import { describe, expect, it } from 'vitest'
import { Cache } from '../src/main/cache'
import { IndustryProductionService } from '../src/main/industry-production-service'
import { industryProducedJob, industryProducedView, industryProducedViews, validateProductionCost, type IndustryProductionCost, type IndustryProductionPricing } from '../src/shared/industry-production'
import { INDUSTRY_SKILL_IDS, type IndustryJob } from '../src/shared/industry'
import { industryCatalog as catalog, industryPurchase as purchase, ownIndustryBlueprint, industryOrder } from './industry-fixtures'

const job: IndustryJob = { jobId: 1, activityId: 1, blueprintTypeId: 101, blueprintItemId: 123, productTypeId: 100, runs: 2, status: 'delivered', startDate: '2026-10-02T00:00:00Z', endDate: '2026-10-03T00:00:00Z', facilityId: 60003760, stationId: 60003760, cost: 123 }
const record = industryProducedJob(job, catalog, job.startDate)!
const purchases = [{ ...purchase, typeName: 'Tritanium' }, { ...purchase, transactionId: 12, typeId: 35, quantity: 2, unitPrice: 10, typeName: 'Pyerite' }]
const cost: IndustryProductionCost = { jobId: 1, allocations: [{ transactionId: 11, quantity: 20 }, { transactionId: 12, quantity: 2 }], materialsConfirmed: true, blueprint: { kind: 'copy', contractId: 77, purchasePrice: 100, runsPurchased: 10 }, extraCost: 5 }
const pricing: IndustryProductionPricing = { orders: [], adjustedPrices: [], jitaCostIndex: null, fetchedAt: null }
describe('actual manufactured-product costing', () => {
  it('uses this character’s Accounting tax and falls back explicitly when skills are unavailable', async () => {
    const cache = new Cache(':memory:')
    let id = 901
    const service = new IndustryProductionService({
      getCharacter: async () => ({ characterId: id, characterName: 'test', skills: id === 901 ? [{ typeId: INDUSTRY_SKILL_IDS.accounting, activeLevel: 5, trainedLevel: 5 }] : null, jobs: [], blueprints: [], missingScopes: [], warnings: [], fetchedAt: new Date().toISOString() }),
      getLedger: async () => { throw new Error('offline') }
    }, cache, async () => id)
    const snapshot = await service.snapshot()
    expect(snapshot.salesTaxSource).toBe('skills')
    expect(snapshot.salesTaxPercent).toBeCloseTo(3.375)
    id = 902
    expect(await service.snapshot()).toMatchObject({ salesTaxPercent: 7.5, salesTaxSource: 'base' })
    cache.close()
  })
  it('derives output only from manufacturing jobs and catalog recipes, not Hangar stock', () => {
    expect(record.outputQuantity).toBe(20)
    expect(industryProducedJob({ ...job, activityId: 8 }, catalog, job.startDate)).toBeNull()
    expect(industryProducedJob({ ...job, productTypeId: 999 }, catalog, job.startDate)).toBeNull()
  })
  it('uses paid transaction prices, allocated BPC runs and the actual ESI job charge exactly once', () => {
    expect(validateProductionCost(cost, record, purchases, [record], [])).toEqual(cost)
    const view = industryProducedView(record, cost, purchases)
    expect(view.materialCost).toBe(60); expect(view.blueprintCost).toBe(20)
    expect(view.totalCost).toBe(208); expect(view.unitCost).toBe(10.4)
    expect(industryProducedView(record, { ...cost, blueprint: { ...cost.blueprint!, kind: 'original' } }, purchases).blueprintCost).toBe(0)
  })
  it('never replaces unknown job, material or blueprint costs with zero', () => {
    expect(industryProducedView(record, null, purchases).totalCost).toBeNull()
    expect(industryProducedView(record, { ...cost, materialsConfirmed: false }, purchases).totalCost).toBeNull()
    expect(industryProducedView(record, { ...cost, blueprint: null }, purchases).totalCost).toBeNull()
    expect(industryProducedView({ ...record, job: { ...job, cost: null } }, cost, purchases).totalCost).toBeNull()
  })
  it('rejects duplicate, sold, future, wrong-material and overallocated purchase quantities', () => {
    expect(() => validateProductionCost({ ...cost, allocations: [...cost.allocations, cost.allocations[0]] }, record, purchases, [record], [])).toThrow()
    expect(() => validateProductionCost(cost, record, purchases.map(p => ({ ...p, buy: false })), [record], [])).toThrow()
    expect(() => validateProductionCost(cost, record, purchases.map(p => ({ ...p, date: '2026-10-03T00:00:00Z' })), [record], [])).toThrow()
    expect(() => validateProductionCost(cost, record, purchases.map(p => ({ ...p, typeId: 999 })), [record], [])).toThrow()
    expect(() => validateProductionCost(cost, record, purchases, [record], [{ ...cost, jobId: 2 }])).toThrow(/уже списана/)
    expect(() => validateProductionCost({ ...cost, allocations: [cost.allocations[0]] }, record, purchases, [record], [])).toThrow(/всех материалов/)
  })
  it('prevents double consumption or inconsistent pricing of one BPC contract', () => {
    const second = { ...record, job: { ...job, jobId: 2, runs: 9 } }
    const empty = { ...cost, jobId: 2, allocations: [], materialsConfirmed: false }
    expect(() => validateProductionCost(empty, second, purchases, [record, second], [cost])).toThrow(/BPC уже списаны/)
    expect(() => validateProductionCost({ ...empty, blueprint: { ...cost.blueprint!, purchasePrice: 999 } }, second, purchases, [record, second], [cost])).toThrow(/одинаковую цену/)
    expect(() => validateProductionCost({ ...empty, blueprint: { ...cost.blueprint!, contractId: 88 } }, second, purchases, [record, second], [cost])).toThrow(/разные контракты/)
  })
  it('preserves production records on cache clear and isolates them by character', async () => {
    const cache = new Cache(':memory:')
    cache.saveIndustryRecord(901, 'production-job', '1', record)
    cache.saveIndustryTransactions(901, purchases, job.endDate)
    let id = 901
    const service = new IndustryProductionService({ getCharacter: async () => { throw new Error('offline') }, getLedger: async () => { throw new Error('offline') } }, cache, async () => id)
    await service.save(cost)
    cache.clear()
    const snapshot = await service.snapshot()
    expect(snapshot.rows[0].unitCost).toBe(10.4)
    expect(snapshot.warnings).toHaveLength(2)
    id = 902
    expect((await service.snapshot()).rows).toEqual([])
    await expect(service.save(cost)).rejects.toThrow('задание не найдено')
    cache.close()
  })
  it('does not call active or cancelled jobs finished goods', async () => {
    const cache = new Cache(':memory:')
    for (const [i, status] of ['active', 'cancelled', 'ready', 'delivered'].entries()) cache.saveIndustryRecord(901, 'production-job', String(i), { ...record, job: { ...job, jobId: i + 1, status } })
    const service = new IndustryProductionService({ getCharacter: async () => { throw new Error('offline') }, getLedger: async () => { throw new Error('offline') } }, cache, async () => 901)
    expect((await service.snapshot()).rows.map(r => r.job.status).sort()).toEqual(['delivered', 'ready'])
    cache.close()
  })
  it('automatically prices recipe quantities from pre-job purchases without any manual allocation', () => {
    const saved = { ...cost, allocations: [], materialsConfirmed: false, extraCost: 0, blueprint: { ...cost.blueprint!, contractId: null } }
    const [view] = industryProducedViews([record], [saved], purchases, pricing, catalog)
    expect(view.materialCost).toBe(60); expect(view.totalCost).toBe(203)
    expect(view.automatic?.materials.map(m => [m.quantity, m.source])).toEqual([[20, 'purchases'], [2, 'purchases']])
    expect(view.cost?.materialsConfirmed).toBe(false)
    expect(validateProductionCost(saved, record, purchases, [record], [])).toEqual(saved)
  })
  it('uses saved ME, rounded whole-batch quantities and preserves it on later jobs-only capture', () => {
    const known = industryProducedJob(job, catalog, job.startDate, { ...ownIndustryBlueprint, itemId: job.blueprintItemId })!
    expect(known.materialEfficiency).toBe(10)
    expect(known.materials.map(m => m.quantity)).toEqual([18, 2])
    expect(industryProducedJob(job, catalog, job.startDate, undefined, known)?.materials).toEqual(known.materials)
    expect(record.materials.map(m => m.quantity)).toEqual([20, 2])
  })
  it('does not double-debit the same purchase across jobs or pretend fallback prices were paid', () => {
    const second = { ...record, job: { ...job, jobId: 2, startDate: '2026-10-02T01:00:00Z' } }
    const rows = industryProducedViews([second, record], [], purchases, pricing, catalog)
    const first = rows.find(r => r.job.jobId === 1)!, next = rows.find(r => r.job.jobId === 2)!
    expect(first.automatic?.materials.every(m => m.source === 'purchases')).toBe(true)
    expect(next.automatic?.materials.every(m => m.source === 'purchase-estimate')).toBe(true)
    expect(next.materialCost).toBe(60)
    expect(next.automatic?.assumptions.join(' ')).toContain('без повторного списания')
    expect(next.totalCost).toBeNull() // BPC is never silently free.
  })
  it('prefers nearest purchases before the job and excludes future/non-personal/sell transactions', () => {
    const rows = [...purchases, { ...purchases[0], transactionId: 31, date: '2026-10-01T23:00:00Z', unitPrice: 3 }, { ...purchases[0], transactionId: 32, date: '2026-10-03T00:00:00Z', unitPrice: 1000 }, { ...purchases[0], transactionId: 33, date: '2026-10-01T23:30:00Z', personal: false, unitPrice: 500 }, { ...purchases[0], transactionId: 34, date: '2026-10-01T23:40:00Z', buy: false, unitPrice: 400 }]
    expect(industryProducedViews([record], [], rows, pricing, catalog)[0].materialCost).toBe(80)
  })
  it('marks current Jita SELL fallback and uses full-quantity limit pricing, not average/adjusted prices', () => {
    const current = { ...pricing, fetchedAt: '2026-10-10T00:00:00Z', orders: [industryOrder(34, 2, false, 10), industryOrder(34, 4, false, 10, { orderId: 999 }), industryOrder(35, 10), industryOrder(34, 0.1, false, 999, { locationId: 60000004 })] }
    const [view] = industryProducedViews([record], [], [], current, catalog)
    expect(view.materialCost).toBe(100)
    expect(view.automatic?.materials.every(m => m.source === 'jita-sell')).toBe(true)
    expect(view.automatic?.assumptions.join(' ')).toContain('не фактически уплаченная')
    expect(industryProducedViews([record], [], [], { ...current, orders: [] }, catalog)[0].materialCost).toBeNull()
  })
  it('uses an actual ESI charge once, with a labelled Jita base estimate only when it is absent', () => {
    const current = { ...pricing, jitaCostIndex: 0.1, adjustedPrices: [{ typeId: 34, adjustedPrice: 4 }, { typeId: 35, adjustedPrice: 15 }] }
    expect(industryProducedViews([record], [], purchases, current, catalog)[0].automatic?.jobCost).toBe(123)
    const [estimate] = industryProducedViews([{ ...record, job: { ...job, cost: null } }], [{ ...cost, allocations: [], materialsConfirmed: false, extraCost: 0 }], purchases, current, catalog)
    expect(estimate.automatic?.jobCost).toBeCloseTo(110 * (0.1 + 0.0025 + 0.04))
    expect(estimate.automatic?.jobCostSource).toBe('jita-estimate')
    expect(estimate.totalCost).toBeCloseTo(60 + 20 + 110 * 0.1425)
  })
  it('reuses a saved BPC price for the same item without contract ID and without exceeding its run budget', () => {
    const saved = { ...cost, allocations: [], materialsConfirmed: false, extraCost: 0, blueprint: { ...cost.blueprint!, contractId: null } }
    const second = { ...record, job: { ...job, jobId: 2 } }
    const rows = industryProducedViews([record, second], [saved], purchases, pricing, catalog)
    expect(rows.find(r => r.job.jobId === 2)?.blueprintCost).toBe(20)
    expect(industryProducedViews([record, { ...second, job: { ...second.job, runs: 9 } }], [saved], purchases, pricing, catalog).find(r => r.job.jobId === 2)?.blueprintCost).toBeNull()
    expect(industryProducedViews([record, { ...second, job: { ...second.job, blueprintItemId: 999 } }], [saved], purchases, pricing, catalog).find(r => r.job.jobId === 2)?.blueprintCost).toBeNull()
  })
  it('hydrates legacy stored jobs and saves only BPC cost without asking for material allocations', async () => {
    const cache = new Cache(':memory:')
    const { materialEfficiency: _me, ...legacy } = record
    cache.saveIndustryRecord(901, 'production-job', '1', { ...legacy, materials: record.materials.map(({ typeId, name }) => ({ typeId, name })) })
    cache.saveIndustryTransactions(901, purchases, job.endDate)
    const priceSpy = async (): Promise<IndustryProductionPricing> => { throw new Error('Should not need a current market quote') }
    const service = new IndustryProductionService({ getCharacter: async () => { throw new Error('offline') }, getLedger: async () => { throw new Error('offline') }, getProductionPricing: priceSpy }, cache, async () => 901, catalog)
    const snapshot = await service.save({ ...cost, allocations: [], materialsConfirmed: false, blueprint: { ...cost.blueprint!, contractId: null }, extraCost: 0 })
    expect(snapshot.rows[0].totalCost).toBe(203)
    expect(snapshot.rows[0].automatic?.materials.map(m => m.quantity)).toEqual([20, 2])
    expect(snapshot.warnings).toEqual([])
    cache.close()
  })
  it('requests fallback pricing only when needed and never returns another character’s pricing result', async () => {
    const cache = new Cache(':memory:')
    cache.saveIndustryRecord(901, 'production-job', '1', { ...record, job: { ...job, cost: null } })
    let id = 901
    const service = new IndustryProductionService({ getCharacter: async () => { throw new Error('offline') }, getLedger: async () => { throw new Error('offline') }, getProductionPricing: async (missing, fee) => { expect(missing).toEqual([34, 35]); expect(fee).toBe(true); id = 902; return pricing } }, cache, async () => id, catalog)
    await expect(service.snapshot()).rejects.toThrow('Персонаж изменился')
    cache.close()
  })
})
