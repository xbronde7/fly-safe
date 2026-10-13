# Fly Safe 1.1.7 verification

Date: 2026-10-03. Target: macOS arm64. Local unsigned build; no GitHub publication.

## Price audit and changes

- Identified incorrect weighted-depth pricing for EVE one-shot Multibuy/orders.
  Ingredient cost now uses the most expensive matched ASK for every unit of that
  type; one-shot sale uses the least expensive matched BID for all output.
  Independent per-level manual trading can improve this conservative quote.
- Public ESI audit of Packrat, 2026-10-03 10:32 UTC, ME0 / Jita station only:
  30-run materials: 226187040 ISK; weighted-depth understating by 18000 ISK.
  30 units BUY: weighted 803670000 vs single-limit 795000000 ISK, overstating
  gross revenue by 8670000 ISK. No blueprint price/character skills assumed.
  Small Tractor Beam I ×100: weighted 199192000 vs Multibuy 199400000 ISK.
  Packrat history through Oct 1: 169.14/day (7d), 173.23/day (30d),
  5197 units over 30 calendar days. Regional The Forge, not Jita station history.
  Reproduce with `scripts/audit-industry-prices.ts`; prices naturally change.
- BUY eligibility includes region and reachable jump/system ranges. Station ASK
  scope unchanged. Regional pages deduplicated and oldest Last-Modified/Expires
  recorded. Re-price after long indexing; do not call scan-finish time price age.
- Jita default. Combined market/contracts/own sources, real ME/TE one-run profit
  selection. Removed desired quantity, source, sales-mode and profit-basis selectors.
- One-run/full-copy/feasible batches and BUY/SELL comparison table after fees.
  Separate original investment/first-run profit/upfront full contract cash.
  Profitable BUY candidate search avoids joke bids in maximum-volume fills.
- Paced, cached regional realized history for visible cards only. Zero-trade days
  count in averages; unpublished days excluded. Missing history remains unknown.
  Daily/30-day volume, active days, last trade, stale/slow-sales warnings and filter.
- Purchase ledger/material mode preserved; mixed deficits use correct Multibuy
  limits. Detailed batch components mount lazily when expanded.

## Verification status

- Typecheck passed. Targeted industry/market/cache: 105 tests passed (9 files).
- Full suite before final packaging: 662 passed, 137 failed. Failures are outside
  industry/market-client/cache suites; pre-existing 1.1.6 report recorded 139.
  This is not an assertion that the full repository suite is green.
- Native 1.1.6 inspection confirmed actual user skills (Industry5/Advanced4/
  Accounting4), saved wallet journal and provisional old scan results. No EVE
  purchase/manufacturing/sale actions were performed.
- Production build and typecheck passed. `hdiutil verify`: VALID.
- Installed `/Applications/Fly Safe.app`: 1.1.7. Packaged/installed ASAR matches:
  `d25afedc2834d0e1ca754786dd665847ee0da6acfdb6e254abaa97c85a1d4574`.
- DMG SHA256: `12e1c36230d08f8bae91162bc2ff3b2cd33e7c69a11dc857e150a2308563e297`.
- Electron-run-as-node installed native SQLite/industry IPC/planning/liquidity UI
  smoke passed. No desired-quantity label in renderer. Native startup reached
  the official existing SSO session check; no persistence/access policy changed.
