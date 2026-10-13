import { describe, expect, it } from 'vitest'
import {
  buildRecentTargetProfile,
  buildTargetProfile,
  classifyRecentTargetObservation,
  selectTargetProfile,
} from '../src/shared/target-profile'

describe('buildTargetProfile', () => {
  it('always returns nine stable categories for empty input', () => {
    const profile = buildTargetProfile(null)

    expect(profile.totalKills).toBe(0)
    expect(profile.categorizedKills).toBe(0)
    expect(profile.entries.map(({ category }) => category)).toEqual([
      'scanner',
      'logistics',
      'mining',
      'hauler',
      'pve',
      'combat',
      'capital',
      'structure',
      'other',
    ])
    expect(profile.entries.every(({ kills, share }) => kills === 0 && share === 0)).toBe(true)
    expect(profile.top).toEqual([])
  })

  it('classifies object rows, supports key fallback and uses total kills for shares', () => {
    const profile = buildTargetProfile(
      {
        covert: { groupID: 830, shipsDestroyed: 20 },
        1527: { shipsDestroyed: '10' },
        barge: { groupID: '463', shipsDestroyed: '1,200' },
        freighter: { groupID: 513, shipsDestroyed: 30 },
        marauder: { groupID: 900, shipsDestroyed: 15 },
        assaultFrigate: { groupID: 324, shipsDestroyed: 80 },
        dread: { groupID: 485, shipsDestroyed: 5 },
        citadel: { groupID: 1657, shipsDestroyed: 2 },
        pod: { groupID: 29, shipsDestroyed: 38 },
      },
      2_000,
    )

    expect(profile.totalKills).toBe(2_000)
    expect(profile.categorizedKills).toBe(1_342)
    expect(Object.fromEntries(profile.entries.map(({ category, kills }) => [category, kills]))).toEqual(
      {
        scanner: 0,
        logistics: 10,
        mining: 1_200,
        hauler: 30,
        pve: 15,
        combat: 80,
        capital: 5,
        structure: 2,
        other: 58,
      },
    )
    expect(profile.entries.find(({ category }) => category === 'mining')?.share).toBe(0.6)
    expect(profile.top.map(({ category }) => category)).toEqual([
      'mining',
      'combat',
      'other',
      'hauler',
      'pve',
      'logistics',
      'capital',
      'structure',
    ])
  })

  it('handles arrays, duplicate categories and malformed rows without NaN', () => {
    const profile = buildTargetProfile(
      [
        { groupID: 830, shipsDestroyed: 3.9 },
        { groupID: 1022, shipsDestroyed: 4 },
        { groupID: 832, shipsDestroyed: -10 },
        { groupID: 543, shipsDestroyed: Number.POSITIVE_INFINITY },
        { groupID: 1202, shipsDestroyed: '2' },
        { groupID: 'bad', shipsDestroyed: 6 },
        { groupID: 830, shipsDestroyed: true },
        null,
      ],
      1,
    )

    expect(profile.totalKills).toBe(15)
    expect(profile.categorizedKills).toBe(6)
    expect(profile.entries.find(({ category }) => category === 'scanner')).toMatchObject({
      kills: 4,
      share: 4 / 15,
    })
    expect(profile.entries.find(({ category }) => category === 'hauler')).toMatchObject({
      kills: 2,
      share: 2 / 15,
    })
    expect(profile.entries.find(({ category }) => category === 'other')).toMatchObject({
      kills: 9,
      share: 9 / 15,
    })
    expect(profile.entries.every(({ share }) => Number.isFinite(share) && share >= 0 && share <= 1)).toBe(
      true,
    )
  })

  it('breaks equal-kill ties by stable category order', () => {
    const profile = buildTargetProfile({
      combat: { groupID: 324, shipsDestroyed: 5 },
      scanner: { groupID: 1022, shipsDestroyed: 5 },
      logistics: { groupID: 832, shipsDestroyed: 5 },
    })

    expect(profile.top.map(({ category }) => category)).toEqual([
      'scanner',
      'logistics',
      'combat',
    ])
  })

  it('uses the object key when a row carries placeholder groupID zero', () => {
    const profile = buildTargetProfile({
      832: { groupID: 0, shipsDestroyed: 3 },
    })

    expect(profile.entries.find(({ category }) => category === 'logistics')?.kills).toBe(3)
    expect(profile.categorizedKills).toBe(3)
  })

  it('builds an explicitly recent fallback profile from killmail victim hull names', () => {
    const profile = buildRecentTargetProfile([
      { shipName: 'Astero' },
      { shipName: 'Guardian' },
      { shipName: 'Hulk' },
      { shipName: 'Providence' },
      { shipName: 'Gila', shipTypeId: 17715, groupId: 26 },
      { shipName: 'Capsule' }
    ])

    expect(profile.totalKills).toBe(6)
    expect(Object.fromEntries(profile.entries.map(({ category, kills }) => [category, kills])))
      .toMatchObject({
        scanner: 1,
        logistics: 1,
        mining: 1,
        hauler: 1,
        combat: 1,
        other: 1
      })
  })

  it('classifies a recent victim by exact type, exact name, then role-safe group', () => {
    expect(classifyRecentTargetObservation({
      shipName: null,
      shipTypeId: 33468,
      groupId: 25,
    })).toBe('scanner')

    expect(classifyRecentTargetObservation({
      shipName: '  ASTERO  ',
      shipTypeId: null,
      groupId: null,
    })).toBe('scanner')

    expect(classifyRecentTargetObservation({
      shipName: null,
      shipTypeId: null,
      groupId: 900,
    })).toBe('pve')
  })

  it.each([
    ['Astero', 33468, 25, 'scanner'],
    ['Bantam', 582, 25, 'logistics'],
    ['Venture', 32880, 25, 'mining'],
    ['Rifter', 587, 25, 'combat'],
    ['Stratios', 33470, 26, 'scanner'],
    ['Rodiva', 49712, 26, 'logistics'],
    ['Caracal', 621, 26, 'combat'],
    ['Pioneer', 89240, 420, 'mining'],
    ['Thrasher', 16242, 420, 'combat'],
    ['Pacifier', 44993, 830, 'combat'],
    ['Buzzard', 11192, 830, 'scanner'],
    ['Babaroga', 88001, 900, 'pve'],
    ['Dagon', 42242, 1538, 'logistics'],
    ['Mobile Depot', 33474, 1246, 'structure'],
    ['Caldari Shuttle', 672, 31, 'other'],
  ] as const)('classifies %s from real ESI metadata', (shipName, shipTypeId, groupId, category) => {
    expect(classifyRecentTargetObservation({ shipName, shipTypeId, groupId })).toBe(category)
  })

  it('keeps mixed aggregate groups unclassified and coverage honest', () => {
    const profile = buildTargetProfile({
      scanner: { groupID: 1022, shipsDestroyed: 20 },
      frigates: { groupID: 25, shipsDestroyed: 70 },
      capsules: { groupID: 29, shipsDestroyed: 10 },
    }, 100)

    expect(profile.categorizedKills).toBe(20)
    expect(profile.entries.find(({ category }) => category === 'scanner')?.kills).toBe(20)
    expect(profile.entries.find(({ category }) => category === 'other')?.kills).toBe(80)
  })

  it('uses complete exact recent evidence only when it covers the lifetime total', () => {
    const lifetime = buildTargetProfile({ mixed: { groupID: 25, shipsDestroyed: 1 } }, 1)
    const recent = buildRecentTargetProfile([
      { shipName: 'Astero', shipTypeId: 33468, groupId: 25 },
    ])

    expect(selectTargetProfile(lifetime, recent, true)).toMatchObject({
      source: 'recent',
      profile: { categorizedKills: 1 },
    })
    expect(selectTargetProfile(lifetime, recent, false)).toMatchObject({
      source: 'lifetime',
      profile: { categorizedKills: 0 },
    })
    expect(selectTargetProfile(buildTargetProfile(null, 100), recent, true).source)
      .toBe('lifetime')
  })

  it('uses the destroyed victim hull, not the ship flown by the watched pilot', () => {
    const scannerAttackerCombatVictim = {
      attackerShipName: 'Astero',
      victim: { shipName: 'Rifter', shipTypeId: 587, groupId: 25 },
    }
    const combatAttackerScannerVictim = {
      attackerShipName: 'Rattlesnake',
      victim: { shipName: 'Astero', shipTypeId: 33468, groupId: 25 },
    }

    expect(classifyRecentTargetObservation(scannerAttackerCombatVictim.victim)).toBe('combat')
    expect(classifyRecentTargetObservation(combatAttackerScannerVictim.victim)).toBe('scanner')
  })

  it('keeps Marauders, Upwell structures and Force Auxiliaries consistent without group data', () => {
    expect(classifyRecentTargetObservation({ shipName: 'Paladin' })).toBe('pve')
    expect(classifyRecentTargetObservation({ shipName: 'Astrahus' })).toBe('structure')
    expect(classifyRecentTargetObservation({ shipName: 'Apostle' })).toBe('logistics')

    const profile = buildRecentTargetProfile([
      { shipName: null, shipTypeId: 28659 },
      { shipName: null, shipTypeId: 35832 },
      { shipName: null, shipTypeId: 37604 },
      { shipName: null, groupId: 900 },
      { shipName: null, groupId: 1657 },
      { shipName: null, groupId: 1538 },
    ])

    expect(Object.fromEntries(profile.entries.map(({ category, kills }) => [category, kills])))
      .toMatchObject({ pve: 2, structure: 2, logistics: 2 })
  })

  it('falls back safely when recent victim metadata is absent or malformed', () => {
    expect(classifyRecentTargetObservation({ shipName: null })).toBe('other')
    expect(classifyRecentTargetObservation({
      shipName: 'Guardian',
      shipTypeId: Number.NaN,
      groupId: -1,
    })).toBe('logistics')
    expect(classifyRecentTargetObservation({ shipName: 'Unknown hull' })).toBe('other')
  })
})
