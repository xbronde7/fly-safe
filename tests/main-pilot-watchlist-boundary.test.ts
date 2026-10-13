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

describe('pilot watchlist desktop boundary', () => {
  it('keeps the watchlist in a dedicated persistent database outside cache clearing', () => {
    expect(MAIN_SOURCE).toContain("join(userDataDirectory, 'pilot-watchlist.sqlite')")
    expect(MAIN_SOURCE).toContain('new PilotWatchlistStore(pilotWatchlistDatabasePath)')
    expect(MAIN_SOURCE).toContain('pilotWatchlistStore?.close()')

    const clearStart = MAIN_SOURCE.indexOf("ipcMain.handle('cache:clear'")
    const clearEnd = MAIN_SOURCE.indexOf("ipcMain.handle('app:status'", clearStart)
    expect(MAIN_SOURCE.slice(clearStart, clearEnd)).not.toContain('pilotWatchlist')
  })

  it('exposes only narrow validated watchlist IPC methods', () => {
    for (const channel of [
      'pilot-watchlist:list',
      'pilot-watchlist:upsert',
      'pilot-watchlist:remove'
    ]) {
      expect(MAIN_SOURCE).toContain(`ipcMain.handle('${channel}'`)
      expect(PRELOAD_SOURCE).toContain(`ipcRenderer.invoke('${channel}'`)
    }
    expect(MAIN_SOURCE).toContain('parsePilotWatchlistUpsertRequest(request)')
    expect(MAIN_SOURCE).toContain('parsePilotWatchlistRemoveRequest(request)')
  })
})
