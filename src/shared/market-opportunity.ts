import type { MarketHubId, MarketHubQuote } from './market'
import {
  estimateRouteHauling,
  type RouteEvidenceConfidence,
  type RouteHaulingEstimate
} from './route-intel'

export interface MarketOpportunityRoute {
  jumps: number
  averageRiskScore: number
  maximumRiskScore: number
  campPatternSystems: number
  confidence: RouteEvidenceConfidence
}

export interface MarketOpportunityFees {
  /** Sales and transaction fees as a fraction of destination revenue. */
  rate?: number
  fixedIsk?: number
}

export interface MarketOpportunityCandidate {
  typeName: string
  unitVolumeM3: number
  originQuote: MarketHubQuote
  destinationQuote: MarketHubQuote
  route: MarketOpportunityRoute
  fees?: MarketOpportunityFees
  haulingCostIsk?: number
}

export interface MarketOpportunityRisk {
  index: number
  penaltyRate: number
  penaltyIsk: number
  averageRouteScore: number
  maximumRouteScore: number
  campPatternSystems: number
  confidence: RouteEvidenceConfidence
  /** Public history heuristic, not a live-camp probability or insured-loss estimate. */
  interpretation: 'historical-route-heuristic'
}

export interface MarketOpportunity {
  key: string
  rank: number
  typeId: number
  typeName: string
  quantity: number
  originHubId: MarketHubId
  destinationHubId: MarketHubId
  acquisitionCostIsk: number
  destinationRevenueIsk: number
  grossMarketDeltaIsk: number
  hauling: RouteHaulingEstimate
  netMarginPercent: number
  risk: MarketOpportunityRisk
  riskAdjustedProfitIsk: number
  cached: boolean
  quoteFetchedAt: string
}

export const MARKET_OPPORTUNITY_SKIP_REASONS = [
  'same-hub',
  'type-mismatch',
  'quantity-mismatch',
  'origin-depth-incomplete',
  'destination-depth-incomplete',
  'invalid-candidate',
  'below-profit-floor'
] as const

export type MarketOpportunitySkipReason = (typeof MARKET_OPPORTUNITY_SKIP_REASONS)[number]

export interface SkippedMarketOpportunity {
  candidateIndex: number
  typeId: number | null
  reason: MarketOpportunitySkipReason
  detail: string
}

export interface MarketOpportunityRadarOptions {
  /** 0 ignores route risk; 1 applies the full heuristic penalty. Defaults to 0.5. */
  riskAversion?: number
  /** Candidates below this net ISK value are reported as skipped. Defaults to 0. */
  minimumNetProfitIsk?: number
}

export interface MarketOpportunityRadar {
  opportunities: MarketOpportunity[]
  skipped: SkippedMarketOpportunity[]
  evaluatedAt: string
  assumptions: string[]
}

export interface MarketOpportunityEvaluationRequest {
  typeId: number
  typeName: string
  quantity: number
  originHubId: MarketHubId
  destinationHubId: MarketHubId
  unitVolumeM3: number
  feeRate: number
  haulingCostIsk: number
  riskAversion: number
  forceRefresh?: boolean
}

/**
 * Turns executable cross-hub quotes into ranked opportunities. Origin uses the
 * sell side (immediate buy); destination uses the buy side (immediate sell).
 */
export function rankMarketOpportunities(
  candidates: readonly MarketOpportunityCandidate[],
  options: MarketOpportunityRadarOptions = {},
  now = new Date().toISOString()
): MarketOpportunityRadar {
  if (!Array.isArray(candidates)) throw new TypeError('Market candidates must be an array')
  const evaluatedAt = normalizeIsoDate(now, 'evaluation timestamp')
  const riskAversion = finiteRange(options.riskAversion ?? 0.5, 0, 1, 'risk aversion')
  const minimumNetProfitIsk = finiteNonNegative(
    options.minimumNetProfitIsk ?? 0,
    'minimum net profit'
  )
  const opportunities: Omit<MarketOpportunity, 'rank'>[] = []
  const skipped: SkippedMarketOpportunity[] = []

  candidates.forEach((candidate, candidateIndex) => {
    const result = evaluateCandidate(candidate, candidateIndex, riskAversion)
    if ('reason' in result) {
      skipped.push(result)
      return
    }
    if (result.hauling.netProfitIsk < minimumNetProfitIsk) {
      skipped.push({
        candidateIndex,
        typeId: result.typeId,
        reason: 'below-profit-floor',
        detail: `Net profit ${result.hauling.netProfitIsk} ISK is below ${minimumNetProfitIsk} ISK`
      })
      return
    }
    opportunities.push(result)
  })

  const ranked = opportunities
    .sort((left, right) =>
      right.riskAdjustedProfitIsk - left.riskAdjustedProfitIsk ||
      right.hauling.netProfitPerM3 - left.hauling.netProfitPerM3 ||
      right.hauling.netProfitIsk - left.hauling.netProfitIsk ||
      left.typeName.localeCompare(right.typeName, 'en') ||
      left.typeId - right.typeId
    )
    .map((opportunity, index): MarketOpportunity => ({ ...opportunity, rank: index + 1 }))

  return {
    opportunities: ranked,
    skipped,
    evaluatedAt,
    assumptions: [
      'Both order-book sides must fully fill the requested quantity.',
      'Fees are applied to destination revenue; configured hauling cost is fixed.',
      'Route risk changes ranking only. It is historical evidence, not live-camp probability.',
      'Prices can change before orders execute.'
    ]
  }
}

