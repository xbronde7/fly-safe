import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LicenseGate, normalizeLicenseKey } from '../src/renderer/src/LicenseGate'

describe('LicenseGate', () => {
  const onActivate = async (): Promise<void> => undefined

  it('does not render protected children while the device is locked', () => {
    const markup = renderToStaticMarkup(
      <LicenseGate
        status={{ state: 'missing', active: false, deviceCode: 'MAC-TEST-123', message: null }}
        onActivate={onActivate}
        onCopyDeviceCode={() => undefined}
      >
        <div>PRIVATE INTEL</div>
      </LicenseGate>
    )

    expect(markup).toContain('Введите ключ доступа')
    expect(markup).toContain('MAC-TEST-123')
    expect(markup).toContain('Копировать')
    expect(markup).not.toContain('PRIVATE INTEL')
  })

  it('renders only protected children after activation', () => {
    const markup = renderToStaticMarkup(
      <LicenseGate
        status={{ state: 'active', active: true, deviceCode: 'MAC-TEST-123', message: null }}
        onActivate={onActivate}
      >
        <div>PRIVATE INTEL</div>
      </LicenseGate>
    )

    expect(markup).toContain('PRIVATE INTEL')
    expect(markup).not.toContain('license-gate')
    expect(markup).not.toContain('Лицензионный ключ')
  })

  it('renders a dedicated non-interactive checking state', () => {
    const markup = renderToStaticMarkup(
      <LicenseGate status={{ state: 'checking' }} onActivate={onActivate}>
        <div>PRIVATE INTEL</div>
      </LicenseGate>
    )

    expect(markup).toContain('Проверяем лицензию')
    expect(markup).not.toContain('<textarea')
    expect(markup).not.toContain('PRIVATE INTEL')
  })

  it('removes accidental whitespace from a pasted key', () => {
    expect(normalizeLicenseKey(' EVE-ABC\n 123\tXYZ ')).toBe('EVE-ABC123XYZ')
  })

  it('shows an honest retry state when subscription plans are unavailable', () => {
    const markup = renderToStaticMarkup(
      <LicenseGate
        status={{ state: 'missing', active: false, deviceCode: 'MAC-TEST-123', message: null }}
        onActivate={onActivate}
        subscriptionStatus={subscriptionStatus()}
        subscriptionPlansLoading={false}
        subscriptionPlansError="backend offline"
        onRefreshSubscriptionPlans={async () => []}
      >
        <div>PRIVATE INTEL</div>
      </LicenseGate>
    )

    expect(markup).toContain('Тарифы временно недоступны')
    expect(markup).toContain('backend offline')
    expect(markup).toContain('Повторить загрузку тарифов')
    expect(markup).not.toContain('Тарифы загружаются')
  })

  it('renders cached plans alongside a transient refresh warning', () => {
    const markup = renderToStaticMarkup(
      <LicenseGate
        status={{ state: 'missing', active: false, deviceCode: 'MAC-TEST-123', message: null }}
        onActivate={onActivate}
        subscriptionStatus={subscriptionStatus()}
        subscriptionPlans={[{
          id: 'pro-30d',
          name: 'Fly Safe Pro',
          amountIsk: '150000000.00',
          durationSeconds: 30 * 86_400,
          features: ['corp_fleet_intel']
        }]}
        subscriptionPlansError="temporary failure"
        onRefreshSubscriptionPlans={async () => []}
      >
        <div>PRIVATE INTEL</div>
      </LicenseGate>
    )

    expect(markup).toContain('Fly Safe Pro')
    expect(markup).toContain('150 000 000 ISK')
    expect(markup).toContain('Показан последний загруженный список')
  })
})

function subscriptionStatus() {
  return {
    state: 'payment_required' as const,
    backendConfigured: true,
    characterId: '90000001',
    characterName: 'Test Pilot',
    deviceCode: 'MAC-TEST-123',
    subscription: null,
    entitlement: null,
    invoice: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    message: null
  }
}
