import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8')
) as {
  build: {
    productName: string
    win: { extraFiles: Array<{ from: string; to: string }> }
    nsis: {
      guid: string
      include: string
      deleteAppDataOnUninstall: boolean
      shortcutName: string
    }
  }
}
const cleaner = readFileSync(
  join(projectRoot, 'scripts', 'windows-clean-uninstall.ps1'),
  'utf8'
)
const installerInclude = readFileSync(
  join(projectRoot, 'build', 'installer.nsh'),
  'utf8'
)

describe('Windows uninstall hygiene', () => {
  it('keeps a stable NSIS identity and removes app data on a real uninstall', () => {
    expect(packageJson.build.productName).toBe('Fly Safe')
    expect(packageJson.build.nsis).toMatchObject({
      guid: '702e68f0-3e12-547a-a38c-ac078bc9afc2',
      include: 'build/installer.nsh',
      deleteAppDataOnUninstall: true,
      shortcutName: 'Fly Safe'
    })
    expect(packageJson.build.win.extraFiles).toContainEqual({
      from: 'scripts/windows-clean-uninstall.ps1',
      to: 'windows-clean-uninstall.ps1'
    })
    expect(installerInclude).toContain('${ifNot} ${isUpdated}')
    expect(installerInclude).toContain('$LOCALAPPDATA\\eve-local-intel-updater')
  })

  it('makes legacy cleanup explicit, previewable and limited to exact product targets', () => {
    expect(cleaner).toContain('SupportsShouldProcess = $true')
    expect(cleaner).toContain("Read-Host 'Type DELETE to continue'")
    expect(cleaner).toContain("'eve-local-intel'")
    expect(cleaner).toContain("'Fly Safe'")
    expect(cleaner).toContain("'EVE Local Intel'")
    expect(cleaner).toContain("'eve-local-intel-updater'")
    expect(cleaner).toContain("$AppGuid = '702e68f0-3e12-547a-a38c-ac078bc9afc2'")
    expect(cleaner).toContain('Refusing to recurse into a reparse point')
    expect(cleaner).toContain('Windows MachineGuid will NOT be changed.')
    expect(cleaner).not.toContain('Remove-Item -Path $env:APPDATA')
    expect(cleaner).not.toContain('Remove-Item -Path $env:LOCALAPPDATA')
  })
})
