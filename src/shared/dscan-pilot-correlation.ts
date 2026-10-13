import {
  normalizeDscanTypeName,
  type DscanHullComposition
} from './dscan-intelligence'
import type {
  SystemObservedShip,
  SystemObservedShipOccurrence,
  SystemZkillHistory
} from './system-intel'

export type DscanCandidateStrength = 'strong' | 'medium' | 'weak'
export type DscanHistoryMatchKind = 'type-id' | 'type-name'

export interface DscanPilotCandidate {
  characterId: number
  name: string | null
  strength: DscanCandidateStrength
  evidenceAt: string
  /** Signed offset from clipboard capture: negative is before, positive is after. */
  timeOffsetMs: number
  timeDistanceMs: number
  killmailId: number
  finalBlow: boolean
  victimCharacterId: number | null
  victimName: string | null
  victimShipTypeId: number
  victimShipName: string | null
  totalValue: number | null
  matchingKillmailCount: number
}

export interface DscanHullPilotMatch {
  dscanKey: string
  typeId: number | null
  typeName: string | null
  dscanCount: number
  historyShipName: string | null
  matchKind: DscanHistoryMatchKind
  candidates: DscanPilotCandidate[]
  candidatesCapped: boolean
}

export type DscanCorrelationStatus = 'ready' | 'no-system' | 'system-changed' | 'no-history'

export interface DscanPilotCorrelation {
  status: DscanCorrelationStatus
  matches: DscanHullPilotMatch[]
  unmatchedHullCount: number
  incomplete: boolean
}

export interface DscanCorrelationOptions {
  capturedSystemId: number | null
  historySystemId: number | null
  /** Exact local time at which the player copied the D-scan. */
  capturedAt?: string | number | Date
  /** @deprecated Compatibility alias for older callers. */
  now?: number | Date
}

export const DSCAN_KILLMAIL_TIME_WINDOW_MS = 6 * 60 * 60 * 1_000
const FUTURE_KILLMAIL_TOLERANCE_MS = 5 * 60 * 1_000
const STRONG_TIME_WINDOW_MS = 15 * 60 * 1_000
const MEDIUM_TIME_WINDOW_MS = 2 * 60 * 60 * 1_000

const STRENGTH_RANK: Record<DscanCandidateStrength, number> = {
  strong: 3,
  medium: 2,
  weak: 1
}

/**
 * Match D-scan hulls to exact public killmail participations from the same system.
 * Only attacker occurrences from six hours before to five minutes after capture are candidates:
 * victim occurrences describe an already destroyed hull. This never asserts identity.
 */
export function correlateDscanPilots(
  hulls: readonly DscanHullComposition[],
  history: SystemZkillHistory | null | undefined,
  options: DscanCorrelationOptions
): DscanPilotCorrelation {
  const capturedSystemId = positiveInteger(options.capturedSystemId)
  const historySystemId = positiveInteger(options.historySystemId)
  if (capturedSystemId === null || historySystemId === null) {
    return emptyCorrelation('no-system')
  }
  if (capturedSystemId !== historySystemId) {
    return emptyCorrelation('system-changed')
  }
  if (!history) return emptyCorrelation('no-history')

  const capturedAtMs = timestamp(options.capturedAt ?? options.now) ?? Date.now()
  const shipsByTypeId = new Map(history.observedShips.map((ship) => [ship.typeId, ship]))
  const shipsByName = new Map<string, SystemObservedShip>()
  for (const ship of history.observedShips) {
    const normalized = normalizeDscanTypeName(ship.name)
    if (normalized && !shipsByName.has(normalized)) shipsByName.set(normalized, ship)
  }

  const matches: DscanHullPilotMatch[] = []
  let unmatchedHullCount = 0
  let nestedCandidatesCapped = false

  for (const hull of hulls) {
    let ship: SystemObservedShip | undefined
    let matchKind: DscanHistoryMatchKind = 'type-id'
    if (hull.typeId !== null) {
      ship = shipsByTypeId.get(hull.typeId)
    } else {
      const normalized = normalizeDscanTypeName(hull.typeName)
      if (normalized) ship = shipsByName.get(normalized)
      matchKind = 'type-name'
    }

    const candidates = ship
      ? candidatesFromOccurrences(ship.occurrences, matchKind, capturedSystemId, capturedAtMs)
      : []
    if (!ship || candidates.length === 0) {
      unmatchedHullCount += 1
      continue
    }

    nestedCandidatesCapped ||= ship.occurrencesCapped
    matches.push({
      dscanKey: hull.key,
      typeId: hull.typeId,
      typeName: hull.typeName,
      dscanCount: hull.count,
      historyShipName: ship.name,
      matchKind,
      candidates,
      candidatesCapped: ship.occurrencesCapped
    })
  }

  matches.sort(compareHullMatches)
  return {
    status: 'ready',
    matches,
    unmatchedHullCount,
    incomplete:
      history.sourceCapped ||
      history.observedShipsCapped ||
      nestedCandidatesCapped
  }
}

