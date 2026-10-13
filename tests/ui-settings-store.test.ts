import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UiSettingsStore } from '../src/main/ui-settings-store'
import { DEFAULT_UI_SETTINGS } from '../src/shared/ui-settings'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

function settingsPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fly-safe-settings-'))
  temporaryDirectories.push(directory)
  return join(directory, 'ui-settings.json')
}

describe('UiSettingsStore', () => {
  it('uses defaults without creating a file until the first update', () => {
    const filePath = settingsPath()
    const store = new UiSettingsStore(filePath)
    expect(store.get()).toEqual({ settings: DEFAULT_UI_SETTINGS, updatedAt: null })
    expect(store.loadWarning).toBeNull()
    expect(existsSync(filePath)).toBe(false)
  })

  it('persists an atomic, versioned JSON document across restarts', () => {
    const filePath = settingsPath()
    const timestamp = Date.parse('2026-08-25T05:06:07.000Z')
    const first = new UiSettingsStore(filePath, () => timestamp)
    const saved = first.update({
      scalePercent: 140,
      density: 'compact',
      soundVolumePercent: 55,
      backgroundNotificationsEnabled: false,
      minimizeToTray: false,
      currentSystemPollSeconds: 50,
      pilotContextPollSeconds: 180
    })

    expect(saved.updatedAt).toBe('2026-08-25T05:06:07.000Z')
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      settings: saved.settings,
      updatedAt: saved.updatedAt
    })

    const reopened = new UiSettingsStore(filePath)
    expect(reopened.get()).toEqual(saved)
    expect(reopened.loadWarning).toBeNull()
  })

  it('falls back safely when JSON is corrupt and replaces it on save', () => {
    const filePath = settingsPath()
    writeFileSync(filePath, '{ definitely-not-json', 'utf8')
    const store = new UiSettingsStore(filePath, () => 1_000)
    expect(store.get().settings).toEqual(DEFAULT_UI_SETTINGS)
    expect(store.loadWarning).toContain('corrupted')

    store.update({ soundVolumePercent: 50 })
    expect(() => JSON.parse(readFileSync(filePath, 'utf8'))).not.toThrow()
  })

  it('validates input again even after the IPC boundary', () => {
    const store = new UiSettingsStore(settingsPath())
    expect(() => store.update({ scalePercent: 500 })).toThrow('UI scale')
    expect(() => store.update({ token: 'secret' })).toThrow('unknown fields')
  })
})
