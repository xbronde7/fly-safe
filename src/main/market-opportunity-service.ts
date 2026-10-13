import { getMarketHub, type MarketHubQuote } from '../shared/market'
import {
  rankMarketOpportunities,
  type MarketOpportunityEvaluationRequest,
  type MarketOpportunityRadar
} from '../shared/market-opportunity'
import type { MarketService } from './market-service'
import type { RouteIntelService } from './route-intel-service'

/** Orchestrates cached market depth and historical route risk inside the main process. */
export class MarketOpportunityService {
  constructor(
    private readonly market: MarketService,
    private readonly route: RouteIntelService
  ) {}

  async evaluate(request: MarketOpportunityEvaluationRequest): Promise<MarketOpportunityRadar> {
    const input = validateRequest(request)
    const originHub = getMarketHub(input.originHubId)
    const destinationHub = getMarketHub(input.destinationHubId)
    const [comparison, route] = await Promise.all([
      this.market.compareHubs({
        typeId: input.typeId,
        quantity: input.quantity,
        hubIds: [input.originHubId, input.destinationHubId],
        includeHistory: false,
        forceRefresh: input.forceRefresh === true
      }),
      this.route.analyze({
        origin: originHub.solarSystemId,
        destination: destinationHub.solarSystemId,
        mode: 'secure',
        forceRefresh: input.forceRefresh === true,
        includeRecentPublicKillmails: true
      })
    ])
    const originQuote = requireQuote(comparison.quotes, input.originHubId)
    const destinationQuote = requireQuote(comparison.quotes, input.destinationHubId)
    return rankMarketOpportunities([{
      typeName: input.typeName,
      unitVolumeM3: input.unitVolumeM3,
      originQuote,
      destinationQuote,
      route: {
        jumps: route.summary.jumps,
        averageRiskScore: route.summary.averageRiskScore,
        maximumRiskScore: route.summary.maximumRiskScore,
        campPatternSystems: route.summary.campPatternSystems,
        confidence: route.summary.confidence
      },
      fees: { rate: input.feeRate },
      haulingCostIsk: input.haulingCostIsk
    }], { riskAversion: input.riskAversion }, route.evaluatedAt)
  }
}

function validateRequest(
  request: MarketOpportunityEvaluationRequest
): MarketOpportunityEvaluationRequest {
  if (!request || typeof request !== 'object') throw new TypeError('Market Radar request is missing')
  if (!Number.isSafeInteger(request.typeId) || request.typeId <= 0) {
    throw new TypeError('Invalid Market Radar type ID')
  }
  if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0 || request.quantity > 2_147_483_647) {
    throw new TypeError('Invalid Market Radar quantity')
  }
  if (request.originHubId === request.destinationHubId) throw new TypeError('Choose different hubs')
  getMarketHub(request.originHubId)
  getMarketHub(request.destinationHubId)
  const typeName = cleanText(request.typeName, 200, 'item name')
  finiteRange(request.unitVolumeM3, Number.MIN_VALUE, Number.MAX_VALUE, 'volume')
  finiteRange(request.feeRate, 0, 1, 'fee')
  finiteRange(request.haulingCostIsk, 0, Number.MAX_VALUE, 'hauling')
  finiteRange(request.riskAversion, 0, 1, 'risk adjustment')
  return { ...request, typeName, forceRefresh: request.forceRefresh === true }
}

function requireQuote(quotes: readonly MarketHubQuote[], hubId: string): MarketHubQuote {
  const quote = quotes.find((entry) => entry.hub.id === hubId)
  if (!quote) throw new Error(`Market backend did not return hub ${hubId}`)
  return quote
}

function cleanText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid field: ${label}`)
  const result = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!result || result.length > maximum || result.includes('\0')) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return result
}

function finiteRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return value
}
