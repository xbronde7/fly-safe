import { afterEach, describe, expect, it, vi } from 'vitest'
import { IntelService } from '../src/main/intel-service'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const CHARACTER_ID = 90_001
const KILLMAIL_HASH = 'a'.repeat(40)
const NPC_SHIP_TYPE_ID = 37_556

const capsuleerParticipantNameIds = [
  CHARACTER_ID,
  98_001,
  99_001,
  17_918,
  28_301,
  90_102,
  98_102,
  99_102,
  17_915,
  28_302,
  90_103,
  98_103,
  99_103,
  17_916,
  28_303,
  90_104,
  98_104,
  99_104,
  17_917,
  28_304,
  90_105,
  98_105,
  99_105,
  17_919,
  28_305,
  90_999,
  98_999,
  99_999,
  17_920,
  28_399
]

const fullKill = {
  killmail_id: 100_001,
  killmail_time: '2026-08-20T12:34:56Z',
  solar_system_id: 30_000_142,
  victim: {
    character_id: 90_101,
    corporation_id: 98_101,
    ship_type_id: 33_468,
    items: [
      { item_type_id: 20_401, flag: 27, quantity_destroyed: 1 },
      { item_type_id: 20_402, flag: 19, quantity_dropped: 1 },
      { item_type_id: 20_403, flag: 5, quantity_destroyed: 500 }
    ]
  },
  attackers: [
    {
      character_id: 90_102,
      corporation_id: 98_102,
      alliance_id: 99_102,
      ship_type_id: 17_915,
      weapon_type_id: 28_302,
      damage_done: 12_300,
      final_blow: false
    },
    {
      character_id: CHARACTER_ID,
      corporation_id: 98_001,
      alliance_id: 99_001,
      ship_type_id: 17_918,
      weapon_type_id: 28_301,
      damage_done: 5_000,
      final_blow: true
    },
    {
      character_id: 90_103,
      corporation_id: 98_103,
      alliance_id: 99_103,
      ship_type_id: 17_916,
      weapon_type_id: 28_303,
      damage_done: 34_100,
      final_blow: false
    },
    {
      corporation_id: 1_000_125,
      ship_type_id: NPC_SHIP_TYPE_ID,
      weapon_type_id: 38_888,
      damage_done: 99_999,
      final_blow: false
    },
    {
      character_id: 90_104,
      corporation_id: 98_104,
      alliance_id: 99_104,
      ship_type_id: 17_917,
      weapon_type_id: 28_304,
      damage_done: 34_000,
      final_blow: false
    },
    {
      character_id: 90_105,
      corporation_id: 98_105,
      alliance_id: 99_105,
      ship_type_id: 17_919,
      weapon_type_id: 28_305,
      damage_done: 9_000,
      final_blow: false
    }
  ],
  zkb: {
    totalValue: 123_456_789.25,
    solo: false
  }
}

const compactLoss = {
  killmail_id: 100_002,
  zkb: {
    hash: KILLMAIL_HASH,
    totalValue: 987_654_321,
    solo: false
  }
}

const hydratedLoss = {
  killmail_id: 100_002,
  killmail_time: '2026-08-19T01:02:03Z',
  solar_system_id: 30_002_365,
  victim: {
    character_id: CHARACTER_ID,
    corporation_id: 98_001,
    ship_type_id: 11_987,
    items: [
      { item_type_id: 20_501, flag: 11, quantity_destroyed: 1 },
      { item_type_id: 20_502, flag: 92, quantity_dropped: 2 },
      {
        item_type_id: 20_503,
        flag: 5,
        quantity_dropped: 1,
        items: [{ item_type_id: 20_504, flag: 5, quantity_destroyed: 200 }]
      }
    ]
  },
  attackers: [
    {
      character_id: 90_999,
      corporation_id: 98_999,
      alliance_id: 99_999,
      ship_type_id: 17_920,
      weapon_type_id: 28_399,
      damage_done: 22_222,
      final_blow: true
    }
  ]
}

