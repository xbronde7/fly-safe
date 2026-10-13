import { manufacturingQuantity, industryLimitFill, type IndustryBlueprint, type IndustryCatalog, type IndustryJob } from './industry'
import { summarizeMarketBook, type MarketHubQuote, type MarketOrder } from './market'
import type { IndustryLedgerTransaction } from './industry-ledger'

export interface IndustryProducedJob {
  job: IndustryJob; productName: string; outputQuantity: number
  materials: Array<{ typeId: number; name: string; quantity?: number }>; firstSeen: string
  materialEfficiency?: number | null
}
export interface IndustryProductionCost {
  jobId: number; allocations: Array<{ transactionId: number; quantity: number }>
  materialsConfirmed: boolean
  blueprint: { kind: 'copy' | 'original'; contractId: number | null; purchasePrice: number; runsPurchased: number } | null
  extraCost: number; updatedAt?: string
}
export interface IndustryProducedView extends IndustryProducedJob {
  cost: IndustryProductionCost | null; materialCost: number | null; blueprintCost: number | null
  totalCost: number | null; unitCost: number | null; missing: string[]
  automatic?: IndustryProductionAutomatic
}
export interface IndustryProductionPricing {
  orders: MarketOrder[]; adjustedPrices: Array<{ typeId: number; adjustedPrice: number | null }>
  jitaCostIndex: number | null; fetchedAt: string | null
}
export interface IndustryProductionAutomatic {
  materials: Array<{ typeId: number; name: string; quantity: number | null; total: number | null; source: 'purchases' | 'purchase-estimate' | 'jita-sell' | 'unknown'; pricedAt: string | null }>
  materialCost: number | null; jobCost: number | null; jobCostSource: 'esi' | 'jita-estimate' | 'unknown'
  assumptions: string[]
}
export interface IndustryProductionSnapshot {
  characterId: number; rows: IndustryProducedView[]; purchases: IndustryLedgerTransaction[]; warnings: string[]; syncedAt: string | null
  salesTaxPercent?: number
  salesTaxSource?: 'skills' | 'base'
}

