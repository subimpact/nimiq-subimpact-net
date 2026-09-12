/**
 * nimiq-api — CORS proxy for NimiqHub REST data, plus a transaction relay and the
 * NimMap paywall.
 *
 * api.nimiqhub.com serves the data we need but sends no Access-Control-Allow-Origin
 * header, so nimiq.subimpact.net cannot call it from the browser. This worker fronts
 * a small whitelist of GET endpoints, adds CORS for known origins, and caches
 * responses for 60s at the edge (300s for /api/graph, which fans out to 50+ calls).
 *
 * GET /api/status is the one route that fronts something other than chain data: the
 * operator's Uptime Kuma, for whether the validator node is actually up — see
 * `nodeStatus`. Same treatment as the rest, CORS and a 60s edge cache.
 *
 * The one write path is POST /api/broadcast, which relays an already-signed
 * transaction to a public Nimiq RPC node — see `broadcastTransaction`. It holds no
 * keys and signs nothing; the signature is produced in the Nimiq Hub popup.
 *
 * The NimMap paywall adds six routes with no accounts and no database behind them:
 * /api/history reads an address's transactions, /api/quote prices the pass in NIM,
 * /api/auth/nonce and /api/auth/verify sign a wallet in, /api/entitlement looks for the
 * payment on-chain and mints a bearer token, and /api/me re-checks that token. The chain
 * is the source of truth — see `checkEntitlement`.
 *
 * Sign-in is a signature, never a claim. A Nimiq address is public — it is printed in
 * every transaction — so "I am NQ…" proves nothing. The client asks for a nonce, has the
 * Hub sign the message that carries it, and posts the signature; this worker verifies the
 * Ed25519 signature, derives the address from the public key that made it, and only then
 * treats the wallet as signed in. See `verifySignIn` and `deriveAddress`.
 *
 * Everything here runs inside the Workers Free per-invocation budget of 50 units,
 * where fetch() subrequests and Cache API match/put/delete calls share one quota.
 * /api/graph is split into parts for that reason — see `delegationGraph`.
 */

import { blake2b256 } from './blake2b.js';

