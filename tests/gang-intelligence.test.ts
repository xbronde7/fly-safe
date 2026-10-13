import { describe, expect, it } from 'vitest'
import { buildGangIntelligence } from '../src/shared/gang-intelligence'
import type { CombatHistoryAttacker, CombatHistoryEntry } from '../src/shared/types'
import type { ShipFit } from '../src/shared/killmail-fit'

const SUBJECT_ID = 1

describe('buildGangIntelligence', () => {
  it('finds frequent co-pilots, exact recurring groups, roles, hours and systems', () => {
    const subject = attacker(SUBJECT_ID, 'Subject', 'Hurricane', 10)
    const logistics = attacker(2, 'Logi', 'Scimitar', 11, { finalBlow: true })
    const tackle = attacker(3, 'Point', 'Stiletto', 12)
    const damage = attacker(4, 'Damage', 'Vagabond', 13)

    const history = [
      entry(101, 'kill', '2026-08-20T12:05:00Z', 30_000_142, 'Jita', [subject, logistics, tackle]),
      entry(102, 'kill', '2026-08-21T12:45:00Z', 30_000_142, 'Jita', [subject, logistics, tackle]),
      entry(103, 'kill', '2026-08-21T21:00:00Z', 30_002_365, 'Amamake', [
        subject,
        logistics,
        damage
      ], true),
      // Attackers on a subject loss are enemies and must not inflate companions.
      entry(104, 'loss', '2026-08-22T02:00:00Z', 30_002_365, 'Amamake', [logistics])
    ]

    const result = buildGangIntelligence(history, SUBJECT_ID)

    expect(result.sample).toEqual({
      source: 'public-killmail-history',
      killmailsReceived: 4,
      qualifyingKills: 3,
      firstSeen: '2026-08-20T12:05:00Z',
      lastSeen: '2026-08-21T21:00:00Z',
      attackersMayBeIncomplete: true
    })
    expect(result.frequentCoPilots.map((pilot) => [pilot.characterId, pilot.sharedKillmails]))
      .toEqual([[2, 3], [3, 2], [4, 1]])
    expect(result.frequentCoPilots[0]).toMatchObject({
      characterId: 2,
      name: 'Logi',
      corporationId: 77,
      corporationName: 'Wolf Corp',
      sharedKillmails: 3,
      shareOfSample: 1,
      finalBlowCount: 3,
      roles: [{ role: 'logistics', count: 3 }],
      activeUtcHours: [{ hour: 12, count: 2 }, { hour: 21, count: 1 }]
    })
    expect(result.frequentCoPilots[1].roles).toEqual([{ role: 'tackle', count: 2 }])
    expect(result.frequentCoPilots[2].roles).toEqual([{ role: 'damage', count: 1 }])
    expect(result.stableGroups).toEqual([
      expect.objectContaining({
        memberCharacterIds: [2, 3],
        occurrences: 2,
        shareOfSample: 0.6667,
        activeUtcHours: [{ hour: 12, count: 2 }]
      })
    ])
    expect(result.activeUtcHours).toEqual([{ hour: 12, count: 2 }, { hour: 21, count: 1 }])
    expect(result.systems).toEqual([
      {
        solarSystemId: 30_000_142,
        solarSystemName: 'Jita',
        count: 2,
        lastSeen: '2026-08-21T12:45:00Z'
      },
      {
        solarSystemId: 30_002_365,
        solarSystemName: 'Amamake',
        count: 1,
        lastSeen: '2026-08-21T21:00:00Z'
      }
    ])
  })

  it('deduplicates killmails, caps output and validates public API inputs', () => {
    const shared = entry(201, 'kill', '2026-08-20T01:00:00Z', 30_000_001, null, [
      attacker(SUBJECT_ID, 'Subject', 'Hurricane', 10),
      attacker(2, 'Alpha', 'Scimitar', 11),
      attacker(3, 'Beta', 'Stiletto', 12)
    ])
    const result = buildGangIntelligence([shared, shared], SUBJECT_ID, {
      coPilotLimit: 1,
      stableGroupLimit: 1
    })
    expect(result.sample).toMatchObject({ killmailsReceived: 1, qualifyingKills: 1 })
    expect(result.frequentCoPilots).toHaveLength(1)
    expect(result.frequentCoPilotsCapped).toBe(true)

    expect(() => buildGangIntelligence([], 0)).toThrow('Pilot ID')
    expect(() => buildGangIntelligence([], 1, { minGroupOccurrences: 1 })).toThrow(
      'minimum group repeats'
    )
  })
})

function attacker(
  characterId: number,
  name: string,
  shipName: string,
  shipTypeId: number,
  overrides: Partial<CombatHistoryAttacker> = {}
): CombatHistoryAttacker {
  return {
    characterId,
    name,
    corporationId: 77,
    corporationName: 'Wolf Corp',
    allianceId: 88,
    allianceName: 'Wolf Alliance',
    shipTypeId,
    shipName,
    weaponTypeId: null,
    weaponName: null,
    damageDone: characterId * 100,
    finalBlow: false,
    ...overrides
  }
}

function entry(
  killmailId: number,
  kind: CombatHistoryEntry['kind'],
  time: string,
  solarSystemId: number,
  solarSystemName: string | null,
  attackers: CombatHistoryAttacker[],
  attackersCapped = false
): CombatHistoryEntry {
  return {
    kind,
    killmailId,
    time,
    solarSystemId,
    solarSystemName,
    victimCharacterId: 999,
    victimName: 'Victim',
    victimCorporationName: 'Other Corp',
    victimFit: fit(100, 'Astero'),
    attackerShipTypeId: 10,
    attackerShipName: 'Hurricane',
    pilotFinalBlow: false,
    attackers,
    attackerCount: attackers.length,
    attackersCapped,
    nonCapsuleerAttackerCount: 0,
    totalValue: 1_000,
    solo: false
  }
}

function fit(shipTypeId: number, shipName: string): ShipFit {
  return {
    shipTypeId,
    shipName,
    sections: {
      high: [], medium: [], low: [], rig: [], subsystem: [],
      drone: [], fighter: [], cargo: [], other: []
    },
    totalDestroyed: 0,
    totalDropped: 0
  }
}
