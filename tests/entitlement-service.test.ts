import { describe, expect, it, vi } from 'vitest'
import type { EveAccountService } from '../src/main/account-service'
import { EntitlementService } from '../src/main/entitlement-service'

const DEVICE_CODE = 'ELI-ABCD-EFGH-JKLM-NPQR'
const NOW_MS = 2_000_000_000_000
const NOW = Math.floor(NOW_MS / 1_000)

function account(connected = true): EveAccountService {
  return {
    getAuthorizedSession: vi.fn(async () => connected
      ? {
          accessToken: 'eve-access-token',
          session: {
            characterId: 21_122_560_144,
            characterName: 'Serg Xbronde',
            scopes: [],
            expiresAt: NOW_MS + 60_000
          }
        }
      : null)
  } as unknown as EveAccountService
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('EntitlementService', () => {
  it('registers the device, activates EVEI2 and keeps EVE tokens in main-process requests', async () => {
    const activate = vi.fn(async () => undefined)
    const requests: Array<{ url: string; authorization: string | null }> = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      requests.push({ url, authorization: headers.get('authorization') })
      if (url.endsWith('/v1/devices')) return json({ device: { id: 'dev-001' } })
      if (url.endsWith('/v1/account')) {
        return json({
          account: {
            subscription: {
              id: 'sub-001',
              planId: 'pro-monthly',
              status: 'active',
              autoRenew: true,
              paidThrough: NOW + 86_400
            }
          }
        })
      }
      if (url.includes('/v1/entitlements/current')) {
        if (headers.get('if-none-match') === '"ent-001-2"') {
          return new Response(null, { status: 304 })
        }
        return new Response(JSON.stringify({
          token: 'EVEI2.payload.signature',
          entitlement: {
            id: 'ent-001',
            revision: 2,
            issuedAt: NOW - 30,
            expiresAt: NOW + 43_200,
            paidThrough: NOW + 86_400,
            planId: 'pro-monthly',
            features: ['wormhole-chain']
          }
        }), { status: 200, headers: { 'content-type': 'application/json', etag: '"ent-001-2"' } })
      }
      return json({ message: 'not found' }, 404)
    })
    const service = new EntitlementService({
      baseUrl: 'https://license.example.test/',
      deviceCode: DEVICE_CODE,
      accountService: account(),
      fetch: fetchMock as typeof fetch,
      activateEntitlement: activate,
      now: () => NOW_MS
    })

    const status = await service.sync()

    expect(status).toMatchObject({
      state: 'active',
      characterId: '21122560144',
      subscription: { id: 'sub-001' },
      entitlement: { id: 'ent-001', revision: 2 }
    })
    expect(activate).toHaveBeenCalledWith('EVEI2.payload.signature')
    expect(requests).toHaveLength(3)
    expect(requests.every((request) => request.authorization === 'Bearer eve-access-token')).toBe(true)
    expect(JSON.stringify(status)).not.toContain('eve-access-token')

    const second = await service.sync()
    expect(second).toMatchObject({ state: 'active', entitlement: { revision: 2 } })
    const entitlementRequests = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/v1/entitlements/current'))
    expect(new Headers(entitlementRequests[1]?.[1]?.headers).get('if-none-match'))
      .toBe('"ent-001-2"')
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('creates an exact-amount ISK invoice and exposes no entitlement without payment', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/invoices')) {
        return json({
          invoice: {
            id: 'inv-001',
            planId: 'pro-monthly',
            status: 'pending',
            receiverCharacterId: '90000001',
            receiverCharacterName: 'Fly Safe Cashier',
            amountIsk: '250000123.00',
            reason: 'FS-K7M4Q2',
            createdAt: NOW,
            expiresAt: NOW + 86_400,
            paidAt: null
          }
        })
      }
      return json({ message: 'not found' }, 404)
    })
    const service = new EntitlementService({
      baseUrl: 'https://license.example.test',
      deviceCode: DEVICE_CODE,
      accountService: account(),
      fetch: fetchMock as typeof fetch,
      activateEntitlement: async () => undefined,
      now: () => NOW_MS
    })

    const invoice = await service.createInvoice('pro-monthly')
    expect(invoice).toMatchObject({
      id: 'inv-001',
      status: 'pending',
      amountIsk: '250000123.00',
      paymentCode: 'FS-K7M4Q2'
    })
    expect(service.status()).toMatchObject({ state: 'pending_payment', invoice: { id: 'inv-001' } })
  })

  it('reports limited pre-license state when SSO is disconnected', async () => {
    const fetchMock = vi.fn()
    const service = new EntitlementService({
      baseUrl: 'https://license.example.test',
      deviceCode: DEVICE_CODE,
      accountService: account(false),
      fetch: fetchMock as typeof fetch,
      activateEntitlement: async () => undefined
    })

    expect(await service.sync()).toMatchObject({ state: 'disconnected' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
