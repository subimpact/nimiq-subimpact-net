/**
 * nimiq-api — CORS proxy for NimiqHub REST data, plus a transaction relay and the
 * ChainMap paywall.
 *
 * api.nimiqhub.com serves the data we need but sends no Access-Control-Allow-Origin
 * header, so nimiq.subimpact.net cannot call it from the browser. This worker fronts
 * a small whitelist of GET endpoints, adds CORS for known origins, and caches
 * responses for 60s at the edge (300s for /api/graph, which fans out to 50+ calls).
 *
 * The one write path is POST /api/broadcast, which relays an already-signed
 * transaction to a public Nimiq RPC node — see `broadcastTransaction`. It holds no
 * keys and signs nothing; the signature is produced in the Nimiq Hub popup.
 *
 * The ChainMap paywall adds four routes with no accounts and no database behind them:
 * /api/history reads an address's transactions, /api/quote prices the pass in NIM,
 * /api/entitlement looks for the payment on-chain and mints a bearer token, and
 * /api/me re-checks that token. The chain is the source of truth — see
 * `checkEntitlement`.
 *
 * Everything here runs inside the Workers Free per-invocation budget of 50 units,
 * where fetch() subrequests and Cache API match/put/delete calls share one quota.
 * /api/graph is split into parts for that reason — see `delegationGraph`.
 */

const ALLOWED_ORIGINS = [
  'https://nimiq.subimpact.net',
  'https://nimiq-subimpact-net.pages.dev',
  'http://localhost:4321',
];

const UPSTREAM = 'https://api.nimiqhub.com';
const USER_AGENT = 'nimiq-api/1.0 (+https://nimiq.subimpact.net)';
const UPSTREAM_TIMEOUT_MS = 10000;
const CACHE_TTL = 60;

// Staker state decides which staking transaction the dialog builds, so a stale
// answer is worse than an extra round trip: a staker cached as "none" would make
// the client build a create-staker the chain then rejects. Short TTL, enough to
// blunt a hot loop but not enough to outlive one staking flow.
const STAKER_CACHE_TTL = 10;

// Public JSON-RPC node used to broadcast signed transactions. Read-only methods
// come from NimiqHub above; this one exists because NimiqHub has no send route.
const RPC_URL = 'https://rpc.nimiqwatch.com';
const RPC_TIMEOUT_MS = 15000;
// A staking transaction serializes to ~190 bytes (380 hex chars). The ceiling is a
// sanity bound on request size, not a protocol limit.
const MAX_TX_HEX_LENGTH = 20000;
const TX_HEX_RE = /^[0-9a-fA-F]+$/;

// /api/graph composes one validator call plus one staker call per validator, so it
// gets a longer TTL and a bounded number of upstream calls in flight.
const GRAPH_CACHE_TTL = 300;
const GRAPH_CONCURRENCY = 6;
// Staker calls per part. A part costs 1 cache match + 1 validators fetch + (part 1
// only) 1 names fetch + GRAPH_CHUNK staker fetches + 1 cache put — 30 units at most,
// comfortably inside the 50-unit free budget. 52 validators split into 2 parts today;
// growth to ~104 validators simply yields 4.
const GRAPH_CHUNK = 26;

// Display names only; every number in /api/graph comes from NimiqHub.
const VALIDATOR_NAMES_URL = 'https://validators-api-main.je-cf9.workers.dev/api/v1/validators';

// Albatross: 720 batches per epoch, one batch roughly every 60s.
const BATCHES_PER_EPOCH = 720;
const SECONDS_PER_BATCH = 60;

// Nimiq addresses are NQ + 34 base32 characters (36 total), i.e. 9 four-char blocks.
const ADDRESS_RE = /^NQ[A-Z0-9]{34}$/i;

// --- ChainMap paywall -------------------------------------------------------

// Transaction hashes are 32 bytes, rendered lowercase hex. The RPC's `startAt`
// cursor is one of these or null, and rejects anything else.
const TX_HASH_RE = /^[0-9a-f]{64}$/;

const HISTORY_DEFAULT_MAX = 20;
// The RPC will serve more, but a page is rendered in the browser and every page is a
// cache entry; 50 is as much as the map view can usefully draw at once.
const HISTORY_MAX = 50;
const HISTORY_CACHE_TTL = 60;

