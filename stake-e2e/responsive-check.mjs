// Desktop-wide layout check: no horizontal overflow at any viewport, and both
// maps — NimMap at /graph/ and the delegation map at /validators/?view=map —
// actually fill a desktop screen. All API data is mocked so the canvases render
// without the live API.
import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://localhost:4331';
const PATHS = ['/', '/validators/', '/graph/', '/validators/?view=map', '/explorer/', '/explorer/block/?id=61000000', '/explorer/tx/?id=b4875e2a2533e121283b5b7008d5698c4e76e6e9261d2bd56ba4fa9795d6a3a8'];
const SEED = 'NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY';
const COUNTERPARTY = 'NQ27 NCB1 3CYU 9P4L EM2V D7L2 28QE 36PA EXB1';
// `minCanvas` is the NimMap target — /graph/ keeps the near-full-bleed 1920px
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
/** Two hops of flow, enough for NimMap to draw something measurable. */
const HISTORY_BODY = JSON.stringify({
  data: [
    {
      hash: 'a'.repeat(64), blockNumber: 61000000, timestamp: Date.now() - 86400000,
      confirmations: 900, size: 139, from: SEED, to: COUNTERPARTY, value: 500000, fee: 0,
    },
  ],
  pagination: { nextStartAt: null },
});

/** A stake big enough to exercise the compact-vs-full stat rendering. */
const IMPACT_STAKE_LUNA = 3_512_194 * 1e5;
const LIVE_VALIDATORS = JSON.stringify({
  data: [{ address: SEED, name: 'ImpactZero stake', balance: IMPACT_STAKE_LUNA, numStakers: 42 }],
  epochNumber: 1234,
  epoch: { approxSecondsRemaining: 900 },
});

/**
 * A full /api/status payload: both monitors, the 100 beats the worker can send, and a
 * label long enough to be the one that would overflow a 390px card if anything did.
 * Two down beats sit inside the newest 30 so the mobile window is not all one colour.
 */
const STATUS_BEATS = Array.from({ length: 100 }, (_, i) => (i === 80 || i === 95 ? 0 : 1));
const STATUS_BODY = JSON.stringify({
  fetchedAt: Date.now() - 4000,
  source: 'uptime.subimpact.net',
  sourceUrl: 'https://uptime.subimpact.net/status/live',
  monitors: [
    {
      id: 28, label: 'Validator node · p2p 8443', status: 1, ping: 12,
      lastCheck: new Date(Date.now() - 38000).toISOString(),
      uptime24h: 0.9971530249110321, heartbeats: STATUS_BEATS,
    },
    {
      id: 27, label: 'Website', status: 1, ping: 137,
      lastCheck: new Date(Date.now() - 12000).toISOString(),
      uptime24h: 1, heartbeats: STATUS_BEATS.map(() => 1),
    },
  ],
});

await context.route('https://nimiq-api.subimpact.net/**', (route) => {
  const url = route.request().url();
  if (url.includes('/api/history/')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: HISTORY_BODY });
  }
  if (url.includes('/api/status')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: STATUS_BODY });
  }
  if (url.includes('/api/active-validators')) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        addresses: VALIDATORS.slice(0, 11).map((v) => v.address.replace(/\s+/g, '').toUpperCase()),
        count: 11,
        fetchedAt: Date.now(),
      }),
    });
  }
  if (url.includes('/api/blocks')) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        height: 61000005,
        fetchedAt: Date.now(),
        source: 'rpc.nimiqwatch.com',
        blocks: Array.from({ length: 15 }, (_, i) => ({
          number: 61000005 - i,
          hash: 'f'.repeat(63) + (i % 10),
          parentHash: 'e'.repeat(64),
          timestamp: Date.now() - i * 60000,
          size: 793,
          batch: 965500 + i,
          epoch: 1342,
          txCount: 1,
          producer: SEED,
          transactions: [
            { hash: 'b'.repeat(64), blockNumber: 61000005 - i, timestamp: Date.now() - i * 60000, confirmations: i + 3, size: 139, from: SEED, to: COUNTERPARTY, value: 500000, fee: 0, fromType: 0, toType: 0, flags: 0, dataType: null, senderDataType: null },
          ],
        })),
      }),
    });
  }
  if (url.includes('/api/block/')) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        block: {
          number: 61000000,
          hash: 'a'.repeat(64),
          parentHash: 'b'.repeat(64),
          timestamp: Date.now() - 300000,
          size: 793,
          batch: 965512,
          epoch: 1342,
          txCount: 2,
          producer: SEED,
          transactions: [
            { hash: 'b'.repeat(64), blockNumber: 61000000, timestamp: Date.now() - 300000, confirmations: 3, size: 139, from: SEED, to: COUNTERPARTY, value: 500000, fee: 0, fromType: 0, toType: 0, flags: 0, dataType: null, senderDataType: null },
            { hash: 'c'.repeat(64), blockNumber: 61000000, timestamp: Date.now() - 300000, confirmations: 3, size: 139, from: COUNTERPARTY, to: SEED, value: 12345, fee: 0, fromType: 0, toType: 0, flags: 0, dataType: null, senderDataType: null },
          ],
        },
      }),
    });
  }
  if (url.includes('/api/tx/')) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tx: { hash: 'b'.repeat(64), blockNumber: 61000000, timestamp: Date.now() - 300000, confirmations: 3, size: 139, from: SEED, to: COUNTERPARTY, value: 500000, fee: 0, fromType: 0, toType: 0, flags: 0, dataType: null, senderDataType: null },
      }),
    });
  }
  const body = url.includes('/api/graph')
    ? GRAPH_BODY
    : url.includes('/api/validators')
      ? LIVE_VALIDATORS
      : JSON.stringify({ data: [], validators: [], epochNumber: 1234, epoch: { approxSecondsRemaining: 900 } });
  route.fulfill({ status: 200, contentType: 'application/json', body });
});

