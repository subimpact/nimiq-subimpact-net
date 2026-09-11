# nimiq-api

Read-only CORS proxy for [NimiqHub REST](https://api.nimiqhub.com) data, used by the
`nimiq.subimpact.net` frontend. NimiqHub serves the data but sends no
`Access-Control-Allow-Origin` header, so browsers cannot call it directly.

The worker whitelists a handful of GET endpoints, echoes CORS headers for known origins
(`https://nimiq.subimpact.net`, `https://nimiq-subimpact-net.pages.dev`,
`http://localhost:4321`), and caches responses for 60s via the Workers Cache API.

## Endpoints

| Route                    | Upstream                                       |
| ------------------------ | ---------------------------------------------- |
| `GET /api/health`        | — returns `{"ok":true}`                        |
| `GET /api/validators`    | `/getValidators`                               |
| `GET /api/stakers/:addr` | `/getStakersByValidatorAddress/:addr`          |
| `GET /api/account/:addr` | `/getAccountByAddress/:addr`                   |

`:addr` accepts a Nimiq address in any spacing or casing (`NQ08ACT8...` or
`NQ08 ACT8 ...`); it is normalized to uppercase 4-char blocks before the upstream call.
Invalid addresses return `400 {"error":"invalid address"}`, unknown routes `404`,
non-GET `405`, and upstream failures `502 {"error":"upstream"}`.

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
