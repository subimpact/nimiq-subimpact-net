/**
 * Local test harness for the nimiq-api worker — plain Node, no dependencies.
 *
 * Drives the exported fetch handler directly with mocked Requests, stubbing
 * globalThis.fetch (fake NimiqHub) and globalThis.caches (in-memory Cache API).
 *
 *   node worker/test-local.mjs
 */

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

function call(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Origin')) headers.set('Origin', ORIGIN);
  return worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }), {}, ctx);
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
  assertEqual(res.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS', 'ACAM');
  assertEqual(res.headers.get('Access-Control-Allow-Headers'), 'Content-Type', 'ACAH');
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
