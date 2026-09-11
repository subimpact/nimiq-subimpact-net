/**
 * Local test harness for the nimiq-api worker — plain Node, no dependencies.
 *
 * Drives the exported fetch handler directly with mocked Requests, stubbing
 * globalThis.fetch (fake NimiqHub) and globalThis.caches (in-memory Cache API).
 *
 *   node worker/test-local.mjs
 */

import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://nimiq.subimpact.net';
const BASE = 'https://nimiq-api.example.workers.dev';
const ADDRESS = 'NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY';
const ADDRESS_ENCODED = encodeURIComponent(ADDRESS);
const EXPECTED_UPSTREAM_ADDRESS =
  'NQ08%20ACT8%20T0FE%20PTG8%20P5RL%20H2S3%20QGXH%20V15R%20NVXY';

// /api/graph fixtures: two validators, the first with two stakers.
const VALIDATOR_A = ADDRESS;
const VALIDATOR_B = 'NQ97 04UL PBTY 3P4R TARV G303 K713 FNNY 4J3Y';
const STAKER_A1 = 'NQ27 NCB1 3CYU 9P4L EM2V D7L2 28QE 36PA EXB1';
const STAKER_A2 = 'NQ16 085S 7JNP YJNY UA5N G5Y5 B98N 0JT7 6GKB';
const NAMES_URL = 'https://validators-api-main.je-cf9.workers.dev/api/v1/validators';

// --- stubs -----------------------------------------------------------------