// ValidatorTable talks to the upstream worker directly, not to our API host.
// Mocked so its "Live data from …" credit line renders without the network.
await context.route('https://validators-api-main.je-cf9.workers.dev/**', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(
      VALIDATORS.map((v, i) => ({
        id: i + 1,
        name: v.name,
        address: v.address,
        fee: 0,
        payoutType: 'restake',
        balance: v.balance,
        stakers: v.numStakers,
        score: { availability: 1, reliability: 1, dominance: 0.05, total: 0.9, epochNumber: 1234 },
      })),
    ),
  }),
);

// Fiat rates come straight from CoinGecko in the browser. Mocked for every
// offered currency so the currency bar and the "≈" cells have numbers.
const FIAT_CODES = [
  'aed', 'ars', 'aud', 'brl', 'cad', 'chf', 'clp', 'cny', 'czk', 'dkk', 'eur', 'gbp', 'hkd',
  'huf', 'idr', 'ils', 'inr', 'jpy', 'krw', 'mxn', 'myr', 'ngn', 'nok', 'nzd', 'php', 'pkr',
  'pln', 'rub', 'sek', 'sgd', 'thb', 'try', 'twd', 'uah', 'usd', 'vnd', 'zar',
];
await context.route('https://api.coingecko.com/**', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      'nimiq-2': Object.fromEntries(FIAT_CODES.map((code) => [code, code === 'myr' ? 0.0016 : 0.00039])),
    }),
  }),
);

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

    const isNimMap = path === '/graph/';
    if (isNimMap || path.includes('view=map')) {
      // NimMap draws nothing until it is given an address to follow.
      if (isNimMap) {
        await page
          .locator('astro-island[component-export="NimMap"]:not([ssr])')
          .waitFor({ state: 'attached', timeout: 15000 });
        await page.locator('[data-nimmap-input]').fill(SEED);
        await page.locator('[data-nimmap-scan]').click();
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
      const target = isNimMap ? vp.minCanvas : vp.minMapCard;
      if (target) {
        assert(rect.cardW >= target, `${path}: map card width ${rect.cardW} >= ${target}`);
        // The delegation map keeps an 18rem cluster sidebar inside its card, so
        // its canvas can never be wider than the card − 288px. NimMap has no
        // sidebar and should take essentially the whole card.
        const floor = isNimMap ? target - 60 : target - 300;
        assert(rect.w >= floor, `${path}: canvas takes the card it is given (${rect.w} >= ${floor})`);
      }

      if (isNimMap) {
        // The legend is expanded on a desktop and folded to a pill on a phone, where
        // 390px has no room to spend on a key nobody asked for. Either way it has to
        // fit inside the canvas it sits on top of.
        const expanded = await page.locator('[data-nimmap-legend]').count();
        const pill = await page.locator('[data-nimmap-legend-toggle]').count();
        if (vp.width >= 640) {
          assert(expanded === 1, `${path} @ ${vp.name}: the legend opens expanded on a desktop`);
        } else {
          assert(
            expanded === 0 && pill === 1,
            `${path} @ ${vp.name}: the legend starts folded to a pill on a phone`,
          );
          await page.locator('[data-nimmap-legend-toggle]').click();
          await page.locator('[data-nimmap-legend]').waitFor({ timeout: 5000 });
        }
        const fits = await page.locator('[data-nimmap-legend]').evaluate((el) => {
          const legend = el.getBoundingClientRect();
          const shell = el.parentElement.getBoundingClientRect();
          return {
            ok: legend.left >= shell.left - 1 && legend.right <= shell.right + 1,
            w: Math.round(legend.width),
            shellW: Math.round(shell.width),
          };
        });
        assert(
          fits.ok,
          `${path} @ ${vp.name}: the open legend fits the map (${fits.w}px inside ${fits.shellW}px)`,
        );
        assert(
          (await page.locator('[data-nimmap-colormode]').getAttribute('data-nimmap-colormode')) === 'type',
          `${path} @ ${vp.name}: the map opens coloured by transaction type`,
        );

        // A detail panel is bottom-left and, on a phone, as wide as the canvas. The
        // legend has to get out of its way there and stay put on a desktop. Driven
        // from the transaction list rather than by sweeping the canvas for a hit.
        const row = page.locator('ul li button').filter({ hasText: '→' }).first();
        if (await row.count()) {
          await row.click();
          await page.getByText('Confirmations').first().waitFor({ timeout: 10000 });
          const stillThere = await page
            .locator('[data-nimmap-legend], [data-nimmap-legend-toggle]')
            .first()
            .isVisible();
          assert(
            vp.width >= 640 ? stillThere : !stillThere,
            vp.width >= 640
              ? `${path} @ ${vp.name}: the legend stays put beside an open detail panel`
              : `${path} @ ${vp.name}: the legend yields to the detail panel it would cover`,
          );
          await page.keyboard.press('Escape');
          await page.locator('[data-nimmap-legend], [data-nimmap-legend-toggle]').first().waitFor({ timeout: 5000 });
          assert(true, `${path} @ ${vp.name}: closing the panel brings the legend back`);
        }
      }
    }

    if (vp.width < 768) {
      const bar = page.locator('nav.fixed.bottom-0, nav[class*="fixed"][class*="bottom-0"]').first();
      const barBox = await bar.boundingBox();
      assert(
        barBox !== null && barBox.width === vp.width && (await bar.locator('a').count()) === 6,
        `${path}: mobile bottom bar intact (${barBox ? Math.round(barBox.width) : 'missing'}px wide, 6 links)`,
      );
    }
  }
}

