// Explorer end-to-end: the hub's live columns, search routing, and the two detail
// pages — driven through the ?id= fallback, because a local preview cannot rewrite
// the pretty /explorer/block/<id> URLs that Pages serves in production. All API
// calls are mocked so the suite runs offline.
import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://localhost:4331';
let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log('PASS  ' + m)) : (failed++, console.log('FAIL  ' + m)); };

const HEIGHT = 61000005;
const blockHash = (n) => n.toString(16).padStart(64, '0');
const TX1 = 'b4875e2a2533e121283b5b7008d5698c4e76e6e9261d2bd56ba4fa9795d6a3a8';
const TX2 = 'edf59c0b6885b62ef243f065b1676e36ac9d74f5c13b0884cca5b979b3900349';
const ALICE = 'NQ02 31N6 3KM5 T6G5 22TN EPF5 5XPY RLHK RMB3';
const STAKE_CONTRACT = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001';

const tx = (hash, from, to, value, at) => ({
  hash, blockNumber: 61000000 + at, timestamp: Date.now() - at * 60000 - 30000,
  confirmations: at + 3, size: 139, from, to, value, fee: 0,
  fromType: 0, toType: 0, flags: 0, dataType: null, senderDataType: null,
});
const TXS = [
  tx(TX1, ALICE, STAKE_CONTRACT, 500000, 2),   // add-stake, contract target
  tx(TX2, STAKE_CONTRACT, ALICE, 12345, 3),    // reward, contract source
];
const block = (n) => ({
  number: n, hash: blockHash(n), parentHash: blockHash(n - 1),
  timestamp: Date.now() - (HEIGHT - n) * 60000, size: 793,
  batch: 965500 + (n % 40), epoch: 1342, txCount: n === 61000000 ? TXS.length : 1,
  producer: 'NQ97 H1NR S3X0 CVFQ VJ9Y 9A0Y FRQN Q6EU D0PL',
  transactions: n === 61000000 ? TXS : [tx(TX1, ALICE, STAKE_CONTRACT, 500000, 1)],
});
const BLOCKS_BODY = JSON.stringify({
  height: HEIGHT, fetchedAt: Date.now(), source: 'rpc.nimiqwatch.com',
  blocks: Array.from({ length: 15 }, (_, i) => block(HEIGHT - i)),
});
const BLOCK_BODY = JSON.stringify({ block: block(61000000) });
const TX_BODY = JSON.stringify({ tx: TXS[0] });

const browser = await chromium.launch();
const context = await browser.newContext();
const apiLog = [];
await context.route('https://nimiq-api.subimpact.net/**', (route) => {
  const url = route.request().url();
  apiLog.push(url.slice(30));
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body });
  if (url.includes('/api/blocks')) return json(BLOCKS_BODY);
  if (url.includes('/api/block/')) {
    const id = decodeURIComponent(url.split('/api/block/')[1].split('?')[0]);
    if (id === '61000000') return json(BLOCK_BODY);
    return json(JSON.stringify({ error: 'not found' }), 404);
  }
  if (url.includes('/api/tx/')) {
    const id = url.split('/api/tx/')[1].split('?')[0];
    if (id === TX1) return json(TX_BODY);
    return json(JSON.stringify({ error: 'not found' }), 404);
  }
  if (url.includes('/api/search')) {
    const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
    if (q === '61000000') return json(JSON.stringify({ type: 'block', number: 61000000 }));
    if (q.startsWith('NQ27')) return json(JSON.stringify({ type: 'address', address: 'NQ27 NCB1 3CYU 9P4L EM2V D7L2 28QE 36PA EXB1' }));
    return json(JSON.stringify({ error: 'not found' }), 404);
  }
  if (url.includes('/api/history/')) return json(JSON.stringify({ data: [], pagination: { nextStartAt: null } }));
  if (url.includes('/api/network')) return json(JSON.stringify({ totalStake: 0, numStakers: 0, epochNumber: 1342, epoch: { approxSecondsRemaining: 900 } }));
  if (url.includes('/api/status')) return json(JSON.stringify({ monitors: [] }));
  return json(JSON.stringify({ data: [], validators: [], stakers: [] }));
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// — hub: live head, 15 newest blocks, latest transactions, search box —
await page.goto(BASE + '/explorer/', { waitUntil: 'domcontentloaded' });
await page.locator('[data-explorer-block]').first().waitFor({ state: 'visible', timeout: 20000 });
const headline = await page.locator('[data-explorer-headline]').innerText();
assert(headline.includes('Chain head') && headline.includes('#61,000,005'), `/explorer/: headline shows the mocked head (got "${headline.replace(/\s+/g, ' ')}")`);
assert(await page.locator('[data-explorer-block]').count() === 15, '/explorer/: 15 newest blocks listed');
assert(await page.locator('[data-explorer-tx]').count() >= 1, '/explorer/: the transactions column lists live activity');
const firstHref = await page.locator('[data-explorer-block]').first().getAttribute('href');
assert(firstHref === `/explorer/block/${HEIGHT}`, `/explorer/: block rows link to pretty detail URLs (got ${firstHref})`);
const txHref = await page.locator('[data-explorer-tx]').first().getAttribute('href');
assert(/^\/explorer\/tx\/[0-9a-f]{64}$/.test(txHref), `/explorer/: tx rows link to pretty tx URLs (got ${txHref})`);
await page.locator('astro-island[component-export="ExplorerSearch"]:not([ssr])').waitFor({ state: 'attached', timeout: 15000 });
assert(await page.locator('[data-explorer-search]').count() === 1, '/explorer/: the search box is hydrated and present');

