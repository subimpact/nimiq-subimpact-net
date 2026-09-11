// Desktop-wide layout check: no horizontal overflow at any viewport, and both
// maps — ChainMap at /graph/ and the delegation map at /validators/?view=map —
// actually fill a desktop screen. All API data is mocked so the canvases render
// without the live API.
import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://localhost:4331';
const PATHS = ['/', '/validators/', '/graph/', '/validators/?view=map'];
const SEED = 'NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY';
const COUNTERPARTY = 'NQ27 NCB1 3CYU 9P4L EM2V D7L2 28QE 36PA EXB1';
// `minCanvas` is the ChainMap target — /graph/ keeps the near-full-bleed 1920px
// shell, because the map is the page. `minMapCard` is the delegation map's, now
// that it lives inside the 1600px shell every other content page uses.
const VIEWPORTS = [
  { name: 'desktop 1440x900', width: 1440, height: 900, minCanvas: 1300, minMapCard: 1340 },
  { name: 'desktop 1920x1080', width: 1920, height: 1080, minCanvas: 1700, minMapCard: 1500 },
  { name: 'mobile 390x844', width: 390, height: 844, minCanvas: 0, minMapCard: 0 },
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
/** Two hops of flow, enough for ChainMap to draw something measurable. */
const HISTORY_BODY = JSON.stringify({
  data: [
    {
      hash: 'a'.repeat(64), blockNumber: 61000000, timestamp: Date.now() - 86400000,
      confirmations: 900, size: 139, from: SEED, to: COUNTERPARTY, value: 500000, fee: 0,
    },
  ],
  pagination: { nextStartAt: null },
});

await context.route('https://nimiq-api.subimpact.net/**', (route) => {
  const url = route.request().url();
  if (url.includes('/api/history/')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: HISTORY_BODY });
  }
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

    const isChainMap = path === '/graph/';
    if (isChainMap || path.includes('view=map')) {
      // ChainMap draws nothing until it is given an address to follow.
      if (isChainMap) {
        await page
          .locator('astro-island[component-export="ChainMap"]:not([ssr])')
          .waitFor({ state: 'attached', timeout: 15000 });
        await page.locator('[data-chainmap-input]').fill(SEED);
        await page.locator('[data-chainmap-scan]').click();
      }
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
      const target = isChainMap ? vp.minCanvas : vp.minMapCard;
      if (target) {
        assert(rect.cardW >= target, `${path}: map card width ${rect.cardW} >= ${target}`);
        // The delegation map keeps an 18rem cluster sidebar inside its card, so
        // its canvas can never be wider than the card − 288px. ChainMap has no
        // sidebar and should take essentially the whole card.
        const floor = isChainMap ? target - 60 : target - 300;
        assert(rect.w >= floor, `${path}: canvas takes the card it is given (${rect.w} >= ${floor})`);
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
