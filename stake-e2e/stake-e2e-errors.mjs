/**
 * The unhappy paths: a cancelled signature, a rejected broadcast, a partial
 * multi-transaction failure, and the "you already stake with us" mode.
 */
import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs'

const BASE = 'http://localhost:4331'
const SENDER = 'NQ27 NCB1 3CYU 9P4L EM2V D7L2 28QE 36PA EXB1'
const VALIDATOR = 'NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY'
const OTHER = 'NQ97 04UL PBTY 3P4R TARV G303 K713 FNNY 4J3Y'

let passed = 0
let failed = 0
const assert = (c, m) => { c ? (passed++, console.log(`PASS  ${m}`)) : (failed++, console.log(`FAIL  ${m}`)) }

// `hubMode` is read from a header the page cannot see; the fake Hub reads it from
// a global the test sets before each scenario.
const hubPage = (mode) => `<!doctype html><html><body><script>
  window.addEventListener('message', function (event) {
    var data = event.data || {}
    if (!data.command) return
    function reply(result) { event.source.postMessage({ status: 'ok', result: result, id: data.id }, '*') }
    function fail(message) {
      event.source.postMessage({ status: 'error', result: { message: message }, id: data.id }, '*')
    }
    if (data.command === 'ping') return reply('pong')
    if (data.command === 'choose-address') return reply({ address: ${JSON.stringify(SENDER)}, label: 'Test' })
    if (data.command === 'sign-staking') {
      if (${JSON.stringify(mode)} === 'cancel') return fail('Request was cancelled')
      var request = data.args[0]
      var list = Array.isArray(request.transaction) ? request.transaction : [request.transaction]
      return reply(list.map(function (bytes, index) {
        var hex = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2) }).join('')
        return { transaction: bytes, serializedTx: hex, hash: 'h' + index, raw: {} }
      }))
    }
  })
</script></body></html>`

const browser = await chromium.launch()

async function scenario(name, { hubMode, staker, broadcast, run }) {
  const context = await browser.newContext()
  await context.route('https://hub.nimiq.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: hubPage(hubMode) })
  )
  let broadcastCount = 0
  await context.route('https://nimiq-api.subimpact.net/api/**', (route) => {
    const url = route.request().url()
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.includes('/api/broadcast')) {
      broadcastCount++
      return broadcast(broadcastCount, json)
    }
    if (url.includes('/api/account/')) return json({ data: { balance: 5_000_000_000 } })
    if (url.includes('/api/staker/')) return json({ data: staker })
    if (url.includes('/api/network')) return json({ blockNumber: 61311377, epoch: {} })
    return json({ data: [] })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.locator('astro-island[component-export="StakeDialogHost"]:not([ssr])').waitFor({ state: 'attached' })
  await page.locator('[data-stake-cta="nav"]').click()
  const dialog = page.locator('[data-slot="dialog-content"]')
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: /Connect your Nimiq account/ }).click()
  await run(page, dialog)
  assert(errors.length === 0, `${name}: no uncaught page errors (${errors.join(' | ')})`)
  await context.close()
}

// --- already staking with ImpactZero --------------------------------------
await scenario('add mode', {
  hubMode: 'ok',
  staker: { address: SENDER, balance: 300_000_000, delegation: VALIDATOR, inactiveBalance: 0 },
  broadcast: (n, json) => json({ result: `sent-${n}` }),
  run: async (page, dialog) => {
    await dialog.getByText(/You already stake/).waitFor({ timeout: 15000 })
    assert(true, 'add mode: an existing ImpactZero staker is told this adds to their stake')
    assert(
      (await dialog.getByText(/You already stake/).innerText()).includes('3,000 NIM'),
      'add mode: the current stake is shown'
    )
    await dialog.locator('#stake-amount').fill('5')
    assert(
      !(await dialog.getByText(/A first stake must be/).isVisible()),
      'add mode: 5 NIM is allowed (the 100 NIM floor is only for a first stake)'
    )
    const button = dialog.getByRole('button', { name: /Stake 5 NIM/ })
    await button.waitFor()
    await button.click()
    await dialog.getByText('Your stake is now delegated to ImpactZero stake.').waitFor({ timeout: 20000 })
    assert(true, 'add mode: the add-stake transaction is signed and broadcast')
  },
})

// --- user cancels in the Hub ----------------------------------------------
await scenario('cancel', {
  hubMode: 'cancel',
  staker: null,
  broadcast: (n, json) => json({ result: `sent-${n}` }),
  run: async (page, dialog) => {
    await dialog.getByText(/New staker/).waitFor({ timeout: 15000 })
    await dialog.locator('#stake-amount').fill('100')
    const button = dialog.getByRole('button', { name: /Stake 100 NIM/ })
    await button.waitFor()
    await button.click()
    await dialog.getByText('Signing cancelled — nothing was sent.').waitFor({ timeout: 20000 })
    assert(true, 'cancel: a cancelled signature returns to the amount step with a note')
    assert(
      (await dialog.locator('#stake-amount').inputValue()) === '100',
      'cancel: the amount the user typed is preserved'
    )
    assert(
      await dialog.getByRole('button', { name: /Stake 100 NIM/ }).isEnabled(),
      'cancel: the user can immediately try again'
    )
  },
})

// --- the network rejects the transaction ----------------------------------
await scenario('rejected', {
  hubMode: 'ok',
  staker: null,
  broadcast: (n, json) =>
    json({ error: 'Rejected: Insufficient funds, required 100000000, but has 1' }, 400),
  run: async (page, dialog) => {
    await dialog.getByText(/New staker/).waitFor({ timeout: 15000 })
    await dialog.locator('#stake-amount').fill('100')
    const button = dialog.getByRole('button', { name: /Stake 100 NIM/ })
    await button.waitFor()
    await button.click()
    await dialog.getByRole('alert').waitFor({ timeout: 20000 })
    assert(
      (await dialog.getByRole('alert').innerText()).includes('Insufficient funds'),
      `rejected: the node's own reason is shown (got "${await dialog.getByRole('alert').innerText()}")`
    )
    assert(
      await dialog.getByRole('button', { name: 'Try again' }).isVisible(),
      'rejected: a retry is offered'
    )
  },
})

// --- the second of two transactions fails ---------------------------------
await scenario('partial', {
  hubMode: 'ok',
  staker: { address: SENDER, balance: 200_000_000, delegation: OTHER, inactiveBalance: 0 },
  broadcast: (n, json) =>
    n === 1 ? json({ result: 'switch-hash' }) : json({ error: 'Rejected: invalid transaction' }, 400),
  run: async (page, dialog) => {
    await dialog.getByText(/another validator/).waitFor({ timeout: 15000 })
    await dialog.locator('#stake-amount').fill('100')
    const button = dialog.getByRole('button', { name: /Switch and add/ })
    await button.waitFor()
    await button.click()
    await dialog.getByRole('alert').waitFor({ timeout: 20000 })
    assert(
      await dialog.getByText('1 of 2 transactions reached the network before this failed:').isVisible(),
      'partial: the user is told which transactions already landed'
    )
    assert(
      await dialog.getByText(/switch-has/).isVisible(),
      'partial: the hash of the transaction that did land is shown'
    )
  },
})

console.log(`\n${passed} passed, ${failed} failed`)
await browser.close()
process.exit(failed > 0 ? 1 : 0)
