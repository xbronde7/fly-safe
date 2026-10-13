import { afterEach, describe, expect, it, vi } from 'vitest'
import { IntelService } from '../src/main/intel-service'
import type { ScanProgress } from '../src/shared/types'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('IntelService', () => {
  let service: IntelService | null = null

  afterEach(() => {
    service?.close()
    service = null
  })

  it('enriches a roster, scores threats and reuses its cache', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)

      if (url.endsWith('/universe/ids/')) {
        const names = JSON.parse(String(init?.body)) as string[]
        return jsonResponse({
          characters: names.map((name, index) => ({ id: 9_001 + index, name }))
        })
      }

      if (url.endsWith('/characters/affiliation/')) {
        return jsonResponse([
          { character_id: 9_001, corporation_id: 98_001, alliance_id: 99_001 },
          { character_id: 9_002, corporation_id: 98_001, alliance_id: 99_001 }
        ])
      }

      if (url.endsWith('/universe/names/')) {
        return jsonResponse([
          { id: 98_001, name: 'Hunters Inc.', category: 'corporation' },
          { id: 99_001, name: 'Danger Alliance', category: 'alliance' }
        ])
      }

      if (url.includes('zkillboard.test')) {
        const isVeteran = url.includes('/9001/')
        return jsonResponse({
          dangerRatio: isVeteran ? 91 : 20,
          gangRatio: isVeteran ? 18 : 95,
          soloRatio: isVeteran ? 82 : 5,
          shipsDestroyed: isVeteran ? 2_400 : 3,
          shipsLost: isVeteran ? 120 : 8,
          soloKills: isVeteran ? 650 : 0,
          iskDestroyed: isVeteran ? 900_000_000_000 : 20_000_000,
          months: { '202608': { shipsDestroyed: 1 } },
          groups: isVeteran
            ? {
                1022: { groupID: 1022, shipsDestroyed: 24 },
                832: { groupID: 832, shipsDestroyed: 12 }
              }
            : {}
        })
      }

      return jsonResponse({ error: 'unexpected request' }, 500)
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkillboard.test', fetch: fetchMock, maxAttempts: 1 }
    })
    const progress: ScanProgress[] = []

    const first = await service.analyze(
      { rawText: 'Veteran Pilot\nNew Pilot' },
      (update) => progress.push(update)
    )

    expect(first.summary).toMatchObject({
      total: 2,
      resolved: 2,
      dangerous: 1,
      unknown: 0,
      cached: 0
    })
    expect(first.pilots[0]).toMatchObject({
      name: 'Veteran Pilot',
      corporationName: 'Hunters Inc.',
      allianceName: 'Danger Alliance',
      threatLevel: 'critical'
    })
    expect(first.pilots[1].threatLevel).toBe('low')
    expect(first.pilots[0].stats?.targetProfile.top.slice(0, 2)).toMatchObject([
      { category: 'scanner', kills: 24 },
      { category: 'logistics', kills: 12 }
    ])
    expect(first.summary.corporationGroups).toEqual([
      { id: 98_001, name: 'Hunters Inc.', count: 2 }
    ])
    expect(progress.at(-1)).toMatchObject({ completed: 2, total: 2 })
    expect(progress.flatMap((update) => update.readyPilot ?? []).map((pilot) => pilot.name))
      .toEqual(['Veteran Pilot', 'New Pilot'])

    const requestCount = fetchMock.mock.calls.length
    const second = await service.analyze({ rawText: 'Veteran Pilot\nNew Pilot' })
    expect(fetchMock).toHaveBeenCalledTimes(requestCount)
    expect(second.summary.cached).toBe(2)
  })

  it('reports each complete pilot before the slowest roster request finishes', async () => {
    const pendingStats = new Map<number, (response: Response) => void>()
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/universe/ids/')) {
        const names = JSON.parse(String(init?.body)) as string[]
        return jsonResponse({
          characters: names.map((name, index) => ({ id: 9_101 + index, name }))
        })
      }
      if (url.endsWith('/characters/affiliation/')) {
        return jsonResponse([
          { character_id: 9_101, corporation_id: 98_101 },
          { character_id: 9_102, corporation_id: 98_102 }
        ])
      }
      if (url.endsWith('/universe/names/')) {
        return jsonResponse([
          { id: 98_101, name: 'First Corp', category: 'corporation' },
          { id: 98_102, name: 'Second Corp', category: 'corporation' }
        ])
      }
      if (url.includes('zkillboard.test')) {
        const characterId = url.includes('/9101/') ? 9_101 : 9_102
        return new Promise<Response>((resolve) => pendingStats.set(characterId, resolve))
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: {
        baseUrl: 'https://zkillboard.test',
        fetch: fetchMock,
        maxAttempts: 1,
        requestIntervalMs: 0
      }
    })
    const progress: ScanProgress[] = []
    let finished = false
    const analysis = service.analyze(
      { rawText: 'First Pilot\nSecond Pilot' },
      (update) => progress.push(update)
    ).finally(() => {
      finished = true
    })

    await vi.waitFor(() => expect(pendingStats.size).toBe(2))
    pendingStats.get(9_102)?.(jsonResponse({
      dangerRatio: 80,
      shipsDestroyed: 200,
      shipsLost: 10
    }))
    await vi.waitFor(() => expect(progress.some((update) => (
      update.readyPilot?.id === 9_102
    ))).toBe(true))

    expect(finished).toBe(false)
    expect(progress.find((update) => update.readyPilot?.id === 9_102)?.readyPilot)
      .toMatchObject({
        name: 'Second Pilot',
        corporationName: 'Second Corp',
        stats: { shipsDestroyed: 200, shipsLost: 10 }
      })

    pendingStats.get(9_101)?.(jsonResponse({
      dangerRatio: 20,
      shipsDestroyed: 2,
      shipsLost: 4
    }))
    const result = await analysis

    expect(result.pilots).toHaveLength(2)
    expect(progress.flatMap((update) => update.readyPilot ?? []).map((pilot) => pilot.id))
      .toEqual([9_102, 9_101])
  })

  it('reports rejected and unresolved names without calling zKill', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/universe/ids/')) return jsonResponse({ characters: [] })
      throw new Error(`Unexpected request: ${url}`)
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkillboard.test', fetch: fetchMock, maxAttempts: 1 }
    })

    const result = await service.analyze({ rawText: 'Valid Pilot\nnot_name!' })

    expect(result.pilots).toEqual([])
    expect(result.unresolvedNames).toEqual(['Valid Pilot'])
    expect(result.summary).toMatchObject({ total: 1, resolved: 0, unknown: 1 })
    expect(result.warnings.join(' ')).toContain('Rows skipped')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns a useful warning when ESI is offline', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('network offline')
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkillboard.test', fetch: fetchMock, maxAttempts: 1 }
    })

    const result = await service.analyze({ rawText: 'Offline Pilot' })
    expect(result.summary).toMatchObject({ total: 1, resolved: 0, unknown: 1 })
    expect(result.warnings[0]).toContain('ESI')
    expect(result.warnings[0]).toContain('network offline')
  })

  it('loads one pilot directly by character ID for historical drilldown', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/universe/names/')) {
        const ids = JSON.parse(String(init?.body)) as number[]
        if (ids.includes(9_001)) {
          return jsonResponse([{ id: 9_001, name: 'Observed Pilot', category: 'character' }])
        }
        return jsonResponse([{ id: 98_001, name: 'Observed Corp', category: 'corporation' }])
      }
      if (url.endsWith('/universe/ids/')) {
        return jsonResponse({ characters: [{ id: 9_001, name: 'Observed Pilot' }] })
      }
      if (url.endsWith('/characters/affiliation/')) {
        return jsonResponse([{ character_id: 9_001, corporation_id: 98_001 }])
      }
      if (url.includes('zkillboard.test')) {
        return jsonResponse({
          shipsDestroyed: 42,
          shipsLost: 4,
          months: {},
          groups: {}
        })
      }
      return jsonResponse({ error: 'unexpected request' }, 500)
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkillboard.test', fetch: fetchMock, maxAttempts: 1 }
    })

    await expect(service.getPilotIntel({ characterId: 9_001 })).resolves.toMatchObject({
      id: 9_001,
      name: 'Observed Pilot',
      corporationName: 'Observed Corp',
      stats: { shipsDestroyed: 42, shipsLost: 4 }
    })
    await expect(service.getPilotIntel({ characterId: 0 })).rejects.toThrow('Invalid pilot ID')
  })

  it('keeps a killmail NPC drilldown usable when name search and zKill stats have no profile', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/universe/names/')) {
        const ids = JSON.parse(String(init?.body)) as number[]
        if (ids.includes(3_012_345)) {
          return jsonResponse([{ id: 3_012_345, name: 'Scylla Tyrannos', category: 'character' }])
        }
        return jsonResponse([])
      }
      if (url.endsWith('/characters/affiliation/')) {
        return jsonResponse({ error: 'NPC affiliation is unavailable' }, 404)
      }
      if (url.endsWith('/universe/ids/')) {
        return jsonResponse({ agents: [{ id: 3_012_345, name: 'Scylla Tyrannos' }] })
      }
      if (url.includes('zkillboard.test')) return jsonResponse({}, 404)
      return jsonResponse({ error: 'unexpected request' }, 500)
    })

    service = new IntelService(':memory:', {
      esi: { baseUrl: 'https://esi.test', fetch: fetchMock, maxAttempts: 1 },
      zkill: { baseUrl: 'https://zkillboard.test', fetch: fetchMock, maxAttempts: 1 }
    })

    await expect(service.getPilotIntel({ characterId: 3_012_345 })).resolves.toMatchObject({
      id: 3_012_345,
      name: 'Scylla Tyrannos',
      corporationId: null,
      stats: null,
      threatLevel: 'unknown'
    })
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/universe/ids/'))).toBe(false)
  })
})
