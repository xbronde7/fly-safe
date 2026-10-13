export const UI_SETTINGS_SCHEMA_VERSION = 1 as const

export const UI_SCALE_RANGE = {
  min: 100,
  max: 160,
  step: 5
} as const

export const SOUND_VOLUME_RANGE = {
  min: 0,
  max: 100,
  step: 5
} as const

export const CURRENT_SYSTEM_POLL_RANGE = {
  min: 20,
  max: 300,
  step: 10
} as const

export const PILOT_CONTEXT_POLL_RANGE = {
  min: 60,
  max: 900,
  step: 30
} as const

export type UiDensity = 'comfortable' | 'compact'

export interface UiSettings {
  scalePercent: number
  density: UiDensity
  soundVolumePercent: number
  backgroundNotificationsEnabled: boolean
  minimizeToTray: boolean
  currentSystemPollSeconds: number
  pilotContextPollSeconds: number
}

export type UiSettingsPatch = Partial<UiSettings>

export interface UiSettingsUpdateRequest {
  patch: UiSettingsPatch
}

export interface UiSettingsSnapshot {
  settings: UiSettings
  /** Null until the defaults are explicitly saved for the first time. */
  updatedAt: string | null
}

/** Deliberately kept separate from the broad application bridge. */
export interface UiSettingsApi {
  getUiSettings(): Promise<UiSettingsSnapshot>
  updateUiSettings(request: UiSettingsUpdateRequest): Promise<UiSettingsSnapshot>
}

export const DEFAULT_UI_SETTINGS: Readonly<UiSettings> = Object.freeze({
  scalePercent: 100,
  density: 'comfortable',
  soundVolumePercent: 100,
  backgroundNotificationsEnabled: true,
  minimizeToTray: true,
  currentSystemPollSeconds: 20,
  pilotContextPollSeconds: 60
})

const UI_SETTING_KEYS = new Set<keyof UiSettings>([
  'scalePercent',
  'density',
  'soundVolumePercent',
  'backgroundNotificationsEnabled',
  'minimizeToTray',
  'currentSystemPollSeconds',
  'pilotContextPollSeconds'
])

export function validateUiSettings(value: unknown): UiSettings {
  const record = requireSettingsRecord(value)
  rejectUnknownSettingKeys(record)
  for (const key of UI_SETTING_KEYS) {
    if (!(key in record)) throw new TypeError(`Setting missing: ${key}`)
  }
  return parseSettingsRecord(record) as UiSettings
}

export function validateUiSettingsPatch(value: unknown): UiSettingsPatch {
  const record = requireSettingsRecord(value)
  rejectUnknownSettingKeys(record)
  if (Object.keys(record).length === 0) {
    throw new TypeError('Settings patch cannot be empty')
  }
  return parseSettingsRecord(record, true)
}

export function mergeUiSettings(
  current: UiSettings,
  patchInput: unknown
): UiSettings {
  const currentSettings = validateUiSettings(current)
  const patch = validateUiSettingsPatch(patchInput)
  return validateUiSettings({ ...currentSettings, ...patch })
}

export function uiSettingsEqual(left: UiSettings, right: UiSettings): boolean {
  return left.scalePercent === right.scalePercent &&
    left.density === right.density &&
    left.soundVolumePercent === right.soundVolumePercent &&
    left.backgroundNotificationsEnabled === right.backgroundNotificationsEnabled &&
    left.minimizeToTray === right.minimizeToTray &&
    left.currentSystemPollSeconds === right.currentSystemPollSeconds &&
    left.pilotContextPollSeconds === right.pilotContextPollSeconds
}

export function uiPollingIntervalsMs(settingsInput: unknown): {
  currentSystem: number
  pilotContext: number
} {
  const settings = validateUiSettings(settingsInput)
  return {
    currentSystem: settings.currentSystemPollSeconds * 1_000,
    pilotContext: settings.pilotContextPollSeconds * 1_000
  }
}

function requireSettingsRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid UI settings')
  }
  return value as Record<string, unknown>
}

function rejectUnknownSettingKeys(record: Record<string, unknown>): void {
  if (Object.keys(record).some((key) => !UI_SETTING_KEYS.has(key as keyof UiSettings))) {
    throw new TypeError('UI settings contain unknown fields')
  }
}

function parseSettingsRecord(
  record: Record<string, unknown>,
  partial = false
): UiSettings | UiSettingsPatch {
  const parsed: UiSettingsPatch = {}
  if (!partial || 'scalePercent' in record) {
    parsed.scalePercent = parseSteppedInteger(
      record.scalePercent,
      UI_SCALE_RANGE,
      'UI scale'
    )
  }
  if (!partial || 'density' in record) parsed.density = parseDensity(record.density)
  if (!partial || 'soundVolumePercent' in record) {
    parsed.soundVolumePercent = parseSteppedInteger(
      record.soundVolumePercent,
      SOUND_VOLUME_RANGE,
      'notification volume'
    )
  }
  if (!partial || 'backgroundNotificationsEnabled' in record) {
    parsed.backgroundNotificationsEnabled = parseBoolean(
      record.backgroundNotificationsEnabled,
      'background notifications'
    )
  }
  if (!partial || 'minimizeToTray' in record) {
    parsed.minimizeToTray = parseBoolean(record.minimizeToTray, 'minimize to tray')
  }
  if (!partial || 'currentSystemPollSeconds' in record) {
    parsed.currentSystemPollSeconds = parseSteppedInteger(
      record.currentSystemPollSeconds,
      CURRENT_SYSTEM_POLL_RANGE,
      'current-system interval'
    )
  }
  if (!partial || 'pilotContextPollSeconds' in record) {
    parsed.pilotContextPollSeconds = parseSteppedInteger(
      record.pilotContextPollSeconds,
      PILOT_CONTEXT_POLL_RANGE,
      'pilot-context interval'
    )
  }
  return parsed as UiSettings | UiSettingsPatch
}

function parseDensity(value: unknown): UiDensity {
  if (value !== 'comfortable' && value !== 'compact') {
    throw new TypeError('Invalid UI density')
  }
  return value
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`Invalid field: ${label}`)
  return value
}

function parseSteppedInteger(
  value: unknown,
  range: { min: number; max: number; step: number },
  label: string
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < range.min ||
    Number(value) > range.max ||
    (Number(value) - range.min) % range.step !== 0
  ) {
    throw new TypeError(
      `Invalid field: ${label} (${range.min}–${range.max}, step ${range.step})`
    )
  }
  return Number(value)
}
