export const API_NETWORK_USER_AGENT =
  'Fly-Safe/0.11.0 (desktop application; proxy-aware)'

interface ElectronFetchInit extends RequestInit {
  bypassCustomProtocolHandlers?: boolean
}

export interface ElectronApiSession {
  fetch(input: string | Request, init?: ElectronFetchInit): Promise<Response>
  setProxy(config: { mode: 'system' }): Promise<void>
  forceReloadProxyConfig(): Promise<void>
  setUserAgent(userAgent: string): void
}

/**
 * Uses Chromium networking while keeping API traffic isolated from renderer
 * cookies and custom protocol handlers.
 */
export function createProxyAwareFetch(apiSession: ElectronApiSession): typeof fetch {
  return (input, init) => apiSession.fetch(
    input instanceof URL ? input.toString() : input,
    {
      ...init,
      credentials: 'omit',
      bypassCustomProtocolHandlers: true
    }
  )
}

/** Applies the current operating-system/PAC proxy to the exact Session used for API calls. */
export async function configureSystemProxySession(
  apiSession: ElectronApiSession
): Promise<void> {
  apiSession.setUserAgent(API_NETWORK_USER_AGENT)
  await apiSession.setProxy({ mode: 'system' })
  try {
    await apiSession.forceReloadProxyConfig()
  } catch {
    // setProxy already applied system mode; reloading a PAC is best effort.
  }
}
