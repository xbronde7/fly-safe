# Fly Safe 1.1.13 — restored source publication

Recovered from the local development archive dated 2026-10-11 and prepared for
publication on 2026-10-13, with the regression suite repaired before publication.

## Validation on the restored source

- TypeScript main/preload and renderer checks: passed.
- Electron Vite production builds: passed.
- Full Vitest suite: **867 tests passed across all 117 files**, with no skipped tests.
  The run includes real local SSO callback and port-reuse tests with localhost
  permitted. Their initial failures were caused by sandbox restrictions.
- Updated obsolete Russian UI/error-message expectations to the existing English
  interface while retaining behavior, validation, token redaction, and storage
  checks. Updated English singular/plural expectations and the removed updater's
  import-regression guard without reintroducing the removed feature.
- Fixed singular asset quantities in the finance UI (`1 unit` rather than
  `1 units`), including per-location quantities.
- Original local macOS DMG integrity and installed native SQLite memory smoke:
  passed during recovery.

## Distribution

This historical macOS preview was rebuilt from the restored source and published
as `v1.1.13`. Windows compatibility and ordered token-storage fixes are included
in the subsequent main release [1.1.14](PUBLISH-1.1.14.md).

Original recovered DMG SHA-256 (for archive identification only):
`eedf02bf94a91e22beec902eb73482b4fceff26263fca2d96cbbc040dd82343c`.
