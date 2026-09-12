/**
 * The NimMap pass, end to end: wallet → signature → payment → unlocked.
 *
 * As in stake-e2e.mjs, hub.nimiq.com is served by Playwright as a page speaking
 * the same postMessage RPC the real Hub does, so HubApi, the popup handshake and
 * the request/response shapes all run unmodified. The worker is mocked, and what
 * the dialog *sends* it is asserted: the claimed address, the hex-encoded public
 * key and signature, and the nonce it was challenged with.
 */
import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs'

const BASE = 'http://localhost:4331'
const WALLET = 'NQ27 NCB1 3CYU 9P4L EM2V D7L2 28QE 36PA EXB1'
const PAYWALL = 'NQ70 SM7L 2PKV 7D55 SUUA B80X 1DML 5XS1 XHJC'
const REQUIRED_LUNA = 7663804559
const DAY = 86400000

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`PASS  ${msg}`) }
  else { failed++; console.log(`FAIL  ${msg}`) }
}

// Deterministic "signature": the bytes never have to verify, because the worker
// that would verify them is the thing being mocked. What matters is that the
// dialog hex-encodes exactly what the Hub handed it.
const PUBLIC_KEY_HEX = Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, '0')).join('')
const SIGNATURE_HEX = Array.from({ length: 64 }, (_, i) => ((i * 3 + 7) % 256).toString(16).padStart(2, '0')).join('')

const HUB_PAGE = `<!doctype html><html><body><script>
  window.addEventListener('message', function (event) {
    var data = event.data || {}
    if (!data.command) return
    function reply(result) {
      event.source.postMessage({ status: 'ok', result: result, id: data.id }, '*')
    }
    if (data.command === 'ping') return reply('pong')
    if (data.command === 'choose-address') {
      return reply({ address: ${JSON.stringify(WALLET)}, label: 'Test wallet' })
    }
    if (data.command === 'sign-message') {
      var request = data.args[0]
      var key = new Uint8Array(32)
      for (var i = 0; i < 32; i++) key[i] = i + 1
      var sig = new Uint8Array(64)
      for (var j = 0; j < 64; j++) sig[j] = (j * 3 + 7) % 256
      // The popup closes as soon as this resolves, so what was asked for is
      // reported out through a route the test intercepts.
      fetch('https://hub.nimiq.com/__record', {
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({ appName: request.appName, signer: request.signer, message: request.message }),
      }).then(function () {
        reply({ signer: request.signer || ${JSON.stringify(WALLET)}, signerPublicKey: key, signature: sig })
      })
      return
    }
  })
</script></body></html>`

const browser = await chromium.launch()

/**
 * One browser context with the Hub and the worker mocked.
 * `worker` decides what /api/auth/verify, /api/entitlement and /api/me answer.
 */
