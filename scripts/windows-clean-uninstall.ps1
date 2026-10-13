#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProductName = 'Fly Safe'
$LegacyProductName = 'EVE Local Intel'
$KnownProductNames = @($ProductName, $LegacyProductName)
$KnownExeNames = @('Fly Safe.exe', 'EVE Local Intel.exe')
$AppGuid = '702e68f0-3e12-547a-a38c-ac078bc9afc2'
$InstallRegistrySubKey = "Software\$AppGuid"
$UninstallRegistrySubKey =
    "Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppGuid"

$FileTargets = @()
$FileIndex = @{}
$RegistryTargets = @()
$InstallLocations = @()
$UnsafeInstallLocations = @()
$Failures = @()

function Normalize-AbsolutePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    try {
        if (-not [IO.Path]::IsPathRooted($Path)) {
            return $null
        }

        $result = [IO.Path]::GetFullPath($Path)
        if ($result.Length -gt 3) {
            $result = $result.TrimEnd([char[]]"\/")
        }
        return $result
    }
    catch {
        return $null
    }
}

function Add-FileTarget {
    param(
        [string]$Path,
        [string]$Category,
        [string]$Source
    )

    $normalized = Normalize-AbsolutePath $Path
    if ($null -eq $normalized) {
        return
    }

    if (-not $FileIndex.ContainsKey($normalized)) {
        $FileIndex[$normalized] = $true
        $script:FileTargets += [pscustomobject]@{
            Path = $normalized
            Category = $Category
            Source = $Source
        }
    }
}

$KnownInstallDirs = @()
if ($env:LOCALAPPDATA) {
    $KnownInstallDirs += (Join-Path $env:LOCALAPPDATA 'Programs\Fly Safe')
    $KnownInstallDirs += (Join-Path $env:LOCALAPPDATA 'Programs\EVE Local Intel')
}
if ($env:ProgramFiles) {
    $KnownInstallDirs += (Join-Path $env:ProgramFiles 'Fly Safe')
    $KnownInstallDirs += (Join-Path $env:ProgramFiles 'EVE Local Intel')
}
if (${env:ProgramFiles(x86)}) {
    $KnownInstallDirs += (Join-Path ${env:ProgramFiles(x86)} 'Fly Safe')
    $KnownInstallDirs += (Join-Path ${env:ProgramFiles(x86)} 'EVE Local Intel')
}

$KnownInstallDirs = @(
    $KnownInstallDirs |
        ForEach-Object { Normalize-AbsolutePath $_ } |
        Where-Object { $null -ne $_ } |
        Select-Object -Unique
)

foreach ($path in $KnownInstallDirs) {
    Add-FileTarget $path 'Install' 'Known NSIS install directory'
}

# Read only this application's exact electron-builder GUID keys.
$Hives = @(
    [Microsoft.Win32.RegistryHive]::CurrentUser,
    [Microsoft.Win32.RegistryHive]::LocalMachine
)
$Views = @(
    [Microsoft.Win32.RegistryView]::Registry64,
    [Microsoft.Win32.RegistryView]::Registry32
)

foreach ($hive in $Hives) {
    foreach ($view in $Views) {
        $baseKey = $null
        try {
            $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            foreach ($entry in @(
                [pscustomobject]@{ SubKey = $InstallRegistrySubKey; Kind = 'Install metadata' },
                [pscustomobject]@{ SubKey = $UninstallRegistrySubKey; Kind = 'Uninstall metadata' }
            )) {
                $key = $null
                try {
                    $key = $baseKey.OpenSubKey($entry.SubKey, $false)
                    if ($null -eq $key) {
                        continue
                    }

                    $RegistryTargets += [pscustomobject]@{
                        Hive = $hive
                        View = $view
                        SubKey = $entry.SubKey
                        Kind = $entry.Kind
                    }

                    $installLocation = [string]$key.GetValue('InstallLocation', '')
                    if (-not [string]::IsNullOrWhiteSpace($installLocation)) {
                        $InstallLocations += $installLocation
                    }

                    $displayIcon = ([string]$key.GetValue('DisplayIcon', '')).Trim()
                    if ($displayIcon.EndsWith(',0')) {
                        $iconPath = $displayIcon.Substring(0, $displayIcon.Length - 2).Trim().Trim('"')
                        if ([IO.Path]::GetFileName($iconPath) -ieq $ExeName) {
                            $InstallLocations += [IO.Path]::GetDirectoryName($iconPath)
                        }
                    }
                }
                finally {
                    if ($null -ne $key) {
                        $key.Dispose()
                    }
                }
            }
        }
        catch {
            # A registry view may be unavailable or require elevation.
        }
        finally {
            if ($null -ne $baseKey) {
                $baseKey.Dispose()
            }
        }
    }
}

