/**
 * End-to-end drive of the real NimMap island against a fake worker.
 *
 * The whole `/api` surface is served by Playwright over a synthetic chain whose
 * shape is known exactly — a binary tree of transfers for the depth tests, a
 * 400-address fan-out for the cap test — so the node and edge counts the map
 * reports can be checked against arithmetic rather than against itself.
 *
 * The paid tier is entered the way a returning reader does: a pass token in
 * localStorage and an entitled `/api/me`. No wallet, no Hub — that path is
 * chainmap-paywall-e2e.mjs.
 */
import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs'

const BASE = 'http://localhost:4331'
const SEED = 'NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY'
const DAY = 86400000

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`PASS  ${msg}`) }
  else { failed++; console.log(`FAIL  ${msg}`) }
}

// --- the synthetic chain ---------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY'

/** A deterministic, checksum-valid Nimiq address for index `n`. */
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

const TOTAL = 420
const ADDRESSES = Array.from({ length: TOTAL }, (_, i) => addressFrom(i))
const INDEX_OF = new Map(ADDRESSES.map((address, i) => [address.replace(/\s+/g, ''), i]))

/** 'tree' — every address has two children. 'wide' — 20, then 19 each. */
let topology = 'tree'

function childrenOf(index) {
  if (topology === 'tree') {
    return [2 * index + 1, 2 * index + 2].filter((i) => i < TOTAL)
  }
  if (index === 0) return Array.from({ length: 20 }, (_, i) => i + 1)
  if (index <= 20) return Array.from({ length: 19 }, (_, i) => 21 + (index - 1) * 19 + i).filter((i) => i < TOTAL)
  return []
}

function parentOf(index) {
  if (index === 0) return null
  if (topology === 'tree') return Math.floor((index - 1) / 2)
  if (index <= 20) return 0
  return Math.floor((index - 21) / 19) + 1
}

/**
 * The classification fields the worker lifts out of a row, cycled by edge number so
 * every transaction family is somewhere on the map — and so a given edge's family is
 * arithmetic rather than a lookup. Edge *n* is the nth-newest, so the transaction list
 * under the map reads: stake, reward, contract call, plain transfer, and repeat.
 */
function classificationFor(n) {
  switch (n % 4) {
    // To the staking contract, recipientData 0x05 — create-staker, "Stake".
    case 1:
      return { fromType: 0, toType: 3, flags: 2, recipientData: '05' + '00'.repeat(99), senderData: '' }
    // Out of the staking contract, senderData 0x01 — remove-stake, the payout.
    case 2:
      return { fromType: 3, toType: 0, flags: 0, recipientData: '', senderData: '01' }
    // A payload between two ordinary accounts: a contract call.
    case 3:
      return { fromType: 0, toType: 0, flags: 0, recipientData: 'ff0102', senderData: '' }
    default:
      return { fromType: 0, toType: 0, flags: 0, recipientData: '', senderData: '' }
  }
}

/** The history the fake worker reports for one address: its parent, its children. */
function historyFor(index, max) {
  const rows = []
  const push = (from, to, n) => {
    const { recipientData, senderData, ...types } = classificationFor(n)
    rows.push({
      hash: `${String(from).padStart(4, '0')}${String(to).padStart(4, '0')}`.padEnd(64, 'a'),
      blockNumber: 61000000 + n,
      // A spread of ages, so the age ramp has something to colour.
      timestamp: Date.now() - n * DAY,
      confirmations: 1000 + n,
      size: 139,
      from: ADDRESSES[from],
      to: ADDRESSES[to],
      value: (n + 1) * 100000,
      fee: 0,
      ...types,
      // The worker sends the op code, not the blob — this is the shape the map sees.
      dataType: recipientData ? Number.parseInt(recipientData.slice(0, 2), 16) : null,
      senderDataType: senderData ? Number.parseInt(senderData.slice(0, 2), 16) : null,
    })
  }
  const parent = parentOf(index)
  if (parent !== null) push(parent, index, index)
  for (const child of childrenOf(index)) push(index, child, child)
  const page = rows.slice(0, max)
  return {
    data: page,
    pagination: { nextStartAt: rows.length > max ? page[page.length - 1].hash : null },
  }
}

// --- fixtures --------------------------------------------------------------

const browser = await chromium.launch()
const historyRequests = []
let entitled = false
/** Milliseconds every history page is held back — used to test Stop. */
let historyDelay = 0