const universeNames = new Map<number, { name: string; category: string }>([
  [30_000_142, { name: 'Jita', category: 'solar_system' }],
  [30_002_365, { name: 'Amamake', category: 'solar_system' }],
  [90_001, { name: 'Watched Pilot', category: 'character' }],
  [90_101, { name: 'Scanner Victim', category: 'character' }],
  [90_102, { name: 'Bait Pilot', category: 'character' }],
  [90_103, { name: 'Top Damage', category: 'character' }],
  [90_104, { name: 'Second Damage', category: 'character' }],
  [90_105, { name: 'Gang Scout', category: 'character' }],
  [90_999, { name: 'Loss Final Blower', category: 'character' }],
  [98_001, { name: 'Watched Corp', category: 'corporation' }],
  [98_101, { name: 'Explorer Corp', category: 'corporation' }],
  [98_102, { name: 'Bait Corp', category: 'corporation' }],
  [98_103, { name: 'Damage Corp', category: 'corporation' }],
  [98_104, { name: 'Second Corp', category: 'corporation' }],
  [98_105, { name: 'Scout Corp', category: 'corporation' }],
  [98_999, { name: 'Loss Corp', category: 'corporation' }],
  [99_001, { name: 'Watched Alliance', category: 'alliance' }],
  [99_102, { name: 'Bait Alliance', category: 'alliance' }],
  [99_103, { name: 'Damage Alliance', category: 'alliance' }],
  [99_104, { name: 'Second Alliance', category: 'alliance' }],
  [99_105, { name: 'Scout Alliance', category: 'alliance' }],
  [99_999, { name: 'Loss Alliance', category: 'alliance' }],
  [33_468, { name: 'Astero', category: 'inventory_type' }],
  [11_987, { name: 'Crow', category: 'inventory_type' }],
  [17_915, { name: 'Scimitar', category: 'inventory_type' }],
  [17_916, { name: 'Sleipnir', category: 'inventory_type' }],
  [17_917, { name: 'Hurricane Fleet Issue', category: 'inventory_type' }],
  [17_918, { name: 'Rattlesnake', category: 'inventory_type' }],
  [17_919, { name: 'Stiletto', category: 'inventory_type' }],
  [17_920, { name: 'Vagabond', category: 'inventory_type' }],
  [28_301, { name: 'Cruise Missile Launcher II', category: 'inventory_type' }],
  [28_302, { name: '200mm AutoCannon II', category: 'inventory_type' }],
  [28_303, { name: '720mm Howitzer Artillery II', category: 'inventory_type' }],
  [28_304, { name: '425mm AutoCannon II', category: 'inventory_type' }],
  [28_305, { name: 'Warp Disruptor II', category: 'inventory_type' }],
  [28_399, { name: 'Heavy Assault Missile Launcher II', category: 'inventory_type' }],
  [20_401, { name: 'Covert Ops Cloaking Device II', category: 'inventory_type' }],
  [20_402, { name: 'Scan Rangefinding Array II', category: 'inventory_type' }],
  [20_403, { name: 'Sisters Core Scanner Probe', category: 'inventory_type' }],
  [20_501, { name: 'Nanofiber Internal Structure II', category: 'inventory_type' }],
  [20_502, { name: 'Small Polycarbon Engine Housing II', category: 'inventory_type' }],
  [20_503, { name: 'Small Secure Container', category: 'inventory_type' }],
  [20_504, { name: 'Caldari Navy Scourge Rocket', category: 'inventory_type' }]
])

