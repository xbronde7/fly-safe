import { describe, expect, it } from 'vitest'
import {
  ROUTE_NOT_LIVE_LIMITATION,
  assessRouteSystemRisk,
  estimateRouteHauling,
  riskLevelForScore,
  summarizeRoute,
  validateRouteIntelRequest,
  validateRouteSystemIds,
  validateRouteWaypointRequest,
  type RouteSystemIntel
} from '../src/shared/route-intel'

describe('route request validation', () => {
  it('normalizes names, defaults and a complete hauling request', () => {
    expect(validateRouteIntelRequest({
      origin: '  Jita ',
      destination: 30_002_187,
      hauling: {
        marketDeltaIsk: 15_000_000,
        cargoM3: 2_500,
        fees: { rate: 0.04, basisIsk: 120_000_000 }
      }
    })).toEqual({
      origin: { kind: 'name', value: 'Jita' },
      destination: { kind: 'id', value: 30_002_187 },
      mode: 'shortest',
      forceRefresh: false,
      includeRecentPublicKillmails: true,
      hauling: {
        marketDeltaIsk: 15_000_000,
        cargoM3: 2_500,
        fees: { rate: 0.04, basisIsk: 120_000_000 },
        haulingCostIsk: undefined
      }
    })
  })

  it('rejects missing endpoints, unsupported modes and incomplete percentage fees', () => {
    expect(() => validateRouteIntelRequest({ origin: ' ', destination: 'Amarr' }))
      .toThrow('Origin system')
    expect(() => validateRouteIntelRequest({
      origin: 'Jita',
      destination: 'Amarr',
      mode: 'fastest' as 'shortest'
    })).toThrow('shortest, secure, or insecure')
    expect(() => validateRouteIntelRequest({
      origin: 'Jita',
      destination: 'Amarr',
      hauling: { marketDeltaIsk: 1, cargoM3: 1, fees: { rate: 0.03 } }
    })).toThrow('requires an ISK basis')
  })

  it('requires a non-empty path with the requested boundaries', () => {
    expect(validateRouteSystemIds([1, 2, 3], 1, 3)).toEqual([1, 2, 3])
    expect(() => validateRouteSystemIds([], 1, 3)).toThrow('empty path')
    expect(() => validateRouteSystemIds([1, 2, 4], 1, 3)).toThrow('different endpoints')
    expect(() => validateRouteSystemIds([1, 2, 2, 3], 1, 3)).toThrow('duplicate systems')
    expect(() => validateRouteSystemIds(
      Array.from({ length: 257 }, (_, index) => index + 1),
      1,
      257
    )).toThrow('more than 256')
  })

  it('validates and normalizes ordered EVE waypoint writes', () => {
    expect(validateRouteWaypointRequest({ destinationIds: [2, 2, 3] }))
      .toEqual({ destinationIds: [2, 3] })
    expect(() => validateRouteWaypointRequest({ destinationIds: [] }))
      .toThrow('at least one')
    expect(() => validateRouteWaypointRequest({ destinationIds: [0] }))
      .toThrow('invalid ID')
    expect(() => validateRouteWaypointRequest({
      destinationIds: [2],
      token: 'must-not-cross-ipc'
    } as never)).toThrow('unknown fields')
  })
})

