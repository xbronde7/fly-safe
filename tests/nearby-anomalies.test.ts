import { describe, expect, it } from 'vitest'
import { parseProbeClipboard } from '../src/shared/clipboard-intel'
import {
  anomalyObservationFreshness,
  rankNearbyAnomalySystems,
  summarizeProbeScan,
  validateNearbyAnomalyRequest,
  validateProbeScanRecordRequest,
  type NearbyAnomalySystem
} from '../src/shared/nearby-anomalies'

describe('nearby anomaly shared model', () => {
  it('summarizes visible anomaly rows without counting signatures', () => {
    const parsed = parseProbeClipboard(
      'AAA-001\tCosmic Anomaly\tCombat Site\tForsaken Hub\t100%\t2 AU\n' +
      'BBB-002\tCosmic Anomaly\tCombat Site\tForsaken Hub\t100%\t4 AU\n' +
      'CCC-003\tCosmic Anomaly\tOre Site\tSmall Asteroid Cluster\t100%\t8 AU\n' +
      'DDD-004\tCosmic Signature\tWormhole\tUnstable Wormhole\t42%\t10 AU'
    )
    const result = summarizeProbeScan(
      30_000_142,
      'Jita',
      parsed.rows,
      parsed.rejected,
      '2026-08-26T12:00:00Z'
    )

    expect(result).toMatchObject({
      solarSystemId: 30_000_142,
      anomalyCount: 3,
      signatureCount: 1,
      rowCount: 4,
      observedAt: '2026-08-26T12:00:00.000Z',
      sites: [
        { name: 'Forsaken Hub', count: 2 },
        { name: 'Small Asteroid Cluster', count: 1 }
      ]
    })
  })

  it('validates strict IPC boundaries and the two-jump cap', () => {
    expect(validateNearbyAnomalyRequest({ originSystemId: 30_000_142 })).toEqual({
      originSystemId: 30_000_142,
      maxJumps: 2
    })
    expect(() => validateNearbyAnomalyRequest({ originSystemId: 30_000_142, maxJumps: 3 }))
      .toThrow('Radius')
    expect(() => validateProbeScanRecordRequest({
      solarSystemId: 30_000_142,
      systemName: 'Jita',
      rawProbeText: 'AAA-001\tCosmic Anomaly\tCombat Site\tHub\t100%',
      observedAt: '2026-08-26T12:00:00Z',
      injected: true
    })).toThrow('unknown fields')
  })

  it('labels freshness and ranks current first, then observed anomaly-rich systems', () => {
    expect(anomalyObservationFreshness(null)).toBe('unseen')
    expect(anomalyObservationFreshness(20)).toBe('fresh')
    expect(anomalyObservationFreshness(21)).toBe('recent')
    expect(anomalyObservationFreshness(61)).toBe('stale')

    const systems = [
      system(2, 'Two jumps', 2, 12, 'recent'),
      system(1, 'One jump', 1, 12, 'fresh'),
      system(3, 'Unknown', 1, null, 'unseen'),
      system(4, 'Current', 0, 0, 'fresh')
    ]
    expect(rankNearbyAnomalySystems(systems).map(({ systemName }) => systemName)).toEqual([
      'Current',
      'One jump',
      'Two jumps',
      'Unknown'
    ])
  })
})

function system(
  solarSystemId: number,
  systemName: string,
  jumps: number,
  anomalyCount: number | null,
  freshness: NearbyAnomalySystem['freshness']
): NearbyAnomalySystem {
  return {
    solarSystemId,
    systemName,
    securityStatus: 0.1,
    jumps,
    pathSystemIds: Array.from({ length: jumps + 1 }, (_, index) => index + 1),
    anomalyCount,
    signatureCount: anomalyCount === null ? null : 0,
    sites: [],
    observedAt: anomalyCount === null ? null : '2026-08-26T12:00:00.000Z',
    ageMinutes: anomalyCount === null ? null : 1,
    freshness
  }
}
