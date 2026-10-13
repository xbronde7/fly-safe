# Fly Safe 1.1.4 verification

Date: 2026-10-01. Target: macOS arm64.

## Changes and tests

- BUY vs SELL toggles re-quote the same market snapshot without re-indexing contracts.
  BUY walks existing bids; SELL is explicitly an estimate at the lowest competing
  ask, subtracting manually configured broker fees and Accounting-based sales tax.
  Brokerage is included in upfront SELL capital. Instant BUY brokerage is zero.
- Desired output units round up to whole blueprint runs. Batch and per-run/per-unit
  profit are shown separately. Full BPC purchase and allocated cost remain distinct.
- Material and buyer bounds are checked before purchases, capped by the requested
  batch. Combined bounds re-check minimum order quantities, BPC limits and job
  duration. Insufficient BPC runs make whole-batch profit unavailable.
- NPC factory comparison uses an official static stargate BFS, high-sec paths by
  default, public facility IDs and SDE-confirmed manufacturing service (14).
  Requotes materials and duration with **zero** private-structure bonuses and
  NPC-model tax 0.25% EIV. This is a model, not a verified in-game job quotation.
- Factory quotes require a completed scan, validated request and unchanged active
  character. No access/refresh tokens cross IPC. Private-factory tariffs, rigs,
  fuel/access and manufacturing services are not invented.
- `npm run typecheck` and `npm run build`: passed.
- Targeted industry/factories/market/SSO: **96 passed** (7 files).
- Full sandbox suite: **629 passed, 139 failed**. Compared exact failed-test names
  with the recorded 1.1.3 baseline: **no newly failing tests**. Existing failures
  were not rewritten or hidden.

## UI checks

Actual React workspace tested in a local browser with clearly marked **DEMO**
data, not live character prices or a trading recommendation:

- 100-run requested batch shows materials sufficient for only 2 runs.
- Available-quantity button sets 2; explicit recalculation updates the party.
- BUY/SELL switching updates revenue, fees and profit immediately.
- Factory table shows gate count, SCI, materials, installation, duration, profit.
- Selecting a factory applies its system and NPC assumptions and prompts re-scan.
- Revenue/cost/profit tiles have separate colors and labels. At the default narrow
  browser width, page width equals viewport width (664 px); the wide factory table
  scrolls locally instead of pushing the entire page outside the viewport.

## Read-only live public ESI check

No SSO tokens or purchases/job starts/sales were used:

- `/industry/facilities/`: **2321** facilities, currently NPC station IDs.
- Cross-check with official SDE 3561556 Factory service and 10 high-sec gate jumps
  from Jita: **472 NPC factories in 156 systems**, maximum distance exactly 10.
- The Forge market: **406 pages, 405823 unique orders**, loaded in 29.4 seconds.
- All **1741** marketable recipes computed; **1533** had complete one-run prices.
  Skill levels here were controlled test inputs (Industry 5, Advanced Industry 3,
  Accounting 4), not a new authenticated-character verification.
- No invalid order duration observed in this live snapshot. Regression tests
  continue to cover missing/zero/invalid descriptive duration and invalid contract
  ME/TE metadata.

## Delivery

Local installer: `dist/Fly-Safe-1.1.4-arm64.dmg`.
Unsigned local build: no Apple Developer ID/notarization, no GitHub publication.
Installation and image integrity checks are recorded below after packaging.

- `hdiutil verify`: **VALID**.
- DMG SHA-256: `c5659455be522a15fcda9df2f0cc72c59881a4b3570365d35e8a5ab2d245152d`.
- Installed `/Applications/Fly Safe.app`: **1.1.4**.
- Installed ASAR matches the packaged app SHA-256:
  `4b1b4dcc5e7440c9558b52f2a671938112d96f4cf2449bed3ecdb1edb3d92c3f`.
- Previous app and 1.1.3 DMG moved to macOS Trash (recoverable), with duplicate
  packaging output, blockmap and builder metadata. `dist` retains only the 1.1.4 DMG.
  User database, SSO policy and character settings were not deleted or changed.
