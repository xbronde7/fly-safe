import { describe, expect, it } from 'vitest'
import { upsertReadyPilot } from '../src/shared/progressive-pilots'
import type { PilotIntel } from '../src/shared/types'

describe('progressive pilot rows', () => {
  it('keeps completion order and updates a repeated pilot without duplication', () => {
    const second = pilot(2, 'Second', 20)
    const first = pilot(1, 'First', 10)
    const updatedSecond = pilot(2, 'Second', 90)

    const loaded = upsertReadyPilot(upsertReadyPilot([], second), first)
    expect(loaded.map(({ id }) => id)).toEqual([2, 1])

    const updated = upsertReadyPilot(loaded, updatedSecond)
    expect(updated.map(({ id }) => id)).toEqual([2, 1])
    expect(updated).toHaveLength(2)
    expect(updated[0]?.threatScore).toBe(90)
  })
})

function pilot(id: number, name: string, threatScore: number): PilotIntel {
  return {
    id,
    name,
    corporationId: null,
    corporationName: null,
    allianceId: null,
    allianceName: null,
    factionId: null,
    stats: null,
    threatScore,
    threatLevel: threatScore >= 80 ? 'critical' : 'low',
    reasons: [],
    zkillUrl: `https://zkillboard.com/character/${id}/`,
    cached: false,
    error: null
  }
}