describe('route risk assessment', () => {
  it('keeps a quiet high-sec system low with high evidence confidence', () => {
    const risk = assessRouteSystemRisk({
      securityStatus: 0.9,
      isWormhole: false,
      shipKills: 0,
      podKills: 0,
      jumps: 1_500,
      recentPublicKillmails: 0,
      recentKillmailWindowHours: 24
    })

    expect(risk).toMatchObject({
      level: 'low',
      confidence: 'high',
      campPattern: 'none',
      campIndicators: []
    })
    expect(risk.score).toBeLessThan(25)
    expect(risk.limitations).toContain(ROUTE_NOT_LIVE_LIMITATION)
  })

  it('finds a strong historical camp-compatible pattern without a live claim', () => {
    const risk = assessRouteSystemRisk({
      securityStatus: -0.4,
      isWormhole: false,
      shipKills: 12,
      podKills: 6,
      jumps: 80,
      recentPublicKillmails: 25,
      recentKillmailWindowHours: 24
    })

    expect(risk.score).toBe(100)
    expect(risk.level).toBe('critical')
    expect(risk.confidence).toBe('high')
    expect(risk.campPattern).toBe('strong')
    expect(risk.campIndicators.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'ship-and-pod-losses',
      'pod-kill-cluster',
      'loss-density',
      'public-killmail-cluster'
    ]))
    expect(risk.campIndicators.every(({ temporal }) => temporal === 'historical')).toBe(true)
  })

  it('marks fully missing evidence unknown and handles wormhole security explicitly', () => {
    expect(assessRouteSystemRisk({
      securityStatus: null,
      isWormhole: false,
      shipKills: null,
      podKills: null,
      jumps: null,
      recentPublicKillmails: null,
      recentKillmailWindowHours: null
    })).toMatchObject({ score: 0, level: 'unknown', confidence: 'low', campPattern: 'unknown' })

    const wormhole = assessRouteSystemRisk({
      securityStatus: -1,
      isWormhole: true,
      shipKills: null,
      podKills: null,
      jumps: null,
      recentPublicKillmails: 2,
      recentKillmailWindowHours: 24
    })
    expect(wormhole.factors).toContainEqual(expect.objectContaining({
      code: 'security-status',
      points: 30
    }))
  })

  it('maps risk boundaries consistently', () => {
    expect(riskLevelForScore(0)).toBe('low')
    expect(riskLevelForScore(25)).toBe('guarded')
    expect(riskLevelForScore(50)).toBe('high')
    expect(riskLevelForScore(75)).toBe('critical')
  })
})

describe('route summary and hauling', () => {
  it('calculates fees, net profit, per-volume and per-jump values', () => {
    const estimate = estimateRouteHauling({
      marketDeltaIsk: 20_000_000,
      cargoM3: 1_000,
      fees: { rate: 0.05, basisIsk: 100_000_000, fixedIsk: 1_000_000 },
      haulingCostIsk: 2_000_000
    }, 10)

    expect(estimate).toMatchObject({
      grossMarketDeltaIsk: 20_000_000,
      percentageFeesIsk: 5_000_000,
      fixedFeesIsk: 1_000_000,
      haulingCostIsk: 2_000_000,
      totalCostsIsk: 8_000_000,
      netProfitIsk: 12_000_000,
      breakEvenMarketDeltaIsk: 8_000_000,
      netProfitPerM3: 12_000,
      netProfitPerJump: 1_200_000,
      profitable: true
    })
  })

  it('summarizes route risk and evidence coverage', () => {
    const systems = [
      makeRouteSystem(0, 1, 10, 'high'),
      makeRouteSystem(1, 2, 80, 'high'),
      makeRouteSystem(2, 3, 30, 'low')
    ]
    systems[1].risk.campPattern = 'strong'

    expect(summarizeRoute(systems)).toEqual({
      systems: 3,
      jumps: 2,
      averageRiskScore: 40,
      maximumRiskScore: 80,
      highestRiskSystemId: 2,
      highRiskSystems: 1,
      campPatternSystems: 1,
      incompleteSystems: 1,
      recentIntelSystemsChecked: 0,
      freshKillmailSystems: 0,
      hotKillmailSystems: 0,
      confidence: 'medium'
    })
  })
})

function makeRouteSystem(
  index: number,
  systemId: number,
  score: number,
  confidence: 'high' | 'low'
): RouteSystemIntel {
  return {
    index,
    systemId,
    name: `System ${systemId}`,
    securityStatus: 0.5,
    isWormhole: false,
    activity: {
      shipKills: 0,
      podKills: 0,
      jumps: 1,
      recentPublicKillmails: null,
      recentKillmailWindowHours: null,
      recentPublicKillmailsLastHour: null,
      latestPublicKillmailAt: null,
      latestPublicKillmailAgeMinutes: null,
      killmailFreshness: 'unknown',
      recentIntelChecked: false,
      aggregateRetrievedAt: '2026-08-25T00:00:00.000Z',
      killsSourceAt: null,
      jumpsSourceAt: null,
      recentIntelSourceAt: null,
      aggregateCached: null,
      recentIntelCached: null,
      access: 'public',
      temporal: 'historical'
    },
    risk: {
      score,
      level: riskLevelForScore(score),
      confidence,
      factors: [],
      campPattern: 'none',
      campIndicators: [],
      limitations: [ROUTE_NOT_LIVE_LIMITATION]
    },
    warnings: []
  }
}
