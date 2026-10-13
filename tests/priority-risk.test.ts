import { describe, expect, it } from 'vitest'
import {
  assessPriorityRisk,
  isRiskPriority,
  RISK_PRIORITY_OPTIONS,
  type RiskPriority
} from '../src/shared/priority-risk'
import {
  buildRecentTargetProfile,
  buildTargetProfile,
  type RecentTargetObservation,
  type TargetCategory,
  type TargetProfile
} from '../src/shared/target-profile'
import type { RecentTargetProfileSnapshot } from '../src/shared/types'

const GROUP_BY_CATEGORY: Record<Exclude<TargetCategory, 'other'>, number> = {
  scanner: 1022,
  logistics: 832,
  mining: 463,
  hauler: 513,
  pve: 900,
  combat: 324,
  capital: 485,
  structure: 1657
}

function lifetime(
  category: Exclude<TargetCategory, 'other'>,
  matches: number,
  total: number
): TargetProfile {
  return buildTargetProfile({
    selected: { groupID: GROUP_BY_CATEGORY[category], shipsDestroyed: matches },
    remainder: { groupID: 29, shipsDestroyed: Math.max(0, total - matches) }
  }, total)
}

function recent(
  observations: readonly RecentTargetObservation[],
  options: { complete?: boolean; requestedSampleSize?: number } = {}
): RecentTargetProfileSnapshot {
  const requestedSampleSize = options.requestedSampleSize ?? observations.length
  return {
    characterId: 90_000_001,
    fetchedAt: '2026-08-27T00:00:00.000Z',
    cached: false,
    requestedSampleSize,
    sampleSize: observations.length,
    complete: options.complete ?? true,
    profile: buildRecentTargetProfile(observations),
    warnings: options.complete === false ? ['partial'] : []
  }
}

function observations(
  category: Exclude<TargetCategory, 'other'>,
  matches: number,
  total = 10
): RecentTargetObservation[] {
  return Array.from({ length: total }, (_, index) => index < matches
    ? { shipName: null, groupId: GROUP_BY_CATEGORY[category] }
    : { shipName: 'Capsule' })
}

describe('priority target risk', () => {
  it('offers one general mode and every actionable target category', () => {
    const values = RISK_PRIORITY_OPTIONS.map(({ value }) => value)

    expect(values).toEqual([
      'general', 'scanner', 'logistics', 'mining', 'hauler', 'pve', 'combat',
      'capital', 'structure'
    ])
    expect(values.every((value) => isRiskPriority(value))).toBe(true)
    expect(isRiskPriority('other')).toBe(false)
  })

  it('marks repeated recent scanner victims as critical', () => {
    const assessment = assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: lifetime('scanner', 30, 100),
      baseThreatScore: 70,
      recent: recent(observations('scanner', 6)),
      evidenceStatus: 'ready'
    })

    expect(assessment).toMatchObject({
      level: 'critical',
      recentMatches: 6,
      recentSampleSize: 10,
      lifetimeMatches: 30,
      confidence: 'full'
    })
    expect(assessment.score).toBeGreaterThanOrEqual(75)
    expect(assessment.reasons.join(' ')).toContain('6 of 10')
  })

  it('makes zero selected victims in a complete last-ten sample low', () => {
    const assessment = assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: lifetime('scanner', 2, 100),
      baseThreatScore: 95,
      recent: recent(observations('scanner', 0)),
      evidenceStatus: 'ready'
    })

    expect(assessment.level).toBe('low')
    expect(assessment.score).toBeLessThan(30)
    expect(assessment.recentComplete).toBe(true)
    expect(assessment.reasons[0]).toContain('0 of 10')
  })

  it('does not make one matching kill in a one-kill career critical', () => {
    const assessment = assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: lifetime('scanner', 1, 1),
      baseThreatScore: 99,
      recent: recent(observations('scanner', 1, 1)),
      evidenceStatus: 'ready'
    })

    expect(assessment.level).toBe('low')
    expect(assessment.score).toBeLessThan(30)
  })

  it('caps a short 12-kill career below critical even with three recent matches', () => {
    const assessment = assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: lifetime('scanner', 4, 12),
      baseThreatScore: 90,
      recent: recent(observations('scanner', 3)),
      evidenceStatus: 'ready'
    })

    expect(assessment.level).toBe('high')
    expect(assessment.score).toBe(74)
  })

  it('treats a confirmed zero-kill profile as low volume, not missing data', () => {
    const assessment = assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: buildTargetProfile(null, 0),
      baseThreatScore: 0,
      recent: recent([]),
      evidenceStatus: 'ready'
    })

    expect(assessment.level).toBe('low')
    expect(assessment.score).toBe(0)
    expect(assessment.reasons[0]).toContain('No public kills')
  })

  it('uses strong lifetime specialization even while recent evidence is loading', () => {
    const assessment = assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: lifetime('scanner', 25, 100),
      baseThreatScore: 60,
      recent: null,
      evidenceStatus: 'loading'
    })

    expect(assessment.level).toBe('critical')
    expect(assessment.confidence).toBe('partial')
    expect(assessment.reasons.join(' ')).toContain('specialt')
  })

  it('returns unknown rather than low when history is unavailable and no specialization exists', () => {
    const assessment = assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: lifetime('scanner', 0, 100),
      baseThreatScore: 90,
      recent: null,
      evidenceStatus: 'error'
    })

    expect(assessment.level).toBe('unknown')
    expect(assessment.score).toBe(0)
    expect(assessment.reasons[0]).toContain('unavailable')
  })

  it('does not treat an incomplete zero-match sample as safe', () => {
    const assessment = assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: lifetime('scanner', 0, 100),
      baseThreatScore: 80,
      recent: recent(observations('scanner', 0, 4), {
        complete: false,
        requestedSampleSize: 10
      }),
      evidenceStatus: 'ready'
    })

    expect(assessment.level).toBe('unknown')
    expect(assessment.confidence).toBe('partial')
  })

  it('keeps categories isolated and scores stay finite and bounded', () => {
    const categories = RISK_PRIORITY_OPTIONS
      .map(({ value }) => value)
      .filter((value): value is Exclude<RiskPriority, 'general'> => value !== 'general')

    for (const category of categories) {
      const own = assessPriorityRisk({
        category,
        lifetimeProfile: lifetime(category, 30, 100),
        baseThreatScore: 50,
        recent: recent(observations(category, 5)),
        evidenceStatus: 'ready'
      })
      const scanner = assessPriorityRisk({
        category: 'scanner',
        lifetimeProfile: lifetime(category, 30, 100),
        baseThreatScore: Number.NaN,
        recent: recent(observations(category, 5)),
        evidenceStatus: 'ready'
      })

      expect(Number.isFinite(own.score)).toBe(true)
      expect(own.score).toBeGreaterThanOrEqual(0)
      expect(own.score).toBeLessThanOrEqual(100)
      if (category !== 'scanner') expect(scanner.recentMatches).toBe(0)
    }
  })

  it('is monotonic as matching victims increase for the same sample', () => {
    const scores = Array.from({ length: 11 }, (_, matches) => assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: lifetime('scanner', 20, 100),
      baseThreatScore: 50,
      recent: recent(observations('scanner', matches)),
      evidenceStatus: 'ready'
    }).score)

    for (let index = 1; index < scores.length; index += 1) {
      expect(scores[index]).toBeGreaterThanOrEqual(scores[index - 1])
    }
  })
})