const LUNA_PER_NIM = 100000;
const DAY_MS = 24 * 60 * 60 * 1000;

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2&vs_currencies=usd';
const USD_TARGET = 29.99;
const QUOTE_TTL_S = 60;
// How long the client may treat a quote as good for. NIM moves, so a quote the user
// sat on for an hour buys a slightly different amount of pass — which is what the
// 0.85 tolerance below exists to absorb.
const QUOTE_VALID_MINUTES = 60;

// Where the pass is paid. Overridable via the PAYWALL_ADDRESS var so a test or a
// staging deploy can point elsewhere; the constant is the production answer.
const PAYWALL_ADDRESS = 'NQ70 SM7L 2PKV 7D55 SUUA B80X 1DML 5XS1 XHJC';

// A pass runs 30 days from the timestamp of the payment transaction, not from when
// the user first asks about it — the chain records when they paid.
const ENTITLEMENT_DAYS = 30;
// The quote is priced at the moment of payment, but the user may have signed against a
// quote minutes old, and NIM moves. Accept 85% of what today's price asks rather than
// charging someone twice for a market tick.
const PAYMENT_TOLERANCE = 0.85;
// One page of history to look for the payment in. Deep enough to find a payment made
// many transactions ago, shallow enough to stay one subrequest.
const ENTITLEMENT_TX_SCAN = 200;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const isApi = segments[0] === 'api';

    // The write routes. Checked before the GET-only gate below, and never cached — an
    // edge cache hit would silently swallow a re-broadcast, or hand one wallet's pass
    // to the next caller.
    const writeRoute =
      request.method === 'POST' && isApi && segments.length === 2 ? segments[1] : null;
    if (writeRoute === 'broadcast' || writeRoute === 'entitlement') {
      // CORS only governs what a browser will let a page read back; it does not stop
      // a server from posting here. These routes' one legitimate caller is our own
      // site, which is cross-origin and so always sends an allowlisted Origin —
      // anything else is turned away before it can spend a subrequest.
      if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        return withHeaders(jsonResponse({ error: 'forbidden' }, 403), cors);
      }
      const response =
        writeRoute === 'broadcast'
          ? await broadcastTransaction(request)
          : await checkEntitlement(request, env);
      return withHeaders(response, cors);
    }

    if (request.method !== 'GET') {
      return withHeaders(jsonResponse({ error: 'method not allowed' }, 405), cors);
    }

    if (!isApi) {
      return withHeaders(jsonResponse({ error: 'not found' }, 404), cors);
    }

    if (segments.length === 2 && segments[1] === 'health') {
      return withHeaders(jsonResponse({ ok: true }, 200, cacheControl()), cors);
    }

    if (segments.length === 2 && segments[1] === 'validators') {
      return withHeaders(await proxy(ctx, url, '/getValidators'), cors);
    }

    if (segments.length === 2 && segments[1] === 'network') {
      return withHeaders(await networkSummary(ctx, url), cors);
    }

    if (segments.length === 2 && segments[1] === 'graph') {
      return withHeaders(await delegationGraph(ctx, url), cors);
    }

    if (segments.length === 2 && segments[1] === 'quote') {
      return withHeaders(await priceQuote(ctx, url, env), cors);
    }

    if (segments.length === 2 && segments[1] === 'me') {
      return withHeaders(await currentEntitlement(request, env), cors);
    }

    if (segments.length === 3 && segments[1] === 'history') {
      const address = normalizeAddress(decodeSegment(segments[2]));
      if (!address) {
        return withHeaders(jsonResponse({ error: 'invalid address' }, 400), cors);
      }
      return withHeaders(await addressHistory(ctx, url, address), cors);
    }

    if (segments.length === 3 && segments[1] === 'staker') {
      const address = normalizeAddress(decodeSegment(segments[2]));
      if (!address) {
        return withHeaders(jsonResponse({ error: 'invalid address' }, 400), cors);
      }
      return withHeaders(await stakerState(ctx, url, address), cors);
    }

    if (segments.length === 3 && (segments[1] === 'stakers' || segments[1] === 'account')) {
      const address = normalizeAddress(decodeSegment(segments[2]));
      if (!address) {
        return withHeaders(jsonResponse({ error: 'invalid address' }, 400), cors);
      }
      const path =
        segments[1] === 'stakers'
          ? `/getStakersByValidatorAddress/${encodeURIComponent(address)}`
          : `/getAccountByAddress/${encodeURIComponent(address)}`;
      // Cache under the normalized address so spacing/case variants share one entry.
      const cacheUrl = new URL(`/api/${segments[1]}/${encodeURIComponent(address)}`, url.origin);
      return withHeaders(await proxy(ctx, cacheUrl, path), cors);
    }

    return withHeaders(jsonResponse({ error: 'not found' }, 404), cors);
  },
};

