import { describe, expect, it } from 'vitest'
import {
  analyzeDscanIntelligence,
  compareDscanScans,
  isCombatScannerProbeType,
  summarizeDscanComposition,
  type DscanIntelligenceInput
} from '../src/shared/dscan-intelligence'

describe('D-scan intelligence composition', () => {
  it('groups duplicates by normalized type and ignores malformed rows safely', () => {
    const rows: DscanIntelligenceInput[] = [
      { type: '  Guardian  ' },
      { type: 'GUARDIAN' },
      { type: 'Sabre', typeId: 22_456 },
      { type: null },
      { type: '   ', typeId: -1 },
      null,
      undefined
    ]

    const result = summarizeDscanComposition(rows)

    expect(result).toMatchObject({
      totalCount: 3,
      ignoredCount: 4,
      roleCounts: { logistics: 2, tackle: 1 },
      combatScannerProbeCount: 0
    })
    expect(result.hulls).toEqual([
      {
        key: 'name:guardian',
        typeId: null,
        typeName: 'Guardian',
        normalizedType: 'guardian',
        count: 2,
        roles: ['logistics'],
        combatScannerProbe: false
      },
      {
        key: 'id:22456',
        typeId: 22_456,
        typeName: 'Sabre',
        normalizedType: 'sabre',
        count: 1,
        roles: ['tackle'],
        combatScannerProbe: false
      }
    ])
  })

  it('can count a valid type ID even when the display type is missing', () => {
    expect(summarizeDscanComposition([{ typeId: 11_978 }])).toMatchObject({
      totalCount: 1,
      ignoredCount: 0,
      hulls: [{ key: 'id:11978', typeId: 11_978, typeName: null, count: 1 }]
    })
  })
})

describe('D-scan multiset comparison', () => {
  it('prefers type IDs, falls back to normalized types, and preserves duplicate deltas', () => {
    const previous: DscanIntelligenceInput[] = [
      { type: 'Raven', typeId: 100 },
      { type: 'Raven', typeId: 100 },
      { type: 'Guardian' },
      { type: 'guardian' },
      { type: 'Sabre' },
      { type: 'Old label', typeId: 200 }
    ]
    const current: DscanIntelligenceInput[] = [
      { type: 'Raven Navy Issue', typeId: 100 },
      { type: ' GUARDIAN ' },
      { type: 'Sabre' },
      { type: 'sabre' },
      { type: 'SABRE' },
      { type: 'New label', typeId: 200 }
    ]

    const result = compareDscanScans(previous, current)

    expect(result).toMatchObject({
      hasBaseline: true,
      addedCount: 2,
      removedCount: 2,
      netCount: 0
    })
    expect(result.added).toEqual([
      expect.objectContaining({ key: 'name:sabre', previousCount: 1, currentCount: 3, delta: 2 })
    ])
    expect(result.removed).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'id:100', previousCount: 2, currentCount: 1, delta: -1 }),
      expect.objectContaining({ key: 'name:guardian', previousCount: 2, currentCount: 1, delta: -1 })
    ]))
    expect(result.removed).toHaveLength(2)
    expect(result.added.some((entry) => entry.key === 'id:200')).toBe(false)
    expect(result.removed.some((entry) => entry.key === 'id:200')).toBe(false)
  })

  it('does not report the first scan as a set of additions', () => {
    expect(compareDscanScans(null, [{ type: 'Sabre' }, { type: 'Sabre' }])).toEqual({
      hasBaseline: false,
      addedCount: 0,
      removedCount: 0,
      netCount: 0,
      added: [],
      removed: []
    })
  })
})

describe('D-scan tactical alerts', () => {
  it('reports every dangerous role with current and newly added counts', () => {
    const previous = [
      { type: 'Naglfar' },
      { type: 'Combat Scanner Probe I' }
    ]
    const current = [
      { type: 'Naglfar' },
      { type: 'Naglfar' },
      { type: 'Sabre' },
      { type: 'Guardian' },
      { type: 'Rapier' },
      { type: 'Blackbird' },
      { type: 'Stork' },
      { type: 'Drake' },
      { type: 'Combat Scanner Probe I' },
      { type: 'Combat Scanner Probe I' },
      { type: 'Sisters Combat Scanner Probe' },
      { type: 'Satori-Horigu Combat Scanner Probe' },
      { type: 'Core Scanner Probe I' }
    ]

    const result = analyzeDscanIntelligence(current, previous)
    const roleAlerts = result.alerts.filter((alert) => alert.kind === 'role')
    const probeAlert = result.alerts.find((alert) => alert.kind === 'combat-scanner-probes')

    expect(roleAlerts.map((alert) => alert.role)).toEqual([
      'capital', 'tackle', 'logistics', 'recon', 'ewar', 'command'
    ])
    expect(roleAlerts[0]).toMatchObject({ count: 2, addedCount: 1 })
    expect(roleAlerts.slice(1)).toEqual(roleAlerts.slice(1).map((alert) => (
      expect.objectContaining({ count: 1, addedCount: 1 })
    )))
    expect(probeAlert).toMatchObject({ count: 4, addedCount: 3 })
    expect(result.composition.combatScannerProbeCount).toBe(4)
  })

  it('matches only exact normalized official combat-probe type names', () => {
    expect(isCombatScannerProbeType(' Combat Scanner Probe I ')).toBe(true)
    expect(isCombatScannerProbeType('sisters combat scanner probe')).toBe(true)
    expect(isCombatScannerProbeType('Satori-Horigu Combat Scanner Probe')).toBe(true)
    expect(isCombatScannerProbeType('Core Scanner Probe I')).toBe(false)
    expect(isCombatScannerProbeType('Combat Scanner Probe I Blueprint')).toBe(false)

    const result = analyzeDscanIntelligence([
      { type: 'Core Scanner Probe I', name: 'Combat Scanner Probe I' } as DscanIntelligenceInput
    ])
    expect(result.alerts).toEqual([])
  })
})
