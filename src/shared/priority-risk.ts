import { threatLevelForScore } from './threat-score'
import type { RecentTargetProfileSnapshot, ThreatLevel } from './types'
import type { TargetCategory, TargetProfile } from './target-profile'

export type RiskPriority = 'general' | Exclude<TargetCategory, 'other'>
export type PriorityEvidenceStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface PriorityRiskAssessment {
  category: Exclude<TargetCategory, 'other'>
  score: number
  level: ThreatLevel
  recentMatches: number
  recentSampleSize: number
  recentShare: number
  recentComplete: boolean
  lifetimeMatches: number
  lifetimeTotal: number
  lifetimeShare: number
  confidence: 'full' | 'partial' | 'none'
  reasons: string[]
}

export const RISK_PRIORITY_OPTIONS: ReadonlyArray<{
  value: RiskPriority
  label: string
  targetLabel: string
}> = [
  { value: 'general', label: 'Overall PvP', targetLabel: 'overall threat' },
  { value: 'scanner', label: 'Scanners', targetLabel: 'scanners' },
  { value: 'logistics', label: 'Logistics', targetLabel: 'logistics' },
  { value: 'mining', label: 'Mining', targetLabel: 'miners' },
  { value: 'hauler', label: 'Haulers', targetLabel: 'haulers' },
  { value: 'pve', label: 'PvE', targetLabel: 'PvE ships' },
  { value: 'combat', label: 'Combat', targetLabel: 'combat ships' },
  { value: 'capital', label: 'Capitals', targetLabel: 'capitals' },
  { value: 'structure', label: 'Structures', targetLabel: 'structures' }
]

const VICTIM_LABELS: Record<Exclude<TargetCategory, 'other'>, string> = {
  scanner: 'scanners',
  logistics: 'logistics',
  mining: 'mining ships',
  hauler: 'haulers',
  pve: 'PvE ships',
  combat: 'combat ships',
  capital: 'capitals',
  structure: 'structures'
}

const PRIORITY_VALUES = new Set<RiskPriority>(RISK_PRIORITY_OPTIONS.map(({ value }) => value))

export function isRiskPriority(value: unknown): value is RiskPriority {
  return typeof value === 'string' && PRIORITY_VALUES.has(value as RiskPriority)
}

export function riskPriorityLabel(priority: RiskPriority): string {
  return RISK_PRIORITY_OPTIONS.find(({ value }) => value === priority)?.label ?? 'Overall PvP'
}

export function riskPriorityTargetLabel(priority: RiskPriority): string {
  return RISK_PRIORITY_OPTIONS.find(({ value }) => value === priority)?.targetLabel ?? 'overall threat'
}

export function formatPriorityRiskEvidence(
  assessment: PriorityRiskAssessment,
  status: PriorityEvidenceStatus
): string {
  if (assessment.recentSampleSize > 0) {
    const recent = `${assessment.recentMatches}/${assessment.recentSampleSize} recent`
    return assessment.lifetimeTotal > 0
      ? `${recent} · ${formatPercent(assessment.lifetimeShare)} lifetime`
      : recent
  }
  if (
    assessment.level === 'low' &&
    assessment.lifetimeTotal === 0 &&
    assessment.reasons.some((reason) => reason.includes('No public kills'))
  ) {
    return '0 public kills'
  }
  if (status === 'loading') return 'last 10: loading…'
  if (status === 'error') {
    return assessment.lifetimeMatches > 0
      ? `${formatPercent(assessment.lifetimeShare)} lifetime · history unavailable`
      : 'last 10 unavailable'
  }
  return assessment.lifetimeMatches > 0
    ? `${formatPercent(assessment.lifetimeShare)} lifetime`
    : 'no sample'
}

/**
 * Contextual risk answers "how often does this pilot kill the selected kind of target?".
 * It never treats the attacker's own hull or a loss as selected-target evidence.
 */
