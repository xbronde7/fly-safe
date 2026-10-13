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
const RENDERER_ENTRY_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/main.tsx', import.meta.url)),
  'utf8'
)

describe('free edition IPC boundary', () => {
  it('keeps trusted IPC and EVE SSO checks without license or subscription handlers', () => {
    const handlers = [...MAIN_SOURCE.matchAll(/ipcMain\.handle\('([^']+)'/g)]
    expect(handlers.length).toBeGreaterThanOrEqual(20)

    for (let index = 0; index < handlers.length; index += 1) {
      const channel = handlers[index][1]
      const start = handlers[index].index ?? 0
      const end = handlers[index + 1]?.index ?? MAIN_SOURCE.indexOf('\n}', start)
      const body = MAIN_SOURCE.slice(start, end)

      expect(channel.startsWith('license:'), channel).toBe(false)
      expect(channel.startsWith('subscription:'), channel).toBe(false)
      if (channel.startsWith('account:characters:')) {
        expect(body, channel).toContain('assertProFeatureIpcEvent(event')
      } else if (channel.startsWith('account:')) {
        expect(body, channel).toContain('assertUnlicensedIpcEvent(event)')
      } else {
        expect(
          body.includes('assertTrustedIpcEvent(event)') ||
          body.includes('assertProFeatureIpcEvent(event'),
          channel
        ).toBe(true)
      }
    }
  })

  it('initializes local services before showing the application shell', () => {
    const readyBlock = MAIN_SOURCE.slice(MAIN_SOURCE.indexOf('app.whenReady()'))
    expect(readyBlock.indexOf('ensureAccountServicesInitialized()')).toBeLessThan(
      readyBlock.indexOf('ensureServicesInitialized()')
    )
    expect(readyBlock.indexOf('ensureServicesInitialized()')).toBeLessThan(
      readyBlock.indexOf('registerIpcHandlers()')
    )
    expect(readyBlock.indexOf('registerIpcHandlers()')).toBeLessThan(
      readyBlock.indexOf('createWindow()')
    )
    expect(MAIN_SOURCE).toContain("throw new Error('Sign in through an EVE Online character is required')")
    expect(MAIN_SOURCE).not.toContain('initializeLicenseService()')
    expect(MAIN_SOURCE).not.toContain('new EntitlementService(')
  })

  it('does not expose license or subscription IPC through preload', () => {
    expect(PRELOAD_SOURCE).not.toContain("ipcRenderer.invoke('license:")
    expect(PRELOAD_SOURCE).not.toContain("ipcRenderer.invoke('subscription:")
    expect(PRELOAD_SOURCE).toContain("ipcRenderer.invoke('account:status')")
    expect(PRELOAD_SOURCE).toContain("ipcRenderer.invoke('account:connect')")
    expect(RENDERER_ENTRY_SOURCE).toContain("import LicensedApp from './LicensedApp'")
    expect(RENDERER_ENTRY_SOURCE).toContain('<LicensedApp />')
  })

  it('does not expose the removed WH-map IPC surface', () => {
    for (const source of [MAIN_SOURCE, PRELOAD_SOURCE]) {
      expect(source).not.toContain('wormhole-map:')
      expect(source).not.toContain('wormhole-collaboration:')
      expect(source).not.toContain('wormhole-location-tracker:')
    }
  })
})
