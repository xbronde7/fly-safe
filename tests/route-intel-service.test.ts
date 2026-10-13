import { describe, expect, it, vi } from 'vitest'
import {
  RouteIntelService,
  ZkillRouteSystemIntelLookup,
  type RouteIntelDependencies
} from '../src/main/route-intel-service'

const JITA = 30_000_142
const PERIMETER = 30_000_144
const AMARR = 30_002_187
const NOW = new Date('2026-08-25T12:00:00Z')

function makeDependencies(): RouteIntelDependencies {
  const names = new Map([
    ['jita', { id: JITA, name: 'Jita' }],
    ['amarr', { id: AMARR, name: 'Amarr' }]
  ])
  const metadata = new Map([
    [JITA, { id: JITA, name: 'Jita', securityStatus: 0.95 }],
    [PERIMETER, { id: PERIMETER, name: 'Perimeter', securityStatus: 1 }],
    [AMARR, { id: AMARR, name: 'Amarr', securityStatus: 1 }]
  ])

  return {
    resolveSolarSystemId: vi.fn(async (name) => names.get(name.toLowerCase()) ?? null),
    getRouteSystems: vi.fn(async () => ({
      systemIds: [JITA, PERIMETER, AMARR],
      fetchedAt: '2026-08-25T11:59:58Z',
      cached: false
    })),
    getSystemMetadata: vi.fn(async (systemId) => {
      const result = metadata.get(systemId)
      if (!result) throw new Error('not found')
      return result
    }),
    getSystemKills: vi.fn(async () => ({
      rows: [{ solarSystemId: PERIMETER, shipKills: 8, podKills: 3 }],
      fetchedAt: '2026-08-25T11:55:00Z',
      cached: true
    })),
    getSystemJumps: vi.fn(async () => ({
      rows: [{ solarSystemId: PERIMETER, jumps: 100 }],
      fetchedAt: '2026-08-25T11:55:05Z',
      cached: true
    })),
    systemIntel: {
      lookupSystemIntel: vi.fn(async (systemId) => ({
        count: systemId === PERIMETER ? 12 : 0,
        windowHours: 24,
        fetchedAt: '2026-08-25T11:50:00Z',
        cached: false,
        capped: false
      }))
    }
  }
}

