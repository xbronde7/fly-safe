# Fly Safe 1.1.11 — simplified automatic finished-goods costing

Verified locally on macOS arm64, 2026-10-10.

## Changes

- Normal finished-goods entry asks only for paid BPC price and original run count;
  no contract ID, purchase allocation inputs, material confirmation checkbox,
  delivery or fee inputs. BPO remains a reusable asset.
- Material quantities computed from recipe/runs and captured ME, with labelled
  ME 0 fallback and base Jita/no-structure-bonus assumptions. Jobs-only background
  reads preserve previously captured ME; legacy records hydrate without wiping
  history. These are calculated quantities, not ESI-reported consumption.
- Nearest personal purchases before the job supply prices. Automatic jobs are
  processed chronologically, including active jobs, with real quantities reserved
  once; previously confirmed allocations take precedence. Incomplete purchase
  history uses labelled last-pre-job-purchase price estimation for the deficit.
  No eligible history uses explicitly labelled current exact-station Jita SELL
  depth, with whole-quantity limit price. Missing price/depth stays unknown.
- Actual ESI job cost always wins, charged once. Missing cost uses a labelled
  current Jita SCI/adjusted-price EIV estimate with base assumptions 0.25% facility
  tax + 4% SCC, Omega, no reductions. No guessed fixed ISK fee or second tax.
- Per-material quantity, unit/total cost, source/date and all assumptions are
  collapsed under details. Auto totals are labelled calculated cost, not exact
  historical expenditure. Same blueprint item reuses saved BPC price/runs within
  its total run budget; unrelated copies do not inherit a guessed price.
- Existing manual allocations, BPC contract references and extra costs preserved.
  Automatic estimates do not fabricate wallet transactions or confirmed debits.

## Checks

`npm run build` passed: both TypeScript projects and all production bundles.

Targeted suite: **173 tests passed, 16 files**:

```
npx vitest run tests/industry.test.ts tests/industry-planning.test.ts tests/industry-decision.test.ts tests/industry-ui.test.tsx tests/industry-service.test.ts tests/industry-ledger.test.ts tests/industry-factories.test.ts tests/industry-esi-client.test.ts tests/market-esi-client.test.ts tests/cache.test.ts tests/industry-monitor.test.ts tests/industry-production.test.ts tests/industry-monitor-ui.test.tsx tests/native-alert-service.test.ts tests/pilot-workspace-state.test.ts tests/clipboard-view.test.ts
```

Offline native Electron UI fixture uses a separate profile, all non-file network
blocked. Desktop 1360px and narrow 600px inspected; no document horizontal overflow.
Only two numeric inputs (BPC price/runs), empty-price save rejected, no contract
ID/material allocation inputs. Automatic materials 60 ISK + BPC 20 + actual job
cost 123 = 203 total / 20 outputs = 10.15 ISK/unit. BPC-only save passed. Missing
job-cost fixture displays the labelled Jita estimate and purchase-history deficits.
Synthetic fixtures are not a live EVE price audit or authenticated job test.

Packaged smoke checks version, automatic workflow and absence of old manual
labels, production/monitor IPC and native SQLite using only an in-memory DB.
Deep strict ad-hoc code-signature verification passed for the staged application.
Fixture source/profile is excluded from the application package.

Installed `/Applications/Fly Safe.app` and relaunched it. Installed package smoke,
deep strict signature verification and DMG checksum verification passed. Installed
ASAR matches the staged SHA256 below. User SQLite quick_check remains `ok`;
transactions/production records counts and production-record digest unchanged
before/after (both tables currently contain zero rows). Prior 1.1.10 application
and installer moved to recoverable Trash; only 1.1.11 DMG remains in `dist`.

DMG SHA256:
`5ce1cfe66987775e224bc566517e6004ff1e5a800e848c2a54a510033675f213`

## Packaging and limits

Reused installed Electron 43.4.1 and unchanged native dependencies, repacked fresh
1.1.11 output/metadata, updated ASAR integrity and ad-hoc signed. DMG uses
electron-builder `--prepackaged`; no runtime downgrade, new OAuth scopes, token
persistence change, or user database replacement.

Staged ASAR SHA256:
`d6b87c77a2af6ba1cbe423813eec685de14f4456550b212c25f1cb64a3e1a49c`

No live purchases, contract acceptance, manufacturing installation/delivery or
sale performed. No claim that unrelated full-suite tests pass. A real authenticated
ESI round-trip and factory quote were not verified this turn. Missing ME, facility
bonuses and purchase history prevent exact historical expense reconstruction;
fallbacks remain estimates and may change on refresh. No historical price is
invented from a current listing. Finished-goods history is not current inventory.
