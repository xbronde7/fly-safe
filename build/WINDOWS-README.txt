Fly Safe 0.10.1 - Windows x64 public installer

INSTALL
1. Download Fly-Safe-Setup-0.10.1-x64.exe from the official release location.
2. Verify that Windows shows the expected Fly Safe Authenticode publisher.
3. Run the installer. An unsigned or unexpected publisher is not a valid release.

NSIS INTEGRITY ERROR
The installer was damaged or changed during transfer. Delete that copy and download
the same public installer again. Portable ZIP builds are not public distribution artifacts.

FULL CLEANUP OF AN OLD OR BROKEN INSTALL
Open PowerShell where windows-clean-uninstall.ps1 is stored and preview exact targets:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows-clean-uninstall.ps1 -WhatIf

Run cleanup:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows-clean-uninstall.ps1

The script lists exact paths and requires typing DELETE. Program files, app profile,
encrypted license, EVE SSO token, local databases, shortcuts, updater cache and exact
application registry keys are removed. Windows MachineGuid is never changed.

DATA LOCATIONS
  %LOCALAPPDATA%\Programs\Fly Safe
  %APPDATA%\eve-local-intel
  %APPDATA%\EVE Local Intel (legacy)
  %LOCALAPPDATA%\eve-local-intel-updater

IMPORTANT
The ELI device code is calculated from Windows MachineGuid and remains the same after cleanup.
This does not mean the encrypted license remains installed.
