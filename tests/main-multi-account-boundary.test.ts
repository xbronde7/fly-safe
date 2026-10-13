import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/main/index.ts', import.meta.url)),
  'utf8'
)
const PRELOAD_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/preload/index.ts', import.meta.url)),
  'utf8'
)

describe('multi-character security boundary', () => {
  it('uses the encrypted per-character service and makes every local feature available', () => {
    expect(MAIN_SOURCE).toContain('new EveMultiAccountService({')
    for (const channel of ['status', 'connect', 'select', 'disconnect', 'remove']) {
      const marker = `ipcMain.handle('account:characters:${channel}'`
      const start = MAIN_SOURCE.indexOf(marker)
      expect(start, marker).toBeGreaterThan(-1)
      const end = MAIN_SOURCE.indexOf("ipcMain.handle('", start + marker.length)
      const body = MAIN_SOURCE.slice(start, end < 0 ? undefined : end)
      expect(body).toContain('assertProFeatureIpcEvent(event, PRO_FEATURES.characters)')
    }
    expect(MAIN_SOURCE).toContain('void feature')
    expect(MAIN_SOURCE).not.toContain('hasProFeature(')
  })

  it('does not initialize payment entitlement code', () => {
    expect(MAIN_SOURCE).not.toContain('new EntitlementService(')
    expect(MAIN_SOURCE).not.toContain('getActiveLicensedOwnerCharacterId(')
  })

  it('uses active character credentials for optional shared workspaces', () => {
    const start = MAIN_SOURCE.indexOf('sharedWorkspaceService = new SharedWorkspaceService({')
    const end = MAIN_SOURCE.indexOf('return sharedWorkspaceService', start)
    const block = MAIN_SOURCE.slice(start, end)
    expect(block).toContain('getAuthorizedSession: () => accountService?.getAuthorizedSession()')
    expect(block).toContain('getOwnerAuthorizedSession: () => accountService?.getAuthorizedSession()')
    expect(block).not.toContain('ownerCharacterId')
  })

  it('exposes only public snapshots through preload', () => {
    expect(PRELOAD_SOURCE).toContain("ipcRenderer.invoke('account:characters:status')")
    expect(PRELOAD_SOURCE).toContain("ipcRenderer.invoke('account:restore')")
    expect(PRELOAD_SOURCE).toContain("ipcRenderer.invoke('account:connect:cancel')")
    expect(PRELOAD_SOURCE).not.toContain('accessToken')
    expect(PRELOAD_SOURCE).not.toContain('refreshToken')
  })

  it('keeps restore and login cancellation available before sign-in completes', () => {
    for (const channel of ['account:restore', 'account:connect:cancel']) {
      const marker = `ipcMain.handle('${channel}'`
      const start = MAIN_SOURCE.indexOf(marker)
      expect(start, marker).toBeGreaterThan(-1)
      const end = MAIN_SOURCE.indexOf("ipcMain.handle('", start + marker.length)
      const body = MAIN_SOURCE.slice(start, end < 0 ? undefined : end)
      expect(body).toContain('assertUnlicensedIpcEvent(event)')
    }
  })
})
