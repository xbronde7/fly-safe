# Fly Safe 1.1.8 verification

Date: 2026-10-03. macOS arm64, local unsigned build. No GitHub publication.

Includes price/automatic planning/history changes documented in
`INDUSTRY-1.1.7-VERIFICATION.md`, plus native-scan fixes:

- Cached contract indexing yields to native UI and abort IPC after each item.
  Contract progress is throttled to 250 ms; unchanged source winners reuse their
  production plans, individual offer economics are memoized until market refresh.
- Initial/final recipe loops yield between recipes. Renderer sort evaluates
  profitability once per row rather than per comparison.
- Missing blueprint offer/cost cannot create a positive repeat-profit quote,
  including BUY/SELL and mixed/historical material valuation.
- Daily-history loading starts for provisional visible rows, not just a completed
  scan. The requested history hub is pinned to that scan, not edited controls.

## Verification

- Typecheck and production build passed. 108 targeted tests passed in 9 files,
  including cached-index abort responsiveness and batched source-count checks.
- Full-suite status is NOT green: the previous 1.1.7 full run was 662 passed /
  137 failed outside industry/market-client/cache modules. No claim of a full
  clean repository suite for 1.1.8.
- Native installed 1.1.8 authenticated as Serg Xbronde: Industry 5, Advanced
  Industry 4, Accounting 4, sales tax 4.2%; journal preserved, 2378 deals observed.
- Native scan progressed beyond 33022/34274 public contracts without the former
  event-loop freeze. Provisional Packrat: contract #236476344, one-run BPC
  17800000 ISK, cost 26402495.59, BUY net -613135.59, SELL estimate +129024.41,
  duration 1.15 h. This is an ESI snapshot, not a committed trade/profit promise.
- CCP market briefly returned ESI 520 MktMarketOpening near daily downtime;
  public market responded HTTP 200 at 11:05:44 UTC. A later incomplete contract
  reply triggered bounded retries with provisional rows retained.
- No purchase, manufacturing, sale or contract acceptance was performed.
  Existing SSO access/persistence policy unchanged. No database/journal removal.
- `/Applications/Fly Safe.app` contains final 1.1.8; installed and packaged ASAR
  match `db7954e6969538646910ff4caf92390907898d4346d7738900a695dfc0f8f5bb`.
- Installer `dist/Fly-Safe-1.1.8-arm64.dmg`: hdiutil VALID; SHA256
  `f05cdd2fabe11404c093f1f05e9db220aa3b768ad0cabc42cd1358dbf3b2ec40`.
- Installed Electron native SQLite/industry IPC/planning/liquidity bundle smoke
  passed. Previous builds and build staging moved to recoverable macOS Trash.

Final native liquidity/UI check passed: daily volume (including 0, 0.03, 0.5/day)
and low-liquidity warnings appeared on provisional cards before completion.
The final build retained 2960 rows after ESI exhausted retries on an incomplete
JSON contract reply. 619 rows remained under the user's profitable/ready filters.
The whole-contract minimum was NOT confirmed; UI correctly states unfinished,
provisional scan. No claim of a successful complete public-contract pass.
Independent public request for contract #236637076 at 11:14:35 UTC confirmed
HTTP 200 with Content-Length 0 (empty JSON), X-ESI-Cache-Status HIT, Expires
12:04:57 UTC. This is malformed upstream cached data, not an invented blueprint
or zero-result calculation. The invalid response is not stored as a valid item
list; repeating before the upstream expiry may hit the same failure.
