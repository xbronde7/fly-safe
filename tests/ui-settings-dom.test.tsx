import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_SETTINGS } from '../src/shared/ui-settings'
import {
  applyUiSettingsToDocument,
  clearUiSettingsFromDocument,
  UI_DENSITY_ATTRIBUTE,
  UI_SOUND_VOLUME_PROPERTY
} from '../src/renderer/src/ui-settings-dom'

function fakeDocumentRoot(): {
  root: HTMLElement
  properties: Map<string, string>
  attributes: Map<string, string>
} {
  const properties = new Map<string, string>()
  const attributes = new Map<string, string>()
  const root = {
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => {
        const previous = properties.get(name) ?? ''
        properties.delete(name)
        return previous
      }
    },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name)
  } as unknown as HTMLElement
  return { root, properties, attributes }
}

describe('renderer UI settings DOM', () => {
  it('never uses root CSS zoom because it desynchronizes Electron pointer hit-testing', () => {
    const { root, properties, attributes } = fakeDocumentRoot()
    properties.set('zoom', '1.25')

    applyUiSettingsToDocument({
      ...DEFAULT_UI_SETTINGS,
      scalePercent: 125,
      density: 'compact',
      soundVolumePercent: 20
    }, root)

    expect(properties.has('zoom')).toBe(false)
    expect(properties.get(UI_SOUND_VOLUME_PROPERTY)).toBe('0.2')
    expect(attributes.get(UI_DENSITY_ATTRIBUTE)).toBe('compact')
  })

  it('clears renderer-only density and sound properties', () => {
    const { root, properties, attributes } = fakeDocumentRoot()
    applyUiSettingsToDocument(DEFAULT_UI_SETTINGS, root)

    clearUiSettingsFromDocument(root)

    expect(properties.has('zoom')).toBe(false)
    expect(properties.has(UI_SOUND_VOLUME_PROPERTY)).toBe(false)
    expect(attributes.has(UI_DENSITY_ATTRIBUTE)).toBe(false)
  })
})
