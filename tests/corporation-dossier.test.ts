import { describe, expect, it } from 'vitest'
import { buildCorporationDossier } from '../src/shared/corporation-dossier'
import type { CombatHistoryAttacker, CombatHistoryEntry } from '../src/shared/types'
import type { ShipFit } from '../src/shared/killmail-fit'

const CORP_ID = 77
const CORP_NAME = 'Wolf Corp'

describe('buildCorporationDossier', () => {
  it('builds an honest killmail-sample dossier with pilots, ships, times and systems', () => {
    const attack = entry({
      killmailId: 301,
      time: '2026-08-20T12:00:00Z',
      solarSystemId: 30_000_142,
      solarSystemName: 'Jita',
      victimCharacterId: 900,
      victimName: 'Target',
      victimCorporationName: 'Other Corp',
      victimShipTypeId: 100,
      victimShipName: 'Astero',
      attackers: [
        attacker(2, 'Logi', CORP_ID, CORP_NAME, 11, 'Scimitar'),
        attacker(3, 'Point', CORP_ID, CORP_NAME, 12, 'Stiletto', true),
        attacker(99, 'Other', 999, 'Other Corp', 13, 'Vagabond')
      ],
      totalValue: 100
    })
    const nameFallbackAttack = entry({
      killmailId: 302,
      time: '2026-08-20T21:00:00Z',
      solarSystemId: 30_000_142,
      solarSystemName: 'Jita',
      victimCharacterId: 901,
      victimName: 'Target Two',
      victimCorporationName: 'Other Corp',
      victimShipTypeId: 101,
      victimShipName: 'Venture',
      attackers: [attacker(4, 'Damage', null, CORP_NAME, 14, 'Vagabond', true)],
      totalValue: 300,
      attackersCapped: true
    })
    const loss = entry({
      killmailId: 303,
      kind: 'loss',
      time: '2026-08-21T12:30:00Z',
      solarSystemId: 30_002_365,
      solarSystemName: 'Amamake',
      victimCharacterId: 2,
      victimName: 'Logi',
      victimCorporationName: CORP_NAME,
      victimShipTypeId: 15,
      victimShipName: 'Crow',
      attackers: [attacker(98, 'Enemy', 998, 'Enemy Corp', 16, 'Hurricane', true)],
      totalValue: 200
    })

    const result = buildCorporationDossier(
      [attack, attack, nameFallbackAttack, loss],
      { corporationId: CORP_ID, corporationName: `  ${CORP_NAME}  ` }
    )

    expect(result).toMatchObject({
      corporationId: CORP_ID,
      corporationName: CORP_NAME,
      provenance: {
        source: 'public-killmail-sample',
        isRoster: false
      },
      sample: {
        killmailsReceived: 3,
        killmailsInvolvingCorporation: 3,
        firstSeen: '2026-08-20T12:00:00Z',
        lastSeen: '2026-08-21T12:30:00Z',
        attackersMayBeIncomplete: true,
        lossesMayBeIncomplete: false
      },
      activity: {
        attackKillmails: 2,
        lossKillmails: 1,
        finalBlows: 2,
        iskDestroyed: 400,
        iskDestroyedKillmails: 2,
        iskLost: 200,
        iskLostKillmails: 1
      }
    })
    expect(result.observedPilots.map((pilot) => pilot.characterId)).toEqual([2, 4, 3])
    expect(result.observedPilots[0]).toMatchObject({
      characterId: 2,
      name: 'Logi',
      attackKillmails: 1,
      losses: 1,
      roles: [
        { role: 'logistics', count: 1 },
        { role: 'tackle', count: 1 }
      ]
    })
    expect(result.observedShips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        typeId: 11,
        name: 'Scimitar',
        attackerObservations: 1,
        roles: ['logistics']
      }),
      expect.objectContaining({
        typeId: 15,
        name: 'Crow',
        lossObservations: 1,
        roles: ['tackle']
      })
    ]))
    expect(result.activeUtcHours).toEqual([
      { hour: 12, count: 2 },
      { hour: 21, count: 1 }
    ])
    expect(result.systems[0]).toMatchObject({
      solarSystemId: 30_000_142,
      count: 2
    })
  })

  it('marks losses incomplete when only a corporation ID is available', () => {
    const loss = entry({
      killmailId: 401,
      kind: 'loss',
      time: '2026-08-20T01:00:00Z',
      solarSystemId: 30_000_001,
      solarSystemName: null,
      victimCharacterId: 2,
      victimName: 'Member',
      victimCorporationName: CORP_NAME,
      victimShipTypeId: 20,
      victimShipName: 'Crow',
      attackers: [],
      totalValue: 500
    })
    const result = buildCorporationDossier([loss], { corporationId: CORP_ID })
    expect(result.sample.lossesMayBeIncomplete).toBe(true)
    expect(result.activity.lossKillmails).toBe(0)
    expect(result.provenance.statement).toContain('not a complete corporation roster')
  })

  it('validates selectors and bounded presentation options', () => {
    expect(() => buildCorporationDossier([], {})).toThrow('corporation ID or name')
    expect(() => buildCorporationDossier([], { corporationId: 0 })).toThrow('Corporation ID')
    expect(() => buildCorporationDossier([], { corporationName: '   ' })).toThrow(
      'corporation name'
    )
    expect(() => buildCorporationDossier([], { corporationId: 1 }, { pilotLimit: 101 }))
      .toThrow('pilot limit')
  })
})

function attacker(
  characterId: number,
  name: string,
  corporationId: number | null,
  corporationName: string,
  shipTypeId: number,
  shipName: string,
  finalBlow = false
): CombatHistoryAttacker {
  return {
    characterId,
    name,
    corporationId,
    corporationName,
    allianceId: 88,
    allianceName: 'Alliance',
    shipTypeId,
    shipName,
    weaponTypeId: null,
    weaponName: null,
    damageDone: characterId * 100,
    finalBlow
  }
}

function entry(input: {
  killmailId: number
  kind?: CombatHistoryEntry['kind']
  time: string
  solarSystemId: number
  solarSystemName: string | null
  victimCharacterId: number
  victimName: string
  victimCorporationName: string
  victimShipTypeId: number
  victimShipName: string
  attackers: CombatHistoryAttacker[]
  totalValue: number
  attackersCapped?: boolean
}): CombatHistoryEntry {
  return {
    kind: input.kind ?? 'kill',
    killmailId: input.killmailId,
    time: input.time,
    solarSystemId: input.solarSystemId,
    solarSystemName: input.solarSystemName,
    victimCharacterId: input.victimCharacterId,
    victimName: input.victimName,
    victimCorporationName: input.victimCorporationName,
    victimFit: fit(input.victimShipTypeId, input.victimShipName),
    attackerShipTypeId: null,
    attackerShipName: null,
    pilotFinalBlow: false,
    attackers: input.attackers,
    attackerCount: input.attackers.length,
    attackersCapped: input.attackersCapped ?? false,
    nonCapsuleerAttackerCount: 0,
    totalValue: input.totalValue,
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
