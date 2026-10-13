import { validateUiSettings, type UiSettings } from '../../shared/ui-settings'

export const UI_DENSITY_ATTRIBUTE = 'data-fly-safe-density'
export const UI_SOUND_VOLUME_PROPERTY = '--fly-safe-sound-volume'

/** Applies renderer-only preferences without granting renderer filesystem access. */
export function applyUiSettingsToDocument(
  settingsInput: UiSettings,
  documentRoot: HTMLElement = document.documentElement
): void {
  const settings = validateUiSettings(settingsInput)
  // CSS `zoom` on the root document breaks pointer hit-testing in Electron on
  // macOS: controls are painted at the scaled position but clicks are resolved
  // against their unscaled coordinates. Page zoom is applied through webFrame.
  documentRoot.style.removeProperty('zoom')
  documentRoot.style.setProperty(
    UI_SOUND_VOLUME_PROPERTY,
    String(settings.soundVolumePercent / 100)
  )
  documentRoot.setAttribute(UI_DENSITY_ATTRIBUTE, settings.density)
}

export function clearUiSettingsFromDocument(
  documentRoot: HTMLElement = document.documentElement
): void {
  documentRoot.style.removeProperty('zoom')
  documentRoot.style.removeProperty(UI_SOUND_VOLUME_PROPERTY)
  documentRoot.removeAttribute(UI_DENSITY_ATTRIBUTE)
}
