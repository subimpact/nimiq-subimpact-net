import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:4331';
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`PASS  ${msg}`); }
  else { failed++; console.log(`FAIL  ${msg}`); }
}

const browser = await chromium.launch();
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();

const requests = [];
page.on('request', (r) => requests.push(r.url()));
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Stub the worker so the flow is deterministic and nothing real is contacted.
await context.route('https://nimiq-api.subimpact.net/api/**', async (route) => {
  const url = route.request().url();
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.includes('/api/account/')) return json({ data: { balance: 5000000000, type: 'basic' } });
  if (url.includes('/api/staker/')) return json({ data: null });
  if (url.includes('/api/network')) return json({ blockNumber: 61311377, epochNumber: 1340, epoch: { approxSecondsRemaining: 1000 } });
  if (url.includes('/api/validators')) return json({ data: [] });
  return json({});
});

await page.goto(BASE, { waitUntil: 'networkidle' });

// --- no nimiq code on first load ------------------------------------------
assert(!requests.some((u) => /\.wasm(\?|$)/.test(u)), 'no wasm requested on initial page load');
assert(!requests.some((u) => /StakeDialog\./.test(u)), 'StakeDialog chunk not requested on initial page load');
assert(requests.some((u) => /StakeDialogHost\./.test(u)), 'StakeDialogHost island is loaded on page load');

// --- footer copy ----------------------------------------------------------
const footerCopy = page.locator('footer button').first();
await footerCopy.waitFor({ state: 'visible' });
assert(await footerCopy.innerText().then((t) => t.includes('NQ08 ACT8')), 'footer shows the validator address');
await footerCopy.click();
await page.waitForTimeout(200);
const clip = await page.evaluate(() => navigator.clipboard.readText());
assert(clip === 'NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY', `footer click copies the address (got "${clip}")`);
assert(await footerCopy.innerText().then((t) => t.includes('Copied!')), 'footer shows "Copied!" feedback');
await page.waitForTimeout(1600);
assert(!(await footerCopy.innerText()).includes('Copied!'), 'feedback clears after ~1.5s');

// --- status-card copy -----------------------------------------------------
const statusCopy = page.locator('#status button').first();
await statusCopy.scrollIntoViewIfNeeded();
await statusCopy.click();
await page.waitForTimeout(200);
assert(
  (await page.evaluate(() => navigator.clipboard.readText())) === 'NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY',
  'validator status card address copies on click',
);

// --- CTA opens the dialog instead of navigating ---------------------------
for (const [name, selector] of [
  ['nav', '[data-stake-cta="nav"]'],
  ['hero', '[data-stake-cta="hero"]'],
  ['cta section', '[data-stake-cta="cta"]'],
]) {
  await page.locator(selector).first().click();
  const dialog = page.locator('[data-slot="dialog-content"]');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  assert(page.url() === `${BASE}/`, `${name} CTA does not navigate away`);
  assert(await dialog.getByText('Stake NIM with ImpactZero').isVisible(), `${name} CTA opens the dialog`);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert(true, `${name}: Escape closes the dialog`);
}

assert(requests.some((u) => /StakeDialog\./.test(u)), 'StakeDialog chunk loads on first open');
assert(!requests.some((u) => /\.wasm(\?|$)/.test(u)), 'still no wasm after merely opening the dialog');

// --- step 1 -> step 2, with a stubbed Hub ---------------------------------
await page.locator('[data-stake-cta="nav"]').click();
const dialog = page.locator('[data-slot="dialog-content"]');
await dialog.waitFor({ state: 'visible' });
assert(await dialog.getByRole('button', { name: /Connect your Nimiq account/ }).isVisible(), 'step 1 offers the connect button');

// Replace the popup the Hub would open with a stub that answers chooseAddress.
await page.evaluate(() => {
  const address = 'NQ27 NCB1 3CYU 9P4L EM2V D7L2 28QE 36PA EXB1';
  window.__opened = [];
  window.open = (url) => {
    window.__opened.push(String(url));
    // Answer the Hub RPC handshake the way the real popup would.
    const post = (data) => window.postMessage(data, '*');
    setTimeout(() => post({ status: 'OK', result: { address, label: 'Test account' }, id: window.__lastId }), 50);
    return { closed: false, close() { this.closed = true; }, focus() {}, postMessage() {} };
  };
});
await dialog.getByRole('button', { name: /Connect your Nimiq account/ }).click();
await page.waitForTimeout(800);
const opened = await page.evaluate(() => window.__opened || []);
assert(opened.some((u) => u.startsWith('https://hub.nimiq.com')), `connect opens the Nimiq Hub (${opened[0] || 'nothing opened'})`);
assert(
  await page.locator('[data-slot="dialog-content"]').getByText(/Waiting for the Hub/).isVisible(),
  'the dialog shows a waiting state while the Hub popup is open',
);

assert(consoleErrors.length === 0, `no uncaught page errors (${consoleErrors.join(' | ')})`);

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
