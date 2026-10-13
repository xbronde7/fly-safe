import { describe, expect, it } from 'vitest'
import {
  parseUiSettingsGetRequest,
  parseUiSettingsUpdateRequest
} from '../src/main/ui-settings-ipc'

describe('UI settings IPC validation', () => {
  it('accepts only a nested, typed settings patch', () => {
    expect(parseUiSettingsUpdateRequest({
      patch: {
        scalePercent: 125,
        density: 'compact',
        soundVolumePercent: 65,
        backgroundNotificationsEnabled: true,
        minimizeToTray: false,
        currentSystemPollSeconds: 40,
        pilotContextPollSeconds: 120
      }
    })).toEqual({
      patch: {
        scalePercent: 125,
        density: 'compact',
        soundVolumePercent: 65,
        backgroundNotificationsEnabled: true,
        minimizeToTray: false,
        currentSystemPollSeconds: 40,
        pilotContextPollSeconds: 120
      }
    })
  })

  it('rejects renderer-controlled paths, timestamps and unknown settings', () => {
    expect(() => parseUiSettingsUpdateRequest({
      patch: { scalePercent: 125 },
      filePath: '/tmp/settings.json'
    })).toThrow('unknown fields')
    expect(() => parseUiSettingsUpdateRequest({
      patch: { scalePercent: 125, updatedAt: '2026-08-25T00:00:00Z' }
    })).toThrow('unknown fields')
  })

  it('rejects malformed, missing and empty requests', () => {
    for (const value of [null, [], 'settings']) {
      expect(() => parseUiSettingsUpdateRequest(value)).toThrow('Invalid UI-settings request')
    }
    expect(() => parseUiSettingsUpdateRequest({})).toThrow('missing')
    expect(() => parseUiSettingsUpdateRequest({ patch: {} })).toThrow('cannot be empty')
  })

  it('keeps the get channel payload-free', () => {
    expect(parseUiSettingsGetRequest(undefined)).toBeUndefined()
    expect(() => parseUiSettingsGetRequest({})).toThrow('accepts no parameters')
  })
})
