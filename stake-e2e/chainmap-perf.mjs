/**
 * Frame rate of the NimMap canvas, measured in a real browser against a real scan.
 *
 * The map is a canvas that repaints every address and every arrow on every frame it is
 * dirty, so the two changes most likely to cost frames are the ones that change what is
 * drawn: hexagons instead of circles (six lineTo calls per node instead of one arc) and
 * colour-by-family instead of colour-by-age (a different batch key). This measures both,
 * against the same map, so a regression in either shows up as a number rather than a
 * feeling.
 *
 * Two phases, because they stress different things:
 *
 *   scan   — from the moment Scan is pressed. The force simulation is ticking, the
 *            camera is refitting and the whole map repaints every frame. This is the
 *            worst sustained load the component ever sees.
 *   pan    — the settled map, dragged. No simulation, but a full repaint per frame:
 *            what a reader actually feels when they move the map around.
 *
 * Run it the way the other suites are run — `npm run build`, a preview on :4331 — then:
 *
 *   node stake-e2e/chainmap-perf.mjs
 *
 * It prints a table and exits non-zero if any measurement falls under MIN_FPS.
 */
import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs'

const BASE = process.env.BASE || 'http://localhost:4331'
const SEED = 'NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY'
const DAY = 86400000
/** Below this the map has stopped feeling live. rAF tops out at 60. */
const MIN_FPS = 45
/**
 * Each phase is measured more than once and the best run is the one reported.
 *
 * This runs on a shared VPS, where one sample in five loses 200-600ms to something
 * that has nothing to do with the canvas — enough to drag a 55fps phase to 41. Taking
 * the best of a few short runs measures the code; taking one run measures the box.
 */
const SCAN_RUNS = 2
const PAN_RUNS = 3

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`PASS  ${msg}`) }
  else { failed++; console.log(`FAIL  ${msg}`) }
}

// --- the synthetic chain ---------------------------------------------------
// The same deterministic, checksum-valid generator chainmap-e2e.mjs uses, so the two
// suites are measuring and asserting against the same shape of map.

const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY'

function addressFrom(n) {
  if (n === 0) return SEED
  let body = ''
  let x = (n + 1) * 2654435761 % 4294967296
  for (let i = 0; i < 32; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    body += ALPHABET[(x >>> 13) % 32]
  }
  let rem = 0
  for (const ch of `${body}NQ00`) {
    const v = ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55
    rem = (rem * (v > 9 ? 100 : 10) + v) % 97
  }
  return `NQ${String(98 - rem).padStart(2, '0')}${body}`.match(/.{1,4}/g).join(' ')
}

const TOTAL = 460
const ADDRESSES = Array.from({ length: TOTAL }, (_, i) => addressFrom(i))
const INDEX_OF = new Map(ADDRESSES.map((address, i) => [address.replace(/\s+/g, ''), i]))

/** A 20-wide fan-out, then 19 each: enough to reach the paid tier's 400-address cap. */
function childrenOf(index) {
  if (index === 0) return Array.from({ length: 20 }, (_, i) => i + 1)
  if (index <= 20) return Array.from({ length: 19 }, (_, i) => 21 + (index - 1) * 19 + i).filter((i) => i < TOTAL)
  return []
}

function parentOf(index) {
  if (index === 0) return null
  if (index <= 20) return 0
  return Math.floor((index - 21) / 19) + 1
}

/** Every family on the map at once, so the type palette really is six batches deep. */
function classificationFor(n) {
  switch (n % 6) {
    case 1: return { fromType: 0, toType: 3, flags: 2, dataType: 0x05, senderDataType: null }
    case 2: return { fromType: 3, toType: 0, flags: 0, dataType: null, senderDataType: 0x01 }
    case 3: return { fromType: 0, toType: 0, flags: 0, dataType: 0xff, senderDataType: null }
    case 4: return { fromType: 2, toType: 0, flags: 0, dataType: null, senderDataType: null }
    case 5: return { fromType: 1, toType: 0, flags: 0, dataType: null, senderDataType: null }
    default: return { fromType: 0, toType: 0, flags: 0, dataType: null, senderDataType: null }
  }
}

