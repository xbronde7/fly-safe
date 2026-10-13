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

GitHub Actions runs the full regression suite, rebuilds the macOS Apple Silicon installer from this source,
publishes it as `v1.1.13`, and includes its SHA-256 checksum.
A rebuilt DMG is a new build and is not expected to match the original local DMG
bit for bit. The Windows workflow runs the complete regression suite on Windows,
builds the x64 NSIS installer, and checks native SQLite in both the packaged app
and a silent installation. It publishes `Fly-Safe-Setup-1.1.13-x64.exe`, updates
checksums for both platforms, and makes 1.1.13 the latest stable release.

POSIX permission assertions apply on macOS/Linux. Windows uses NTFS ACLs rather
than POSIX mode bits; file-kind, encryption, contents, backup, and atomic-write
checks continue to run on both platforms.

Original recovered DMG SHA-256 (for archive identification only):
`eedf02bf94a91e22beec902eb73482b4fceff26263fca2d96cbbc040dd82343c`.
