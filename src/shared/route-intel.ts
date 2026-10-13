export const ROUTE_MODES = ['shortest', 'secure', 'insecure'] as const
export const MAX_ROUTE_SYSTEMS = 256

export type RouteMode = (typeof ROUTE_MODES)[number]
export type RouteEndpointInput = string | number
export type RouteRiskLevel = 'low' | 'guarded' | 'high' | 'critical' | 'unknown'
export type RouteEvidenceConfidence = 'high' | 'medium' | 'low'
export type RouteCampPattern = 'none' | 'possible' | 'strong' | 'unknown'
export type RouteKillmailFreshness = 'hot' | 'recent' | 'aging' | 'stale' | 'none' | 'unknown'

export interface RouteHaulingFeesInput {
  /** Fraction from 0 to 1, for example 0.036 for 3.6%. */
  rate?: number
  /** ISK amount to which `rate` is applied. Required when rate is greater than zero. */
  basisIsk?: number
  fixedIsk?: number
}

export interface RouteHaulingInput {
  /** Destination revenue minus origin acquisition cost, before fees and hauling costs. */
  marketDeltaIsk: number
  cargoM3: number
  fees?: RouteHaulingFeesInput
  haulingCostIsk?: number
}

export interface RouteIntelRequest {
  origin: RouteEndpointInput
  destination: RouteEndpointInput
  mode?: RouteMode
  forceRefresh?: boolean
  includeRecentPublicKillmails?: boolean
  hauling?: RouteHaulingInput
}

export interface RouteWaypointRequest {
  /** Ordered route systems excluding the pilot's current/origin system. */
  destinationIds: number[]
}

export interface RouteWaypointResult {
  destinationIds: number[]
  waypointsSet: number
}

export interface NormalizedRouteEndpoint {
  kind: 'id' | 'name'
  value: number | string
}

export interface ValidatedRouteIntelRequest {
  origin: NormalizedRouteEndpoint
  destination: NormalizedRouteEndpoint
  mode: RouteMode
  forceRefresh: boolean
  includeRecentPublicKillmails: boolean
  hauling: RouteHaulingInput | null
}

export interface ResolvedRouteEndpoint {
  id: number
  name: string | null
  input: RouteEndpointInput
}

export interface RouteSystemMetadataSource {
  id: number
  name: string
  securityStatus: number
  isWormhole?: boolean
  cached?: boolean
}

export interface RouteSystemKillRow {
  solarSystemId: number
  shipKills: number
  podKills: number
}

export interface RouteSystemJumpRow {
  solarSystemId: number
  jumps: number
}

export interface RouteRowsSnapshot<T> {
  rows: readonly T[]
  /** Time supplied by the adapter. Null/omitted means the upstream sample time is unknown. */
  fetchedAt?: string | null
  cached?: boolean
}

export interface RoutePathSnapshot {
  systemIds: readonly number[]
  fetchedAt?: string | null
  cached?: boolean
}

export interface RouteRecentPublicKillmailSnapshot {
  count: number | null
  windowHours: number
  /** Killmails whose occurrence time is within the last hour. */
  lastHourCount?: number | null
  /** True when only the newest compact zKill reference was ESI-hydrated. */
  lastHourCountLowerBound?: boolean
  /** Occurrence time of the newest parsed killmail, not its upload/fetch time. */
  latestAt?: string | null
  fetchedAt?: string | null
  cached?: boolean
  capped?: boolean
  warnings?: readonly string[]
}

export interface RouteRiskInput {
  securityStatus: number | null
  isWormhole: boolean
  shipKills: number | null
  podKills: number | null
  jumps: number | null
  recentPublicKillmails: number | null
  recentKillmailWindowHours: number | null
  recentPublicKillmailsLastHour?: number | null
  recentPublicKillmailsLastHourLowerBound?: boolean
  latestPublicKillmailAgeMinutes?: number | null
}

export type RouteRiskFactorCode =
  | 'security-status'
  | 'ship-kills'
  | 'pod-kills'
  | 'loss-density'
  | 'recent-public-killmails'
  | 'fresh-public-killmail'

