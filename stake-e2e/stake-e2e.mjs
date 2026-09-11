/**
 * End-to-end drive of the real StakeDialog against a fake Hub and a fake worker.
 *
 * hub.nimiq.com is served by Playwright as a small page that speaks the same
 * postMessage RPC the real Hub does, so HubApi, the popup handshake, the
 * transaction building and the broadcast loop all run unmodified. The bytes the
 * dialog asks the Hub to sign are captured and decoded with @nimiq/core.
 */
import { chromium } from '/root/projects/alphaaccess-my/e2e/node_modules/playwright/index.mjs'
import { Address, Transaction } from '../node_modules/@nimiq/core/nodejs/index.mjs'

const BASE = 'http://localhost:4331'
const SENDER = 'NQ27 NCB1 3CYU 9P4L EM2V D7L2 28QE 36PA EXB1'
const VALIDATOR = 'NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY'
const STAKING_CONTRACT = 'NQ77 0000 0000 0000 0000 0000 0000 0000 0001'
const HEIGHT = 61311377
const BALANCE_LUNA = 5_000_000_000 // 50,000 NIM

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`PASS  ${msg}`) }
  else { failed++; console.log(`FAIL  ${msg}`) }
}

const HUB_PAGE = `<!doctype html><html><body><script>
  window.addEventListener('message', function (event) {
    var data = event.data || {}
    if (!data.command) return
    function reply(result) {
      event.source.postMessage({ status: 'ok', result: result, id: data.id }, '*')
    }
    if (data.command === 'ping') return reply('pong')
    if (data.command === 'choose-address') {
      return reply({ address: ${JSON.stringify(SENDER)}, label: 'Test account' })
    }
    if (data.command === 'sign-staking') {
      var request = data.args[0]
      var list = Array.isArray(request.transaction) ? request.transaction : [request.transaction]
      // The popup is closed as soon as the call resolves, so the request is
      // reported out through a route the test intercepts.
      fetch('https://hub.nimiq.com/__record', {
        method: 'POST',
        keepalive: true,
        body: JSON.stringify({
          validatorAddress: request.validatorAddress,
          validatorImageUrl: request.validatorImageUrl,
          fromValidatorAddress: request.fromValidatorAddress,
          recipientLabel: request.recipientLabel,
          appName: request.appName,
          amount: request.amount,
          count: list.length,
          isArray: Array.isArray(request.transaction),
        }),
      }).then(function () {
      reply(list.map(function (bytes, index) {
        var hex = Array.prototype.map.call(bytes, function (b) {
          return ('0' + b.toString(16)).slice(-2)
        }).join('')
        return { transaction: bytes, serializedTx: hex, hash: 'hash' + index, raw: {} }
      }))
      })
      return
    }
  })
</script></body></html>`

const browser = await chromium.launch()
const context = await browser.newContext()
const broadcasts = []
let stakerState = { data: null } // no staker yet -> create-staker flow

const hubRequests = []
await context.route('https://hub.nimiq.com/**', (route) => {
  if (route.request().url().endsWith('/__record')) {
    hubRequests.push(JSON.parse(route.request().postData() || '{}'))
    return route.fulfill({ status: 204, body: '' })
  }
  return route.fulfill({ status: 200, contentType: 'text/html', body: HUB_PAGE })
})

