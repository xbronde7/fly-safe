import { describe, expect, it } from 'vitest'
import {
  buildSystemHistoryFacts,
  calculateSystemDanger,
  collectSystemKillmailNameIds,
  isWormholeSystemId,
  parseSystemKillmail
} from '../src/shared/system-intel'

const SYSTEM_ID = 30_000_142

function killmail(
  id: number,
  time: string,
  victimCharacterId: number,
  victimShipTypeId: number,
  attackers: unknown[]
): unknown {
  return {
    killmail_id: id,
    killmail_time: time,
    solar_system_id: SYSTEM_ID,
    victim: {
      character_id: victimCharacterId,
      ship_type_id: victimShipTypeId
    },
    attackers,
    zkb: { totalValue: id * 1_000 }
  }
}

describe('system killmail facts', () => {
  it('parses full killmails and rejects compact, malformed, or wrong-system data', () => {
    const full = killmail(10, '2026-08-21T12:00:00Z', 90_001, 11_978, [
      { character_id: 90_002, ship_type_id: 17_918, final_blow: true }
    ])

    expect(parseSystemKillmail(full, SYSTEM_ID)).toMatchObject({
      killmailId: 10,
      solarSystemId: SYSTEM_ID,
      victimCharacterId: 90_001,
      victimShipTypeId: 11_978,
      totalValue: 10_000
    })
    expect(parseSystemKillmail({ killmail_id: 10, zkb: { hash: 'a'.repeat(40) } })).toBeNull()
    expect(parseSystemKillmail(full, 30_002_365)).toBeNull()
    expect(parseSystemKillmail({})).toBeNull()
  })

  it('deduplicates output entities, counts both roles, resolves names, sorts, and caps lists', () => {
    const raw = [
      killmail(1, '2026-08-21T10:00:00Z', 90_001, 11_978, [
        { character_id: 90_002, ship_type_id: 17_918, final_blow: true },
        { character_id: 90_003, ship_type_id: 17_918 }
      ]),
      killmail(2, '2026-08-21T11:00:00Z', 90_002, 17_918, [
        { character_id: 90_001, ship_type_id: 11_978, final_blow: true }
      ]),
      killmail(1, '2026-08-21T10:00:00Z', 90_001, 11_978, [
        { character_id: 90_002, ship_type_id: 17_918, final_blow: true },
        { character_id: 90_003, ship_type_id: 17_918 }
      ]),
      { killmail_id: 3, zkb: { hash: 'b'.repeat(40) } }
    ]
    const names = new Map([
      [90_001, 'Pilot One'],
      [90_002, 'Pilot Two'],
      [90_003, 'Pilot Three'],
      [11_978, 'Astero'],
      [17_918, 'Rattlesnake']
    ])

    const facts = buildSystemHistoryFacts(raw, names, SYSTEM_ID, {
      latestKillmails: 1,
      observedShips: 1,
      observedPilots: 2
    })

    expect(facts).toMatchObject({
      count: 2,
      sourceCapped: false,
      latestCapped: true,
      capped: true,
      observedShipsCapped: true,
      observedPilotsCapped: true,
      invalidCount: 1
    })
    expect(facts.latest).toEqual([
      expect.objectContaining({
        killmailId: 2,
        victimName: 'Pilot Two',
        victimShipName: 'Rattlesnake'
      })
    ])
    expect(facts.observedShips[0]).toMatchObject({
      typeId: 17_918,
      name: 'Rattlesnake',
      victimCount: 1,
      attackerCount: 2,
      pilots: expect.arrayContaining([
        expect.objectContaining({
          characterId: 90_002,
          victimCount: 1,
          attackerCount: 1,
          finalBlowCount: 1,
          lastAttackerSeen: '2026-08-21T10:00:00.000Z',
          lastVictimSeen: '2026-08-21T11:00:00.000Z'
        }),
        expect.objectContaining({
          characterId: 90_003,
          victimCount: 0,
          attackerCount: 1,
          finalBlowCount: 0
        })
      ]),
      occurrences: [
        {
          killmailId: 2,
          time: '2026-08-21T11:00:00.000Z',
          solarSystemId: SYSTEM_ID,
          role: 'victim',
          pilotCharacterId: 90_002,
          pilotName: 'Pilot Two',
          finalBlow: false,
          victimCharacterId: 90_002,
          victimName: 'Pilot Two',
          victimShipTypeId: 17_918,
          victimShipName: 'Rattlesnake',
          totalValue: 2_000
        },
        expect.objectContaining({
          killmailId: 1,
          role: 'attacker',
          pilotCharacterId: 90_002,
          victimCharacterId: 90_001,
          victimName: 'Pilot One',
          victimShipTypeId: 11_978,
          victimShipName: 'Astero',
          totalValue: 1_000
        }),
        expect.objectContaining({
          killmailId: 1,
          role: 'attacker',
          pilotCharacterId: 90_003
        })
      ],
      occurrencesCapped: false
    })
    expect(facts.observedPilots).toHaveLength(2)
    expect(new Set(facts.observedPilots.map((pilot) => pilot.characterId)).size).toBe(2)

    const parsed = raw.flatMap((item) => {
      const value = parseSystemKillmail(item, SYSTEM_ID)
      return value ? [value] : []
    })
    expect(new Set(collectSystemKillmailNameIds(parsed))).toEqual(
      new Set([90_001, 90_002, 90_003, 11_978, 17_918])
    )
  })

  it('separates an upstream 200-row page cap from the local latest-list cap', () => {
    const repeated = killmail(10, '2026-08-21T12:00:00Z', 90_001, 11_978, [
      { character_id: 90_002, ship_type_id: 17_918, final_blow: true }
    ])
    const facts = buildSystemHistoryFacts(Array.from({ length: 200 }, () => repeated))

    expect(facts).toMatchObject({
      count: 1,
      sourceCapped: true,
      latestCapped: false,
      capped: true
    })
    expect(facts.latest).toHaveLength(1)
  })

  it('does not report NPC attacker hulls as observed capsuleer ships', () => {
    const raw = killmail(11, '2026-08-21T12:30:00Z', 90_001, 11_978, [
      { character_id: 90_002, ship_type_id: 17_918, final_blow: true },
      { corporation_id: 1_000_125, ship_type_id: 37_556, final_blow: false }
    ])
    const parsed = parseSystemKillmail(raw, SYSTEM_ID)
    expect(parsed).not.toBeNull()

    const facts = buildSystemHistoryFacts([raw], new Map(), SYSTEM_ID)
    expect(facts.observedShips.map((ship) => ship.typeId)).toEqual([11_978, 17_918])
    expect(facts.observedShips.find((ship) => ship.typeId === 37_556)).toBeUndefined()
    expect(facts.observedShips.flatMap((ship) => ship.pilots.map((pilot) => pilot.characterId)))
      .not.toContain(1_000_125)
    expect(facts.observedShips.flatMap((ship) => ship.occurrences))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ pilotCharacterId: 90_001, role: 'victim' }),
        expect.objectContaining({ pilotCharacterId: 90_002, role: 'attacker' })
      ]))
    expect(facts.observedShips.flatMap((ship) => ship.occurrences)).toHaveLength(2)
    expect(collectSystemKillmailNameIds([parsed!])).not.toContain(37_556)
  })

  it('does not create a pilot occurrence for a victim without a character ID', () => {
    const raw = {
      killmail_id: 12,
      killmail_time: '2026-08-21T12:45:00Z',
      solar_system_id: SYSTEM_ID,
      victim: { ship_type_id: 11_978 },
      attackers: [{ character_id: 90_002, ship_type_id: 17_918, final_blow: true }],
      zkb: { totalValue: 42_000_000 }
    }

    const facts = buildSystemHistoryFacts([raw], new Map(), SYSTEM_ID)

    expect(facts.observedShips.find((ship) => ship.typeId === 11_978)?.occurrences).toEqual([])
    expect(facts.observedShips.find((ship) => ship.typeId === 17_918)?.occurrences).toEqual([
      expect.objectContaining({
        role: 'attacker',
        pilotCharacterId: 90_002,
        victimCharacterId: null
      })
    ])
  })

  it('keeps complete per-hull pilot links when the separate pilot lists are capped', () => {
    const raw = [
      killmail(20, '2026-08-21T12:00:00Z', 90_001, 11_978, [
        { character_id: 90_002, ship_type_id: 17_918, final_blow: true },
        { character_id: 90_003, ship_type_id: 17_918, final_blow: false }
      ])
    ]

    const facts = buildSystemHistoryFacts(raw, new Map(), SYSTEM_ID, {
      observedPilots: 1,
      pilotShipTypes: 1
    })

    expect(facts.observedPilots).toHaveLength(1)
    expect(facts.observedShips.find((ship) => ship.typeId === 17_918)?.pilots)
      .toHaveLength(2)
  })

  it('caps per-hull candidates separately and reports the boundary', () => {
    const raw = killmail(21, '2026-08-21T12:00:00Z', 90_001, 11_978, [
      { character_id: 90_002, ship_type_id: 17_918 },
      { character_id: 90_003, ship_type_id: 17_918 }
    ])

    const facts = buildSystemHistoryFacts([raw], new Map(), SYSTEM_ID, {
      observedShipPilots: 1
    })
    const ship = facts.observedShips.find((candidate) => candidate.typeId === 17_918)

    expect(ship?.pilots).toHaveLength(1)
    expect(ship?.pilotsCapped).toBe(true)
  })

  it('caps exact per-hull killmail occurrences separately and keeps the newest event', () => {
    const raw = [
      killmail(30, '2026-08-21T12:00:00Z', 90_001, 11_978, [
        { character_id: 90_002, ship_type_id: 17_918 }
      ]),
      killmail(31, '2026-08-21T13:00:00Z', 90_003, 11_978, [
        { character_id: 90_004, ship_type_id: 17_918, final_blow: true }
      ])
    ]

    const facts = buildSystemHistoryFacts(raw, new Map(), SYSTEM_ID, {
      observedShipOccurrences: 1
    })
    const ship = facts.observedShips.find((candidate) => candidate.typeId === 17_918)

    expect(ship?.occurrences).toEqual([
      expect.objectContaining({
        killmailId: 31,
        role: 'attacker',
        pilotCharacterId: 90_004,
        finalBlow: true
      })
    ])
    expect(ship?.occurrencesCapped).toBe(true)
  })
})