function Test-SafeRegistryInstallDirectory {
    param([string]$Path)

    $normalized = Normalize-AbsolutePath $Path
    if ($null -eq $normalized) {
        return $false
    }

    foreach ($known in $KnownInstallDirs) {
        if ($normalized -ieq $known) {
            return $true
        }
    }

    # Custom paths require the exact leaf and multiple app markers.
    if ($KnownProductNames -notcontains ([IO.Path]::GetFileName($normalized))) {
        return $false
    }

    $asar = Join-Path $normalized 'resources\app.asar'
    $exeMatches = $false
    $uninstallerMatches = $false

    foreach ($exeName in $KnownExeNames) {
        $exe = Join-Path $normalized $exeName
        if (Test-Path -LiteralPath $exe -PathType Leaf) {
            try {
                $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
                if ($KnownProductNames -contains $versionInfo.ProductName) {
                    $exeMatches = $true
                }
            }
            catch {
                # Keep checking other known executable names.
            }
        }
    }
    foreach ($knownProductName in $KnownProductNames) {
        if (Test-Path -LiteralPath (Join-Path $normalized "Uninstall $knownProductName.exe") -PathType Leaf) {
            $uninstallerMatches = $true
        }
    }

    return $exeMatches -and (
        (Test-Path -LiteralPath $asar -PathType Leaf) -or
        $uninstallerMatches
    )
}

foreach ($path in ($InstallLocations | Select-Object -Unique)) {
    $normalized = Normalize-AbsolutePath $path
    if ($null -ne $normalized -and (Test-SafeRegistryInstallDirectory $normalized)) {
        Add-FileTarget $normalized 'Install' 'Exact NSIS registry key'
    }
    elseif ($null -ne $normalized) {
        $UnsafeInstallLocations += $normalized
    }
}

# Electron userData: license, EVE SSO, Chromium data and SQLite databases.
if ($env:APPDATA) {
    Add-FileTarget (Join-Path $env:APPDATA 'eve-local-intel') 'User data' 'package.json name'
    Add-FileTarget (Join-Path $env:APPDATA 'Fly Safe') 'User data' 'Electron product name'
    Add-FileTarget (Join-Path $env:APPDATA 'EVE Local Intel') 'User data' 'Legacy product name'
    Add-FileTarget `
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Fly Safe.lnk') `
        'Shortcut' `
        'Taskbar shortcut'
    Add-FileTarget `
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\EVE Local Intel.lnk') `
        'Shortcut' `
        'Legacy taskbar shortcut'
}
if ($env:LOCALAPPDATA) {
    Add-FileTarget `
        (Join-Path $env:LOCALAPPDATA 'eve-local-intel-updater') `
        'Updater cache' `
        'electron-builder updater cache'
}

$ShortcutFolders = @(
    [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)
)
foreach ($folder in $ShortcutFolders) {
    if (-not [string]::IsNullOrWhiteSpace($folder)) {
        Add-FileTarget (Join-Path $folder 'Fly Safe.lnk') 'Shortcut' 'NSIS shortcut'
        Add-FileTarget (Join-Path $folder 'EVE Local Intel.lnk') 'Shortcut' 'Legacy NSIS shortcut'
    }
}