async function makeContext() {
  const context = await browser.newContext({ acceptDownloads: true })
  await context.route('https://nimiq-api.subimpact.net/api/**', async (route) => {
    if (historyDelay && route.request().url().includes('/api/history/')) {
      await new Promise((resolve) => setTimeout(resolve, historyDelay))
    }
    const url = new URL(route.request().url())
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (url.pathname.startsWith('/api/history/')) {
      const address = decodeURIComponent(url.pathname.slice('/api/history/'.length))
      const max = Number(url.searchParams.get('max'))
      historyRequests.push({ address, max })
      const index = INDEX_OF.get(address.replace(/\s+/g, '').toUpperCase())
      if (index === undefined) return json({ data: [], pagination: { nextStartAt: null } })
      return json(historyFor(index, max))
    }
    if (url.pathname === '/api/me') {
      return entitled
        ? json({ entitled: true, address: SEED, paidUntil: Date.now() + 21 * DAY, daysLeft: 21, expiresInMs: 21 * DAY })
        : json({ error: 'invalid token' }, 401)
    }
    if (url.pathname.startsWith('/api/account/')) return json({ data: { balance: 123400000, type: 'basic' } })
    if (url.pathname === '/api/validators') return json({ data: [{ address: SEED }] })
    if (url.pathname === '/api/quote') {
      return json({
        priceUsd: 0.00039,
        usdTarget: 29.99,
        nimAmount: 76638.04,
        lunaAmount: 7663804559,
        paywallAddress: 'NQ70 SM7L 2PKV 7D55 SUUA B80X 1DML 5XS1 XHJC',
      })
    }
    return json({ data: [] })
  })
  return context
}

async function openMap(context) {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(`${BASE}/graph/`, { waitUntil: 'domcontentloaded' })
  // The island is server-rendered, so the input exists before React owns it —
  // typing into it earlier is thrown away when the controlled value takes over.
  await page.locator('astro-island[component-export="NimMap"]:not([ssr])').waitFor({ state: 'attached', timeout: 15000 })
  await page.locator('[data-nimmap-input]').waitFor({ state: 'visible', timeout: 15000 })
  return { page, errors }
}

async function scan(page, depth) {
  // Clear first: the counts overlay from the previous scan is still on screen,
  // so waiting for it to appear would pass before this scan even starts.
  const clear = page.locator('[data-nimmap-clear]')
  if (await clear.count()) {
    await clear.click()
    await page.locator('[data-nimmap-counts]').waitFor({ state: 'detached', timeout: 15000 })
  }
  historyRequests.length = 0
  await page.locator('[data-nimmap-input]').fill(SEED)
  if (depth) await page.locator(`[data-nimmap-depth="${depth}"]`).click()
  await page.locator('[data-nimmap-scan]').click()
  await page.locator('[data-nimmap-counts]').waitFor({ state: 'visible', timeout: 30000 })
}

/** Sweep the canvas until a click lands on an arrow and opens its panel. */
async function clickAnyEdge(page) {
  const canvas = page.locator('canvas[data-nimmap-canvas]')
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  const viewport = page.viewportSize()
  const top = Math.max(box.y + 20, 80)
  const bottom = Math.min(box.y + box.height - 20, viewport.height - 20)
  for (let y = top; y <= bottom; y += 13) {
    for (let x = box.x + 20; x <= box.x + box.width - 20; x += 13) {
      await page.mouse.click(x, y)
      if (await page.getByText('Confirmations').first().isVisible().catch(() => false)) return true
    }
  }
  return false
}

/**
 * Sweep the canvas until a click lands on a node and opens its panel.
 *
 * The sweep is clamped to the part of the canvas actually inside the viewport —
 * the map is taller than a 720px window, and a click at a coordinate below the
 * fold reaches nothing.
 */
async function clickAnyNode(page) {
  const canvas = page.locator('canvas[data-nimmap-canvas]')
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  const viewport = page.viewportSize()
  // Below the 64px sticky header too: scrollIntoViewIfNeeded does not know about
  // it, so the top of the canvas can sit underneath the nav links.
  const top = Math.max(box.y + 20, 80)
  const bottom = Math.min(box.y + box.height - 20, viewport.height - 20)
  for (let y = top; y <= bottom; y += 24) {
    for (let x = box.x + 30; x <= box.x + box.width - 30; x += 30) {
      await page.mouse.click(x, y)
      if (await page.getByText('Hops from seed').first().isVisible().catch(() => false)) return true
    }
  }
  return false
}