export interface RouteRiskFactor {
  code: RouteRiskFactorCode
  points: number
  reason: string
}

export type RouteCampIndicatorCode =
  | 'ship-and-pod-losses'
  | 'pod-kill-cluster'
  | 'loss-density'
  | 'losses-without-reported-traffic'
  | 'public-killmail-cluster'
  | 'fresh-public-killmail'

export interface RouteCampIndicator {
  code: RouteCampIndicatorCode
  severity: 'notice' | 'elevated' | 'strong'
  evidence: string
  /** This is a historical pattern, not proof of a currently active camp. */
  temporal: 'historical'
}

export interface RouteSystemRiskAssessment {
  score: number
  level: RouteRiskLevel
  confidence: RouteEvidenceConfidence
  factors: RouteRiskFactor[]
  campPattern: RouteCampPattern
  campIndicators: RouteCampIndicator[]
  limitations: string[]
}

export interface RouteSystemActivityEvidence {
  shipKills: number | null
  podKills: number | null
  jumps: number | null
  recentPublicKillmails: number | null
  recentKillmailWindowHours: number | null
  recentPublicKillmailsLastHour: number | null
  recentPublicKillmailsLastHourLowerBound?: boolean
  latestPublicKillmailAt: string | null
  latestPublicKillmailAgeMinutes: number | null
  killmailFreshness: RouteKillmailFreshness
  /** False means this system was intentionally skipped to protect upstream rate limits. */
  recentIntelChecked: boolean
  /** When this service received the aggregate snapshot from its adapter. */
  aggregateRetrievedAt: string | null
  /** Upstream/cache timestamp supplied by the aggregate adapter, when known. */
  killsSourceAt: string | null
  jumpsSourceAt: string | null
  recentIntelSourceAt: string | null
  aggregateCached: boolean | null
  recentIntelCached: boolean | null
  access: 'public'
  temporal: 'historical'
}

export interface RouteSystemIntel {
  index: number
  systemId: number
  name: string | null
  securityStatus: number | null
  isWormhole: boolean
  activity: RouteSystemActivityEvidence
  risk: RouteSystemRiskAssessment
  warnings: string[]
}

export interface RouteIntelSummary {
  systems: number
  jumps: number
  averageRiskScore: number
  maximumRiskScore: number
  highestRiskSystemId: number | null
  highRiskSystems: number
  campPatternSystems: number
  incompleteSystems: number
  recentIntelSystemsChecked: number
  freshKillmailSystems: number
  hotKillmailSystems: number
  confidence: RouteEvidenceConfidence
}

export interface RouteCorridorKillmailAlert {
  systemId: number
  systemName: string | null
  systemIndex: number
  latestAt: string
  ageMinutes: number
  lastHourCount: number
  lastHourCountLowerBound?: boolean
  freshness: Extract<RouteKillmailFreshness, 'hot' | 'recent' | 'aging'>
  severity: 'critical' | 'warning' | 'notice'
  /** A recent public killmail is an observation, never proof of a live gate camp. */
  temporal: 'reported-killmail'
}

export interface RouteHaulingEstimate {
  grossMarketDeltaIsk: number
  percentageFeesIsk: number
  fixedFeesIsk: number
  haulingCostIsk: number
  totalCostsIsk: number
  netProfitIsk: number
  breakEvenMarketDeltaIsk: number
  netProfitPerM3: number
  netProfitPerJump: number | null
  cargoM3: number
  profitable: boolean
  assumptions: string[]
}

export interface RouteIntelResult {
  request: {
    origin: ResolvedRouteEndpoint
    destination: ResolvedRouteEndpoint
    mode: RouteMode
  }
  systems: RouteSystemIntel[]
  summary: RouteIntelSummary
  corridorAlerts: RouteCorridorKillmailAlert[]
  hauling: RouteHaulingEstimate | null
  evaluatedAt: string
  confidence: RouteEvidenceConfidence
  warnings: string[]
  sourceTimestamps: {
    route: string | null
    systemKills: string | null
    systemJumps: string | null
  }
  sourceCache: {
    route: boolean | null
    systemKills: boolean | null
    systemJumps: boolean | null
  }
  provenance: {
    route: 'public-planning'
    activity: 'public-historical-aggregate'
    recentKillmails: 'optional-public-historical'
    liveCampDetection: false
  }
}

