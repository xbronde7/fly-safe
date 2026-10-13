import { afterEach, describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { ESI_AUTH_SCOPES, EsiClient } from '../src/main/esi-client'
import { SystemIntelService } from '../src/main/system-intel-service'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const SYSTEM_ID = 30_000_142
const CONSTELLATION_ID = 20_000_020
const REGION_ID = 10_000_002
const HASH = 'c'.repeat(40)

const fullKillmail = {
  killmail_id: 700_001,
  killmail_time: '2026-08-21T12:00:00Z',
  solar_system_id: SYSTEM_ID,
  victim: { character_id: 90_001, ship_type_id: 11_978 },
  attackers: [
    { character_id: 90_002, ship_type_id: 17_918, final_blow: true },
    { character_id: 90_003, ship_type_id: 17_918, final_blow: false }
  ]
}

const compactKillmail = {
  killmail_id: 700_002,
  zkb: { hash: HASH, totalValue: 55_000_000 }
}

const hydratedKillmail = {
  killmail_id: 700_002,
  killmail_time: '2026-08-21T11:00:00Z',
  solar_system_id: SYSTEM_ID,
  victim: { character_id: 90_002, ship_type_id: 17_918 },
  attackers: [{ character_id: 90_001, ship_type_id: 11_978, final_blow: true }]
}

const names = new Map([
  [90_001, { name: 'Victim One', category: 'character' }],
  [90_002, { name: 'Hunter Two', category: 'character' }],
  [90_003, { name: 'Hunter Three', category: 'character' }],
  [11_978, { name: 'Astero', category: 'inventory_type' }],
  [17_918, { name: 'Rattlesnake', category: 'inventory_type' }]
])

describe('SystemIntelService', () => {
  let service: SystemIntelService | null = null

  afterEach(() => {
    service?.close()
    service = null
  })

  it('combines metadata, hourly aggregates, hydrated zKill history, names, scoring, and cache', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith(`/universe/systems/${SYSTEM_ID}/`)) {
        return jsonResponse({
          name: 'Jita',
          constellation_id: CONSTELLATION_ID,
          security_status: 0.945,
          security_class: 'B'
        })
      }
      if (url.endsWith(`/universe/constellations/${CONSTELLATION_ID}/`)) {
        return jsonResponse({ name: 'Kimotoro', region_id: REGION_ID })
      }
      if (url.endsWith(`/universe/regions/${REGION_ID}/`)) {
        return jsonResponse({ name: 'The Forge' })
      }
      if (url.endsWith('/universe/system_kills/')) {
        return jsonResponse([
          { system_id: SYSTEM_ID, ship_kills: 2, pod_kills: 1, npc_kills: 77 }
        ])
      }
      if (url.endsWith('/universe/system_jumps/')) {
        return jsonResponse([{ system_id: SYSTEM_ID, ship_jumps: 100 }])
      }
      if (url.endsWith(`/api/systemID/${SYSTEM_ID}/pastSeconds/86400/page/1/`)) {
        return jsonResponse([fullKillmail, compactKillmail])
      }
      if (url.endsWith(`/killmails/${compactKillmail.killmail_id}/${HASH}/`)) {
        return jsonResponse(hydratedKillmail)
      }
      if (url.endsWith('/universe/names/')) {
        expect(init?.method).toBe('POST')
        const ids = JSON.parse(String(init?.body)) as number[]
        return jsonResponse(ids.flatMap((id) => {
          const match = names.get(id)
          return match ? [{ id, ...match }] : []
        }))
      }
      return jsonResponse({ error: `unexpected request: ${url}` }, 500)
    })

    service = new SystemIntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkill.test', fetch: fetchMock, maxAttempts: 1 },
      now: () => new Date('2026-08-21T13:00:00Z')
    })

    const first = await service.getSystemIntel(SYSTEM_ID)
    expect(first).toMatchObject({
      system: {
        id: SYSTEM_ID,
        name: 'Jita',
        securityStatus: 0.945,
        constellationName: 'Kimotoro',
        regionName: 'The Forge',
        isWormhole: false
      },
      lastHour: {
        shipKills: 2,
        podKills: 1,
        npcKills: 77,
        jumps: 100,
        access: 'public',
        temporal: 'historical'
      },
      zkill24h: {
        count: 2,
        sourceCapped: false,
        latestCapped: false,
        capped: false,
        access: 'public',
        temporal: 'historical'
      },
      fetchedAt: '2026-08-21T13:00:00.000Z',
      cached: false,
      warnings: [],
      provenance: {
        access: 'public',
        temporal: 'historical',
        liveRosterAvailable: false
      }
    })
    expect(first.zkill24h.latest).toHaveLength(2)
    expect(first.zkill24h.latest[0]).toMatchObject({
      victimName: 'Victim One',
      victimShipName: 'Astero'
    })
    expect(first.zkill24h.latest[1].totalValue).toBe(55_000_000)
    expect(first.zkill24h.observedShips[0]).toMatchObject({
      typeId: 17_918,
      name: 'Rattlesnake',
      victimCount: 1,
      attackerCount: 2
    })
    expect(first.zkill24h.observedPilots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ characterId: 90_001, name: 'Victim One' }),
        expect.objectContaining({ characterId: 90_002, name: 'Hunter Two' })
      ])
    )
    expect(first.danger.score).toBeGreaterThan(0)
    expect(first.danger.score).toBe(
      first.danger.factors.reduce((sum, factor) => sum + factor.points, 0)
    )

    const callsAfterFirst = fetchMock.mock.calls.length
    const second = await service.analyze({ solarSystemId: SYSTEM_ID })
    expect(second.cached).toBe(true)
    expect(second.zkill24h).toEqual(first.zkill24h)
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst)
  })

  it('reports a full zKill source page separately from local list truncation', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith(`/universe/systems/${SYSTEM_ID}/`)) {
        return jsonResponse({
          name: 'Jita',
          constellation_id: CONSTELLATION_ID,
          security_status: 0.945
        })
      }
      if (url.endsWith(`/universe/constellations/${CONSTELLATION_ID}/`)) {
        return jsonResponse({ name: 'Kimotoro', region_id: REGION_ID })
      }
      if (url.endsWith(`/universe/regions/${REGION_ID}/`)) return jsonResponse({ name: 'The Forge' })
      if (url.endsWith('/universe/system_kills/') || url.endsWith('/universe/system_jumps/')) {
        return jsonResponse([])
      }
      if (url.endsWith(`/api/systemID/${SYSTEM_ID}/pastSeconds/86400/page/1/`)) {
        return jsonResponse(Array.from({ length: 200 }, () => fullKillmail))
      }
      if (url.endsWith('/universe/names/')) {
        const ids = JSON.parse(String(init?.body)) as number[]
        return jsonResponse(ids.flatMap((id) => {
          const match = names.get(id)
          return match ? [{ id, ...match }] : []
        }))
      }
      return jsonResponse({ error: `unexpected request: ${url}` }, 500)
    })

    service = new SystemIntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkill.test', fetch: fetchMock, maxAttempts: 1 }
    })

    const result = await service.getSystemIntel(SYSTEM_ID)
    expect(result.zkill24h).toMatchObject({
      count: 1,
      sourceCapped: true,
      latestCapped: false,
      capped: true,
      observedShipsCapped: false,
      observedPilotsCapped: false
    })
  })

  it('uses zero for missing known-space aggregate rows', async () => {
    const fetchMock = baseEmptyFetch(SYSTEM_ID)
    service = new SystemIntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkill.test', fetch: fetchMock, maxAttempts: 1 }
    })

    const result = await service.getSystemIntel(SYSTEM_ID)
    expect(result.lastHour).toMatchObject({
      shipKills: 0,
      podKills: 0,
      npcKills: 0,
      jumps: 0
    })
    expect(result.zkill24h.count).toBe(0)
  })

  it('keeps wormhole hourly metrics null and skips irrelevant global endpoints', async () => {
    const wormholeId = 31_000_001
    const fetchMock = baseEmptyFetch(wormholeId)
    service = new SystemIntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkill.test', fetch: fetchMock, maxAttempts: 1 }
    })

    const result = await service.getSystemIntel(wormholeId)
    expect(result.system.isWormhole).toBe(true)
    expect(result.lastHour).toMatchObject({
      shipKills: null,
      podKills: null,
      npcKills: null,
      jumps: null
    })
    expect(fetchMock.mock.calls.map(([input]) => String(input)).join('\n')).not.toContain(
      'system_kills'
    )
    expect(fetchMock.mock.calls.map(([input]) => String(input)).join('\n')).not.toContain(
      'system_jumps'
    )
  })

  it('keeps unavailable aggregates null and reports partial source failures', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith(`/universe/systems/${SYSTEM_ID}/`)) {
        return jsonResponse({
          name: 'Jita',
          constellation_id: CONSTELLATION_ID,
          security_status: 0.945
        })
      }
      if (url.endsWith(`/universe/constellations/${CONSTELLATION_ID}/`)) {
        return jsonResponse({ name: 'Kimotoro', region_id: REGION_ID })
      }
      if (url.endsWith(`/universe/regions/${REGION_ID}/`)) return jsonResponse({ name: 'The Forge' })
      if (url.includes('system_kills') || url.includes('system_jumps')) {
        return jsonResponse({ error: 'offline' }, 503)
      }
      if (url.includes('/api/systemID/')) return jsonResponse({ error: 'offline' }, 503)
      return jsonResponse({ error: `unexpected request: ${url}` }, 500)
    })
    service = new SystemIntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkill.test', fetch: fetchMock, maxAttempts: 1 }
    })

    const result = await service.getSystemIntel(SYSTEM_ID)
    expect(result.lastHour).toMatchObject({
      shipKills: null,
      podKills: null,
      npcKills: null,
      jumps: null
    })
    expect(result.zkill24h.count).toBeNull()
    expect(result.cached).toBe(false)
    expect(result.warnings.join(' ')).toContain('kills per hour')
    expect(result.warnings.join(' ')).toContain('jumps per hour')
    expect(result.warnings.join(' ')).toContain('zKill')
  })

  it('clears an injected system cache without taking ownership of its close', () => {
    const cache = new Cache(':memory:')
    cache.set('system', '30000142', { name: 'Jita' }, 10_000)
    service = new SystemIntelService(':memory:', { cache })

    service.clearCache()
    expect(cache.count()).toBe(0)

    service.close()
    expect(() => cache.count()).not.toThrow()
    cache.close()
  })
})

