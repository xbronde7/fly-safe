# Fly Safe 1.1.6 verification

Date: 2026-10-02. Target: macOS arm64. Local unsigned build, no GitHub publication.

- Default material mode: full market. Wallet history cannot null out market profits.
- Mixed mode: exact direct-Hangar stock snapshot at selected location, purchase-price
  basis for known held quantities, marked minimum-SELL valuation for unpriced holdings,
  and independent executable order-book quote for the remaining quantity. No historical
  purchase-volume-to-inventory inference; no proportional full-recipe-average shortcut.
- Filters, sort, counts, per-run/batch profit and cash budget follow selected cost mode.
  Mixed cash capital excludes already-held materials. Multibuy follows the same stock
  snapshot automatically. Changing location requires rescan and conservatively falls
  back to full market until the correct snapshot is available.
- Missing SELL depth/minimum lots remain explicit unknown cost instead of fake profits.
  Mixed readiness confirms the requested batch only; smaller batches require re-quote.
- Strict historical-price comparison remains optional, not default. Factory table still
  uses the full market recipe; an explicit non-market-mode warning explains the difference.
- Journal and nested transaction list are both initially collapsed. Cost period and stock
  location controls are available without expanding transaction rows.

## Verification

- Typecheck and production build: passed.
- Targeted industry/ledger/UI/cache/market: **93 passed, 8 files**.
- Full sandbox suite: **648 passed, 139 failed**. Exact failed-test full names compared
  to saved 1.1.5 report: **no new failures**. Existing unrelated failures remain.
- New coverage: no-wallet market mode, actual-stock-only blending, multilevel deficit
  prices, market-value fallback, insufficient full recipe rescued by held stock, minimum
  lot refusal, unavailable/stale-location stock, requested-Hangar service snapshot and
  invalid location rejection. Markup asserts both disclosures initially closed.
- Interactive localhost preview was not attempted after the previous browser denial.
- `hdiutil verify`: **VALID**.
- DMG SHA-256: `d83e13fed4928781e63f42106df9272c7df3d020be2767d06ea256fabd48feaa`.
- Installed/packaged ASAR SHA-256:
  `da71dcfcfd0337bfb63e0a0fefcdadc1e4b510684473ef04b7dbda5bab7db097`.
- Installed `/Applications/Fly Safe.app`: **1.1.6**. Electron/native SQLite smoke passed,
  with ledger/factory IPC, new mode strings, collapsed-list UI and deficit calculation.
- Prior 1.1.5 app/DMG and duplicate packaging artifacts moved to macOS Trash, recoverable.
  Database/settings not deleted. Only 1.1.6 DMG retained in `dist`; canonical installed
  app re-registered in Launch Services.

Native startup succeeded, then showed the official EVE SSO sign-in gate. Current
macOS policy is session-only sign-in, ending when Fly Safe closes; no Keychain/token
persistence policy was changed. Live authenticated mode/disclosure interaction could
not be checked after restart without the user's sign-in. Installed-bundle and markup
checks above verify presence/default state, not a claimed authenticated live scan.