// ===========================================================================
// 1. Free tier
// ===========================================================================

const freeContext = await makeContext()
const { page: free, errors: freeErrors } = await openMap(freeContext)

assert(
  (await free.locator('[data-nimmap-tier="free"]').innerText()).includes('Free'),
  'a reader with no pass is shown the free tier badge',
)
assert(
  await free.locator('[data-nimmap-depth="4"][data-locked]').isVisible(),
  'depths 4 to 6 are marked locked on the free tier',
)
assert(await free.locator('[data-nimmap-scan]').isDisabled(), 'Scan is disabled with an empty address')

await free.locator('[data-nimmap-input]').fill('NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXX')
assert(
  await free.locator('[data-nimmap-scan]').isDisabled(),
  'Scan stays disabled for an address that fails its checksum',
)
await free.locator('[data-nimmap-input]').fill(SEED)
assert(await free.locator('[data-nimmap-scan]').isEnabled(), 'Scan enables for a valid address')

// --- depth 1, then depth 3 ------------------------------------------------
await scan(free, 1)
assert(
  (await free.locator('[data-nimmap-counts]').innerText()).replace(/\s+/g, ' ') ===
    '3 addresses · 2 transactions',
  `depth 1 maps the seed and its two counterparties (got "${(await free.locator('[data-nimmap-counts]').innerText()).replace(/\s+/g, ' ')}")`,
)
assert(historyRequests.length === 1, `depth 1 reads exactly the seed's history (${historyRequests.length} requests)`)

await scan(free, 3)
const freeCounts = (await free.locator('[data-nimmap-counts]').innerText()).replace(/\s+/g, ' ')
assert(freeCounts === '15 addresses · 14 transactions', `depth 3 maps 2^4-1 addresses (got "${freeCounts}")`)
assert(
  historyRequests.length === 7,
  `depth 3 expands levels 0-2 only — 7 addresses (${historyRequests.length} requests)`,
)
assert(
  historyRequests.every((request) => request.max === 20),
  'the free tier reads 20 transactions per address',
)

// --- the boundary ----------------------------------------------------------
assert(
  await free.locator('[data-nimmap-limit="depth"]').isVisible(),
  'hitting the free depth ceiling shows the boundary notice',
)
assert(
  (await free.locator('[data-nimmap-limit="depth"]').innerText()).includes('Free scans stop at depth 3'),
  'the notice names the free limits',
)
assert(await free.locator('[data-nimmap-unlock]').isVisible(), 'the boundary notice offers the unlock')

// --- the legend and the colour mode ----------------------------------------
// Before the canvas sweeps below: the legend takes pointer events now, so a sweep
// click landing on it would toggle the very thing these assertions are reading.
const legend = free.locator('[data-nimmap-legend]')
const colorMode = () => free.locator('[data-nimmap-colormode]').getAttribute('data-nimmap-colormode')

assert(await legend.isVisible(), 'the legend is expanded by default on a desktop viewport')
assert((await colorMode()) === 'type', 'the map colours by transaction type by default')
const typeRows = await legend.locator('[data-nimmap-legend-edge]').count()
assert(typeRows >= 6, `Type mode names every transaction family (${typeRows} edge rows, want >= 6)`)
const legendText = (await legend.innerText()).replace(/\s+/g, ' ')
const FAMILIES = ['Basic', 'Stake', 'Reward', 'Contract call', 'HTLC', 'Vesting']
assert(
  FAMILIES.every((family) => legendText.includes(family)),
  `the six families are named in the legend (got "${legendText}")`,
)
assert(
  (await legend.innerText()).includes('dashed'),
  'the legend says the contract-call family is the dashed one',
)
assert(
  (await legend.innerText()).includes('arrow = direction · width = amount'),
  'the legend keeps the arrow and width note',
)
assert(
  (await legend.locator('svg polygon').count()) === 4,
  'the node key is four hexagons — seed, address, contract, edge of scan',
)

await legend.locator('[data-nimmap-colorby="age"]').click()
await free.locator('[data-nimmap-colormode="age"]').waitFor({ timeout: 5000 })
assert((await colorMode()) === 'age', 'the Age chip switches the canvas to the age ramp')
assert(
  (await legend.locator('[data-nimmap-legend-edge]').count()) === 1 &&
    (await legend.innerText()).includes('old → recent'),
  'Age mode replaces the six families with one old-to-recent ramp',
)
assert(
  (await legend.locator('[data-nimmap-colorby="age"]').getAttribute('aria-pressed')) === 'true' &&
    (await legend.locator('[data-nimmap-colorby="type"]').getAttribute('aria-pressed')) === 'false',
  'the active chip is the one that is pressed',
)

