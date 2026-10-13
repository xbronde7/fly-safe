import { calculateIndustryOpportunity, manufacturingQuantity, industryLimitFill, industrySlots, type IndustryCharacterSnapshot, type IndustryLiquidity, type IndustryMassSettings, type IndustryOpportunity } from './industry'
import { summarizeMarketBook, type MarketFill } from './market'

export type IndustryQuoteInput = Parameters<typeof calculateIndustryOpportunity>[0]
export const DEFAULT_MASS_SETTINGS: IndustryMassSettings = { lines: 9, hours: 24, minimumHours: 4, minimumRuns: 2, budget: 0, maximumDailySharePercent: 25 }
export interface IndustryMassSource { key: string; capacity: number; input: IndustryQuoteInput; quote: IndustryOpportunity }
export interface IndustryMassJob { sourceKey: string; quote: IndustryOpportunity }
export interface IndustryMassMaterial { typeId: number; name: string; quantity: number; fill: MarketFill; volume: number }
export interface IndustryMassProduct { typeId: number; name: string; quantity: number; fill: MarketFill; sellUnitPrice: number | null; daily: number | null; demandCap: number | null }
export interface IndustryMassTotals {
  materials: IndustryMassMaterial[]; products: IndustryMassProduct[]; complete: boolean
  materialCost: number | null; installationCost: number | null; blueprintPurchase: number | null; blueprintConsumed: number | null
  transportCost: number; capital: number | null; buyNet: number | null; sellNet: number | null
  cashProfit: number | null; economicProfit: number | null; sellCashProfit: number | null
  hours: number; slotHours: number; inputVolume: number; outputVolume: number; demandReady: boolean
}
export interface IndustryMassPlan {
  settings: IndustryMassSettings; jobs: IndustryMassJob[]; totals: IndustryMassTotals
  requestedLines: number; characterLines: number; freeNow: number | null; targetLines: number
  consideredSources: number; shortlistedSources: number; liquidity: IndustryLiquidity[]; warnings: string[]
}