function candidatesFromOccurrences(
  occurrences: readonly SystemObservedShipOccurrence[],
  matchKind: DscanHistoryMatchKind,
  capturedSystemId: number,
  capturedAtMs: number
): DscanPilotCandidate[] {
  const byPilot = new Map<number, { nearest: SystemObservedShipOccurrence; offsetMs: number; count: number }>()

  for (const occurrence of occurrences) {
    if (occurrence.role !== 'attacker' || occurrence.solarSystemId !== capturedSystemId) continue
    const occurrenceMs = timestamp(occurrence.time)
    if (occurrenceMs === null) continue
    const offsetMs = occurrenceMs - capturedAtMs
    if (
      offsetMs < -DSCAN_KILLMAIL_TIME_WINDOW_MS ||
      offsetMs > FUTURE_KILLMAIL_TOLERANCE_MS
    ) continue

    const current = byPilot.get(occurrence.pilotCharacterId)
    if (!current) {
      byPilot.set(occurrence.pilotCharacterId, { nearest: occurrence, offsetMs, count: 1 })
      continue
    }

    current.count += 1
    const currentDistance = Math.abs(current.offsetMs)
    const nextDistance = Math.abs(offsetMs)
    if (
      nextDistance < currentDistance ||
      (nextDistance === currentDistance && occurrence.killmailId > current.nearest.killmailId)
    ) {
      current.nearest = occurrence
      current.offsetMs = offsetMs
    }
  }

  const values = [...byPilot.values()]
  const nearPilotCount = values.filter(
    ({ offsetMs }) => Math.abs(offsetMs) <= STRONG_TIME_WINDOW_MS
  ).length

  return values
    .map(({ nearest, offsetMs, count }): DscanPilotCandidate => {
      const distanceMs = Math.abs(offsetMs)
      const strength: DscanCandidateStrength = matchKind !== 'type-id'
        ? 'weak'
        : distanceMs <= STRONG_TIME_WINDOW_MS && nearPilotCount === 1
          ? 'strong'
          : distanceMs <= MEDIUM_TIME_WINDOW_MS
            ? 'medium'
            : 'weak'
      return {
        characterId: nearest.pilotCharacterId,
        name: nearest.pilotName,
        strength,
        evidenceAt: nearest.time,
        timeOffsetMs: offsetMs,
        timeDistanceMs: distanceMs,
        killmailId: nearest.killmailId,
        finalBlow: nearest.finalBlow,
        victimCharacterId: nearest.victimCharacterId,
        victimName: nearest.victimName,
        victimShipTypeId: nearest.victimShipTypeId,
        victimShipName: nearest.victimShipName,
        totalValue: nearest.totalValue,
        matchingKillmailCount: count
      }
    })
    .sort(compareCandidates)
}

function compareCandidates(left: DscanPilotCandidate, right: DscanPilotCandidate): number {
  return (
    left.timeDistanceMs - right.timeDistanceMs ||
    STRENGTH_RANK[right.strength] - STRENGTH_RANK[left.strength] ||
    Number(right.finalBlow) - Number(left.finalBlow) ||
    Date.parse(right.evidenceAt) - Date.parse(left.evidenceAt) ||
    right.matchingKillmailCount - left.matchingKillmailCount ||
    (left.name ?? '').localeCompare(right.name ?? '', 'en-US') ||
    left.characterId - right.characterId
  )
}

function compareHullMatches(left: DscanHullPilotMatch, right: DscanHullPilotMatch): number {
  const leftBest = left.candidates[0]
  const rightBest = right.candidates[0]
  return (
    leftBest.timeDistanceMs - rightBest.timeDistanceMs ||
    STRENGTH_RANK[rightBest.strength] - STRENGTH_RANK[leftBest.strength] ||
    right.dscanCount - left.dscanCount ||
    (left.historyShipName ?? left.typeName ?? '').localeCompare(
      right.historyShipName ?? right.typeName ?? '',
      'en-US'
    )
  )
}

function emptyCorrelation(status: Exclude<DscanCorrelationStatus, 'ready'>): DscanPilotCorrelation {
  return { status, matches: [], unmatchedHullCount: 0, incomplete: false }
}

function timestamp(value: unknown): number | null {
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}
