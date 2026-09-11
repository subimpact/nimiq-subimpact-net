# nimiq-api

Read-only CORS proxy for [NimiqHub REST](https://api.nimiqhub.com) data, used by the
`nimiq.subimpact.net` frontend. NimiqHub serves the data but sends no
`Access-Control-Allow-Origin` header, so browsers cannot call it directly.

The worker whitelists a handful of GET endpoints, echoes CORS headers for known origins
(`https://nimiq.subimpact.net`, `https://nimiq-subimpact-net.pages.dev`,
`http://localhost:4321`), and caches responses for 60s via the Workers Cache API.

## Endpoints

| Route                     | Upstream                                              |
| ------------------------- | ----------------------------------------------------- |
| `GET /api/health`         | — returns `{"ok":true}`                               |
| `GET /api/validators`     | `/getValidators`                                      |
| `GET /api/stakers/:addr`  | `/getStakersByValidatorAddress/:addr`                 |
| `GET /api/account/:addr`  | `/getAccountByAddress/:addr`                          |
| `GET /api/network`        | `/getBlockNumber` + `/getEpochNumber` + `/getBatchNumber` |
| `GET /api/graph?part=N`   | `/getValidators` + one staker call per validator      |
| `GET /api/status`         | `uptime.subimpact.net` status page (node uptime)      |
| `GET /api/history/:addr`  | `getTransactionsByAddress` on `rpc.nimiqwatch.com`    |
| `GET /api/quote`          | price feed (CoinGecko → Gate.io → MEXC)               |
| `GET /api/auth/nonce`     | — mints a signed challenge, no upstream call          |
| `POST /api/auth/verify`   | price feed + `getTransactionsByAddress`               |
| `POST /api/entitlement`   | price feed + `getTransactionsByAddress`               |
| `GET /api/me`             | — reads the pass token, no upstream call              |

`:addr` accepts a Nimiq address in any spacing or casing (`NQ08ACT8...` or
`NQ08 ACT8 ...`); it is normalized to uppercase 4-char blocks before the upstream call.
Invalid addresses return `400 {"error":"invalid address"}`, unknown routes `404`,
non-GET `405`, and upstream failures `502 {"error":"upstream"}`.

### `/api/graph` parts

Workers Free allows **50 units per invocation**, and `fetch()` shares that quota with
Cache API `match`/`put`/`delete`. A whole-graph compose is ~150 units at 52 validators,
so the route is chunked: `?part=N` fetches the stakers of at most 26 validators.

Every part returns the **full** validator list plus its own staker slice:

```json
{ "validators": [...52...], "stakers": [...], "totalActiveStake": 0,
  "updatedAt": "…", "part": { "index": 1, "count": 2 } }
```

Read `part.count` from part 1, fetch parts `2..count`, concatenate `stakers`, and take
everything else from part 1 — only part 1 pays the subrequest for display names, so the
validator lists in later parts carry no `name`. `?part` defaults to 1; a value that is
not a positive integer, or is past `part.count`, returns `400 {"error":"invalid part"}`.
Each part is cached for 300s under its own key. Cold cost per part: 1 cache match +
1 validators fetch + (part 1) 1 names fetch + ≤26 staker fetches + 1 cache put ≈ 30 units.

### `/api/status`

Whether the validator node is up, read from the operator's [Uptime
Kuma](https://uptime.subimpact.net/status/live) rather than probed from here — Kuma has
been checking every 60s from a fixed vantage point for as long as the node has existed,
and a worker can only report what one Cloudflare colo saw once. The upstream is the
public status page's own unauthenticated JSON; no token is involved and nothing here can
write to Kuma.

```json
{ "fetchedAt": 1757605234123, "source": "uptime.subimpact.net",
  "sourceUrl": "https://uptime.subimpact.net/status/live",
  "monitors": [
    { "id": 28, "label": "Validator node · p2p 8443", "status": 1, "ping": 12,
      "lastCheck": "2026-09-11T16:20:59.143Z", "uptime24h": 0.9971530249110321,
      "heartbeats": [1, 1, 1] }
  ] }
```

`status` follows Kuma: `1` up, `0` down, `2` pending, `3` maintenance. `status`, `ping`
and `lastCheck` come from the newest beat; `heartbeats` is the last ≤100 statuses,
oldest → newest; `uptime24h` is a 0–1 ratio, `null` when Kuma reports none. Kuma writes
beat times as `2026-09-11 16:20:59.143` with **no zone marker** and means UTC — the route
appends the `Z` so the client cannot read them as local time.

Only the two monitor ids in `STATUS_MONITORS` are passed through, always in that order,
and one that is absent from the payload is dropped rather than faked. Those ids are
Kuma's database ids: recreating a monitor there gives it a new one, and the constant in
`src/index.js` has to be edited to match — until then that row simply disappears. Cold
cost: 1 cache match + 1–2 status fetches + 1 cache put; cached 60s.

## ChainMap paywall

The ChainMap address mapper is free to depth 3 and paid beyond it. There are no accounts
and no database: a signature from the connected wallet is the login, and the payment
transaction on chain is the receipt.

`GET /api/history/:addr?max=20&startAt=<hash>` pages an address's transactions from the
public RPC node. `max` is 1–50 (default 20); `startAt` is the node's cursor and must be a
64-char lowercase hex transaction hash. Each row is trimmed to
`hash, blockNumber, timestamp, confirmations, size, from, to, value, fee` — the node's
`recipientData` blob runs to hundreds of bytes per staking transaction and is dropped.
`pagination.nextStartAt` is the last hash of a full page, `null` at the end of the
history. A request the node rejects comes back as `400` carrying the node's own message;
an unreachable node is `502 {"error":"upstream"}`. Pages are cached 60s per
address + `max` + `startAt`.

`GET /api/quote` prices a 30-day pass: `$29.99` at the NIM spot rate, rounded up to the
luna, alongside the paywall address to pay it to, and `priceSource` naming the feed that
answered. Cached 60s.

### Signing in

A Nimiq address proves nothing: every paid address is printed on the chain in public, so
"I am NQ…" is a claim anyone can copy. Sign-in is therefore a signature.

`GET /api/auth/nonce` returns `{nonce, message, expiresInMs}` — the challenge plus the
exact sentence to sign. The nonce is `"<issued-at base36>.<HMAC>"`, stateless: there is no
KV namespace and no write per sign-in, because the HMAC is what makes the timestamp
unforgeable and a **10-minute** window is what closes the replay. `no-store` at every
layer.

`POST /api/auth/verify` `{address, signerPublicKey, signature, nonce}` verifies the
Ed25519 signature with WebCrypto over the Hub's signed-message digest
(`"\x16Nimiq Signed Message:\n" + byteLength + message`, SHA-256'd), then **derives** the
address from the public key that made the signature and compares it to the claimed one —
BLAKE2b-256 of the key, first 20 bytes, base32, IBAN check digits. The BLAKE2b is vendored
in `src/blake2b.js` — WebCrypto has no BLAKE2, and a dependency would mean a build step
for a file wrangler currently ships as-is — and the derivation is checked byte for byte
against real `@nimiq/core` keypairs in the suite.
A stale nonce, a bad signature and an address/key mismatch each get their own `401`, so
the client can say which happened. The answer is the entitlement the chain shows —
`{ok, entitled, authToken, requiredLuna, priceUsd, …}`, plus a pass `token` when there is
a payment. Origin-gated, never cached.

Two token kinds, both `base64url("<kind>:<address>:<expiry>.<HMAC-SHA256>")`, both
receipts rather than sessions — nothing is stored server-side:

| Kind   | Lives    | Says                                       | Accepted by         |
| ------ | -------- | ------------------------------------------ | ------------------- |
| `auth` | 60 min   | this key signed for this address           | `/api/entitlement`  |
| `sub`  | to `paidUntil` (30 days paid, a century comped) | the chain showed a payment, or the operator granted one | `/api/me` |

The kind is inside the signed payload, so neither can be passed off as the other. `verify`
mints `auth` whatever the chain says — that is what lets the client poll while a payment
confirms without a second Hub popup — and `sub` only when there is a payment.

### The payment check

`POST /api/entitlement` carries **no body**: the address comes from the `auth` bearer
token and nowhere else. It looks for the newest transfer from that address to the paywall
address worth at least **85%** of what the pass costs right now — tolerance for NIM having
moved since the user signed. The 30 days run from that transaction's own timestamp, so a
pass bought three weeks ago has a week left, not a fresh month. The answer is
`{entitled, reason, requiredLuna, priceUsd}` plus, when entitled, a `sub` token.
Origin-gated like `/api/broadcast`, and never cached — a cached answer would hand the
first caller's pass to the next wallet that asked.

The search pages back through history with `startAt`, **5 pages of 200** transactions, and
stops early on a short page. So a payment is found anywhere in the last 1000 transactions
of that address, at a cost of ≤6 subrequests; a wallet that has made more than 1000
transactions since paying reads as `no_payment`.

`GET /api/me` with `Authorization: Bearer <sub token>` re-checks a pass without touching
any upstream. A token we did not sign is `401`, as is an `auth` token; a genuine `sub`
token whose pass has run out is `200 {"entitled":false,"reason":"expired"}`, which tells
the client to show *renew* rather than *connect wallet*.

### Comped wallets

Addresses named in `COMP_ADDRESSES` hold a pass without paying for one. The check is the
first thing `resolveEntitlement` does, before the price fetch and before the history walk,
so a comped wallet signs in when every price feed is refusing Cloudflare and the RPC node
is down — which is most of the point of having one. Its answer is an ordinary paid one
plus `comp: true`, with `paidUntil` a century out and no `requiredLuna`/`priceUsd`, since
nothing was priced; the client reads the flag and prints *no expiry* rather than counting
out 36,500 days. Everything downstream — the `sub` token, the tier, the depth and export
limits — sees a pass like any other.

Being on the list grants nothing by itself: the address still has to prove it holds its
key on `/api/auth/verify`, and the address the list is checked against is the one *derived
from the signature*, never one a caller named. `/api/me` re-reads the list on every call
rather than trusting a flag baked into a token, so removing an address stops it claiming
to be comped immediately; its existing token still runs to its own expiry.

### Price sources

The pass is priced in USD and paid in NIM, so every route above needs a spot price before
it can answer. CoinGecko is the reference rate and is tried first, but it cannot be the
only one: from Cloudflare's egress it is persistently rate-limited — three of three calls
refused in a live check, while the identical request from an ordinary server succeeds —
and that took `/api/quote`, `/api/auth/verify` and `/api/entitlement` down together. So
the chain is tried in order until one returns a finite number above zero:

| `priceSource` | Endpoint                                                        | Read        |
| ------------- | --------------------------------------------------------------- | ----------- |
| `coingecko`   | `api.coingecko.com/api/v3/simple/price?ids=nimiq-2&vs_currencies=usd` | `["nimiq-2"].usd` |
| `gate`        | `api.gateio.ws/api/v4/spot/tickers?currency_pair=NIM_USDT`       | `[0].last`  |
| `mexc`        | `api.mexc.com/api/v3/ticker/price?symbol=NIMUSDT`                | `.price`    |

A source is skipped on a timeout (10s), a non-2xx, a body that is not JSON, or a quote
that is not a usable number — both exchanges send the price as a *string*, so it goes
through `Number()` before that test. All three failing is `502 {"error":"upstream"}`.
The fallbacks are NIM/USDT spot markets rather than CoinGecko's USD average, so they
quote a slightly different number; the 85% payment tolerance absorbs far more drift than
the spread between two live order books. Worst case the chain costs 3 subrequests instead
of 1, still inside the 50-unit budget.

### Configuration

`PAYWALL_ADDRESS` and `COMP_ADDRESSES` are plain vars in `wrangler.toml` — both name
addresses, which are public anyway. `COMP_ADDRESSES` is a comma-separated list in any
spacing or casing; an entry that is not a Nimiq address is dropped rather than matched, so
a typo comps nobody. Granting and revoking is editing that line and redeploying.
`CHAINMAP_TOKEN_SECRET` signs the
nonces and both token kinds and is **not** in the repo — set it per environment with
`npx wrangler secret put CHAINMAP_TOKEN_SECRET`. Without it the sign-in and token routes
answer `500`; rotating it invalidates every issued token and nonce, costing each holder
one sign-in round trip.

## Local test

```sh
npm install && node --check worker/src/index.js && node worker/test-local.mjs
```

Runs the handler in plain Node with a stubbed upstream `fetch` and an in-memory
Cache API — no network, no wrangler needed. The one dependency is `@nimiq/core` from the
repo root, and only the sign-in tests use it: address derivation and signature
verification are checked against real keypairs, because agreeing with a fixture would only
prove the worker agrees with itself.

## Deploy

```sh
cd worker && npx wrangler deploy
```
