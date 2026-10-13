import { describe, expect, it } from 'vitest'
import { planIndustryOpportunity, industryLiquidity } from '../src/shared/industry-planning'
import { industryCatalog as catalog, industryRecipe as recipe, industryRequest as request, industrySkills as skills, industryOrder as order } from './industry-fixtures'

function input() {
  return { recipe, catalog, request: { ...request, blueprintMode: 'contracts' as const, autoPlan: true }, skills, systemCostIndex: 0.1,
    contractBlueprint: { contractId: 22, typeId: 101, price: 100, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '', copy: true, me: 0, te: 0, runs: 100, bundled: false },
    buyOrders: new Map([[34, [order(34, 5, false, 10), order(34, 7, false, 10)]], [35, [order(35, 20)]]]),
    sellOrders: new Map([[100, [order(100, 30, true, 10), order(100, 25, true, 10), order(100, 40, false, 100)]]]),
    blueprintOrders: new Map(), adjustedPrices: new Map([[34, 4], [35, 15]]) }
}
describe('automatic manufacturing and calendar-day demand', () => {
  it('quotes one whole recipe run independently of the old output target, then a full and feasible copy', () => {
    const row = planIndustryOpportunity({ ...input(), request: { ...input().request, productionQuantity: 99999 } })
    expect(row.runs).toBe(1); expect(row.outputQuantity).toBe(10)
    expect(row.materialCost).toBe(70); expect(row.grossRevenue).toBe(300)
    expect(row.plan?.fullRuns).toBe(100); expect(row.plan?.full?.materialCost).toBeNull()
    expect(row.plan?.production?.runs).toBe(2); expect(row.plan?.immediate?.runs).toBe(2)
    expect(row.plan?.production?.materialCost).toBe(180)
    expect(row.plan?.immediate?.grossRevenue).toBe(500)
    expect(row.plan?.immediate?.blueprint.cost).toBe(2)
    expect(row.plan?.immediate?.blueprint.purchaseCost).toBe(100)
  })
  it('does not invent a buy-feasible batch when buyers or material minimum lots forbid it', () => {
    const options = input()
    options.sellOrders.set(100, [order(100, 30, true, 5), order(100, 40)])
    expect(planIndustryOpportunity(options).plan?.immediate).toBeNull()
    options.buyOrders.set(34, [order(34, 5, false, 20, { minVolume: 15 })])
    expect(planIndustryOpportunity(options).materialCost).toBeNull()
    expect(planIndustryOpportunity(options).plan?.production?.runs).toBe(2)
  })
  it('has no full original consumption and respects a single-job duration bound', () => {
    const options = input()
    const row = planIndustryOpportunity({ ...options, recipe: { ...recipe, time: 3600 * 100 }, contractBlueprint: { ...options.contractBlueprint, copy: false, runs: -1 }, buyOrders: new Map([[34, [order(34, 5)]], [35, [order(35, 20)]]]) })
    expect(row.plan?.fullRuns).toBeNull(); expect(row.plan?.full).toBeNull()
    expect(row.plan?.production!.hours).toBeLessThanOrEqual(720)
    expect(row.plan?.production!.runs).toBeGreaterThan(1)
  })
  it('finds a profitable BUY boundary instead of selling a whole copy to joke bids', () => {
    const options = input()
    options.buyOrders.set(34, [order(34, 5, false, 10000)])
    options.sellOrders.set(100, [order(100, 30, true, 200), order(100, 0.01, true, 10000, { orderId: 100333 }), order(100, 40)])
    const row = planIndustryOpportunity(options)
    expect(row.plan?.immediate?.runs).toBe(100)
    expect(row.plan?.immediate?.repeatProfit).toBeLessThan(0)
    expect(row.plan?.profitableBuy?.runs).toBe(20)
    expect(row.plan?.profitableBuy?.repeatProfit).toBeGreaterThan(0)
    expect(row.plan?.profitableBuy?.outputFill.complete).toBe(true)
  })
  it('does not turn a single monthly sale into one item sold per day', () => {
    const point = { date: '2026-09-15', volume: 1, average: 5, highest: 5, lowest: 5, orderCount: 1 }
    const row = industryLiquidity(100, 10000002, [point, { ...point, date: '2026-10-02', volume: 999 }], '2026-10-01', '2026-10-02T12:00:00Z', Date.parse('2026-10-03T00:00:00Z'))
    expect(row.volume30).toBe(1); expect(row.daily30).toBe(1 / 30)
    expect(row.daily7).toBe(0); expect(row.activeDays30).toBe(1); expect(row.lastTrade).toBe('2026-09-15')
    expect(row.stale).toBe(false)
  })
  it('retains a separate best hourly BUY candidate, not only the largest total profit', () => {
    const options = input()
    options.buyOrders.set(34, [order(34, 5, false, 1000)])
    options.sellOrders.set(100, [order(100, 30, true, 10), order(100, 25, true, 990)])
    const row = planIndustryOpportunity(options)
    expect(row.plan?.hourlyBuy?.runs).toBe(1)
    expect(row.plan?.profitableBuy?.runs).toBe(100)
    expect(row.plan!.hourlyBuy!.repeatProfit! / row.plan!.hourlyBuy!.hours).toBeGreaterThan(row.plan!.profitableBuy!.repeatProfit! / row.plan!.profitableBuy!.hours)
  })
  it('includes zero days after the last trade and flags an old publication, not mere inactivity', () => {
    const row = industryLiquidity(100, 1, [], '2026-09-01', '2026-10-03T00:00:00Z', Date.parse('2026-10-03T00:00:00Z'))
    expect(row.daily30).toBe(0); expect(row.lastTrade).toBeNull(); expect(row.stale).toBe(true)
  })
})