describe('system danger score', () => {
  it('keeps an explicit point breakdown separate from facts', () => {
    const result = calculateSystemDanger({
      securityStatus: 0.3,
      isWormhole: false,
      shipKills: 2,
      podKills: 1,
      jumps: 20,
      zkill24hCount: 4
    })

    expect(result.score).toBe(
      result.factors.reduce((sum, factor) => sum + factor.points, 0)
    )
    expect(result.level).toBe('high')
    expect(result.factors.map((factor) => factor.code)).toEqual([
      'zkill-24h',
      'ship-kills-1h',
      'pod-kills-1h',
      'kill-density',
      'security'
    ])
    expect(result.reasons).toEqual(result.factors.map((factor) => factor.reason))
  })

  it('distinguishes W-space IDs from known-space Pochven and abyssal ranges', () => {
    expect(isWormholeSystemId(31_000_001)).toBe(true)
    expect(isWormholeSystemId(31_999_999)).toBe(true)
    expect(isWormholeSystemId(31_000_000)).toBe(false)
    expect(isWormholeSystemId(30_003_504)).toBe(false)
    expect(isWormholeSystemId(32_000_001)).toBe(false)
  })

  it('returns unknown when all public activity feeds are unavailable', () => {
    expect(
      calculateSystemDanger({
        securityStatus: -0.5,
        isWormhole: true,
        shipKills: null,
        podKills: null,
        jumps: null,
        zkill24hCount: null
      })
    ).toMatchObject({ score: 0, level: 'unknown', factors: [] })
  })

  it('returns unknown when jumps exist but every combat feed is unavailable', () => {
    expect(
      calculateSystemDanger({
        securityStatus: -0.5,
        isWormhole: false,
        shipKills: null,
        podKills: null,
        jumps: 42,
        zkill24hCount: null
      })
    ).toEqual({
      score: 0,
      level: 'unknown',
      reasons: ['ESI and zKillboard combat sources are unavailable or returned incomplete data'],
      factors: []
    })
  })
})
