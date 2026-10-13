import { describe, expect, it } from 'vitest'
import {
  classifyDscanShipRoles,
  classifyEveClipboard,
  collectDscanTypeIds,
  detectClipboardKind,
  enrichDscanRows,
  parseDscanClipboard,
  parseEveDistance,
  parseProbeClipboard,
  summarizeDscanRoles,
} from '../src/shared/clipboard-intel'

describe('EVE clipboard detection', () => {
  it('distinguishes Local, D-scan, Probe Scanner, and unrelated text', () => {
    expect(detectClipboardKind('Alice Example\nBob-Prime\nCarol.3')).toBe('local')
    expect(detectClipboardKind('My Drake\tDrake\t1,234 km')).toBe('dscan')
    expect(
      detectClipboardKind('ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t82.4%\t3.1 AU'),
    ).toBe('probe')
    expect(detectClipboardKind('This is an ordinary sentence.')).toBe('unknown')
    expect(classifyEveClipboard('')).toEqual({ kind: 'unknown', confidence: 'high', rowCount: 0 })
  })

  it('gives Probe Scanner precedence over D-scan-like distance data', () => {
    const result = classifyEveClipboard(
      'ID\tGroup\tType\tName\tSignal Strength\tDistance\n' +
        'XYZ-987\tCosmic Anomaly\tCombat Site\tForsaken Hub\t100%\t12 AU',
    )

    expect(result).toEqual({ kind: 'probe', confidence: 'high', rowCount: 1 })
  })
})

describe('parseDscanClipboard', () => {
  it('parses headers, item IDs, unavailable ranges, and rejects malformed rows', () => {
    const result = parseDscanClipboard(
      'Name\tType\tDistance\n' +
        'My Drake\tDrake\t1,234 km\n' +
        '987654321\tFriendly Logi\tGuardian\t12,5 км\n' +
        'Far Fortizar\tFortizar\t—\n' +
        'broken row\n' +
        'No Range\tRaven\tunknown',
    )

    expect(result.rejected).toBe(2)
    expect(result.rows).toHaveLength(3)
    expect(result.rows[0]).toMatchObject({
      typeId: null,
      name: 'My Drake',
      type: 'Drake',
      distanceText: '1,234 km',
      lineNumber: 2,
      distance: { value: 1234, unit: 'km', meters: 1_234_000 },
    })
    expect(result.rows[1]).toMatchObject({
      typeId: null,
      name: 'Friendly Logi',
      type: 'Guardian',
      distance: { value: 12.5, unit: 'km', meters: 12_500 },
    })
    expect(result.rows[2]).toMatchObject({ distance: null, distanceText: '—' })
  })

  it('parses EVE type-ID rows while preserving the custom ship name', () => {
    const result = parseDscanClipboard(
      '17715\t*custom ship name\t-\n' +
        '17715\tSecond custom name\t12 km',
    )

    expect(result).toMatchObject({ rejected: 0 })
    expect(result.rows[0]).toMatchObject({
      typeId: 17_715,
      name: '*custom ship name',
      type: '*custom ship name',
      distance: null,
      distanceText: '-',
      lineNumber: 1,
    })
    expect(result.rows[1]).toMatchObject({
      typeId: 17_715,
      name: 'Second custom name',
      distance: { value: 12, unit: 'km' },
    })
  })

  it('enriches type-ID rows without mutating or replacing their custom names', () => {
    const rows = parseDscanClipboard(
      '17715\t*custom ship name\t-\n' +
        '17715\tSecond custom name\t12 km\n' +
        'My Drake\tDrake\t1,234 km',
    ).rows

    expect(collectDscanTypeIds(rows)).toEqual([17_715])

    const enriched = enrichDscanRows(rows, [{ typeId: 17_715, name: ' Gila ' }])
    expect(enriched.map(({ typeId, name, type }) => ({ typeId, name, type }))).toEqual([
      { typeId: 17_715, name: '*custom ship name', type: 'Gila' },
      { typeId: 17_715, name: 'Second custom name', type: 'Gila' },
      { typeId: null, name: 'My Drake', type: 'Drake' },
    ])
    expect(rows[0]).toMatchObject({ name: '*custom ship name', type: '*custom ship name' })
    expect(enriched[0]).not.toBe(rows[0])
  })

  it('renders native type 17715 as Gila while preserving its Unicode custom name', () => {
    const rows = parseDscanClipboard('17715\t*不怕抓的刷怪毒蜥\t-').rows
    const enriched = enrichDscanRows(rows, [{ typeId: 17_715, name: 'Gila' }])

    expect(enriched).toEqual([
      expect.objectContaining({
        typeId: 17_715,
        type: 'Gila',
        name: '*不怕抓的刷怪毒蜥',
        distance: null,
        distanceText: '-'
      })
    ])
  })

  it('parses localized distance units and mixed numeric separators', () => {
    expect(parseEveDistance('1\u202f234,5 км')).toMatchObject({ value: 1234.5, unit: 'km' })
    expect(parseEveDistance('1,234.5 km')).toMatchObject({ value: 1234.5, unit: 'km' })
    expect(parseEveDistance('2,5 а. е.')).toMatchObject({ value: 2.5, unit: 'au' })
    expect(parseEveDistance('3.125 AU')).toMatchObject({ value: 3.125, unit: 'au' })
    expect(parseEveDistance('unknown')).toBeNull()
  })
})

