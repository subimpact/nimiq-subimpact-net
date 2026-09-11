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
