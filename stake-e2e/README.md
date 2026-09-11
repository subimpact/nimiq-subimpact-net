# stake-e2e — browser tests for the on-site staking dialog

These drive the **real** `StakeDialog` against a **fake Nimiq Hub**: a page served by
Playwright that speaks the same `postMessage` RPC the real Hub does, so `HubApi`, the
popup handshake, transaction building and the broadcast loop all run unmodified. The
bytes the dialog asks the Hub to sign are captured and decoded with `@nimiq/core`
(sender, staking-contract recipient, amount, fee, networkId, validityStartHeight,
delegation target) — a mismatch here would mean the dialog asks someone to sign the
wrong thing.

## Run (from the repo root)

```sh
npm run build
npm run preview -- --port 4331    # keep running in another shell
node stake-e2e/stake-smoke.mjs
node stake-e2e/stake-e2e.mjs
node stake-e2e/stake-e2e-errors.mjs
node stake-e2e/pages-check.mjs
```

- `stake-smoke` — dialog opens, chunk loads lazily, Hub popup is the real hub.nimiq.com.
- `stake-e2e` — happy paths: create / add / switch-with-amount, byte-level tx assertions.
- `stake-e2e-errors` — cancel, rejected broadcast, partial multi-tx failure.
- `pages-check` — every page: CTA opens the dialog, footer copies, no unwired stake links.

## Notes

- Playwright is imported from a machine-local path; adjust the import if this moves.
- The preview must serve `dist/` on `http://localhost:4331` (the scripts' BASE).
