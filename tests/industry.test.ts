import { describe, expect, it } from 'vitest'
import { calculateIndustryOpportunity, industrySalesView, industrySalesTaxPercent, industrySkillLevels, industrySlots, manufacturingHours, manufacturingQuantity, missingIndustrySkills, validateIndustryRequest, jobReadyToDeliver, type IndustryJob } from '../src/shared/industry'
import { industryRequest as request, industryRecipe as recipe, industryCatalog as catalog, industrySkills as skills, industryOrder as order, ownIndustryBlueprint } from './industry-fixtures'
function input() {
  return { request, recipe, catalog, skills, systemCostIndex: 0.1,
    buyOrders: new Map([[34, [order(34, 5, false, 10), order(34, 7, false, 10)]], [35, [order(35, 20)]]]),
    sellOrders: new Map([[100, [order(100, 30, true, 10), order(100, 25, true, 10)]]]),
    blueprintOrders: new Map([[101, [order(101, 100), order(101, 90, false, 1, { locationId: 60000004 }), order(101, 1, false, 1, { locationId: 1040000000000 })]]]),
    adjustedPrices: new Map([[34, 4], [35, 15]]) }
}
describe('industry economics', () => {
  it('rounds requested product units to complete recipe runs, without using the old global run count', () => {
    const row = calculateIndustryOpportunity({ ...input(), request: { ...request, runs: 100, productionQuantity: 15 } })
    expect(row.requestedQuantity).toBe(15); expect(row.runs).toBe(2); expect(row.outputQuantity).toBe(20)
    expect(row.materials.map(m => m.quantity)).toEqual([20, 2])
    expect(row.materialCost).toBe(180)
  })
  it('warns before purchase when only two runs of ingredients exist for a hundred-run batch', () => {
    const row = calculateIndustryOpportunity({ ...input(), recipe: { ...recipe, productQuantity: 1 }, request: { ...request, productionQuantity: 100 } })
    expect(row.runs).toBe(100); expect(row.materialCost).toBeNull(); expect(row.profit).toBeNull()
    expect(row.maxMaterialRuns).toBe(2); expect(row.maxFeasibleRuns).toBe(2)
    expect(row.marketReady).toBe(false)
  })
  it('uses lower buy-order levels for instant sales, not competing sell prices, and switches snapshot modes without losing fees', () => {
    const options = { ...input(), sellOrders: new Map([[100, [order(100, 30, true, 10), order(100, 25, true, 10), order(100, 40, false, 1)]]]) }
    const buy = calculateIndustryOpportunity(options)
    const sell = industrySalesView(buy, 'sell', 3)
    expect(buy.grossRevenue).toBe(500); expect(sell.grossRevenue).toBe(800)
    expect(buy.brokerFee).toBe(0); expect(sell.brokerFee).toBe(24)
    expect(sell.salesTax).toBeCloseTo(27)
    expect(sell.profit).toBeCloseTo(800 - 27 - 24 - 180 - 15.675 - 10 - 90)
    expect(sell.capitalRequired).toBeCloseTo(buy.capitalRequired! + 24)
    expect(industrySalesView(sell, 'buy', 3).profit).toBeCloseTo(buy.profit!)
    expect(calculateIndustryOpportunity({ ...options, request: { ...request, salesMode: 'sell', brokerFeePercent: 3 } }).profit).toBeCloseTo(sell.profit!)
  })
  it('never treats competing sell supply as instant buyer demand', () => {
    const row = calculateIndustryOpportunity({ ...input(), sellOrders: new Map([[100, [order(100, 40, false, 100), order(100, 30, true, 5)]]]) })
    expect(row.grossRevenue).toBeNull(); expect(row.maxBuyRuns).toBe(0)
    const sell = industrySalesView(row, 'sell', 3)
    expect(sell.grossRevenue).toBe(800); expect(sell.marketReady).toBe(true)
    expect(sell.maxFeasibleRuns).toBe(2); expect(sell.warnings.join(' ')).toContain('не обещание продажи')
    const absentSell = industrySalesView(calculateIndustryOpportunity(input()), 'sell', 3)
    expect(absentSell.profit).toBeNull(); expect(absentSell.warnings.join(' ')).toContain('Нет sell-цены')
  })
  it('rechecks minimum lots after buyer or BPC run limits reduce the batch', () => {
    const row = calculateIndustryOpportunity({ ...input(),
      buyOrders: new Map([[34, [order(34, 5, false, 20, { minVolume: 15 })]], [35, [order(35, 20)]]]),
      sellOrders: new Map([[100, [order(100, 30, true, 10)]]]) })
    expect(row.maxMaterialRuns).toBe(2); expect(row.maxBuyRuns).toBe(1)
    expect(row.maxImmediateRuns).toBe(0); expect(row.maxFeasibleRuns).toBe(0)
  })
  it('allocates the BPC cost per run while showing the full purchase investment and applying actual ME/TE', () => {
    const offer = { contractId: 22, typeId: 101, price: 90, locationId: 60003760, expires: '2026-10-30T00:00:00Z', title: '', copy: true, me: 10, te: 20, runs: 10, bundled: true }
    const row = calculateIndustryOpportunity({ ...input(), request: { ...request, blueprintMode: 'contracts' }, contractBlueprint: offer })
    expect(row.blueprint).toMatchObject({ source: 'contract-copy', contractId: 22, me: 10, te: 20, cost: 18, purchaseCost: 90, availableRuns: 10 })
    expect(row.materialCost).toBe(166); expect(row.hours).toBeCloseTo(1.36 * 0.8)
    expect(row.profit).toBe(row.repeatProfit); expect(row.breakEvenBatches).toBeNull()
    expect(row.warnings.some(w => w.includes('полная цена'))).toBe(true)
    const insufficient = calculateIndustryOpportunity({ ...input(), request: { ...request, blueprintMode: 'contracts' }, contractBlueprint: { ...offer, runs: 1 } })
    expect(insufficient.profit).toBeNull(); expect(insufficient.repeatProfit).toBeNull()
    expect(insufficient.marketReady).toBe(false); expect(insufficient.maxFeasibleRuns).toBe(1)
    expect(insufficient.blueprint.cost).toBe(180)
    const original = calculateIndustryOpportunity({ ...input(), request: { ...request, blueprintMode: 'contracts' }, contractBlueprint: { ...offer, copy: false, runs: -1 } })
    expect(original.repeatProfit! - original.profit!).toBe(90)
  })
  it('uses executable sell depth for all materials, buy depth for all output, and cheapest NPC BPO', () => {
    const row = calculateIndustryOpportunity(input())
    expect(row.materialCost).toBe(180)
    expect(row.grossRevenue).toBe(500)
    expect(row.materials[0].fill.orderLimitPrice).toBe(7)
    expect(row.outputFill.orderLimitPrice).toBe(25)
    expect(row.blueprint.cost).toBe(90)
    expect(row.blueprint.systemName).toBe('Muvolailen')
    expect(row.salesTaxPercent).toBeCloseTo(3.375)
    expect(row.salesTax).toBeCloseTo(16.875)
    expect(row.installationCost).toBeCloseTo(110 * 0.1425)
    expect(row.repeatProfit).toBeCloseTo(277.45)
    expect(row.profit).toBeCloseTo(187.45)
    expect(row.capitalRequired).toBeCloseTo(295.675)
    expect(row.marketReady).toBe(true)
    expect(row.hours).toBeCloseTo(2 * 0.8 * 0.85)
    expect(row.breakEvenBatches).toBe(1)
    // maxProductionLimit is a copying limit, NOT a manufacturing BPO run cap.
    expect(row.runs).toBeGreaterThan(recipe.maxRuns)
  })
  it('never prices unfilled material or output as a complete profitable batch', () => {
    const data = input(); data.buyOrders.set(34, [order(34, 5, false, 1)])
    const missingMaterial = calculateIndustryOpportunity(data)
    expect(missingMaterial.materialCost).toBeNull(); expect(missingMaterial.profit).toBeNull(); expect(missingMaterial.marketReady).toBe(false)
    const other = input(); other.sellOrders.set(100, [order(100, 30, true, 1)])
    const missingBuyer = calculateIndustryOpportunity(other)
    expect(missingBuyer.grossRevenue).toBeNull(); expect(missingBuyer.profit).toBeNull(); expect(missingBuyer.outputFill.filledQuantity).toBe(1)
  })
  it('does not invent free BPOs or adjusted prices', () => {
    const a = input(); a.blueprintOrders.clear()
    const unavailable = calculateIndustryOpportunity(a)
    expect(unavailable.profit).toBeNull(); expect(unavailable.repeatProfit).toBeNull()
    expect(industrySalesView(unavailable, 'buy', 3).repeatProfit).toBeNull()
    expect(industrySalesView(unavailable, 'sell', 3).repeatProfit).toBeNull()
    const b = input(); b.adjustedPrices.delete(35)
    expect(calculateIndustryOpportunity(b).installationCost).toBeNull()
    expect(calculateIndustryOpportunity(b).profit).toBeNull()
  })
  it('uses owned ME/TE, never discounts a one-per-run material, and keeps EIV unmodified', () => {
    const row = calculateIndustryOpportunity({ ...input(), request: { ...request, blueprintMode: 'owned' }, ownedBlueprint: ownIndustryBlueprint })
    expect(row.materials.map(m => m.quantity)).toEqual([18, 2])
    expect(row.materialCost).toBe(166); expect(row.blueprint.cost).toBe(0)
    expect(row.installationCost).toBeCloseTo(110 * 0.1425)
    expect(row.hours).toBeCloseTo(2 * 0.8 * 0.85 * 0.8)
    expect(row.profit).toBe(row.repeatProfit)
  })
  it('adds factory tax and Alpha surcharge directly to EIV, bonuses only to SCI', () => {
    const row = calculateIndustryOpportunity({ ...input(), request: { ...request, clone: 'alpha', jobCostReductionPercent: 50, facilityTaxPercent: 1 } })
    expect(row.installationCost).toBeCloseTo(110 * (0.1 * 0.5 + 0.01 + 0.04 + 0.0025))
  })
  it('blocks exhausted/busy BPC and batches longer than 30 days', () => {
    const own = { ...ownIndustryBlueprint, quantity: -2, runs: 1 }
    expect(calculateIndustryOpportunity({ ...input(), request: { ...request, blueprintMode: 'owned' }, ownedBlueprint: own }).marketReady).toBe(false)
    expect(calculateIndustryOpportunity({ ...input(), request: { ...request, blueprintMode: 'owned' }, ownedBlueprint: ownIndustryBlueprint, busyBlueprintIds: new Set([ownIndustryBlueprint.itemId]) }).marketReady).toBe(false)
    expect(calculateIndustryOpportunity({ ...input(), recipe: { ...recipe, time: 3600 * 1000 } }).marketReady).toBe(false)
  })
  it('applies active (not trained) skills, including recursive prerequisites', () => {
    const levels = industrySkillLevels([{ typeId: 3380, activeLevel: 1, trainedLevel: 5 }, { typeId: 3388, activeLevel: 0, trainedLevel: 5 }, { typeId: 16622, activeLevel: 0, trainedLevel: 5 }])
    expect(industrySalesTaxPercent(levels)).toBe(7.5)
    const missing = missingIndustrySkills({ ...recipe, skills: [{ typeId: 3388, level: 1 }] }, levels, catalog.skills)
    expect(missing).toEqual(expect.arrayContaining([expect.objectContaining({ typeId: 3380, required: 3, active: 1 }), expect.objectContaining({ typeId: 3388, active: 0 })]))
    const row = calculateIndustryOpportunity({ ...input(), skills: [] })
    expect(row.marketReady).toBe(false)
  })
  it('uses blueprint-specific science bonuses only for directly required skills', () => {
    const definitions = { ...catalog.skills, 999: { name: 'Science', nameRu: '', required: [], timeBonus: -1 } }
    const levels = new Map([[3380, 5], [3388, 5], [999, 5]])
    expect(manufacturingHours(recipe, 2, 0, 0, levels, definitions)).toBeCloseTo(1.36)
    expect(manufacturingHours({ ...recipe, skills: [...recipe.skills, { typeId: 999, level: 1 }] }, 2, 0, 0, levels, definitions)).toBeCloseTo(1.36 * 0.95)
    expect(manufacturingQuantity(100, 10, 10, 2)).toBe(882)
    expect(manufacturingQuantity(1, 10, 10, 2)).toBe(10)
  })
  it('accounts for manufacturing slots and paused jobs honestly', () => {
    expect(industrySlots([{ typeId: 3387, activeLevel: 3, trainedLevel: 5 }, { typeId: 24625, activeLevel: 0, trainedLevel: 5 }])).toBe(4)
    const job = { status: 'active', endDate: '2026-09-30T00:00:00Z' } as IndustryJob
    expect(jobReadyToDeliver(job, Date.parse('2026-10-01T00:00:00Z'))).toBe(true)
    expect(jobReadyToDeliver({ ...job, status: 'paused' }, Date.parse('2026-10-01T00:00:00Z'))).toBe(false)
  })
  it.each([{ ...request, productionQuantity: 0 }, { ...request, productionQuantity: 1.5 }, { ...request, productionQuantity: 100001 }, { ...request, salesMode: 'instant-sell' }, { ...request, brokerFeePercent: NaN }, { ...request, brokerFeePercent: -1 }, { ...request, runs: 0 }, { ...request, runs: 1.5 }, { ...request, transportCost: NaN }, { ...request, buyHubId: 'evil' }, { ...request, blueprintHubIds: [] }, { ...request, productionSystem: '\0' }, { ...request, accessToken: 'injected' }, { ...request, timeReductionPercent: 100 }, { ...request, forceRefresh: 'true' }])('validates all IPC inputs', invalid => {
    expect(() => validateIndustryRequest(invalid)).toThrow()
  })
})