$Processes = @(Get-Process -Name $KnownProductNames -ErrorAction SilentlyContinue)
$PresentFileTargets = @($FileTargets | Where-Object { Test-Path -LiteralPath $_.Path })

Write-Host ''
Write-Host 'Fly Safe full cleanup'
Write-Host 'The following exact targets will be removed:'
foreach ($process in $Processes) {
    Write-Host "  PROCESS PID $($process.Id): $($process.ProcessName)"
}
foreach ($target in $PresentFileTargets) {
    Write-Host "  $($target.Category): $($target.Path)"
}
foreach ($target in $RegistryTargets) {
    Write-Host "  REGISTRY $($target.Hive)/$($target.View): $($target.SubKey)"
}
if ($UnsafeInstallLocations.Count -gt 0) {
    Write-Warning 'These registry paths were refused as unsafe:'
    foreach ($path in $UnsafeInstallLocations) {
        Write-Warning "  $path"
    }
}

if ($Processes.Count -eq 0 -and $PresentFileTargets.Count -eq 0 -and $RegistryTargets.Count -eq 0) {
    Write-Host 'No Fly Safe targets found.'
    exit 0
}

Write-Warning 'User data, license, EVE SSO tokens and local databases will be deleted.'
Write-Warning 'Windows MachineGuid will NOT be changed.'
if (-not $Force -and -not $WhatIfPreference) {
    $answer = Read-Host 'Type DELETE to continue'
    if ($answer -cne 'DELETE') {
        Write-Host 'Cancelled. Nothing was changed.'
        exit 2
    }
}

foreach ($process in $Processes) {
    if ($PSCmdlet.ShouldProcess("PID $($process.Id) ($($process.ProcessName))", 'Stop process')) {
        try {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
        }
        catch {
            $Failures += "Could not stop PID $($process.Id): $($_.Exception.Message)"
        }
    }
}

$InstallRemovalFailed = $UnsafeInstallLocations.Count -gt 0
foreach ($target in $PresentFileTargets) {
    if ($PSCmdlet.ShouldProcess($target.Path, "Remove $($target.Category)")) {
        try {
            $item = Get-Item -LiteralPath $target.Path -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Refusing to recurse into a reparse point'
            }
            Remove-Item -LiteralPath $target.Path -Recurse -Force -ErrorAction Stop
        }
        catch {
            $Failures += "Could not remove $($target.Path): $($_.Exception.Message)"
            if ($target.Category -eq 'Install') {
                $InstallRemovalFailed = $true
            }
        }
    }
}

function Remove-ExactRegistryTarget {
    param($Target)

    $baseKey = $null
    $parentKey = $null
    try {
        $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Target.Hive, $Target.View)
        $separator = $Target.SubKey.LastIndexOf('\')
        $parentPath = $Target.SubKey.Substring(0, $separator)
        $leafName = $Target.SubKey.Substring($separator + 1)
        $parentKey = $baseKey.OpenSubKey($parentPath, $true)
        if ($null -ne $parentKey) {
            $parentKey.DeleteSubKeyTree($leafName, $false)
        }
    }
    finally {
        if ($null -ne $parentKey) {
            $parentKey.Dispose()
        }
        if ($null -ne $baseKey) {
            $baseKey.Dispose()
        }
    }
}

# Keep registry recovery pointers when an installation directory could not be removed safely.
if ($InstallRemovalFailed) {
    Write-Warning 'Install cleanup was incomplete; registry keys were preserved.'
}
else {
    foreach ($target in $RegistryTargets) {
        $description = "$($target.Hive)/$($target.View)/$($target.SubKey)"
        if ($PSCmdlet.ShouldProcess($description, 'Remove registry key')) {
            try {
                Remove-ExactRegistryTarget $target
            }
            catch {
                $Failures += "Could not remove registry key ${description}: $($_.Exception.Message)"
            }
        }
    }
}

if ($Failures.Count -gt 0) {
    Write-Warning 'Cleanup completed with errors:'
    foreach ($failure in $Failures) {
        Write-Warning "  $failure"
    }
    exit 1
}

Write-Host 'Cleanup completed.'