// Stat values must not clip. Network stake runs to billions of NIM, so the hero
// card renders a compact form (5.63B) wherever the full figure would not fit.
// Checked at every viewport the suite already visits, plus the md two-column
// hero at 768px, which squeezes the stat cell harder than a phone does.
for (const width of [390, 768, 900, 1440, 1920]) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  const stats = await page.evaluate(() =>
    [...document.querySelectorAll('[data-stat]')].map((el) => ({
      key: el.dataset.stat,
      text: el.innerText.trim(),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    })),
  );
  for (const s of stats) {
    assert(
      s.scrollWidth <= s.clientWidth + 1,
      `${width}px: ${s.key} "${s.text}" not clipped (scrollWidth ${s.scrollWidth} <= clientWidth ${s.clientWidth})`,
    );
    // Where the compact form renders it must also be a single line — that is
    // the whole point of it. At lg+ the full figure is deliberately back, and
    // in the 32rem hero card "NIM" legitimately falls to a second line.
    if (width < 1024) {
      assert(s.lines <= 1, `${width}px: ${s.key} "${s.text}" stays on one line (${s.lines})`);
    } else {
      console.log(`      ${width}px: ${s.key} "${s.text}" on ${s.lines} line(s), full precision`);
    }
  }
}

// The server-status strip, with a full payload behind it. 60 heartbeat bars at 4px are
// 240px — more than the 390px card has to spare once "checked 38s ago" is beside them,
// so the oldest 30 drop out below sm. Nothing in the strip may scroll sideways.
for (const width of [390, 1440]) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.locator('#status [data-server-status="ready"]').waitFor({ timeout: 15000 });

  const strip = await page.evaluate(() => {
    const el = document.querySelector('[data-server-status]');
    const node = document.querySelector('[data-monitor="28"]');
    const bars = [...node.querySelectorAll('span[title]')];
    return {
      state: el.dataset.serverStatus,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      rows: document.querySelectorAll('[data-monitor]').length,
      bars: bars.length,
      visibleBars: bars.filter((b) => b.getBoundingClientRect().width > 0).length,
      right: Math.round(Math.max(...bars.map((b) => b.getBoundingClientRect().right))),
      cardRight: Math.round(node.closest('.rounded-xl').getBoundingClientRect().right),
      text: el.innerText.replace(/\s+/g, ' ').trim(),
    };
  });
  console.log(`      ${width}px: ${strip.rows} rows, ${strip.visibleBars}/${strip.bars} bars shown`);
  assert(strip.rows === 2, `${width}px: both monitors render (${strip.rows})`);
  assert(
    strip.scrollWidth <= strip.clientWidth + 1,
    `${width}px: status strip does not scroll sideways (${strip.scrollWidth} <= ${strip.clientWidth})`,
  );
  assert(
    strip.right <= strip.cardRight,
    `${width}px: heartbeat bars stay inside the card (${strip.right} <= ${strip.cardRight})`,
  );
  assert(
    strip.visibleBars === (width < 640 ? 30 : 60),
    `${width}px: ${width < 640 ? 30 : 60} bars shown (got ${strip.visibleBars})`,
  );
  assert(
    strip.text.includes('Up · 24h 99.7% · 12 ms'),
    `${width}px: the node row spells out its state (got ${JSON.stringify(strip.text.slice(0, 90))})`,
  );
  assert(
    strip.text.includes('Live from uptime.subimpact.net'),
    `${width}px: the strip credits its source`,
  );
}

