# Fly Safe 1.1.10 — BPC monitor and produced-goods cost ledger

Verified and installed locally on macOS arm64, 2026-10-10.

## Delivered

- Opt-in main-process BPC monitor, independent of the active tab. All manufacturing
  BPC types present in public contracts of the five configured trade-hub regions
  are considered; this is not a universe-wide contract search.
- Only purchased BPCs and full market resource purchases; no owned blueprints,
  BPOs, held resources or historical-cost substitutions in monitor decisions.
  Recommendations require executable positive BUY profit and fresh market data.
- Editable notification thresholds, budget and interval. Defaults: 10m ISK batch
  profit, 20% return on whole upfront cash, 10 minutes after a completed cycle.
  Per-character persistent contract dedupe, five new notices per cycle, global
  and system notification permissions respected. Disable aborts the current scan;
  character changes invalidate old progress and alerts. No automatic spending.
- Separate «Готовая продукция» tab based only on observed personal manufacturing
  jobs marked ready/delivered. Completed jobs requested and durably captured every
  five minutes while authenticated. Cache clearing preserves recorded jobs/costs.
- Paid material transaction prices and actual ESI job cost; manually confirmed
  material quantities and paid BPC price/runs/contract. Allocation guards prevent
  double consumption of purchases/BPC runs across jobs. Total and unit costs stay
  unknown until required inputs are confirmed, never defaulting missing cost to zero.

## Checks

`npm run build` passed (both TypeScript projects and production bundles).

Targeted suite: **161 tests passed**, 16 files:

```
npx vitest run tests/industry.test.ts tests/industry-planning.test.ts tests/industry-decision.test.ts tests/industry-ui.test.tsx tests/industry-service.test.ts tests/industry-ledger.test.ts tests/industry-factories.test.ts tests/industry-esi-client.test.ts tests/market-esi-client.test.ts tests/cache.test.ts tests/industry-monitor.test.ts tests/industry-production.test.ts tests/industry-monitor-ui.test.tsx tests/native-alert-service.test.ts tests/pilot-workspace-state.test.ts tests/clipboard-view.test.ts
```

Offline native Electron fixture with a separate profile, all non-file networking
blocked: desktop 1360px and narrow 600px inspected, no horizontal document overflow;
monitor toggle, lazy transaction editor and validated cost save passed. Synthetic
example: 60 ISK materials + 20 allocated BPC + 123 job cost + 5 extras = 208 total,
20 output units = 10.4 ISK/unit. This is not an authenticated price/production audit.

Packaged/installed smoke verified version, monitor/production UI and IPC, completed
job query and native SQLite using an in-memory database. QA fixture is excluded
from the packaged application. Deep strict ad-hoc code-signature verification and
DMG checksum verification passed. App relaunched from `/Applications/Fly Safe.app`.
Existing user SQLite quick_check was `ok` before/after installation; purchase
transaction count remained 0 (no fabricated purchases or database replacement).
Prior installed app and 1.1.9 installer moved to recoverable Trash.

Full unrelated suite is not claimed green. Two pre-existing native-alert IPC
message-language assertions fail (Russian expectations vs English source errors);
the new industry workspace whitelist has separate passing coverage.

## Packaging and remaining limits

Reused the installed Electron 43.4.1 runtime and unchanged packaged native
dependencies because the local development Electron.app was absent and exact
runtime download unavailable. Repacked fresh 1.1.10 production output/metadata,
updated ASAR header integrity, ad-hoc signed, built DMG with `--prepackaged`.
No token persistence or OAuth scope changes. EVE SSO needs re-entry after restart.

Installed/staged ASAR SHA256:
`f2a689f17a25245fff1bda04c041cabbc4d4efbe15512d2fc84d2236dd407367`

DMG SHA256:
`17767f52b8ba9e2e6633329e91d1ac5e4a8032c67e85b6f77661c942fe1a2bdc`

Live ESI verification was unavailable due network/DNS failures this turn. No live
trades, purchases, contract acceptance or job installation/delivery were performed.
ESI caches (contracts up to 30m, market about 5m), initial indexing and bounded
source/batch selection prevent real-time sniping or a global optimum guarantee.
Fly Safe must remain running. Finished-goods history is limited to jobs returned
by ESI or already observed locally, not proof of current inventory or sales.
ESI does not link purchases/exact material consumption to a job; paid BPC cost is
confirmed manually, not automatically fetched from a personal contract history.
Single-BPC cost allocation is supported; bundles need separate investigation.
