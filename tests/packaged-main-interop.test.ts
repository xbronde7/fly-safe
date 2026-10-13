import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/main/index.ts', import.meta.url)),
  'utf8'
)

describe('packaged main-process module interop', () => {
  it('avoids the crashing named import from CommonJS electron-updater', () => {
    // Auto-updating is no longer initialized by the main process. Keep the
    // interoperability regression guard without requiring the removed feature.
    expect(MAIN_SOURCE).not.toContain("import { autoUpdater } from 'electron-updater'")
  })
})
