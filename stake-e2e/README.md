# stake-e2e — browser tests for the staking dialog and NimMap

These drive the **real** components against a **fake Nimiq Hub**: a page served by
Playwright that speaks the same `postMessage` RPC the real Hub does, so `HubApi`, the
popup handshake, transaction building, message signing and the broadcast loop all run
unmodified. The bytes the staking dialog asks the Hub to sign are captured and decoded
with `@nimiq/core` (sender, staking-contract recipient, amount, fee, networkId,
validityStartHeight, delegation target) — a mismatch here would mean the dialog asks
someone to sign the wrong thing.

## Run (from the repo root)

```sh
npm run build
npm run preview -- --port 4331    # keep running in another shell
node stake-e2e/stake-smoke.mjs
node stake-e2e/stake-e2e.mjs
node stake-e2e/stake-e2e-errors.mjs
node stake-e2e/pages-check.mjs
node stake-e2e/responsive-check.mjs
node stake-e2e/chainmap-e2e.mjs
node stake-e2e/chainmap-paywall-e2e.mjs
node stake-e2e/chainmap-perf.mjs
```

- `stake-smoke` — dialog opens, chunk loads lazily, Hub popup is the real hub.nimiq.com.
- `stake-e2e` — happy paths: create / add / switch-with-amount, byte-level tx assertions.
- `stake-e2e-errors` — cancel, rejected broadcast, partial multi-tx failure.
- `pages-check` — every page: CTA opens the dialog, footer copies, no unwired stake links.
- `responsive-check` — no horizontal overflow at three viewports; both maps fill their shell.
- `chainmap-e2e` — the scan engine and the map, over a synthetic chain of known shape.
- `chainmap-paywall-e2e` — sign-in, checkout, payment polling, renewal and sign-out.
- `chainmap-perf` — frame rate of the map under a settled and a synthetic worst-case layout.

The three `chainmap-*` files keep their old names: the map was renamed ChainMap → NimMap,
but a test file is not user-facing and renaming it would break every shell history, note
and runbook that names it. Everything *inside* them speaks NimMap.

### How the NimMap suites fake a chain

`chainmap-e2e` serves the whole `/api` surface from a generated graph: a binary tree of
transfers for the depth tests (depth *d* must map exactly 2^(d+1)−1 addresses and one
fewer transaction, over exactly 2^d−1 history requests), and a 20×19 fan-out for the
address-cap test. Every generated address carries real IBAN check digits, so the input
validation and the "scan from here" path run against addresses the app accepts. Tiers
are entered the way a returning reader does — a pass token in localStorage and an
entitled `/api/me` — with no wallet involved.

Canvas hit-testing is checked by sweeping real clicks across the canvas until a node or
an arrow panel opens. The sweep starts 80px below the top of the viewport: the sticky
header would otherwise swallow the clicks and navigate away.

## Notes

- Playwright is imported from a machine-local path; adjust the import if this moves.
- The preview must serve `dist/` on `http://localhost:4331` (the scripts' BASE).
- The NimMap island is server-rendered, so its input exists before React owns it.
  Every script waits for `astro-island[component-export="NimMap"]:not([ssr])` before
  typing — text entered earlier is discarded when the controlled value takes over.