export function assessPriorityRisk(input: {
  category: Exclude<TargetCategory, 'other'>
  lifetimeProfile: TargetProfile | null | undefined
  baseThreatScore: number
  recent: RecentTargetProfileSnapshot | null | undefined
  evidenceStatus?: PriorityEvidenceStatus
}): PriorityRiskAssessment {
  const { category, lifetimeProfile, recent } = input
  const evidenceStatus = input.evidenceStatus ?? (recent ? 'ready' : 'idle')
  const lifetimeEntry = lifetimeProfile?.entries.find((entry) => entry.category === category)
  const recentEntry = recent?.profile.entries.find((entry) => entry.category === category)
  const lifetimeTotal = safeCount(lifetimeProfile?.totalKills)
  const lifetimeMatches = Math.min(lifetimeTotal, safeCount(lifetimeEntry?.kills))
  const lifetimeShare = lifetimeTotal === 0 ? 0 : lifetimeMatches / lifetimeTotal
  const recentSampleSize = safeCount(recent?.sampleSize)
  const recentMatches = Math.min(recentSampleSize, safeCount(recentEntry?.kills))
  const recentShare = recentSampleSize === 0 ? 0 : recentMatches / recentSampleSize
  const expectedRecent = lifetimeTotal > 0
    ? Math.min(10, lifetimeTotal)
    : safeCount(recent?.requestedSampleSize)
  const recentComplete = Boolean(
    recent?.complete &&
    recentSampleSize === safeCount(recent.requestedSampleSize) &&
    recentSampleSize >= expectedRecent
  )
  const hasLifetimeEvidence = lifetimeTotal > 0
  const hasRecentEvidence = recentSampleSize > 0
  const lifetimeCritical = lifetimeMatches >= 20 && lifetimeShare >= 0.2
  const lifetimeHigh = lifetimeMatches >= 10 && lifetimeShare >= 0.1
  const lifetimeMedium = lifetimeMatches >= 5 && lifetimeShare >= 0.05

  const hasLifetimeProfile = lifetimeProfile !== null && lifetimeProfile !== undefined

  if (!hasRecentEvidence && !hasLifetimeEvidence && hasLifetimeProfile) {
    return {
      category,
      score: 0,
      level: 'low',
      recentMatches: 0,
      recentSampleSize: 0,
      recentShare: 0,
      recentComplete: Boolean(recent?.complete),
      lifetimeMatches: 0,
      lifetimeTotal: 0,
      lifetimeShare: 0,
      confidence: 'partial',
      reasons: ['No public kills — selected specialty is not confirmed']
    }
  }

  if (!hasRecentEvidence && !hasLifetimeEvidence) {
    return unknownAssessment(category, evidenceStatus === 'error'
      ? 'Recent kills unavailable; overall statistics are also unavailable'
      : evidenceStatus === 'loading'
        ? 'Loading last 10 public kills'
        : 'No public kill sample')
  }

  if (!hasRecentEvidence && !lifetimeMedium && !(hasLifetimeProfile && lifetimeTotal < 10)) {
    return unknownAssessment(category, evidenceStatus === 'error'
      ? 'Recent kills unavailable — zero risk is not assumed'
      : 'Loading last 10 public kills')
  }

  const baseThreat = clamp(Number.isFinite(input.baseThreatScore) ? input.baseThreatScore : 0, 0, 100)
  let score = Math.round(100 * (
    0.65 * recentShare +
    0.25 * lifetimeShare +
    0.1 * (baseThreat / 100)
  ))

  const recentCritical =
    recentSampleSize >= 5 && recentMatches >= 3 && recentShare >= 0.3
  const recentHigh =
    recentSampleSize >= 5 && recentMatches >= 2 && recentShare >= 0.2
  const recentMedium = recentMatches >= 1

  if (recentCritical || lifetimeCritical) score = Math.max(score, 75)
  else if (recentHigh || lifetimeHigh) score = Math.max(score, 55)
  else if (recentMedium || lifetimeMedium) score = Math.max(score, 30)

  const observedKillCount = Math.max(lifetimeTotal, recentSampleSize)
  if (observedKillCount < 10) score = Math.min(score, 29)
  else if (observedKillCount < 25) score = Math.min(score, 74)
  if (!recentComplete && recentCritical && !lifetimeCritical) score = Math.min(score, 74)

  if (recentComplete && recentSampleSize > 0 && recentMatches === 0 && !lifetimeCritical) {
    score = Math.min(score, 29)
  }

  if (!recentComplete && hasRecentEvidence && recentMatches === 0 && !lifetimeMedium) {
    return unknownAssessment(
      category,
      'Latest sample is incomplete — absence of selected targets is not confirmed',
      {
        recentSampleSize,
        recentComplete,
        lifetimeMatches,
        lifetimeTotal,
        lifetimeShare
      }
    )
  }

  score = Math.round(clamp(score, 0, 100))
  const reasons: string[] = []
  const victimLabel = VICTIM_LABELS[category]

  if (hasRecentEvidence) {
    reasons.push(recentMatches === 0
      ? `0 of ${recentSampleSize} recent kills — no ${victimLabel}`
      : `${recentMatches} of ${recentSampleSize} recent kills — ${victimLabel}`)
  } else {
    reasons.push('Recent kills not loaded yet; specialty assessment')
  }
  if (hasLifetimeEvidence) {
    reasons.push(
      `${lifetimeMatches} of ${lifetimeTotal} lifetime (${formatPercent(lifetimeShare)}) — ${victimLabel}`
    )
  }
  if (observedKillCount < 10) {
    reasons.push(`Few confirmed kills: ${observedKillCount}`)
  }
  if (!recentComplete && hasRecentEvidence) {
    reasons.push('Latest sample is incomplete — critical level is limited by it')
  }
  if (lifetimeCritical) reasons.push(`Consistent specialty in destroying ${victimLabel}`)

  return {
    category,
    score,
    level: threatLevelForScore(score),
    recentMatches,
    recentSampleSize,
    recentShare,
    recentComplete,
    lifetimeMatches,
    lifetimeTotal,
    lifetimeShare,
    confidence: recentComplete ? 'full' : 'partial',
    reasons: reasons.slice(0, 4)
  }
}

function unknownAssessment(
  category: Exclude<TargetCategory, 'other'>,
  reason: string,
  partial: Partial<Pick<
    PriorityRiskAssessment,
    'recentSampleSize' | 'recentComplete' | 'lifetimeMatches' | 'lifetimeTotal' | 'lifetimeShare'
  >> = {}
): PriorityRiskAssessment {
  return {
    category,
    score: 0,
    level: 'unknown',
    recentMatches: 0,
    recentSampleSize: partial.recentSampleSize ?? 0,
    recentShare: 0,
    recentComplete: partial.recentComplete ?? false,
    lifetimeMatches: partial.lifetimeMatches ?? 0,
    lifetimeTotal: partial.lifetimeTotal ?? 0,
    lifetimeShare: partial.lifetimeShare ?? 0,
    confidence: partial.recentSampleSize || partial.lifetimeTotal ? 'partial' : 'none',
    reasons: [reason]
  }
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function formatPercent(value: number): string {
  const percent = clamp(value, 0, 1) * 100
  if (percent > 0 && percent < 1) {
    return `${percent.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
  }
  return `${Math.round(percent)}%`
}