/** Allowlist match on Origin; unknown or absent origin gets no CORS headers. */
function corsHeaders(origin) {
  const headers = { Vary: 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    // Authorization carries the ChainMap pass token on /api/me.
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

function cacheControl(ttl = CACHE_TTL) {
  return { 'Cache-Control': `public, max-age=${ttl}` };
}

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {}),
    },
  });
}

/** Returns a new Response with `headers` merged in (cached responses have immutable headers). */
function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/**
 * Strip whitespace, validate, uppercase, then re-group into 4-char blocks.
 * Returns null when the input is not a Nimiq address.
 */
function normalizeAddress(raw) {
  const compact = String(raw || '').replace(/\s+/g, '');
  if (!ADDRESS_RE.test(compact)) return null;
  return (compact.toUpperCase().match(/.{1,4}/g) || []).join(' ');
}

/**
 * The same address as one unbroken uppercase run — the form used for equality checks
 * and inside signed tokens, where the spacing would only be noise. Returns '' for
 * anything that is not an address, which never equals another compacted address.
 */
function compactAddress(raw) {
  const normalized = normalizeAddress(raw);
  return normalized ? normalized.replace(/ /g, '') : '';
}

/** GET JSON from NimiqHub; throws on transport error, non-2xx, or unparseable body. */
async function fetchUpstreamJson(upstreamPath) {
  const response = await fetch(`${UPSTREAM}${upstreamPath}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  return response.json();
}

/**
 * NimiqHub wraps these counters inconsistently: `{blockNumber: n}` from one endpoint,
 * `{epochNumber: {data: n}}` from the next. Returns null when no number is present.
 */
function unwrapNumber(payload, key) {
  const raw = payload && typeof payload === 'object' ? payload[key] : undefined;
  const value = raw && typeof raw === 'object' ? raw.data : raw;
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

/**
 * Chain head as one payload: block, epoch, batch, plus how far the current epoch has
 * run. Cached like `proxy`, but the body is derived rather than passed through.
 */
async function networkSummary(ctx, cacheUrl) {
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let payloads;
  try {
    payloads = await Promise.all([
      fetchUpstreamJson('/getBlockNumber'),
      fetchUpstreamJson('/getEpochNumber'),
      fetchUpstreamJson('/getBatchNumber'),
    ]);
  } catch {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  const blockNumber = unwrapNumber(payloads[0], 'blockNumber');
  const epochNumber = unwrapNumber(payloads[1], 'epochNumber');
  const batchNumber = unwrapNumber(payloads[2], 'batchNumber');

  if (blockNumber === null || epochNumber === null || batchNumber === null) {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  const batchInEpoch = batchNumber % BATCHES_PER_EPOCH;
  const batchesRemaining = BATCHES_PER_EPOCH - batchInEpoch;

  const response = jsonResponse(
    {
      blockNumber,
      epochNumber,
      batchNumber,
      epoch: {
        batchInEpoch,
        batchesRemaining,
        approxSecondsRemaining: batchesRemaining * SECONDS_PER_BATCH,
      },
    },
    200,
    cacheControl(),
  );

  if (cache) {
    const put = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
    else await put;
  }

  return response;
}

/** NimiqHub wraps list endpoints in `{data: [...]}`; tolerate a bare array too. */
function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.validators)) return payload.validators;
  return [];
}

function toNumber(value) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

/** Runs `task` over `items` with at most `limit` in flight; results keep input order. */
async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  async function drain() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}

/**
 * Display names from the official validators API, keyed by normalized address.
 * Best-effort: any failure yields an empty map and the graph ships without names.
 */
async function fetchValidatorNames() {
  try {
    const response = await fetch(VALIDATOR_NAMES_URL, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return new Map();
    const names = new Map();
    for (const row of unwrapList(await response.json())) {
      const address = normalizeAddress(row && row.address);
      const name = row && typeof row.name === 'string' ? row.name.trim() : '';
      if (address && name) names.set(address, name);
    }
    return names;
  } catch {
    return new Map();
  }
}

/** Staker list for one validator; `[]` on any failure, so one bad upstream is local. */
async function fetchStakerList(validatorAddress) {
  try {
    return unwrapList(
      await fetchUpstreamJson(
        `/getStakersByValidatorAddress/${encodeURIComponent(validatorAddress)}`,
      ),
    );
  } catch {
    return [];
  }
}

/**
 * `?part=N` — a positive integer, or absent for part 1. Returns null when the value is
 * present but not a positive integer, which the caller turns into a 400.
 */
function parsePart(raw) {
  if (raw === null) return 1;
  if (!/^\d+$/.test(raw)) return null;
  const part = Number(raw);
  return part >= 1 ? part : null;
}

/**
 * The delegation graph: every validator as a hub, every staker as a satellite.
 *
 * A full graph needs one staker call per validator — ~50 today, which blows the Free
 * plan's 50-unit per-invocation budget (fetch() and Cache API calls share it). So the
 * compose is split: each part carries the FULL validator list but only its own slice of
 * GRAPH_CHUNK validators' stakers, and the client concatenates the parts. The staker
 * calls are plain fetches — caching them individually would double their unit cost for
 * no benefit, since the assembled part is itself cached for GRAPH_CACHE_TTL.
 *
 * A validator whose staker list fails or comes back empty is still returned — it just
 * contributes no staker rows — so a single bad upstream cannot sink the whole graph.
 */
async function delegationGraph(ctx, url) {
  const part = parsePart(url.searchParams.get('part'));
  if (part === null) return jsonResponse({ error: 'invalid part' }, 400);

  const cache = globalThis.caches?.default;
  // One canonical key per part, so /api/graph and /api/graph?part=1 share an entry.
  const cacheKey = new Request(new URL(`/api/graph?part=${part}`, url.origin).toString(), {
    method: 'GET',
  });

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let payload;
  try {
    payload = await fetchUpstreamJson('/getValidators');
  } catch {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  const validators = [];
  for (const row of unwrapList(payload)) {
    const address = normalizeAddress(row && row.address);
    if (!address) continue;
    validators.push({
      address,
      balance: toNumber(row && row.balance),
      numStakers: Math.max(0, Math.trunc(toNumber(row && row.numStakers))),
    });
  }

  if (validators.length === 0) return jsonResponse({ error: 'upstream' }, 502);

  // Only validators reporting stakers cost a round trip, so they alone set the split.
  const fetchable = validators.filter((validator) => validator.numStakers > 0);
  const count = Math.max(1, Math.ceil(fetchable.length / GRAPH_CHUNK));
  if (part > count) return jsonResponse({ error: 'invalid part' }, 400);

  const slice = fetchable.slice((part - 1) * GRAPH_CHUNK, part * GRAPH_CHUNK);

  // Names cost a subrequest, so only part 1 pays for them — the client reads the
  // validator list from part 1 and ignores the unnamed copies the other parts carry.
  const names = part === 1 ? await fetchValidatorNames() : new Map();
  const totalActiveStake = validators.reduce((sum, validator) => sum + validator.balance, 0);

  const stakerLists = await mapWithConcurrency(slice, GRAPH_CONCURRENCY, (validator) =>
    fetchStakerList(validator.address),
  );

  const stakers = [];
  stakerLists.forEach((list, index) => {
    const validatorAddress = slice[index].address;
    for (const row of list) {
      const address = normalizeAddress(row && row.address);
      if (!address) continue;
      stakers.push({ address, validatorAddress, balance: toNumber(row && row.balance) });
    }
  });

  const response = jsonResponse(
    {
      validators: validators.map((validator) => {
        const name = names.get(validator.address);
        return {
          address: validator.address,
          ...(name ? { name } : {}),
          balance: validator.balance,
          numStakers: validator.numStakers,
          stakeShare: totalActiveStake > 0 ? validator.balance / totalActiveStake : 0,
        };
      }),
      stakers,
      totalActiveStake,
      updatedAt: new Date().toISOString(),
      part: { index: part, count },
    },
    200,
    cacheControl(GRAPH_CACHE_TTL),
  );

  if (cache) {
    const put = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
    else await put;
  }

  return response;
}

/**
 * Staker state for one address — the delegation, and how much is staked.
 *
 * NimiqHub has no "not a staker" response: for an address that never staked it
 * answers 502 with `{"error":"Internal error: No staker with address: NQ…"}`. That
 * is an expected, meaningful answer for us, so it is normalized to 200
 * `{"data":null}` and the caller reads "this address is not a staker yet".
 *
 * Any other non-2xx stays a 502. The distinction matters: the client picks
 * create-staker vs add-stake from this answer, and a real outage reported as
 * `{"data":null}` would have it build a create-staker the chain then rejects.
 */
async function stakerState(ctx, url, address) {
  const cache = globalThis.caches?.default;
  // Cache under the normalized address so spacing/case variants share one entry.
  const cacheKey = new Request(
    new URL(`/api/staker/${encodeURIComponent(address)}`, url.origin).toString(),
    { method: 'GET' },
  );

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let upstream;
  let body;
  try {
    upstream = await fetch(`${UPSTREAM}/getStakerByAddress/${encodeURIComponent(address)}`, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    body = await upstream.text();
  } catch {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  let response;
  if (upstream.ok) {
    response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...cacheControl(STAKER_CACHE_TTL),
      },
    });
  } else if (upstream.status === 404 || /no staker/i.test(body)) {
    response = jsonResponse({ data: null }, 200, cacheControl(STAKER_CACHE_TTL));
  } else {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  if (cache) {
    const put = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
    else await put;
  }

  return response;
}

/** JSON-RPC results arrive as `{data: value}` from some methods and bare from others. */
function unwrapRpcResult(result) {
  const value = result && typeof result === 'object' ? result.data : result;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Relay an already-signed transaction to the RPC node. `{tx: "<hex>"}` in,
 * `{result: "<hash>"}` out.
 *
 * Callers are gated on Origin in `fetch` before this runs, so everything here can
 * assume the request came from one of ALLOWED_ORIGINS.
 *
 * The signature comes from the Nimiq Hub popup in the user's browser; this worker
 * only forwards bytes, so the worst a malformed body can do is waste one
 * subrequest. Rejections (bad serialization, insufficient funds, a create-staker
 * for an address that already stakes) come back from the node with HTTP 200 and an
 * `error` member — those are the user's problem to see, so the node's own message
 * is passed through with a 400 rather than flattened into "upstream".
 */
async function broadcastTransaction(request) {
  let raw;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  // Bound the parse: a valid body is one short hex string in a JSON envelope.
  if (raw.length > MAX_TX_HEX_LENGTH + 1024) {
    return jsonResponse({ error: 'invalid body' }, 400);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }

  const tx = body && typeof body.tx === 'string' ? body.tx.trim() : '';
  if (
    tx.length < 2 ||
    tx.length > MAX_TX_HEX_LENGTH ||
    tx.length % 2 !== 0 ||
    !TX_HEX_RE.test(tx)
  ) {
    return jsonResponse({ error: 'invalid transaction' }, 400);
  }

  let upstream;
  let payload;
  try {
    upstream = await fetch(RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendRawTransaction',
        params: [tx],
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    payload = await upstream.json();
  } catch {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  const rpcError = payload && typeof payload === 'object' ? payload.error : null;
  if (rpcError) {
    // `data` carries the useful detail ("Serialization error: …"); `message` is
    // usually just the generic "Internal error".
    const detail =
      typeof rpcError.data === 'string' && rpcError.data
        ? rpcError.data
        : typeof rpcError.message === 'string' && rpcError.message
          ? rpcError.message
          : 'transaction rejected';
    return jsonResponse({ error: detail }, 400);
  }

  const hash = unwrapRpcResult(payload && payload.result);
  if (!upstream.ok || !hash) {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  return jsonResponse({ result: hash }, 200);
}

// --- ChainMap paywall -------------------------------------------------------

/** The paywall address as canonical 4-char blocks; the var wins, the constant backs it. */
function paywallAddress(env) {
  return normalizeAddress(env && env.PAYWALL_ADDRESS) || PAYWALL_ADDRESS;
}

/**
 * getTransactionsByAddress on the public RPC node.
 *
 * Like sendRawTransaction, the node answers HTTP 200 whether it understood the request
 * or not — a bad `startAt` comes back as an `error` member, not a 4xx. So the three
 * outcomes are kept apart for the caller to interpret: `{ok: true, data}`,
 * `{ok: false, message}` for a request the node rejected, and `{ok: false, message: null}`
 * for a node that could not be reached at all.
 */
async function fetchTransactions(address, max, startAt) {
  let upstream;
  let payload;
  try {
    upstream = await fetch(RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransactionsByAddress',
        params: [address, max, startAt],
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    payload = await upstream.json();
  } catch {
    return { ok: false, message: null };
  }

  const rpcError = payload && typeof payload === 'object' ? payload.error : null;
  if (rpcError) {
    // `data` carries the useful detail; `message` is usually just "Internal error".
    const detail =
      typeof rpcError.data === 'string' && rpcError.data
        ? rpcError.data
        : typeof rpcError.message === 'string' && rpcError.message
          ? rpcError.message
          : 'request rejected';
    return { ok: false, message: detail };
  }

  if (!upstream.ok) return { ok: false, message: null };
  return { ok: true, data: unwrapList(payload && payload.result) };
}

/**
 * One transaction, trimmed to the fields the map draws.
 *
 * The node also returns fromType/toType and the raw senderData/recipientData blobs — a
 * staking transaction's recipientData alone runs to hundreds of bytes, and none of it is
 * rendered, so it is dropped rather than cached 50 rows at a time. A row missing any of
 * hash/from/to/value is not a transaction we can place on the graph: it returns null and
 * the caller drops it.
 */
function normalizeTransaction(row) {
  if (!row || typeof row !== 'object') return null;

  const hash = typeof row.hash === 'string' ? row.hash.trim() : '';
  const from = typeof row.from === 'string' ? row.from.trim() : '';
  const to = typeof row.to === 'string' ? row.to.trim() : '';
  const value = typeof row.value === 'number' ? row.value : Number(row.value);
  if (!hash || !from || !to || !Number.isFinite(value)) return null;

  const tx = {
    hash,
    // Addresses arrive in canonical form already; normalizing makes that a guarantee
    // the entitlement check and the client can both rely on.
    from: normalizeAddress(from) || from,
    to: normalizeAddress(to) || to,
    value,
  };
  for (const key of ['blockNumber', 'timestamp', 'confirmations', 'size', 'fee']) {
    const raw = row[key];
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (raw !== undefined && raw !== null && Number.isFinite(num)) tx[key] = num;
  }
  return tx;
}

/**
 * `?max=` — an integer in 1..HISTORY_MAX, or absent for the default. Returns null when
 * the value is present but out of range, which the caller turns into a 400.
 */
function parseHistoryMax(raw) {
  if (raw === null) return HISTORY_DEFAULT_MAX;
  if (!/^\d+$/.test(raw)) return null;
  const max = Number(raw);
  return max >= 1 && max <= HISTORY_MAX ? max : null;
}

/**
 * Transaction history for one address, paged.
 *
 * `?startAt=<hash>` is the node's own cursor, so it is validated to the node's shape
 * before it can cost a subrequest. `pagination.nextStartAt` is the last hash of a full
 * page and null otherwise — a short page is the end of the history.
 *
 * A request the node rejects (an unknown cursor, say) is the caller's to fix, so its
 * message is passed through with a 400 rather than flattened into "upstream", and it is
 * not cached. Only successful pages are cached, keyed by address + max + startAt.
 */
async function addressHistory(ctx, url, address) {
  const max = parseHistoryMax(url.searchParams.get('max'));
  if (max === null) return jsonResponse({ error: 'invalid max' }, 400);

  const startAtParam = url.searchParams.get('startAt');
  if (startAtParam !== null && !TX_HASH_RE.test(startAtParam)) {
    return jsonResponse({ error: 'invalid startAt' }, 400);
  }
  const startAt = startAtParam === null ? null : startAtParam;

  const cache = globalThis.caches?.default;
  // Cache under the normalized address plus both page parameters, so page 2 can never
  // be served from page 1's entry.
  const cacheKey = new Request(
    new URL(
      `/api/history/${encodeURIComponent(address)}?max=${max}` +
        (startAt ? `&startAt=${startAt}` : ''),
      url.origin,
    ).toString(),
    { method: 'GET' },
  );

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const result = await fetchTransactions(address, max, startAt);
  if (!result.ok) {
    return result.message
      ? jsonResponse({ error: result.message }, 400)
      : jsonResponse({ error: 'upstream' }, 502);
  }

  const data = result.data.map(normalizeTransaction).filter(Boolean);
  const response = jsonResponse(
    {
      data,
      pagination: { nextStartAt: data.length === max ? data[data.length - 1].hash : null },
    },
    200,
    cacheControl(HISTORY_CACHE_TTL),
  );

  if (cache) {
    const put = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
    else await put;
  }

  return response;
}

/** NIM spot price in USD from CoinGecko; null on any failure, so callers 502 once. */
async function fetchNimPriceUsd() {
  let payload;
  try {
    const upstream = await fetch(COINGECKO_URL, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) return null;
    payload = await upstream.json();
  } catch {
    return null;
  }
  const quoted = payload && typeof payload === 'object' ? payload['nimiq-2'] : null;
  const price = quoted && typeof quoted === 'object' ? Number(quoted.usd) : NaN;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** What $29.99 costs in luna at `priceUsd`, rounded up so the pass is never underpaid. */
function requiredLunaAt(priceUsd) {
  return Math.ceil((USD_TARGET * LUNA_PER_NIM) / priceUsd);
}

/**
 * The price of a pass, in the units the wallet needs. Cached for a minute: the point of
 * the tolerance downstream is that this number does not have to be exact.
 */
async function priceQuote(ctx, url, env) {
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(new URL('/api/quote', url.origin).toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const priceUsd = await fetchNimPriceUsd();
  if (priceUsd === null) return jsonResponse({ error: 'upstream' }, 502);

  const requiredLuna = requiredLunaAt(priceUsd);
  const response = jsonResponse(
    {
      priceUsd,
      usdTarget: USD_TARGET,
      nimAmount: requiredLuna / LUNA_PER_NIM,
      lunaAmount: requiredLuna,
      paywallAddress: paywallAddress(env),
      validMinutes: QUOTE_VALID_MINUTES,
      generatedAt: new Date().toISOString(),
    },
    200,
    cacheControl(QUOTE_TTL_S),
  );

  if (cache) {
    const put = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
    else await put;
  }

  return response;
}

const encoder = new TextEncoder();

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(text) {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
}

/** Content-independent compare, so a forged signature leaks nothing through timing. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signPayload(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

/**
 * The pass token: base64url("<address>.<paidUntil>.<hmac>").
 *
 * It is a receipt, not a session — it says only "this address had paid until this
 * instant", which is what the chain said when it was minted. Nothing is stored
 * server-side, so a lost token costs the user one more /api/entitlement round trip, and
 * a stolen one expires with the pass it describes. The address is carried compacted, so
 * the payload can never contain the separator.
 */
async function mintToken(addressCompact, paidUntil, secret) {
  const payload = `${addressCompact}.${paidUntil}`;
  return base64UrlEncode(`${payload}.${await signPayload(payload, secret)}`);
}

/** `{addressCompact, paidUntil}` for a token this worker signed, otherwise null. */
async function readToken(token, secret) {
  const decoded = typeof token === 'string' && token ? base64UrlDecode(token) : null;
  if (!decoded) return null;

  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const [addressCompact, paidUntilRaw, signature] = parts;
  if (!ADDRESS_RE.test(addressCompact) || !/^\d+$/.test(paidUntilRaw)) return null;

  const expected = await signPayload(`${addressCompact}.${paidUntilRaw}`, secret);
  if (!timingSafeEqual(signature, expected)) return null;

  return { addressCompact, paidUntil: Number(paidUntilRaw) };
}

/** How much pass is left, in the three units the UI wants. */
function entitlementWindow(paidUntil) {
  const expiresInMs = paidUntil - Date.now();
  return { paidUntil, expiresInMs, daysLeft: Math.max(0, Math.ceil(expiresInMs / DAY_MS)) };
}

/**
 * Does this address hold a ChainMap pass? `{address}` in, an answer plus a token out.
 *
 * There are no accounts here: the wallet address is the login and the payment
 * transaction is the receipt, so the only question is whether the chain shows a transfer
 * from that address to the paywall address large enough to count. The newest such
 * payment wins, and the 30 days run from its own timestamp — someone who paid three
 * weeks ago gets the week they have left, not a fresh month for asking.
 *
 * The price is re-fetched rather than taken from the request: a caller who could name
 * their own `requiredLuna` could buy the pass for a luna. PAYMENT_TOLERANCE then allows
 * for NIM having moved between the quote the user signed and this moment.
 *
 * Callers are gated on Origin in `fetch` before this runs, and nothing here is cached —
 * a cached answer would hand the first caller's pass to the next wallet that asked.
 */
async function checkEntitlement(request, env) {
  let body;
  try {
    const raw = await request.text();
    // A valid body is one address in a JSON envelope; bound the parse like broadcast.
    if (raw.length > 1024) return jsonResponse({ error: 'invalid body' }, 400);
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }

  const address = normalizeAddress(body && body.address);
  if (!address) return jsonResponse({ error: 'invalid address' }, 400);

  const secret = env && env.CHAINMAP_TOKEN_SECRET;
  if (!secret) return jsonResponse({ error: 'server misconfigured' }, 500);

  const priceUsd = await fetchNimPriceUsd();
  if (priceUsd === null) return jsonResponse({ error: 'upstream' }, 502);
  const requiredLuna = requiredLunaAt(priceUsd);
  const minimumLuna = Math.floor(PAYMENT_TOLERANCE * requiredLuna);

  const result = await fetchTransactions(address, ENTITLEMENT_TX_SCAN, null);
  if (!result.ok) return jsonResponse({ error: 'upstream' }, 502);

  const target = compactAddress(paywallAddress(env));
  let newestPayment = null;
  let sawUnderpayment = false;
  for (const row of result.data) {
    const tx = normalizeTransaction(row);
    if (!tx || compactAddress(tx.to) !== target) continue;
    if (tx.value < minimumLuna) {
      sawUnderpayment = true;
      continue;
    }
    // The node returns newest first, but its ordering is not something to lean on when
    // the answer decides how much pass someone has left.
    const timestamp = Number.isFinite(tx.timestamp) ? tx.timestamp : 0;
    if (!newestPayment || timestamp > newestPayment.timestamp) newestPayment = { timestamp };
  }

  if (!newestPayment) {
    return jsonResponse(
      {
        entitled: false,
        reason: sawUnderpayment ? 'amount_too_low' : 'no_payment',
        requiredLuna,
        priceUsd,
      },
      200,
    );
  }

  const paidUntil = newestPayment.timestamp + ENTITLEMENT_DAYS * DAY_MS;
  if (Date.now() >= paidUntil) {
    return jsonResponse({ entitled: false, reason: 'expired', paidUntil, requiredLuna, priceUsd }, 200);
  }

  return jsonResponse(
    {
      entitled: true,
      address,
      ...entitlementWindow(paidUntil),
      requiredLuna,
      priceUsd,
      token: await mintToken(compactAddress(address), paidUntil, secret),
    },
    200,
  );
}

/**
 * Re-check a pass token — the path the app takes on every page load, costing no
 * subrequest at all, since the token already carries the answer the chain gave.
 *
 * A token we did not sign, or one edited after we did, is a 401. A token that is genuine
 * but describes a pass that has run out is a 200 saying so: the client is authenticated,
 * it simply has nothing left, and the difference tells it whether to show "connect
 * wallet" or "renew".
 */
async function currentEntitlement(request, env) {
  const secret = env && env.CHAINMAP_TOKEN_SECRET;
  if (!secret) return jsonResponse({ error: 'server misconfigured' }, 500);

  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const claims = match ? await readToken(match[1], secret) : null;
  if (!claims) return jsonResponse({ error: 'invalid token' }, 401);

  if (Date.now() >= claims.paidUntil) {
    return jsonResponse({ entitled: false, reason: 'expired' }, 200);
  }

  return jsonResponse(
    {
      entitled: true,
      address: normalizeAddress(claims.addressCompact),
      ...entitlementWindow(claims.paidUntil),
    },
    200,
  );
}

/**
 * Serve `cacheUrl` from the edge cache, otherwise fetch `upstreamPath` from NimiqHub.
 * Cached entries carry no CORS headers — those are applied per-request by the caller.
 */
async function proxy(ctx, cacheUrl, upstreamPath) {
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}${upstreamPath}`, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  if (!upstream.ok) {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  let body;
  try {
    body = await upstream.text();
  } catch {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cacheControl(),
    },
  });

  if (cache) {
    const put = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
    else await put;
  }

  return response;
}