// The API host is credited with a link to the source repo, not as bare text.
const SOURCE_REPO = 'https://github.com/nimiq/validators-api';
await page.setViewportSize({ width: 1440, height: 900 });
for (const path of ['/', '/validators/']) {
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  const link = page.locator(`[data-source-line] a[href="${SOURCE_REPO}"]`).first();
  const href = await link.getAttribute('href').catch(() => null);
  assert(href === SOURCE_REPO, `${path}: source line links to ${SOURCE_REPO} (got ${href})`);
  const text = await link.textContent().catch(() => null);
  assert(
    (text || '').includes('validators-api-main.je-cf9.workers.dev'),
    `${path}: the linked token is the API host (got ${JSON.stringify(text)})`,
  );
}

// The elected chips: one per row, fed by the chain's active set plus the score signal.
// Eleven validators are in the mocked active set; the twelfth must read Inactive even
// though its mock score alone would read Elected.
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(BASE + '/validators/', { waitUntil: 'load' });
await page.locator('[data-elected-chip="inactive"]').waitFor({ timeout: 10000 });
assert((await page.locator('[data-elected-chip]').count()) === 12, 'every listed validator carries a status chip');
assert((await page.locator('[data-elected-chip="elected"]').count()) === 11, 'validators in the active set read Elected');
assert((await page.locator('[data-elected-chip="inactive"]').count()) === 1, 'a validator outside the active set reads Inactive');

// Fiat evaluation: the currency bar knows the NIM rate, every stake cell gets an
// "≈" value priced in the chosen currency, and switching re-prices + persists.
await page.goto(BASE + '/validators/', { waitUntil: 'load' });
await page.locator('[data-stake-fiat]').first().waitFor({ timeout: 10000 });
const usdCell = (await page.locator('[data-stake-fiat]').first().innerText()).trim();
assert(usdCell.startsWith('≈ $'), `a stake cell is evaluated in USD by default (got "${usdCell}")`);
assert(
  (await page.locator('[data-total-fiat]').innerText()).includes('Total staked ≈ $'),
  'the bar prices the whole book of stake',
);
await page.locator('[data-currency-switcher]').click();
await page.locator('[data-currency-tile="myr"]').click();
const myrCell = (await page.locator('[data-stake-fiat]').first().innerText()).trim();
assert(myrCell.startsWith('≈ RM'), `the stake cell re-prices to MYR after the switch (got "${myrCell}")`);
assert(
  (await page.locator('[data-rate-line]').innerText()).includes('RM'),
  'the rate line follows the currency',
);
const savedCurrency = await page.evaluate(() => window.localStorage.getItem('nimiq:currency'));
assert(savedCurrency === 'myr', `the choice is remembered (got ${savedCurrency})`);

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
