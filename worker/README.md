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
| `GET /api/history/:addr`  | `getTransactionsByAddress` on `rpc.nimiqwatch.com`    |
| `GET /api/quote`          | CoinGecko `simple/price?ids=nimiq-2`                  |
| `POST /api/entitlement`   | CoinGecko + `getTransactionsByAddress`                |
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

## ChainMap paywall

The ChainMap address mapper is free to depth 3 and paid beyond it. There are no accounts
and no database: the connected wallet address is the login, and the payment transaction
on chain is the receipt.

`GET /api/history/:addr?max=20&startAt=<hash>` pages an address's transactions from the
public RPC node. `max` is 1–50 (default 20); `startAt` is the node's cursor and must be a
64-char lowercase hex transaction hash. Each row is trimmed to
`hash, blockNumber, timestamp, confirmations, size, from, to, value, fee` — the node's
`recipientData` blob runs to hundreds of bytes per staking transaction and is dropped.
`pagination.nextStartAt` is the last hash of a full page, `null` at the end of the
history. A request the node rejects comes back as `400` carrying the node's own message;
an unreachable node is `502 {"error":"upstream"}`. Pages are cached 60s per
address + `max` + `startAt`.

`GET /api/quote` prices a 30-day pass: `$29.99` at the CoinGecko NIM spot rate, rounded
up to the luna, alongside the paywall address to pay it to. Cached 60s.

`POST /api/entitlement` `{address}` looks for the newest transfer from that address to
the paywall address worth at least **85%** of what the pass costs right now — tolerance
for NIM having moved since the user signed. The 30 days run from that transaction's own
timestamp, so a pass bought three weeks ago has a week left, not a fresh month. The
answer is `{entitled, reason, requiredLuna, priceUsd}` plus, when entitled, a `token`.
Origin-gated like `/api/broadcast`, and never cached.

`GET /api/me` with `Authorization: Bearer <token>` re-checks a pass without touching any
upstream. The token is `base64url("<address>.<paidUntil>.<HMAC-SHA256>")` — a signed
receipt, not a session, so nothing is stored server-side. A token we did not sign is
`401`; a genuine token whose pass has run out is `200 {"entitled":false,"reason":"expired"}`,
which tells the client to show *renew* rather than *connect wallet*.

`PAYWALL_ADDRESS` is a plain var in `wrangler.toml`. `CHAINMAP_TOKEN_SECRET` signs the
tokens and is **not** in the repo — set it per environment with
`npx wrangler secret put CHAINMAP_TOKEN_SECRET`. Without it both token routes answer
`500`; rotating it invalidates every issued token, costing each holder one
`/api/entitlement` round trip.

**Known bound:** entitlement scans one 200-transaction page. A wallet that has made more
than 200 transactions since paying would have its payment fall off the end and read as
`no_payment`. Paginating with `startAt` until the payment is found would fix it at the
cost of one subrequest per extra page.

## Local test

```sh
node --check worker/src/index.js && node worker/test-local.mjs
```

Runs the handler in plain Node with a stubbed upstream `fetch` and an in-memory
Cache API — no network, no wrangler needed.

## Deploy

```sh
cd worker && npx wrangler deploy
```