describe('IntelService.getCombatHistory', () => {
  let service: IntelService | null = null

  afterEach(() => {
    service?.close()
    service = null
  })

  it('builds kill/loss fits, resolves names, hydrates zkbOnly records and reuses cache', async () => {
    const universeNameRequests: number[][] = []
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)

      if (url.endsWith(`/api/kills/characterID/${CHARACTER_ID}/page/1/`)) {
        return jsonResponse([fullKill])
      }
      if (url.endsWith(`/api/losses/characterID/${CHARACTER_ID}/page/1/`)) {
        return jsonResponse([compactLoss])
      }
      if (url.endsWith(`/killmails/${compactLoss.killmail_id}/${KILLMAIL_HASH}/`)) {
        expect(init?.method).toBe('GET')
        return jsonResponse(hydratedLoss)
      }
      if (url.endsWith('/universe/types/33468/')) {
        return jsonResponse({
          type_id: 33_468,
          name: 'Astero',
          group_id: 25,
          mass: 1_150_000
        })
      }
      if (url.endsWith('/universe/names/')) {
        expect(init?.method).toBe('POST')
        const ids = JSON.parse(String(init?.body)) as number[]
        universeNameRequests.push(ids)
        return jsonResponse(
          ids.flatMap((id) => {
            const match = universeNames.get(id)
            return match ? [{ id, ...match }] : []
          })
        )
      }

      return jsonResponse({ error: `unexpected request: ${url}` }, 500)
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkill.test', fetch: fetchMock, maxAttempts: 1 }
    })

    const first = await service.getCombatHistory({ characterId: CHARACTER_ID, limit: 5 })

    expect(first).toMatchObject({
      characterId: CHARACTER_ID,
      cached: false,
      warnings: []
    })
    expect(first.kills).toHaveLength(1)
    expect(first.losses).toHaveLength(1)
    expect(first.pageInfo).toEqual({
      kill: { offset: 0, limit: 5, nextOffset: 1, hasMore: false },
      loss: { offset: 0, limit: 5, nextOffset: 1, hasMore: false }
    })
    expect(first.kills[0]).toMatchObject({
      kind: 'kill',
      killmailId: fullKill.killmail_id,
      time: '2026-08-20T12:34:56.000Z',
      solarSystemId: 30_000_142,
      solarSystemName: 'Jita',
      victimCharacterId: 90_101,
      victimName: 'Scanner Victim',
      victimCorporationName: 'Explorer Corp',
      victimShipGroupId: 25,
      attackerShipTypeId: 17_918,
      attackerShipName: 'Rattlesnake',
      pilotFinalBlow: true,
      attackerCount: 5,
      attackersCapped: false,
      nonCapsuleerAttackerCount: 1,
      totalValue: 123_456_789.25,
      solo: false
    })
    expect(first.kills[0].attackers).toEqual([
      {
        characterId: CHARACTER_ID,
        name: 'Watched Pilot',
        corporationId: 98_001,
        corporationName: 'Watched Corp',
        allianceId: 99_001,
        allianceName: 'Watched Alliance',
        shipTypeId: 17_918,
        shipName: 'Rattlesnake',
        weaponTypeId: 28_301,
        weaponName: 'Cruise Missile Launcher II',
        damageDone: 5_000,
        finalBlow: true
      },
      {
        characterId: 90_103,
        name: 'Top Damage',
        corporationId: 98_103,
        corporationName: 'Damage Corp',
        allianceId: 99_103,
        allianceName: 'Damage Alliance',
        shipTypeId: 17_916,
        shipName: 'Sleipnir',
        weaponTypeId: 28_303,
        weaponName: '720mm Howitzer Artillery II',
        damageDone: 34_100,
        finalBlow: false
      },
      {
        characterId: 90_104,
        name: 'Second Damage',
        corporationId: 98_104,
        corporationName: 'Second Corp',
        allianceId: 99_104,
        allianceName: 'Second Alliance',
        shipTypeId: 17_917,
        shipName: 'Hurricane Fleet Issue',
        weaponTypeId: 28_304,
        weaponName: '425mm AutoCannon II',
        damageDone: 34_000,
        finalBlow: false
      },
      {
        characterId: 90_102,
        name: 'Bait Pilot',
        corporationId: 98_102,
        corporationName: 'Bait Corp',
        allianceId: 99_102,
        allianceName: 'Bait Alliance',
        shipTypeId: 17_915,
        shipName: 'Scimitar',
        weaponTypeId: 28_302,
        weaponName: '200mm AutoCannon II',
        damageDone: 12_300,
        finalBlow: false
      },
      {
        characterId: 90_105,
        name: 'Gang Scout',
        corporationId: 98_105,
        corporationName: 'Scout Corp',
        allianceId: 99_105,
        allianceName: 'Scout Alliance',
        shipTypeId: 17_919,
        shipName: 'Stiletto',
        weaponTypeId: 28_305,
        weaponName: 'Warp Disruptor II',
        damageDone: 9_000,
        finalBlow: false
      }
    ])
    expect(first.kills[0].victimFit).toMatchObject({
      shipTypeId: 33_468,
      shipName: 'Astero',
      totalDestroyed: 501,
      totalDropped: 1
    })
    expect(first.kills[0].victimFit.sections.high).toEqual([
      expect.objectContaining({
        typeId: 20_401,
        name: 'Covert Ops Cloaking Device II',
        quantityDestroyed: 1
      })
    ])
    expect(first.kills[0].victimFit.sections.medium).toEqual([
      expect.objectContaining({
        typeId: 20_402,
        name: 'Scan Rangefinding Array II',
        quantityDropped: 1
      })
    ])
    expect(first.kills[0].victimFit.sections.cargo).toEqual([
      expect.objectContaining({
        typeId: 20_403,
        name: 'Sisters Core Scanner Probe',
        quantityDestroyed: 500
      })
    ])

    expect(first.losses[0]).toMatchObject({
      kind: 'loss',
      killmailId: compactLoss.killmail_id,
      time: '2026-08-19T01:02:03.000Z',
      solarSystemId: 30_002_365,
      solarSystemName: 'Amamake',
      victimCharacterId: CHARACTER_ID,
      victimName: 'Watched Pilot',
      victimCorporationName: 'Watched Corp',
      attackerShipTypeId: null,
      attackerShipName: null,
      pilotFinalBlow: false,
      attackerCount: 1,
      attackersCapped: false,
      nonCapsuleerAttackerCount: 0,
      totalValue: 987_654_321,
      solo: false
    })
    expect(first.losses[0].attackers).toEqual([
      {
        characterId: 90_999,
        name: 'Loss Final Blower',
        corporationId: 98_999,
        corporationName: 'Loss Corp',
        allianceId: 99_999,
        allianceName: 'Loss Alliance',
        shipTypeId: 17_920,
        shipName: 'Vagabond',
        weaponTypeId: 28_399,
        weaponName: 'Heavy Assault Missile Launcher II',
        damageDone: 22_222,
        finalBlow: true
      }
    ])
    expect(first.losses[0].attackers.map(({ characterId }) => characterId)).not.toContain(
      CHARACTER_ID
    )
    expect(first.losses[0].victimFit).toMatchObject({
      shipTypeId: 11_987,
      shipName: 'Crow',
      totalDestroyed: 201,
      totalDropped: 3
    })
    expect(first.losses[0].victimFit.sections.low[0]).toMatchObject({
      name: 'Nanofiber Internal Structure II'
    })
    expect(first.losses[0].victimFit.sections.rig[0]).toMatchObject({
      name: 'Small Polycarbon Engine Housing II'
    })
    expect(first.losses[0].victimFit.sections.cargo).toEqual([
      expect.objectContaining({ name: 'Small Secure Container', quantityDropped: 1 }),
      expect.objectContaining({ name: 'Caldari Navy Scourge Rocket', quantityDestroyed: 200 })
    ])

    const requestedNameIds = universeNameRequests.flat()
    expect(requestedNameIds).toEqual(expect.arrayContaining(capsuleerParticipantNameIds))
    expect(requestedNameIds).not.toContain(NPC_SHIP_TYPE_ID)

    const callsAfterFirst = fetchMock.mock.calls.length
    const second = await service.getCombatHistory({ characterId: CHARACTER_ID, limit: 5 })

    expect(second.cached).toBe(true)
    expect(second.kills).toEqual(first.kills)
    expect(second.losses).toEqual(first.losses)
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst)
  })

  it('keeps the first ten fast and loads one tab in deduplicated batches of fifty', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      ...fullKill,
      killmail_id: 500_000 - index
    }))
    const secondPage = [
      firstPage[firstPage.length - 1],
      ...Array.from({ length: 60 }, (_, index) => ({
        ...fullKill,
        killmail_id: 499_800 - index
      }))
    ]
    const requestedUrls: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      requestedUrls.push(url)

      if (url.endsWith(`/api/kills/characterID/${CHARACTER_ID}/page/1/`)) {
        return jsonResponse(firstPage)
      }
      if (url.endsWith(`/api/kills/characterID/${CHARACTER_ID}/page/2/`)) {
        return jsonResponse(secondPage)
      }
      if (url.endsWith(`/api/losses/characterID/${CHARACTER_ID}/page/1/`)) {
        return jsonResponse([])
      }
      if (url.endsWith('/universe/types/33468/')) {
        return jsonResponse({ type_id: 33_468, name: 'Astero', group_id: 25 })
      }
      if (url.endsWith('/universe/names/')) {
        expect(init?.method).toBe('POST')
        const ids = JSON.parse(String(init?.body)) as number[]
        return jsonResponse(ids.flatMap((id) => {
          const match = universeNames.get(id)
          return match ? [{ id, ...match }] : []
        }))
      }

      return jsonResponse({ error: `unexpected request: ${url}` }, 500)
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: {
        baseUrl: 'https://zkill.test',
        fetch: fetchMock,
        maxAttempts: 1,
        requestIntervalMs: 0
      }
    })

    const initial = await service.getCombatHistory({ characterId: CHARACTER_ID, limit: 10 })
    expect(initial.kills).toHaveLength(10)
    expect(initial.losses).toEqual([])
    expect(initial.pageInfo).toEqual({
      kill: { offset: 0, limit: 10, nextOffset: 10, hasMore: true },
      loss: { offset: 0, limit: 10, nextOffset: 0, hasMore: false }
    })

    const next = await service.getCombatHistory({
      characterId: CHARACTER_ID,
      kind: 'kill',
      offset: 10,
      limit: 50
    })
    expect(next.kills).toHaveLength(50)
    expect(next.losses).toEqual([])
    expect(next.pageInfo).toEqual({
      kill: { offset: 10, limit: 50, nextOffset: 60, hasMore: true }
    })

    const crossing = await service.getCombatHistory({
      characterId: CHARACTER_ID,
      kind: 'kill',
      offset: 190,
      limit: 50
    })
    expect(crossing.kills).toHaveLength(50)
    expect(new Set(crossing.kills.map(({ killmailId }) => killmailId)).size).toBe(50)
    expect(crossing.pageInfo.kill).toEqual({
      offset: 190,
      limit: 50,
      nextOffset: 240,
      hasMore: true
    })

    const final = await service.getCombatHistory({
      characterId: CHARACTER_ID,
      kind: 'kill',
      offset: 240,
      limit: 50
    })
    expect(final.kills).toHaveLength(20)
    expect(final.pageInfo.kill).toEqual({
      offset: 240,
      limit: 50,
      nextOffset: 260,
      hasMore: false
    })
    expect(requestedUrls.filter((url) => url.includes('/page/2/'))).toEqual([
      `https://zkill.test/api/kills/characterID/${CHARACTER_ID}/page/2/`
    ])
  })

  it('keeps available history and reports partial zKill/ESI failures', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)

      if (url.includes(`/api/kills/characterID/${CHARACTER_ID}/`)) {
        return jsonResponse({ error: 'kills unavailable' }, 503)
      }
      if (url.includes(`/api/losses/characterID/${CHARACTER_ID}/`)) {
        return jsonResponse([compactLoss])
      }
      if (url.includes(`/killmails/${compactLoss.killmail_id}/${KILLMAIL_HASH}/`)) {
        return jsonResponse({ error: 'killmail unavailable' }, 404)
      }

      return jsonResponse({ error: `unexpected request: ${url}` }, 500)
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkill.test', fetch: fetchMock, maxAttempts: 1 }
    })

    const result = await service.getCombatHistory({ characterId: CHARACTER_ID })

    expect(result.cached).toBe(false)
    expect(result.kills).toEqual([])
    expect(result.losses).toEqual([])
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('zKill kills'),
        expect.stringContaining(`Killmail ${compactLoss.killmail_id}`),
        expect.stringContaining('Incomplete killmails skipped: 1')
      ])
    )
  })

  it('builds lightweight recent target evidence from unique kill victims only', async () => {
    const requestedUrls: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      requestedUrls.push(url)

      if (url.endsWith(`/api/kills/characterID/${CHARACTER_ID}/page/1/`)) {
        return jsonResponse([fullKill, fullKill])
      }
      if (url.endsWith('/universe/types/33468/')) {
        expect(init?.method).toBe('GET')
        return jsonResponse({ type_id: 33_468, name: 'Astero', group_id: 25 })
      }

      return jsonResponse({ error: `unexpected request: ${url}` }, 500)
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkill.test', fetch: fetchMock, maxAttempts: 1 }
    })

    const result = await service.getRecentTargetProfile({
      characterId: CHARACTER_ID,
      limit: 10
    })

    expect(result).toMatchObject({
      characterId: CHARACTER_ID,
      requestedSampleSize: 1,
      sampleSize: 1,
      complete: true,
      warnings: []
    })
    expect(result.profile.entries.find(({ category }) => category === 'scanner')).toMatchObject({
      kills: 1,
      share: 1
    })
    expect(requestedUrls.some((url) => url.includes('/api/losses/'))).toBe(false)
  })

  it('keeps a victim in the recent denominator when ESI type metadata fails', async () => {
    const unknownTypeId = 999_999
    const unknownKill = {
      ...fullKill,
      victim: { ...fullKill.victim, ship_type_id: unknownTypeId }
    }
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith(`/api/kills/characterID/${CHARACTER_ID}/page/1/`)) {
        return jsonResponse([unknownKill])
      }
      if (url.endsWith(`/universe/types/${unknownTypeId}/`)) {
        return jsonResponse({ error: 'metadata unavailable' }, 503)
      }
      if (url.endsWith('/universe/names/')) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual([unknownTypeId])
        return jsonResponse([
          { id: unknownTypeId, name: 'Future Utility Hull', category: 'inventory_type' }
        ])
      }
      return jsonResponse({ error: `unexpected request: ${url}` }, 500)
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkill.test', fetch: fetchMock, maxAttempts: 1 }
    })

    const result = await service.getRecentTargetProfile({ characterId: CHARACTER_ID })

    expect(result).toMatchObject({
      requestedSampleSize: 1,
      sampleSize: 1,
      complete: false,
      profile: { totalKills: 1, categorizedKills: 0 }
    })
    expect(result.profile.entries.find(({ category }) => category === 'other')?.kills).toBe(1)
    expect(result.warnings.join(' ')).toContain('victim hull groups unavailable')
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid character ID %s before network calls',
    async (characterId) => {
      const fetchMock = vi.fn<typeof fetch>()
      service = new IntelService(':memory:', {
        esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
        zkill: { baseUrl: 'https://zkill.test', fetch: fetchMock, maxAttempts: 1 }
      })

      await expect(service.getCombatHistory({ characterId })).rejects.toThrow(
        'Invalid pilot ID'
      )
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )
})