function evaluateCandidate(
  candidate: MarketOpportunityCandidate,
  candidateIndex: number,
  riskAversion: number
): Omit<MarketOpportunity, 'rank'> | SkippedMarketOpportunity {
  const typeId = candidate?.originQuote?.typeId
  try {
    validateCandidateShape(candidate)
  } catch (error) {
    return {
      candidateIndex,
      typeId: Number.isSafeInteger(typeId) && typeId > 0 ? typeId : null,
      reason: 'invalid-candidate',
      detail: error instanceof Error ? error.message : 'Invalid market candidate'
    }
  }

  const origin = candidate.originQuote
  const destination = candidate.destinationQuote
  if (origin.hub.id === destination.hub.id) {
    return skip(candidateIndex, typeId, 'same-hub', 'Origin and destination hubs are identical')
  }
  if (origin.typeId !== destination.typeId) {
    return skip(candidateIndex, typeId, 'type-mismatch', 'Origin and destination type IDs differ')
  }
  if (origin.quantity !== destination.quantity) {
    return skip(candidateIndex, typeId, 'quantity-mismatch', 'Origin and destination quantities differ')
  }
  if (!isCompleteFill(origin.book.immediateBuy, origin.quantity)) {
    return skip(
      candidateIndex,
      typeId,
      'origin-depth-incomplete',
      'Origin sell orders cannot fill the requested quantity'
    )
  }
  if (!isCompleteFill(destination.book.immediateSell, destination.quantity)) {
    return skip(
      candidateIndex,
      typeId,
      'destination-depth-incomplete',
      'Destination buy orders cannot fill the requested quantity'
    )
  }

  const quantity = origin.quantity
  const acquisitionCostIsk = origin.book.immediateBuy.total
  const destinationRevenueIsk = destination.book.immediateSell.total
  const grossMarketDeltaIsk = destinationRevenueIsk - acquisitionCostIsk
  const cargoM3 = candidate.unitVolumeM3 * quantity
  const feeRate = candidate.fees?.rate ?? 0
  const fixedFeesIsk = candidate.fees?.fixedIsk ?? 0
  const hauling = estimateRouteHauling({
    marketDeltaIsk: grossMarketDeltaIsk,
    cargoM3,
    fees: {
      rate: feeRate,
      basisIsk: destinationRevenueIsk,
      fixedIsk: fixedFeesIsk
    },
    haulingCostIsk: candidate.haulingCostIsk ?? 0
  }, candidate.route.jumps)
  const riskIndex = calculateRouteRiskIndex(candidate.route)
  const penaltyRate = riskIndex / 100 * riskAversion
  // Do not make a loss look smaller by multiplying a negative number.
  const penaltyIsk = Math.max(0, hauling.netProfitIsk) * penaltyRate
  const quoteFetchedAt = latestIsoDate(origin.fetchedAt, destination.fetchedAt)

  return {
    key: `${origin.typeId}:${origin.hub.id}:${destination.hub.id}`,
    typeId: origin.typeId,
    typeName: cleanText(candidate.typeName, 'type name', 200),
    quantity,
    originHubId: origin.hub.id,
    destinationHubId: destination.hub.id,
    acquisitionCostIsk,
    destinationRevenueIsk,
    grossMarketDeltaIsk,
    hauling,
    netMarginPercent: acquisitionCostIsk > 0
      ? hauling.netProfitIsk / acquisitionCostIsk * 100
      : 0,
    risk: {
      index: riskIndex,
      penaltyRate,
      penaltyIsk,
      averageRouteScore: candidate.route.averageRiskScore,
      maximumRouteScore: candidate.route.maximumRiskScore,
      campPatternSystems: candidate.route.campPatternSystems,
      confidence: candidate.route.confidence,
      interpretation: 'historical-route-heuristic'
    },
    riskAdjustedProfitIsk: hauling.netProfitIsk - penaltyIsk,
    cached: origin.cached || destination.cached,
    quoteFetchedAt
  }
}