const NOT_LIVE_LIMITATION =
  'Risk and camp indicators use public historical aggregates and do not confirm a live camp.'

export function validateRouteIntelRequest(request: RouteIntelRequest): ValidatedRouteIntelRequest {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Route request is missing')
  }

  const mode = request.mode ?? 'shortest'
  if (!ROUTE_MODES.includes(mode)) {
    throw new TypeError('Route mode must be shortest, secure, or insecure')
  }

  return {
    origin: normalizeEndpoint(request.origin, 'Origin system'),
    destination: normalizeEndpoint(request.destination, 'Destination system'),
    mode,
    forceRefresh: request.forceRefresh === true,
    includeRecentPublicKillmails: request.includeRecentPublicKillmails !== false,
    hauling: request.hauling ? validateHaulingInput(request.hauling) : null
  }
}

export function validateRouteWaypointRequest(request: RouteWaypointRequest): RouteWaypointRequest {
  if (!request || typeof request !== 'object' || !Array.isArray(request.destinationIds) ||
      request.destinationIds.length === 0) {
    throw new TypeError('Autopilot route must contain at least one system')
  }
  const unknownKeys = Object.keys(request).filter((key) => key !== 'destinationIds')
  if (unknownKeys.length > 0) {
    throw new TypeError(`Autopilot route contains unknown fields: ${unknownKeys.join(', ')}`)
  }
  if (request.destinationIds.length > 256) {
    throw new RangeError('Autopilot route cannot contain more than 256 waypoints')
  }
  const destinationIds: number[] = []
  for (const systemId of request.destinationIds) {
    assertPositiveId(systemId, 'Autopilot system')
    if (destinationIds.at(-1) !== systemId) destinationIds.push(systemId)
  }
  return { destinationIds }
}

export function validateRouteSystemIds(
  systemIds: readonly number[],
  originId: number,
  destinationId: number
): number[] {
  assertPositiveId(originId, 'origin system')
  assertPositiveId(destinationId, 'destination system')
  if (!Array.isArray(systemIds) || systemIds.length === 0) {
    throw new TypeError('Route source returned an empty path')
  }
  if (systemIds.length > MAX_ROUTE_SYSTEMS) {
    throw new RangeError(`Route source returned more than ${MAX_ROUTE_SYSTEMS} systems`)
  }
  const normalized: number[] = []
  const seen = new Set<number>()
  for (let index = 0; index < systemIds.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(systemIds, index)) {
      throw new TypeError('Route source returned a path with empty entries')
    }
    const systemId = systemIds[index]
    assertPositiveId(systemId, 'route system ID')
    if (seen.has(systemId)) {
      throw new TypeError('Route source returned a path with duplicate systems')
    }
    seen.add(systemId)
    normalized.push(systemId)
  }
  if (normalized[0] !== originId || normalized.at(-1) !== destinationId) {
    throw new TypeError('Route source returned a path with different endpoints')
  }
  return normalized
}

/**
 * Explainable heuristic over public historical evidence. It intentionally does
 * not claim that a gate camp is active at the time of viewing.
 */
