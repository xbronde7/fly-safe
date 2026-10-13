import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cache } from '../src/main/cache'
import { industryPurchaseBasis, industryPurchaseQuote, industryMaterialCostView } from '../src/shared/industry-ledger'
import { calculateIndustryOpportunity, industrySalesView } from '../src/shared/industry'
import { industryCatalog as catalog, industryRecipe as recipe, industryRequest as request, industrySkills as skills, industryOrder as order } from './industry-fixtures'

import { industryPurchase as purchase } from './industry-fixtures'
const quote = () => calculateIndustryOpportunity({ recipe, catalog, request, skills, systemCostIndex: 0.1,
  buyOrders: new Map([[34, [order(34, 5)]], [35, [order(35, 20)]]]), sellOrders: new Map([[100, [order(100, 30, true)]]]),
  blueprintOrders: new Map([[101, [order(101, 100)]]]), adjustedPrices: new Map([[34, 4], [35, 15]]) })
describe('manufacturing purchase ledger', () => {
  const stockQuote = (stock: ReadonlyMap<number, number>, orders = [order(34, 5)]) => calculateIndustryOpportunity({ recipe, catalog, request, skills, stock, systemCostIndex: 0.1,
    buyOrders: new Map([[34, orders], [35, [order(35, 20)]]]), sellOrders: new Map([[100, [order(100, 30, true)]]]),
    blueprintOrders: new Map([[101, [order(101, 100)]]]), adjustedPrices: new Map([[34, 4], [35, 15]]) })
  it('keeps market-only cost and profit even with no wallet history', () => {
    const row = quote()
    const result = industryPurchaseQuote(row, new Map(), 'repeat', 'market')
    expect(result.materialCost).toBe(row.materialCost); expect(result.profit).toBe(row.repeatProfit)
    expect(industryMaterialCostView(row, new Map(), 'market')).toBe(row)
  })
  it('does not restore profit for a blueprint with no available offer', () => {
    const original = quote()
    const row = { ...original, blueprint: { ...original.blueprint, cost: null, purchaseCost: null } }
    expect(industryPurchaseQuote(row, new Map(), 'repeat', 'market').profit).toBeNull()
    expect(industryMaterialCostView(row, new Map(), 'mixed').repeatProfit).toBeNull()
  })
  it('prices only actual stock at purchase cost and buys the deficit from exact cheapest depth', () => {
    const row = stockQuote(new Map([[34, 10]]), [order(34, 5, false, 5), order(34, 10, false, 100)])
    const purchases = industryPurchaseBasis([purchase], '2026-09-30')
    const mixed = industryPurchaseQuote(row, purchases, 'repeat', 'mixed')
    expect(mixed.materials[0]).toMatchObject({ ownQuantity: 10, historicalQuantity: 10, marketQuantity: 10, ownCost: 20, marketCost: 100, cost: 120 })
    expect(mixed.materialCost).toBe(160)
    expect(mixed.marketCost).toBe(140)
    const display = industryMaterialCostView(row, purchases, 'mixed')
    expect(display.repeatProfit).toBeCloseTo(mixed.profit!)
    expect(display.materialCost).toBe(160)
    expect(display.capitalRequired).toBeCloseTo(140 + row.installationCost! + row.blueprint.purchaseCost! + row.transportCost)
  })
  it('does not turn historical purchase quantity into inventory', () => {
    const row = stockQuote(new Map())
    const mixed = industryPurchaseQuote(row, industryPurchaseBasis([purchase], '2026-09-30'), 'repeat', 'mixed')
    expect(mixed.materials[0].ownQuantity).toBe(0)
    expect(mixed.materialCost).toBe(row.materialCost)
  })
  it('falls back to market value for unpriced own stock, never treating it as free', () => {
    const row = stockQuote(new Map([[34, 10]]))
    const mixed = industryPurchaseQuote(row, new Map(), 'repeat', 'mixed')
    expect(mixed.materials[0]).toMatchObject({ historicalQuantity: 0, valuedQuantity: 10, ownCost: 50, marketCost: 50, cost: 100 })
    expect(mixed.materialCost).toBe(row.materialCost)
    expect(industryMaterialCostView(row, new Map(), 'mixed').warnings.join(' ')).toContain('не нулевая')
  })
  it('can complete a batch with purchased stock when the full market recipe lacks volume', () => {
    const row = stockQuote(new Map([[34, 10]]), [order(34, 5, false, 10)])
    expect(row.materialCost).toBeNull()
    const display = industryMaterialCostView(row, industryPurchaseBasis([purchase], '2026-09-30'), 'mixed')
    expect(display.materialCost).toBe(110)
    expect(display.profit).not.toBeNull(); expect(display.marketReady).toBe(true)
    expect(display.maxFeasibleRuns).toBe(row.runs)
  })
  it('does not fake completion when the remaining market quantity violates minimum lots', () => {
    const row = stockQuote(new Map([[34, 15]]), [order(34, 5, false, 100, { minVolume: 10 })])
    expect(row.materialCost).not.toBeNull()
    const display = industryMaterialCostView(row, industryPurchaseBasis([purchase], '2026-09-30'), 'mixed')
    expect(display.materialCost).toBeNull(); expect(display.profit).toBeNull(); expect(display.marketReady).toBe(false)
    expect(display.warnings.join(' ')).toContain('на закупку: 5')
  })
  it('uses market cost rather than stale inventory after a location change or missing asset scope', () => {
    const row = stockQuote(new Map([[34, 10]]))
    const purchases = industryPurchaseBasis([purchase], '2026-09-30')
    expect(industryMaterialCostView(row, purchases, 'mixed', 123).materialCost).toBe(row.materialCost)
    expect(industryMaterialCostView(quote(), purchases, 'mixed').materialCost).toBe(quote().materialCost)
    expect(industryMaterialCostView(row, purchases, 'mixed', 123).warnings.join(' ')).toContain('Пересчитайте')
  })
  it('deduplicates immutable deals, isolates characters, persists across restart and cache clearing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'industry-ledger-test-'))
    const file = join(dir, 'test.sqlite')
    let cache = new Cache(file)
    try {
      cache.saveIndustryTransactions(901, [purchase, { ...purchase, transactionId: 12, personal: false }], purchase.date)
      cache.saveIndustryTransactions(901, [purchase, { ...purchase, unitPrice: 99 }], purchase.date)
      cache.saveIndustryTransactions(902, [{ ...purchase, unitPrice: 10 }], purchase.date)
      cache.set('temp', '1', 1, 1000); cache.clear(); cache.purgeExpired()
      cache.close(); cache = new Cache(file)
      expect(cache.getIndustryTransactions(901)).toEqual({ transactions: [purchase], syncedAt: purchase.date })
      expect(cache.getIndustryTransactions(902).transactions[0].unitPrice).toBe(10)
      expect(cache.getIndustryTransactions(903).transactions).toEqual([])
      expect(cache.count()).toBe(0)
    } finally { cache.close(); rmSync(dir, { recursive: true }) }
  })
  it('rejects malformed imports atomically without overwriting the successful sync date', () => {
    const cache = new Cache(':memory:')
    try {
      cache.saveIndustryTransactions(901, [purchase], purchase.date)
      expect(() => cache.saveIndustryTransactions(901, [{ ...purchase, transactionId: 99 }, { ...purchase, unitPrice: -1 }], '2026-10-02T00:00:00Z')).toThrow()
      expect(cache.getIndustryTransactions(901).transactions).toHaveLength(1)
      expect(cache.getIndustryTransactions(901).syncedAt).toBe(purchase.date)
    } finally { cache.close() }
  })
  it('uses weighted executed purchase prices and selected period, not sales or corporate deals', () => {
    const purchases = industryPurchaseBasis([purchase, { ...purchase, transactionId: 12, quantity: 10, unitPrice: 5 },
      { ...purchase, buy: false, unitPrice: 100 }, { ...purchase, personal: false }, { ...purchase, date: '2026-09-01T00:00:00Z' }], '2026-09-30')
    expect(purchases.get(34)).toEqual({ quantity: 30, total: 90, unitPrice: 3 })
    expect(industryPurchaseBasis([purchase], '')).toHaveLength(0)
  })
  it('reports unknown cost when one material lacks enough recorded purchases, never zero', () => {
    const row = quote()
    const missing = industryPurchaseQuote(row, industryPurchaseBasis([purchase], '2026-09-30'), 'repeat')
    expect(missing.materialCost).toBeNull(); expect(missing.profit).toBeNull()
    const partial = industryPurchaseQuote(row, industryPurchaseBasis([{ ...purchase, quantity: 1 }], '2026-09-30'), 'repeat')
    expect(partial.materials[0].cost).toBeNull()
  })
  it('changes only material cost, keeping tax, installation, delivery and blueprint accounting', () => {
    const row = quote()
    const purchases = industryPurchaseBasis([purchase, { ...purchase, transactionId: 12, typeId: 35, quantity: 2, unitPrice: 10 }], '2026-09-30')
    const first = industryPurchaseQuote(row, purchases, 'first')
    const repeat = industryPurchaseQuote(row, purchases, 'repeat')
    expect(first.materialCost).toBe(60)
    expect(first.profit).toBeCloseTo(row.profit! + row.materialCost! - 60)
    expect(repeat.profit! - first.profit!).toBe(100)
    expect(industryPurchaseQuote({ ...row, materialCost: null }, purchases, 'repeat').profit).toBe(repeat.profit)
    expect(industryPurchaseQuote({ ...row, grossRevenue: null }, purchases, 'repeat').profit).toBeNull()
    expect(industryPurchaseQuote({ ...row, blueprint: { ...row.blueprint, source: 'contract-copy', availableRuns: 1 } }, purchases, 'repeat').profit).toBeNull()
  })
  it('blocks invalid renderer-side brokerage before showing an inflated profit', () => {
    for (const fee of [-1, 11, NaN]) {
      const row = industrySalesView(quote(), 'sell', fee)
      expect(row.profit).toBeNull(); expect(row.brokerFee).toBeNull(); expect(row.marketReady).toBe(false)
    }
  })
})
