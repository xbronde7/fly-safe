import { describe, expect, it } from 'vitest'
import { correlateDscanPilots } from '../src/shared/dscan-pilot-correlation'
import type { DscanHullComposition } from '../src/shared/dscan-intelligence'
import type {
  SystemObservedShip,
  SystemObservedShipOccurrence,
  SystemZkillHistory
} from '../src/shared/system-intel'

const SYSTEM_ID = 30_000_142
const CAPTURED_AT = '2026-08-25T12:00:00Z'

function hull(typeId: number | null, typeName: string, count = 1): DscanHullComposition {
  return {
    key: typeId === null ? `name:${typeName.toLowerCase()}` : `id:${typeId}`,
    typeId,
    typeName,
    normalizedType: typeName.toLowerCase(),
    count,
    roles: [],
    combatScannerProbe: false
  }
}

function occurrence(
  pilotCharacterId: number,
  time: string,
  overrides: Partial<SystemObservedShipOccurrence> = {}
): SystemObservedShipOccurrence {
  return {
    killmailId: pilotCharacterId,
    time,
    solarSystemId: SYSTEM_ID,
    role: 'attacker',
    pilotCharacterId,
    pilotName: `Pilot ${pilotCharacterId}`,
    finalBlow: false,
    victimCharacterId: 91_000,
    victimName: 'Target Pilot',
    victimShipTypeId: 587,
    victimShipName: 'Rifter',
    totalValue: 12_000_000,
    ...overrides
  }
}

function observedShip(overrides: Partial<SystemObservedShip> = {}): SystemObservedShip {
  return {
    typeId: 17_918,
    name: 'Rattlesnake',
    victimCount: 1,
    attackerCount: 2,
    lastSeen: '2026-08-25T11:55:00Z',
    pilots: [],
    pilotsCapped: false,
    occurrences: [occurrence(90_001, '2026-08-25T11:55:00Z')],
    occurrencesCapped: false,
    ...overrides
  }
}

function history(
  ships: SystemObservedShip[],
  overrides: Partial<SystemZkillHistory> = {}
): SystemZkillHistory {
  return {
    count: 2,
    latest: [],
    sourceCapped: false,
    latestCapped: false,
    capped: false,
    observedShips: ships,
    observedShipsCapped: false,
    observedPilots: [],
    observedPilotsCapped: false,
    source: 'zKillboard',
    access: 'public',
    temporal: 'historical',
    ...overrides
  }
}

describe('D-scan to exact killmail correlation', () => {
  it('matches an exact hull to the one unique attacker within 15 minutes', () => {
    const result = correlateDscanPilots(
      [hull(17_918, 'custom ship name')],
      history([observedShip()]),
      {
        capturedSystemId: SYSTEM_ID,
        historySystemId: SYSTEM_ID,
        capturedAt: CAPTURED_AT
      }
    )

    expect(result.status).toBe('ready')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ matchKind: 'type-id', dscanCount: 1 })
    expect(result.matches[0].candidates[0]).toMatchObject({
      characterId: 90_001,
      strength: 'strong',
      killmailId: 90_001,
      timeOffsetMs: -5 * 60 * 1_000,
      victimName: 'Target Pilot'
    })
  })

  it('keeps simultaneous attackers ambiguous and excludes destroyed victim hulls', () => {
    const ship = observedShip({
      occurrences: [
        occurrence(90_001, '2026-08-25T11:55:00Z'),
        occurrence(90_002, '2026-08-25T11:56:00Z'),
        occurrence(90_003, '2026-08-25T11:59:00Z', { role: 'victim' })
      ]
    })

    const result = correlateDscanPilots([hull(17_918, 'Rattlesnake')], history([ship]), {
      capturedSystemId: SYSTEM_ID,
      historySystemId: SYSTEM_ID,
      capturedAt: CAPTURED_AT
    })

    expect(result.matches[0].candidates.map(({ characterId, strength }) => ({
      characterId,
      strength
    }))).toEqual([
      { characterId: 90_002, strength: 'medium' },
      { characterId: 90_001, strength: 'medium' }
    ])
  })

  it('chooses the closest exact killmail per pilot and counts nearby events', () => {
    const ship = observedShip({
      occurrences: [
        occurrence(90_001, '2026-08-25T08:00:00Z', { killmailId: 1 }),
        occurrence(90_001, '2026-08-25T11:50:00Z', { killmailId: 2, finalBlow: true }),
        occurrence(90_001, '2026-08-25T11:58:00Z', { killmailId: 3 })
      ]
    })

    const candidate = correlateDscanPilots([hull(17_918, 'Rattlesnake')], history([ship]), {
      capturedSystemId: SYSTEM_ID,
      historySystemId: SYSTEM_ID,
      capturedAt: CAPTURED_AT
    }).matches[0].candidates[0]

    expect(candidate).toMatchObject({
      characterId: 90_001,
      killmailId: 3,
      timeDistanceMs: 2 * 60 * 1_000,
      matchingKillmailCount: 3
    })
  })

  it('uses normalized type names only when no type ID exists and caps confidence at weak', () => {
    const result = correlateDscanPilots([hull(null, '  RATTLESNAKE ')], history([observedShip()]), {
      capturedSystemId: SYSTEM_ID,
      historySystemId: SYSTEM_ID,
      capturedAt: CAPTURED_AT
    })

    expect(result.matches[0]).toMatchObject({ matchKind: 'type-name' })
    expect(result.matches[0].candidates[0].strength).toBe('weak')
  })

  it('ignores stale evidence and killmails more than five minutes after capture', () => {
    const ship = observedShip({
      occurrences: [
        occurrence(90_001, '2026-08-25T05:59:59Z'),
        occurrence(90_002, '2026-08-25T12:05:01Z')
      ]
    })
    const result = correlateDscanPilots([hull(17_918, 'Rattlesnake')], history([ship]), {
      capturedSystemId: SYSTEM_ID,
      historySystemId: SYSTEM_ID,
      capturedAt: CAPTURED_AT
    })

    expect(result.matches).toHaveLength(0)
    expect(result.unmatchedHullCount).toBe(1)
  })

  it('never reuses candidates after the character changes systems', () => {
    const result = correlateDscanPilots([hull(17_918, 'Rattlesnake')], history([observedShip()]), {
      capturedSystemId: SYSTEM_ID,
      historySystemId: SYSTEM_ID + 1,
      capturedAt: CAPTURED_AT
    })

    expect(result).toEqual({
      status: 'system-changed',
      matches: [],
      unmatchedHullCount: 0,
      incomplete: false
    })
  })

  it('propagates incomplete source and per-hull occurrence boundaries', () => {
    const ship = observedShip({ occurrencesCapped: true })
    const result = correlateDscanPilots(
      [hull(17_918, 'Rattlesnake'), hull(587, 'Rifter')],
      history([ship], { sourceCapped: true, capped: true }),
      {
        capturedSystemId: SYSTEM_ID,
        historySystemId: SYSTEM_ID,
        capturedAt: CAPTURED_AT
      }
    )

    expect(result).toMatchObject({ incomplete: true, unmatchedHullCount: 1 })
    expect(result.matches[0].candidatesCapped).toBe(true)
  })
})