export function assessRouteSystemRisk(input: RouteRiskInput): RouteSystemRiskAssessment {
  validateRiskInput(input)
  const factors: RouteRiskFactor[] = []

  if (input.securityStatus !== null) {
    const points = securityRiskPoints(input.securityStatus, input.isWormhole)
    if (points > 0) {
      factors.push({
        code: 'security-status',
        points,
        reason: input.isWormhole
          ? 'No CONCORD or Local pilot list in wormhole space'
          : `Security status ${formatSecurity(input.securityStatus)}`
      })
    }
  }

  if (input.shipKills !== null && input.shipKills > 0) {
    factors.push({
      code: 'ship-kills',
      points: Math.min(24, 4 + input.shipKills * 4),
      reason: `Ships destroyed in public hourly aggregate: ${input.shipKills}`
    })
  }
  if (input.podKills !== null && input.podKills > 0) {
    factors.push({
      code: 'pod-kills',
      points: Math.min(20, 6 + input.podKills * 6),
      reason: `Pods destroyed in public hourly aggregate: ${input.podKills}`
    })
  }

  const reportedLosses = addKnown(input.shipKills, input.podKills)
  if (reportedLosses !== null && reportedLosses > 0 && input.jumps !== null) {
    const density = input.jumps === 0 ? 1 : reportedLosses / input.jumps
    const points = Math.min(18, Math.max(0, Math.round(density * 300)))
    if (points > 0) {
      factors.push({
        code: 'loss-density',
        points,
        reason: input.jumps === 0
          ? 'Losses recorded with a zero public jump count'
          : `Losses per jump: ${(density * 100).toFixed(1)}%`
      })
    }
  }

  if (input.recentPublicKillmails !== null && input.recentPublicKillmails > 0) {
    const window = input.recentKillmailWindowHours ?? 24
    factors.push({
      code: 'recent-public-killmails',
      points: Math.min(15, Math.round(Math.log2(input.recentPublicKillmails + 1) * 4)),
      reason: `Public killmails in ${formatHours(window)}: ${input.recentPublicKillmails}`
    })
  }

  const freshCount = input.recentPublicKillmailsLastHour ?? null
  if (freshCount !== null && freshCount > 0) {
    const age = input.latestPublicKillmailAgeMinutes
    const countText = `${input.recentPublicKillmailsLastHourLowerBound ? '≥' : ''}${freshCount}`
    factors.push({
      code: 'fresh-public-killmail',
      points: Math.min(24, 8 + freshCount * 4 + (age !== null && age !== undefined && age <= 15 ? 4 : 0)),
      reason: age === null || age === undefined
        ? `Killmails in the last hour: ${countText}`
        : `Killmails in the last hour: ${countText}; latest ${formatAgeMinutes(age)} ago`
    })
  }

  const score = Math.min(100, factors.reduce((sum, factor) => sum + factor.points, 0))
  const hasScoringEvidence = input.securityStatus !== null ||
    input.shipKills !== null ||
    input.podKills !== null ||
    input.recentPublicKillmails !== null
  const confidence = riskConfidence(input)
  const campIndicators = detectCampIndicators(input)
  const campPattern = campPatternFromIndicators(input, campIndicators)

  return {
    score,
    level: hasScoringEvidence ? riskLevelForScore(score) : 'unknown',
    confidence,
    factors,
    campPattern,
    campIndicators,
    limitations: [NOT_LIVE_LIMITATION]
  }
}

export function summarizeRoute(systems: readonly RouteSystemIntel[]): RouteIntelSummary {
  if (systems.length === 0) {
    return {
      systems: 0,
      jumps: 0,
      averageRiskScore: 0,
      maximumRiskScore: 0,
      highestRiskSystemId: null,
      highRiskSystems: 0,
      campPatternSystems: 0,
      incompleteSystems: 0,
      recentIntelSystemsChecked: 0,
      freshKillmailSystems: 0,
      hotKillmailSystems: 0,
      confidence: 'low'
    }
  }

  const ranked = [...systems].sort((left, right) =>
    right.risk.score - left.risk.score || left.index - right.index
  )
  const incompleteSystems = systems.filter((system) => system.risk.confidence === 'low').length
  const highConfidence = systems.filter((system) => system.risk.confidence === 'high').length

  return {
    systems: systems.length,
    jumps: Math.max(0, systems.length - 1),
    averageRiskScore: Math.round(
      systems.reduce((sum, system) => sum + system.risk.score, 0) / systems.length
    ),
    maximumRiskScore: ranked[0]?.risk.score ?? 0,
    highestRiskSystemId: ranked[0]?.systemId ?? null,
    highRiskSystems: systems.filter((system) =>
      system.risk.level === 'high' || system.risk.level === 'critical'
    ).length,
    campPatternSystems: systems.filter((system) =>
      system.risk.campPattern === 'possible' || system.risk.campPattern === 'strong'
    ).length,
    incompleteSystems,
    recentIntelSystemsChecked: systems.filter((system) => system.activity.recentIntelChecked).length,
    freshKillmailSystems: systems.filter((system) =>
      system.activity.killmailFreshness === 'hot' || system.activity.killmailFreshness === 'recent'
    ).length,
    hotKillmailSystems: systems.filter((system) => system.activity.killmailFreshness === 'hot').length,
    confidence: incompleteSystems > Math.floor(systems.length / 2)
      ? 'low'
      : highConfidence === systems.length
        ? 'high'
        : 'medium'
  }
}

