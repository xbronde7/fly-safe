import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/main/index.ts', import.meta.url)),
  'utf8'
)
const INITIALIZE_SERVICES_SOURCE = sourceBetween(
  'async function initializeServices()',
  'const hasSingleInstanceLock'
)
const INITIALIZE_ACCOUNT_SOURCE = sourceBetween(
  'async function initializeAccountServices()',
  'async function initializeServices()'
)

describe('main-process proxy boundary', () => {
  it('configures the same isolated Chromium session used by the API fetch adapter', () => {
    expect(INITIALIZE_ACCOUNT_SOURCE).toContain(
      "const apiSession = session.fromPartition('eve-api-network', { cache: false })"
    )
    expect(INITIALIZE_ACCOUNT_SOURCE).toContain(
      'await configureSystemProxySession(apiSession)'
    )
    expect(INITIALIZE_ACCOUNT_SOURCE).toContain(
      'apiFetch = createProxyAwareFetch(apiSession)'
    )
  })

  it('keeps IntelService ESI on proxy fetch and routes zKill through combat transport', () => {
    const source = assignmentSource('intelService =', 'systemCache =')

    expect(source).toContain('new IntelService')
    expect(source).toMatch(/esi\s*:\s*{[^}]*fetch\s*:\s*proxyFetch/s)
    expect(source).toContain('zkill: zkillNetworkOptions')
    expect(fetchInjectionCount(source)).toBe(1)
  })

  it('injects the proxy fetch into the standalone ESI client', () => {
    const source = assignmentSource('esiClient =', 'systemIntelService =')

    expect(source).toContain('new EsiClient')
    expect(fetchInjectionCount(source)).toBe(1)
  })

  it('reuses standalone ESI and the bounded combat transport for SystemIntel zKill', () => {
    const source = assignmentSource('systemIntelService =', 'marketService =')

    expect(source).toContain('new SystemIntelService')
    expect(source).toMatch(/\besiClient\b/)
    expect(source).toContain('zkill: zkillNetworkOptions')
    expect(fetchInjectionCount(source)).toBe(0)
  })

  it('injects proxy fetch into every EVE SSO client created by the account service', () => {
    const source = sourceBetweenIn(
      INITIALIZE_ACCOUNT_SOURCE,
      'accountService =',
      '// Restoration is intentionally non-blocking'
    )

    expect(source).toContain('clientFactory:')
    expect(source).toContain('new EveSsoClient')
    expect(source).toContain('fetch: apiFetch!')
  })

  it('injects combat transport into the R2z2 kill-alert client', () => {
    const source = assignmentSource('killAlertService =', '\n\n}')

    expect(source).toContain('new R2z2Client')
    expect(combatFetchInjectionCount(source)).toBe(1)
  })

  it('builds direct-first relay fallback with one bounded zKill attempt', () => {
    expect(INITIALIZE_SERVICES_SOURCE).toContain('createZkillRelayFetch')
    expect(INITIALIZE_SERVICES_SOURCE).toContain('getCombatRelayBaseUrl()')
    expect(INITIALIZE_SERVICES_SOURCE).toContain('fetch: proxyFetch')
    expect(INITIALIZE_SERVICES_SOURCE).toContain('relayBaseUrl: combatBackendBaseUrl')
    expect(INITIALIZE_SERVICES_SOURCE).toContain('accountService!.getAuthorizedSession()')
    expect(INITIALIZE_SERVICES_SOURCE).toContain('`${combatBackendBaseUrl}${ZKILL_RELAY_PATH}`')
    expect(INITIALIZE_SERVICES_SOURCE).toContain('`${combatBackendBaseUrl}${R2Z2_RELAY_PATH}`')
    expect(INITIALIZE_SERVICES_SOURCE).toContain('timeoutMs: COMBAT_API_REQUEST_BUDGET_MS')
    expect(INITIALIZE_SERVICES_SOURCE).toContain('maxAttempts: 1')
  })

  it('has exactly the required base and combat fetch injection points', () => {
    expect(fetchInjectionCount(INITIALIZE_SERVICES_SOURCE)).toBe(3)
    expect(combatFetchInjectionCount(INITIALIZE_SERVICES_SOURCE)).toBe(2)
    expect(INITIALIZE_ACCOUNT_SOURCE.match(/\bfetch\s*:\s*apiFetch!/g)).toHaveLength(1)
  })
})

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = MAIN_SOURCE.indexOf(startMarker)
  if (start < 0) throw new Error(`Source marker not found: ${startMarker}`)
  const end = MAIN_SOURCE.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`Source marker not found: ${endMarker}`)
  return MAIN_SOURCE.slice(start, end)
}

function assignmentSource(startMarker: string, endMarker: string): string {
  const start = INITIALIZE_SERVICES_SOURCE.indexOf(startMarker)
  if (start < 0) throw new Error(`Service assignment not found: ${startMarker}`)
  const end = INITIALIZE_SERVICES_SOURCE.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`Service assignment not found: ${endMarker}`)
  return INITIALIZE_SERVICES_SOURCE.slice(start, end)
}

function sourceBetweenIn(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`Source marker not found: ${startMarker}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`Source marker not found: ${endMarker}`)
  return source.slice(start, end)
}

function fetchInjectionCount(source: string): number {
  return source.match(/\bfetch\s*:\s*proxyFetch\b/g)?.length ?? 0
}

function combatFetchInjectionCount(source: string): number {
  return source.match(/\bfetch\s*:\s*combatFetch\b/g)?.length ?? 0
}
