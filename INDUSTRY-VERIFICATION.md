# Verification — Fly Safe 1.1.3 manufacturing radar

Date: 2026-09-30. Target: macOS arm64.

- `npm run typecheck`: passed, Node and renderer TypeScript configurations.
- `npm run build`: passed, main/preload/renderer production bundles.
- Targeted industry/SSO/market tests: **80 passed**, including **51 new tests**.
  The SSO loopback tests require permission to bind localhost port 53173.
- Full suite under the filesystem/network sandbox: **613 passed, 139 failed**.
  A pristine copy of the original source produced **562 passed, the same 139 failed**.
  Exact failed test-name sets were compared: **no newly failing tests**. Existing
  failures include outdated Russian-text expectations against English UI and
  sandbox-blocked network/listener tests. No unrelated tests were rewritten.
- UI: rendered actual components with clearly marked demonstration prices and
  visually checked the complete form and opportunity card in the in-app browser.
  This does not count as a live-character production/profit validation.
- Bundled data: CCP SDE build 3561556, released 2026-09-30; 4035 manufacturing
  recipes, active-skill requirements and dogma time modifiers.
- DMG packaging completed using the already-installed official Electron 43.4.1
  runtime. DMG creation required macOS `hdiutil` outside the filesystem sandbox.
  No Apple Developer ID certificate is available; this is a locally built,
  unsigned installer, not a notarized public release.

Artifact: `dist/Fly-Safe-1.1.3-arm64.dmg`.

- `hdiutil verify`: checksum **VALID**.
- SHA-256: `518516b9ef57382a8b405669b89dba6a751b12ecfd8e7fc476d6d1ee3d83f98e`.
- Installed app ASAR SHA-256 matches the newly packaged app:
  `63c2938652682eeb8090df0084223a7582649ff696dc36e0cabff571e608ade9`.
- Installed Electron smoke test: 1.1.3, SQLite `SELECT 1` passed and
  the optional-duration fix is present in the packaged main process.
- Full live public The Forge market check: **405 pages, 404763 unique orders**,
  loaded in 34.3 seconds. All **1741** marketable recipes computed; **1533** had
  complete first-run pricing. Test skill levels match the last visible character
  UI (Industry 5, Advanced Industry 3, Accounting 4); no SSO token was used.
  The transient invalid duration was not reproduced in this current book. Zero,
  absent, null, negative, fractional and string duration metadata are tested;
  descriptive duration does not invalidate safe executable price/volume fields.
- Read-only live ESI checks: The Forge public contracts has **35 list pages**;
  contract `235641669` returned a real copy with ME 0, TE 0 and 2 runs. This
  confirms the fields; it does not prove a current Packrat offer or profit.
- Contract-only Packrat blueprint **33701** exists in the bundled catalog.
- UI preview verified blueprint name, costs, all required/current skills,
  per-unit material prices and expanded profit formula. Demo quotes are marked
  as such and are not a trading signal.

The installed `/Applications/Fly Safe.app` is now version **1.1.3**. The previous
app was closed and moved to Trash before replacement. Old legacy `dist` (5.7 GB),
legacy `out`, old installers, duplicate packaged app and temporary builder files
were also moved to Trash. The old 1.1.0 mounted installer volume was ejected.
LaunchServices registers the `/Applications` copy; Dock had no pinned Fly Safe
entry to repair. Personal data in `Library/Application Support/eve-local-intel`
was preserved. Sources, dependencies and tests are retained for future work.
No GitHub release, commit or push was made.
After relaunch the app displays the sign-in screen: its existing macOS policy
keeps the SSO session only until app exit to avoid a Keychain prompt. The user
must sign in again; no token-storage/security policy was changed for this update.

1.1.2/1.1.3 refinements: per-run BPC cost = full contract price / available runs,
upfront purchase capital shown separately; invalid efficiency skips only the
proposal, partial quotes survive failures, scan failures remain visible during
character refresh, and ESI rate-limit waits are bounded/cancellable. The actual
user failure at contract 2655 was `invalid contract ME`, not assumed to be a 429.

The user had already connected the new permissions in 1.1.0: the native UI showed
active Industry 5, Advanced Industry 3, Accounting 4 and five jobs for the character.
No passwords, raw refresh tokens or production transactions were accessed to work
around authentication. Full live contract indexing and a confirmed Packrat
minimum/profit have not been verified; first indexing is intentionally explicit,
progressive and cancellable rather than a hidden blocking startup task.
