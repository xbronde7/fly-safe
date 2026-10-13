import { describe, expect, it } from 'vitest'
import { MARKET_HUBS, type MarketFill, type MarketHubQuote } from '../src/shared/market'
import {
  calculateRouteRiskIndex,
  rankMarketOpportunities,
  type MarketOpportunityCandidate
} from '../src/shared/market-opportunity'

describe('market opportunity radar', () => {
  it('combines executable quote depth, fees, hauling and route risk', () => {
    const candidate = opportunity({
      typeId: 34,
      name: 'Tritanium',
      quantity: 10,
      originTotal: 100_000_000,
      destinationTotal: 150_000_000,
      unitVolumeM3: 2,
      feeRate: 0.1,
      haulingCostIsk: 5_000_000,
      route: { jumps: 10, averageRiskScore: 20, maximumRiskScore: 40, campPatternSystems: 1, confidence: 'high' }
    })

    const result = rankMarketOpportunities([candidate], { riskAversion: 0.5 }, '2026-08-25T12:00:00Z')

    expect(result.skipped).toEqual([])
    expect(result.opportunities[0]).toMatchObject({
      rank: 1,
      typeId: 34,
      quantity: 10,
      acquisitionCostIsk: 100_000_000,
      destinationRevenueIsk: 150_000_000,
      grossMarketDeltaIsk: 50_000_000,
      risk: {
        index: 37,
        penaltyRate: 0.185,
        interpretation: 'historical-route-heuristic'
      },
      hauling: {
        percentageFeesIsk: 15_000_000,
        haulingCostIsk: 5_000_000,
        netProfitIsk: 30_000_000,
        netProfitPerM3: 1_500_000,
        netProfitPerJump: 3_000_000
      },
      riskAdjustedProfitIsk: 24_450_000
    })
  })

  it('can rank a safer route above a larger raw profit', () => {
    const dangerous = opportunity({
      typeId: 1,
      name: 'Danger Cargo',
      originTotal: 100,
      destinationTotal: 200,
      route: { jumps: 5, averageRiskScore: 100, maximumRiskScore: 100, campPatternSystems: 2, confidence: 'high' }
    })
    const safe = opportunity({
      typeId: 2,
      name: 'Safe Cargo',
      originTotal: 100,
      destinationTotal: 180,
      route: { jumps: 5, averageRiskScore: 0, maximumRiskScore: 0, campPatternSystems: 0, confidence: 'high' }
    })

    const ranked = rankMarketOpportunities([dangerous, safe], { riskAversion: 1 })

    expect(ranked.opportunities.map(({ typeId, rank }) => ({ typeId, rank }))).toEqual([
      { typeId: 2, rank: 1 },
      { typeId: 1, rank: 2 }
    ])
    expect(calculateRouteRiskIndex(dangerous.route)).toBe(100)
  })

  it('reports mismatched and non-executable quotes instead of inventing liquidity', () => {
    const incomplete = opportunity({ typeId: 1, name: 'Thin Item' })
    incomplete.destinationQuote.book.immediateSell.complete = false
    incomplete.destinationQuote.book.immediateSell.filledQuantity = 5
    incomplete.destinationQuote.book.immediateSell.missingQuantity = 5
    const mismatch = opportunity({ typeId: 2, name: 'Mismatch' })
    mismatch.destinationQuote.quantity = 11

    const result = rankMarketOpportunities([incomplete, mismatch])

    expect(result.opportunities).toEqual([])
    expect(result.skipped.map(({ reason }) => reason)).toEqual([
      'destination-depth-incomplete',
      'quantity-mismatch'
    ])
  })

  it('keeps losing trades out using the default zero-profit floor', () => {
    const result = rankMarketOpportunities([opportunity({
      typeId: 4,
      name: 'Loss',
      originTotal: 200,
      destinationTotal: 100
    })])

    expect(result.opportunities).toEqual([])
    expect(result.skipped[0]).toMatchObject({ reason: 'below-profit-floor', typeId: 4 })
  })
})

function opportunity(overrides: {
  typeId?: number
  name?: string
  quantity?: number
  originTotal?: number
  destinationTotal?: number
  unitVolumeM3?: number
  feeRate?: number
  haulingCostIsk?: number
  route?: MarketOpportunityCandidate['route']
}): MarketOpportunityCandidate {
  const typeId = overrides.typeId ?? 34
  const quantity = overrides.quantity ?? 10
  return {
    typeName: overrides.name ?? 'Item',
    unitVolumeM3: overrides.unitVolumeM3 ?? 1,
    originQuote: quote('jita', typeId, quantity, overrides.originTotal ?? 100, 'buy'),
    destinationQuote: quote('amarr', typeId, quantity, overrides.destinationTotal ?? 150, 'sell'),
    route: overrides.route ?? {
      jumps: 10,
      averageRiskScore: 0,
      maximumRiskScore: 0,
      campPatternSystems: 0,
      confidence: 'high'
    },
    fees: { rate: overrides.feeRate ?? 0 },
    haulingCostIsk: overrides.haulingCostIsk ?? 0
  }
}

function quote(
  hubId: 'jita' | 'amarr',
  typeId: number,
  quantity: number,
  total: number,
  executableSide: 'buy' | 'sell'
): MarketHubQuote {
  const hub = MARKET_HUBS.find((entry) => entry.id === hubId)!
  const empty = fill(quantity, 0, false)
  const executable = fill(quantity, total, true)
  return {
    hub,
    typeId,
    quantity,
    book: {
      bestBuy: executableSide === 'sell' ? total / quantity : null,
      bestSell: executableSide === 'buy' ? total / quantity : null,
      spread: null,
      spreadPercent: null,
      buyOrderCount: executableSide === 'sell' ? 1 : 0,
      sellOrderCount: executableSide === 'buy' ? 1 : 0,
      buyVolume: executableSide === 'sell' ? quantity : 0,
      sellVolume: executableSide === 'buy' ? quantity : 0,
      immediateBuy: executableSide === 'buy' ? executable : empty,
      immediateSell: executableSide === 'sell' ? executable : empty
    },
    regionalOrderCount: 1,
    stationOrderCount: 1,
    history: null,
    cached: false,
    fetchedAt: hubId === 'jita' ? '2026-08-25T10:00:00Z' : '2026-08-25T10:01:00Z'
  }
}

function fill(quantity: number, total: number, complete: boolean): MarketFill {
  return {
    requestedQuantity: quantity,
    filledQuantity: complete ? quantity : 0,
    missingQuantity: complete ? 0 : quantity,
    total,
    averagePrice: complete ? total / quantity : null,
    complete,
    ordersUsed: complete ? 1 : 0,
    levels: complete ? [{ price: total / quantity, quantity, orderCount: 1 }] : []
  }
}
