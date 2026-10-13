# Fly Safe 1.1.14

Main release for Windows 10/11 x64 and macOS Apple Silicon.

- Windows: `Fly-Safe-Setup-1.1.14-x64.exe`.
- macOS: `Fly-Safe-1.1.14-arm64.dmg`.
- `SHA256SUMS.txt` contains checksums for both installers.

## Windows compatibility and storage fix

Concurrent writes to the same encrypted SSO-token file could fail on Windows
while another write changed its permissions. Storage operations are now ordered
per file, including reads and logout clears across multiple store adapters.
Temporary-file writes and atomic replacement are preserved. An earlier failed
write does not prevent later operations from succeeding.

Windows uses NTFS ACLs instead of POSIX mode bits. The complete regression suite
retains encryption, file contents, backup, validation, and storage checks on both
platforms; POSIX permission assertions run on macOS/Linux. Git checks out text
with LF endings consistently, keeping source-boundary checks portable.

## Release verification

The workflow runs all 869 tests, TypeScript checks, and production packaging on
both Windows and macOS. Windows also checks native SQLite in the packaged app,
silently installs the NSIS installer in the disposable CI runner, and repeats
the native SQLite check in the installed application. macOS DMG integrity is
verified before upload. Publication requires both platform jobs to succeed.

EVE SSO still requires the user's sign-in. Automated installer checks do not
claim a live authenticated game session.
