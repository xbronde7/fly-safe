import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsWorkspace } from '../src/renderer/src/SettingsWorkspace'

describe('settings workspace UI', () => {
  it('renders readable controls and explicit safe ranges', () => {
    const markup = renderToStaticMarkup(<SettingsWorkspace api={null} />)

    expect(markup).toContain('Interface settings')
    expect(markup).toContain('Interface scale')
    expect(markup).toContain('min="100"')
    expect(markup).toContain('max="160"')
    expect(markup).toContain('Card density')
    expect(markup).toContain('role="radiogroup"')
    expect(markup).toContain('Alert volume')
    expect(markup).toContain('Test sound')
    expect(markup).toContain('Background operation')
    expect(markup).toContain('System notifications')
    expect(markup).toContain('Minimize to tray')
    expect(markup).toContain('Current-system refresh')
    expect(markup).toContain('A 20-second minimum')
    expect(markup).toContain('Pilot-context refresh')
    expect(markup).toContain('safe minimum is one minute')
  })

  it('explains missing IPC without hiding the controls', () => {
    const markup = renderToStaticMarkup(<SettingsWorkspace api={null} />)
    expect(markup).toContain('Storage unavailable')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('Defaults')
    expect(markup).toContain('Save')
  })
})
