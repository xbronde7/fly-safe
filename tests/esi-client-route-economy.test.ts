import { describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { EsiClient } from '../src/main/esi-client'

const CHARACTER_ID = 90_000_001
const TOKEN = 'secret-access-token'

describe('EsiClient route planning', () => {
  it('shares the full ESI Retry-After cooldown across unrelated request routes', async () => {
    let now = Date.parse('2026-08-25T12:00:00Z')
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => jsonResponse(
        { error: 'internal upstream detail must stay private' },
        429,
        { 'Retry-After': '120' }
      ))
      .mockImplementation(async (input) => {
        expect(new URL(String(input)).pathname).toBe('/universe/systems/30000144/')
        return jsonResponse({
          constellation_id: 20_000_020,
          name: 'Perimeter',
          security_status: 1
        })
      })
    const cache = new Cache(':memory:')
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 3,
      now: () => now
    })

    const limited = client.getRouteSystems(30_000_142, 30_002_187, 'secure')
    await expect(limited).rejects.toMatchObject({
      status: 429,
      message: 'ESI request paused by rate limit'
    })
    await expect(limited).rejects.not.toThrow('internal upstream detail')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 119_999
    await expect(client.getSolarSystem(30_000_144, true)).rejects.toMatchObject({ status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 1
    await expect(client.getSolarSystem(30_000_144, true)).resolves.toMatchObject({
      id: 30_000_144,
      name: 'Perimeter'
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    cache.close()
  })

  it('keeps automatic retries for side-effect-free route reads', async () => {
    const cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => jsonResponse(
        { error: 'temporary' },
        503,
        { 'Retry-After': '0' }
      ))
      .mockImplementationOnce(async () => jsonResponse({
        route: [30_000_142, 30_002_187]
      }))
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 2
    })

    await expect(client.getRouteSystems(30_000_142, 30_002_187, 'secure'))
      .resolves.toMatchObject({ systemIds: [30_000_142, 30_002_187] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    cache.close()
  })

  it('fast-fails and shares a long Retry-After from any retryable ESI response', async () => {
    let now = Date.parse('2026-08-25T12:00:00Z')
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => jsonResponse(
        { error: 'private overload detail' },
        503,
        { 'Retry-After': '120' }
      ))
      .mockImplementationOnce(async () => jsonResponse({
        constellation_id: 20_000_020,
        name: 'Perimeter',
        security_status: 1
      }))
    const cache = new Cache(':memory:')
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 3,
      now: () => now
    })

    const limited = client.getRouteSystems(30_000_142, 30_002_187, 'secure')
    await expect(limited).rejects.toMatchObject({
      status: 503,
      message: 'ESI 503: server requested retry later'
    })
    await expect(limited).rejects.not.toThrow('private overload detail')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 119_999
    await expect(client.getSolarSystem(30_000_144, true)).rejects.toMatchObject({
      status: 503,
      message: 'ESI request paused by server Retry-After'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 1
    await expect(client.getSolarSystem(30_000_144, true)).resolves.toMatchObject({
      id: 30_000_144,
      name: 'Perimeter'
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    cache.close()
  })

  it('loads and caches a strictly bounded public route', async () => {
    const cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/route/30000142/30002187')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        preference: 'Safer',
        security_penalty: 50
      })
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return jsonResponse({ route: [30_000_142, 30_002_659, 30_002_187] }, 200, {
        ETag: '"route-v1"',
        'Cache-Control': 'public, max-age=60'
      })
    })
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1,
      now: () => Date.parse('2026-08-25T12:00:00Z')
    })

    await expect(client.getRouteSystems(30_000_142, 30_002_187, 'secure')).resolves.toEqual({
      systemIds: [30_000_142, 30_002_659, 30_002_187],
      fetchedAt: '2026-08-25T12:00:00.000Z',
      cached: false
    })
    await expect(client.getRouteSystems(30_000_142, 30_002_187, 'secure')).resolves.toMatchObject({
      cached: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(client.getRouteSystems(30_000_142, 30_002_187, 'invalid' as never))
      .rejects.toThrow('Invalid route mode')
    cache.close()
  })

  it('rejects an oversized route response before downstream metadata fan-out', async () => {
    const cache = new Cache(':memory:')
    const route = Array.from({ length: 257 }, (_, index) => 30_000_142 + index)
    route[route.length - 1] = 30_002_187
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: async () => jsonResponse({ route }),
      maxAttempts: 1
    })

    await expect(client.getRouteSystems(30_000_142, 30_002_187, 'secure'))
      .rejects.toThrow('unexpected response')
    cache.close()
  })

  it('installs an ordered corridor through scoped EVE autopilot waypoints', async () => {
    const cache = new Cache(':memory:')
    const calls: Array<{
      destination: string | null
      clear: string | null
      beginning: string | null
    }> = []
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/ui/autopilot/waypoint/')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
      calls.push({
        destination: url.searchParams.get('destination_id'),
        clear: url.searchParams.get('clear_other_waypoints'),
        beginning: url.searchParams.get('add_to_beginning')
      })
      return new Response(null, { status: 204 })
    })
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    await expect(client.setAuthenticatedAutopilotRoute(
      [30_000_144, 30_000_144, 30_002_187],
      TOKEN
    )).resolves.toEqual({
      destinationIds: [30_000_144, 30_002_187],
      waypointsSet: 2
    })
    expect(calls).toEqual([
      { destination: '30002187', clear: 'true', beginning: 'false' },
      { destination: '30000144', clear: 'false', beginning: 'true' }
    ])
    await expect(client.setAuthenticatedAutopilotRoute([], TOKEN))
      .rejects.toThrow('at least one')
    cache.close()
  })

  it('never automatically retries an ambiguous waypoint mutation', async () => {
    const cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => { throw new Error('socket closed') })
      .mockImplementationOnce(async () => jsonResponse(
        { error: 'temporary waypoint failure' },
        503,
        { 'Retry-After': '0' }
      ))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }))
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 3
    })

    await expect(client.setAuthenticatedAutopilotWaypoint(30_000_144, TOKEN))
      .rejects.toThrow('socket closed')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await expect(client.setAuthenticatedAutopilotWaypoint(30_000_144, TOKEN))
      .rejects.toMatchObject({ status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await expect(client.setAuthenticatedAutopilotWaypoint(30_000_144, TOKEN)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    cache.close()
  })
})