/** A long, multi-run job. The short one-run/hourly optimizer is deliberately not used. */
export function quoteIndustryMassJob(input: IndustryQuoteInput, settings: IndustryMassSettings, runLimit = 100000): IndustryOpportunity {
  const request = { ...input.request, productionQuantity: undefined, autoPlan: false, massProduction: undefined, salesMode: 'buy' as const, transportCost: 0 }
  const one = calculateIndustryOpportunity({ ...input, request: { ...request, runs: 1 }, skipCapacity: true })
  const safe = Math.min(100000, Math.floor(2147483647 / Math.max(input.recipe.productQuantity, ...input.recipe.materials.map(m => m.quantity))))
  const runs = Math.max(1, Math.min(safe, runLimit, one.blueprint.availableRuns ?? safe, Math.floor(settings.hours / Math.max(one.hours, 1e-9))))
  const probe = calculateIndustryOpportunity({ ...input, request: { ...request, runs } })
  const full = probe.maxImmediateRuns > 0 && probe.maxImmediateRuns < runs
    ? calculateIndustryOpportunity({ ...input, request: { ...request, runs: probe.maxImmediateRuns } }) : probe
  if ((massJobCashProfit(full) ?? -Infinity) > 0 || full.maxImmediateRuns === 0) return full
  // Deep joke bids / expensive material tiers must not hide a genuinely long,
  // profitable boundary batch. Never fall back to a single-run quick deal.
  const limit = full.maxImmediateRuns, minimum = Math.max(settings.minimumRuns, Math.ceil(settings.minimumHours / Math.max(one.hours, 1e-9)))
  const candidates = new Set<number>([minimum, limit])
  const boundary = (typeId: number, side: 'buy' | 'sell', quantity: (n: number) => number): void => {
    const orders = (side === 'buy' ? input.buyOrders : input.sellOrders).get(typeId) ?? []
    const fill = summarizeMarketBook(orders, quantity(limit))[side === 'buy' ? 'immediateBuy' : 'immediateSell']
    let volume = 0
    for (const level of fill.levels) {
      volume += level.quantity
      let low = 0, high = limit
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (quantity(mid) <= volume) low = mid; else high = mid - 1 }
      candidates.add(low); candidates.add(low - 1)
    }
  }
  boundary(input.recipe.productTypeId, 'sell', n => n * input.recipe.productQuantity)
  for (const m of input.recipe.materials) boundary(m.typeId, 'buy', n => manufacturingQuantity(m.quantity, n, one.blueprint.me, input.request.materialReductionPercent))
  const sorted = [...candidates].filter(n => n >= minimum && n <= limit).sort((a, b) => a - b)
  const checked = sorted.length <= 32 ? sorted : [...new Set(Array.from({ length: 32 }, (_, i) => sorted[Math.floor(i * (sorted.length - 1) / 31)]))]
  let best = full
  for (const n of checked) {
    const q = calculateIndustryOpportunity({ ...input, request: { ...request, runs: n }, skipCapacity: true })
    if (q.productionReady && q.outputFill.complete && (massJobCashProfit(q) ?? -Infinity) > (massJobCashProfit(best) ?? -Infinity)) best = q
  }
  return best === full ? full : calculateIndustryOpportunity({ ...input, request: { ...request, runs: best.runs } })
}
export function industryMassReasons(row: IndustryOpportunity, settings: IndustryMassSettings): string[] {
  const reasons: string[] = []
  if (row.runs < settings.minimumRuns) reasons.push(`Нужно хотя бы ${settings.minimumRuns} прогона; доступно ${row.runs}`)
  if (row.hours < settings.minimumHours) reasons.push(`Короткое задание: ${row.hours.toFixed(2)} ч., минимум ${settings.minimumHours} ч.`)
  if (row.hours > settings.hours + 1e-8) reasons.push('Задание не помещается в выбранный цикл')
  if (!row.productionReady || !row.outputFill.complete) reasons.push('Не хватает ресурсов, BUY, навыков или подтверждённого чертежа')
  if (row.blueprint.source === 'owned-copy') reasons.push('Цена своего BPC неизвестна')
  if (massJobCashProfit(row) === null) reasons.push('Не все расходы известны')
  else if (massJobCashProfit(row)! <= 0) reasons.push('Первая партия не окупает полную закупку чертежа')
  if (settings.budget > 0 && (row.capitalRequired === null || row.capitalRequired > settings.budget)) reasons.push('Закупка превышает общий бюджет')
  return reasons
}
export function massJobCashProfit(row: IndustryOpportunity): number | null {
  return row.grossRevenue === null || row.salesTax === null || row.materialCost === null || row.installationCost === null || row.blueprint.purchaseCost === null ? null : row.grossRevenue - row.salesTax - row.materialCost - row.installationCost - row.blueprint.purchaseCost - row.transportCost
}
function demandLimit(history: IndustryLiquidity | undefined, settings: IndustryMassSettings): { daily: number | null; cap: number | null } {
  if (!history || history.stale) return { daily: null, cap: null }
  const daily = Math.min(history.daily7, history.daily30)
  return { daily, cap: history.activeDays30 < 5 ? 0 : Math.floor(daily * settings.maximumDailySharePercent / 100 * Math.max(1, settings.hours / 24)) }
}

