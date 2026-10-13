import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MASS_SETTINGS, industryMassTotals, industryMassReasons, massJobCashProfit, planIndustryMassProduction, quoteIndustryMassJob, type IndustryMassSource, type IndustryQuoteInput } from '../src/shared/industry-mass'
import { validateIndustryRequest, type IndustryCharacterSnapshot, type IndustryLiquidity } from '../src/shared/industry'
import { validateIndustryMonitor, DEFAULT_INDUSTRY_MONITOR } from '../src/shared/industry-monitor'
import { IndustryMassPanel, IndustryMassJobCard } from '../src/renderer/src/IndustryMassPanel'
import { industryCatalog as catalog, industryRecipe as recipe, industryRequest as request, industrySkills as skills, industryOrder as order } from './industry-fixtures'

const settings = { ...DEFAULT_MASS_SETTINGS }
const character: IndustryCharacterSnapshot = { characterId: 901, characterName: 'test', skills: [...skills, { typeId: 3387, activeLevel: 5, trainedLevel: 5 }, { typeId: 24625, activeLevel: 3, trainedLevel: 3 }], blueprints: [], jobs: [], missingScopes: [], warnings: [], fetchedAt: '2026-10-11T00:00:00Z' }
const history: IndustryLiquidity = { typeId: 100, regionId: 10000002, through: '2026-10-10', fetchedAt: '2026-10-11T00:00:00Z', daily7: 100000, daily30: 100000, volume30: 3000000, activeDays30: 30, lastTrade: '2026-10-10', stale: false }
function input(id = 1): IndustryQuoteInput {
  return { recipe, catalog, request: { ...request, blueprintMode: 'contracts', productionSystem: 'Jita' }, skills: character.skills!, systemCostIndex: 0.1,
    contractBlueprint: { contractId: id, typeId: 101, price: 100, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '', copy: true, me: 0, te: 0, runs: 100, bundled: false },
    buyOrders: new Map([[34, [order(34, 5, false, 1000000)]], [35, [order(35, 20, false, 1000000)]]]), sellOrders: new Map([[100, [order(100, 30, true, 1000000), order(100, 40, false, 1000000)]]]), blueprintOrders: new Map(), adjustedPrices: new Map([[34, 4], [35, 15]]) }
}
function source(id: number, options = input(id), config = settings, capacity = 1): IndustryMassSource { return { key: `contract:${id}`, capacity, input: options, quote: quoteIndustryMassJob(options, config) } }
describe('mass production on distinct lines', () => {
  it('fills nine lines with nine real copies, long jobs and a single transport charge', () => {
    const sources = Array.from({ length: 9 }, (_, i) => source(i + 1))
    const p = planIndustryMassProduction(sources, sources[0].input, settings, character, [history])
    expect(p.jobs).toHaveLength(9)
    expect(new Set(p.jobs.map(j => j.sourceKey)).size).toBe(9)
    expect(p.jobs.every(j => j.quote.runs === 35 && j.quote.hours >= 4 && j.quote.hours <= 24)).toBe(true)
    expect(p.totals.products[0].quantity).toBe(3150)
    expect(p.totals.materials.find(m => m.typeId === 34)?.quantity).toBe(3150)
    expect(p.totals.blueprintPurchase).toBe(900)
    expect(p.totals.transportCost).toBe(10)
    expect(p.totals.hours).toBeCloseTo(23.8)
    expect(p.totals.slotHours).toBeCloseTo(214.2)
    expect(p.totals.cashProfit).toBeCloseTo(p.totals.buyNet! - p.totals.capital!)
    expect(p.totals.economicProfit).toBeGreaterThan(p.totals.cashProfit!)
  })
  it('never repeats one BPC/BPO on nine parallel lines or invents additional market originals', () => {
    expect(planIndustryMassProduction([source(1)], input(), settings, character, [history]).jobs).toHaveLength(1)
    const market = { ...input(), contractBlueprint: undefined, request: { ...request, blueprintMode: 'buy' as const }, blueprintOrders: new Map([[101, [order(101, 100, false, 2)]]]) }
    const s = { ...source(1, market), key: 'market:1', capacity: 2 }
    const p = planIndustryMassProduction([s], market, settings, character, [history])
    expect(p.jobs).toHaveLength(2); expect(p.totals.blueprintPurchase).toBe(200)
  })
  it('shares finite materials and BUY volume across all jobs, shrinking to whole long runs', () => {
    const config = { ...settings, hours: 7 }
    const options = input(); options.buyOrders.set(34, [order(34, 5, false, 180)])
    options.sellOrders.set(100, [order(100, 30, true, 180), order(100, 40)])
    const p = planIndustryMassProduction(Array.from({ length: 9 }, (_, i) => source(i, { ...options, contractBlueprint: { ...options.contractBlueprint!, contractId: i + 1 } }, config)), options, config, character, [history])
    expect(p.jobs.map(j => j.quote.runs)).toEqual([10, 8])
    expect(p.totals.products[0].quantity).toBe(180)
    expect(p.totals.materials[0].quantity).toBe(180)
    expect(p.totals.complete).toBe(true)
  })
  it('reprices the entire shared basket at a common limit after adding a job', () => {
    const config = { ...settings, hours: 7 }, options = input()
    options.buyOrders.set(34, [order(34, 5, false, 100), order(34, 7, false, 100)])
    const a = source(1, options, config), b = source(2, { ...options, contractBlueprint: { ...options.contractBlueprint!, contractId: 2 } }, config)
    const t = industryMassTotals([{ sourceKey: a.key, quote: a.quote }, { sourceKey: b.key, quote: b.quote }], options, config, new Map([[100, history]]))
    expect(a.quote.materialCost).toBe(700)
    expect(t.materialCost).toBe(1800)
    expect(t.materials.find(m => m.typeId === 34)?.fill.orderLimitPrice).toBe(7)
  })
  it('applies one joint budget including full contracts, job taxes and transport', () => {
    const config = { ...settings, hours: 7, budget: 1000 }, sources = Array.from({ length: 9 }, (_, i) => source(i, input(i), config))
    const p = planIndustryMassProduction(sources, input(), config, character, [history])
    expect(p.jobs).toHaveLength(1)
    expect(p.totals.capital).toBeLessThanOrEqual(1000)
    expect(p.totals.capital).toBeCloseTo(700 + 78.375 + 100 + 10)
  })
  it('rejects tiny jobs and a single monthly trade even with deep current BUY orders', () => {
    const short = { ...input(), contractBlueprint: { ...input().contractBlueprint!, runs: 1 } }
    expect(industryMassReasons(quoteIndustryMassJob(short, settings), settings).join(' ')).toContain('хотя бы 2')
    const rare = { ...history, daily7: 0, daily30: 1 / 30, volume30: 1, activeDays30: 1 }
    expect(planIndustryMassProduction([source(1)], input(), settings, character, [rare]).jobs).toEqual([])
    expect(planIndustryMassProduction([source(1)], input(), settings, character, []).jobs).toEqual([])
    expect(planIndustryMassProduction([source(1)], input(), settings, character, [{ ...history, stale: true }]).jobs).toEqual([])
  })
  it('caps shared product demand using the lower seven/thirty-day average', () => {
    const config = { ...settings, hours: 7 }, sources = Array.from({ length: 9 }, (_, i) => source(i, input(i), config))
    const p = planIndustryMassProduction(sources, input(), config, character, [{ ...history, daily7: 720, daily30: 10000 }])
    expect(p.jobs.map(j => j.quote.runs)).toEqual([10, 8])
    expect(p.totals.products[0].demandCap).toBe(180)
  })
  it('keeps thin marginal BUY price levels from turning the joint plan unprofitable', () => {
    const config = { ...settings, hours: 7 }, options = input()
    options.sellOrders.set(100, [order(100, 30, true, 100), order(100, 0.01, true, 10000), order(100, 40)])
    const p = planIndustryMassProduction([source(1, options, config), source(2, options, config)], options, config, character, [history])
    expect(p.jobs).toHaveLength(1); expect(p.totals.cashProfit).toBeGreaterThan(0)
  })
  it('finds a long profitable BUY boundary without reverting to one-run hourly profits', () => {
    const options = input()
    options.sellOrders.set(100, [order(100, 30, true, 200), order(100, 0.01, true, 10000), order(100, 40)])
    const q = quoteIndustryMassJob(options, settings)
    expect(q.runs).toBe(20); expect(q.hours).toBeGreaterThan(4)
    expect(massJobCashProfit(q)).toBeGreaterThan(0)
  })
  it('does not call unspent BPC runs free cash or ignore a new BPO purchase', () => {
    const options = input(); options.contractBlueprint = { ...options.contractBlueprint!, price: 10000, runs: 1000 }
    const q = quoteIndustryMassJob(options, settings)
    expect(q.repeatProfit).toBeGreaterThan(0); expect(massJobCashProfit(q)).toBeLessThan(0)
    expect(planIndustryMassProduction([source(1, options)], options, settings, character, [history]).jobs).toEqual([])
  })
  it('reports real skill capacity, occupied/unknown lines and never labels nine lines immediately free', () => {
    const sources = Array.from({ length: 9 }, (_, i) => source(i))
    const p = planIndustryMassProduction(sources, input(), settings, { ...character, skills }, [history])
    expect(p.characterLines).toBe(1); expect(p.jobs).toHaveLength(1)
    expect(planIndustryMassProduction(sources, input(), settings, { ...character, jobs: null }, [history]).freeNow).toBeNull()
    const busy = planIndustryMassProduction(sources, input(), settings, { ...character, jobs: [{ activityId: 1, status: 'ready' } as never] }, [history])
    expect(busy.freeNow).toBe(8)
    expect(busy.warnings.join(' ')).toContain('дождаться')
  })
  it('validates mass options and keeps monitor strictly one-run without inherited mass settings', () => {
    expect(validateIndustryRequest({ ...request, massProduction: settings }).massProduction?.lines).toBe(9)
    for (const invalid of [{ lines: 99 }, { hours: NaN }, { minimumHours: 25 }, { minimumRuns: 1 }, { budget: -1 }, { maximumDailySharePercent: 0 }, { unknown: true }]) expect(() => validateIndustryRequest({ ...request, massProduction: { ...settings, ...invalid } })).toThrow()
    const monitor = validateIndustryMonitor({ ...DEFAULT_INDUSTRY_MONITOR, request: { ...request, massProduction: settings } })
    expect(monitor.request).toMatchObject({ runs: 1, autoPlan: false, contractCopiesOnly: true })
    expect(monitor.request.massProduction).toBeUndefined()
  })
  it('renders whole-plan metrics, source identities, haul volumes and joint Multibuy', () => {
    const p = planIndustryMassProduction([source(1)], input(), settings, character, [history])
    const html = renderToStaticMarkup(<IndustryMassPanel plan={p} stale />)
    for (const text of ['План на 9', '1/9 заполнено', 'Общий список Multibuy', 'Скопировать общую закупку', 'слот·ч', 'м³', 'Контракт #1', 'вся покупка чертежей', 'план ещё старый']) expect(html).toContain(text)
    const card = renderToStaticMarkup(<IndustryMassJobCard row={p.jobs[0].quote} settings={settings} liquidity={history} brokerFeePercent={3} />)
    expect(card).toContain('35 прогонов'); expect(card).toContain('Не умножайте на 9')
    expect(card).toContain('SELL результат')
  })
})
