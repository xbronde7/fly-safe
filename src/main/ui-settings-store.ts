import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_UI_SETTINGS,
  UI_SETTINGS_SCHEMA_VERSION,
  mergeUiSettings,
  validateUiSettings,
  type UiSettings,
  type UiSettingsPatch,
  type UiSettingsSnapshot
} from '../shared/ui-settings'

interface PersistedUiSettingsDocument {
  schemaVersion: typeof UI_SETTINGS_SCHEMA_VERSION
  settings: UiSettings
  updatedAt: string
}

/**
 * Small local JSON store for UI preferences. Writes are atomic and the path is
 * selected by the main process, never by a renderer request.
 */
export class UiSettingsStore {
  readonly filePath: string
  readonly loadWarning: string | null

  private settings: UiSettings
  private updatedAt: string | null

  constructor(filePath: string, private readonly now: () => number = Date.now) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new TypeError('Invalid UI-settings path')
    }
    this.filePath = filePath
    const loaded = this.load()
    this.settings = loaded.settings
    this.updatedAt = loaded.updatedAt
    this.loadWarning = loaded.warning
  }

  get(): UiSettingsSnapshot {
    return {
      settings: { ...this.settings },
      updatedAt: this.updatedAt
    }
  }

  update(patchInput: unknown): UiSettingsSnapshot {
    const next = mergeUiSettings(this.settings, patchInput)
    const updatedAt = new Date(validClock(this.now)).toISOString()
    this.persist({
      schemaVersion: UI_SETTINGS_SCHEMA_VERSION,
      settings: next,
      updatedAt
    })
    this.settings = next
    this.updatedAt = updatedAt
    return this.get()
  }

  reset(): UiSettingsSnapshot {
    return this.update({ ...DEFAULT_UI_SETTINGS } satisfies UiSettingsPatch)
  }

  private load(): {
    settings: UiSettings
    updatedAt: string | null
    warning: string | null
  } {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const document = parsePersistedDocument(JSON.parse(raw))
      return {
        settings: document.settings,
        updatedAt: document.updatedAt,
        warning: null
      }
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          settings: { ...DEFAULT_UI_SETTINGS },
          updatedAt: null,
          warning: null
        }
      }
      return {
        settings: { ...DEFAULT_UI_SETTINGS },
        updatedAt: null,
        warning: 'Settings file is corrupted; safe defaults were applied.'
      }
    }
  }

  private persist(document: PersistedUiSettingsDocument): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      renameSync(temporaryPath, this.filePath)
    } catch (error) {
      rmSync(temporaryPath, { force: true })
      throw error
    }
  }
}

function parsePersistedDocument(value: unknown): PersistedUiSettingsDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid settings file')
  }
  const record = value as Record<string, unknown>
  const keys = new Set(['schemaVersion', 'settings', 'updatedAt'])
  if (Object.keys(record).some((key) => !keys.has(key))) {
    throw new TypeError('Settings file contains unknown fields')
  }
  if (record.schemaVersion !== UI_SETTINGS_SCHEMA_VERSION) {
    throw new TypeError('Unsupported settings version')
  }
  if (typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new TypeError('Invalid settings saved-at time')
  }
  return {
    schemaVersion: UI_SETTINGS_SCHEMA_VERSION,
    settings: validateUiSettings(record.settings),
    updatedAt: new Date(Date.parse(record.updatedAt)).toISOString()
  }
}

function validClock(clock: () => number): number {
  const timestamp = clock()
  if (!Number.isFinite(timestamp)) throw new TypeError('Invalid system clock')
  return timestamp
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