export function classifyRouteKillmailFreshness(
  latestAt: string | null,
  evaluatedAt: string
): { freshness: RouteKillmailFreshness; ageMinutes: number | null } {
  if (latestAt === null) return { freshness: 'none', ageMinutes: null }
  const latestMs = Date.parse(latestAt)
  const evaluatedMs = Date.parse(evaluatedAt)
  if (!Number.isFinite(latestMs) || !Number.isFinite(evaluatedMs)) {
    return { freshness: 'unknown', ageMinutes: null }
  }
  const ageMinutes = Math.max(0, Math.floor((evaluatedMs - latestMs) / 60_000))
  if (ageMinutes <= 15) return { freshness: 'hot', ageMinutes }
  if (ageMinutes <= 60) return { freshness: 'recent', ageMinutes }
  if (ageMinutes <= 360) return { freshness: 'aging', ageMinutes }
  return { freshness: 'stale', ageMinutes }
}

export function buildRouteCorridorAlerts(
  systems: readonly RouteSystemIntel[]
): RouteCorridorKillmailAlert[] {
  return systems.flatMap((system): RouteCorridorKillmailAlert[] => {
    if (system.index === 0) return []
    const freshness = system.activity.killmailFreshness
    const latestAt = system.activity.latestPublicKillmailAt
    const ageMinutes = system.activity.latestPublicKillmailAgeMinutes
    if ((freshness !== 'hot' && freshness !== 'recent' && freshness !== 'aging') ||
        latestAt === null || ageMinutes === null) return []
    return [{
      systemId: system.systemId,
      systemName: system.name,
      systemIndex: system.index,
      latestAt,
      ageMinutes,
      lastHourCount: system.activity.recentPublicKillmailsLastHour ?? 0,
      lastHourCountLowerBound:
        system.activity.recentPublicKillmailsLastHourLowerBound === true,
      freshness,
      severity: freshness === 'hot' ? 'critical' : freshness === 'recent' ? 'warning' : 'notice',
      temporal: 'reported-killmail'
    }]
  }).sort((left, right) => left.ageMinutes - right.ageMinutes || left.systemIndex - right.systemIndex)
}

export function estimateRouteHauling(
  rawInput: RouteHaulingInput,
  jumps: number
): RouteHaulingEstimate {
  const input = validateHaulingInput(rawInput)
  if (!Number.isSafeInteger(jumps) || jumps < 0) {
    throw new TypeError('Jump count must be a non-negative whole number')
  }

  const feeRate = input.fees?.rate ?? 0
  const feeBasis = input.fees?.basisIsk ?? 0
  const percentageFeesIsk = feeRate * feeBasis
  const fixedFeesIsk = input.fees?.fixedIsk ?? 0
  const haulingCostIsk = input.haulingCostIsk ?? 0
  const totalCostsIsk = percentageFeesIsk + fixedFeesIsk + haulingCostIsk
  const netProfitIsk = input.marketDeltaIsk - totalCostsIsk
  const assumptions = [
    'Market difference was supplied externally and does not guarantee order fills.',
    'Estimate does not include cargo-loss risk.'
  ]
  if (feeRate === 0 && fixedFeesIsk === 0) {
    assumptions.push('Fees are set to 0 ISK.')
  }
  if (haulingCostIsk === 0) assumptions.push('Hauling cost is set to 0 ISK.')

  return {
    grossMarketDeltaIsk: input.marketDeltaIsk,
    percentageFeesIsk,
    fixedFeesIsk,
    haulingCostIsk,
    totalCostsIsk,
    netProfitIsk,
    breakEvenMarketDeltaIsk: totalCostsIsk,
    netProfitPerM3: netProfitIsk / input.cargoM3,
    netProfitPerJump: jumps > 0 ? netProfitIsk / jumps : null,
    cargoM3: input.cargoM3,
    profitable: netProfitIsk > 0,
    assumptions
  }
}

