import { describe, expect, it, vi } from 'vitest'
import {
  API_NETWORK_USER_AGENT,
  configureSystemProxySession,
  createProxyAwareFetch,
  type ElectronApiSession
} from '../src/main/proxy-fetch'

function sessionHarness(overrides: Partial<ElectronApiSession> = {}): {
  session: ElectronApiSession
  fetch: ReturnType<typeof vi.fn<ElectronApiSession['fetch']>>
  setProxy: ReturnType<typeof vi.fn<ElectronApiSession['setProxy']>>
  forceReloadProxyConfig: ReturnType<typeof vi.fn<ElectronApiSession['forceReloadProxyConfig']>>
  setUserAgent: ReturnType<typeof vi.fn<ElectronApiSession['setUserAgent']>>
} {
  const fetch = vi.fn<ElectronApiSession['fetch']>(async () => new Response(null, { status: 204 }))
  const setProxy = vi.fn<ElectronApiSession['setProxy']>(async () => undefined)
  const forceReloadProxyConfig = vi.fn<ElectronApiSession['forceReloadProxyConfig']>(
    async () => undefined
  )
  const setUserAgent = vi.fn<ElectronApiSession['setUserAgent']>()
  const session: ElectronApiSession = {
    fetch,
    setProxy,
    forceReloadProxyConfig,
    setUserAgent,
    ...overrides
  }

  return {
    session,
    fetch: session.fetch as typeof fetch,
    setProxy: session.setProxy as typeof setProxy,
    forceReloadProxyConfig: session.forceReloadProxyConfig as typeof forceReloadProxyConfig,
    setUserAgent: session.setUserAgent as typeof setUserAgent
  }
}

describe('createProxyAwareFetch', () => {
  it('routes URL objects through the Electron session and preserves request init', async () => {
    const harness = sessionHarness()
    const proxyFetch = createProxyAwareFetch(harness.session)
    const signal = new AbortController().signal
    const headers = new Headers({ Accept: 'application/json' })

    const response = await proxyFetch(new URL('https://zkillboard.com/api/stats/characterID/42/'), {
      method: 'POST',
      headers,
      cache: 'no-store',
      signal
    })

    expect(response.status).toBe(204)
    expect(harness.fetch).toHaveBeenCalledOnce()
    expect(harness.fetch).toHaveBeenCalledWith(
      'https://zkillboard.com/api/stats/characterID/42/',
      {
        method: 'POST',
        headers,
        cache: 'no-store',
        signal,
        credentials: 'omit',
        bypassCustomProtocolHandlers: true
      }
    )
  })

  it('forces cookie-free direct protocol handling without mutating caller init', async () => {
    const harness = sessionHarness()
    const proxyFetch = createProxyAwareFetch(harness.session)
    const init = {
      credentials: 'include',
      bypassCustomProtocolHandlers: false,
      redirect: 'manual'
    } satisfies RequestInit & { bypassCustomProtocolHandlers: boolean }

    await proxyFetch('https://esi.evetech.net/latest/status/', init)

    expect(init).toEqual({
      credentials: 'include',
      bypassCustomProtocolHandlers: false,
      redirect: 'manual'
    })
    expect(harness.fetch).toHaveBeenCalledWith(
      'https://esi.evetech.net/latest/status/',
      {
        credentials: 'omit',
        bypassCustomProtocolHandlers: true,
        redirect: 'manual'
      }
    )
  })

  it('keeps Request objects intact for Electron session.fetch', async () => {
    const harness = sessionHarness()
    const proxyFetch = createProxyAwareFetch(harness.session)
    const request = new Request('https://login.eveonline.com/.well-known/oauth-authorization-server')

    await proxyFetch(request)

    expect(harness.fetch.mock.calls[0]?.[0]).toBe(request)
  })
})

describe('configureSystemProxySession', () => {
  it('sets the API user agent, selects the system proxy, and reloads proxy configuration', async () => {
    const harness = sessionHarness()

    await configureSystemProxySession(harness.session)

    expect(harness.setUserAgent).toHaveBeenCalledOnce()
    expect(harness.setUserAgent).toHaveBeenCalledWith(API_NETWORK_USER_AGENT)
    expect(harness.setProxy).toHaveBeenCalledOnce()
    expect(harness.setProxy).toHaveBeenCalledWith({ mode: 'system' })
    expect(harness.forceReloadProxyConfig).toHaveBeenCalledOnce()
    expect(harness.setProxy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.forceReloadProxyConfig.mock.invocationCallOrder[0]!
    )
  })

  it('treats forceReloadProxyConfig failure as best effort after system mode is applied', async () => {
    const reloadError = new Error('PAC reload unavailable')
    const harness = sessionHarness({
      forceReloadProxyConfig: vi.fn(async () => {
        throw reloadError
      })
    })

    await expect(configureSystemProxySession(harness.session)).resolves.toBeUndefined()
    expect(harness.setProxy).toHaveBeenCalledWith({ mode: 'system' })
    expect(harness.forceReloadProxyConfig).toHaveBeenCalledOnce()
  })

  it('propagates setProxy failure and does not pretend configuration succeeded', async () => {
    const proxyError = new Error('system proxy unavailable')
    const harness = sessionHarness({
      setProxy: vi.fn(async () => {
        throw proxyError
      })
    })

    await expect(configureSystemProxySession(harness.session)).rejects.toBe(proxyError)
    expect(harness.setUserAgent).toHaveBeenCalledWith(API_NETWORK_USER_AGENT)
    expect(harness.forceReloadProxyConfig).not.toHaveBeenCalled()
  })
})
