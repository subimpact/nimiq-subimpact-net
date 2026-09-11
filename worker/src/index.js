/**
 * nimiq-api — read-only CORS proxy for NimiqHub REST data.
 *
 * api.nimiqhub.com serves the data we need but sends no Access-Control-Allow-Origin
 * header, so nimiq.subimpact.net cannot call it from the browser. This worker fronts
 * a small whitelist of GET endpoints, adds CORS for known origins, and caches
 * responses for 60s at the edge (300s for /api/graph, which fans out to 50+ calls).
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

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'GET') {
      return withHeaders(jsonResponse({ error: 'method not allowed' }, 405), cors);
    }

    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments[0] !== 'api') {
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
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
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
