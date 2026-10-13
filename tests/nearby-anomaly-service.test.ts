import { afterEach, describe, expect, it, vi } from 'vitest'
import { NearbyAnomalyService } from '../src/main/nearby-anomaly-service'
import { ProbeScanStore } from '../src/main/probe-scan-store'
import type { ProbeSystemObservation } from '../src/shared/nearby-anomalies'

describe('NearbyAnomalyService', () => {
  let store: ProbeScanStore | null = null

  afterEach(() => {
    store?.close()
    store = null
  })

  it('keeps saved reports within two shortest jumps and returns exact waypoint paths', async () => {
    store = new ProbeScanStore(':memory:')
    store.record(observation(10, 'Origin', 0, '2026-08-26T11:58:00Z'))
    store.record(observation(20, 'Rich One', 10, '2026-08-26T11:57:00Z'))
    store.record(observation(30, 'Rich Two', 14, '2026-08-26T11:30:00Z'))
    store.record(observation(40, 'Far Away', 99, '2026-08-26T11:59:00Z'))
    const routes = new Map([
      [20, [10, 20]],
      [30, [10, 20, 30]],
      [40, [10, 11, 12, 40]]
    ])
    const getRouteSystems = vi.fn(async (_originId: number, destinationId: number) => ({
      systemIds: routes.get(destinationId)!,
      cached: false
    }))
    const service = new NearbyAnomalyService(store, {
      getRouteSystems,
      getSystemMetadata: async (id) => ({ id, name: `System ${id}`, securityStatus: -0.2 })
    }, { now: () => new Date('2026-08-26T12:00:00Z') })

    const result = await service.getNearby({ originSystemId: 10, maxJumps: 2 })

    expect(result.systems.map(({ solarSystemId }) => solarSystemId)).toEqual([10, 30, 20])
    expect(result.systems[1]).toMatchObject({
      anomalyCount: 14,
      jumps: 2,
      pathSystemIds: [10, 20, 30],
      freshness: 'recent'
    })
    expect(result.systems.some(({ solarSystemId }) => solarSystemId === 40)).toBe(false)
    expect(result.coverage).toEqual({ checkedReports: 4, nearbyReports: 2 })
  })

  it('distinguishes an unscanned current system and reports partial route failures', async () => {
    store = new ProbeScanStore(':memory:')
    store.record(observation(20, 'Saved', 3, '2026-08-26T11:00:00Z'))
    const service = new NearbyAnomalyService(store, {
      getRouteSystems: async () => { throw new Error('route offline') },
      getSystemMetadata: async (id) => ({ id, name: 'Current', securityStatus: 0.5 })
    }, { now: () => new Date('2026-08-26T12:00:00Z') })

    const result = await service.getNearby({ originSystemId: 10 })
    expect(result.systems).toEqual([
      expect.objectContaining({ solarSystemId: 10, anomalyCount: null, freshness: 'unseen' })
    ])
    expect(result.warnings.join(' ')).toContain('Could not check distance')
  })
})

function observation(
  solarSystemId: number,
  systemName: string,
  anomalyCount: number,
  observedAt: string
): ProbeSystemObservation {
  return {
    solarSystemId,
    systemName,
    anomalyCount,
    signatureCount: 1,
    rowCount: anomalyCount + 1,
    rejectedCount: 0,
    sites: anomalyCount > 0 ? [{ name: 'Forsaken Hub', count: anomalyCount }] : [],
    observedAt: new Date(observedAt).toISOString()
  }
}