export function calculateRouteRiskIndex(route: MarketOpportunityRoute): number {
  validateRoute(route)
  const confidencePenalty = route.confidence === 'low' ? 10 : route.confidence === 'medium' ? 5 : 0
  return Math.min(100, Math.round(
    route.averageRiskScore * 0.4 +
    route.maximumRiskScore * 0.6 +
    Math.min(20, route.campPatternSystems * 5) +
    confidencePenalty
  ))
}

function validateCandidateShape(candidate: MarketOpportunityCandidate): void {
  if (!candidate || typeof candidate !== 'object') throw new TypeError('Candidate must be an object')
  cleanText(candidate.typeName, 'type name', 200)
  finitePositive(candidate.unitVolumeM3, 'unit volume')
  if (!candidate.originQuote || !candidate.destinationQuote) {
    throw new TypeError('Both market quotes are required')
  }
  positiveInteger(candidate.originQuote.typeId, 'origin type ID')
  positiveInteger(candidate.destinationQuote.typeId, 'destination type ID')
  positiveInteger(candidate.originQuote.quantity, 'origin quantity')
  positiveInteger(candidate.destinationQuote.quantity, 'destination quantity')
  finiteNonNegative(candidate.originQuote.book?.immediateBuy?.total, 'origin total')
  finiteNonNegative(candidate.destinationQuote.book?.immediateSell?.total, 'destination total')
  validateRoute(candidate.route)
  finiteRange(candidate.fees?.rate ?? 0, 0, 1, 'fee rate')
  finiteNonNegative(candidate.fees?.fixedIsk ?? 0, 'fixed fees')
  finiteNonNegative(candidate.haulingCostIsk ?? 0, 'hauling cost')
  normalizeIsoDate(candidate.originQuote.fetchedAt, 'origin quote timestamp')
  normalizeIsoDate(candidate.destinationQuote.fetchedAt, 'destination quote timestamp')
}

function validateRoute(route: MarketOpportunityRoute): void {
  if (!route || typeof route !== 'object') throw new TypeError('Route summary is required')
  if (!Number.isSafeInteger(route.jumps) || route.jumps < 0) {
    throw new TypeError('Route jumps must be a non-negative integer')
  }
  finiteRange(route.averageRiskScore, 0, 100, 'average route risk')
  finiteRange(route.maximumRiskScore, 0, 100, 'maximum route risk')
  if (!Number.isSafeInteger(route.campPatternSystems) || route.campPatternSystems < 0) {
    throw new TypeError('Camp-pattern count must be a non-negative integer')
  }
  if (route.confidence !== 'high' && route.confidence !== 'medium' && route.confidence !== 'low') {
    throw new TypeError('Invalid route confidence')
  }
}

function isCompleteFill(
  fill: { complete: boolean; filledQuantity: number; requestedQuantity: number; total: number },
  quantity: number
): boolean {
  return fill.complete === true && fill.filledQuantity === quantity &&
    fill.requestedQuantity === quantity && Number.isFinite(fill.total) && fill.total >= 0
}

function skip(
  candidateIndex: number,
  typeId: number,
  reason: MarketOpportunitySkipReason,
  detail: string
): SkippedMarketOpportunity {
  return { candidateIndex, typeId, reason, detail }
}

function latestIsoDate(left: string, right: string): string {
  const normalizedLeft = normalizeIsoDate(left, 'quote timestamp')
  const normalizedRight = normalizeIsoDate(right, 'quote timestamp')
  return Date.parse(normalizedLeft) >= Date.parse(normalizedRight) ? normalizedLeft : normalizedRight
}

function cleanText(value: string, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`)
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maximumLength || normalized.includes('\0')) {
    throw new TypeError(`Invalid ${label}`)
  }
  return normalized
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be positive`)
  return value
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive`)
  return value
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be non-negative`)
  return value
}

function finiteRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function normalizeIsoDate(value: string, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date`)
  }
  return new Date(value).toISOString()
}