export interface IndustryProductionMarketValue {
  buy: { unitPrice: number | null; gross: number | null; net: number | null; profit: number | null; filled: number; complete: boolean }
  sell: { unitPrice: number | null; gross: number | null; net: number | null; profit: number | null }
  salesTaxPercent: number; brokerFeePercent: number
}
/** Value the actual output batch. Never scale a thin top bid to unavailable volume. */
export function industryProductionMarketValue(row: IndustryProducedView, quote: MarketHubQuote, salesTaxPercent: number, brokerFeePercent = 3): IndustryProductionMarketValue {
  if (quote.typeId !== row.job.productTypeId || quote.quantity !== row.outputQuantity || !Number.isFinite(salesTaxPercent) || salesTaxPercent < 0 || salesTaxPercent > 100 || !Number.isFinite(brokerFeePercent) || brokerFeePercent < 0 || brokerFeePercent + salesTaxPercent > 100) throw new TypeError('Некорректная рыночная оценка партии')
  const fill = industryLimitFill(quote.book.immediateSell, 'sell')
  const buyGross = fill.complete ? fill.total : null
  const buyNet = buyGross === null ? null : buyGross * (1 - salesTaxPercent / 100)
  const sellGross = quote.book.bestSell === null ? null : quote.book.bestSell * row.outputQuantity
  const sellNet = sellGross === null ? null : sellGross * (1 - (salesTaxPercent + brokerFeePercent) / 100)
  return { buy: { unitPrice: fill.complete ? fill.orderLimitPrice ?? fill.averagePrice : null, gross: buyGross, net: buyNet, profit: buyNet === null || row.totalCost === null ? null : buyNet - row.totalCost, filled: fill.filledQuantity, complete: fill.complete },
    sell: { unitPrice: quote.book.bestSell, gross: sellGross, net: sellNet, profit: sellNet === null || row.totalCost === null ? null : sellNet - row.totalCost }, salesTaxPercent, brokerFeePercent }
}
export function industryProducedJob(job: IndustryJob, catalog: IndustryCatalog, now: string, blueprint?: IndustryBlueprint | null, previous?: IndustryProducedJob): IndustryProducedJob | null {
  const recipe = catalog.blueprints.find(b => b.blueprintTypeId === job.blueprintTypeId && b.productTypeId === job.productTypeId)
  if (job.activityId !== 1 || !recipe || !Number.isSafeInteger(recipe.productQuantity * job.runs)) return null
  const materialEfficiency = blueprint?.itemId === job.blueprintItemId && blueprint.typeId === job.blueprintTypeId ? blueprint.materialEfficiency : previous?.materialEfficiency ?? null
  return { job, productName: recipe.productName, outputQuantity: recipe.productQuantity * job.runs,
    materials: recipe.materials.map(m => ({ typeId: m.typeId, name: catalog.types[m.typeId]?.name ?? `Type #${m.typeId}`, quantity: manufacturingQuantity(m.quantity, job.runs, materialEfficiency ?? 0, 0) })), firstSeen: now, materialEfficiency }
}
export function validateProductionCost(value: unknown, record: IndustryProducedJob, purchases: readonly IndustryLedgerTransaction[], jobs: readonly IndustryProducedJob[], existing: readonly IndustryProductionCost[]): IndustryProductionCost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Некорректная себестоимость')
  const c = value as IndustryProductionCost
  if (Object.keys(c).some(k => !['jobId', 'allocations', 'materialsConfirmed', 'blueprint', 'extraCost'].includes(k)) || c.jobId !== record.job.jobId || typeof c.materialsConfirmed !== 'boolean' || !Number.isFinite(c.extraCost) || c.extraCost < 0 || c.extraCost > 1e15) throw new TypeError('Некорректная себестоимость задания')
  if (!Array.isArray(c.allocations) || c.allocations.length > 500 || c.allocations.some(a => !a || typeof a !== 'object') || new Set(c.allocations.map(a => a.transactionId)).size !== c.allocations.length) throw new TypeError('Некорректное распределение покупок')
  const remaining = new Map(purchases.filter(p => p.buy && p.personal).map(p => [p.transactionId, p.quantity]))
  for (const other of existing.filter(o => o.jobId !== c.jobId)) for (const a of other.allocations) remaining.set(a.transactionId, (remaining.get(a.transactionId) ?? 0) - a.quantity)
  for (const a of c.allocations) {
    const purchase = purchases.find(p => p.transactionId === a.transactionId && p.buy && p.personal)
    if (!a || Object.keys(a).some(k => !['transactionId', 'quantity'].includes(k)) || !Number.isSafeInteger(a.quantity) || a.quantity < 1 || !purchase || !record.materials.some(m => m.typeId === purchase.typeId) || Date.parse(purchase.date) > Date.parse(record.job.startDate)) throw new TypeError('Покупка не подходит заданию: нужны материалы, купленные до запуска')
    if (a.quantity > (remaining.get(a.transactionId) ?? 0)) throw new RangeError('Эта покупка уже списана на другое производство или количества не хватает')
  }
  if (c.materialsConfirmed && record.materials.some(m => !c.allocations.some(a => purchases.find(p => p.transactionId === a.transactionId)?.typeId === m.typeId))) throw new TypeError('Привяжите покупки всех материалов или снимите подтверждение полного расхода')
  if (!Number.isFinite(c.allocations.reduce((sum, a) => sum + a.quantity * purchases.find(p => p.transactionId === a.transactionId)!.unitPrice, 0))) throw new RangeError('Сумма покупок превышает безопасный предел')
  if (c.blueprint !== null) {
    const b = c.blueprint
    if (!b || Object.keys(b).some(k => !['kind', 'contractId', 'purchasePrice', 'runsPurchased'].includes(k)) || !['copy', 'original'].includes(b.kind) || !Number.isFinite(b.purchasePrice) || b.purchasePrice < 0 || b.purchasePrice > 1e15 || !Number.isSafeInteger(b.runsPurchased) || b.runsPurchased < 1 || b.runsPurchased > 1e9 || b.contractId !== null && (!Number.isSafeInteger(b.contractId) || b.contractId <= 0)) throw new TypeError('Некорректная оплаченная стоимость чертежа')
    const sameSource = existing.filter(o => o.jobId !== c.jobId && o.blueprint && (b.contractId !== null && o.blueprint.contractId === b.contractId || jobs.find(j => j.job.jobId === o.jobId)?.job.blueprintItemId === record.job.blueprintItemId))
    if (sameSource.some(o => o.blueprint!.contractId !== null && b.contractId !== null && o.blueprint!.contractId !== b.contractId)) throw new TypeError('Один экземпляр чертежа нельзя списывать как разные контракты')
    if (sameSource.some(o => o.blueprint!.kind !== b.kind || o.blueprint!.purchasePrice !== b.purchasePrice || b.kind === 'copy' && o.blueprint!.runsPurchased !== b.runsPurchased || jobs.find(j => j.job.jobId === o.jobId)?.job.blueprintTypeId !== record.job.blueprintTypeId)) throw new TypeError('Для одного контракта используйте одинаковую цену, тип и исходное число прогонов')
    if (b.kind === 'copy' && record.job.runs + sameSource.reduce((sum, o) => sum + (jobs.find(j => j.job.jobId === o.jobId)?.job.runs ?? 0), 0) > b.runsPurchased) throw new RangeError('Прогоны этого BPC уже списаны или их недостаточно')
  }
  return { ...c, allocations: c.allocations.map(a => ({ ...a })), blueprint: c.blueprint ? { ...c.blueprint } : null }
}
export function industryProducedView(record: IndustryProducedJob, cost: IndustryProductionCost | null, purchases: readonly IndustryLedgerTransaction[], automatic?: IndustryProductionAutomatic): IndustryProducedView {
  const missing: string[] = []
  const prices = new Map(purchases.map(p => [p.transactionId, p]))
  const materialCost = cost?.materialsConfirmed ? cost.allocations.some(a => !prices.has(a.transactionId)) ? null : cost.allocations.reduce((sum, a) => sum + a.quantity * prices.get(a.transactionId)!.unitPrice, 0) : automatic?.materialCost ?? null
  const blueprintCost = !cost?.blueprint ? null : cost.blueprint.kind === 'original' ? 0 : cost.blueprint.purchasePrice / cost.blueprint.runsPurchased * record.job.runs
  if (materialCost === null) missing.push(automatic ? 'Не хватает цен материалов: обновите покупки и рынок' : 'Не подтверждён фактический расход покупок материалов')
  if (blueprintCost === null) missing.push('Не указана оплаченная стоимость BPC / тип BPO')
  const jobCost = record.job.cost ?? automatic?.jobCost ?? null
  if (jobCost === null) missing.push('ESI не сообщил стоимость запуска; оценка Jita пока недоступна')
  const totalCost = materialCost === null || blueprintCost === null || jobCost === null ? null : materialCost + blueprintCost + jobCost + (cost?.extraCost ?? 0)
  return { ...record, cost, materialCost, blueprintCost, totalCost, unitCost: totalCost === null ? null : totalCost / record.outputQuantity, missing, ...(automatic ? { automatic } : {}) }
}

