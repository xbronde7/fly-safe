# Fly Safe 1.1.5 verification

Date: 2026-10-02. Target: macOS arm64. Local unsigned build; no GitHub publication.

## Changes

- Persistent personal-wallet purchase/sale ledger keyed by character and immutable
  transaction ID; atomic imports, pagination through the existing ESI wallet adapter.
  Separate SQLite tables survive cache expiry, Clear cache and app restart.
- Journal shows transaction date, item, side, quantity, executed unit price, total
  and location ID. Names use the manufacturing SDE catalog; unknown types use IDs.
- Read-only wallet scope required. Character is checked before and after fetching
  and before displaying; no tokens cross IPC. Outage keeps saved history with a warning.
- Historical material price is quantity-weighted over a chosen UTC start date.
  Party and per-run profit shown separately from replacement-market profit. Missing
  purchase coverage makes cost unknown, not zero. Historical purchases are explicitly
  not current inventory or exact job allocations. Blueprint/job/transport/sale expenses
  remain modeled; contract acquisitions and separately charged buy-order brokerage
  are not included in wallet transaction material prices.
- Limited cancellable retries handle truncated JSON/network causes and 5xx during
  contract indexing. Invalid semantic data is not retried; no failed response is cached.
- Invalid renderer-side broker fees cannot inflate profit.

## Checks

- Typecheck and production build: passed.
- Industry, ledger, UI markup, cache, market and SSO: **112 passed, 9 files**.
- Full sandbox suite: **640 passed, 139 failed**. Same failure count as recorded 1.1.4
  baseline (629 passed, 139 failed); full suite is not green. New feature tests pass.
  This run does not claim an exact failed-name comparison with the old report, which
  is no longer available in the temporary directory.
- Tests cover restart/cache-clearing persistence, duplicate isolation, atomic rejection,
  weighted prices, period boundaries, missing coverage, unchanged non-material fees,
  insufficient BPC runs, wallet outage, missing scope, character switch, token exclusion,
  JSON retry and semantic-error classification.
- Browser demo QA was denied by browser security policy. No alternate browser or
  localhost workaround used. Temporary QA server stopped. Markup assertions passed;
  interactive demo/responsive checks for this increment were not performed.
- Installer integrity: `hdiutil verify` **VALID**.
- DMG SHA-256: `34fbc493123e71df7f7704f027ecfc08fd3499dd6552142759b65f213fcb19d6`.
- Packaged ASAR SHA-256: `df59a74ab49c9bb5e05f3dd71cf55c5dbda1891fdf59b737726e53f0e226ef44`.

## Installation

- Installed `/Applications/Fly Safe.app`: **1.1.5**. Its ASAR matches packaged hash.
- Installed Electron SQLite smoke: passed; ledger/factory IPC, ledger tables,
  quantity, BUY/SELL, journal and historical-cost renderer strings confirmed.
- Existing SSO session restored. Native UI confirmed version 1.1.5 and a live
  character-isolated journal with **2220 saved transactions**. Expanded journal
  showed actual dates, item names/ID fallback, quantity, paid unit price and exact
  gross amount including fractional ISK. Ongoing user scan was not cancelled.
- Prior app and 1.1.4 DMG moved to macOS Trash, recoverable. Duplicate packaged app,
  blockmap and builder metadata also trashed; `dist` retains only 1.1.5 DMG.
  User database/settings were not deleted. Launch Services registered canonical
  `/Applications/Fly Safe.app`, not the temporary packaging copy.
