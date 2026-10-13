import { describe, expect, it } from 'vitest'
import { industryBuyDecision } from '../src/shared/industry-decision'
import { planIndustryOpportunity } from '../src/shared/industry-planning'
import { industryPurchaseBasis } from '../src/shared/industry-ledger'
import { industryCatalog as catalog, industryRecipe as recipe, industryRequest as request, industrySkills as skills, industryOrder as order, industryPurchase as purchase } from './industry-fixtures'

function options() {
  return { recipe, catalog, request: { ...request, blueprintMode: 'contracts' as const }, skills, systemCostIndex: 0.1,
    contractBlueprint: { contractId: 22, typeId: 101, price: 100, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '', copy: true, me: 0, te: 0, runs: 100, bundled: false },
    buyOrders: new Map([[34, [order(34, 5, false, 1000)]], [35, [order(35, 20)]]]),
    sellOrders: new Map([[100, [order(100, 30, true, 10), order(100, 25, true, 990), order(100, 1e9)]]]),
    blueprintOrders: new Map(), adjustedPrices: new Map([[34, 4], [35, 15]]) }
}
describe('BUY-only manufacturing decisions', () => {
  it('does not treat a high competing SELL without buyers as an opportunity', () => {
    const input = options()
    input.sellOrders.set(100, [order(100, 1e12)])
    const decision = industryBuyDecision(planIndustryOpportunity(input))
    expect(decision.executable).toBe(false)
    expect(decision.profitable).toBe(false)
    expect(decision.hourly).toBeNull()
    expect(decision.reasons.join(' ')).toContain('BUY принимает только 0')
  })
  it('picks hourly and total-profit batches separately and divides by that exact batch time', () => {
    const row = planIndustryOpportunity(options())
    const hourly = industryBuyDecision(row)
    const total = industryBuyDecision(row, { sort: 'profit' })
    expect(hourly.quote.runs).toBe(1)
    expect(total.quote.runs).toBe(100)
    expect(total.hourly).toBe(total.quote.repeatProfit! / total.quote.hours)
    expect(total.hourly).not.toBe(total.quote.repeatProfit! / row.hours)
    expect(hourly.hourly).toBeGreaterThan(total.hourly!)
  })
  it('uses the whole batch cash and the entire contract for budget checks', () => {
    const row = planIndustryOpportunity(options())
    const decision = industryBuyDecision(row, { sort: 'profit', budget: row.capitalRequired! })
    expect(decision.quote.runs).toBe(1)
    expect(decision.profitable).toBe(true)
    const blocked = industryBuyDecision(row, { budget: row.capitalRequired! - 1 })
    expect(blocked.executable).toBe(false)
    expect(blocked.reasons.join(' ')).toContain('превышает бюджет')
  })
  it('never recommends manufacturing without skills, costs or finite duration', () => {
    const input = options()
    const noSkills = industryBuyDecision(planIndustryOpportunity({ ...input, skills: [] }))
    expect(noSkills.profitable).toBe(false)
    expect(noSkills.reasons.join(' ')).toContain('навыков')
    const row = planIndustryOpportunity(input)
    expect(industryBuyDecision({ ...row, plan: undefined, hours: NaN }).hourly).toBeNull()
    expect(industryBuyDecision({ ...row, plan: undefined, blueprint: { ...row.blueprint, cost: null } }).executable).toBe(false)
    expect(industryBuyDecision({ ...row, plan: undefined, blueprint: { ...row.blueprint, source: 'owned-copy' } }).executable).toBe(false)
  })
  it('uses the same historical material valuation in the headline, ranking and chosen batch', () => {
    const row = planIndustryOpportunity(options())
    const purchases = industryPurchaseBasis([purchase, { ...purchase, transactionId: 12, typeId: 35, unitPrice: 1, quantity: 2 }], '2026-09-30')
    const decision = industryBuyDecision(row, { materialMode: 'purchases', purchases })
    expect(decision.profitable).toBe(true)
    expect(decision.quote.materialCost).toBe(21)
    expect(decision.hourly).toBe(decision.quote.repeatProfit! / decision.quote.hours)
    expect(industryBuyDecision(row, { materialMode: 'purchases', purchases: new Map() }).profitable).toBe(false)
  })
  it('keeps BPO operating earnings separate from full acquisition cash and first-batch profit', () => {
    const input = options()
    const row = planIndustryOpportunity({ ...input, contractBlueprint: { ...input.contractBlueprint, copy: false, runs: -1, price: 1e6 } })
    const decision = industryBuyDecision(row)
    expect(decision.profitable).toBe(true)
    expect(decision.quote.profit).toBeLessThan(0)
    expect(decision.quote.capitalRequired).toBeGreaterThan(1e6)
    expect(decision.hourly).toBe(decision.quote.repeatProfit! / decision.quote.hours)
    expect(industryBuyDecision(row, { budget: 1000 }).executable).toBe(false)
  })
})