async function openMap({ worker = {}, token = null } = {}) {
  const context = await browser.newContext()
  const hubRequests = []
  const verifyRequests = []
  const entitlementRequests = []
  let nonceCount = 0
  let entitlementCalls = 0

  await context.route('https://hub.nimiq.com/**', (route) => {
    if (route.request().url().endsWith('/__record')) {
      hubRequests.push(JSON.parse(route.request().postData() || '{}'))
      return route.fulfill({ status: 204, body: '' })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: HUB_PAGE })
  })

  await context.route('https://nimiq-api.subimpact.net/api/**', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (url.pathname === '/api/auth/nonce') {
      nonceCount++
      const nonce = `nonce-${nonceCount}`
      return json({
        nonce,
        message: `nimiq.subimpact.net NimMap sign-in\nnonce: ${nonce}`,
        expiresInMs: 600000,
      })
    }
    if (url.pathname === '/api/auth/verify') {
      verifyRequests.push({
        body: JSON.parse(request.postData() || '{}'),
        method: request.method(),
      })
      const answer = worker.verify ?? { entitled: false, reason: 'no_payment' }
      if (answer.status) return json(answer.body, answer.status)
      return json({
        ok: true,
        authToken: 'auth-token-1',
        requiredLuna: REQUIRED_LUNA,
        priceUsd: 29.99,
        paywallAddress: PAYWALL,
        ...answer,
      })
    }
    if (url.pathname === '/api/entitlement') {
      entitlementCalls++
      entitlementRequests.push({
        authorization: request.headers()['authorization'] ?? null,
        body: request.postData(),
      })
      const paidOn = worker.entitledOnCall ?? Infinity
      if (entitlementCalls < paidOn) {
        return json({ entitled: false, reason: 'no_payment', requiredLuna: REQUIRED_LUNA, priceUsd: 29.99 })
      }
      return json({
        entitled: true,
        address: WALLET,
        paidUntil: Date.now() + 30 * DAY,
        daysLeft: 30,
        token: 'sub-token-1',
        requiredLuna: REQUIRED_LUNA,
        priceUsd: 29.99,
      })
    }
    if (url.pathname === '/api/me') {
      const answer = worker.me
      if (!answer) return json({ error: 'invalid token' }, 401)
      if (answer.status) return json(answer.body, answer.status)
      return json(answer)
    }
    if (url.pathname === '/api/quote') {
      return json({
        priceUsd: 0.00039,
        usdTarget: 29.99,
        nimAmount: REQUIRED_LUNA / 1e5,
        lunaAmount: REQUIRED_LUNA,
        paywallAddress: PAYWALL,
      })
    }
    if (url.pathname.startsWith('/api/history/')) return json({ data: [], pagination: { nextStartAt: null } })
    return json({ data: [] })
  })

  if (token) await context.addInitScript((value) => window.localStorage.setItem('chainmap.token', value), token)

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  // Subscribed before the navigation, not after it. A stored token is checked during
  // hydration, and hydration is what the two waits below are waiting for — so a caller
  // that asked for /api/me afterwards was racing an event that had usually already
  // fired, and lost about two runs in three.
  const meAnswered = token
    ? page.waitForResponse((response) => response.url().includes('/api/me'), { timeout: 20000 })
    : Promise.resolve(null)
  await page.goto(`${BASE}/graph/`, { waitUntil: 'domcontentloaded' })
  // Wait for the island to own the DOM before touching its controls.
  await page.locator('astro-island[component-export="NimMap"]:not([ssr])').waitFor({ state: 'attached', timeout: 15000 })
  await page.locator('[data-nimmap-input]').waitFor({ state: 'visible', timeout: 15000 })
  return { context, page, errors, meAnswered, hubRequests, verifyRequests, entitlementRequests }
}

async function signIn(page) {
  await page.locator('[data-nimmap-tier]').click()
  const dialog = page.locator('[data-nimmap-paywall]')
  await dialog.waitFor({ state: 'visible', timeout: 15000 })
  await dialog.locator('[data-nimmap-connect]').click()
  await dialog.locator('[data-nimmap-sign]').waitFor({ state: 'visible', timeout: 20000 })
  await dialog.locator('[data-nimmap-sign]').click()
  return dialog
}