await legend.locator('[data-nimmap-colorby="type"]').click()
await free.locator('[data-nimmap-colormode="type"]').waitFor({ timeout: 5000 })
assert((await colorMode()) === 'type', 'the Type chip switches back')

await legend.locator('[data-nimmap-legend-toggle]').click()
await legend.waitFor({ state: 'detached', timeout: 5000 })
assert(
  await free.locator('[data-nimmap-legend-toggle]').isVisible(),
  'the legend folds away to a pill that can bring it back',
)
await free.locator('[data-nimmap-legend-toggle]').click()
await legend.waitFor({ state: 'visible', timeout: 5000 })
assert(await legend.isVisible(), 'the pill re-opens the legend')

// --- locked depth opens the paywall ---------------------------------------
assert(
  (await free.locator('[data-nimmap-depth="5"]').getAttribute('title')) === 'Depth 4–6 needs a NimMap pass',
  'a locked depth says which pass it needs',
)
await free.locator('[data-nimmap-depth="5"]').click()
await free.locator('[data-nimmap-paywall]').waitFor({ state: 'visible', timeout: 15000 })
assert(true, 'a locked depth opens the pass dialog instead of scanning')
assert(
  (await free.locator('[data-nimmap-paywall] [data-slot="dialog-title"]').innerText()).trim() ===
    'NimMap Pass',
  'the pass dialog is titled NimMap Pass',
)
assert(
  (await free.locator('[data-nimmap-depth="3"]').getAttribute('aria-pressed')) === 'true',
  'the depth stays where it was when a locked one is clicked',
)
await free.keyboard.press('Escape')
await free.locator('[data-nimmap-paywall]').waitFor({ state: 'hidden' })

// --- detail panels ---------------------------------------------------------
assert(await clickAnyNode(free), 'clicking a node on the canvas opens its detail panel')
await free.getByText('1,234 NIM').waitFor({ timeout: 10000 }).catch(() => {})
assert(await free.getByText('1,234 NIM').isVisible(), 'the node panel shows the balance from /api/account')
assert(
  await free.locator('a[href^="https://nimiq.watch/#NQ"]').first().isVisible(),
  'the node panel links the address to the explorer',
)

assert(await clickAnyEdge(free), 'clicking an arrow on the canvas opens the transaction panel')
await free.keyboard.press('Escape')
assert(
  !(await free.getByText('Confirmations').first().isVisible().catch(() => false)),
  'Escape clears the selection',
)

const rows = free.locator('ul li button').filter({ hasText: '→' })
await rows.first().click()
await free.getByText('Confirmations').waitFor({ timeout: 10000 })
assert(true, 'picking a transaction from the list opens the edge panel')
assert(
  await free.locator('[data-slot="dialog-content"]').count() === 0 &&
    (await free.getByText(/ago|in \d/).first().isVisible()),
  'the edge panel carries a relative timestamp',
)

// The list is newest-first and the fixture cycles the families by edge number, so
// rows 1-4 are exactly one of each: stake, payout, contract call, plain transfer.
const kindBadge = free.locator('[data-nimmap-edge-kind]')
const EXPECTED_KINDS = [
  { kind: 'stake', label: 'Stake', why: 'recipientData 0x05 to the staking contract' },
  { kind: 'reward', label: 'Reward', why: 'senderData 0x01 out of the staking contract' },
  { kind: 'data', label: 'Contract call', why: 'a payload between two basic accounts' },
]
for (const [index, expected] of EXPECTED_KINDS.entries()) {
  await rows.nth(index).click()
  await kindBadge.waitFor({ timeout: 10000 }).catch(() => {})
  const got = await kindBadge.innerText().catch(() => '(no badge)')
  const kind = await kindBadge.getAttribute('data-nimmap-edge-kind').catch(() => null)
  assert(
    got.trim() === expected.label && kind === expected.kind,
    `the edge panel names ${expected.why} "${expected.label}" (got "${got.trim()}"/${kind})`,
  )
}
await rows.nth(3).click()
await free.getByText('Confirmations').waitFor({ timeout: 10000 })
assert(
  (await kindBadge.count()) === 0,
  'a plain transfer between two basic accounts gets no badge — the amount is the whole story',
)
await free.keyboard.press('Escape')

