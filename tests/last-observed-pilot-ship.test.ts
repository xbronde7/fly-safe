import { describe, expect, it } from 'vitest'
import {
  selectLastObservedPilotShip,
  type LastObservedPilotShip
} from '../src/shared/last-observed-pilot-ship'
import type { CombatHistoryEntry, PilotCombatHistory, ShipFit } from '../src/shared/types'

function fit(shipTypeId: number, shipName?: string): ShipFit {
  return {
    shipTypeId,
    shipName,
    sections: {
      high: [],
      medium: [],
      low: [],
      rig: [],
      subsystem: [],
      drone: [],
      fighter: [],
      cargo: [],
      other: []
    },
    totalDestroyed: 0,
    totalDropped: 0
  }
}

function entry(
  overrides: Partial<CombatHistoryEntry> & Pick<CombatHistoryEntry, 'kind' | 'killmailId' | 'time'>
): CombatHistoryEntry {
  return {
    solarSystemId: 30_000_142,
    solarSystemName: 'Jita',
    victimCharacterId: 90_001,
    victimName: 'Victim',
    victimCorporationName: 'Victim Corp',
    victimFit: fit(587, 'Rifter'),
    attackerShipTypeId: 11_978,
    attackerShipName: 'Astero',
    pilotFinalBlow: false,
    attackers: [],
    attackerCount: 0,
    attackersCapped: false,
    nonCapsuleerAttackerCount: 0,
    totalValue: 12_345_678,
    solo: false,
    ...overrides,
    kind: overrides.kind,
    killmailId: overrides.killmailId,
    time: overrides.time
  }
}

function history(
  kills: CombatHistoryEntry[] = [],
  losses: CombatHistoryEntry[] = []
): PilotCombatHistory {
  return {
    characterId: 90_002,
    fetchedAt: '2026-08-25T10:00:00.000Z',
    cached: false,
    kills,
    losses,
    pageInfo: {},
    warnings: []
  }
}

describe('selectLastObservedPilotShip', () => {
  it('returns the watched attacker hull from the newest valid killmail', () => {
    const result = selectLastObservedPilotShip(
      history([
        entry({
          kind: 'kill',
          killmailId: 101,
          time: '2026-08-20T12:00:00.000Z',
          attackerShipTypeId: 11_978,
          attackerShipName: 'Astero'
        }),
        entry({
          kind: 'kill',
          killmailId: 102,
          time: '2026-08-22T12:00:00.000Z',
          solarSystemId: 31_000_001,
          solarSystemName: 'J100001',
          attackerShipTypeId: 17_918,
          attackerShipName: 'Rattlesnake',
          totalValue: 450_000_000
        })
      ])
    )

    expect(result).toEqual<LastObservedPilotShip>({
      typeId: 17_918,
      shipName: 'Rattlesnake',
      time: '2026-08-22T12:00:00.000Z',
      solarSystemId: 31_000_001,
      solarSystemName: 'J100001',
      killmailId: 102,
      role: 'attacker',
      totalValue: 450_000_000
    })
  })

  it('selects a newer loss and reports the pilot as the victim', () => {
    const result = selectLastObservedPilotShip(
      history(
        [
          entry({
            kind: 'kill',
            killmailId: 201,
            time: '2026-08-20T12:00:00.000Z',
            attackerShipTypeId: 11_978,
            attackerShipName: 'Astero'
          })
        ],
        [
          entry({
            kind: 'loss',
            killmailId: 202,
            time: '2026-08-24T01:02:03.000Z',
            solarSystemId: 30_002_365,
            solarSystemName: 'Amamake',
            victimFit: fit(11_987, 'Crow'),
            totalValue: 98_765_432
          })
        ]
      )
    )

    expect(result).toMatchObject({
      typeId: 11_987,
      shipName: 'Crow',
      time: '2026-08-24T01:02:03.000Z',
      solarSystemId: 30_002_365,
      solarSystemName: 'Amamake',
      killmailId: 202,
      role: 'victim',
      totalValue: 98_765_432
    })
  })

  it('skips a newer kill without the pilot attacker hull and falls back to a loss', () => {
    const result = selectLastObservedPilotShip(
      history(
        [
          entry({
            kind: 'kill',
            killmailId: 301,
            time: '2026-08-25T12:00:00.000Z',
            attackerShipTypeId: null,
            attackerShipName: null
          })
        ],
        [
          entry({
            kind: 'loss',
            killmailId: 300,
            time: '2026-08-23T12:00:00.000Z',
            victimFit: fit(587, 'Rifter')
          })
        ]
      )
    )

    expect(result).toMatchObject({ typeId: 587, shipName: 'Rifter', role: 'victim' })
  })

  it('ignores malformed dates and uses killmail id as a deterministic timestamp tie-breaker', () => {
    const result = selectLastObservedPilotShip(
      history([
        entry({
          kind: 'kill',
          killmailId: 999,
          time: 'not-a-date',
          attackerShipTypeId: 99_999,
          attackerShipName: 'Invalid'
        }),
        entry({
          kind: 'kill',
          killmailId: 400,
          time: '2026-08-24T12:00:00.000Z',
          attackerShipTypeId: 587,
          attackerShipName: 'Rifter'
        }),
        entry({
          kind: 'kill',
          killmailId: 401,
          time: '2026-08-24T12:00:00.000Z',
          attackerShipTypeId: 11_978,
          attackerShipName: 'Astero'
        })
      ])
    )

    expect(result).toMatchObject({ killmailId: 401, typeId: 11_978, shipName: 'Astero' })
  })

  it('returns null when the history has no valid observed hull', () => {
    expect(selectLastObservedPilotShip(undefined)).toBeNull()
    expect(selectLastObservedPilotShip(null)).toBeNull()
    expect(selectLastObservedPilotShip(history())).toBeNull()
    expect(
      selectLastObservedPilotShip(
        history([
          entry({
            kind: 'kill',
            killmailId: 501,
            time: '2026-08-25T12:00:00.000Z',
            attackerShipTypeId: null,
            attackerShipName: null
          })
        ])
      )
    ).toBeNull()
  })

  it('does not reorder or otherwise mutate the supplied history', () => {
    const source = history(
      [
        entry({ kind: 'kill', killmailId: 602, time: '2026-08-24T12:00:00.000Z' }),
        entry({ kind: 'kill', killmailId: 601, time: '2026-08-23T12:00:00.000Z' })
      ],
      [entry({ kind: 'loss', killmailId: 600, time: '2026-08-22T12:00:00.000Z' })]
    )
    const before = structuredClone(source)

    selectLastObservedPilotShip(source)

    expect(source).toEqual(before)
  })
})
