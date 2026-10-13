# Fly Safe 1.1.13 verification — 2026-10-11

## Scope

Manual profit search now plans long multi-run production across nine lines;
the opt-in background BPC monitor remains single-run. No trade, contract purchase,
manufacturing submission, new SSO scope or database migration is introduced.

## Completed checks

- `npm run build`: TypeScript plus main/preload/renderer production builds passed.
- Nineteen targeted Vitest files, **203 tests passed**. Includes thirteen new mass
  planner cases and a main-service integration test. Legacy entire-suite status
  is not claimed; previous MarketService language-assertion failures are unrelated.
- Nine actual BPC instances give nine 35-run jobs, 3,150 output units, 23.8-hour
  wall time and 214.2 slot-hours in synthetic inputs. One blueprint is never
  replicated across lines; market BPO capacity follows actual order quantity.
- Joint resources/BUY/demand are shared, entire baskets repriced at common limits,
  whole-run shrinking respects budget/depth, transport is charged once. Rare,
  stale or unknown demand cannot confirm a mass plan. Full-copy purchase must
  be recovered by first-cycle cash profit, not just amortized economic profit.
- A deep joke bid does not hide a viable long profitable boundary batch; minimum
  runs/hours prevent fallback to the lucrative isolated single run.
- Main scan integration verifies nine distinct contract IDs, excludes a two-copy
  bundled contract, retains actual long-run factory comparison and full BPC cash
  outlay, and keeps a subsequent monitor scan one-run with no mass plan.
- Strict mass validation, skill capacity, ready/occupied and unknown slots,
  monitor option stripping and unchanged character isolation tested.
- Isolated native Electron fixture: all non-file network blocked. Actual
  IndustryWorkspace shows default nine lines and one-run monitor; scan returns
  nine distinct long jobs, shared Multibuy quantities and all-cycle totals.
  Changing budget marks results stale; a new scan respects the joint 5,000 ISK
  fixture budget. Copying factory settings into monitor strips mass options and
  keeps it disabled. Screenshots inspected at 1360 and 600 px; document has no
  horizontal overflow (line table has its own horizontal scroll on narrow screens).

## Limits

Bounded greedy selection: sixteen offers per blueprint type, eighty eligible
sources overall, not a guaranteed global optimum. Default 24-hour horizon,
minimum four hours/two runs per job, maximum 25% of lower 7/30-day regional
average scaled by cycle days (at least one day), at least five active trade days.
History is regional, not station-specific demand. BUY is a snapshot, not a future
price guarantee; SELL is only a listing estimate. Unknown history excludes the
product from the common plan. Unfilled lines are reported, not multiplied.
Logistics duration/route/blueprint freight volume are not estimated. Existing
stock does not reduce the new material-purchase budget. Own BPOs need readable
jobs to confirm availability. New BPO/full contract prices are charged upfront.

## Packaging / installation

Installed Electron 43.4.1 and unchanged native dependencies reused; new output
repacked into ASAR, integrity header updated, ad-hoc signed. Offline QA fixture
excluded. Staged and installed native SQLite memory smoke checks and
`codesign --verify --deep --strict` passed. Installed `/Applications/Fly Safe.app`.
Public SSO client ID unchanged. Previous app and 1.1.12 DMG moved to recoverable
Trash; user data directories untouched.

Staged/installed ASAR SHA256:
`e11c6d733969f5260f350b38b9568a33112fa37e9283fa0be14c1dc165e5e44e`.
`dist/Fly-Safe-1.1.13-arm64.dmg` SHA256:
`eedf02bf94a91e22beec902eb73482b4fceff26263fca2d96cbbc040dd82343c`.

Read-only check of actual industry DB `system-intel-cache.sqlite` immediately
before and after installation: quick_check `ok`, 4,304 wallet transactions,
198 industry records, unchanged records digest
`c8dc9b263689209cccdd5c9c07e9aa266de1c0412b4435b45ba46f71ab711df3`.
This comparison is before restarting the new app, so normal subsequent ESI
captures/notifications are not falsely claimed to leave the database unchanged.

## Installed UI / authenticated limit

Native UI confirms installed version 1.1.13, restored basic EVE SSO session for
the existing character, 4,304 saved wallet deals, Jita default, nine lines,
24-hour cycle, four-hour/two-run minimums and single-run monitor description.
Existing monitor enabled preference was preserved, not changed by QA.
The restored token lacks the three industry scopes (`esi-skills.read_skills.v1`,
`esi-characters.read_blueprints.v1`, `esi-industry.read_character_jobs.v1`).
Manual scan correctly remains disabled instead of assuming zero skills or fake
capacity. No successful authenticated live mass scan is claimed. The user must
use the industry-permissions SSO button to authorize that token; no grant or
credential change was performed automatically. Offline/service tests above
verify the algorithm independently of this authorization limitation.