export function riskLevelForScore(score: number): Exclude<RouteRiskLevel, 'unknown'> {
  const bounded = Math.min(100, Math.max(0, score))
  if (bounded >= 75) return 'critical'
  if (bounded >= 50) return 'high'
  if (bounded >= 25) return 'guarded'
  return 'low'
}

export { NOT_LIVE_LIMITATION as ROUTE_NOT_LIVE_LIMITATION }

function normalizeEndpoint(value: RouteEndpointInput, label: string): NormalizedRouteEndpoint {
  if (typeof value === 'number') {
    assertPositiveId(value, label)
    return { kind: 'id', value }
  }
  if (typeof value !== 'string') throw new TypeError(`${label} is not set`)
  const name = value.trim()
  if (name.length === 0 || name.length > 128) {
    throw new TypeError(`${label}: name must contain from 1 to 128 characters`)
  }
  return { kind: 'name', value: name }
}

function validateHaulingInput(input: RouteHaulingInput): RouteHaulingInput {
  assertFinite(input.marketDeltaIsk, 'Market difference')
  assertPositiveFinite(input.cargoM3, 'Cargo volume')
  const feeRate = input.fees?.rate ?? 0
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 1) {
    throw new TypeError('Fee rate must be from 0 to 1')
  }
  if (feeRate > 0 && input.fees?.basisIsk === undefined) {
    throw new TypeError('Percentage fee requires an ISK basis')
  }
  if (input.fees?.basisIsk !== undefined) {
    assertNonNegativeFinite(input.fees.basisIsk, 'Fee basis')
  }
  if (input.fees?.fixedIsk !== undefined) {
    assertNonNegativeFinite(input.fees.fixedIsk, 'Fixed fee')
  }
  if (input.haulingCostIsk !== undefined) {
    assertNonNegativeFinite(input.haulingCostIsk, 'Hauling cost')
  }
  return {
    marketDeltaIsk: input.marketDeltaIsk,
    cargoM3: input.cargoM3,
    fees: input.fees ? { ...input.fees } : undefined,
    haulingCostIsk: input.haulingCostIsk
  }
}

function validateRiskInput(input: RouteRiskInput): void {
  if (input.securityStatus !== null &&
      (!Number.isFinite(input.securityStatus) || input.securityStatus < -1 || input.securityStatus > 1)) {
    throw new TypeError('Security status must be from -1 to 1 or null')
  }
  assertNullableNonNegativeInteger(input.shipKills, 'Ship kills')
  assertNullableNonNegativeInteger(input.podKills, 'Pod kills')
  assertNullableNonNegativeInteger(input.jumps, 'Jumps')
  assertNullableNonNegativeInteger(input.recentPublicKillmails, 'Killmail')
  if (input.recentPublicKillmailsLastHour !== undefined) {
    assertNullableNonNegativeInteger(input.recentPublicKillmailsLastHour, 'Killmails in the last hour')
  }
  if (input.latestPublicKillmailAgeMinutes !== undefined &&
      input.latestPublicKillmailAgeMinutes !== null &&
      (!Number.isFinite(input.latestPublicKillmailAgeMinutes) || input.latestPublicKillmailAgeMinutes < 0)) {
    throw new TypeError('Latest killmail age must be non-negative or null')
  }
  if (input.recentKillmailWindowHours !== null) {
    assertPositiveFinite(input.recentKillmailWindowHours, 'Killmail window')
  }
}

function securityRiskPoints(securityStatus: number, isWormhole: boolean): number {
  if (isWormhole) return 30
  if (securityStatus >= 0.5) return Math.round((1 - securityStatus) * 10)
  if (securityStatus >= 0) return Math.round(12 + (0.5 - securityStatus) * 32)
  return Math.round(30 + Math.min(10, Math.abs(securityStatus) * 10))
}