await context.route('https://nimiq-api.subimpact.net/api/**', async (route) => {
  const request = route.request()
  const url = request.url()
  const json = (body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (url.includes('/api/broadcast')) {
    const body = JSON.parse(request.postData() || '{}')
    broadcasts.push(body.tx)
    return json({ result: `hash-from-network-${broadcasts.length}` })
  }
  if (url.includes('/api/account/')) return json({ data: { balance: BALANCE_LUNA, type: 'basic' } })
  if (url.includes('/api/staker/')) return json(stakerState)
  if (url.includes('/api/network')) return json({ blockNumber: HEIGHT, epochNumber: 1340, epoch: {} })
  return json({ data: [] })
})

const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

async function openDialog() {
  await page.locator('astro-island[component-export="StakeDialogHost"]:not([ssr])').waitFor({ state: 'attached', timeout: 15000 })
  await page.locator('[data-stake-cta="nav"]').click()
}

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await openDialog()
const dialog = page.locator('[data-slot="dialog-content"]')
await dialog.waitFor({ state: 'visible' })

// --- step 1: connect ------------------------------------------------------
await dialog.getByRole('button', { name: /Connect your Nimiq account/ }).click()
await dialog.getByText(/New staker/).waitFor({ timeout: 15000 })
assert(true, 'chooseAddress round-trips through the Hub popup and reaches step 2')
assert(
  await dialog.getByText('50,000 NIM').isVisible(),
  'the available balance from /api/account is shown'
)
assert(
  (await dialog.getByText(/New staker/).innerText()).includes("you'll delegate to ImpactZero"),
  'a non-staker is told this creates a new stake'
)

// --- step 2: amount validation -------------------------------------------
const input = dialog.locator('#stake-amount')
const submitButton = dialog.getByRole('button', { name: /Stake |Switch |Preparing/ })

await input.fill('50')
assert(
  await dialog.getByText('A first stake must be at least 100 NIM.').isVisible(),
  'a first stake below 100 NIM is rejected'
)
assert(await submitButton.isDisabled(), 'submit is disabled while the amount is invalid')

await input.fill('999999')
assert(
  await dialog.getByText(/That is more than your available/).isVisible(),
  'an amount above the balance is rejected'
)

await dialog.getByRole('button', { name: 'Max', exact: true }).click()
assert((await input.inputValue()) === '50000', 'Max fills the full available balance')

await dialog.getByRole('button', { name: '1,000', exact: true }).click()
assert((await input.inputValue()) === '1000', 'a preset chip fills the amount')
assert(
  await dialog.getByText('Fee: 0 NIM · Min first stake: 100 NIM').isVisible(),
  'the fee and minimum line is shown'
)
await submitButton.waitFor({ state: 'visible' })
assert(
  (await submitButton.innerText()).includes('Stake 1000 NIM'),
  `the submit button names the amount (got "${await submitButton.innerText()}")`
)

// --- step 3: sign + broadcast --------------------------------------------
await submitButton.click()
await dialog.getByText('Your stake is now delegated to ImpactZero stake.').waitFor({ timeout: 20000 })
assert(true, 'the success screen appears after signing and broadcasting')
assert(broadcasts.length === 1, `exactly one transaction was broadcast (got ${broadcasts.length})`)
assert(
  await dialog.getByText(/hash-from-…/).isVisible(),
  'the hash returned by the network is displayed'
)
assert(
  (await dialog.locator('a:has-text("Explorer")').first().getAttribute('href')) ===
    'https://nimiq.watch/#hash-from-network-1',
  'the hash links to the block explorer'
)

const hubRequest = hubRequests[0] || {}
assert(hubRequest.validatorAddress === VALIDATOR, `the Hub is told the validator (${hubRequest.validatorAddress})`)
assert(hubRequest.appName === 'ImpactZero stake', 'the Hub request carries the app name')
assert(hubRequest.amount === 100_000_000, `the Hub is told the amount in luna (${hubRequest.amount})`)
assert(hubRequest.count === 1, 'a new staker signs exactly one transaction')
assert(hubRequest.isArray === false, 'a single transaction is passed to the Hub unwrapped')
assert(
  hubRequest.validatorImageUrl === 'https://nimiq.subimpact.net/logo.svg',
  'the Hub is given the validator logo'
)

// --- what actually got signed --------------------------------------------
const parsed = Transaction.fromAny(Buffer.from(broadcasts[0], 'hex'))
assert(parsed.sender.toUserFriendlyAddress() === SENDER, 'the signed tx is sent from the chosen account')
assert(parsed.recipient.toUserFriendlyAddress() === STAKING_CONTRACT, 'the signed tx targets the staking contract')
assert(parsed.value === 100_000_000n, `the signed tx carries 1000 NIM (${parsed.value} luna)`)
assert(parsed.fee === 0n, 'the signed tx carries a zero fee')
assert(parsed.networkId === 24, `the signed tx is for mainnet (${parsed.networkId})`)
assert(parsed.validityStartHeight === HEIGHT, 'validityStartHeight is the height read from /api/network')
assert(
  Buffer.from(parsed.data).toString('hex').includes(
    Buffer.from(Address.fromUserFriendlyAddress(VALIDATOR).serialize()).toString('hex')
  ),
  'the signed tx delegates to ImpactZero'
)

// --- the switch flow ------------------------------------------------------
broadcasts.length = 0
hubRequests.length = 0
stakerState = {
  data: {
    address: SENDER,
    balance: 200_000_000,
    delegation: 'NQ97 04UL PBTY 3P4R TARV G303 K713 FNNY 4J3Y',
    inactiveBalance: 0,
    retiredBalance: 0,
  },
}
await page.reload({ waitUntil: 'domcontentloaded' })
await openDialog()
await dialog.waitFor({ state: 'visible' })
await dialog.getByRole('button', { name: /Connect your Nimiq account/ }).click()
await dialog.getByText(/another validator/).waitFor({ timeout: 15000 })
assert(true, 'a staker delegating elsewhere is told this switches their delegation')

await dialog.locator('#stake-amount').fill('500')
const switchButton = dialog.getByRole('button', { name: /Switch and add/ })
await switchButton.waitFor()
await switchButton.click()
await dialog.getByText('Your stake is now delegated to ImpactZero stake.').waitFor({ timeout: 20000 })
assert(broadcasts.length === 2, `switching with an added amount broadcasts two txs (got ${broadcasts.length})`)

const [first, second] = broadcasts.map((hex) => Transaction.fromAny(Buffer.from(hex, 'hex')))
assert(first.value === 0n && first.flags === 2, 'the first tx is the signalling delegation switch')
assert(second.value === 50_000_000n, `the second tx adds 500 NIM (${second.value} luna)`)
assert(
  Buffer.from(first.data).toString('hex').includes(
    Buffer.from(Address.fromUserFriendlyAddress(VALIDATOR).serialize()).toString('hex')
  ),
  'the switch points at ImpactZero'
)
const switchRequest = hubRequests[0] || {}
assert(switchRequest.count === 2 && switchRequest.isArray === true, 'both txs go to the Hub in one array request')
assert(
  switchRequest.fromValidatorAddress === 'NQ97 04UL PBTY 3P4R TARV G303 K713 FNNY 4J3Y',
  `the Hub is told which validator is being left (${switchRequest.fromValidatorAddress})`
)

assert(pageErrors.length === 0, `no uncaught page errors (${pageErrors.join(' | ')})`)

console.log(`\n${passed} passed, ${failed} failed`)
await browser.close()
process.exit(failed > 0 ? 1 : 0)
