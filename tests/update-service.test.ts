import { EventEmitter } from 'node:events'
import type { AppUpdater } from 'electron-updater'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoUpdateService } from '../src/main/update-service'

class FakeUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  autoRunAppAfterInstall = false
  allowDowngrade = true
  allowPrerelease = true
  disableWebInstaller = false
  checkForUpdates = vi.fn(async () => null)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AutoUpdateService', () => {
  it('stays disabled in unpackaged development builds', async () => {
    const updater = new FakeUpdater()
    const service = new AutoUpdateService({
      updater: updater as unknown as AppUpdater,
      packaged: false
    })

    expect(service.start()).toMatchObject({ state: 'disabled' })
    expect(await service.check()).toMatchObject({ state: 'disabled' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('downloads signed releases automatically and reports progress', async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const service = new AutoUpdateService({
      updater: updater as unknown as AppUpdater,
      packaged: true
    })

    expect(service.start()).toMatchObject({ state: 'idle' })
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.disableWebInstaller).toBe(true)

    updater.emit('update-available', { version: '1.2.0' })
    updater.emit('download-progress', { percent: 52.5 })
    expect(service.status()).toMatchObject({
      state: 'downloading',
      version: '1.2.0',
      progressPercent: 52.5
    })

    updater.emit('update-downloaded', { version: '1.2.0' })
    expect(service.status()).toMatchObject({
      state: 'downloaded',
      version: '1.2.0',
      progressPercent: 100
    })
    service.dispose()
  })
})