/** Automatic bookkeeping is an estimate, not evidence of exact job consumption.
 * Reserve real purchase quantities once across jobs, nearest pre-start buys first.
 * Missing history uses an explicitly labelled price estimate, never fake transactions.
 */
export function industryProducedViews(records: readonly IndustryProducedJob[], costs: readonly IndustryProductionCost[], purchases: readonly IndustryLedgerTransaction[], pricing: IndustryProductionPricing, catalog?: IndustryCatalog): IndustryProducedView[] {
  const byJob = new Map(costs.map(c => [c.jobId, c]))
  const remaining = new Map(purchases.filter(p => p.buy && p.personal).map(p => [p.transactionId, p.quantity]))
  for (const c of costs) for (const a of c.allocations) remaining.set(a.transactionId, Math.max(0, (remaining.get(a.transactionId) ?? 0) - a.quantity))
  const buys = new Map<number, IndustryLedgerTransaction[]>()
  for (const p of purchases) if (p.buy && p.personal) { const list = buys.get(p.typeId) ?? []; list.push(p); buys.set(p.typeId, list) }
  for (const list of buys.values()) list.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.transactionId - a.transactionId)
  const orders = new Map<number, MarketOrder[]>()
  for (const o of pricing.orders) if (!o.isBuyOrder && o.locationId === 60003760) { const list = orders.get(o.typeId) ?? []; list.push(o); orders.set(o.typeId, list) }
  const adjusted = new Map(pricing.adjustedPrices.filter(p => p.adjustedPrice !== null).map(p => [p.typeId, p.adjustedPrice!]))
  const blueprintSources = new Map<number, IndustryProductionCost>()
  for (const c of costs) { const record = records.find(r => r.job.jobId === c.jobId); if (record && c.blueprint) blueprintSources.set(record.job.blueprintItemId, c) }
  const sourceRuns = new Map<number, number>()
  for (const r of records) if (['active', 'paused', 'ready', 'delivered'].includes(r.job.status)) sourceRuns.set(r.job.blueprintItemId, (sourceRuns.get(r.job.blueprintItemId) ?? 0) + r.job.runs)
  const result: IndustryProducedView[] = []
  for (const record of [...records].filter(r => ['active', 'paused', 'ready', 'delivered'].includes(r.job.status)).sort((a, b) => Date.parse(a.job.startDate) - Date.parse(b.job.startDate) || a.job.jobId - b.job.jobId)) {
    let cost = byJob.get(record.job.jobId) ?? null
    const sharedCost = blueprintSources.get(record.job.blueprintItemId), shared = sharedCost?.blueprint
    if (!cost?.blueprint && shared && (shared.kind === 'original' || (sourceRuns.get(record.job.blueprintItemId) ?? 0) <= shared.runsPurchased)) cost = { jobId: record.job.jobId, allocations: [], materialsConfirmed: false, extraCost: 0, ...cost, blueprint: { ...shared }, updatedAt: sharedCost?.updatedAt ?? cost?.updatedAt }
    const assumptions = [record.materialEfficiency == null ? 'ME чертежа не сохранился: расход рассчитан по ME 0.' : `Расход рассчитан по чертежу ME ${record.materialEfficiency}.`, 'Бонусы материалов завода не учтены: базовое производство Jita. Расход расчётный, не подтверждённый ESI.']
    const materials: IndustryProductionAutomatic['materials'] = record.materials.map(m => {
      const quantity = m.quantity ?? null
      if (quantity === null) return { ...m, quantity, total: null, source: 'unknown', pricedAt: null }
      if (cost?.materialsConfirmed) {
        const rows = cost.allocations.flatMap(a => { const p = purchases.find(p => p.transactionId === a.transactionId && p.typeId === m.typeId); return p ? [{ p, quantity: a.quantity }] : [] })
        return { ...m, quantity: rows.reduce((n, r) => n + r.quantity, 0), total: rows.reduce((n, r) => n + r.quantity * r.p.unitPrice, 0), source: 'purchases', pricedAt: rows[0]?.p.date ?? null }
      }
      const eligible = (buys.get(m.typeId) ?? []).filter(p => Date.parse(p.date) <= Date.parse(record.job.startDate))
      let needed = quantity, total = 0, usedAt: string | null = null
      for (const p of eligible) {
        const taken = Math.min(needed, remaining.get(p.transactionId) ?? 0)
        if (taken > 0 && usedAt === null) usedAt = p.date
        total += taken * p.unitPrice; needed -= taken
        remaining.set(p.transactionId, (remaining.get(p.transactionId) ?? 0) - taken)
        if (needed === 0) break
      }
      if (needed === 0) return { ...m, quantity, total, source: 'purchases', pricedAt: usedAt }
      if (eligible[0]) return { ...m, quantity, total: total + needed * eligible[0].unitPrice, source: 'purchase-estimate', pricedAt: eligible[0].date }
      const fill = industryLimitFill(summarizeMarketBook(orders.get(m.typeId) ?? [], quantity).immediateBuy, 'buy')
      return { ...m, quantity, total: fill.complete ? fill.total : null, source: fill.complete ? 'jita-sell' : 'unknown', pricedAt: pricing.fetchedAt }
    })
    if (materials.some(m => m.source === 'purchase-estimate')) assumptions.push('Части покупок не хватает в истории: недостающий расход оценён по последней цене покупки до запуска, без повторного списания сделки.')
    if (materials.some(m => m.source === 'jita-sell')) assumptions.push('Нет исторической покупки: использована текущая SELL-оценка Jita, не фактически уплаченная цена.')
    const recipe = catalog?.blueprints.find(b => b.blueprintTypeId === record.job.blueprintTypeId && b.productTypeId === record.job.productTypeId)
    const eiv = recipe && recipe.materials.every(m => adjusted.has(m.typeId)) ? recipe.materials.reduce((n, m) => n + m.quantity * adjusted.get(m.typeId)!, 0) * record.job.runs : null
    const estimatedFee = eiv !== null && pricing.jitaCostIndex !== null ? eiv * (pricing.jitaCostIndex + 0.0025 + 0.04) : null
    const jobCost = record.job.cost ?? estimatedFee
    const jobCostSource = record.job.cost !== null ? 'esi' : estimatedFee !== null ? 'jita-estimate' : 'unknown'
    if (jobCostSource === 'jita-estimate') assumptions.push(`Запуск: оценка Jita по текущему SCI ${(pricing.jitaCostIndex! * 100).toFixed(3)}% + базовые допущения: налог завода 0,25% EIV и SCC 4%, Omega; не историческое списание.`)
    const automatic: IndustryProductionAutomatic = { materials, materialCost: materials.every(m => m.total !== null) ? materials.reduce((n, m) => n + m.total!, 0) : null, jobCost, jobCostSource, assumptions: cost?.materialsConfirmed ? assumptions.filter(a => !a.startsWith('ME ') && !a.startsWith('Расход ') && !a.startsWith('Бонусы ')) : assumptions }
    result.push(industryProducedView(record, cost, purchases, automatic))
  }
  return result.filter(r => ['ready', 'delivered'].includes(r.job.status)).sort((a, b) => b.job.endDate.localeCompare(a.job.endDate))
}
