import { describe, expect, it } from 'vitest'
import { formatAppVersion } from '../src/shared/app-version'

describe('app version label', () => {
  it('formats the version supplied by the main-process status API', () => {
    expect(formatAppVersion('0.3.1')).toBe('v0.3.1')
  })

  it('does not duplicate an existing version prefix', () => {
    expect(formatAppVersion(' v0.3.1 ')).toBe('v0.3.1')
  })

  it('shows a stable loading placeholder before IPC status arrives', () => {
    expect(formatAppVersion(null)).toBe('v…')
    expect(formatAppVersion('  ')).toBe('v…')
  })
})
