import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PRO_FEATURE_IDS } from '../src/shared/pro-features'

const LICENSED_APP_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/LicensedApp.tsx', import.meta.url)),
  'utf8'
)
const SETTINGS_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/SettingsWorkspace.tsx', import.meta.url)),
  'utf8'
)

describe('free edition access', () => {
  it('passes every local Pro feature to the app without a license gate', () => {
    expect(PRO_FEATURE_IDS.length).toBeGreaterThan(0)
    expect(LICENSED_APP_SOURCE).toContain('<App entitlementFeatures={PRO_FEATURE_IDS} />')
    expect(LICENSED_APP_SOURCE).not.toContain('<LicenseGate')
    expect(LICENSED_APP_SOURCE).not.toContain('getLicenseStatus')
    expect(LICENSED_APP_SOURCE).not.toContain('getSubscriptionStatus')
  })

  it('shows optional donation paths instead of a paid subscription', () => {
    expect(SETTINGS_SOURCE).toContain('https://donatty.com/xbronde')
    expect(SETTINGS_SOURCE).toContain('13mQGzbcyaW5RtfzMvL4dxtzANHnAS2zbC')
    expect(SETTINGS_SOURCE).toContain('Fly Safe is free to use')
    expect(SETTINGS_SOURCE).not.toContain('settings-subscription-card')
  })
})
