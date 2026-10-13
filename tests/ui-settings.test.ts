import { describe, expect, it } from 'vitest'
import {
  CURRENT_SYSTEM_POLL_RANGE,
  DEFAULT_UI_SETTINGS,
  PILOT_CONTEXT_POLL_RANGE,
  mergeUiSettings,
  uiPollingIntervalsMs,
  validateUiSettings,
  validateUiSettingsPatch
} from '../src/shared/ui-settings'

describe('UI settings', () => {
  it('ships with the existing safe polling intervals and enabled background behavior', () => {
    expect(DEFAULT_UI_SETTINGS).toEqual({
      scalePercent: 100,
      density: 'comfortable',
      soundVolumePercent: 100,
      backgroundNotificationsEnabled: true,
      minimizeToTray: true,
      currentSystemPollSeconds: 20,
      pilotContextPollSeconds: 60
    })
    expect(uiPollingIntervalsMs(DEFAULT_UI_SETTINGS)).toEqual({
      currentSystem: 20_000,
      pilotContext: 60_000
    })
  })

  it('merges a validated partial update without dropping other values', () => {
    expect(mergeUiSettings({ ...DEFAULT_UI_SETTINGS }, {
      scalePercent: 135,
      density: 'compact',
      soundVolumePercent: 45,
      backgroundNotificationsEnabled: false
    })).toEqual({
      ...DEFAULT_UI_SETTINGS,
      scalePercent: 135,
      density: 'compact',
      soundVolumePercent: 45,
      backgroundNotificationsEnabled: false
    })
  })

  it('rejects missing and unknown full settings fields', () => {
    expect(() => validateUiSettings({
      ...DEFAULT_UI_SETTINGS,
      scalePercent: undefined
    })).toThrow('UI scale')
    expect(() => validateUiSettings({
      ...DEFAULT_UI_SETTINGS,
      developerMode: true
    })).toThrow('unknown fields')
  })

  it('enforces safe scale, volume and polling steps', () => {
    const invalidPatches = [
      { scalePercent: 99 },
      { scalePercent: 102 },
      { soundVolumePercent: -5 },
      { soundVolumePercent: 101 },
      { currentSystemPollSeconds: CURRENT_SYSTEM_POLL_RANGE.min - 10 },
      { currentSystemPollSeconds: CURRENT_SYSTEM_POLL_RANGE.min + 1 },
      { pilotContextPollSeconds: PILOT_CONTEXT_POLL_RANGE.min - 30 },
      { pilotContextPollSeconds: PILOT_CONTEXT_POLL_RANGE.min + 1 }
    ]
    for (const patch of invalidPatches) {
      expect(() => validateUiSettingsPatch(patch)).toThrow('Invalid field')
    }
  })

  it('rejects invalid toggles, density, empty patches and non-records', () => {
    expect(() => validateUiSettingsPatch({ density: 'dense' })).toThrow('density')
    expect(() => validateUiSettingsPatch({ minimizeToTray: 'yes' })).toThrow('tray')
    expect(() => validateUiSettingsPatch({ backgroundNotificationsEnabled: 1 }))
      .toThrow('background notifications')
    expect(() => validateUiSettingsPatch({})).toThrow('cannot be empty')
    for (const value of [null, [], 'settings']) {
      expect(() => validateUiSettingsPatch(value)).toThrow('Invalid UI settings')
    }
  })
})
