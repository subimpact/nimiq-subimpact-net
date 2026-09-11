// Desktop-wide layout check: no horizontal overflow at any viewport, and the
// delegation map actually fills a desktop screen. Graph data is mocked so the
// canvas renders without the live API.
import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://localhost:4331';
const PATHS = ['/', '/validators/', '/graph/'];
const VIEWPORTS = [
  { name: 'desktop 1440x900', width: 1440, height: 900, minCanvas: 1300 },
  { name: 'desktop 1920x1080', width: 1920, height: 1080, minCanvas: 1700 },
  { name: 'mobile 390x844', width: 390, height: 844, minCanvas: 0 },
];

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log('PASS  ' + m)) : (failed++, console.log('FAIL  ' + m)); };

const VALIDATORS = Array.from({ length: 12 }, (_, i) => ({
  address: `NQ08 ACT8 T0FE 0000 0000 0000 0000 0000 ${String(1000 + i)}`.slice(0, 44),
  name: `Validator ${i + 1}`,
  balance: (12 - i) * 5_000_000 * 1e5,
  numStakers: 6,
  stakeShare: (12 - i) / 78,
}));
const STAKERS = VALIDATORS.flatMap((v, i) =>
  Array.from({ length: 6 }, (_, j) => ({
    address: `NQ08 STAK ER${String(i).padStart(2, '0')} ${String(j)}000 0000 0000 0000 0000`.slice(0, 44),
    validatorAddress: v.address,
    balance: (j + 1) * 250_000 * 1e5,
  })),
);
const GRAPH_BODY = JSON.stringify({
  validators: VALIDATORS,
  stakers: STAKERS,
  totalActiveStake: VALIDATORS.reduce((s, v) => s + v.balance, 0),
  updatedAt: '2026-09-11T00:00:00.000Z',
  part: { index: 1, count: 1 },
});

const browser = await chromium.launch();
const context = await browser.newContext();
await context.route('https://nimiq-api.subimpact.net/**', (route) => {
  const url = route.request().url();
  const body = url.includes('/api/graph')
    ? GRAPH_BODY
    : JSON.stringify({ data: [], validators: [], epochNumber: 1234, epoch: { approxSecondsRemaining: 900 } });
  route.fulfill({ status: 200, contentType: 'application/json', body });
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  console.log(`\n— ${vp.name} —`);

  for (const path of PATHS) {
    await page.goto(BASE + path, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    const box = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      bodyScroll: document.body.scrollWidth,
    }));
    assert(
      box.scrollWidth <= box.innerWidth && box.bodyScroll <= box.innerWidth,
      `${path}: no horizontal overflow (scrollWidth ${box.scrollWidth} <= innerWidth ${box.innerWidth})`,
    );

    if (path === '/graph/') {
      const canvas = page.locator('canvas').first();
      await canvas.waitFor({ state: 'visible', timeout: 20000 });
      const rect = await canvas.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const card = el.closest('.rounded-xl').getBoundingClientRect();
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          cardW: Math.round(card.width), cardH: Math.round(card.height),
        };
      });
      console.log(`      canvas ${rect.w} x ${rect.h} px · map card ${rect.cardW} x ${rect.cardH} px`);
      if (vp.minCanvas) {
        // The 18rem cluster sidebar sits inside the map card, so the canvas can
        // never be wider than viewport − 288px. The target is measured on the
        // card (canvas + sidebar), with the canvas floor set to what the card
        // leaves over.
        assert(rect.cardW >= vp.minCanvas, `/graph/: map card width ${rect.cardW} >= ${vp.minCanvas}`);
        assert(
          rect.w >= vp.minCanvas - 300,
          `/graph/: canvas takes all of the card minus the sidebar (${rect.w} >= ${vp.minCanvas - 300})`,
        );
      }
    }

    if (vp.width < 768) {
      const bar = page.locator('nav.fixed.bottom-0, nav[class*="fixed"][class*="bottom-0"]').first();
      const barBox = await bar.boundingBox();
      assert(
        barBox !== null && barBox.width === vp.width && (await bar.locator('a').count()) === 5,
        `${path}: mobile bottom bar intact (${barBox ? Math.round(barBox.width) : 'missing'}px wide, 5 links)`,
      );
    }
  }
}

// Shell width on desktop: the wide shells actually take the screen.
await page.setViewportSize({ width: 1920, height: 1080 });
await page.goto(BASE + '/', { waitUntil: 'load' });
const heroWidth = await page.evaluate(() =>
  Math.round(document.querySelector('main section').getBoundingClientRect().width),
);
console.log(`\nhomepage hero section width at 1920: ${heroWidth}px`);
assert(heroWidth >= 1560, `homepage shell reaches the 1600px cap (${heroWidth}px)`);

assert(errors.length === 0, `no uncaught page errors (${errors.join(' | ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
process.exit(failed > 0 ? 1 : 0);