/** Reprice the joint basket, including earlier jobs. No multiplying independent top-of-book quotes. */
export function industryMassTotals(jobs: readonly IndustryMassJob[], input: IndustryQuoteInput, settings: IndustryMassSettings, history: ReadonlyMap<number, IndustryLiquidity>): IndustryMassTotals {
  const materialMap = new Map<number, { name: string; quantity: number }>(), productMap = new Map<number, { name: string; quantity: number }>()
  for (const { quote: q } of jobs) {
    for (const m of q.materials) { const previous = materialMap.get(m.typeId); materialMap.set(m.typeId, { name: m.name, quantity: m.quantity + (previous?.quantity ?? 0) }) }
    const previous = productMap.get(q.productTypeId); productMap.set(q.productTypeId, { name: q.productName, quantity: q.outputQuantity + (previous?.quantity ?? 0) })
  }
  const materials = [...materialMap].map(([typeId, m]) => ({ ...m, typeId, fill: industryLimitFill(summarizeMarketBook(input.buyOrders.get(typeId) ?? [], m.quantity).immediateBuy, 'buy'), volume: input.catalog.types[typeId]?.volume ?? 0 }))
  const products = [...productMap].map(([typeId, p]) => {
    const book = summarizeMarketBook(input.sellOrders.get(typeId) ?? [], p.quantity), demand = demandLimit(history.get(typeId), settings)
    return { ...p, typeId, fill: industryLimitFill(book.immediateSell, 'sell'), sellUnitPrice: book.bestSell, daily: demand.daily, demandCap: demand.cap }
  })
  const knownSum = (get: (q: IndustryOpportunity) => number | null): number | null => jobs.some(j => get(j.quote) === null) ? null : jobs.reduce((n, j) => n + get(j.quote)!, 0)
  const materialCost = materials.every(m => m.fill.complete) ? materials.reduce((n, m) => n + m.fill.total, 0) : null
  const installationCost = knownSum(q => q.installationCost), blueprintPurchase = knownSum(q => q.blueprint.purchaseCost)
  const blueprintConsumed = knownSum(q => q.blueprint.source.endsWith('copy') ? q.blueprint.cost : 0)
  const transportCost = jobs.length ? input.request.transportCost : 0
  const capital = materialCost === null || installationCost === null || blueprintPurchase === null ? null : materialCost + installationCost + blueprintPurchase + transportCost
  const tax = (jobs[0]?.quote.salesTaxPercent ?? 0) / 100, broker = (input.request.brokerFeePercent ?? 3) / 100
  const buyNet = products.every(p => p.fill.complete) ? products.reduce((n, p) => n + p.fill.total * (1 - tax), 0) : null
  const sellNet = products.every(p => p.sellUnitPrice !== null) ? products.reduce((n, p) => n + p.sellUnitPrice! * p.quantity * (1 - tax - broker), 0) : null
  const cost = materialCost === null || installationCost === null || blueprintConsumed === null ? null : materialCost + installationCost + blueprintConsumed + transportCost
  return { materials, products, complete: capital !== null && buyNet !== null, materialCost, installationCost, blueprintPurchase, blueprintConsumed, transportCost, capital, buyNet, sellNet,
    cashProfit: capital === null || buyNet === null ? null : buyNet - capital, economicProfit: cost === null || buyNet === null ? null : buyNet - cost,
    sellCashProfit: capital === null || sellNet === null ? null : sellNet - capital,
    hours: Math.max(0, ...jobs.map(j => j.quote.hours)), slotHours: jobs.reduce((n, j) => n + j.quote.hours, 0),
    inputVolume: materials.reduce((n, m) => n + m.quantity * m.volume, 0), outputVolume: products.reduce((n, p) => n + p.quantity * (input.catalog.types[p.typeId]?.volume ?? 0), 0),
    demandReady: products.every(p => p.demandCap !== null && p.quantity <= p.demandCap) }
}

export function shortlistIndustryMassSources(sources: readonly IndustryMassSource[], settings: IndustryMassSettings): IndustryMassSource[] {
  return sources.filter(s => !industryMassReasons(s.quote, { ...settings, budget: 0 }).length)
    .sort((a, b) => massJobCashProfit(b.quote)! - massJobCashProfit(a.quote)! || b.quote.hours - a.quote.hours).slice(0, 80)
}

