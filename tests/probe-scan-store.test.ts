import { afterEach, describe, expect, it } from 'vitest'
import { ProbeScanStore } from '../src/main/probe-scan-store'
import type { ProbeSystemObservation } from '../src/shared/nearby-anomalies'

describe('ProbeScanStore', () => {
  let store: ProbeScanStore | null = null

  afterEach(() => {
    store?.close()
    store = null
  })

  it('keeps one latest complete visible snapshot per system', () => {
    store = new ProbeScanStore(':memory:')
    store.record(observation(1, 'Alpha', 10, '2026-08-26T11:00:00Z'))
    store.record(observation(2, 'Beta', 4, '2026-08-26T11:10:00Z'))
    store.record(observation(1, 'Alpha', 2, '2026-08-26T11:20:00Z'))

    expect(store.get(1)).toMatchObject({ anomalyCount: 2, sites: [{ name: 'Hub', count: 2 }] })
    expect(store.get(2)).toMatchObject({ anomalyCount: 4 })
    expect(store.listRecent().map(({ solarSystemId }) => solarSystemId)).toEqual([1, 2])
  })

  it('does not let a late older write replace a newer scan', () => {
    store = new ProbeScanStore(':memory:')
    store.record(observation(1, 'Alpha', 7, '2026-08-26T12:00:00Z'))
    store.record(observation(1, 'Alpha', 99, '2026-08-26T11:00:00Z'))
    expect(store.get(1)?.anomalyCount).toBe(7)
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
    signatureCount: 0,
    rowCount: anomalyCount,
    rejectedCount: 0,
    sites: anomalyCount > 0 ? [{ name: 'Hub', count: anomalyCount }] : [],
    observedAt: new Date(observedAt).toISOString()
  }
}