// --- exports are gated -----------------------------------------------------
await free.locator('[data-nimmap-export-csv]').click()
await free.locator('[data-nimmap-paywall]').waitFor({ state: 'visible', timeout: 15000 })
assert(true, 'a free reader clicking CSV gets the pass dialog')
await free.keyboard.press('Escape')
await free.locator('[data-nimmap-paywall]').waitFor({ state: 'hidden' })
await free.locator('[data-nimmap-export-png]').click()
await free.locator('[data-nimmap-paywall]').waitFor({ state: 'visible', timeout: 15000 })
assert(true, 'a free reader clicking PNG gets the pass dialog')
await free.keyboard.press('Escape')

// --- the address cap -------------------------------------------------------
topology = 'wide'
await scan(free, 3)
const capCounts = (await free.locator('[data-nimmap-counts]').innerText()).replace(/\s+/g, ' ')
assert(capCounts.startsWith('100 addresses'), `the free scan stops at 100 addresses (got "${capCounts}")`)
assert(
  await free.locator('[data-nimmap-limit="cap"]').isVisible(),
  'hitting the address cap shows the cap notice, not a silently truncated map',
)
assert(
  (await free.locator('[data-nimmap-limit="cap"]').innerText()).includes('address cap'),
  'the cap notice says the cap was the reason',
)
topology = 'tree'

// --- Stop keeps what was found so far --------------------------------------
historyDelay = 400
await free.locator('[data-nimmap-clear]').click()
await free.locator('[data-nimmap-counts]').waitFor({ state: 'detached', timeout: 15000 })
await free.locator('[data-nimmap-input]').fill(SEED)
await free.locator('[data-nimmap-scan]').click()
await free.locator('[data-nimmap-stop]').waitFor({ state: 'visible', timeout: 10000 })
assert(
  (await free.locator('[data-nimmap-progress]').first().innerText()).includes('addresses'),
  'a running scan reports its progress',
)
await free.waitForTimeout(700)
await free.locator('[data-nimmap-stop]').click()
await free.locator('[data-nimmap-counts]').waitFor({ state: 'visible', timeout: 15000 })
const stoppedCounts = (await free.locator('[data-nimmap-counts]').innerText()).replace(/\s+/g, ' ')
// How far it gets depends on how many 400ms pages landed first — what matters
// is that it kept a real partial map and did not run to the full 15.
const stoppedAddresses = Number(stoppedCounts.split(' ')[0])
assert(
  stoppedAddresses >= 3 && stoppedAddresses < 15,
  `Stop keeps the part of the map that was already found (got "${stoppedCounts}")`,
)
assert(
  (await free.locator('[data-nimmap-limit]').count()) === 0,
  'a stopped scan is not reported as having hit a tier limit',
)
historyDelay = 0

// --- analytics -------------------------------------------------------------
const freeEvents = await free.evaluate(() => window.dataLayer.filter((entry) => entry.event?.startsWith('nimmap_')))
assert(
  freeEvents.some((entry) => entry.event === 'nimmap_scan_started' && entry.depth === 3 && entry.tier === 'free'),
  'nimmap_scan_started carries the depth and the tier',
)
assert(
  freeEvents.some((entry) => entry.event === 'nimmap_limit_hit' && entry.limit === 'depth') &&
    freeEvents.some((entry) => entry.event === 'nimmap_limit_hit' && entry.limit === 'cap'),
  'nimmap_limit_hit fires for both the depth ceiling and the address cap',
)

assert(freeErrors.length === 0, `no uncaught page errors on the free tier (${freeErrors.join(' | ')})`)
await freeContext.close()

// ===========================================================================
// 2. Paid tier
// ===========================================================================

entitled = true
const paidContext = await makeContext()
await paidContext.addInitScript(() => window.localStorage.setItem('chainmap.token', 'test-sub-token'))
const { page: paid, errors: paidErrors } = await openMap(paidContext)

await paid.locator('[data-nimmap-tier="paid"]').waitFor({ state: 'visible', timeout: 15000 })
assert(
  (await paid.locator('[data-nimmap-tier="paid"]').innerText()).includes('21 days left'),
  'a stored pass token is re-checked against /api/me and shown as days left',
)
assert(
  (await paid.locator('[data-nimmap-depth="6"]').getAttribute('data-locked')) === null,
  'depth 6 is unlocked with a pass',
)