/** Bounded greedy candidate, not a global optimizer. Each line owns a distinct blueprint. */
export function planIndustryMassProduction(sources: readonly IndustryMassSource[], base: IndustryQuoteInput, settings: IndustryMassSettings, character: IndustryCharacterSnapshot, liquidity: readonly IndustryLiquidity[]): IndustryMassPlan {
  const history = new Map(liquidity.map(h => [h.typeId, h])), shortlist = shortlistIndustryMassSources(sources, settings)
  const characterLines = character.skills ? industrySlots(character.skills) : 0, targetLines = Math.min(settings.lines, characterLines)
  const freeNow = character.jobs ? Math.max(0, characterLines - character.jobs.filter(j => j.activityId === 1 && ['active', 'paused', 'ready'].includes(j.status)).length) : null
  const jobs: IndustryMassJob[] = [], used = new Map<string, number>()
  let totals = industryMassTotals(jobs, base, settings, history)
  for (let line = 0; line < targetLines; line++) {
    let best: { job: IndustryMassJob; totals: IndustryMassTotals; gain: number } | null = null
    for (const source of shortlist) {
      if ((used.get(source.key) ?? 0) >= source.capacity) continue
      let q = source.quote
      for (let attempt = 0; attempt < 12; attempt++) {
        if (industryMassReasons(q, { ...settings, budget: 0 }).length) break
        const next = industryMassTotals([...jobs, { sourceKey: source.key, quote: q }], base, settings, history)
        if (next.complete && next.demandReady && (settings.budget <= 0 || next.capital! <= settings.budget)) {
          const gain = next.cashProfit! - (totals.cashProfit ?? 0)
          if (gain > 0 && (!best || gain > best.gain)) best = { job: { sourceKey: source.key, quote: q }, totals: next, gain }
          break
        }
        // Tighten to whole-run resource/buyer/demand limits, then independently re-quote.
        let ratio = 1
        for (const m of next.materials) if (!m.fill.complete) {
          const old = totals.materials.find(p => p.typeId === m.typeId)?.quantity ?? 0
          ratio = Math.min(ratio, Math.max(0, m.fill.filledQuantity - old) / Math.max(1, m.quantity - old))
        }
        for (const p of next.products) {
          const old = totals.products.find(x => x.typeId === p.typeId)?.quantity ?? 0
          if (p.demandCap === null) { ratio = 0; break }
          const available = Math.min(p.fill.filledQuantity, p.demandCap)
          if (p.quantity > available) ratio = Math.min(ratio, Math.max(0, available - old) / Math.max(1, p.quantity - old))
        }
        if (settings.budget > 0 && next.capital !== null && next.capital > settings.budget) ratio = Math.min(ratio, Math.max(0, settings.budget - (totals.capital ?? 0)) / Math.max(1, next.capital - (totals.capital ?? 0)))
        const runs = Math.min(q.runs - 1, Math.floor(q.runs * ratio))
        if (runs < settings.minimumRuns) break
        q = quoteIndustryMassJob(source.input, settings, runs)
      }
    }
    if (!best) break
    jobs.push(best.job); used.set(best.job.sourceKey, (used.get(best.job.sourceKey) ?? 0) + 1); totals = best.totals
  }
  const warnings = ['План — ограниченный жадный подбор, не глобальный максимум. BUY — текущий снимок, не гарантия цены после производства.', 'Один экземпляр BPO/BPC — одно параллельное задание. Смешанные и пакетные контракты массовый план исключает: состав и цену не делим произвольно.', 'Общие материалы и готовая продукция перепроверены по суммарному объёму. Доставка задана вручную один раз на весь цикл; время перевозок и ручных действий неизвестно.']
  if (jobs.length < settings.lines) warnings.push(`Заполнено ${jobs.length}/${settings.lines} линий. Ограничения: навыки, отдельные чертежи, длинные партии, общий рынок, спрос или бюджет. Недостающие линии не домножены.`)
  if (targetLines < settings.lines) warnings.push(`Навыки персонажа дают ${characterLines} линий, запрошено ${settings.lines}.`)
  if (freeNow === null) warnings.push('Свободные линии сейчас неизвестны: задания ESI недоступны. Это план после освобождения линий, не подтверждение запуска сейчас.')
  else if (freeNow < jobs.length) warnings.push(`Сейчас свободно ${freeNow} линий; план требует дождаться завершения/доставки текущих заданий.`)
  if (shortlist.some(s => !history.has(s.quote.productTypeId))) warnings.push('Часть кандидатов без истории спроса исключена из общего плана; неизвестный спрос не считается нулём или подтверждением продаж.')
  return { settings, jobs, totals, requestedLines: settings.lines, characterLines, freeNow, targetLines, consideredSources: sources.length, shortlistedSources: shortlist.length, liquidity: [...liquidity], warnings }
}