function riskConfidence(input: RouteRiskInput): RouteEvidenceConfidence {
  const available = [
    input.securityStatus !== null,
    input.shipKills !== null && input.podKills !== null,
    input.jumps !== null
  ].filter(Boolean).length
  if (available === 3) return 'high'
  if (available === 2) return 'medium'
  return 'low'
}

function detectCampIndicators(input: RouteRiskInput): RouteCampIndicator[] {
  const indicators: RouteCampIndicator[] = []
  const shipKills = input.shipKills
  const podKills = input.podKills
  const losses = addKnown(shipKills, podKills)

  if (shipKills !== null && podKills !== null && shipKills >= 3 && podKills >= 2) {
    indicators.push({
      code: 'ship-and-pod-losses',
      severity: shipKills >= 8 || podKills >= 4 ? 'strong' : 'elevated',
      evidence: `Hourly aggregate: ${shipKills} ships and ${podKills} pods`,
      temporal: 'historical'
    })
  }
  if (podKills !== null && podKills >= 2) {
    indicators.push({
      code: 'pod-kill-cluster',
      severity: podKills >= 5 ? 'strong' : 'elevated',
      evidence: `Hourly aggregate pods: ${podKills}`,
      temporal: 'historical'
    })
  }
  if (losses !== null && losses >= 2 && input.jumps !== null) {
    if (input.jumps === 0) {
      indicators.push({
        code: 'losses-without-reported-traffic',
        severity: 'strong',
        evidence: `${losses} losses with a zero public jump count`,
        temporal: 'historical'
      })
    } else if (losses / input.jumps >= 0.04) {
      indicators.push({
        code: 'loss-density',
        severity: losses / input.jumps >= 0.1 ? 'strong' : 'elevated',
        evidence: `${(losses / input.jumps * 100).toFixed(1)} losses per 100 jumps`,
        temporal: 'historical'
      })
    }
  }
  if (input.recentPublicKillmails !== null && input.recentPublicKillmails >= 8) {
    indicators.push({
      code: 'public-killmail-cluster',
      severity: input.recentPublicKillmails >= 20 ? 'strong' : 'notice',
      evidence: `${input.recentPublicKillmails} public killmails in ${formatHours(input.recentKillmailWindowHours ?? 24)}`,
      temporal: 'historical'
    })
  }
  const freshCount = input.recentPublicKillmailsLastHour ?? null
  if (freshCount !== null && freshCount > 0) {
    const age = input.latestPublicKillmailAgeMinutes
    const countText = `${input.recentPublicKillmailsLastHourLowerBound ? '≥' : ''}${freshCount}`
    indicators.push({
      code: 'fresh-public-killmail',
      severity: freshCount >= 3 || (age !== null && age !== undefined && age <= 15)
        ? 'strong'
        : 'elevated',
      evidence: age === null || age === undefined
        ? `${countText} public killmails in the last hour`
        : `${countText} public killmails per hour; latest ${formatAgeMinutes(age)} ago`,
      temporal: 'historical'
    })
  }
  return indicators
}

function campPatternFromIndicators(
  input: RouteRiskInput,
  indicators: readonly RouteCampIndicator[]
): RouteCampPattern {
  if (input.shipKills === null && input.podKills === null &&
      input.jumps === null && input.recentPublicKillmails === null &&
      (input.recentPublicKillmailsLastHour ?? null) === null) return 'unknown'
  if (indicators.length === 0) return 'none'
  const evidenceWeight = indicators.reduce((sum, indicator) =>
    sum + (indicator.severity === 'strong' ? 3 : indicator.severity === 'elevated' ? 2 : 1), 0
  )
  return evidenceWeight >= 4 ? 'strong' : 'possible'
}

function addKnown(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null
  return (left ?? 0) + (right ?? 0)
}

function formatSecurity(value: number): string {
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`
}

function formatAgeMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, Math.floor(minutes))} min`
  return `${Math.floor(minutes / 60)} h ${Math.floor(minutes % 60)} min`
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label}: invalid ID`)
}

function assertNullableNonNegativeInteger(value: number | null, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${label} must be whole, non-negative, or null`)
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`)
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be greater than zero`)
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be non-negative`)
}
