import type { Cache } from './cache'
import type { IndustryService } from './industry-service'
import { industryProducedJob, industryProducedViews, validateProductionCost, type IndustryProducedJob, type IndustryProductionCost, type IndustryProductionPricing, type IndustryProductionSnapshot } from '../shared/industry-production'
import { industrySalesTaxPercent, industrySkillLevels, type IndustryCatalog } from '../shared/industry'

export class IndustryProductionService {
  private timer: ReturnType<typeof setInterval> | null = null
  private controller: AbortController | null = null
  private salesTaxes = new Map<number, { salesTaxPercent: number; salesTaxSource: 'skills' | 'base' }>()
  constructor(private readonly service: Pick<IndustryService, 'getCharacter' | 'getLedger'> & Partial<Pick<IndustryService, 'captureJobs' | 'getProductionPricing'>>, private readonly cache: Cache, private readonly identity: () => Promise<number | null>, private readonly catalog?: IndustryCatalog) {}
  start(): void {
    if (this.timer || !this.service.captureJobs) return
    const capture = (): void => {
      if (this.controller) return
      const controller = new AbortController(); this.controller = controller
      void this.service.captureJobs!(controller.signal).catch(() => {}).finally(() => { if (this.controller === controller) this.controller = null })
    }
    this.timer = setInterval(capture, 300000); this.timer.unref?.(); capture()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.controller?.abort() }
  async snapshot(forceRefresh = false): Promise<IndustryProductionSnapshot> {
    const id = await this.identity()
    if (!id) throw new Error('Войдите в EVE SSO для готовой продукции')
    const warnings: string[] = []
    try { const character = await this.service.getCharacter(forceRefresh); warnings.push(...character.warnings); this.salesTaxes.set(id, { salesTaxPercent: character.skills ? industrySalesTaxPercent(industrySkillLevels(character.skills)) : 7.5, salesTaxSource: character.skills ? 'skills' : 'base' }); if (!character.jobs) warnings.push('Задания ESI недоступны; показана сохранённая история.') } catch { warnings.push('ESI заданий недоступен; показана сохранённая история.') }
    try { const ledger = await this.service.getLedger(forceRefresh); warnings.push(...ledger.warnings) } catch { warnings.push('Новые покупки недоступны; используются сохранённые сделки.') }
    if (await this.identity() !== id) throw new Error('Персонаж изменился — обновите вкладку')
    return this.read(id, warnings, forceRefresh)
  }
  async save(value: unknown): Promise<IndustryProductionSnapshot> {
    const id = await this.identity()
    if (!id) throw new Error('Войдите в EVE SSO')
    const jobId = (value as IndustryProductionCost | null)?.jobId
    const jobs = this.cache.getIndustryRecords<IndustryProducedJob>(id, 'production-job').map(r => r.value)
    const job = jobs.find(r => r.job.jobId === jobId)
    if (!job) throw new Error('Подтверждённое производственное задание не найдено')
    const existing = this.cache.getIndustryRecords<IndustryProductionCost>(id, 'production-cost').map(r => r.value)
    const purchases = this.purchases(id)
    const cost = validateProductionCost(value, job, purchases, jobs, existing)
    this.cache.saveIndustryRecord(id, 'production-cost', String(cost.jobId), { ...cost, updatedAt: new Date().toISOString() })
    return this.read(id, [])
  }
  private purchases(id: number) { return this.cache.getIndustryTransactions(id).transactions.map(p => ({ ...p, typeName: `Type #${p.typeId}` })) }
  private async read(id: number, warnings: string[], forceRefresh = false): Promise<IndustryProductionSnapshot> {
    const jobs = this.cache.getIndustryRecords<IndustryProducedJob>(id, 'production-job').map(r => this.catalog ? industryProducedJob(r.value.job, this.catalog, r.value.firstSeen, undefined, r.value) ?? r.value : r.value)
    const costs = this.cache.getIndustryRecords<IndustryProductionCost>(id, 'production-cost').map(r => r.value)
    const purchases = this.purchases(id)
    let pricing: IndustryProductionPricing = { orders: [], adjustedPrices: [], jitaCostIndex: null, fetchedAt: null }
    const finished = jobs.filter(j => ['delivered', 'ready'].includes(j.job.status))
    const missingTypeIds = [...new Set(finished.filter(j => !costs.find(c => c.jobId === j.job.jobId)?.materialsConfirmed).flatMap(j => j.materials.filter(m => !purchases.some(p => p.typeId === m.typeId && p.buy && p.personal && Date.parse(p.date) <= Date.parse(j.job.startDate))).map(m => m.typeId)))]
    if (this.service.getProductionPricing && (missingTypeIds.length || finished.some(j => j.job.cost === null))) {
      try { pricing = await this.service.getProductionPricing(missingTypeIds, finished.some(j => j.job.cost === null), forceRefresh) }
      catch { warnings.push('Текущая оценка Jita недоступна. Сохранённые цены покупок и фактический запуск ESI продолжают использоваться.') }
    }
    if (await this.identity() !== id) throw new Error('Персонаж изменился — обновите вкладку')
    return { characterId: id, rows: industryProducedViews(jobs, costs, purchases, pricing, this.catalog), purchases, warnings, syncedAt: this.cache.getIndustryTransactions(id).syncedAt, ...(this.salesTaxes.get(id) ?? { salesTaxPercent: 7.5, salesTaxSource: 'base' as const }) }
  }
}
