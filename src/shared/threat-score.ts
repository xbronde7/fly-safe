import type { PilotStats, ThreatLevel } from './types'
import { buildTargetProfile } from './target-profile'

type UnknownRecord = Record<string, unknown>

export interface ThreatAssessment {
  score: number
  level: ThreatLevel
  reasons: string[]
}

const EMPTY_STATS: PilotStats = {
  dangerRatio: null,
  gangRatio: null,
  soloRatio: null,
  shipsDestroyed: 0,
  shipsLost: 0,
  soloKills: 0,
  iskDestroyed: 0,
  activeMonths: 0,
  lastActivity: null,
  targetProfile: buildTargetProfile(null),
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== 'string') {
    return null
  }

  const compact = value.trim().replaceAll(',', '')
  if (compact === '') {
    return null
  }

  const parsed = Number(compact)
  return Number.isFinite(parsed) ? parsed : null
}

function nonNegative(value: unknown): number {
  const parsed = finiteNumber(value)
  return parsed === null ? 0 : Math.max(0, parsed)
}

function nonNegativeInteger(value: unknown): number {
  return Math.floor(nonNegative(value))
}

function ratio(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed === null ? null : Math.min(100, Math.max(0, parsed))
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }

  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}

function monthKeyToDate(key: string): string | null {
  const match = /^(\d{4})[-/]?(0[1-9]|1[0-2])$/.exec(key.trim())
  if (!match) {
    return null
  }

  return `${match[1]}-${match[2]}-01T00:00:00.000Z`
}

function activityFromMonths(value: unknown): { activeMonths: number; lastActivity: string | null } {
  const monthKeys = Array.isArray(value)
    ? value.flatMap((entry) => {
        if (typeof entry === 'string' || typeof entry === 'number') return [String(entry)]
        const record = asRecord(entry)
        const key = record?.month ?? record?.date
        return typeof key === 'string' || typeof key === 'number' ? [String(key)] : []
      })
    : Object.keys(asRecord(value) ?? {})

  const dates = monthKeys.map(monthKeyToDate).filter((date): date is string => date !== null)
  dates.sort()

  return {
    activeMonths: new Set(dates.map((date) => date.slice(0, 7))).size,
    lastActivity: dates.at(-1) ?? null,
  }
}

/** Convert an untrusted zKillboard stats response into stable application data. */
export function normalizeZkillStats(raw: unknown): PilotStats {
  const source = asRecord(raw)
  if (!source) {
    return { ...EMPTY_STATS }
  }

  const shipsDestroyed = nonNegativeInteger(source.shipsDestroyed)
  const soloKills = nonNegativeInteger(source.soloKills)
  const gangRatio = ratio(source.gangRatio)
  const explicitSoloRatio = ratio(source.soloRatio)
  const inferredSoloRatio =
    gangRatio !== null
      ? 100 - gangRatio
      : shipsDestroyed > 0
        ? Math.min(100, (soloKills / shipsDestroyed) * 100)
        : null
  const monthActivity = activityFromMonths(source.months)
  const explicitActiveMonths = finiteNumber(source.activeMonths)

  return {
    dangerRatio: ratio(source.dangerRatio),
    gangRatio,
    soloRatio: explicitSoloRatio ?? inferredSoloRatio,
    shipsDestroyed,
    shipsLost: nonNegativeInteger(source.shipsLost),
    soloKills,
    iskDestroyed: nonNegative(source.iskDestroyed),
    activeMonths:
      explicitActiveMonths === null
        ? monthActivity.activeMonths
        : Math.floor(Math.max(0, explicitActiveMonths)),
    lastActivity: normalizeDate(source.lastActivity) ?? monthActivity.lastActivity,
    targetProfile: buildTargetProfile(source.groups, shipsDestroyed),
  }
}

function clampScore(score: number): number {
  return Math.round(Math.min(100, Math.max(0, score)))
}

export function threatLevelForScore(score: number, hasStats = true): ThreatLevel {
  if (!hasStats) return 'unknown'
  if (score >= 75) return 'critical'
  if (score >= 55) return 'high'
  if (score >= 30) return 'medium'
  return 'low'
}

function formatInteger(value: number): string {
  return Math.floor(value).toLocaleString('en-US')
}

/**
 * Produce a bounded, explainable estimate. It is triage, not certainty: zKill
 * data is voluntary and can be incomplete.
 */
export function assessThreat(stats: PilotStats | null): ThreatAssessment {
  if (stats === null) {
    return { score: 0, level: 'unknown', reasons: ['No zKillboard data'] }
  }

  const safe = normalizeZkillStats(stats)
  const danger = safe.dangerRatio ?? 0
  const solo = safe.soloRatio ?? 0

  // Logarithms keep veterans from dwarfing newer but dangerous pilots.
  const dangerPoints = danger * 0.45
  const activityPoints = Math.min(25, Math.log10(safe.shipsDestroyed + 1) * 9)
  const soloPoints = Math.min(15, solo * 0.15 + Math.log10(safe.soloKills + 1) * 2)
  const iskPoints = Math.min(10, Math.log10(safe.iskDestroyed / 1_000_000_000 + 1) * 4)
  const experiencePoints = Math.min(5, Math.log10(safe.activeMonths + 1) * 3)
  const score = clampScore(
    dangerPoints + activityPoints + soloPoints + iskPoints + experiencePoints,
  )

  const reasons: string[] = []
  if (danger >= 80) reasons.push(`Danger ratio ${Math.round(danger)}%`)
  else if (danger >= 60) reasons.push(`High danger ratio: ${Math.round(danger)}%`)

  if (safe.shipsDestroyed >= 1_000) {
    reasons.push(`${formatInteger(safe.shipsDestroyed)} ships destroyed`)
  } else if (safe.shipsDestroyed >= 100) {
    reasons.push(`Experienced PvP pilot: ${formatInteger(safe.shipsDestroyed)} kills`)
  }

  if (solo >= 50 && safe.soloKills >= 10) {
    reasons.push(`Strong solo profile: ${Math.round(solo)}%`)
  } else if (safe.soloKills >= 100) {
    reasons.push(`${formatInteger(safe.soloKills)} solo kills`)
  }

  if (safe.iskDestroyed >= 100_000_000_000) {
    reasons.push(`${formatInteger(safe.iskDestroyed / 1_000_000_000)}B ISK destroyed`)
  }

  if (reasons.length === 0) {
    reasons.push(score < 30 ? 'Little confirmed PvP activity' : 'Moderate PvP activity')
  }

  return { score, level: threatLevelForScore(score), reasons: reasons.slice(0, 4) }
}

export const calculateThreat = assessThreat

export function calculateThreatScore(stats: PilotStats | null): number {
  return assessThreat(stats).score
}