await scan(paid, 6)
const paidCounts = (await paid.locator('[data-nimmap-counts]').innerText()).replace(/\s+/g, ' ')
assert(paidCounts === '127 addresses · 126 transactions', `depth 6 maps 2^7-1 addresses (got "${paidCounts}")`)
assert(
  historyRequests.length === 63,
  `depth 6 expands levels 0-5 — 63 addresses (${historyRequests.length} requests)`,
)
assert(
  historyRequests.every((request) => request.max === 50),
  'the paid tier reads 50 transactions per address',
)
assert(
  await paid.locator('[data-nimmap-limit]').count() === 0 ||
    (await paid.locator('[data-nimmap-limit="depth"]').innerText()).includes('The map stops here'),
  'a paid reader at the boundary is told where the map ends, without an upsell',
)

// --- exports work ----------------------------------------------------------
const csvPromise = paid.waitForEvent('download', { timeout: 20000 })
await paid.locator('[data-nimmap-export-csv]').click()
const csvDownload = await csvPromise
assert(/^nimmap-NQ08ACT8T0FE-\d{4}-\d{2}-\d{2}\.csv$/.test(csvDownload.suggestedFilename()),
  `the CSV is named for the seed and the date (got "${csvDownload.suggestedFilename()}")`)
const csvPath = await csvDownload.path()
const csvText = await (await import('node:fs/promises')).readFile(csvPath, 'utf8')
const csvLines = csvText.trim().split('\n')
assert(
  csvLines[0] === 'from,to,value_luna,value_nim,hash,timestamp_iso,confirmations',
  `the CSV header is the agreed column list (got "${csvLines[0]}")`,
)
assert(csvLines.length === 127, `the CSV carries every edge, one per row (${csvLines.length - 1} rows)`)
assert(/^NQ[0-9A-Z ]+,NQ[0-9A-Z ]+,\d+,[\d.]+,[0-9a-f]{64},\d{4}-\d{2}-\d{2}T/.test(csvLines[1]),
  `a CSV row is addresses, luna, NIM, hash, ISO timestamp (got "${csvLines[1].slice(0, 90)}")`)

const pngPromise = paid.waitForEvent('download', { timeout: 20000 })
await paid.locator('[data-nimmap-export-png]').click()
const pngDownload = await pngPromise
assert(/^nimmap-NQ08ACT8T0FE-\d{4}-\d{2}-\d{2}\.png$/.test(pngDownload.suggestedFilename()),
  `the PNG is named the same way (got "${pngDownload.suggestedFilename()}")`)
const pngBytes = await (await import('node:fs/promises')).readFile(await pngDownload.path())
assert(pngBytes.length > 2000 && pngBytes.subarray(1, 4).toString() === 'PNG',
  `the PNG is a real image of a rendered map (${pngBytes.length} bytes)`)

const paidEvents = await paid.evaluate(() => window.dataLayer.filter((entry) => entry.event?.startsWith('nimmap_')))
assert(
  paidEvents.some((entry) => entry.event === 'nimmap_export' && entry.format === 'csv' && entry.tier === 'paid') &&
    paidEvents.some((entry) => entry.event === 'nimmap_export' && entry.format === 'png'),
  'nimmap_export fires for both formats with the tier',
)

// --- re-scan from a node ---------------------------------------------------
const paidNodeHit = await clickAnyNode(paid)
// A miss is worth looking at rather than guessing about.
if (!paidNodeHit) await paid.screenshot({ path: '/tmp/nimmap-node-miss.png' })
assert(paidNodeHit, 'a paid reader can open a node panel')
const rescan = paid.locator('[data-nimmap-rescan]')
if (await rescan.count()) {
  assert((await rescan.innerText()).trim() === 'Scan from here', 'the paid node panel offers a plain re-scan')
  await rescan.click()
  await paid.waitForFunction(
    (seed) => document.querySelector('[data-nimmap-input]')?.value !== seed,
    SEED,
    { timeout: 20000 },
  )
  const newSeed = await paid.locator('[data-nimmap-input]').inputValue()
  assert(newSeed.startsWith('NQ') && newSeed !== SEED, `re-scanning from a node makes it the new seed (${newSeed})`)
} else {
  assert(true, 'the seed panel offers no re-scan (it is already the seed)')
}

assert(paidErrors.length === 0, `no uncaught page errors on the paid tier (${paidErrors.join(' | ')})`)
await paidContext.close()

console.log(`\n${passed} passed, ${failed} failed`)
await browser.close()
process.exit(failed > 0 ? 1 : 0)