// — nav entry, desktop and phone bar —
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(300);
assert(await page.locator('a[href="/explorer/"]').count() >= 2, '/: Explorer is linked from the nav and the bottom bar');

// — block detail through the ?id= fallback (the path form is rewrites-only, Pages-side) —
await page.goto(BASE + '/explorer/block/?id=61000000', { waitUntil: 'domcontentloaded' });
await page.locator('[data-explorer-block-detail]').waitFor({ state: 'visible', timeout: 20000 });
const blockText = (await page.locator('[data-explorer-block-detail]').innerText()).replace(/\s+/g, ' ');
assert((await page.locator('h1').innerText()) === 'Block 61,000,000', 'block detail: h1 names the block');
assert(blockText.includes('Hash') && blockText.includes('Producer') && blockText.includes('2 transactions'), 'block detail: hash, producer and tx count rows render');
assert(await page.locator('[data-explorer-tx]').count() === 2, 'block detail: both transactions listed');
const detailTxHref = await page.locator('[data-explorer-tx]').first().getAttribute('href');
assert(detailTxHref === `/explorer/tx/${TX1}`, `block detail: tx rows link to /explorer/tx/<hash> (got ${detailTxHref})`);
const pair = page.locator('[data-explorer-address-pair]').first();
await pair.click();
assert((await pair.innerText()).includes(ALICE), 'block detail: clicking an address pair reveals the exact addresses');

// — tx detail —
await page.goto(BASE + `/explorer/tx/?id=${TX1}`, { waitUntil: 'domcontentloaded' });
try {
  await page.locator('[data-explorer-tx-detail]').waitFor({ state: 'visible', timeout: 20000 });
} catch (e) {
  console.log('DEBUG url:', page.url());
  console.log('DEBUG body:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 320));
  console.log('DEBUG api:', JSON.stringify(apiLog.slice(-5)));
  console.log('DEBUG errors:', JSON.stringify(errors.slice(-4)));
  throw e;
}
const txText = (await page.locator('[data-explorer-tx-detail]').innerText()).replace(/\s+/g, ' ');
assert((await page.locator('h1').innerText()) === 'Transaction', 'tx detail: h1 renders');
assert(txText.includes('confirmations') && txText.includes(ALICE.slice(0, 9)), 'tx detail: confirmations and both addresses render');
assert((await page.locator('[data-explorer-tx-kind]').innerText()).length > 0, 'tx detail: the classification chip is labelled');

// — missing and bare states degrade with a message, never a crash —
await page.goto(BASE + '/explorer/block/?id=999999999', { waitUntil: 'domcontentloaded' });
await page.locator('[data-explorer-missing]').waitFor({ state: 'visible', timeout: 20000 });
assert((await page.locator('[data-explorer-missing]').innerText()).includes('No block'), 'block detail: an unknown id says so');
await page.goto(BASE + '/explorer/block/', { waitUntil: 'domcontentloaded' });
await page.locator('[data-explorer-missing]').waitFor({ state: 'visible', timeout: 20000 });
assert((await page.locator('[data-explorer-missing]').innerText()).includes('No block'), 'bare block shell: missing id degrades to the same message');
await page.goto(BASE + '/explorer/tx/', { waitUntil: 'domcontentloaded' });
await page.locator('[data-explorer-missing]').waitFor({ state: 'visible', timeout: 20000 });
assert((await page.locator('[data-explorer-missing]').innerText()).includes('No transaction'), 'bare tx shell: missing hash degrades to the same message');

// — search routes: number → block, address → NimMap seed —
await page.goto(BASE + '/explorer/', { waitUntil: 'domcontentloaded' });
await page.locator('astro-island[component-export="ExplorerSearch"]:not([ssr])').waitFor({ state: 'attached', timeout: 15000 });
await page.locator('[data-explorer-search]').fill('61000000');
await page.locator('[data-explorer-search-submit]').click();
await page.waitForURL('**/explorer/block/61000000', { timeout: 15000 });
assert(true, 'search: a height navigates to /explorer/block/<n>');
await page.goto(BASE + '/explorer/', { waitUntil: 'domcontentloaded' });
await page.locator('astro-island[component-export="ExplorerSearch"]:not([ssr])').waitFor({ state: 'attached', timeout: 15000 });
await page.locator('[data-explorer-search]').fill('NQ27NCB13CYU9P4LEM2VD7L228QE36PAEXB1');
await page.locator('[data-explorer-search-submit]').click();
await page.waitForURL(/\/graph\/\?seed=NQ27/, { timeout: 15000 });
assert(true, 'search: an address opens NimMap seeded with it');

assert(errors.length === 0, `no page errors across the explorer (${errors.length}): ${errors.slice(0, 2).join(' | ')}`);

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