function jsonUpstream(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Canned NimiqHub chain-head responses, in the three shapes the API actually returns. */
function networkUpstream(url) {
  if (url.endsWith('/getBlockNumber')) return jsonUpstream({ blockNumber: 61307037, metadata: null });
  if (url.endsWith('/getEpochNumber')) return jsonUpstream({ epochNumber: { data: 1340, metadata: null } });
  if (url.endsWith('/getBatchNumber')) return jsonUpstream({ batchNumber: 964184, metadata: null });
  return new Response('not found', { status: 404 });
}

function stakersPath(address) {
  return `/getStakersByValidatorAddress/${encodeURIComponent(address)}`;
}

/**
 * Canned NimiqHub + validator-names responses for /api/graph.
 * `opts.bStakers` sets validator B's reported staker count; `opts.bFails` makes its
 * staker call return 500; otherwise B's list comes back empty.
 */
function graphUpstream(opts = {}) {
  return (url) => {
    if (url.endsWith('/getValidators')) {
      return jsonUpstream({
        data: [
          { address: VALIDATOR_A, balance: 300000000, numStakers: 2 },
          { address: VALIDATOR_B, balance: 100000000, numStakers: opts.bStakers ?? 0 },
        ],
        metadata: null,
      });
    }
    if (url.endsWith(stakersPath(VALIDATOR_A))) {
      return jsonUpstream({
        data: [
          { address: STAKER_A1, balance: 200000000, delegation: VALIDATOR_A },
          { address: STAKER_A2, balance: 50000000, delegation: VALIDATOR_A },
        ],
        metadata: null,
      });
    }
    if (url.endsWith(stakersPath(VALIDATOR_B))) {
      if (opts.bFails) return new Response('boom', { status: 500 });
      return jsonUpstream({ data: [], metadata: null });
    }
    if (url === NAMES_URL) {
      return jsonUpstream([{ id: 1, name: 'ImpactZero stake', address: VALIDATOR_A, fee: 0 }]);
    }
    return new Response('not found', { status: 404 });
  };
}

// --- /api/staker + /api/broadcast fixtures ---------------------------------

const STAKER_ADDRESS = STAKER_A1;
const STAKER_ADDRESS_ENCODED = encodeURIComponent(STAKER_A1);
const RPC_URL = 'https://rpc.nimiqwatch.com';
// 188 hex-encoded bytes — the size a create-staker transaction serializes to.
const TX_HEX = 'ab'.repeat(188);
const TX_HASH = '2e4046ff5ca6071e5137f0c492e3de70226322352512a89aa69677e5d0dc07d3';

/**
 * getStakerByAddress, in the three shapes NimiqHub actually returns:
 * the staker, a 502 carrying "No staker with address" for an address that never
 * staked, and a plain failure when the API itself is unwell (`opts.down`).
 */
function stakerUpstream(opts = {}) {
  return (url) => {
    if (!url.includes('/getStakerByAddress/')) return new Response('not found', { status: 404 });
    if (opts.missing) {
      return new Response(
        JSON.stringify({
          error: `Internal error: No staker with address: ${STAKER_ADDRESS}`,
          code: 502,
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (opts.down) return new Response('service unavailable', { status: 503 });
    return jsonUpstream({
      data: {
        address: STAKER_ADDRESS,
        balance: 341219403873,
        delegation: VALIDATOR_A,
        inactiveBalance: 0,
        inactiveFrom: null,
        retiredBalance: 0,
      },
      metadata: { blockNumber: 61311359, blockHash: 'abc' },
    });
  };
}

/**
 * The RPC node's sendRawTransaction replies. It answers HTTP 200 whether the
 * transaction was accepted or rejected; a rejection is an `error` member whose
 * `data` holds the detail. `opts.httpFail` stands in for the node being down.
 */
function rpcUpstream(opts = {}) {
  return (url) => {
    if (url !== RPC_URL) return new Response('not found', { status: 404 });
    if (opts.httpFail) return new Response('service unavailable', { status: 503 });
    if (opts.rejection) {
      return jsonUpstream({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error', data: opts.rejection },
        id: 1,
      });
    }
    if (opts.messageOnly) {
      return jsonUpstream({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: 1 });
    }
    if (opts.emptyResult) return jsonUpstream({ jsonrpc: '2.0', result: null, id: 1 });
    return jsonUpstream({ jsonrpc: '2.0', result: { data: TX_HASH, metadata: null }, id: 1 });
  };
}

function postBroadcast(body) {
  return call('/api/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// --- ChainMap paywall fixtures ---------------------------------------------

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2&vs_currencies=usd';
const PAYWALL_ADDRESS = 'NQ70 SM7L 2PKV 7D55 SUUA B80X 1DML 5XS1 XHJC';
const PAYWALL_COMPACT = PAYWALL_ADDRESS.replace(/\s+/g, '');
// Not the deployed secret: that one is a wrangler secret and lives nowhere in this repo.
const TOKEN_SECRET = 'test-secret-not-the-deployed-one';
/** The bindings the worker reads off `env`; wrangler supplies these in production. */
const ENV = { PAYWALL_ADDRESS, CHAINMAP_TOKEN_SECRET: TOKEN_SECRET };

// The fixture price and the amounts derived from it, worked out here rather than read
// back from the worker — these literals are what the arithmetic is being checked against.
//   $29.99 / $0.0004 per NIM      = 74,975 NIM
//   74,975 NIM x 100,000 luna/NIM = 7,497,500,000 luna
//   85% tolerance floor           = 6,372,875,000 luna
const PRICE_USD = 0.0004;
const REQUIRED_NIM = 74975;
const REQUIRED_LUNA = 7497500000;
const TOLERANCE_FLOOR_LUNA = 6372875000;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const RECENT_PAYMENT_MS = NOW - 2 * DAY_MS;
const STALE_PAYMENT_MS = NOW - 31 * DAY_MS;

const HISTORY_HASH_1 = 'a'.repeat(64);
const HISTORY_HASH_2 = 'b'.repeat(64);
const CURSOR_HASH = 'c1d2'.repeat(16);

/**
 * One transaction in the shape rpc.nimiqwatch.com actually returns, noise included:
 * fromType/toType and the senderData/recipientData blobs the worker is expected to drop.
 */
function txFixture(overrides = {}) {
  return {
    hash: HISTORY_HASH_1,
    blockNumber: 61301932,
    timestamp: RECENT_PAYMENT_MS,
    confirmations: 14148,
    size: 152,
    relatedAddresses: [ADDRESS, STAKER_A1],
    from: ADDRESS,
    fromType: 0,
    to: STAKER_A1,
    toType: 0,
    value: 100000,
    fee: 138,
    senderData: '',
    recipientData: 'de'.repeat(300),
    ...overrides,
  };
}

/** A payment of `value` luna to the paywall address; `to` overridable to test matching. */
function paymentFixture(value, overrides = {}) {
  return txFixture({ hash: HISTORY_HASH_2, to: PAYWALL_ADDRESS, value, ...overrides });
}

/**
 * The paywall's two upstreams: CoinGecko's price feed and the RPC node's
 * getTransactionsByAddress. Like sendRawTransaction, the node answers HTTP 200 for a
 * request it rejected, with the detail in `error.data` (`opts.rejection`).
 */
function paywallUpstream(opts = {}) {
  return (url, init) => {
    if (url === COINGECKO_URL) {
      if (opts.priceFails) return new Response('rate limited', { status: 429 });
      if (opts.priceThrows) throw new Error('connection refused');
      if (opts.priceGarbage) return jsonUpstream({ 'nimiq-2': {} });
      return jsonUpstream({ 'nimiq-2': { usd: opts.priceUsd ?? PRICE_USD } });
    }
    if (url !== RPC_URL) return new Response('not found', { status: 404 });
    const sent = JSON.parse(init.body);
    if (sent.method !== 'getTransactionsByAddress') return new Response('not found', { status: 404 });
    if (opts.historyThrows) throw new Error('connection refused');
    if (opts.historyHttpFail) return new Response('service unavailable', { status: 503 });
    if (opts.rejection) {
      return jsonUpstream({
        jsonrpc: '2.0',
        error: { code: -32602, message: 'Internal error', data: opts.rejection },
        id: 1,
      });
    }
    return jsonUpstream({ jsonrpc: '2.0', result: { data: opts.txs ?? [], metadata: null }, id: 1 });
  };
}

/** The params of the last getTransactionsByAddress call, or null if there was none. */
function lastHistoryParams() {
  for (let i = upstreamCalls.length - 1; i >= 0; i--) {
    if (upstreamCalls[i].url !== RPC_URL) continue;
    const sent = JSON.parse(upstreamCalls[i].init.body);
    if (sent.method === 'getTransactionsByAddress') return sent.params;
  }
  return null;
}

function postEntitlement(body, headers = {}) {
  return call('/api/entitlement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function getMe(token) {
  return call('/api/me', token ? { headers: { Authorization: `Bearer ${token}` } } : {});
}

/**
 * A pass token minted here, independently of the worker: base64url of
 * "<compact address>.<paidUntil>.<hex HMAC-SHA256>". Signing it from the test rather
 * than reusing the worker's own helper is what makes the format an assertion.
 */
function mintTestToken(addressCompact, paidUntil, secret = TOKEN_SECRET) {
  const payload = `${addressCompact}.${paidUntil}`;
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

/** Rebuild a token from its decoded parts, so a test can edit one of them. */
function forgeToken(parts) {
  return Buffer.from(parts.join('.')).toString('base64url');
}

// --- /api/graph at mainnet scale -------------------------------------------
//
// Workers Free allows 50 units per invocation, and fetch() shares that quota with
// Cache API match/put/delete. Each /api/graph part costs 1 match + 1 put on top of its
// fetches, so the fetch budget below leaves ample headroom.
const MAX_FETCHES_PER_PART = 32;
const GRAPH_CHUNK = 26;

/** Deterministic, unique, regex-valid Nimiq addresses: NQ + 34 base32 chars. */
function fakeAddress(prefix, index) {
  const body = `${prefix}${String(index).padStart(3, '0')}`.toUpperCase();
  return `NQ${(body + 'X'.repeat(34)).slice(0, 34)}`.match(/.{1,4}/g).join(' ');
}

// 52 validators — today's mainnet count — four of which report no stakers at all.
const BULK_ZERO_STAKER_INDEXES = new Set([7, 18, 33, 44]);
const BULK_STAKERS_PER_VALIDATOR = 2;
const BULK_VALIDATORS = Array.from({ length: 52 }, (_, index) => ({
  address: fakeAddress('VAL', index),
  balance: 1000000 * (index + 1),
  numStakers: BULK_ZERO_STAKER_INDEXES.has(index) ? 0 : BULK_STAKERS_PER_VALIDATOR,
}));
/** The validators that actually cost a round trip — the list the worker splits. */
const BULK_FETCHABLE = BULK_VALIDATORS.filter((validator) => validator.numStakers > 0);

function bulkStakers(index) {
  return Array.from({ length: BULK_STAKERS_PER_VALIDATOR }, (_, n) => ({
    address: fakeAddress('STK', index * BULK_STAKERS_PER_VALIDATOR + n),
    balance: 1000 * (index + 1) + n,
    delegation: BULK_VALIDATORS[index].address,
  }));
}

/** `opts.failAddress` makes that one validator's staker call return 500. */
function bulkGraphUpstream(opts = {}) {
  return (url) => {
    if (url.endsWith('/getValidators')) {
      return jsonUpstream({ data: BULK_VALIDATORS, metadata: null });
    }
    if (url === NAMES_URL) {
      return jsonUpstream([{ id: 1, name: 'Bulk validator 0', address: BULK_VALIDATORS[0].address }]);
    }
    const index = BULK_VALIDATORS.findIndex((validator) => url.endsWith(stakersPath(validator.address)));
    if (index >= 0) {
      if (opts.failAddress === BULK_VALIDATORS[index].address) {
        return new Response('boom', { status: 500 });
      }
      return jsonUpstream({ data: bulkStakers(index), metadata: null });
    }
    return new Response('not found', { status: 404 });
  };
}

/** Records every upstream call; returns a canned JSON body. */
const upstreamCalls = [];
let upstreamHandler = () =>
  new Response(JSON.stringify({ fake: 'upstream' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  upstreamCalls.push({ url, init });
  return upstreamHandler(url, init);
};

/** Minimal in-memory Cache API: keyed by request URL, stores cloned Responses. */
const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(request) {
      const key = typeof request === 'string' ? request : request.url;
      const stored = cacheStore.get(key);
      return stored ? stored.clone() : undefined;
    },
    async put(request, response) {
      const key = typeof request === 'string' ? request : request.url;
      cacheStore.set(key, response.clone());
    },
  },
};

const ctx = { waitUntil: (promise) => promise.catch(() => {}) };

const workerUrl = pathToFileURL(new URL('./src/index.js', import.meta.url).pathname).href;
const worker = (await import(workerUrl)).default;

/**
 * Sends the allowlisted Origin unless one is given, or `init.omitOrigin` drops it.
 * `init.env` overrides the bindings for a test that needs one missing.
 */
function call(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!init.omitOrigin && !headers.has('Origin')) headers.set('Origin', ORIGIN);
  return worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }), init.env || ENV, ctx);
}

/** One worker invocation, plus how many upstream fetches it made. */
async function callCounting(path, init = {}) {
  const before = upstreamCalls.length;
  const res = await call(path, init);
  return { res, fetches: upstreamCalls.length - before };
}

function reset() {
  upstreamCalls.length = 0;
  cacheStore.clear();
  upstreamHandler = () =>
    new Response(JSON.stringify({ fake: 'upstream' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

// --- runner ----------------------------------------------------------------

let passed = 0;
let failed = 0;
const notes = [];

/** Measurements a test wants in the transcript; printed under its PASS/FAIL line. */
function note(message) {
  notes.push(message);
}

async function test(name, fn) {
  reset();
  notes.length = 0;
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message}`);
  }
  for (const line of notes) console.log(`      ${line}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

// --- cases -----------------------------------------------------------------

await test('OPTIONS preflight -> 204 + CORS headers', async () => {
  const res = await call('/api/validators', { method: 'OPTIONS' });
  assertEqual(res.status, 204, 'status');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
  assertEqual(res.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS', 'ACAM');
  // Authorization is allowed so the browser may send the ChainMap pass on /api/me.
  assertEqual(res.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization', 'ACAH');
  assertEqual(res.headers.get('Vary'), 'Origin', 'Vary');
});

await test('GET /api/health -> 200 {ok:true}', async () => {
  const res = await call('/api/health');
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.ok, true, 'body.ok');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
});

await test('GET /api/stakers/:address -> upstream called with normalized address', async () => {
  const res = await call(`/api/stakers/${ADDRESS_ENCODED}`);
  assertEqual(res.status, 200, 'status');
  assertEqual(upstreamCalls.length, 1, 'upstream call count');
  const url = upstreamCalls[0].url;
  assert(
    url === `https://api.nimiqhub.com/getStakersByValidatorAddress/${EXPECTED_UPSTREAM_ADDRESS}`,
    `upstream URL: got ${url}`,
  );
  assert(url.includes(EXPECTED_UPSTREAM_ADDRESS), 'upstream URL missing 4-char-block encoding');
  assertEqual(
    upstreamCalls[0].init.headers['User-Agent'],
    'nimiq-api/1.0 (+https://nimiq.subimpact.net)',
    'User-Agent',
  );
  assertEqual(res.headers.get('Cache-Control'), 'public, max-age=60', 'Cache-Control');
});

await test('GET /api/stakers/:address (unspaced, lowercase) -> same normalized upstream', async () => {
  const compact = ADDRESS.replace(/\s+/g, '').toLowerCase();
  const res = await call(`/api/stakers/${compact}`);
  assertEqual(res.status, 200, 'status');
  assert(
    upstreamCalls[0].url.includes(EXPECTED_UPSTREAM_ADDRESS),
    `upstream URL: got ${upstreamCalls[0].url}`,
  );
});

await test('GET /api/account/:address -> getAccountByAddress', async () => {
  const res = await call(`/api/account/${ADDRESS_ENCODED}`);
  assertEqual(res.status, 200, 'status');
  assertEqual(
    upstreamCalls[0].url,
    `https://api.nimiqhub.com/getAccountByAddress/${EXPECTED_UPSTREAM_ADDRESS}`,
    'upstream URL',
  );
});

await test('GET /api/staker/:address -> getStakerByAddress with a normalized address', async () => {
  upstreamHandler = stakerUpstream();
  const res = await call(`/api/staker/${STAKER_ADDRESS_ENCODED}`);
  assertEqual(res.status, 200, 'status');
  assertEqual(
    upstreamCalls[0].url,
    `https://api.nimiqhub.com/getStakerByAddress/${encodeURIComponent(STAKER_ADDRESS)}`,
    'upstream URL',
  );
  const body = await res.json();
  assertEqual(body.data.address, STAKER_ADDRESS, 'data.address');
  assertEqual(body.data.balance, 341219403873, 'data.balance (luna)');
  assertEqual(body.data.delegation, VALIDATOR_A, 'data.delegation');
  assertEqual(body.data.inactiveBalance, 0, 'data.inactiveBalance');
  assertEqual(body.data.retiredBalance, 0, 'data.retiredBalance');
  assertEqual(res.headers.get('Cache-Control'), 'public, max-age=10', 'Cache-Control');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
});

await test('GET /api/staker/:address (unspaced, lowercase) -> same normalized upstream', async () => {
  upstreamHandler = stakerUpstream();
  const res = await call(`/api/staker/${STAKER_ADDRESS.replace(/\s+/g, '').toLowerCase()}`);
  assertEqual(res.status, 200, 'status');
  assertEqual(
    upstreamCalls[0].url,
    `https://api.nimiqhub.com/getStakerByAddress/${encodeURIComponent(STAKER_ADDRESS)}`,
    'upstream URL',
  );
});

await test('GET /api/staker/:address for a non-staker -> 200 {"data":null}', async () => {
  // NimiqHub reports "not a staker" as a 502 with a message, not as a 404.
  upstreamHandler = stakerUpstream({ missing: true });
  const res = await call(`/api/staker/${STAKER_ADDRESS_ENCODED}`);
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.data, null, 'data');
  assertEqual(body.error, undefined, 'body.error (not an error for the client)');
  assertEqual(res.headers.get('Cache-Control'), 'public, max-age=10', 'Cache-Control');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
});

await test('GET /api/staker/:address for a 404 upstream -> 200 {"data":null}', async () => {
  upstreamHandler = () => new Response('not found', { status: 404 });
  const res = await call(`/api/staker/${STAKER_ADDRESS_ENCODED}`);
  assertEqual(res.status, 200, 'status');
  assertEqual((await res.json()).data, null, 'data');
});

await test('GET /api/staker/:address with the API down -> 502, never "data":null', async () => {
  // A real outage must stay an error: reported as `{"data":null}` it would make the
  // client build a create-staker for an address that already stakes.
  upstreamHandler = stakerUpstream({ down: true });
  const res = await call(`/api/staker/${STAKER_ADDRESS_ENCODED}`);
  assertEqual(res.status, 502, 'status');
  const body = await res.json();
  assertEqual(body.error, 'upstream', 'body.error');
  assertEqual('data' in body, false, 'body must not carry a data key');
});

await test('GET /api/staker/:address with upstream throwing -> 502', async () => {
  upstreamHandler = () => {
    throw new Error('timed out');
  };
  const res = await call(`/api/staker/${STAKER_ADDRESS_ENCODED}`);
  assertEqual(res.status, 502, 'status');
  assertEqual((await res.json()).error, 'upstream', 'body.error');
});

await test('GET /api/staker/:address is cached, including the not-found answer', async () => {
  upstreamHandler = stakerUpstream();
  await call(`/api/staker/${STAKER_ADDRESS_ENCODED}`);
  const cached = await callCounting(`/api/staker/${STAKER_ADDRESS_ENCODED}`);
  assertEqual(cached.fetches, 0, 'upstream fetches on a cache hit');
  assertEqual((await cached.res.json()).data.delegation, VALIDATOR_A, 'cached body');

  reset();
  upstreamHandler = stakerUpstream({ missing: true });
  await call(`/api/staker/${STAKER_ADDRESS_ENCODED}`);
  const cachedMiss = await callCounting(`/api/staker/${STAKER_ADDRESS_ENCODED}`);
  assertEqual(cachedMiss.fetches, 0, 'upstream fetches on a cached not-found');
  assertEqual((await cachedMiss.res.json()).data, null, 'cached not-found body');
});

await test('GET /api/staker/:address with a bad address -> 400, no upstream call', async () => {
  const res = await call('/api/staker/NOTANADDRESS');
  assertEqual(res.status, 400, 'status');
  assertEqual((await res.json()).error, 'invalid address', 'body.error');
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('POST /api/broadcast -> sendRawTransaction, returns the hash', async () => {
  upstreamHandler = rpcUpstream();
  const res = await postBroadcast({ tx: TX_HEX });
  assertEqual(res.status, 200, 'status');
  assertEqual((await res.json()).result, TX_HASH, 'body.result');

  assertEqual(upstreamCalls.length, 1, 'upstream call count');
  assertEqual(upstreamCalls[0].url, RPC_URL, 'upstream URL');
  assertEqual(upstreamCalls[0].init.method, 'POST', 'upstream method');
  const sent = JSON.parse(upstreamCalls[0].init.body);
  assertEqual(sent.jsonrpc, '2.0', 'jsonrpc');
  assertEqual(sent.method, 'sendRawTransaction', 'method');
  assertEqual(JSON.stringify(sent.params), JSON.stringify([TX_HEX]), 'params');
  assertEqual(upstreamCalls[0].init.headers['Content-Type'], 'application/json', 'Content-Type');

  assertEqual(res.headers.get('Cache-Control'), 'no-store', 'Cache-Control');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
});

await test('POST /api/broadcast accepts a bare string result', async () => {
  upstreamHandler = () => jsonUpstream({ jsonrpc: '2.0', result: TX_HASH, id: 1 });
  const res = await postBroadcast({ tx: TX_HEX });
  assertEqual(res.status, 200, 'status');
  assertEqual((await res.json()).result, TX_HASH, 'body.result');
});

await test('POST /api/broadcast is never cached (each call reaches the node)', async () => {
  upstreamHandler = rpcUpstream();
  await postBroadcast({ tx: TX_HEX });
  const again = await callCounting('/api/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: TX_HEX }),
  });
  assertEqual(again.res.status, 200, 'status');
  assertEqual(again.fetches, 1, 'upstream fetches on the second identical broadcast');
});

await test('POST /api/broadcast from a disallowed origin -> 403, node never called', async () => {
  // CORS would only hide the response from the page; the relay itself must refuse,
  // or any server can spend our subrequests on the RPC node.
  upstreamHandler = rpcUpstream();
  const res = await call('/api/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ tx: TX_HEX }),
  });
  assertEqual(res.status, 403, 'status');
  assertEqual((await res.json()).error, 'forbidden', 'body.error');
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), null, 'ACAO');
  assertEqual(res.headers.get('Vary'), 'Origin', 'Vary');
});

await test('POST /api/broadcast without an Origin header -> 403, node never called', async () => {
  // curl and every other non-browser caller lands here.
  upstreamHandler = rpcUpstream();
  const res = await call('/api/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: TX_HEX }),
    omitOrigin: true,
  });
  assertEqual(res.status, 403, 'status');
  assertEqual((await res.json()).error, 'forbidden', 'body.error');
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), null, 'ACAO');
});

await test('POST /api/broadcast with an invalid transaction -> 400, no upstream call', async () => {
  upstreamHandler = rpcUpstream();
  const bad = [
    { tx: 'abc' }, // odd length
    { tx: 'zz' }, // not hex
    { tx: '' }, // empty
    { tx: 'a' }, // below the two-character floor
    { tx: 'ab'.repeat(10001) }, // past MAX_TX_HEX_LENGTH
    { tx: 123 }, // not a string
    {}, // no tx at all
    { tx: null },
  ];
  for (const body of bad) {
    const res = await postBroadcast(body);
    assertEqual(res.status, 400, `status for ${JSON.stringify(body).slice(0, 40)}`);
    assertEqual(
      (await res.json()).error,
      'invalid transaction',
      `body.error for ${JSON.stringify(body).slice(0, 40)}`,
    );
  }
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('POST /api/broadcast with an unparseable body -> 400 invalid body', async () => {
  upstreamHandler = rpcUpstream();
  for (const raw of ['not json', '', '{"tx":']) {
    const res = await postBroadcast(raw);
    assertEqual(res.status, 400, `status for ${JSON.stringify(raw)}`);
    assertEqual((await res.json()).error, 'invalid body', `body.error for ${JSON.stringify(raw)}`);
  }
  // An oversized body is rejected before it is parsed.
  const huge = await postBroadcast(`{"tx":"${'a'.repeat(40000)}"}`);
  assertEqual(huge.status, 400, 'status for an oversized body');
  assertEqual((await huge.json()).error, 'invalid body', 'body.error for an oversized body');
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test("POST /api/broadcast passes the node's rejection through -> 400", async () => {
  upstreamHandler = rpcUpstream({
    rejection: 'Serialization error: Hit the end of buffer, expected more data',
  });
  const res = await postBroadcast({ tx: TX_HEX });
  assertEqual(res.status, 400, 'status');
  assertEqual(
    (await res.json()).error,
    'Serialization error: Hit the end of buffer, expected more data',
    'body.error (the node message, verbatim)',
  );
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
});

await test('POST /api/broadcast falls back to the RPC message when there is no detail', async () => {
  upstreamHandler = rpcUpstream({ messageOnly: true });
  const res = await postBroadcast({ tx: TX_HEX });
  assertEqual(res.status, 400, 'status');
  assertEqual((await res.json()).error, 'Method not found', 'body.error');
});

await test('POST /api/broadcast with the node unreachable -> 502', async () => {
  upstreamHandler = () => {
    throw new Error('connection refused');
  };
  const res = await postBroadcast({ tx: TX_HEX });
  assertEqual(res.status, 502, 'status');
  assertEqual((await res.json()).error, 'upstream', 'body.error');
});

await test('POST /api/broadcast with a non-JSON or resultless node reply -> 502', async () => {
  upstreamHandler = rpcUpstream({ httpFail: true });
  const failed = await postBroadcast({ tx: TX_HEX });
  assertEqual(failed.status, 502, 'status for an HTTP failure');
  assertEqual((await failed.json()).error, 'upstream', 'body.error');

  reset();
  upstreamHandler = rpcUpstream({ emptyResult: true });
  const empty = await postBroadcast({ tx: TX_HEX });
  assertEqual(empty.status, 502, 'status for a null result');
  assertEqual((await empty.json()).error, 'upstream', 'body.error');
});

await test('POST to any other route -> 405', async () => {
  for (const path of ['/api/staker/NQ27', '/api/network', '/api/nope']) {
    const res = await call(path, { method: 'POST' });
    assertEqual(res.status, 405, `status for ${path}`);
  }
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('GET /api/broadcast -> 404 (the route is POST only)', async () => {
  const res = await call('/api/broadcast');
  assertEqual(res.status, 404, 'status');
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('GET /api/validators -> getValidators', async () => {
  const res = await call('/api/validators');
  assertEqual(res.status, 200, 'status');
  assertEqual(upstreamCalls[0].url, 'https://api.nimiqhub.com/getValidators', 'upstream URL');
});

await test('GET /api/network -> normalized counters + epoch math', async () => {
  upstreamHandler = networkUpstream;
  const res = await call('/api/network');
  assertEqual(res.status, 200, 'status');
  assertEqual(upstreamCalls.length, 3, 'upstream call count');
  assert(
    ['/getBlockNumber', '/getEpochNumber', '/getBatchNumber'].every((path) =>
      upstreamCalls.some((c) => c.url === `https://api.nimiqhub.com${path}`),
    ),
    `upstream URLs: got ${upstreamCalls.map((c) => c.url).join(', ')}`,
  );
  const body = await res.json();
  assertEqual(body.blockNumber, 61307037, 'blockNumber');
  assertEqual(body.epochNumber, 1340, 'epochNumber (unwrapped from .data)');
  assertEqual(body.batchNumber, 964184, 'batchNumber');
  assertEqual(body.epoch.batchInEpoch, 104, 'epoch.batchInEpoch');
  assertEqual(body.epoch.batchesRemaining, 616, 'epoch.batchesRemaining');
  assertEqual(body.epoch.approxSecondsRemaining, 36960, 'epoch.approxSecondsRemaining');
  assertEqual(res.headers.get('Cache-Control'), 'public, max-age=60', 'Cache-Control');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
});

await test('GET /api/network is cached (three upstream calls for two requests)', async () => {
  upstreamHandler = networkUpstream;
  await call('/api/network');
  const res = await call('/api/network');
  assertEqual(res.status, 200, 'status');
  assertEqual(upstreamCalls.length, 3, 'upstream call count');
  assertEqual((await res.json()).epochNumber, 1340, 'cached body');
});

await test('GET /api/network with one upstream failing -> 502', async () => {
  upstreamHandler = (url) =>
    url.endsWith('/getBatchNumber') ? new Response('boom', { status: 500 }) : networkUpstream(url);
  const res = await call('/api/network');
  assertEqual(res.status, 502, 'status');
  assertEqual((await res.json()).error, 'upstream', 'body.error');
});

await test('GET /api/network with a missing counter -> 502', async () => {
  upstreamHandler = (url) =>
    url.endsWith('/getEpochNumber') ? jsonUpstream({ metadata: null }) : networkUpstream(url);
  const res = await call('/api/network');
  assertEqual(res.status, 502, 'status');
  assertEqual((await res.json()).error, 'upstream', 'body.error');
});

await test('GET /api/graph -> composed validators + stakers, part 1 of 1', async () => {
  upstreamHandler = graphUpstream();
  const res = await call('/api/graph');
  assertEqual(res.status, 200, 'status');
  assertEqual(res.headers.get('Cache-Control'), 'public, max-age=300', 'Cache-Control');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');

  const body = await res.json();
  assertEqual(body.part.index, 1, 'part.index');
  assertEqual(body.part.count, 1, 'part.count (one validator with stakers fits one part)');
  assertEqual(body.validators.length, 2, 'validator count');
  assertEqual(body.totalActiveStake, 400000000, 'totalActiveStake');
  assert(!Number.isNaN(Date.parse(body.updatedAt)), `updatedAt: got ${body.updatedAt}`);

  const [a, b] = body.validators;
  assertEqual(a.address, VALIDATOR_A, 'validators[0].address');
  assertEqual(a.name, 'ImpactZero stake', 'validators[0].name (enriched)');
  assertEqual(a.balance, 300000000, 'validators[0].balance');
  assertEqual(a.numStakers, 2, 'validators[0].numStakers');
  assertEqual(a.stakeShare, 0.75, 'validators[0].stakeShare');
  assertEqual(b.address, VALIDATOR_B, 'validators[1].address');
  assertEqual(b.name, undefined, 'validators[1].name (no match)');
  assertEqual(b.stakeShare, 0.25, 'validators[1].stakeShare');

  assertEqual(body.stakers.length, 2, 'staker count');
  assertEqual(body.stakers[0].address, STAKER_A1, 'stakers[0].address');
  assertEqual(body.stakers[0].validatorAddress, VALIDATOR_A, 'stakers[0].validatorAddress');
  assertEqual(body.stakers[0].balance, 200000000, 'stakers[0].balance');
  assertEqual(body.stakers[1].address, STAKER_A2, 'stakers[1].address');

  // A validator reporting zero stakers costs no upstream round trip.
  assert(
    !upstreamCalls.some((c) => c.url.endsWith(stakersPath(VALIDATOR_B))),
    'fetched stakers for a validator that reports none',
  );
  assertEqual(upstreamCalls.length, 3, 'upstream call count (validators + names + one staker list)');
});

await test('GET /api/graph with an empty staker list -> validator kept, no stakers', async () => {
  upstreamHandler = graphUpstream({ bStakers: 3 });
  const res = await call('/api/graph');
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.validators.length, 2, 'validator count');
  assertEqual(body.validators[1].numStakers, 3, 'validators[1].numStakers (as reported)');
  assertEqual(body.stakers.length, 2, 'staker count');
  assert(
    body.stakers.every((s) => s.validatorAddress === VALIDATOR_A),
    'stakers attributed to the wrong validator',
  );
  assert(
    upstreamCalls.some((c) => c.url.endsWith(stakersPath(VALIDATOR_B))),
    'expected a staker call for a validator reporting stakers',
  );
});

await test('GET /api/graph with one staker fetch failing -> 200, that validator has no stakers', async () => {
  upstreamHandler = graphUpstream({ bStakers: 3, bFails: true });
  const res = await call('/api/graph');
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.validators.length, 2, 'validator count');
  assertEqual(body.validators[1].address, VALIDATOR_B, 'failed validator still listed');
  assertEqual(body.stakers.length, 2, 'staker count (only validator A contributed)');
  assert(
    body.stakers.every((s) => s.validatorAddress === VALIDATOR_A),
    'stakers attributed to the wrong validator',
  );
});

await test('GET /api/graph with /getValidators failing -> 502', async () => {
  upstreamHandler = (url) =>
    url.endsWith('/getValidators') ? new Response('boom', { status: 500 }) : graphUpstream()(url);
  const res = await call('/api/graph');
  assertEqual(res.status, 502, 'status');
  assertEqual((await res.json()).error, 'upstream', 'body.error');
});

await test('GET /api/graph is cached (no extra upstream calls on the second request)', async () => {
  upstreamHandler = graphUpstream();
  await call('/api/graph');
  const before = upstreamCalls.length;
  const res = await call('/api/graph');
  assertEqual(res.status, 200, 'status');
  assertEqual(upstreamCalls.length, before, 'upstream call count');
  assertEqual((await res.json()).totalActiveStake, 400000000, 'cached body');
});

await test('GET /api/graph?part=N -> 52 validators split into two parts', async () => {
  upstreamHandler = bulkGraphUpstream();
  const first = await callCounting('/api/graph?part=1');
  const second = await callCounting('/api/graph?part=2');
  assertEqual(first.res.status, 200, 'part 1 status');
  assertEqual(second.res.status, 200, 'part 2 status');

  const one = await first.res.json();
  const two = await second.res.json();
  assertEqual(one.part.index, 1, 'part 1 index');
  assertEqual(one.part.count, 2, 'part 1 count');
  assertEqual(two.part.index, 2, 'part 2 index');
  assertEqual(two.part.count, 2, 'part 2 count');

  // Every part carries the whole validator list; only part 1 pays for the names call.
  assertEqual(one.validators.length, 52, 'part 1 validator count');
  assertEqual(two.validators.length, 52, 'part 2 validator count');
  assertEqual(one.validators[0].name, 'Bulk validator 0', 'part 1 name enrichment');
  assertEqual(two.validators[0].name, undefined, 'part 2 carries no names');
  assertEqual(one.totalActiveStake, two.totalActiveStake, 'totalActiveStake across parts');
  assert(
    !upstreamCalls.slice(first.fetches).some((c) => c.url === NAMES_URL),
    'part 2 fetched the validator-names API',
  );

  // Part 1 takes the first GRAPH_CHUNK validators that report stakers; part 2 the rest.
  const coveredByOne = new Set(one.stakers.map((s) => s.validatorAddress));
  const coveredByTwo = new Set(two.stakers.map((s) => s.validatorAddress));
  assertEqual(coveredByOne.size, GRAPH_CHUNK, 'validators covered by part 1');
  assertEqual(coveredByTwo.size, BULK_FETCHABLE.length - GRAPH_CHUNK, 'validators covered by part 2');
  assert(
    BULK_FETCHABLE.slice(0, GRAPH_CHUNK).every((v) => coveredByOne.has(v.address)),
    'part 1 missed one of the first 26 validators that report stakers',
  );
  assert(
    BULK_FETCHABLE.slice(GRAPH_CHUNK).every((v) => coveredByTwo.has(v.address)),
    'part 2 missed one of the remaining validators that report stakers',
  );
  assert(
    ![...coveredByTwo].some((address) => coveredByOne.has(address)),
    'a validator was fetched by both parts',
  );

  // Zero-staker validators are listed but never cost a round trip.
  for (const index of BULK_ZERO_STAKER_INDEXES) {
    assert(
      !upstreamCalls.some((c) => c.url.endsWith(stakersPath(BULK_VALIDATORS[index].address))),
      `fetched stakers for validator ${index}, which reports none`,
    );
  }

  const union = [...one.stakers, ...two.stakers];
  const keys = new Set(union.map((s) => `${s.address}|${s.validatorAddress}`));
  assertEqual(keys.size, union.length, 'duplicate address+validatorAddress across parts');
  assertEqual(
    union.length,
    BULK_FETCHABLE.length * BULK_STAKERS_PER_VALIDATOR,
    'union staker count',
  );
  note(`stakers: part 1 = ${one.stakers.length}, part 2 = ${two.stakers.length}, union = ${union.length}, duplicates = 0`);
});

await test('GET /api/graph?part=N stays inside the Workers Free subrequest budget', async () => {
  upstreamHandler = bulkGraphUpstream();
  const first = await callCounting('/api/graph?part=1');
  const second = await callCounting('/api/graph?part=2');
  note(
    `upstream fetches per invocation: part 1 = ${first.fetches}, part 2 = ${second.fetches}` +
      ` (cap ${MAX_FETCHES_PER_PART}; each part also spends 1 cache match + 1 cache put of the 50-unit budget)`,
  );
  assert(first.fetches <= MAX_FETCHES_PER_PART, `part 1 made ${first.fetches} fetches`);
  assert(second.fetches <= MAX_FETCHES_PER_PART, `part 2 made ${second.fetches} fetches`);

  // A cache hit must cost nothing upstream at all.
  const repeat = await callCounting('/api/graph?part=1');
  assertEqual(repeat.res.status, 200, 'cached part 1 status');
  assertEqual(repeat.fetches, 0, 'upstream fetches on a cache hit');
});

await test('GET /api/graph?part=2 with one staker fetch failing -> 200, fewer stakers', async () => {
  const failing = BULK_FETCHABLE[GRAPH_CHUNK];
  upstreamHandler = bulkGraphUpstream({ failAddress: failing.address });
  const res = await call('/api/graph?part=2');
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.validators.length, 52, 'validator count');
  assertEqual(body.part.count, 2, 'part.count');
  assertEqual(
    body.stakers.length,
    (BULK_FETCHABLE.length - GRAPH_CHUNK - 1) * BULK_STAKERS_PER_VALIDATOR,
    'staker count (the failed validator contributes none)',
  );
  assert(
    !body.stakers.some((s) => s.validatorAddress === failing.address),
    'the failed validator still contributed stakers',
  );
  assert(
    body.validators.some((v) => v.address === failing.address),
    'the failed validator was dropped from the list',
  );
});

await test('GET /api/graph with an invalid part -> 400 {"error":"invalid part"}', async () => {
  upstreamHandler = bulkGraphUpstream();
  for (const value of ['0', 'abc', '1.5', '-1', '']) {
    const res = await call(`/api/graph?part=${value}`);
    assertEqual(res.status, 400, `status for part=${JSON.stringify(value)}`);
    assertEqual((await res.json()).error, 'invalid part', `body.error for part=${JSON.stringify(value)}`);
  }
  assertEqual(upstreamCalls.length, 0, 'upstream call count (rejected before any fetch)');

  // Out of range needs the validator list to know the count, so it costs one fetch.
  const tooHigh = await call('/api/graph?part=3');
  assertEqual(tooHigh.status, 400, 'status for part=3 when count=2');
  assertEqual((await tooHigh.json()).error, 'invalid part', 'body.error for part=3');
});

await test('GET /api/graph without ?part -> identical to ?part=1', async () => {
  upstreamHandler = bulkGraphUpstream();
  const bare = await callCounting('/api/graph');
  const explicit = await callCounting('/api/graph?part=1');
  assertEqual(bare.res.status, 200, 'status');
  assertEqual(explicit.res.status, 200, 'status');
  // Both normalize to the same cache key, so the second request costs nothing.
  assertEqual(explicit.fetches, 0, 'upstream fetches for ?part=1 after the bare call');
  const a = await bare.res.json();
  const b = await explicit.res.json();
  assertEqual(JSON.stringify(a), JSON.stringify(b), 'bare /api/graph differs from ?part=1');
  assertEqual(a.part.index, 1, 'part.index');
  assertEqual(a.part.count, 2, 'part.count');
});

await test('GET /api/graph parts are cached independently', async () => {
  upstreamHandler = bulkGraphUpstream();
  await call('/api/graph?part=1');
  const second = await callCounting('/api/graph?part=2');
  assertEqual(second.res.status, 200, 'status');
  assert(second.fetches > 0, 'part 2 was wrongly served from the part 1 cache entry');
  assertEqual((await second.res.json()).part.index, 2, 'part.index');
});

await test('GET /api/graph survives a missing validator-names API', async () => {
  upstreamHandler = (url) => (url === NAMES_URL ? new Response('nope', { status: 503 }) : graphUpstream()(url));
  const res = await call('/api/graph');
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.validators.length, 2, 'validator count');
  assertEqual(body.validators[0].name, undefined, 'no name when enrichment fails');
  assertEqual(body.stakers.length, 2, 'staker count');
});

// --- ChainMap paywall: /api/history ----------------------------------------

await test('GET /api/history/:address -> normalized page, nextStartAt on a full page', async () => {
  upstreamHandler = paywallUpstream({
    txs: [txFixture(), txFixture({ hash: HISTORY_HASH_2, value: 250000 })],
  });
  const res = await call(`/api/history/${ADDRESS_ENCODED}?max=2`);
  assertEqual(res.status, 200, 'status');
  assertEqual(res.headers.get('Cache-Control'), 'public, max-age=60', 'Cache-Control');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');

  assertEqual(upstreamCalls.length, 1, 'upstream call count');
  assertEqual(upstreamCalls[0].url, RPC_URL, 'upstream URL');
  assertEqual(upstreamCalls[0].init.method, 'POST', 'upstream method');
  assertEqual(
    upstreamCalls[0].init.headers['User-Agent'],
    'nimiq-api/1.0 (+https://nimiq.subimpact.net)',
    'User-Agent',
  );
  const sent = JSON.parse(upstreamCalls[0].init.body);
  assertEqual(sent.method, 'getTransactionsByAddress', 'RPC method');
  assertEqual(JSON.stringify(sent.params), JSON.stringify([ADDRESS, 2, null]), 'RPC params');

  const body = await res.json();
  assertEqual(body.data.length, 2, 'data length');
  const [first] = body.data;
  assertEqual(first.hash, HISTORY_HASH_1, 'data[0].hash');
  assertEqual(first.blockNumber, 61301932, 'data[0].blockNumber');
  assertEqual(first.timestamp, RECENT_PAYMENT_MS, 'data[0].timestamp');
  assertEqual(first.confirmations, 14148, 'data[0].confirmations');
  assertEqual(first.size, 152, 'data[0].size');
  assertEqual(first.from, ADDRESS, 'data[0].from');
  assertEqual(first.to, STAKER_A1, 'data[0].to');
  assertEqual(first.value, 100000, 'data[0].value');
  assertEqual(first.fee, 138, 'data[0].fee');
  // The node's payload noise never reaches the client, nor the cache entry.
  assertEqual(first.recipientData, undefined, 'data[0].recipientData (dropped)');
  assertEqual(first.relatedAddresses, undefined, 'data[0].relatedAddresses (dropped)');
  assertEqual(first.fromType, undefined, 'data[0].fromType (dropped)');

  // A page as long as `max` means there is probably more behind it.
  assertEqual(body.pagination.nextStartAt, HISTORY_HASH_2, 'pagination.nextStartAt');
});

await test('GET /api/history/:address -> nextStartAt null on a short page', async () => {
  upstreamHandler = paywallUpstream({ txs: [txFixture()] });
  const res = await call(`/api/history/${ADDRESS_ENCODED}`);
  assertEqual(res.status, 200, 'status');
  assertEqual(JSON.stringify(lastHistoryParams()), JSON.stringify([ADDRESS, 20, null]), 'RPC params (default max)');
  const body = await res.json();
  assertEqual(body.data.length, 1, 'data length');
  assertEqual(body.pagination.nextStartAt, null, 'pagination.nextStartAt');
});

await test('GET /api/history/:address?startAt= passes the cursor to the node', async () => {
  upstreamHandler = paywallUpstream({ txs: [txFixture()] });
  const res = await call(`/api/history/${ADDRESS_ENCODED}?max=5&startAt=${CURSOR_HASH}`);
  assertEqual(res.status, 200, 'status');
  assertEqual(
    JSON.stringify(lastHistoryParams()),
    JSON.stringify([ADDRESS, 5, CURSOR_HASH]),
    'RPC params',
  );
});

await test('GET /api/history/:address (unspaced, lowercase) -> normalized upstream address', async () => {
  upstreamHandler = paywallUpstream({ txs: [] });
  const res = await call(`/api/history/${ADDRESS.replace(/\s+/g, '').toLowerCase()}`);
  assertEqual(res.status, 200, 'status');
  assertEqual(lastHistoryParams()[0], ADDRESS, 'RPC address param');
  const body = await res.json();
  assertEqual(body.data.length, 0, 'data length');
  assertEqual(body.pagination.nextStartAt, null, 'pagination.nextStartAt');
});

await test('GET /api/history/:address drops rows that are not transactions', async () => {
  upstreamHandler = paywallUpstream({
    txs: [
      txFixture(),
      { hash: HISTORY_HASH_2, from: ADDRESS, to: STAKER_A1 }, // no value
      { blockNumber: 1, from: ADDRESS, to: STAKER_A1, value: 5 }, // no hash
      { hash: HISTORY_HASH_2, to: STAKER_A1, value: 5 }, // no from
      null,
    ],
  });
  const res = await call(`/api/history/${ADDRESS_ENCODED}`);
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.data.length, 1, 'data length (only the complete transaction)');
  assertEqual(body.data[0].hash, HISTORY_HASH_1, 'data[0].hash');
});

await test('GET /api/history with a bad address -> 400, no upstream call', async () => {
  upstreamHandler = paywallUpstream();
  const res = await call('/api/history/NOTANADDRESS');
  assertEqual(res.status, 400, 'status');
  assertEqual((await res.json()).error, 'invalid address', 'body.error');
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('GET /api/history with a bad startAt -> 400, no upstream call', async () => {
  upstreamHandler = paywallUpstream();
  // The node's cursor is a 64-char lowercase hex hash; anything else it would reject
  // itself, so it is turned away before it costs a subrequest.
  const bad = ['abc', '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(62)}zz`];
  for (const value of bad) {
    const res = await call(`/api/history/${ADDRESS_ENCODED}?startAt=${value}`);
    assertEqual(res.status, 400, `status for startAt=${JSON.stringify(value)}`);
    assertEqual((await res.json()).error, 'invalid startAt', `body.error for startAt=${JSON.stringify(value)}`);
  }
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('GET /api/history with max out of range -> 400, no upstream call', async () => {
  upstreamHandler = paywallUpstream();
  for (const value of ['51', '0', '100', 'abc', '', '-1', '2.5']) {
    const res = await call(`/api/history/${ADDRESS_ENCODED}?max=${value}`);
    assertEqual(res.status, 400, `status for max=${JSON.stringify(value)}`);
    assertEqual((await res.json()).error, 'invalid max', `body.error for max=${JSON.stringify(value)}`);
  }
  assertEqual(upstreamCalls.length, 0, 'upstream call count');

  // The edges of the range are accepted.
  upstreamHandler = paywallUpstream({ txs: [] });
  for (const value of ['1', '50']) {
    const res = await call(`/api/history/${ADDRESS_ENCODED}?max=${value}`);
    assertEqual(res.status, 200, `status for max=${value}`);
    assertEqual(lastHistoryParams()[1], Number(value), `RPC max param for max=${value}`);
  }
});

await test('GET /api/history with the node unreachable -> 502', async () => {
  upstreamHandler = paywallUpstream({ historyThrows: true });
  const thrown = await call(`/api/history/${ADDRESS_ENCODED}`);
  assertEqual(thrown.status, 502, 'status for a transport failure');
  assertEqual((await thrown.json()).error, 'upstream', 'body.error');

  reset();
  upstreamHandler = paywallUpstream({ historyHttpFail: true });
  const httpFail = await call(`/api/history/${ADDRESS_ENCODED}`);
  assertEqual(httpFail.status, 502, 'status for an HTTP failure');
  assertEqual((await httpFail.json()).error, 'upstream', 'body.error');
});

await test("GET /api/history passes the node's rejection through -> 400", async () => {
  upstreamHandler = paywallUpstream({
    rejection: 'Serialization error: Hit the end of buffer, expected more data',
  });
  const res = await call(`/api/history/${ADDRESS_ENCODED}?startAt=${CURSOR_HASH}`);
  assertEqual(res.status, 400, 'status');
  assertEqual(
    (await res.json()).error,
    'Serialization error: Hit the end of buffer, expected more data',
    'body.error (the node message, verbatim)',
  );
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
});

await test('GET /api/history is cached per address + max + startAt', async () => {
  upstreamHandler = paywallUpstream({ txs: [txFixture()] });
  await call(`/api/history/${ADDRESS_ENCODED}?max=5`);

  const repeat = await callCounting(`/api/history/${ADDRESS_ENCODED}?max=5`);
  assertEqual(repeat.fetches, 0, 'upstream fetches on a cache hit');
  assertEqual((await repeat.res.json()).data[0].hash, HISTORY_HASH_1, 'cached body');

  // A different page of the same address must not be served from that entry.
  const otherMax = await callCounting(`/api/history/${ADDRESS_ENCODED}?max=6`);
  assertEqual(otherMax.fetches, 1, 'upstream fetches for a different max');
  const otherCursor = await callCounting(`/api/history/${ADDRESS_ENCODED}?max=5&startAt=${CURSOR_HASH}`);
  assertEqual(otherCursor.fetches, 1, 'upstream fetches for a different startAt');
  const otherAddress = await callCounting(`/api/history/${encodeURIComponent(STAKER_A1)}?max=5`);
  assertEqual(otherAddress.fetches, 1, 'upstream fetches for a different address');

  // A rejection is not cached: the next caller must reach the node again.
  reset();
  upstreamHandler = paywallUpstream({ rejection: 'unknown transaction hash' });
  await call(`/api/history/${ADDRESS_ENCODED}?max=5`);
  const again = await callCounting(`/api/history/${ADDRESS_ENCODED}?max=5`);
  assertEqual(again.res.status, 400, 'status');
  assertEqual(again.fetches, 1, 'upstream fetches after a rejection');
});

// --- ChainMap paywall: /api/quote ------------------------------------------

await test('GET /api/quote -> $29.99 priced in luna at the CoinGecko rate', async () => {
  upstreamHandler = paywallUpstream();
  const res = await call('/api/quote');
  assertEqual(res.status, 200, 'status');
  assertEqual(upstreamCalls.length, 1, 'upstream call count');
  assertEqual(upstreamCalls[0].url, COINGECKO_URL, 'upstream URL');

  const body = await res.json();
  assertEqual(body.priceUsd, PRICE_USD, 'priceUsd');
  assertEqual(body.usdTarget, 29.99, 'usdTarget');
  // $29.99 / $0.0004 = 74,975 NIM; x 100,000 luna = 7,497,500,000 luna.
  assertEqual(body.nimAmount, REQUIRED_NIM, 'nimAmount');
  assertEqual(body.lunaAmount, REQUIRED_LUNA, 'lunaAmount');
  assertEqual(body.lunaAmount, body.nimAmount * 100000, 'lunaAmount vs nimAmount');
  assertEqual(body.paywallAddress, PAYWALL_ADDRESS, 'paywallAddress');
  assertEqual(body.validMinutes, 60, 'validMinutes');
  assert(!Number.isNaN(Date.parse(body.generatedAt)), `generatedAt: got ${body.generatedAt}`);
  assertEqual(res.headers.get('Cache-Control'), 'public, max-age=60', 'Cache-Control');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
  note(`$${body.usdTarget} at $${body.priceUsd}/NIM = ${body.nimAmount} NIM = ${body.lunaAmount} luna`);
});

await test('GET /api/quote rounds up, so the pass is never underpaid', async () => {
  // $29.99 at $0.00037 is 81,054.05… NIM — the fraction of a luna rounds towards us.
  upstreamHandler = paywallUpstream({ priceUsd: 0.00037 });
  const res = await call('/api/quote');
  const body = await res.json();
  const exact = (29.99 * 100000) / 0.00037;
  assertEqual(body.lunaAmount, Math.ceil(exact), 'lunaAmount');
  assert(body.lunaAmount >= exact, 'lunaAmount rounded down, leaving the pass underpaid');
  assert(body.lunaAmount - exact < 1, `rounded up by more than a luna: ${body.lunaAmount - exact}`);
});

await test('GET /api/quote is cached (one CoinGecko call for two requests)', async () => {
  upstreamHandler = paywallUpstream();
  await call('/api/quote');
  const repeat = await callCounting('/api/quote');
  assertEqual(repeat.res.status, 200, 'status');
  assertEqual(repeat.fetches, 0, 'upstream fetches on a cache hit');
  assertEqual((await repeat.res.json()).lunaAmount, REQUIRED_LUNA, 'cached body');
});

await test('GET /api/quote with CoinGecko failing -> 502', async () => {
  for (const opts of [{ priceFails: true }, { priceThrows: true }, { priceGarbage: true }]) {
    reset();
    upstreamHandler = paywallUpstream(opts);
    const res = await call('/api/quote');
    assertEqual(res.status, 502, `status for ${JSON.stringify(opts)}`);
    assertEqual((await res.json()).error, 'upstream', `body.error for ${JSON.stringify(opts)}`);
  }
});

// --- ChainMap paywall: /api/entitlement ------------------------------------

await test('POST /api/entitlement with no payment -> no_payment', async () => {
  upstreamHandler = paywallUpstream({ txs: [txFixture()] });
  const res = await postEntitlement({ address: ADDRESS });
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.entitled, false, 'entitled');
  assertEqual(body.reason, 'no_payment', 'reason');
  assertEqual(body.requiredLuna, REQUIRED_LUNA, 'requiredLuna');
  assertEqual(body.priceUsd, PRICE_USD, 'priceUsd');
  assertEqual(body.token, undefined, 'token (none without a payment)');
  assertEqual(JSON.stringify(lastHistoryParams()), JSON.stringify([ADDRESS, 200, null]), 'RPC params');
  assertEqual(res.headers.get('Cache-Control'), 'no-store', 'Cache-Control');
});

await test('POST /api/entitlement with a payment to another address -> no_payment', async () => {
  // Right amount, wrong recipient: paying someone else is not paying us.
  upstreamHandler = paywallUpstream({
    txs: [paymentFixture(REQUIRED_LUNA, { to: VALIDATOR_B })],
  });
  const res = await postEntitlement({ address: ADDRESS });
  const body = await res.json();
  assertEqual(body.entitled, false, 'entitled');
  assertEqual(body.reason, 'no_payment', 'reason');
});

await test('POST /api/entitlement with an underpayment -> amount_too_low', async () => {
  upstreamHandler = paywallUpstream({ txs: [paymentFixture(Math.floor(REQUIRED_LUNA * 0.5))] });
  const res = await postEntitlement({ address: ADDRESS });
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.entitled, false, 'entitled');
  assertEqual(body.reason, 'amount_too_low', 'reason');
  assertEqual(body.requiredLuna, REQUIRED_LUNA, 'requiredLuna');
  assertEqual(body.priceUsd, PRICE_USD, 'priceUsd');
  assertEqual(body.paidUntil, undefined, 'paidUntil (nothing was bought)');
});

await test('POST /api/entitlement tolerance floor: 85% is enough, a luna less is not', async () => {
  // NIM moves between the quote the user signs and this check, so a payment within 15%
  // of today's price still counts.
  assertEqual(TOLERANCE_FLOOR_LUNA, Math.floor(0.85 * REQUIRED_LUNA), 'tolerance floor arithmetic');

  upstreamHandler = paywallUpstream({ txs: [paymentFixture(TOLERANCE_FLOOR_LUNA)] });
  const atFloor = await (await postEntitlement({ address: ADDRESS })).json();
  assertEqual(atFloor.entitled, true, 'entitled at exactly the floor');

  reset();
  upstreamHandler = paywallUpstream({ txs: [paymentFixture(TOLERANCE_FLOOR_LUNA - 1)] });
  const belowFloor = await (await postEntitlement({ address: ADDRESS })).json();
  assertEqual(belowFloor.entitled, false, 'entitled one luna below the floor');
  assertEqual(belowFloor.reason, 'amount_too_low', 'reason');
  note(`floor = ${TOLERANCE_FLOOR_LUNA} luna (85% of ${REQUIRED_LUNA})`);
});

await test('POST /api/entitlement with a payment above the floor -> entitled + a token', async () => {
  const paid = Math.floor(REQUIRED_LUNA * 0.9);
  upstreamHandler = paywallUpstream({ txs: [txFixture(), paymentFixture(paid)] });
  const res = await postEntitlement({ address: ADDRESS });
  assertEqual(res.status, 200, 'status');
  assertEqual(res.headers.get('Cache-Control'), 'no-store', 'Cache-Control');

  const body = await res.json();
  assertEqual(body.entitled, true, 'entitled');
  assertEqual(body.address, ADDRESS, 'address (canonical blocks)');
  // 30 days from the transaction's own timestamp, not from now.
  assertEqual(body.paidUntil, RECENT_PAYMENT_MS + 30 * DAY_MS, 'paidUntil');
  assert(body.expiresInMs > 27 * DAY_MS && body.expiresInMs <= 28 * DAY_MS, `expiresInMs: got ${body.expiresInMs}`);
  assertEqual(body.daysLeft, 28, 'daysLeft');
  assertEqual(body.requiredLuna, REQUIRED_LUNA, 'requiredLuna');
  assertEqual(body.priceUsd, PRICE_USD, 'priceUsd');

  // The token is exactly the HMAC this test computes for itself.
  assertEqual(
    body.token,
    mintTestToken(ADDRESS.replace(/\s+/g, ''), body.paidUntil),
    'token (base64url of "<address>.<paidUntil>.<hmac>")',
  );

  // And it round-trips: /api/me reads the same pass back out of it, with no upstream call.
  const me = await callCounting('/api/me', { headers: { Authorization: `Bearer ${body.token}` } });
  assertEqual(me.res.status, 200, '/api/me status');
  assertEqual(me.fetches, 0, '/api/me upstream fetches');
  const mine = await me.res.json();
  assertEqual(mine.entitled, true, '/api/me entitled');
  assertEqual(mine.address, ADDRESS, '/api/me address');
  assertEqual(mine.paidUntil, body.paidUntil, '/api/me paidUntil');
  assertEqual(mine.daysLeft, 28, '/api/me daysLeft');
});

await test('POST /api/entitlement takes the newest qualifying payment', async () => {
  const older = paymentFixture(REQUIRED_LUNA, { hash: 'd'.repeat(64), timestamp: NOW - 20 * DAY_MS });
  const newer = paymentFixture(REQUIRED_LUNA, { timestamp: RECENT_PAYMENT_MS });
  // Oldest first, to prove the answer does not lean on the node's ordering.
  upstreamHandler = paywallUpstream({ txs: [older, newer] });
  const body = await (await postEntitlement({ address: ADDRESS })).json();
  assertEqual(body.entitled, true, 'entitled');
  assertEqual(body.paidUntil, RECENT_PAYMENT_MS + 30 * DAY_MS, 'paidUntil (from the newest payment)');
});

await test('POST /api/entitlement counts 30 days from the payment -> expired', async () => {
  upstreamHandler = paywallUpstream({
    txs: [paymentFixture(REQUIRED_LUNA, { timestamp: STALE_PAYMENT_MS })],
  });
  const res = await postEntitlement({ address: ADDRESS });
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.entitled, false, 'entitled');
  assertEqual(body.reason, 'expired', 'reason');
  assertEqual(body.paidUntil, STALE_PAYMENT_MS + 30 * DAY_MS, 'paidUntil');
  assert(body.paidUntil < Date.now(), 'paidUntil is not in the past');
  assertEqual(body.requiredLuna, REQUIRED_LUNA, 'requiredLuna');
  assertEqual(body.token, undefined, 'token (an expired pass mints none)');
});

await test('POST /api/entitlement matches the paywall address in any casing or spacing', async () => {
  upstreamHandler = paywallUpstream({
    txs: [paymentFixture(REQUIRED_LUNA, { to: PAYWALL_COMPACT.toLowerCase() })],
  });
  const body = await (await postEntitlement({
    address: ADDRESS.replace(/\s+/g, '').toLowerCase(),
  })).json();
  assertEqual(body.entitled, true, 'entitled');
  assertEqual(body.address, ADDRESS, 'address (normalized in the answer)');
  assertEqual(lastHistoryParams()[0], ADDRESS, 'RPC address param (normalized)');
  assertEqual(body.token, mintTestToken(ADDRESS.replace(/\s+/g, ''), body.paidUntil), 'token');
});

await test('POST /api/entitlement from a disallowed origin -> 403, nothing fetched', async () => {
  upstreamHandler = paywallUpstream({ txs: [paymentFixture(REQUIRED_LUNA)] });
  const evil = await postEntitlement({ address: ADDRESS }, { Origin: 'https://evil.example' });
  assertEqual(evil.status, 403, 'status for a disallowed origin');
  assertEqual((await evil.json()).error, 'forbidden', 'body.error');
  assertEqual(evil.headers.get('Access-Control-Allow-Origin'), null, 'ACAO');

  const bare = await call('/api/entitlement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: ADDRESS }),
    omitOrigin: true,
  });
  assertEqual(bare.status, 403, 'status without an Origin header');
  assertEqual((await bare.json()).error, 'forbidden', 'body.error');
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('POST /api/entitlement with a bad address or body -> 400', async () => {
  upstreamHandler = paywallUpstream({ txs: [paymentFixture(REQUIRED_LUNA)] });
  for (const body of [{ address: 'NOTANADDRESS' }, { address: '' }, {}, { address: 123 }]) {
    const res = await postEntitlement(body);
    assertEqual(res.status, 400, `status for ${JSON.stringify(body)}`);
    assertEqual((await res.json()).error, 'invalid address', `body.error for ${JSON.stringify(body)}`);
  }
  for (const raw of ['not json', '', '{"address":']) {
    const res = await postEntitlement(raw);
    assertEqual(res.status, 400, `status for ${JSON.stringify(raw)}`);
    assertEqual((await res.json()).error, 'invalid body', `body.error for ${JSON.stringify(raw)}`);
  }
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('POST /api/entitlement with an upstream down -> 502', async () => {
  // The price decides what counts as payment, so a missing price cannot be guessed at.
  upstreamHandler = paywallUpstream({ priceFails: true, txs: [paymentFixture(REQUIRED_LUNA)] });
  const noPrice = await postEntitlement({ address: ADDRESS });
  assertEqual(noPrice.status, 502, 'status with CoinGecko down');
  assertEqual((await noPrice.json()).error, 'upstream', 'body.error');

  reset();
  upstreamHandler = paywallUpstream({ historyThrows: true });
  const noHistory = await postEntitlement({ address: ADDRESS });
  assertEqual(noHistory.status, 502, 'status with the node down');
  assertEqual((await noHistory.json()).error, 'upstream', 'body.error');

  // A node that rejects the request is still a 502 here: unlike /api/history there is
  // no cursor for the caller to fix, so it is our problem, not theirs.
  reset();
  upstreamHandler = paywallUpstream({ rejection: 'Internal error' });
  const rejected = await postEntitlement({ address: ADDRESS });
  assertEqual(rejected.status, 502, 'status with the node rejecting');
  assertEqual((await rejected.json()).error, 'upstream', 'body.error');
});

await test('POST /api/entitlement is never cached (each call re-reads the chain)', async () => {
  upstreamHandler = paywallUpstream({ txs: [paymentFixture(REQUIRED_LUNA)] });
  await postEntitlement({ address: ADDRESS });
  const again = await callCounting('/api/entitlement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: ADDRESS }),
  });
  assertEqual(again.res.status, 200, 'status');
  assertEqual(again.fetches, 2, 'upstream fetches on the second identical check (price + history)');
  assertEqual((await again.res.json()).entitled, true, 'entitled');
});

await test('POST /api/entitlement without the token secret -> 500, nothing fetched', async () => {
  upstreamHandler = paywallUpstream({ txs: [paymentFixture(REQUIRED_LUNA)] });
  const res = await call('/api/entitlement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: ADDRESS }),
    env: { PAYWALL_ADDRESS },
  });
  assertEqual(res.status, 500, 'status');
  assertEqual((await res.json()).error, 'server misconfigured', 'body.error');
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

// --- ChainMap paywall: /api/me ---------------------------------------------

await test('GET /api/me with a valid token -> entitled, no upstream call', async () => {
  const paidUntil = NOW + 10 * DAY_MS;
  const res = await callCounting('/api/me', {
    headers: { Authorization: `Bearer ${mintTestToken(PAYWALL_COMPACT, paidUntil)}` },
  });
  assertEqual(res.res.status, 200, 'status');
  assertEqual(res.fetches, 0, 'upstream fetches');
  const body = await res.res.json();
  assertEqual(body.entitled, true, 'entitled');
  assertEqual(body.address, PAYWALL_ADDRESS, 'address (re-spaced from the token)');
  assertEqual(body.paidUntil, paidUntil, 'paidUntil');
  assertEqual(body.daysLeft, 10, 'daysLeft');
  assert(body.expiresInMs > 0 && body.expiresInMs <= 10 * DAY_MS, `expiresInMs: got ${body.expiresInMs}`);
  assertEqual(res.res.headers.get('Cache-Control'), 'no-store', 'Cache-Control');
  assertEqual(res.res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO');
});

await test('GET /api/me with an expired paidUntil -> 200 {entitled:false}', async () => {
  // The token is genuine; the pass behind it has simply run out. That is not a 401 —
  // the client knows who it is, it just needs to renew.
  const token = mintTestToken(PAYWALL_COMPACT, NOW - DAY_MS);
  const res = await getMe(token);
  assertEqual(res.status, 200, 'status');
  const body = await res.json();
  assertEqual(body.entitled, false, 'entitled');
  assertEqual(body.reason, 'expired', 'reason');
  assertEqual(body.address, undefined, 'address (nothing to hand back)');
});

await test('GET /api/me with a tampered token -> 401', async () => {
  const paidUntil = NOW + 10 * DAY_MS;
  const decoded = Buffer.from(mintTestToken(PAYWALL_COMPACT, paidUntil), 'base64url').toString();
  const [address, until, signature] = decoded.split('.');

  const flipped = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
  const cases = {
    'flipped signature bit': forgeToken([address, until, flipped]),
    // The attack that matters: keep the signature, extend the pass by a year.
    'extended paidUntil': forgeToken([address, String(Number(until) + 365 * DAY_MS), signature]),
    'swapped address': forgeToken([ADDRESS.replace(/\s+/g, ''), until, signature]),
    'another secret': mintTestToken(PAYWALL_COMPACT, paidUntil, 'not-the-secret'),
  };
  for (const [label, token] of Object.entries(cases)) {
    const res = await getMe(token);
    assertEqual(res.status, 401, `status for a ${label}`);
    assertEqual((await res.json()).error, 'invalid token', `body.error for a ${label}`);
  }
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('GET /api/me with a malformed or missing token -> 401', async () => {
  const paidUntil = NOW + 10 * DAY_MS;
  const signature = 'f'.repeat(64);
  const malformed = {
    'no Authorization header': null,
    'empty bearer': '',
    'not base64url': '!!!not-base64!!!',
    'not a token at all': Buffer.from('hello').toString('base64url'),
    'two parts': forgeToken([PAYWALL_COMPACT, String(paidUntil)]),
    'four parts': forgeToken([PAYWALL_COMPACT, String(paidUntil), signature, 'extra']),
    'non-numeric paidUntil': forgeToken([PAYWALL_COMPACT, 'soon', signature]),
    'not an address': forgeToken(['NOTANADDRESS', String(paidUntil), signature]),
  };
  for (const [label, token] of Object.entries(malformed)) {
    const res = await getMe(token);
    assertEqual(res.status, 401, `status for ${label}`);
    assertEqual((await res.json()).error, 'invalid token', `body.error for ${label}`);
  }

  // A header that is not a bearer at all lands in the same place.
  for (const header of ['Basic abc', 'Bearer', `${mintTestToken(PAYWALL_COMPACT, paidUntil)}`]) {
    const res = await call('/api/me', { headers: { Authorization: header } });
    assertEqual(res.status, 401, `status for Authorization: ${header.slice(0, 20)}`);
  }
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('GET /api/me without the token secret -> 500', async () => {
  const res = await call('/api/me', {
    headers: { Authorization: `Bearer ${mintTestToken(PAYWALL_COMPACT, NOW + DAY_MS)}` },
    env: { PAYWALL_ADDRESS },
  });
  assertEqual(res.status, 500, 'status');
  assertEqual((await res.json()).error, 'server misconfigured', 'body.error');
});

await test('bad address -> 400 {"error":"invalid address"}', async () => {
  const res = await call('/api/stakers/NOTANADDRESS');
  assertEqual(res.status, 400, 'status');
  assertEqual((await res.json()).error, 'invalid address', 'body.error');
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('unknown route -> 404 JSON', async () => {
  const res = await call('/api/nope');
  assertEqual(res.status, 404, 'status');
  assert(res.headers.get('Content-Type').includes('application/json'), 'content type');
  assertEqual((await res.json()).error, 'not found', 'body.error');
});

await test('POST -> 405', async () => {
  const res = await call('/api/validators', { method: 'POST' });
  assertEqual(res.status, 405, 'status');
  assertEqual(upstreamCalls.length, 0, 'upstream call count');
});

await test('disallowed origin -> no CORS headers', async () => {
  const res = await call('/api/health', { headers: { Origin: 'https://evil.example' } });
  assertEqual(res.status, 200, 'status');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), null, 'ACAO');
  assertEqual(res.headers.get('Vary'), 'Origin', 'Vary');
});

await test('second request is served from cache (one upstream call)', async () => {
  await call('/api/validators');
  const res = await call('/api/validators');
  assertEqual(res.status, 200, 'status');
  assertEqual(upstreamCalls.length, 1, 'upstream call count');
  assertEqual(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'ACAO on cached response');
  assertEqual((await res.json()).fake, 'upstream', 'cached body');
});

await test('upstream error -> 502 {"error":"upstream"}', async () => {
  upstreamHandler = () => new Response('boom', { status: 500 });
  const res = await call('/api/validators');
  assertEqual(res.status, 502, 'status');
  assertEqual((await res.json()).error, 'upstream', 'body.error');
});

await test('upstream throw/timeout -> 502', async () => {
  upstreamHandler = () => {
    throw new Error('timed out');
  };
  const res = await call('/api/validators');
  assertEqual(res.status, 502, 'status');
  assertEqual((await res.json()).error, 'upstream', 'body.error');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