describe('EsiClient personal economy routes', () => {
  it('loads scoped wallet, order and asset data with pagination and strict mapping', async () => {
    const cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)

      if (url.pathname.endsWith('/wallet/')) return jsonResponse(123_456.78)
      if (url.pathname.endsWith('/orders/')) return jsonResponse([rawOrder('open')])
      if (url.pathname.endsWith('/orders/history/')) {
        const page = Number(url.searchParams.get('page'))
        return jsonResponse([rawOrder(page === 1 ? 'cancelled' : 'expired', page)], 200, {
          ...(page === 1 ? { 'X-Pages': '2' } : {}),
          'Last-Modified': 'Tue, 25 Aug 2026 12:00:00 GMT'
        })
      }
      if (url.pathname.endsWith('/wallet/transactions/')) {
        return jsonResponse([rawTransaction(77)])
      }
      if (url.pathname.endsWith('/assets/')) {
        const page = Number(url.searchParams.get('page'))
        return jsonResponse([rawAsset(page)], 200, {
          ...(page === 1 ? { 'X-Pages': '2' } : {}),
          'Last-Modified': 'Tue, 25 Aug 2026 12:00:00 GMT'
        })
      }
      throw new Error(`Unexpected ESI route ${url}`)
    })
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    await expect(client.getAuthenticatedCharacterWallet(CHARACTER_ID, TOKEN))
      .resolves.toBe(123_456.78)
    await expect(client.getAuthenticatedCharacterOrders(CHARACTER_ID, TOKEN))
      .resolves.toEqual([expectedOrder('open', 1)])
    await expect(client.getAuthenticatedCharacterOrderHistory(CHARACTER_ID, TOKEN))
      .resolves.toEqual([
        expectedOrder('cancelled', 1),
        expectedOrder('expired', 2)
      ])
    await expect(client.getAuthenticatedCharacterWalletTransactions(CHARACTER_ID, TOKEN))
      .resolves.toEqual([{
        transactionId: 77,
        date: '2026-08-25T10:00:00Z',
        typeId: 34,
        quantity: 10,
        unitPrice: 5.25,
        buy: true,
        personal: true,
        locationId: 60_003_760,
        clientId: 90_000_002
      }])
    await expect(client.getAuthenticatedCharacterAssets(CHARACTER_ID, TOKEN))
      .resolves.toEqual([
        expectedAsset(1),
        expectedAsset(2)
      ])
    expect(fetchMock).toHaveBeenCalledTimes(8)
    cache.close()
  })

  it('follows the wallet transaction from_id cursor without duplicating its boundary', async () => {
    const cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      const cursor = url.searchParams.get('from_id')
      if (cursor === null) {
        return jsonResponse([rawTransaction(5_000), rawTransaction(4_999), rawTransaction(4_998)])
      }
      if (cursor === '4998') {
        return jsonResponse([rawTransaction(4_998), rawTransaction(4_997)])
      }
      expect(cursor).toBe('4997')
      return jsonResponse([rawTransaction(4_997)])
    })
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    const rows = await client.getAuthenticatedCharacterWalletTransactions(CHARACTER_ID, TOKEN)
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((row) => row.transactionId)).size).toBe(4)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    cache.close()
  })

  it('loads public market prices without leaking an SSO token', async () => {
    const cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return jsonResponse([
        { type_id: 34, average_price: 5.2, adjusted_price: 5 },
        { type_id: 35, adjusted_price: 10 }
      ])
    })
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    await expect(client.getMarketPrices()).resolves.toEqual([
      { typeId: 34, averagePrice: 5.2, adjustedPrice: 5 },
      { typeId: 35, averagePrice: null, adjustedPrice: 10 }
    ])
    cache.close()
  })

  it('caches private structure names per character and revalidates successful responses', async () => {
    const cache = new Cache(':memory:')
    const structureId = 1_041_132_165_591
    let now = Date.parse('2026-08-25T12:00:00Z')
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe(`/universe/structures/${structureId}/`)
      const headers = new Headers(init?.headers)
      const token = headers.get('authorization')
      if (headers.get('if-none-match') === '"structure-a"') {
        return new Response(null, {
          status: 304,
          headers: { 'Cache-Control': 'max-age=60', ETag: '"structure-a"' }
        })
      }
      return jsonResponse({
        name: token === 'Bearer token-b' ? 'Character B Structure' : 'Character A Structure',
        owner_id: 98_000_001,
        solar_system_id: 30_001_059,
        type_id: 35_834
      }, 200, {
        'Cache-Control': 'max-age=1',
        ETag: token === 'Bearer token-b' ? '"structure-b"' : '"structure-a"'
      })
    })
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1,
      now: () => now
    })

    await expect(client.getAuthenticatedUniverseStructure(CHARACTER_ID, structureId, TOKEN))
      .resolves.toEqual({
        structureId,
        name: 'Character A Structure',
        solarSystemId: 30_001_059,
        typeId: 35_834,
        ownerId: 98_000_001,
        cached: false
      })
    await expect(client.getAuthenticatedUniverseStructure(CHARACTER_ID, structureId, TOKEN))
      .resolves.toMatchObject({ name: 'Character A Structure', cached: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    now += 2_000
    await expect(client.getAuthenticatedUniverseStructure(CHARACTER_ID, structureId, TOKEN))
      .resolves.toMatchObject({ name: 'Character A Structure', cached: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await expect(client.getAuthenticatedUniverseStructure(
      CHARACTER_ID + 1,
      structureId,
      'token-b'
    )).resolves.toMatchObject({ name: 'Character B Structure', cached: false })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    cache.close()
  })

  it('does not cache inaccessible private structure responses', async () => {
    const cache = new Cache(':memory:')
    const structureId = 1_041_132_165_591
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(
      { error: 'Forbidden' },
      403
    ))
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    await expect(client.getAuthenticatedUniverseStructure(CHARACTER_ID, structureId, TOKEN))
      .rejects.toMatchObject({ status: 403 })
    await expect(client.getAuthenticatedUniverseStructure(CHARACTER_ID, structureId, TOKEN))
      .rejects.toMatchObject({ status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    cache.close()
  })
})

function rawOrder(state: 'open' | 'cancelled' | 'expired', index = 1): Record<string, unknown> {
  return {
    duration: 90,
    escrow: 12.5,
    is_buy_order: true,
    issued: '2026-08-20T00:00:00Z',
    location_id: 60_003_760,
    min_volume: 1,
    order_id: index,
    price: 5.5,
    region_id: 10_000_002,
    ...(state === 'open' ? {} : { state }),
    type_id: 34,
    volume_remain: 50,
    volume_total: 100
  }
}

function expectedOrder(
  state: 'open' | 'cancelled' | 'expired',
  index: number
): Record<string, unknown> {
  return {
    orderId: index,
    typeId: 34,
    locationId: 60_003_760,
    regionId: 10_000_002,
    buyOrder: true,
    price: 5.5,
    volumeRemain: 50,
    volumeTotal: 100,
    minVolume: 1,
    issued: '2026-08-20T00:00:00Z',
    durationDays: 90,
    escrow: 12.5,
    state
  }
}

function rawTransaction(transactionId: number): Record<string, unknown> {
  return {
    client_id: 90_000_002,
    date: '2026-08-25T10:00:00Z',
    is_buy: true,
    is_personal: true,
    location_id: 60_003_760,
    quantity: 10,
    transaction_id: transactionId,
    type_id: 34,
    unit_price: 5.25
  }
}

function rawAsset(index: number): Record<string, unknown> {
  return {
    is_singleton: index === 2,
    item_id: index,
    location_flag: 'Hangar',
    location_id: 60_003_760,
    location_type: 'station',
    quantity: index === 2 ? -1 : 100,
    type_id: index === 1 ? 34 : 587
  }
}

function expectedAsset(index: number): Record<string, unknown> {
  return {
    itemId: index,
    typeId: index === 1 ? 34 : 587,
    quantity: index === 1 ? 100 : 1,
    locationId: 60_003_760,
    locationType: 'station',
    locationFlag: 'Hangar',
    singleton: index === 2
  }
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