describe('RouteIntelService', () => {
  it('joins route, metadata, aggregates, public history and hauling math', async () => {
    const dependencies = makeDependencies()
    const service = new RouteIntelService(dependencies, { now: () => NOW })

    const result = await service.analyze({
      origin: ' Jita ',
      destination: 'Amarr',
      mode: 'secure',
      forceRefresh: true,
      hauling: {
        marketDeltaIsk: 10_000_000,
        cargoM3: 500,
        fees: { fixedIsk: 1_000_000 },
        haulingCostIsk: 2_000_000
      }
    })

    expect(dependencies.resolveSolarSystemId).toHaveBeenCalledWith('Jita', true)
    expect(dependencies.getRouteSystems).toHaveBeenCalledWith(JITA, AMARR, 'secure', true)
    expect(result.request).toEqual({
      origin: { id: JITA, name: 'Jita', input: ' Jita ' },
      destination: { id: AMARR, name: 'Amarr', input: 'Amarr' },
      mode: 'secure'
    })
    expect(result.systems).toHaveLength(3)
    expect(result.systems[0]).toMatchObject({
      name: 'Jita',
      activity: { shipKills: 0, podKills: 0, jumps: 0 },
      risk: { campPattern: 'none', confidence: 'high' }
    })
    expect(result.systems[1]).toMatchObject({
      name: 'Perimeter',
      activity: {
        shipKills: 8,
        podKills: 3,
        jumps: 100,
        recentPublicKillmails: 12,
        aggregateRetrievedAt: NOW.toISOString(),
        killsSourceAt: '2026-08-25T11:55:00.000Z',
        jumpsSourceAt: '2026-08-25T11:55:05.000Z'
      },
      risk: { campPattern: 'strong', confidence: 'high' }
    })
    expect(result.summary).toMatchObject({ systems: 3, jumps: 2, campPatternSystems: 1 })
    expect(result.hauling).toMatchObject({
      totalCostsIsk: 3_000_000,
      netProfitIsk: 7_000_000,
      netProfitPerM3: 14_000,
      netProfitPerJump: 3_500_000
    })
    expect(result.evaluatedAt).toBe(NOW.toISOString())
    expect(result.sourceTimestamps).toEqual({
      route: '2026-08-25T11:59:58.000Z',
      systemKills: '2026-08-25T11:55:00.000Z',
      systemJumps: '2026-08-25T11:55:05.000Z'
    })
    expect(result.provenance.liveCampDetection).toBe(false)
    expect(result.warnings.join(' ')).toContain('do not confirm a live camp')
  })

  it('accepts numeric endpoints without resolving names and can skip killmail lookup', async () => {
    const dependencies = makeDependencies()
    const service = new RouteIntelService(dependencies, { now: () => NOW })

    const result = await service.analyze({
      origin: JITA,
      destination: AMARR,
      includeRecentPublicKillmails: false
    })

    expect(dependencies.resolveSolarSystemId).not.toHaveBeenCalled()
    expect(dependencies.systemIntel?.lookupSystemIntel).not.toHaveBeenCalled()
    expect(result.systems.every(({ activity }) =>
      activity.recentPublicKillmails === null && activity.recentIntelSourceAt === null
    )).toBe(true)
  })

  it('degrades safely when activity, metadata and optional intel fail', async () => {
    const dependencies = makeDependencies()
    dependencies.getSystemKills = vi.fn(async () => { throw new Error('kills offline') })
    dependencies.getSystemJumps = vi.fn(async () => { throw new Error('jumps offline') })
    dependencies.getSystemMetadata = vi.fn(async (systemId) => {
      if (systemId === PERIMETER) throw new Error('metadata offline')
      return { id: systemId, name: `Known ${systemId}`, securityStatus: 0.8 }
    })
    dependencies.systemIntel = {
      lookupSystemIntel: vi.fn(async (systemId) => {
        if (systemId === PERIMETER) throw new Error('zkill offline')
        return null
      })
    }
    const service = new RouteIntelService(dependencies, { now: () => NOW })

    const result = await service.analyze({ origin: JITA, destination: AMARR })
    const middle = result.systems[1]

    expect(middle).toMatchObject({
      systemId: PERIMETER,
      name: null,
      securityStatus: null,
      activity: { shipKills: null, podKills: null, jumps: null },
      risk: { level: 'unknown', confidence: 'low', campPattern: 'unknown' }
    })
    expect(result.confidence).toBe('low')
    expect(result.warnings.join('\n')).toContain('kills offline')
    expect(result.warnings.join('\n')).toContain('jumps offline')
    expect(result.warnings.join('\n')).toContain('metadata offline')
    expect(result.warnings.join('\n')).toContain('zkill offline')
  })

  it('rejects unresolved, equal and boundary-mismatched routes', async () => {
    const dependencies = makeDependencies()
    const service = new RouteIntelService(dependencies)

    await expect(service.analyze({ origin: 'Unknown', destination: 'Amarr' }))
      .rejects.toThrow('not found: Unknown')
    await expect(service.analyze({ origin: JITA, destination: JITA }))
      .rejects.toThrow('are the same')

    dependencies.getRouteSystems = vi.fn(async () => [JITA, PERIMETER])
    await expect(service.analyze({ origin: JITA, destination: AMARR }))
      .rejects.toThrow('different endpoints')
  })

  it('ignores malformed activity rows but records warnings', async () => {
    const dependencies = makeDependencies()
    dependencies.getSystemKills = vi.fn(async () => ({
      rows: [
        { solarSystemId: PERIMETER, shipKills: -1, podKills: 0 },
        { solarSystemId: AMARR, shipKills: 2, podKills: 0 }
      ]
    }))
    dependencies.getSystemJumps = vi.fn(async () => ({
      rows: [{ solarSystemId: PERIMETER, jumps: Number.NaN }]
    }))
    const service = new RouteIntelService(dependencies, { now: () => NOW })

    const result = await service.analyze({ origin: JITA, destination: AMARR })

    expect(result.systems[1].activity).toMatchObject({ shipKills: 0, podKills: 0, jumps: 0 })
    expect(result.warnings.join('\n')).toContain('loss rows skipped: 1')
    expect(result.warnings.join('\n')).toContain('jump rows skipped: 1')
  })

  it('builds freshness alerts and reuses the bounded recent-intel cache', async () => {
    const dependencies = makeDependencies()
    const lookup = vi.fn(async (systemId: number) => ({
      count: systemId === PERIMETER ? 4 : 0,
      windowHours: 24,
      lastHourCount: systemId === PERIMETER ? 2 : 0,
      latestAt: systemId === PERIMETER ? '2026-08-25T11:55:00Z' : null,
      fetchedAt: NOW.toISOString(),
      cached: false
    }))
    dependencies.systemIntel = { lookupSystemIntel: lookup }
    const service = new RouteIntelService(dependencies, { now: () => NOW })

    const first = await service.analyze({ origin: JITA, destination: AMARR })
    const second = await service.analyze({ origin: JITA, destination: AMARR, forceRefresh: true })

    expect(first.corridorAlerts).toEqual([
      expect.objectContaining({
        systemId: PERIMETER,
        ageMinutes: 5,
        lastHourCount: 2,
        freshness: 'hot',
        severity: 'critical'
      })
    ])
    expect(first.summary).toMatchObject({
      recentIntelSystemsChecked: 1,
      freshKillmailSystems: 1,
      hotKillmailSystems: 1
    })
    expect(first.systems[1].risk.factors).toContainEqual(expect.objectContaining({
      code: 'fresh-public-killmail'
    }))
    expect(second.systems[1].activity.recentIntelCached).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('negative-caches recent-intel failures before retrying upstream', async () => {
    const dependencies = makeDependencies()
    const lookup = vi.fn(async () => {
      throw new Error('proxy offline')
    })
    dependencies.systemIntel = { lookupSystemIntel: lookup }
    let nowMs = NOW.getTime()
    const service = new RouteIntelService(dependencies, {
      now: () => new Date(nowMs),
      recentIntelErrorCacheTtlMs: 60_000
    })

    const first = await service.analyze({
      origin: JITA,
      destination: AMARR,
      forceRefresh: true
    })
    const second = await service.analyze({
      origin: JITA,
      destination: AMARR,
      forceRefresh: true
    })

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(first.warnings.join('\n')).toContain('proxy offline')
    expect(second.warnings.join('\n')).toContain('proxy offline')
    expect(second.systems[1].activity.recentIntelChecked).toBe(true)

    nowMs += 60_001
    await service.analyze({
      origin: JITA,
      destination: AMARR,
      forceRefresh: true
    })
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('retains and retries a malformed recent-killmail timestamp through the error cache', async () => {
    const dependencies = makeDependencies()
    const lookup = vi.fn(async () => ({
      count: 4,
      windowHours: 24,
      lastHourCount: null,
      latestAt: 'not-a-timestamp',
      fetchedAt: NOW.toISOString(),
      cached: false
    }))
    dependencies.systemIntel = { lookupSystemIntel: lookup }
    let nowMs = NOW.getTime()
    const service = new RouteIntelService(dependencies, {
      now: () => new Date(nowMs),
      recentIntelErrorCacheTtlMs: 60_000
    })

    const first = await service.analyze({
      origin: JITA,
      destination: AMARR,
      forceRefresh: true
    })
    const second = await service.analyze({
      origin: JITA,
      destination: AMARR,
      forceRefresh: true
    })

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(first.warnings.join('\n')).toContain('invalid latest-fight time')
    expect(second.warnings.join('\n')).toContain('invalid latest-fight time')
    expect(second.systems[1].activity).toMatchObject({
      recentPublicKillmails: 4,
      latestPublicKillmailAt: null,
      recentIntelCached: true
    })

    nowMs += 60_001
    await service.analyze({
      origin: JITA,
      destination: AMARR,
      forceRefresh: true
    })
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('parses zKill system timestamps without hydrating individual killmails', async () => {
    const source = {
      getSystemHistory: vi.fn(async () => ({
        solarSystemId: PERIMETER,
        cached: false,
        killmails: [
          { solar_system_id: PERIMETER, killmail_time: '2026-08-25T11:50:00Z' },
          { solar_system_id: PERIMETER, killmail_time: '2026-08-25T10:00:00Z' },
          {
            killmail_id: 999,
            solar_system_id: AMARR,
            killmail_time: '2026-08-25T11:59:00Z',
            zkb: { hash: 'f'.repeat(40) }
          }
        ]
      }))
    }
    const lookup = new ZkillRouteSystemIntelLookup(source, { now: () => NOW })

    await expect(lookup.lookupSystemIntel(PERIMETER, true)).resolves.toMatchObject({
      count: 2,
      lastHourCount: 1,
      latestAt: '2026-08-25T11:50:00.000Z',
      cached: false,
      warnings: ['zKill: skipped rows without exact time/system: 1']
    })
    expect(source.getSystemHistory).toHaveBeenCalledWith(PERIMETER, true)
  })

  it('hydrates only the newest compact zKill reference and marks an hourly lower bound', async () => {
    const source = {
      getSystemHistory: vi.fn(async () => ({
        solarSystemId: PERIMETER,
        cached: false,
        killmails: [
          { killmail_id: 101, zkb: { hash: 'a'.repeat(40) } },
          { killmail_id: 100, zkb: { hash: 'b'.repeat(40) } }
        ]
      })),
      getPublicKillmail: vi.fn(async () => ({
        killmail: {
          killmail_id: 101,
          solar_system_id: PERIMETER,
          killmail_time: '2026-08-25T11:50:00Z'
        },
        cached: true
      }))
    }
    const lookup = new ZkillRouteSystemIntelLookup(source, { now: () => NOW })

    await expect(lookup.lookupSystemIntel(PERIMETER, true)).resolves.toMatchObject({
      count: 2,
      lastHourCount: 1,
      lastHourCountLowerBound: true,
      latestAt: '2026-08-25T11:50:00.000Z',
      cached: false
    })
    expect(source.getPublicKillmail).toHaveBeenCalledTimes(1)
    expect(source.getPublicKillmail).toHaveBeenCalledWith(101, 'a'.repeat(40), false)
  })

  it('keeps the 24-hour compact count when newest-killmail hydration is unavailable', async () => {
    const source = {
      getSystemHistory: vi.fn(async () => ({
        solarSystemId: PERIMETER,
        cached: true,
        killmails: [
          { killmail_id: 101, zkb: { hash: 'a'.repeat(40) } },
          { killmail_id: 100, zkb: { hash: 'b'.repeat(40) } }
        ]
      })),
      getPublicKillmail: vi.fn(async () => { throw new Error('offline') })
    }
    const lookup = new ZkillRouteSystemIntelLookup(source, { now: () => NOW })

    await expect(lookup.lookupSystemIntel(PERIMETER)).resolves.toMatchObject({
      count: 2,
      lastHourCount: null,
      latestAt: null,
      cached: false,
      warnings: ['ESI: latest killmail time is temporarily unavailable']
    })
  })

  it('explains that ESI cannot build a stargate route from wormhole space', async () => {
    const dependencies = makeDependencies()
    const service = new RouteIntelService(dependencies)

    await expect(service.analyze({ origin: 31_001_310, destination: AMARR }))
      .rejects.toThrow('cannot build a stargate route')
    expect(dependencies.getRouteSystems).not.toHaveBeenCalled()
  })
})
