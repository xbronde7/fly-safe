# Fly Safe 1.1.9 — BUY-first manufacturing

Verified locally on macOS arm64, 2026-10-10.

## Change

- Removed max(BUY, SELL) profit ranking. Default: positive executable BUY,
  sorted by net operating ISK/hour in one manufacturing slot.
- One shared BUY decision determines the batch, filtering, sorting and headline.
  Budget checks the full batch and full blueprint/contract acquisition cash.
- Added a separate hourly BUY boundary candidate alongside best total-profit
  candidate. Actual batch hours are used, not one-run hours.
- Main card: quantity, time, net BUY profit, per-run cost/profit, matching buyer
  quantity/price, upfront cash. BPO purchase and first-batch profit are explicit.
- Unknown-cost own BPC is not an actionable recommendation. Missing buyers,
  materials, skills, price/time or budget yield reasons in the all-results view.
- Full BPC/one-run/SELL comparison collapsed; material details and Multibuy kept.
- Regional trade volume remains visible, including batch share of average daily
  volume; it is not a promise of station liquidity or an estimated sale duration.

## Checks

`npm run build` passed (both TypeScript projects and production bundles).

Targeted suite: **116 tests passed**, 10 files:

```
npx vitest run tests/industry.test.ts tests/industry-planning.test.ts tests/industry-decision.test.ts tests/industry-ui.test.tsx tests/industry-service.test.ts tests/industry-ledger.test.ts tests/industry-factories.test.ts tests/industry-esi-client.test.ts tests/market-esi-client.test.ts tests/cache.test.ts
```

Offline fixture render inspected at 1360px and 600px using a separate native
Electron profile; no horizontal document overflow. All network requests blocked
in the fixture window. These are layout checks on synthetic prices, not an EVE
price audit or an authenticated end-to-end scan.

Installed package smoke: version, BUY UI labels, industry IPC code and hourly
planner present; bundled native SQLite works with an in-memory database.
SQLite `quick_check` on the existing user database was `ok`; purchase transaction
count was 0 before and after installation (no history fabricated or cleared).

DMG checksum verification passed. Staged application passed deep strict ad-hoc
code-signature verification. Prior app and installer moved to recoverable Trash.

## Packaging and limits

Local development Electron.app runtime was absent; downloading exact Electron
43.4.1 failed due network access. Reused the already installed 43.4.1 runtime and
unchanged packaged native dependencies, repacked fresh production output and
1.1.9 metadata, updated ASAR header integrity and re-signed ad-hoc; DMG built via
electron-builder `--prepackaged`. No runtime downgrade, credential persistence
change, or user DB replacement.

No live trades, resource purchases, contract acceptance or manufacturing jobs
were performed. Full unrelated test suite was not rerun. Candidate search remains
bounded, not globally optimal; BUY orders may change before manufacturing ends.