describe('parseProbeClipboard', () => {
  it('parses signatures, anomalies, unresolved fields, and localized rows', () => {
    const result = parseProbeClipboard(
      'ID\tGroup\tType\tName\tSignal Strength\tDistance\n' +
        'ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t82.4%\t3.1 AU\n' +
        'DEF-456\tCosmic Anomaly\tCombat Site\tForsaken Hub\t100%\t12 AU\n' +
        'GHI-789\tКосмическая сигнатура\t\t\t7,5%\t2,5 а.е.\n' +
        'not a probe row',
    )

    expect(result.rejected).toBe(1)
    expect(result.rows).toHaveLength(3)
    expect(result.rows[0]).toMatchObject({
      id: 'ABC-123',
      kind: 'signature',
      type: 'Wormhole',
      name: 'Unstable Wormhole',
      signal: 82.4,
      distance: { value: 3.1, unit: 'au' },
    })
    expect(result.rows[1]).toMatchObject({ id: 'DEF-456', kind: 'anomaly', signal: 100 })
    expect(result.rows[2]).toMatchObject({
      id: 'GHI-789',
      kind: 'signature',
      type: null,
      name: null,
      signal: 7.5,
      distance: { value: 2.5, unit: 'au' },
    })
  })

  it('rejects plausible tabular noise without a known probe group', () => {
    const result = parseProbeClipboard('ABC-123\tInventory\tModule\tThing\t50%\t2 km')
    expect(result).toEqual({ rows: [], rejected: 1 })
  })
})

describe('D-scan role summary', () => {
  it('uses exact type names and never a custom object name', () => {
    expect(classifyDscanShipRoles('Guardian')).toEqual(['logistics'])
    expect(classifyDscanShipRoles('Guardian Navy Issue')).toEqual([])

    const rows = parseDscanClipboard(
      'Guardian\tRaven\t20 km\n' +
        'Actually combat fit\tGuardian\t30 km\n' +
        'Bubble\tSabre\t40 km\n' +
        'Rock\tVeldspar\t50 km',
    ).rows
    const summary = summarizeDscanRoles(rows)

    expect(summary.counts.logistics).toBe(1)
    expect(summary.counts.tackle).toBe(1)
    expect(summary.matched).toBe(2)
    expect(summary.unclassified).toBe(2)
    expect(summary.ships).toEqual({ logistics: ['Guardian'], tackle: ['Sabre'] })
  })
})
