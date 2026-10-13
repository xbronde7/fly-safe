# Fly Safe 1.1.12 verification — 2026-10-10

## Scope

Current Jita IV–4 valuation of actual manufactured output, and expandable complete
station BUY/SELL ladders in Market and finished goods. No trades, contracts or
manufacturing jobs are submitted. No new SSO scopes or persisted credentials.

## Checks completed

- `npm run build`: TypeScript and production renderer/main/preload build passed.
- 18 targeted Vitest files, **189 tests passed**. New coverage: complete depth
  sorting/grouping/deduplication/station scope/quantity independence, source cache
  timestamps and expiry, full-batch BUY limit pricing/partial depth/unknown costs,
  fees/losses, queue coalescing/concurrency/refresh/retry, Accounting character scope.
- Existing MarketService suite separately: 8 passed, 5 pre-existing failures from
  Russian error-string assertions against English validation messages. Validation
  behavior still rejects the inputs. This report does not claim the entire legacy
  suite is green.
- Isolated native Electron UI fixture, all non-file networking blocked: actual
  components show material 60 + BPC 20 + job 123 = 203 ISK cost for 20 items;
  full-batch BUY limit 15 gives 300 gross, 285 net, +82 against cost; SELL 30 gives
  600 gross, 552 net after fixture tax 5% + base broker 3%, +349 against cost.
- Modal opens from production and all five Market hub cards. Initial 25 levels
  each side, +50 pagination, cumulative quantities, order counts, Escape close,
  manual refresh verified. Screenshots inspected at 1360 and 600 px; all four
  table columns visible without horizontal scrolling for fixture values.
- Live unauthenticated ESI through the actual MarketService: Tritanium type 34,
  station 60003760, quantity 100, 25 BUY levels and 23 SELL levels, best BUY 3.69,
  best SELL 3.93 ISK; source 2026-10-10T17:38:32Z, expires 17:43:32Z. This is a
  transient validation snapshot, not a lasting price claim or recommendation.

## Limitations

SELL is a listing estimate, not guaranteed demand. BUY needs sufficient whole-batch
depth and uses one batch limit; other stations' ranged bids are not included.
Output quantity is produced quantity, not present stock. Accounting tax uses the
active character when known, otherwise labelled base 7.5%; broker uses labelled
base 3%, not personalized standings. ESI is cached upstream even on manual refresh.
Production costs may contain the existing labelled estimates. The offline fixture
and public API check do not prove authenticated history refresh; the installed
UI check below separately verifies saved real jobs and public live valuations.

## Packaging / installation

Electron 43.4.1 and unchanged native dependencies reused from installed application;
fresh production output repacked into ASAR, integrity header updated, ad-hoc signed.
Offline QA fixture excluded from package. Native SQLite checked in memory only.
Installed at `/Applications/Fly Safe.app`; native SQLite in-memory checks and
`codesign --verify --deep --strict` passed for staged and installed copies.
Staged and installed ASAR SHA256 match:
`f9faf1fe32e5786243ee4ce091d7f8b1796ac39b9d811239942f8c8cca1e9a8c`.
DMG `dist/Fly-Safe-1.1.12-arm64.dmg` SHA256:
`eb333ee031173c87185536a40dcce64bb432973cabb0c490dd054eff698d47bf`.
Previous 1.1.11 application/DMG and new disposable packaging metadata moved to
Trash, recoverable. User data directories were neither copied nor deleted.

Read-only check of the **actual industry database** `system-intel-cache.sqlite`
after install/start: quick_check `ok`, 4,120 wallet transactions, 190 industry
records; digest `c908ce0521b779765d614d5055ab9bf7ad9c8f9b10056cd76ce22387e2135683`
unchanged across the two post-start checks. Initial pre-install aggregate check
was accidentally against `intel-cache.sqlite` (empty industry tables), so it is
not claimed as a before/after industry digest comparison.

Native installed UI confirms version 1.1.12 and existing EVE session remained
connected, despite the conservative re-login warning before restart. Saved
finished jobs load, with live public market valuations. Example Vedmak: recorded
cost 63,498,779; BUY 64,020,000, net 59,218,500; SELL 70,440,000, estimated net
63,043,800 under the explicitly labelled base fees. Missing BPC cost does not hide
market value for other products. Current ESI jobs returned unavailable, and the UI
correctly says saved history is displayed; no successful fresh jobs sync claimed.
Live product modal verified: nine SELL and five BUY levels, quantities, cumulative
quantities and order counts. No purchase, order placement or cost edit performed.
Installed Market UI also verified via native accessibility: search/select Tritanium,
all five hub cards loaded, Jita modal opens with 23 SELL and 25 BUY levels, including
deep prices beyond the best quote and grouped order counts. Left the live modal open
for the user. The synthetic fixture never supplied data to the installed application.