function historyFor(index, max) {
  const rows = []
  const push = (from, to, n) => {
    rows.push({
      hash: `${String(from).padStart(4, '0')}${String(to).padStart(4, '0')}`.padEnd(64, 'a'),
      blockNumber: 61000000 + n,
      timestamp: Date.now() - (n % 400) * DAY,
      confirmations: 1000 + n,
      size: 139,
      from: ADDRESSES[from],
      to: ADDRESSES[to],
      value: (n + 1) * 100000,
      fee: 0,
      ...classificationFor(n),
    })
  }
  const parent = parentOf(index)
  if (parent !== null) push(parent, index, index)
  for (const child of childrenOf(index)) push(index, child, child)
  const page = rows.slice(0, max)
  return { data: page, pagination: { nextStartAt: rows.length > max ? page[page.length - 1].hash : null } }
}

// --- the browser -----------------------------------------------------------

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.route('https://nimiq-api.subimpact.net/api/**', (route) => {
  const url = new URL(route.request().url())
  const json = (body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  if (url.pathname.startsWith('/api/history/')) {
    const address = decodeURIComponent(url.pathname.slice('/api/history/'.length))
    const index = INDEX_OF.get(address.replace(/\s+/g, '').toUpperCase())
    if (index === undefined) return json({ data: [], pagination: { nextStartAt: null } })
    return json(historyFor(index, Number(url.searchParams.get('max'))))
  }
  // The paid tier, entered the way a returning reader does: a token and an entitled /api/me.
  if (url.pathname === '/api/me') {
    return json({ entitled: true, address: SEED, paidUntil: Date.now() + 21 * DAY, daysLeft: 21 })
  }
  return json({ data: [] })
})
await context.addInitScript(() => window.localStorage.setItem('chainmap.token', 'perf-token'))

const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
await page.goto(`${BASE}/graph/`, { waitUntil: 'domcontentloaded' })
await page.locator('astro-island[component-export="NimMap"]:not([ssr])').waitFor({ state: 'attached', timeout: 15000 })
await page.locator('[data-nimmap-tier="paid"]').waitFor({ timeout: 15000 })

/** Count animation frames for `ms`, and report the rate and the worst single frame. */
async function sample(ms) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const stamps = []
        const start = performance.now()
        const tick = (now) => {
          stamps.push(now)
          if (now - start < duration) requestAnimationFrame(tick)
          else {
            const span = stamps[stamps.length - 1] - stamps[0]
            let worst = 0
            for (let i = 1; i < stamps.length; i++) worst = Math.max(worst, stamps[i] - stamps[i - 1])
            resolve({ fps: ((stamps.length - 1) / span) * 1000, frames: stamps.length, worst })
          }
        }
        requestAnimationFrame(tick)
      }),
    ms,
  )
}

async function scanAndSample(depth) {
  const clear = page.locator('[data-nimmap-clear]')
  if (await clear.count()) {
    await clear.click()
    await page.locator('[data-nimmap-counts]').waitFor({ state: 'detached', timeout: 15000 })
  }
  await page.locator('[data-nimmap-input]').fill(SEED)
  await page.locator(`[data-nimmap-depth="${depth}"]`).click()
  // Sampling starts with the click, not after it: the first second, with the layout
  // hottest and every arrowhead being re-laid-out, is the part that can drop frames.
  const [measure] = await Promise.all([sample(4000), page.locator('[data-nimmap-scan]').click()])
  await page.locator('[data-nimmap-counts]').waitFor({ state: 'visible', timeout: 30000 })
  return measure
}

