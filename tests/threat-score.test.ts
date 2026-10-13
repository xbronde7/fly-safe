import { describe, expect, it } from 'vitest'
import type { PilotStats } from '../src/shared/types'
import {
  assessThreat,
  calculateThreatScore,
  normalizeZkillStats,
  threatLevelForScore,
} from '../src/shared/threat-score'

describe('normalizeZkillStats', () => {
  it('normalizes string numbers, ratios and month activity', () => {
    expect(
      normalizeZkillStats({
        dangerRatio: '106',
        gangRatio: '65.5',
        shipsDestroyed: '1,234',
        shipsLost: -3,
        soloKills: '100',
        iskDestroyed: '450000000000',
        months: { 202401: 3, '2024-03': 8, invalid: 99 },
      }),
    ).toEqual({
      dangerRatio: 100,
      gangRatio: 65.5,
      soloRatio: 34.5,
      shipsDestroyed: 1234,
      shipsLost: 0,
      soloKills: 100,
      iskDestroyed: 450_000_000_000,
      activeMonths: 2,
      lastActivity: '2024-03-01T00:00:00.000Z',
      targetProfile: {
        totalKills: 1234,
        categorizedKills: 0,
        entries: expect.any(Array),
        top: [],
      },
    })
  })

  it('never throws or leaks NaN for malformed responses', () => {
    expect(normalizeZkillStats({ dangerRatio: 'wat', shipsDestroyed: Infinity })).toEqual({
      dangerRatio: null,
      gangRatio: null,
      soloRatio: null,
      shipsDestroyed: 0,
      shipsLost: 0,
      soloKills: 0,
      iskDestroyed: 0,
      activeMonths: 0,
      lastActivity: null,
      targetProfile: {
        totalKills: 0,
        categorizedKills: 0,
        entries: expect.any(Array),
        top: [],
      },
    })
    expect(normalizeZkillStats([])).toEqual(normalizeZkillStats(null))
  })

  it('prefers explicit fields and accepts valid activity dates', () => {
    const stats = normalizeZkillStats({
      gangRatio: 90,
      soloRatio: 42,
      activeMonths: 7.8,
      lastActivity: '2026-08-20T12:30:00Z',
      months: { 202001: 1 },
    })

    expect(stats.soloRatio).toBe(42)
    expect(stats.activeMonths).toBe(7)
    expect(stats.lastActivity).toBe('2026-08-20T12:30:00.000Z')
  })
})

describe('assessThreat', () => {
  const dangerous: PilotStats = {
    dangerRatio: 94,
    gangRatio: 25,
    soloRatio: 75,
    shipsDestroyed: 8_000,
    shipsLost: 200,
    soloKills: 900,
    iskDestroyed: 2_000_000_000_000,
    activeMonths: 60,
    lastActivity: '2026-08-01T00:00:00.000Z',
    targetProfile: normalizeZkillStats({}).targetProfile,
  }

  it('marks missing stats unknown', () => {
    expect(assessThreat(null)).toEqual({
      score: 0,
      level: 'unknown',
      reasons: ['No zKillboard data'],
    })
  })

  it('returns a bounded, explainable critical score for a veteran hunter', () => {
    const result = assessThreat(dangerous)

    expect(result.score).toBeGreaterThanOrEqual(75)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.level).toBe('critical')
    expect(result.reasons.length).toBeGreaterThan(1)
    expect(calculateThreatScore(dangerous)).toBe(result.score)
  })

  it('treats empty but available stats as low rather than unknown', () => {
    const result = assessThreat(normalizeZkillStats({}))

    expect(result.score).toBe(0)
    expect(result.level).toBe('low')
    expect(result.reasons).toEqual(['Little confirmed PvP activity'])
  })

  it('maps score boundaries consistently', () => {
    expect(threatLevelForScore(0)).toBe('low')
    expect(threatLevelForScore(30)).toBe('medium')
    expect(threatLevelForScore(55)).toBe('high')
    expect(threatLevelForScore(75)).toBe('critical')
    expect(threatLevelForScore(99, false)).toBe('unknown')
  })
})
