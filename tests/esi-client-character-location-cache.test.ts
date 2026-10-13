import { describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { EsiClient, EsiError } from '../src/main/esi-client'

const CHARACTER_ID = 90_000_001
const OTHER_CHARACTER_ID = 90_000_002
const SYSTEM_ID = 30_000_142
const TOKEN = 'secret-token'
const RATE_LIMIT_MESSAGE = 'ESI character-location request paused by rate limit'

describe('EsiClient authenticated character-location protection', () => {
  it('uses 5s location/ship TTLs and a 60s online TTL per character', async () => {
    let now = 100_000
    const fetchMock = vi.fn<typeof fetch>(async (input) => responseForRoute(String(input)))
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1,
      now: () => now
    })

    await Promise.all([
      esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN),
      esi.getAuthenticatedCharacterShip(CHARACTER_ID, TOKEN),
      esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)

    now += 4_999
    await Promise.all([
      esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN),
      esi.getAuthenticatedCharacterShip(CHARACTER_ID, TOKEN),
      esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)

    now += 1
    await Promise.all([
      esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN),
      esi.getAuthenticatedCharacterShip(CHARACTER_ID, TOKEN),
      esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)
    ])
    expect(fetchMock).toHaveBeenCalledTimes(5)

    now = 159_999
    await esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(5)

    now = 160_000
    await esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(6)

    await esi.getAuthenticatedCharacterOnline(OTHER_CHARACTER_ID, TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(cache.count()).toBe(0)
    cache.close()
  })

  it('coalesces only the same endpoint and character while a request is in flight', async () => {
    const pending = new Map<string, Deferred<Response>>()
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      const request = deferred<Response>()
      pending.set(url, request)
      return request.promise
    })
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    const first = esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)
    const coalesced = esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)
    const otherEndpoint = esi.getAuthenticatedCharacterShip(CHARACTER_ID, TOKEN)
    const otherCharacter = esi.getAuthenticatedCharacterLocation(OTHER_CHARACTER_ID, TOKEN)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    pending.get(`https://esi.test/characters/${CHARACTER_ID}/location/`)?.resolve(
      locationResponse(SYSTEM_ID)
    )
    pending.get(`https://esi.test/characters/${OTHER_CHARACTER_ID}/location/`)?.resolve(
      locationResponse(SYSTEM_ID + 1)
    )
    pending.get(`https://esi.test/characters/${CHARACTER_ID}/ship/`)?.resolve(shipResponse())

    await expect(Promise.all([first, coalesced])).resolves.toEqual([
      { solarSystemId: SYSTEM_ID, stationId: null, structureId: null },
      { solarSystemId: SYSTEM_ID, stationId: null, structureId: null }
    ])
    await expect(otherEndpoint).resolves.toMatchObject({ shipTypeId: 11_978 })
    await expect(otherCharacter).resolves.toMatchObject({ solarSystemId: SYSTEM_ID + 1 })
    cache.close()
  })

  it('cleans up a rejected single-flight request and validates tokens before cache hits', async () => {
    const firstResponse = deferred<Response>()
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => firstResponse.promise)
      .mockImplementation(async () => locationResponse(SYSTEM_ID))
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    const first = esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)
    const coalesced = esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    firstResponse.resolve(jsonResponse({ error: 'unauthorized' }, 401))

    const results = await Promise.allSettled([first, coalesced])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])

    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
      solarSystemId: SYSTEM_ID
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, '   ')).rejects.toThrow(
      'Access token is required'
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    cache.close()
  })

  it('shares a full Retry-After cooldown and blocks every route without retrying', async () => {
    let now = 1_000_000
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => locationResponse(SYSTEM_ID))
      .mockImplementationOnce(async () => jsonResponse(
        { error: 'Rate limit exceeded: internal detail' },
        429,
        { 'Retry-After': '120' }
      ))
      .mockImplementation(async (input) => responseForRoute(String(input)))
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 3,
      now: () => now
    })

    await esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)
    now += 5_000
    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)).rejects.toMatchObject({
      status: 429,
      message: RATE_LIMIT_MESSAGE
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const onlineError = await captureError(
      esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)
    )
    const shipError = await captureError(
      esi.getAuthenticatedCharacterShip(CHARACTER_ID, TOKEN)
    )
    for (const error of [onlineError, shipError]) {
      expect(error).toBeInstanceOf(EsiError)
      expect(error).toMatchObject({ status: 429, message: RATE_LIMIT_MESSAGE })
      expect(error.message).not.toContain('internal detail')
    }
    const publicRouteError = await captureError(esi.getSolarSystem(SYSTEM_ID, true))
    expect(publicRouteError).toMatchObject({
      status: 429,
      message: 'ESI request paused by rate limit'
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    now += 119_999
    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)).rejects.toMatchObject({
      status: 429,
      message: RATE_LIMIT_MESSAGE
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    now += 1
    await expect(esi.getAuthenticatedCharacterShip(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
      shipTypeId: 11_978
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    cache.close()
  })

  it('serves fresh character cache during cooldown without starting network work', async () => {
    let now = 10_000
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => locationResponse(SYSTEM_ID))
      .mockImplementationOnce(async () => jsonResponse(
        { error: 'limited' },
        429,
        { 'Retry-After': '1' }
      ))
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 3,
      now: () => now
    })

    await esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)
    await expect(esi.getAuthenticatedCharacterShip(CHARACTER_ID, TOKEN)).rejects.toMatchObject({
      status: 429,
      message: RATE_LIMIT_MESSAGE
    })
    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
      solarSystemId: SYSTEM_ID
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    now += 1_000
    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
      solarSystemId: SYSTEM_ID
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    cache.close()
  })

  it('parses an HTTP-date Retry-After against the injected clock', async () => {
    const startedAt = Date.parse('2026-08-21T16:00:00Z')
    let now = startedAt
    const retryAt = new Date(startedAt + 120_000).toUTCString()
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => jsonResponse(
        { error: 'limited' },
        429,
        { 'Retry-After': retryAt }
      ))
      .mockImplementation(async () => onlineResponse())
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 3,
      now: () => now
    })

    await expect(esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)).rejects.toMatchObject({
      status: 429,
      message: RATE_LIMIT_MESSAGE
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 119_999
    await expect(esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)).rejects.toMatchObject({
      status: 429
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 1
    await expect(esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
      online: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    cache.close()
  })

  it('uses a short fallback cooldown when Retry-After is missing or malformed', async () => {
    for (const retryAfter of [undefined, 'not-a-date']) {
      let now = 50_000
      const headers: Record<string, string> = {}
      if (retryAfter !== undefined) headers['Retry-After'] = retryAfter
      const fetchMock = vi.fn<typeof fetch>()
        .mockImplementationOnce(async () => jsonResponse({ error: 'limited' }, 429, headers))
        .mockImplementation(async () => onlineResponse())
      const cache = new Cache(':memory:')
      const esi = new EsiClient(cache, {
        baseUrl: 'https://esi.test',
        fetch: fetchMock,
        maxAttempts: 3,
        now: () => now
      })

      await expect(esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)).rejects.toMatchObject({
        status: 429
      })
      now += 999
      await expect(esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)).rejects.toMatchObject({
        status: 429
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)

      now += 1
      await expect(esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
        online: true
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      cache.close()
    }
  })

  it('never lets a forced refresh use stale data or bypass cooldown', async () => {
    let now = 75_000
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => locationResponse(SYSTEM_ID))
      .mockImplementationOnce(async () => locationResponse(SYSTEM_ID + 1))
      .mockImplementationOnce(async () => jsonResponse(
        { error: 'do not expose this detail' },
        429,
        { 'Retry-After': '120' }
      ))
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 3,
      now: () => now
    })

    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
      solarSystemId: SYSTEM_ID
    })
    await expect(
      esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN, true)
    ).resolves.toMatchObject({ solarSystemId: SYSTEM_ID + 1 })
    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
      solarSystemId: SYSTEM_ID + 1
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const forcedError = await captureError(
      esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN, true)
    )
    expect(forcedError).toMatchObject({ status: 429, message: RATE_LIMIT_MESSAGE })
    expect(forcedError.message).not.toContain('do not expose')
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
      solarSystemId: SYSTEM_ID + 1
    })
    await expect(
      esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN, true)
    ).rejects.toMatchObject({ status: 429, message: RATE_LIMIT_MESSAGE })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    cache.close()
  })

  it('keeps the longest cooldown when concurrent endpoints receive different limits', async () => {
    let now = 0
    const longLimit = deferred<Response>()
    const shortLimit = deferred<Response>()
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => longLimit.promise)
      .mockImplementationOnce(async () => shortLimit.promise)
      .mockImplementation(async () => onlineResponse())
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 3,
      now: () => now
    })

    const location = captureError(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN))
    const ship = captureError(esi.getAuthenticatedCharacterShip(CHARACTER_ID, TOKEN))
    longLimit.resolve(jsonResponse({ error: 'long' }, 429, { 'Retry-After': '120' }))
    await expect(location).resolves.toMatchObject({ status: 429 })
    shortLimit.resolve(jsonResponse({ error: 'short' }, 429, { 'Retry-After': '10' }))
    await expect(ship).resolves.toMatchObject({ status: 429 })

    now = 10_000
    await expect(esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)).rejects.toMatchObject({
      status: 429
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    now = 120_000
    await expect(esi.getAuthenticatedCharacterOnline(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
      online: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    cache.close()
  })

  it('does not serve stale data for non-rate-limit errors', async () => {
    let now = 0
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => locationResponse(SYSTEM_ID))
      .mockImplementationOnce(async () => jsonResponse({ error: 'unauthorized' }, 401))
      .mockImplementation(async () => locationResponse(SYSTEM_ID + 1))
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1,
      now: () => now
    })

    await esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)
    now = 5_000
    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)).rejects.toMatchObject({
      status: 401
    })
    await expect(esi.getAuthenticatedCharacterLocation(CHARACTER_ID, TOKEN)).resolves.toMatchObject({
      solarSystemId: SYSTEM_ID + 1
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    cache.close()
  })
})

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function captureError(operation: Promise<unknown>): Promise<Error & { status?: number }> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`Expected Error, received ${String(error)}`)
  }
  throw new Error('Expected operation to reject')
}

function responseForRoute(url: string): Response {
  if (url.endsWith('/location/')) return locationResponse(SYSTEM_ID)
  if (url.endsWith('/online/')) return onlineResponse()
  if (url.endsWith('/ship/')) return shipResponse()
  return jsonResponse({ error: `unexpected request: ${url}` }, 500)
}

function locationResponse(solarSystemId: number): Response {
  return jsonResponse({ solar_system_id: solarSystemId })
}

function onlineResponse(): Response {
  return jsonResponse({ online: true })
}

function shipResponse(): Response {
  return jsonResponse({ ship_item_id: 123_456, ship_name: 'Astero', ship_type_id: 11_978 })
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}