/** Drag the settled map in a circle — a full repaint per frame, no simulation. */
async function panAndSample() {
  const canvas = page.locator('canvas[data-nimmap-canvas]')
  await canvas.scrollIntoViewIfNeeded()
  // Reset first. Each pan leaves the camera a few hundred pixels off, and a run that
  // starts with half the map already off-screen draws less and looks faster — exactly
  // the run best-of would pick, which would hide the regression this is here to catch.
  await page.getByRole('button', { name: 'Reset' }).click()
  await page.waitForTimeout(1200)
  const box = await canvas.boundingBox()
  const viewport = page.viewportSize()
  // Start in the top-left corner: the map is fitted with padding, so the corner is
  // empty and the drag pans the view rather than pulling one address out of the pile.
  // Clamped below the 64px sticky header, which would otherwise swallow the press.
  const cx = box.x + 40
  const cy = Math.max(box.y + 40, 100)
  const reach = Math.min(160, (viewport.height - cy) / 2, box.width / 4)
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  const measure = sample(3000)
  const until = Date.now() + 3000
  for (let i = 0; Date.now() < until; i++) {
    const angle = i * 0.12
    await page.mouse.move(cx + (1 + Math.cos(angle)) * reach, cy + (1 + Math.sin(angle)) * reach)
  }
  await page.mouse.up()
  return measure
}

async function setMode(mode) {
  const legend = page.locator('[data-nimmap-legend]')
  if (!(await legend.count())) await page.locator('[data-nimmap-legend-toggle]').click()
  await legend.locator(`[data-nimmap-colorby="${mode}"]`).click()
  await page.locator(`[data-nimmap-colormode="${mode}"]`).waitFor({ timeout: 5000 })
}

// --- the runs --------------------------------------------------------------

/** The fastest of `count` runs — see SCAN_RUNS. */
async function best(count, run) {
  let winner = null
  for (let i = 0; i < count; i++) {
    const measure = await run()
    if (!winner || measure.fps > winner.fps) winner = measure
  }
  return winner
}

const results = []
for (const mode of ['type', 'age']) {
  // The legend only exists once there is a map to explain, so the first run takes the
  // component's default — which is what `type` is — and the second switches before its
  // own scan. The mode is component state: it survives Clear and the next scan.
  if (await page.locator('[data-nimmap-legend], [data-nimmap-legend-toggle]').count()) {
    await setMode(mode)
  }
  const scan = await best(SCAN_RUNS, () => scanAndSample(3))
  const counts = (await page.locator('[data-nimmap-counts]').innerText()).replace(/\s+/g, ' ')
  const drawnAs = await page.locator('[data-nimmap-colormode]').getAttribute('data-nimmap-colormode')
  assert(drawnAs === mode, `the map was measured colouring by ${mode} (canvas says ${drawnAs})`)
  const pan = await best(PAN_RUNS, panAndSample)
  results.push({ mode, counts, scan, pan })
}

console.log(`\n  best of ${SCAN_RUNS} scans and ${PAN_RUNS} pans, rAF ceiling 60 fps`)
for (const { mode, counts, scan, pan } of results) {
  console.log(`  colour by ${mode.padEnd(5)} · ${counts}`)
  console.log(`    scan  ${scan.fps.toFixed(1)} fps over ${scan.frames} frames (worst frame ${scan.worst.toFixed(1)}ms)`)
  console.log(`    pan   ${pan.fps.toFixed(1)} fps over ${pan.frames} frames (worst frame ${pan.worst.toFixed(1)}ms)`)
}
console.log('')

for (const { mode, scan, pan } of results) {
  assert(scan.fps >= MIN_FPS, `colour by ${mode}: the scan holds ${scan.fps.toFixed(1)} fps (>= ${MIN_FPS})`)
  assert(pan.fps >= MIN_FPS, `colour by ${mode}: panning holds ${pan.fps.toFixed(1)} fps (>= ${MIN_FPS})`)
}
// The two modes differ only in which colour a batch gets, so neither may be the slow one.
const spread = Math.abs(results[0].pan.fps - results[1].pan.fps)
assert(spread < 8, `the two colour modes cost the same to draw (${spread.toFixed(1)} fps apart)`)
assert(errors.length === 0, `no uncaught page errors (${errors.join(' | ')})`)

console.log(`\n${passed} passed, ${failed} failed`)
await browser.close()
process.exit(failed > 0 ? 1 : 0)
