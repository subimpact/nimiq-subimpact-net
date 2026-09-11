/**
 * nimiq-api — read-only CORS proxy for NimiqHub REST data.
 *
 * api.nimiqhub.com serves the data we need but sends no Access-Control-Allow-Origin
 * header, so nimiq.subimpact.net cannot call it from the browser. This worker fronts
 * a small whitelist of GET endpoints, adds CORS for known origins, and caches
 * responses for 60s at the edge.
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
      return withHeaders(await proxy(request, ctx, url, '/getValidators'), cors);
    }

    if (segments.length === 2 && segments[1] === 'network') {
      return withHeaders(await networkSummary(ctx, url), cors);
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
      return withHeaders(await proxy(request, ctx, cacheUrl, path), cors);
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

function cacheControl() {
  return { 'Cache-Control': `public, max-age=${CACHE_TTL}` };
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

/**
 * Serve `cacheUrl` from the edge cache, otherwise fetch `upstreamPath` from NimiqHub.
 * Cached entries carry no CORS headers — those are applied per-request by the caller.
 */
async function proxy(request, ctx, cacheUrl, upstreamPath) {
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