// ===========================================================================
// 1. Sign in on a wallet that has already paid
// ===========================================================================
{
  const { context, page, errors, hubRequests, verifyRequests } = await openMap({
    worker: {
      verify: {
        entitled: true,
        address: WALLET,
        paidUntil: Date.now() + 30 * DAY,
        daysLeft: 30,
        token: 'sub-token-1',
      },
    },
  })

  await page.locator('[data-nimmap-tier]').click()
  const titleBefore = await page
    .locator('[data-nimmap-paywall] [data-slot="dialog-title"]')
    .innerText()
  assert(titleBefore.trim() === 'NimMap Pass', `the pass is called the NimMap Pass (got "${titleBefore.trim()}")`)
  await page.keyboard.press('Escape')
  await page.locator('[data-nimmap-paywall]').waitFor({ state: 'hidden' })

  const dialog = await signIn(page)
  await page.getByText('Your pass is active').waitFor({ timeout: 20000 })
  assert(true, 'a wallet that has already paid unlocks straight after signing')

  const hubRequest = hubRequests[0] ?? {}
  assert(hubRequest.appName === 'ImpactZero NimMap', `the Hub is told the app name (${hubRequest.appName})`)
  assert(
    typeof hubRequest.message === 'string' && hubRequest.message.includes('NimMap sign-in'),
    `the sentence the wallet is asked to sign names NimMap (${hubRequest.message})`,
  )
  assert(hubRequest.signer === WALLET, 'the Hub is asked to sign with the account that was chosen')
  assert(
    typeof hubRequest.message === 'string' && hubRequest.message.includes('nonce: nonce-1'),
    `what is signed is the sentence the worker issued (${hubRequest.message})`,
  )

  const verify = verifyRequests[0] ?? {}
  assert(verify.method === 'POST', '/api/auth/verify is a POST')
  assert(verify.body?.address === WALLET, 'the verify call claims the chosen address')
  assert(verify.body?.signerPublicKey === PUBLIC_KEY_HEX, 'the public key is hex-encoded from the Hub bytes')
  assert(verify.body?.signature === SIGNATURE_HEX, 'the signature is hex-encoded from the Hub bytes')
  assert(verify.body?.nonce === 'nonce-1', 'the verify call carries the nonce that was challenged')

  await dialog.getByRole('button', { name: 'Start mapping' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.locator('[data-nimmap-tier="paid"]').waitFor({ timeout: 10000 })
  assert(
    (await page.locator('[data-nimmap-tier="paid"]').innerText()).includes('30 days left'),
    'the tier badge switches to the pass with its days left',
  )
  assert(
    (await page.locator('[data-nimmap-depth="6"]').getAttribute('data-locked')) === null,
    'depth 6 unlocks in the controls',
  )
  assert(
    (await page.evaluate(() => window.localStorage.getItem('chainmap.token'))) === 'sub-token-1',
    'the pass token is kept for the next visit',
  )
  const events = await page.evaluate(() => window.dataLayer.filter((e) => e.event?.startsWith('nimmap_')))
  assert(
    events.some((e) => e.event === 'nimmap_signin_started'),
    'nimmap_signin_started fires when the wallet is asked for',
  )
  assert(
    events.some((e) => e.event === 'nimmap_unlock_success' && e.daysLeft === 30),
    'nimmap_unlock_success carries the days left',
  )
  assert(errors.length === 0, `no uncaught page errors (${errors.join(' | ')})`)
  await context.close()
}

// ===========================================================================
// 2. No payment yet → checkout, then "I've paid" finds it on the second check
// ===========================================================================
{
  const { context, page, errors, entitlementRequests } = await openMap({
    worker: { verify: { entitled: false, reason: 'no_payment' }, entitledOnCall: 2 },
  })

  const dialog = await signIn(page)
  await dialog.locator('[data-nimmap-check]').waitFor({ timeout: 20000 })
  assert(true, 'a wallet with no payment lands on the checkout step')
  assert(
    (await dialog.locator('[data-nimmap-amount]').innerText()).trim() === '76,639 NIM',
    `the amount to send is the required luna, rounded up (got "${(await dialog.locator('[data-nimmap-amount]').innerText()).trim()}")`,
  )
  assert(
    (await dialog.innerText()).includes('$29.99'),
    'the checkout names the dollar price the amount is derived from',
  )
  assert(
    (await dialog.innerText()).includes(PAYWALL),
    'the checkout shows the pass address to send to',
  )
  assert(
    (await dialog.innerText()).includes('the wallet you just signed with'),
    'the checkout says which wallet the payment has to come from',
  )

  const checkoutEvents = await page.evaluate(() =>
    window.dataLayer.filter((e) => e.event === 'nimmap_checkout_viewed'),
  )
  assert(
    checkoutEvents.some((e) => e.requiredLuna === REQUIRED_LUNA && e.priceUsd === 29.99),
    'nimmap_checkout_viewed carries the amount and the price',
  )

  await dialog.locator('[data-nimmap-check]').click()
  assert(
    (await dialog.innerText()).includes('Waiting for the network to confirm'),
    'the first check that finds nothing says it is waiting for the network',
  )
  await page.getByText('Your pass is active').waitFor({ timeout: 40000 })
  assert(true, 'a payment found on a later poll unlocks the pass')
  assert(
    entitlementRequests.length === 2 && entitlementRequests.every((r) => r.authorization === 'Bearer auth-token-1'),
    `every payment check carries the auth token from sign-in (${entitlementRequests.length} calls)`,
  )
  assert(
    entitlementRequests.every((r) => !r.body),
    'the payment check sends no body — the address comes from the token',
  )

  const paymentEvents = await page.evaluate(() =>
    window.dataLayer.filter((e) => e.event === 'nimmap_payment_check'),
  )
  assert(
    paymentEvents.length === 2 && paymentEvents[0].found === false && paymentEvents[1].found === true,
    'nimmap_payment_check records each attempt and whether it found the payment',
  )

  await page.locator('[data-nimmap-tier="paid"]').waitFor({ timeout: 10000 })
  assert(true, 'the badge shows the pass once the payment lands')
  assert(errors.length === 0, `no uncaught page errors (${errors.join(' | ')})`)
  await context.close()
}

// ===========================================================================
// 3. An underpayment is told what it is short of
// ===========================================================================
{
  const { context, page } = await openMap({
    worker: { verify: { entitled: false, reason: 'amount_too_low' } },
  })
  const dialog = await signIn(page)
  await dialog.locator('[data-nimmap-check]').waitFor({ timeout: 20000 })
  const text = await dialog.innerText()
  assert(
    text.includes('below the pass price') && text.includes('76,639 NIM'),
    'an underpayment is named as one, with the price to reach',
  )
  await context.close()
}

// ===========================================================================
// 4. An expired pass on load asks to renew, not to connect
// ===========================================================================
{
  const { context, page } = await openMap({
    worker: { me: { entitled: false, reason: 'expired' } },
    token: 'old-sub-token',
  })

  await page.locator('[data-nimmap-tier="expired"]').waitFor({ timeout: 15000 })
  assert(true, 'a genuine token with a spent pass shows as expired rather than as free')
  assert(
    (await page.locator('[data-nimmap-tier="expired"]').innerText()).includes('renew'),
    'the expired badge offers to renew',
  )
  await page.locator('[data-nimmap-tier="expired"]').click()
  const dialog = page.locator('[data-nimmap-paywall]')
  await dialog.waitFor({ state: 'visible', timeout: 15000 })
  assert(
    (await dialog.innerText()).includes('previous pass has run out'),
    'the dialog explains the renewal instead of pitching the pass from scratch',
  )
  assert(
    (await dialog.innerText()).includes('76,639 NIM'),
    'the renewal quotes the current price up front',
  )
  await context.close()
}

// ===========================================================================
// 5. A token we did not sign is dropped; a rejected signature is explained
// ===========================================================================
{
  const { context, page, meAnswered } = await openMap({
    worker: { me: { status: 401, body: { error: 'invalid token' } } },
    token: 'tampered-token',
  })
  // The badge reads "Free" from the first paint, so waiting for it would prove
  // nothing — wait for the answer to /api/me instead.
  await meAnswered
  const cleared = await page
    .waitForFunction(() => window.localStorage.getItem('chainmap.token') === null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false)
  assert(cleared, 'a token the worker will not accept is cleared from storage')
  assert(
    await page.locator('[data-nimmap-tier="free"]').isVisible(),
    'a tampered pass token leaves the reader on the free tier',
  )
  await context.close()
}

{
  const { context, page } = await openMap({
    worker: { verify: { status: 401, body: { error: 'invalid signature' } } },
  })
  const dialog = await signIn(page)
  await dialog.locator('[data-nimmap-error]').waitFor({ timeout: 20000 })
  assert(
    (await dialog.locator('[data-nimmap-error]').innerText()).includes('signature did not check out'),
    'a rejected signature is explained as a signature problem',
  )
  await context.close()
}

{
  const { context, page } = await openMap({
    worker: { verify: { status: 401, body: { error: 'address mismatch' } } },
  })
  const dialog = await signIn(page)
  await dialog.locator('[data-nimmap-error]').waitFor({ timeout: 20000 })
  assert(
    (await dialog.locator('[data-nimmap-error]').innerText()).includes('different account'),
    'an address mismatch gets its own message, not the signature one',
  )
  await context.close()
}

{
  const { context, page } = await openMap({
    worker: { verify: { status: 401, body: { error: 'invalid nonce' } } },
  })
  const dialog = await signIn(page)
  await dialog.locator('[data-nimmap-error]').waitFor({ timeout: 20000 })
  assert(
    (await dialog.locator('[data-nimmap-error]').innerText()).includes('expired'),
    'a stale challenge is explained as an expiry, with the ten-minute window',
  )
  await context.close()
}

// ===========================================================================
// 6. Managing a live pass
// ===========================================================================
{
  const { context, page } = await openMap({
    worker: { me: { entitled: true, address: WALLET, paidUntil: Date.now() + 9 * DAY, daysLeft: 9, expiresInMs: 9 * DAY } },
    token: 'sub-token-live',
  })
  await page.locator('[data-nimmap-tier="paid"]').waitFor({ timeout: 15000 })
  await page.locator('[data-nimmap-tier="paid"]').click()
  const dialog = page.locator('[data-nimmap-paywall]')
  await dialog.waitFor({ state: 'visible', timeout: 15000 })
  assert(
    (await dialog.locator('[data-nimmap-days-left]').innerText()).trim() === '9',
    'the manage dialog counts the days left',
  )
  assert(
    (await dialog.locator('[data-slot="dialog-title"]').innerText()).trim() === 'Your NimMap pass',
    'the manage dialog calls it your NimMap pass',
  )
  assert(
    (await dialog.innerText()).includes(WALLET.slice(0, 9)),
    'the manage dialog names the signed-in wallet',
  )
  await dialog.locator('[data-nimmap-refresh]').click()
  await page.waitForTimeout(500)
  assert(await dialog.isVisible(), 'Refresh status re-checks the pass without closing the dialog')

  await dialog.getByRole('button', { name: 'Sign out' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.locator('[data-nimmap-tier="free"]').waitFor({ timeout: 10000 })
  assert(true, 'signing out drops back to the free tier')
  assert(
    (await page.evaluate(() => window.localStorage.getItem('chainmap.token'))) === null,
    'signing out forgets the pass token',
  )
  await context.close()
}

// ===========================================================================
// 7. A comped pass — the owner's wallet, granted rather than paid for
// ===========================================================================
{
  // What the worker answers for an address on COMP_ADDRESSES: an ordinary pass, a
  // century out, flagged so the client labels it instead of counting it down.
  const { context, page } = await openMap({
    worker: {
      me: {
        entitled: true,
        comp: true,
        address: WALLET,
        paidUntil: Date.now() + 36500 * DAY,
        daysLeft: 36500,
        expiresInMs: 36500 * DAY,
      },
    },
    token: 'sub-token-comp',
  })

  const badge = page.locator('[data-nimmap-tier="paid"]')
  await badge.waitFor({ timeout: 15000 })
  const badgeText = (await badge.innerText()).replace(/\s+/g, ' ')
  assert(
    badgeText.includes('Owner pass') && badgeText.includes('no expiry'),
    `a comped pass is badged as an owner pass with no expiry (got "${badgeText}")`,
  )
  assert(
    !badgeText.includes('36500') && !badgeText.includes('days left'),
    'the badge never counts out the five-digit day total behind a comp pass',
  )
  assert(
    (await page.locator('[data-nimmap-paywall]').count()) === 0,
    'the paywall never opens itself for an entitled comp wallet',
  )
  assert(
    (await page.locator('[data-nimmap-depth="6"]').getAttribute('data-locked')) === null,
    'a comp pass is the paid tier: depth 6 is unlocked',
  )

  await badge.click()
  const dialog = page.locator('[data-nimmap-paywall]')
  await dialog.waitFor({ state: 'visible', timeout: 15000 })
  assert(
    (await dialog.locator('[data-nimmap-days-left]').innerText()).trim() === 'Owner',
    'the manage dialog names the pass rather than counting days',
  )
  assert((await dialog.innerText()).includes('Never'), 'the manage dialog says it never expires')
  await context.close()
}

// ===========================================================================
// 8. A staker pass — full access for wallets staking with the operator's validator
// ===========================================================================
{
  // What /api/me answers for a staker: an ordinary paid pass for as long as the stake
  // stands, flagged so the client labels it instead of counting days.
  const { context, page } = await openMap({
    worker: {
      me: {
        entitled: true,
        staker: true,
        address: WALLET,
        paidUntil: Date.now() + 7 * DAY,
        daysLeft: 7,
        expiresInMs: 7 * DAY,
      },
    },
    token: 'staker-token-staker',
  })

  const badge = page.locator('[data-nimmap-tier="paid"]')
  await badge.waitFor({ timeout: 15000 })
  const badgeText = (await badge.innerText()).replace(/\s+/g, ' ')
  assert(
    badgeText.includes('Staker pass') && badgeText.includes('while staked'),
    `a staker pass is badged as a staker pass, not a countdown (got "${badgeText}")`,
  )
  assert(
    !badgeText.includes('days left') && !badgeText.includes('Owner'),
    'the staker badge neither counts days nor claims an owner pass',
  )
  assert(
    (await page.locator('[data-nimmap-paywall]').count()) === 0,
    'the paywall never opens itself for a staker wallet',
  )
  assert(
    (await page.locator('[data-nimmap-depth="6"]').getAttribute('data-locked')) === null,
    'a staker pass is the paid tier: depth 6 is unlocked',
  )

  await badge.click()
  const dialog = page.locator('[data-nimmap-paywall]')
  await dialog.waitFor({ state: 'visible', timeout: 15000 })
  assert(
    (await dialog.locator('[data-nimmap-days-left]').innerText()).trim() === 'Staker',
    'the manage dialog names the pass rather than counting days',
  )
  assert(
    (await dialog.innerText()).includes('While staked'),
    'the manage dialog says the staker pass runs while staked',
  )
  await context.close()
}

// ===========================================================================
// 9. A receipt whose stake is gone — back on the free tier, receipt kept
// ===========================================================================
{
  // What /api/me answers once the wallet no longer delegates to our validator:
  // not entitled, and deliberately not "expired". The client must show the plain
  // free tier — no renew nag — and keep the receipt so re-staking restores the pass.
  const { context, page } = await openMap({
    worker: { me: { entitled: false, reason: 'not_staked', address: WALLET } },
    token: 'staker-token-unstaked',
  })

  const badge = page.locator('[data-nimmap-tier="free"]')
  await badge.waitFor({ timeout: 15000 })
  const badgeText = (await badge.innerText()).replace(/\s+/g, ' ')
  assert(badgeText.includes('Free'), `an unstaked receipt lands on the free tier (got "${badgeText}")`)

  const stored = await page.evaluate(() => window.localStorage.getItem('chainmap.token'))
  assert(stored === 'staker-token-unstaked', 'the receipt is kept, not destroyed')
  await context.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
await browser.close()
process.exit(failed > 0 ? 1 : 0)
