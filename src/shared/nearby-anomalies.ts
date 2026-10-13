import type { ProbeRow } from './clipboard-intel'

export const MAX_NEARBY_ANOMALY_JUMPS = 2
export const MAX_NEARBY_ANOMALY_SYSTEMS = 96
export const MAX_ANOMALY_SITE_SUMMARIES = 8

export type AnomalyObservationFreshness = 'fresh' | 'recent' | 'stale' | 'unseen'

export interface ProbeScanRecordRequest {
  solarSystemId: number
  systemName: string
  rawProbeText: string
  observedAt: string
}

export interface AnomalySiteSummary {
  name: string
  count: number
}

export interface ProbeSystemObservation {
  solarSystemId: number
  systemName: string
  anomalyCount: number
  signatureCount: number
  rowCount: number
  rejectedCount: number
  sites: AnomalySiteSummary[]
  observedAt: string
}

export interface NearbyAnomalyRequest {
  originSystemId: number
  maxJumps?: number
}

export interface NearbyAnomalySystem {
  solarSystemId: number
  systemName: string
  securityStatus: number | null
  jumps: number
  pathSystemIds: number[]
  anomalyCount: number | null
  signatureCount: number | null
  sites: AnomalySiteSummary[]
  observedAt: string | null
  ageMinutes: number | null
  freshness: AnomalyObservationFreshness
}

export interface NearbyAnomalySnapshot {
  originSystemId: number
  maxJumps: number
  generatedAt: string
  systems: NearbyAnomalySystem[]
  coverage: {
    checkedReports: number
    nearbyReports: number
  }
  warnings: string[]
}

export function validateProbeScanRecordRequest(value: unknown): ProbeScanRecordRequest {
  if (!isRecord(value)) throw new TypeError('Invalid Probe Scanner snapshot')
  assertExactKeys(value, ['solarSystemId', 'systemName', 'rawProbeText', 'observedAt'])

  const solarSystemId = positiveId(value.solarSystemId, 'solar system')
  const systemName = boundedText(value.systemName, 128, 'system name')
  const rawProbeText = boundedText(value.rawProbeText, 250_000, 'Probe Scanner')
  const observedAt = isoTimestamp(value.observedAt, 'snapshot time')

  return { solarSystemId, systemName, rawProbeText, observedAt }
}

export function validateNearbyAnomalyRequest(value: unknown): Required<NearbyAnomalyRequest> {
  if (!isRecord(value)) throw new TypeError('Invalid nearby-anomaly request')
  assertExactKeys(value, ['originSystemId', 'maxJumps'])
  const originSystemId = positiveId(value.originSystemId, 'origin system')
  const maxJumps = value.maxJumps === undefined ? MAX_NEARBY_ANOMALY_JUMPS : value.maxJumps
  if (!Number.isSafeInteger(maxJumps) || (maxJumps as number) < 1 ||
      (maxJumps as number) > MAX_NEARBY_ANOMALY_JUMPS) {
    throw new RangeError(`Radius must be from 1 to ${MAX_NEARBY_ANOMALY_JUMPS} jumps`)
  }
  return { originSystemId, maxJumps: maxJumps as number }
}

export function summarizeProbeScan(
  solarSystemId: number,
  systemName: string,
  rows: readonly ProbeRow[],
  rejectedCount: number,
  observedAt: string
): ProbeSystemObservation {
  positiveId(solarSystemId, 'solar system')
  const normalizedName = boundedText(systemName, 128, 'system name')
  const normalizedObservedAt = isoTimestamp(observedAt, 'snapshot time')
  if (!Number.isSafeInteger(rejectedCount) || rejectedCount < 0) {
    throw new TypeError('Invalid skipped Probe Scanner row count')
  }

  const anomalyRows = rows.filter((row) => row.kind === 'anomaly')
  const siteCounts = new Map<string, number>()
  for (const row of anomalyRows) {
    const name = cleanSiteName(row.name ?? row.type ?? 'Not identified')
    siteCounts.set(name, (siteCounts.get(name) ?? 0) + 1)
  }
  const sites = [...siteCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'en'))
    .slice(0, MAX_ANOMALY_SITE_SUMMARIES)

  return {
    solarSystemId,
    systemName: normalizedName,
    anomalyCount: anomalyRows.length,
    signatureCount: rows.filter((row) => row.kind === 'signature').length,
    rowCount: rows.length,
    rejectedCount,
    sites,
    observedAt: normalizedObservedAt
  }
}

export function anomalyObservationFreshness(ageMinutes: number | null): AnomalyObservationFreshness {
  if (ageMinutes === null) return 'unseen'
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) {
    throw new TypeError('Invalid anomaly-snapshot age')
  }
  if (ageMinutes <= 20) return 'fresh'
  if (ageMinutes <= 60) return 'recent'
  return 'stale'
}

export function rankNearbyAnomalySystems(
  systems: readonly NearbyAnomalySystem[]
): NearbyAnomalySystem[] {
  return [...systems].sort((left, right) => {
    if (left.jumps === 0 || right.jumps === 0) return left.jumps === 0 ? -1 : 1
    const leftObserved = left.anomalyCount !== null
    const rightObserved = right.anomalyCount !== null
    if (leftObserved !== rightObserved) return leftObserved ? -1 : 1
    return (right.anomalyCount ?? -1) - (left.anomalyCount ?? -1) ||
      freshnessRank(left.freshness) - freshnessRank(right.freshness) ||
      left.jumps - right.jumps ||
      left.systemName.localeCompare(right.systemName, 'en-US')
  })
}

function freshnessRank(value: AnomalyObservationFreshness): number {
  return value === 'fresh' ? 0 : value === 'recent' ? 1 : value === 'stale' ? 2 : 3
}

function cleanSiteName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized.slice(0, 160) || 'Not identified'
}

function boundedText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid ${label}`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`Invalid ${label}`)
  }
  return normalized
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid ${label}`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new TypeError(`Invalid ${label}`)
  return new Date(timestamp).toISOString()
}

function positiveId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`Invalid ${label} ID`)
  }
  return value as number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed)
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new TypeError('Request contains unknown fields')
  }
}
