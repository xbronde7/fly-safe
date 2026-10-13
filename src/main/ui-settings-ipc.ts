import {
  validateUiSettingsPatch,
  type UiSettingsUpdateRequest
} from '../shared/ui-settings'

const UPDATE_REQUEST_KEYS = new Set(['patch'])

/**
 * Strict IPC boundary: the renderer can update only the documented preference fields.
 * It cannot choose the file path, schema version, or persisted timestamp.
 */
export function parseUiSettingsUpdateRequest(value: unknown): UiSettingsUpdateRequest {
  const record = requireRecord(value)
  rejectUnknownKeys(record, UPDATE_REQUEST_KEYS)
  if (!('patch' in record)) throw new TypeError('Settings patch is missing')
  return { patch: validateUiSettingsPatch(record.patch) }
}

/** `settings:get` carries no renderer-controlled payload. */
export function parseUiSettingsGetRequest(value: unknown): undefined {
  if (value !== undefined) throw new TypeError('Getting settings accepts no parameters')
  return undefined
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid UI-settings request')
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError('Settings request contains unknown fields')
  }
}