describe('EsiClient authenticated location contract', () => {
  it('uses bearer access without persisting authenticated state and documents exact scopes', async () => {
    const cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token-value')
      if (url.endsWith('/characters/9001/location/')) {
        return jsonResponse({ solar_system_id: SYSTEM_ID, station_id: 60_000_001 })
      }
      if (url.endsWith('/characters/9001/online/')) {
        return jsonResponse({
          online: true,
          last_login: '2026-08-21T10:00:00Z',
          logins: 12
        })
      }
      if (url.endsWith('/characters/9001/ship/')) {
        return jsonResponse({ ship_item_id: 123_456, ship_name: 'My Astero', ship_type_id: 11_978 })
      }
      return jsonResponse({ error: `unexpected request: ${url}` }, 500)
    })
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    await expect(esi.getAuthenticatedCharacterLocation(9_001, 'token-value')).resolves.toEqual({
      solarSystemId: SYSTEM_ID,
      stationId: 60_000_001,
      structureId: null
    })
    await expect(esi.getAuthenticatedCharacterOnline(9_001, 'token-value')).resolves.toEqual({
      online: true,
      lastLogin: '2026-08-21T10:00:00Z',
      lastLogout: null,
      logins: 12
    })
    await expect(esi.getAuthenticatedCharacterShip(9_001, 'token-value')).resolves.toEqual({
      shipItemId: 123_456,
      shipName: 'My Astero',
      shipTypeId: 11_978
    })
    await esi.getAuthenticatedCharacterLocation(9_001, 'token-value')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(cache.count()).toBe(0)
    expect(ESI_AUTH_SCOPES).toEqual({
      location: 'esi-location.read_location.v1',
      online: 'esi-location.read_online.v1',
      ship: 'esi-location.read_ship_type.v1'
    })
    await expect(esi.getAuthenticatedCharacterLocation(9_001, '   ')).rejects.toThrow(
      'Access token is required'
    )
    cache.close()
  })

  it.each([
    {
      source: String.raw`u'\u041c\u043e\u0439 \u043a\u043e\u0440\u0430\u0431\u043b\u044c'`,
      expected: 'Мой корабль'
    },
    {
      source: String.raw`U"\U0001F680 \u041c\u0430\u044f\u043a"`,
      expected: '🚀 Маяк'
    },
    {
      source: String.raw`u'\u041c\u043e\u0439 \'\u0441\u043a\u0430\u043d\u0435\u0440'`,
      expected: "Мой 'сканер"
    }
  ])('decodes a complete escaped unicode ship name: $source', async ({ source, expected }) => {
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      maxAttempts: 1,
      fetch: vi.fn<typeof fetch>(async () => jsonResponse({
        ship_item_id: 123_456,
        ship_name: source,
        ship_type_id: 11_978
      }))
    })

    await expect(esi.getAuthenticatedCharacterShip(9_001, 'token-value')).resolves.toMatchObject({
      shipName: expected
    })
    cache.close()
  })

  it.each([
    String.raw`u'Literal'`,
    String.raw`u'\u041G'`,
    String.raw`u'\ud83d'`,
    String.raw`u'\u041c\n'`,
    String.raw`\u041c\u043e\u0439`
  ])('keeps a non-matching or malformed escaped ship name unchanged: %s', async (source) => {
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      maxAttempts: 1,
      fetch: vi.fn<typeof fetch>(async () => jsonResponse({
        ship_item_id: 123_456,
        ship_name: source,
        ship_type_id: 11_978
      }))
    })

    await expect(esi.getAuthenticatedCharacterShip(9_001, 'token-value')).resolves.toMatchObject({
      shipName: source
    })
    cache.close()
  })
})

function baseEmptyFetch(solarSystemId: number): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith(`/universe/systems/${solarSystemId}/`)) {
      return jsonResponse({
        name: solarSystemId >= 31_000_000 ? 'J100001' : 'Jita',
        constellation_id: CONSTELLATION_ID,
        security_status: solarSystemId >= 31_000_000 ? -0.99 : 0.945
      })
    }
    if (url.endsWith(`/universe/constellations/${CONSTELLATION_ID}/`)) {
      return jsonResponse({ name: 'Constellation', region_id: REGION_ID })
    }
    if (url.endsWith(`/universe/regions/${REGION_ID}/`)) return jsonResponse({ name: 'Region' })
    if (url.endsWith('/universe/system_kills/')) return jsonResponse([])
    if (url.endsWith('/universe/system_jumps/')) return jsonResponse([])
    if (url.includes(`/api/systemID/${solarSystemId}/pastSeconds/86400/page/1/`)) {
      return jsonResponse([])
    }
    return jsonResponse({ error: `unexpected request: ${url}` }, 500)
  })
}
