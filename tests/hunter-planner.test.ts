import { describe, expect, it } from 'vitest'
import { buildHunterPlan } from '../src/shared/hunter-planner'
import type { EncounterSnapshot } from '../src/shared/encounter-journal'

describe('Hunter Planner encounter analytics', () => {
  it('deduplicates repeated snapshots and builds timezone-aware activity patterns', () => {
    const snapshots = [
      encounter(1, '2026-08-25T20:10:00Z', 31_000_001, 'J100001', null, 'Target One'),
      encounter(2, '2026-08-25T20:30:00Z', 31_000_001, 'J100001', 101, ' target   ONE '),
      encounter(3, '2026-08-26T20:15:00Z', 31_000_001, 'J100001', 101, 'Target One'),
      encounter(4, '2026-08-27T20:15:00Z', 31_000_002, 'J100002', 101, 'Target One'),
      encounter(5, '2026-08-27T21:15:00Z', 31_000_002, 'J100002', 202, 'Second Target')
    ]
    const plan = buildHunterPlan(snapshots, {
      timezoneOffsetMinutes: 300,
      activityBucketMinutes: 60
    })

    expect(plan).toMatchObject({
      timezoneOffsetMinutes: 300,
      sourceSnapshotCount: 5,
      encounters: 4
    })
    const target = plan.targets.find((entry) => entry.characterId === 101)
    expect(target).toMatchObject({
      key: 'id:101',
      encounters: 3,
      distinctDays: 3,
      confidence: 'medium',
      activeHours: [{ hour: 1, encounters: 3, share: 1 }]
    })
    expect(target?.aliases).toEqual(expect.arrayContaining(['Target One', 'target ONE']))
    expect(target?.systems).toEqual([
      expect.objectContaining({ solarSystemId: 31_000_001, encounters: 2, share: 0.6667 }),
      expect.objectContaining({ solarSystemId: 31_000_002, encounters: 1, share: 0.3333 })
    ])
    expect(plan.systems).toEqual([
      expect.objectContaining({ solarSystemId: 31_000_002, encounters: 2, uniqueTargets: 2 }),
      expect.objectContaining({ solarSystemId: 31_000_001, encounters: 2, uniqueTargets: 1 })
    ])
    expect(plan.heatmap).toHaveLength(168)
    expect(plan.heatmap.filter((cell) => cell.hour === 1)
      .reduce((total, cell) => total + cell.encounters, 0)).toBe(3)
    expect(plan.heatmap.filter((cell) => cell.hour === 2)
      .reduce((total, cell) => total + cell.encounters, 0)).toBe(1)
  })

  it('keeps ambiguous unresolved names separate and validates planner options', () => {
    const snapshots = [
      encounter(1, '2026-08-25T10:00:00Z', 1, 'One', 101, 'Same Name'),
      encounter(2, '2026-08-26T10:00:00Z', 1, 'One', 202, 'Same Name'),
      encounter(3, '2026-08-27T10:00:00Z', 1, 'One', null, 'Same Name')
    ]
    expect(buildHunterPlan(snapshots).targets.map((target) => target.key).sort()).toEqual([
      'id:101',
      'id:202',
      'name:same name'
    ])
    expect(() => buildHunterPlan(snapshots, { timezoneOffsetMinutes: 2_000 }))
      .toThrow('timezone offset')
    expect(() => buildHunterPlan(snapshots, { activityBucketMinutes: 1 }))
      .toThrow('time-window size')
  })
})

function encounter(
  id: number,
  capturedAt: string,
  solarSystemId: number,
  systemName: string,
  characterId: number | null,
  pilotName: string
): EncounterSnapshot {
  return {
    id,
    capturedAt: new Date(capturedAt).toISOString(),
    recordedAt: new Date(capturedAt).toISOString(),
    currentSystem: { solarSystemId, name: systemName },
    ownShip: null,
    localPilots: [{ characterId, name: pilotName, corporationName: null }],
    dscanHulls: []
  }
}