const ALLOWED_ORIGINS = [
  'https://nimiq.subimpact.net',
  'https://nimiq-subimpact-net.pages.dev',
  'http://localhost:4321',
  // The test suite's preview port. Kept alongside 4321 so a local server on either
  // port can drive the real API — the e2e suites mock the worker instead.
  'http://localhost:4331',
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

// --- Node status (Uptime Kuma) ----------------------------------------------

// The operator's Uptime Kuma, on a different host from the validator it watches. The
// `live` status page is public, and this is the same unauthenticated JSON its own web
// UI reads — no token is involved, and nothing here can write to Kuma.
const STATUS_UPSTREAM = 'https://uptime.subimpact.net/api/status-page/heartbeat/live';
const STATUS_PAGE_URL = 'https://uptime.subimpact.net/status/live';
const STATUS_SOURCE = 'uptime.subimpact.net';

/**
 * Kuma monitor ids on the `live` status page, in the order the site renders them —
 * the validator first, the website it is announced on second.
 *
 * These are database ids, not names: deleting and recreating a monitor in Kuma hands
 * it a fresh id, and this map has to be edited to match when that happens. The route
 * skips an id it cannot find rather than failing, so a stale entry costs one missing
 * row on the status strip, not a broken endpoint.
 */
const STATUS_MONITORS = [
  { id: 28, label: 'Validator node · p2p 8443' },
  { id: 27, label: 'Website' },
];

// Kuma sends at most 100 beats per monitor; bound it here too so a future server-side
// change cannot quietly inflate the response the browser has to parse.
const STATUS_MAX_BEATS = 100;

// One retry, and only one. Kuma runs on a single small VPS, where an occasional reset
// costs a blank strip on the homepage for a whole cache period; an instance that is
// genuinely down still costs at most two subrequests per cold request.
const STATUS_ATTEMPTS = 2;

// --- NimMap paywall ---------------------------------------------------------

// Transaction hashes are 32 bytes, rendered lowercase hex. The RPC's `startAt`
// cursor is one of these or null, and rejects anything else.
const TX_HASH_RE = /^[0-9a-f]{64}$/;

const HISTORY_DEFAULT_MAX = 20;
// The RPC will serve more, but a page is rendered in the browser and every page is a
// cache entry; 50 is as much as the map view can usefully draw at once.
const HISTORY_MAX = 50;
const HISTORY_CACHE_TTL = 60;

// --- block explorer ---------------------------------------------------------
//
// The same node that answers history answers blocks and single transactions, so the
// explorer routes read the node directly rather than NimiqHub. Blocks are chained at
// ~1/second, so the head list is cached for seconds — long enough to absorb a burst of
// readers, short enough that the page follows the chain. A sealed block and a mined
// transaction never change, so their entries get minutes.

const BLOCKS_DEFAULT_LIMIT = 15;
const BLOCKS_MAX_LIMIT = 25;
const BLOCKS_CACHE_TTL = 20;
const BLOCK_CACHE_TTL = 600;
const TX_CACHE_TTL = 300;

const LUNA_PER_NIM = 100000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where the NIM price comes from, tried in this order until one answers with a usable
 * number. CoinGecko is the reference rate and stays first, but it cannot be the only
 * one: from Cloudflare's egress it is persistently rate-limited — three calls out of
 * three refused in a live check, while the identical request from an ordinary server
 * succeeds — and a blocked price feed takes /api/quote, /api/auth/verify and
 * /api/entitlement down with it, since all three need a price before they can answer.
 *
 * The fallbacks are spot markets (NIM/USDT), not a USD volume-weighted average, so they
 * quote a slightly different number from CoinGecko's and from each other. That is fine
 * here: PAYMENT_TOLERANCE below accepts 85% of the asking price, which is far more drift
 * than the spread between two live order books.
 *
 * Cost: one subrequest per source tried, so 3 in the worst case where the first two are
 * down — still comfortably inside the 50-unit free budget for these routes.
 */
const PRICE_SOURCES = [
  {
    name: 'coingecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2&vs_currencies=usd',
    // {"nimiq-2":{"usd":0.00039309}}
    read: (payload) => payload?.['nimiq-2']?.usd,
  },
  {
    name: 'gate',
    url: 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=NIM_USDT',
    // [{"currency_pair":"NIM_USDT","last":"0.0003915",…}] — one ticker, price as a string
    read: (payload) => (Array.isArray(payload) ? payload[0]?.last : undefined),
  },
  {
    name: 'mexc',
    url: 'https://api.mexc.com/api/v3/ticker/price?symbol=NIMUSDT',
    // {"symbol":"NIMUSDT","price":"0.000389"} — price as a string
    read: (payload) => payload?.price,
  },
];

const USD_TARGET = 29.99;
const QUOTE_TTL_S = 60;
// How long the client may treat a quote as good for. NIM moves, so a quote the user
// sat on for an hour buys a slightly different amount of pass — which is what the
// 0.85 tolerance below exists to absorb.
const QUOTE_VALID_MINUTES = 60;

// Where the pass is paid. Overridable via the PAYWALL_ADDRESS var so a test or a
// staging deploy can point elsewhere; the constant is the production answer.
const PAYWALL_ADDRESS = 'NQ70 SM7L 2PKV 7D55 SUUA B80X 1DML 5XS1 XHJC';

// How long a comped pass runs. It is a real expiry rather than a null, so the comp
// case travels through the same token, the same claims and the same client code as a
// paid one — a century out is "never" for every purpose here, and still an ordinary
// millisecond timestamp that a token can carry and a date can render.
const COMP_PASS_MS = 100 * 365 * DAY_MS;

// A pass runs 30 days from the timestamp of the payment transaction, not from when
// the user first asks about it — the chain records when they paid.
const ENTITLEMENT_DAYS = 30;
// The quote is priced at the moment of payment, but the user may have signed against a
// quote minutes old, and NIM moves. Accept 85% of what today's price asks rather than
// charging someone twice for a market tick.
const PAYMENT_TOLERANCE = 0.85;
// The payment hunt walks the address's history newest-first, a page at a time. One page
// is one subrequest, so the depth is capped: 5 x 200 = the last 1000 transactions, which
// covers any wallet that is not a bot and costs at most 5 of the 50-unit budget.
const ENTITLEMENT_PAGE_SIZE = 200;
const ENTITLEMENT_MAX_PAGES = 5;

// --- signed sign-in ---------------------------------------------------------

// The site the sign-in message names. It is part of what the user signs, so a signature
// collected by some other site cannot be replayed here.
const SIGN_IN_DOMAIN = 'nimiq.subimpact.net';

// What the Nimiq Hub actually signs. `signMessage` does not sign the message bytes: it
// signs sha256(prefix + <decimal byte length> + message), where the prefix is the literal
// 23 bytes below — 0x16 is the length of "Nimiq Signed Message:\n" and makes the digest
// unmistakable for a transaction hash, so a signature harvested here can never be
// replayed as a transfer.
const SIGNED_MESSAGE_PREFIX = '\x16Nimiq Signed Message:\n';

// Ed25519, as Nimiq uses it: a 32-byte public key and a 64-byte signature, both hex on
// the wire.
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const HEX_RE = /^[0-9a-fA-F]+$/;

// A Nimiq address is the first 20 bytes of BLAKE2b-256 over the public key.
const ADDRESS_BYTES = 20;
// Nimiq's base32 alphabet: RFC 4648 rotated so the digits come first, with I, O, W and Z
// dropped — the characters a human would misread as 1, 0, VV and 2.
const BASE32_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY';

// How long a nonce stays signable. Long enough for the user to find the Hub popup and
// read what they are signing, short enough that a signature scraped from a log is stale.
const NONCE_TTL_MS = 10 * 60 * 1000;

// The two things this worker signs. `sub` is the pass itself and outlives the browser
// session; `auth` only says "this wallet proved it holds the key", and is short because
// its whole job is to let the client re-ask the chain without signing again.
const AUTH_TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN_KINDS = new Set(['sub', 'auth']);

// A sign-in body is four short strings; bound the parse like /api/broadcast.
const MAX_AUTH_BODY = 1024;

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
      request.method === 'POST' && isApi
        ? segments.length === 2
          ? segments[1]
          : segments.length === 3 && segments[1] === 'auth'
            ? `auth/${segments[2]}`
            : null
        : null;
    const writeHandlers = {
      broadcast: () => broadcastTransaction(request),
      entitlement: () => checkEntitlement(request, env),
      'auth/verify': () => verifySignIn(request, env),
    };
    if (writeRoute && Object.hasOwn(writeHandlers, writeRoute)) {
      // CORS only governs what a browser will let a page read back; it does not stop
      // a server from posting here. These routes' one legitimate caller is our own
      // site, which is cross-origin and so always sends an allowlisted Origin —
      // anything else is turned away before it can spend a subrequest.
      if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        return withHeaders(jsonResponse({ error: 'forbidden' }, 403), cors);
      }
      return withHeaders(await writeHandlers[writeRoute](), cors);
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

    if (segments.length === 2 && segments[1] === 'status') {
      return withHeaders(await nodeStatus(ctx, url), cors);
    }

    if (segments.length === 2 && segments[1] === 'quote') {
      return withHeaders(await priceQuote(ctx, url, env), cors);
    }

    if (segments.length === 2 && segments[1] === 'me') {
      return withHeaders(await currentEntitlement(request, env), cors);
    }

    if (segments.length === 3 && segments[1] === 'auth' && segments[2] === 'nonce') {
      return withHeaders(await issueNonce(env), cors);
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

    if (segments.length === 2 && segments[1] === 'blocks') {
      return withHeaders(await latestBlocks(ctx, url), cors);
    }

    if (segments.length === 3 && segments[1] === 'block') {
      return withHeaders(await blockDetail(ctx, url, decodeSegment(segments[2])), cors);
    }

    if (segments.length === 3 && segments[1] === 'tx') {
      return withHeaders(await transactionDetail(ctx, url, decodeSegment(segments[2])), cors);
    }

    if (segments.length === 2 && segments[1] === 'search') {
      return withHeaders(await searchChain(url), cors);
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
    // Authorization carries the NimMap pass token on /api/me.
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

/**
 * Cache-Control for the copy a route stores in the Worker Cache API (the TTL that governs
 * how long `cache.match` can serve it). The client-facing response is rewritten to
 * `no-store` by `withHeaders` — browsers and the CDN must never hold these payloads.
 */
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
  // Client-facing API responses are never storable by a browser or the CDN. This zone
  // runs `cache_level: aggressive` with `browser_cache_ttl: 14400`, so any cacheable
  // response that the CDN stores gets its browser TTL rewritten to 4 hours — which parked
  // long-polling clients on a frozen payload for the rest of the day. The Worker Cache
  // API is a separate layer: routes `put` their own copies (they keep the max-age from
  // `cacheControl`) and only this wrapper decides what the network sees.
  merged.set('Cache-Control', 'no-store');
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

/**
 * The Kuma status-page payload, or null when every attempt failed.
 *
 * A failure is any of: transport error or timeout, non-2xx, or a body that is not
 * JSON — the last one matters because a reverse proxy in front of Kuma answers 200
 * with an HTML error page, which is a failure wearing a success status code.
 */
async function fetchKumaStatus() {
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    try {
      const upstream = await fetch(STATUS_UPSTREAM, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!upstream.ok) continue;
      return await upstream.json();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * A Kuma beat time as an ISO instant. Kuma writes them as `2026-09-11 16:20:59.143`
 * with no zone marker at all, and the instant is UTC — so the space becomes a `T` and
 * a `Z` is appended, or whoever parses it downstream reads the wall clock as local
 * time. Returns null for anything unparseable.
 */
function kumaBeatTime(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const zoned = /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`;
  const parsed = new Date(zoned.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Is the validator node up? Answered from the operator's Uptime Kuma rather than by
 * probing the node from here: Kuma has been checking every 60s from a fixed vantage
 * point for as long as the node has existed, and a worker can only ever report what
 * one request from one Cloudflare colo saw one time.
 *
 * Only the two monitors in STATUS_MONITORS are passed through — the `live` page
 * carries every service the operator runs, and the rest is not this site's business.
 * A monitor absent from the payload is dropped, so an empty `monitors` array is a
 * valid answer: it means Kuma is reachable but no longer knows those ids.
 */
async function nodeStatus(ctx, url) {
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(new URL('/api/status', url.origin).toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const payload = await fetchKumaStatus();
  const heartbeatList = payload?.heartbeatList;
  if (!heartbeatList || typeof heartbeatList !== 'object') {
    return jsonResponse({ error: 'upstream' }, 502);
  }
  const uptimeList = payload.uptimeList && typeof payload.uptimeList === 'object' ? payload.uptimeList : {};

  const monitors = [];
  for (const monitor of STATUS_MONITORS) {
    const raw = heartbeatList[String(monitor.id)];
    if (!Array.isArray(raw)) continue;
    // Oldest → newest, as Kuma sends them; a beat without a numeric status is not one.
    const beats = raw.filter((beat) => beat && typeof beat.status === 'number').slice(-STATUS_MAX_BEATS);
    if (beats.length === 0) continue;

    const latest = beats[beats.length - 1];
    const uptime24h = uptimeList[`${monitor.id}_24`];
    monitors.push({
      id: monitor.id,
      label: monitor.label,
      status: latest.status,
      ping: typeof latest.ping === 'number' ? latest.ping : null,
      lastCheck: kumaBeatTime(latest.time),
      uptime24h: typeof uptime24h === 'number' && Number.isFinite(uptime24h) ? uptime24h : null,
      heartbeats: beats.map((beat) => beat.status),
    });
  }

  const response = jsonResponse(
    {
      fetchedAt: Date.now(),
      source: STATUS_SOURCE,
      sourceUrl: STATUS_PAGE_URL,
      monitors,
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

// --- NimMap paywall ---------------------------------------------------------

/** The paywall address as canonical 4-char blocks; the var wins, the constant backs it. */
function paywallAddress(env) {
  return normalizeAddress(env && env.PAYWALL_ADDRESS) || PAYWALL_ADDRESS;
}

/**
 * The wallets that hold a pass without having paid for one — the operator's own, and
 * whoever else they decide to comp.
 *
 * The list is the COMP_ADDRESSES var, comma-separated. It is public data, not a secret:
 * it names addresses, which the chain prints anyway, and naming one grants nothing on
 * its own — the address still has to prove it holds its key on /api/auth/verify before
 * this list is ever consulted. Editing the var is the whole of granting and revoking.
 *
 * Every entry is compacted, which both normalizes it and validates it: an entry that is
 * not a Nimiq address compacts to '' and is dropped, so a typo comps nobody rather than
 * matching something unintended.
 */
function compAddresses(env) {
  const raw = env && typeof env.COMP_ADDRESSES === 'string' ? env.COMP_ADDRESSES : '';
  return new Set(raw.split(',').map(compactAddress).filter(Boolean));
}

/** Is this address comped? Both sides compacted, so spacing and casing cannot matter. */
function isCompAddress(address, env) {
  const compact = compactAddress(address);
  return compact !== '' && compAddresses(env).has(compact);
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
 * The op code of a Nimiq data blob: its first byte, as an int.
 *
 * `senderData` and `recipientData` arrive as lowercase hex strings, and for every
 * transaction family the map colours, the first byte alone says which one it is — a
 * staking `recipientData` runs to hundreds of bytes, of which 531 are the validator key
 * material nobody is drawing. Returns null for an empty, short or non-hex blob, which
 * the client reads as "this transaction carried no data".
 */
function dataOpCode(raw) {
  if (typeof raw !== 'string') return null;
  const head = raw.trim().slice(0, 2);
  if (!/^[0-9a-fA-F]{2}$/.test(head)) return null;
  return Number.parseInt(head, 16);
}

/** A field the node sends as either a number or a decimal string; absent means `fallback`. */
function intField(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

/**
 * One transaction, trimmed to the fields the map draws.
 *
 * The raw senderData/recipientData blobs do not survive this: a staking transaction's
 * recipientData alone runs to hundreds of bytes and would be cached 50 rows at a time.
 * What the map actually needs from them is one byte each — the op code that says whether
 * this was a stake, an unstake, a reward payout or a contract call — so that byte is
 * lifted out as `dataType`/`senderDataType` and the blob is dropped. `fromType`/`toType`
 * (the @nimiq/core AccountType: 0 basic, 1 vesting, 2 HTLC, 3 staking) and `flags`
 * (bit 1 = signalling) come through as ints for the same reason.
 *
 * A row missing any of hash/from/to/value is not a transaction we can place on the graph:
 * it returns null and the caller drops it.
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
    fromType: intField(row.fromType, 0),
    toType: intField(row.toType, 0),
    flags: intField(row.flags, 0),
    dataType: dataOpCode(row.recipientData),
    senderDataType: dataOpCode(row.senderData),
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

/**
 * One JSON-RPC call to the public node. The node speaks POST only and answers a
 * rejected request with HTTP 200 and the detail in `error`, so both layers are checked
 * here. Every caller gets the same two-way answer: `ok` for whether the node answered,
 * `data` for what it answered with. `data: null` with `ok: true` is the chain saying
 * "no such block or transaction" — the routes below turn that into a 404, never into
 * an upstream error.
 */
async function rpcCall(method, params) {
  let payload;
  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, data: null };
    payload = await response.json();
  } catch {
    return { ok: false, data: null };
  }
  if (payload && typeof payload === 'object' && payload.error) {
    return { ok: true, data: null };
  }
  const data = payload && payload.result ? (payload.result.data ?? null) : null;
  return { ok: true, data };
}

/**
 * A block as the explorer draws it. `number`/`hash` identify it; `transactions` are
 * normalized exactly like history rows, so the feed, the block page and NimMap all
 * speak one shape — and the tx-type bytes that colour NimMap's edges colour the
 * explorer too. A row without a hash or number is not a block: it returns null and the
 * caller drops it.
 */
function normalizeBlock(row) {
  if (!row || typeof row !== 'object') return null;
  const hash = typeof row.hash === 'string' ? row.hash : '';
  const number = toNumber(row.number);
  if (!hash || !number) return null;
  const transactions = Array.isArray(row.transactions)
    ? row.transactions.map(normalizeTransaction).filter(Boolean)
    : [];
  const producer = row.producer && typeof row.producer === 'object' ? row.producer : null;
  return {
    number,
    hash,
    parentHash: typeof row.parentHash === 'string' ? row.parentHash : null,
    timestamp: toNumber(row.timestamp),
    size: toNumber(row.size),
    batch: toNumber(row.batch),
    epoch: toNumber(row.epoch),
    producer: producer && typeof producer.validator === 'string' ? producer.validator : null,
    txCount: transactions.length,
    transactions,
  };
}

/** `?limit=` — an integer in 1..BLOCKS_MAX_LIMIT, or absent for the default. */
function parseBlocksLimit(raw) {
  if (raw === null || raw === '') return BLOCKS_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  return limit >= 1 && limit <= BLOCKS_MAX_LIMIT ? limit : null;
}

/** The chain head plus its last `limit` blocks, newest first, transactions inline. */
async function latestBlocks(ctx, url) {
  const limit = parseBlocksLimit(url.searchParams.get('limit'));
  if (limit === null) return jsonResponse({ error: 'invalid limit' }, 400);

  const cache = globalThis.caches?.default;
  const cacheKey = new Request(new URL(`/api/blocks?limit=${limit}`, url.origin).toString(), {
    method: 'GET',
  });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const head = await rpcCall('getBlockNumber', []);
  if (!head.ok || typeof head.data !== 'number') {
    return jsonResponse({ error: 'upstream' }, 502);
  }

  const numbers = [];
  for (let offset = 0; offset < limit && head.data - offset >= 0; offset++) {
    numbers.push(head.data - offset);
  }
  const rows = await mapWithConcurrency(numbers, 6, (number) =>
    rpcCall('getBlockByNumber', [number, true]),
  );
  const blocks = rows
    .filter((row) => row.ok && row.data)
    .map((row) => normalizeBlock(row.data))
    .filter(Boolean);

  const response = jsonResponse(
    { height: head.data, fetchedAt: Date.now(), source: 'rpc.nimiqwatch.com', blocks },
    200,
    cacheControl(BLOCKS_CACHE_TTL),
  );
  if (cache) {
    const put = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
    else await put;
  }
  return response;
}

/** One block by height or hash, transactions inline. */
async function blockDetail(ctx, url, rawId) {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  const isNumber = /^\d+$/.test(id);
  const hash = id.toLowerCase();
  if (!isNumber && !TX_HASH_RE.test(hash)) {
    return jsonResponse({ error: 'invalid block' }, 400);
  }

  const cache = globalThis.caches?.default;
  const cacheKey = new Request(
    new URL(`/api/block/${encodeURIComponent(isNumber ? id : hash)}`, url.origin).toString(),
    { method: 'GET' },
  );
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const call = isNumber
    ? await rpcCall('getBlockByNumber', [Number(id), true])
    : await rpcCall('getBlockByHash', [hash, true]);
  if (!call.ok) return jsonResponse({ error: 'upstream' }, 502);

  const block = call.data ? normalizeBlock(call.data) : null;
  if (!block) return jsonResponse({ error: 'not found' }, 404);

  const response = jsonResponse({ block }, 200, cacheControl(BLOCK_CACHE_TTL));
  if (cache) {
    const put = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
    else await put;
  }
  return response;
}

/** One transaction by hash. */
async function transactionDetail(ctx, url, rawHash) {
  const hash = typeof rawHash === 'string' ? rawHash.trim().toLowerCase() : '';
  if (!TX_HASH_RE.test(hash)) {
    return jsonResponse({ error: 'invalid transaction' }, 400);
  }

  const cache = globalThis.caches?.default;
  const cacheKey = new Request(new URL(`/api/tx/${hash}`, url.origin).toString(), {
    method: 'GET',
  });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const call = await rpcCall('getTransactionByHash', [hash]);
  if (!call.ok) return jsonResponse({ error: 'upstream' }, 502);

  const tx = call.data ? normalizeTransaction(call.data) : null;
  if (!tx) return jsonResponse({ error: 'not found' }, 404);

  const response = jsonResponse({ tx }, 200, cacheControl(TX_CACHE_TTL));
  if (cache) {
    const put = cache.put(cacheKey, response.clone());
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
    else await put;
  }
  return response;
}

/**
 * "What is this?" — the one box the explorer's search field hands its text to.
 *
 * A bare number is a block height; 64 hex characters may be a block hash or a
 * transaction hash (both are tested, block first); an NQ address is accepted with or
 * without spacing and answered as a canonical address — the client links it into
 * NimMap or the account endpoints. Anything else is a 404, which the search box
 * renders as "nothing matches".
 */
async function searchChain(url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return jsonResponse({ error: 'invalid query' }, 400);

  if (/^\d{1,10}$/.test(q)) {
    const call = await rpcCall('getBlockByNumber', [Number(q), false]);
    if (!call.ok) return jsonResponse({ error: 'upstream' }, 502);
    if (call.data) return jsonResponse({ type: 'block', number: Number(q) });
    return jsonResponse({ error: 'not found' }, 404);
  }

  const lower = q.toLowerCase();
  if (TX_HASH_RE.test(lower)) {
    const [asBlock, asTx] = await Promise.all([
      rpcCall('getBlockByHash', [lower, false]),
      rpcCall('getTransactionByHash', [lower]),
    ]);
    if (!asBlock.ok || !asTx.ok) return jsonResponse({ error: 'upstream' }, 502);
    if (asBlock.data) return jsonResponse({ type: 'block', hash: lower });
    if (asTx.data) return jsonResponse({ type: 'tx', hash: lower });
    return jsonResponse({ error: 'not found' }, 404);
  }

  const address = normalizeAddress(q);
  if (address) return jsonResponse({ type: 'address', address });

  return jsonResponse({ error: 'not found' }, 404);
}

/**
 * NIM spot price in USD, from the first source in PRICE_SOURCES that answers with one.
 * Returns `{price, source}`, or null when every source failed, so callers 502 once.
 *
 * A source is skipped on any of: transport error or timeout, non-2xx, a body that is not
 * JSON, or a quote that is not a finite number above zero. The exchanges send their price
 * as a string, so everything goes through Number() before that check.
 */
async function fetchNimPrice() {
  for (const source of PRICE_SOURCES) {
    let payload;
    try {
      const upstream = await fetch(source.url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!upstream.ok) continue;
      payload = await upstream.json();
    } catch {
      continue;
    }
    const price = Number(source.read(payload));
    if (Number.isFinite(price) && price > 0) return { price, source: source.name };
  }
  return null;
}

/** The price alone, for the callers that report no source of their own. */
async function fetchNimPriceUsd() {
  const quote = await fetchNimPrice();
  return quote === null ? null : quote.price;
}

/** What $29.99 costs in luna at `priceUsd`, rounded up so the pass is never underpaid. */
function requiredLunaAt(priceUsd) {
  return Math.ceil((USD_TARGET * LUNA_PER_NIM) / priceUsd);
}

/**
 * The price of a pass, in the units the wallet needs. Cached for a minute: the point of
 * the tolerance downstream is that this number does not have to be exact.
 *
 * `priceSource` names the feed that answered, so a client — or whoever is reading the
 * logs after CoinGecko starts refusing Cloudflare again — can see which one it was.
 */
async function priceQuote(ctx, url, env) {
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(new URL('/api/quote', url.origin).toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const quote = await fetchNimPrice();
  if (quote === null) return jsonResponse({ error: 'upstream' }, 502);

  const { price: priceUsd } = quote;
  const requiredLuna = requiredLunaAt(priceUsd);
  const response = jsonResponse(
    {
      priceUsd,
      priceSource: quote.source,
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
 * The bearer tokens: base64url("<kind>:<address>:<expiry>.<hmac>").
 *
 * Both kinds are receipts, not sessions. A `sub` token says "the chain showed this
 * address paid until this instant"; an `auth` token says "this address proved it holds
 * its key at this instant". Nothing is stored server-side, so a lost token costs the user
 * one round trip and a stolen one expires on its own.
 *
 * The kind is inside the signed payload rather than alongside it, because it is exactly
 * the thing an attacker would want to change: without it, the hour-long proof-of-key
 * token from /api/auth/verify would also open /api/me as a 30-day pass. The address is
 * carried compacted, and neither separator can occur in any field.
 */
async function mintToken(kind, addressCompact, expiresAt, secret) {
  const payload = `${kind}:${addressCompact}:${expiresAt}`;
  return base64UrlEncode(`${payload}.${await signPayload(payload, secret)}`);
}

/** `{kind, addressCompact, expiresAt}` for a token this worker signed, otherwise null. */
async function readToken(token, secret) {
  const decoded = typeof token === 'string' && token ? base64UrlDecode(token) : null;
  if (!decoded) return null;

  const parts = decoded.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;

  const fields = payload.split(':');
  if (fields.length !== 3) return null;
  const [kind, addressCompact, expiresRaw] = fields;
  if (!TOKEN_KINDS.has(kind) || !ADDRESS_RE.test(addressCompact) || !/^\d+$/.test(expiresRaw)) {
    return null;
  }

  const expected = await signPayload(payload, secret);
  if (!timingSafeEqual(signature, expected)) return null;

  return { kind, addressCompact, expiresAt: Number(expiresRaw) };
}

/** The token out of `Authorization: Bearer <token>`, or null when there is not one. */
function bearerToken(request) {
  const match = /^Bearer\s+(\S+)$/i.exec((request.headers.get('Authorization') || '').trim());
  return match ? match[1] : null;
}

/** How much pass is left, in the three units the UI wants. */
function entitlementWindow(paidUntil) {
  const expiresInMs = paidUntil - Date.now();
  return { paidUntil, expiresInMs, daysLeft: Math.max(0, Math.ceil(expiresInMs / DAY_MS)) };
}

// --- signed sign-in ---------------------------------------------------------

/** `length` bytes from a hex string of exactly that size, or null for anything else. */
function hexToBytes(hex, length) {
  if (typeof hex !== 'string' || hex.length !== length * 2 || !HEX_RE.test(hex)) return null;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Nimiq base32 — no padding, and 20 bytes divide into exactly 32 characters. */
function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The two digits after "NQ" — an IBAN check, not a hash.
 *
 * Nimiq addresses are IBANs in shape as well as in spelling: move the country code and
 * its placeholder "00" to the end, replace every character by its base-36 value (A=10 …
 * Z=35), read the result as one long decimal number, and the check is 98 - (n mod 97).
 * The number runs to ~40 digits, so the modulo is folded digit by digit rather than
 * asking Number to hold it.
 */
function ibanCheckDigits(base32Body) {
  let remainder = 0;
  for (const char of `${base32Body}NQ00`) {
    for (const digit of parseInt(char, 36).toString()) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return String(98 - remainder).padStart(2, '0');
}

/**
 * The address a public key spends from — the whole point of the sign-in flow, since it is
 * what turns "this key signed" into "this account signed".
 *
 * Derivation, verified byte for byte against @nimiq/core in the test suite: take
 * BLAKE2b-256 of the 32-byte public key, keep the first 20 bytes, base32 them with the
 * alphabet above, prefix "NQ" and the IBAN check digits, and group by four.
 *
 * Exported so the suite can check it against real keypairs directly rather than only
 * through a sign-in round trip; a named export beside the default one is inert to
 * wrangler, which only looks at `default`.
 */
export function deriveAddress(publicKey) {
  const body = base32Encode(blake2b256(publicKey).subarray(0, ADDRESS_BYTES));
  const address = `NQ${ibanCheckDigits(body)}${body}`;
  return (address.match(/.{1,4}/g) || []).join(' ');
}

/** What the Hub actually signs for `message` — see SIGNED_MESSAGE_PREFIX. */
async function signedMessageDigest(message) {
  const body = encoder.encode(message);
  // The length is the message's byte count, not its character count, and is spelled in
  // decimal ASCII. Our own messages are ASCII so the two agree, but the client picks the
  // nonce it signs and the rule is the protocol's, not ours.
  const header = encoder.encode(`${SIGNED_MESSAGE_PREFIX}${body.length}`);
  const payload = new Uint8Array(header.length + body.length);
  payload.set(header, 0);
  payload.set(body, header.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
}

/**
 * Ed25519 verify, via WebCrypto — the same primitive Nimiq signs with, so no curve
 * arithmetic is carried here. A key the runtime refuses to import (a 32-byte string that
 * is not a curve point) throws rather than returning false; either way it is not a
 * signature we accept.
 */
async function verifyEd25519(publicKey, signature, digest) {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    return await crypto.subtle.verify('Ed25519', key, signature, digest);
  } catch {
    return false;
  }
}

/** The message the client hands to the Hub verbatim. ASCII, so every wallet renders it. */
function signInMessage(nonce) {
  return `${SIGN_IN_DOMAIN} NimMap sign-in\nnonce: ${nonce}`;
}

/**
 * A nonce with no state behind it: "<issued-at base36>.<hmac>".
 *
 * Storing nonces would mean a KV namespace and a write per sign-in, to defend against a
 * replay the 10-minute window already closes. The HMAC is what makes the timestamp
 * unforgeable, so a nonce cannot be back-dated into the window or minted without the
 * secret. It is domain-separated from the token HMAC so neither signature can stand in
 * for the other.
 */
async function mintNonce(secret, issuedAt) {
  const stamp = issuedAt.toString(36);
  return `${stamp}.${await signPayload(`nonce:${stamp}`, secret)}`;
}

/** `{issuedAt}` for a nonce this worker signed inside the TTL, otherwise null. */
async function readNonce(nonce, secret) {
  if (typeof nonce !== 'string' || !nonce || nonce.length > 128) return null;

  const parts = nonce.split('.');
  if (parts.length !== 2) return null;
  const [stamp, signature] = parts;
  if (!/^[0-9a-z]{1,12}$/.test(stamp)) return null;

  const expected = await signPayload(`nonce:${stamp}`, secret);
  if (!timingSafeEqual(signature, expected)) return null;

  const issuedAt = parseInt(stamp, 36);
  // Only the upper bound is checked: a future timestamp would have to have been signed
  // with the secret, and a worker whose clock ran ahead is not an attacker.
  if (Date.now() - issuedAt > NONCE_TTL_MS) return null;

  return { issuedAt };
}

/** `GET /api/auth/nonce` — the challenge, and the exact message to sign with it. */
async function issueNonce(env) {
  const secret = env && env.CHAINMAP_TOKEN_SECRET;
  if (!secret) return jsonResponse({ error: 'server misconfigured' }, 500);

  const nonce = await mintNonce(secret, Date.now());
  // No cache, at any layer: a shared nonce is a shared challenge.
  return jsonResponse(
    { nonce, message: signInMessage(nonce), expiresInMs: NONCE_TTL_MS },
    200,
    { 'Cache-Control': 'no-store' },
  );
}

/**
 * Walk an address's history newest-first looking for the payment that buys a pass.
 *
 * The node pages with `startAt` set to the last hash of the page before, and returns
 * newest first — so the first page carrying a qualifying payment carries the newest one,
 * and the walk stops there rather than reading history it cannot use. A short page is the
 * end of the history and also stops the walk; otherwise it gives up after
 * ENTITLEMENT_MAX_PAGES and the caller reports `no_payment`.
 *
 * Within a page the ordering is not leaned on — the newest timestamp wins explicitly,
 * because this number decides how much pass someone has left.
 */
async function findNewestPayment(address, target, minimumLuna) {
  let startAt = null;
  let sawUnderpayment = false;

  for (let page = 1; page <= ENTITLEMENT_MAX_PAGES; page++) {
    const result = await fetchTransactions(address, ENTITLEMENT_PAGE_SIZE, startAt);
    if (!result.ok) return { ok: false };

    let newest = null;
    for (const row of result.data) {
      const tx = normalizeTransaction(row);
      if (!tx || compactAddress(tx.to) !== target) continue;
      if (tx.value < minimumLuna) {
        sawUnderpayment = true;
        continue;
      }
      const timestamp = Number.isFinite(tx.timestamp) ? tx.timestamp : 0;
      if (!newest || timestamp > newest.timestamp) newest = { timestamp };
    }
    if (newest) return { ok: true, payment: newest, sawUnderpayment, pages: page };

    // The cursor has to be a hash the node will accept, and it comes off the raw row:
    // a row we could not normalize still moves the page forward.
    const last = result.data[result.data.length - 1];
    const rawHash = last && typeof last.hash === 'string' ? last.hash.trim() : '';
    const cursor = TX_HASH_RE.test(rawHash) ? rawHash : null;
    if (result.data.length < ENTITLEMENT_PAGE_SIZE || !cursor || cursor === startAt) {
      return { ok: true, payment: null, sawUnderpayment, pages: page };
    }
    startAt = cursor;
  }

  return { ok: true, payment: null, sawUnderpayment, pages: ENTITLEMENT_MAX_PAGES };
}

/**
 * Does the chain show a pass for this address? The one place that question is answered,
 * shared by /api/auth/verify and /api/entitlement.
 *
 * There are no accounts here: the payment transaction on chain is the receipt, so the
 * only question is whether there is a transfer from that address to the paywall address
 * large enough to count. The newest such payment wins, and the 30 days run from its own
 * timestamp — someone who paid three weeks ago gets the week they have left, not a fresh
 * month for asking.
 *
 * The price is re-fetched rather than taken from the request: a caller who could name
 * their own `requiredLuna` could buy the pass for a luna. PAYMENT_TOLERANCE then allows
 * for NIM having moved between the quote the user signed and this moment.
 *
 * A comped address is answered before any of that and never reaches it: no price, no
 * history walk, no 30-day window. That ordering is the feature, not an optimisation — a
 * comp pass is the one that has to work when CoinGecko is refusing Cloudflare and the RPC
 * node is down, and it cannot depend on the upstreams it exists to be independent of.
 *
 * Returns `{status: 'upstream' | 'unpaid' | 'paid', …}`; the callers shape the JSON,
 * because the two routes answer in different envelopes. `comp: true` rides along on the
 * paid answer purely so the client can say "no expiry" instead of counting out 36,500
 * days — everything else downstream reads the status and sees an ordinary pass.
 */
async function resolveEntitlement(address, env) {
  if (isCompAddress(address, env)) {
    return { status: 'paid', comp: true, paidUntil: Date.now() + COMP_PASS_MS };
  }

  const priceUsd = await fetchNimPriceUsd();
  if (priceUsd === null) return { status: 'upstream' };

  const requiredLuna = requiredLunaAt(priceUsd);
  const minimumLuna = Math.floor(PAYMENT_TOLERANCE * requiredLuna);

  const search = await findNewestPayment(address, compactAddress(paywallAddress(env)), minimumLuna);
  if (!search.ok) return { status: 'upstream' };

  if (!search.payment) {
    return {
      status: 'unpaid',
      reason: search.sawUnderpayment ? 'amount_too_low' : 'no_payment',
      requiredLuna,
      priceUsd,
    };
  }

  const paidUntil = search.payment.timestamp + ENTITLEMENT_DAYS * DAY_MS;
  if (Date.now() >= paidUntil) {
    return { status: 'unpaid', reason: 'expired', paidUntil, requiredLuna, priceUsd };
  }

  return { status: 'paid', paidUntil, requiredLuna, priceUsd };
}

/**
 * `POST /api/auth/verify` — sign in a wallet by signature, then tell it where it stands.
 *
 * This is the route that makes the paywall mean anything. An address proves nothing on
 * its own: every paid address is written on the chain in public, so the previous version
 * of this flow — post `{address}`, get a pass — handed a 30-day token to anyone who read
 * a block explorer. Here the client posts a signature over a nonce this worker issued,
 * and the address is *derived from the key that produced it* rather than taken on trust.
 *
 * The four checks run in order, each with its own 401, because the client shows the user
 * a different thing for each: a stale nonce means "try again", a bad signature means "that
 * wallet did not sign", a mismatch means the address and the key disagree.
 *
 * Both tokens are minted whatever the payment says. `authToken` is proof of key and is
 * useful to an unpaid wallet — it is what lets the client re-check after the user pays,
 * without a second Hub popup. `token`, the pass itself, is only minted when the chain
 * shows one.
 *
 * Callers are gated on Origin in `fetch` before this runs, and nothing here is cached.
 */
async function verifySignIn(request, env) {
  const secret = env && env.CHAINMAP_TOKEN_SECRET;
  if (!secret) return jsonResponse({ error: 'server misconfigured' }, 500);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_AUTH_BODY) return jsonResponse({ error: 'invalid body' }, 400);
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  // An array parses as an object and would fall through to "invalid address"; a sign-in
  // body is a JSON object or it is nothing.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'invalid body' }, 400);
  }

  // Shape first, so a typo costs a 400 and no work: the checks below spend a SHA-256, a
  // curve operation and up to six subrequests each.
  const claimed = normalizeAddress(body.address);
  if (!claimed) return jsonResponse({ error: 'invalid address' }, 400);
  const publicKey = hexToBytes(body.signerPublicKey, PUBLIC_KEY_BYTES);
  if (!publicKey) return jsonResponse({ error: 'invalid public key' }, 400);
  const signature = hexToBytes(body.signature, SIGNATURE_BYTES);
  if (!signature) return jsonResponse({ error: 'invalid signature' }, 400);

  if (!(await readNonce(body.nonce, secret))) {
    return jsonResponse({ error: 'invalid nonce' }, 401);
  }

  // The message is rebuilt from the nonce rather than accepted from the client: whatever
  // they signed, what is verified is the one sentence this worker would have issued.
  const digest = await signedMessageDigest(signInMessage(body.nonce));
  if (!(await verifyEd25519(publicKey, signature, digest))) {
    return jsonResponse({ error: 'invalid signature' }, 401);
  }

  const address = deriveAddress(publicKey);
  if (compactAddress(address) !== compactAddress(claimed)) {
    return jsonResponse({ error: 'address mismatch' }, 401);
  }

  const entitlement = await resolveEntitlement(address, env);
  if (entitlement.status === 'upstream') return jsonResponse({ error: 'upstream' }, 502);

  const addressCompact = compactAddress(address);
  const authToken = await mintToken('auth', addressCompact, Date.now() + AUTH_TOKEN_TTL_MS, secret);

  if (entitlement.status !== 'paid') {
    return jsonResponse(
      {
        ok: true,
        entitled: false,
        reason: entitlement.reason,
        ...(entitlement.paidUntil ? { paidUntil: entitlement.paidUntil } : {}),
        authToken,
        requiredLuna: entitlement.requiredLuna,
        priceUsd: entitlement.priceUsd,
        paywallAddress: paywallAddress(env),
      },
      200,
    );
  }

  return jsonResponse(
    {
      ok: true,
      entitled: true,
      address,
      ...entitlementWindow(entitlement.paidUntil),
      token: await mintToken('sub', addressCompact, entitlement.paidUntil, secret),
      authToken,
      // A comp pass was never priced, so it quotes no price: `comp` stands where
      // requiredLuna and priceUsd would be, and the client shows no expiry rather than
      // the century this pass nominally runs for.
      ...(entitlement.comp
        ? { comp: true }
        : { requiredLuna: entitlement.requiredLuna, priceUsd: entitlement.priceUsd }),
    },
    200,
  );
}

/**
 * `POST /api/entitlement` — re-ask the chain about an already signed-in wallet.
 *
 * The address comes from the `auth` token and nowhere else, which is the whole difference
 * from the version this replaced: there is no body to name an address in. It is the route
 * the client polls while a payment confirms, so it costs a Hub popup only on the first
 * sign-in of the hour, not on every check.
 *
 * Callers are gated on Origin in `fetch` before this runs, and nothing here is cached —
 * a cached answer would hand the first caller's pass to the next wallet that asked.
 */
async function checkEntitlement(request, env) {
  const secret = env && env.CHAINMAP_TOKEN_SECRET;
  if (!secret) return jsonResponse({ error: 'server misconfigured' }, 500);

  const claims = await readToken(bearerToken(request), secret);
  // A `sub` token is turned away as firmly as a forged one: it is a statement about a
  // pass, not proof that whoever holds it can sign for the address.
  if (!claims || claims.kind !== 'auth' || Date.now() >= claims.expiresAt) {
    return jsonResponse({ error: 'invalid token' }, 401);
  }

  const address = normalizeAddress(claims.addressCompact);
  const entitlement = await resolveEntitlement(address, env);
  if (entitlement.status === 'upstream') return jsonResponse({ error: 'upstream' }, 502);

  if (entitlement.status !== 'paid') {
    return jsonResponse(
      {
        entitled: false,
        reason: entitlement.reason,
        ...(entitlement.paidUntil ? { paidUntil: entitlement.paidUntil } : {}),
        requiredLuna: entitlement.requiredLuna,
        priceUsd: entitlement.priceUsd,
      },
      200,
    );
  }

  return jsonResponse(
    {
      entitled: true,
      address,
      ...entitlementWindow(entitlement.paidUntil),
      token: await mintToken('sub', claims.addressCompact, entitlement.paidUntil, secret),
      ...(entitlement.comp
        ? { comp: true }
        : { requiredLuna: entitlement.requiredLuna, priceUsd: entitlement.priceUsd }),
    },
    200,
  );
}

/**
 * Re-check a pass token — the path the app takes on every page load, costing no
 * subrequest at all, since the token already carries the answer the chain gave.
 *
 * A token we did not sign, one edited after we did, or an `auth` token presented as a
 * pass is a 401. A `sub` token that is genuine but describes a pass that has run out is a
 * 200 saying so: the client is authenticated, it simply has nothing left, and the
 * difference tells it whether to show "connect wallet" or "renew".
 *
 * The comp list is re-read here rather than baked into the token, so the flag always
 * describes the list as it stands now. It changes only how the pass is labelled — the
 * token's own expiry still decides whether there is one, which is what keeps this route
 * free of any chain read at all.
 */
async function currentEntitlement(request, env) {
  const secret = env && env.CHAINMAP_TOKEN_SECRET;
  if (!secret) return jsonResponse({ error: 'server misconfigured' }, 500);

  const claims = await readToken(bearerToken(request), secret);
  if (!claims || claims.kind !== 'sub') return jsonResponse({ error: 'invalid token' }, 401);

  if (Date.now() >= claims.expiresAt) {
    return jsonResponse({ entitled: false, reason: 'expired' }, 200);
  }

  return jsonResponse(
    {
      entitled: true,
      address: normalizeAddress(claims.addressCompact),
      ...(isCompAddress(claims.addressCompact, env) ? { comp: true } : {}),
      ...entitlementWindow(claims.expiresAt),
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
