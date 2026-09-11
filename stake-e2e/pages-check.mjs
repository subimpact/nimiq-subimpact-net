import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs';
const BASE = 'http://localhost:4331';
let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log('PASS  ' + m)) : (failed++, console.log('FAIL  ' + m)); };

const browser = await chromium.launch();
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
await context.route('https://nimiq-api.subimpact.net/**', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], validators: [], stakers: [], blockNumber: 1, part: { index: 1, count: 1 } }) }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

for (const path of ['/validators/', '/graph/']) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  // A click before hydration is designed to follow the plain staking link, so
  // wait for the island before asserting the dialog opens.
  await page.locator('astro-island[component-export="StakeDialogHost"]:not([ssr])').waitFor({ state: 'attached', timeout: 15000 });
  await page.locator('[data-stake-cta="nav"]').click();
  const dialog = page.locator('[data-slot="dialog-content"]');
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  assert(page.url() === BASE + path, `${path}: nav CTA opens the dialog without navigating`);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

  const footerCopy = page.locator('footer button').first();
  await footerCopy.click();
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(clip.startsWith('NQ08 ACT8'), `${path}: footer address copies`);
  assert(
    await page.locator('[data-stake-cta]').count() === 1,
    `${path}: only the nav CTA is present (no stray generic staking links)`
  );
}

// The remaining plain nimiq.com/staking links, if any, across all pages.
for (const path of ['/', '/validators/', '/graph/']) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  const generic = await page.locator('a[href="https://www.nimiq.com/staking"]:not([data-stake-cta])').count();
  assert(generic === 0, `${path}: no generic staking link left unwired (${generic} found)`);
}

// The server-status strip in the homepage's "Validator status" card. The mock above
// answers /api/status with the same shapeless stub as everything else, so what is
// checked here is the structure plus the graceful degradation: the strip must still
// name its source and link to it when the payload tells it nothing.
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
const strip = page.locator('#status [data-server-status]');
await strip.waitFor({ state: 'attached', timeout: 15000 });
assert(await strip.count() === 1, '/: #status contains the server-status strip');

const STATUS_PAGE = 'https://uptime.subimpact.net/status/live';
const statusLink = strip.locator('[data-status-source]');
const statusHref = await statusLink.getAttribute('href').catch(() => null);
assert(statusHref === STATUS_PAGE, `/: status strip links to ${STATUS_PAGE} (got ${statusHref})`);
assert(
  (await statusLink.getAttribute('rel')) === 'noopener' &&
    (await statusLink.getAttribute('target')) === '_blank',
  '/: the status-page link opens in a new tab with rel=noopener',
);

// Either a monitor row or the "unavailable" line — both are correct answers, and
// which one appears depends on the API, so neither is asserted on its own.
await page
  .locator('#status [data-monitor], #status [data-status-fallback]')
  .first()
  .waitFor({ state: 'visible', timeout: 15000 });
const rows = await strip.locator('[data-monitor]').count();
const fallback = await strip.locator('[data-status-fallback]').count();
assert(
  rows > 0 || fallback === 1,
  `/: status strip resolves to rows or the unavailable state (${rows} rows, ${fallback} fallback)`,
);
assert(
  (await strip.innerText()).includes('uptime.subimpact.net'),
  '/: status strip credits uptime.subimpact.net either way',
);

assert(errors.length === 0, `no uncaught page errors (${errors.join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
