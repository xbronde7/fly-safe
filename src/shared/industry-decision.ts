import { industrySalesView, type IndustryOpportunity } from './industry'
import { industryMaterialCostView, type IndustryMaterialCostMode, type PurchaseBasis } from './industry-ledger'

export type IndustryDecisionSort = 'hour' | 'profit' | 'margin'
export interface IndustryBuyDecision {
  quote: IndustryOpportunity
  executable: boolean
  profitable: boolean
  hourly: number | null
  margin: number | null
  reasons: string[]
}
export interface IndustryDecisionOptions {
  sort?: IndustryDecisionSort
  budget?: number
  brokerFeePercent?: number
  purchases?: ReadonlyMap<number, PurchaseBasis>
  materialMode?: IndustryMaterialCostMode
  stockLocationId?: number
}

/** One decision powers ranking, filters and headline numbers. Never uses SELL.
 * Compare only independently quoted batches; don't scale a one-run quote.
 * BUY depth is a snapshot, not a promise that bids survive manufacturing.
 */
export function industryBuyDecision(row: IndustryOpportunity, options: IndustryDecisionOptions = {}): IndustryBuyDecision {
  const batches = [row, row.plan?.hourlyBuy, row.plan?.profitableBuy, row.plan?.immediate, row.plan?.production, row.plan?.full]
    .filter((q): q is IndustryOpportunity => !!q)
  const unique = [...new Map(batches.map(q => [q.runs, q])).values()]
  const decisions = unique.map(candidate => {
    const quote = industryMaterialCostView(industrySalesView(candidate, 'buy', options.brokerFeePercent ?? 3), options.purchases ?? new Map(), options.materialMode ?? 'market', options.stockLocationId)
    const reasons: string[] = []
    if (!quote.outputFill.complete) reasons.push(`BUY принимает только ${quote.outputFill.filledQuantity} из ${quote.outputQuantity} шт.`)
    if (quote.materialCost === null) reasons.push('Не хватает материалов или их цены на всю партию')
    if (quote.missingSkills.length) reasons.push('Не хватает навыков для запуска')
    if (!quote.productionReady && !reasons.length) reasons.push('Запуск производства не подтверждён')
    if (quote.blueprint.source === 'owned-copy') reasons.push('Стоимость собственного BPC неизвестна')
    if (quote.repeatProfit === null || !Number.isFinite(quote.repeatProfit)) reasons.push('Не все расходы известны')
    if (!(quote.hours > 0) || !Number.isFinite(quote.hours)) reasons.push('Время производства неизвестно')
    if (quote.capitalRequired === null || !Number.isFinite(quote.capitalRequired)) reasons.push('Неизвестна сумма закупки')
    else if ((options.budget ?? 0) > 0 && quote.capitalRequired > options.budget!) reasons.push('Вся закупка, включая чертёж, превышает бюджет')
    const executable = reasons.length === 0
    const profitable = executable && quote.repeatProfit! > 0
    const hourly = executable ? quote.repeatProfit! / quote.hours : null
    const margin = executable && quote.capitalRequired! > 0 ? quote.repeatProfit! / quote.capitalRequired! * 100 : null
    return { quote, executable, profitable, hourly, margin, reasons }
  })
  const score = (d: IndustryBuyDecision): number => options.sort === 'profit' ? d.quote.repeatProfit ?? -Infinity : options.sort === 'margin' ? d.margin ?? -Infinity : d.hourly ?? -Infinity
  // Valid BUY batches always precede speculative/unavailable calculations.
  decisions.sort((a, b) => Number(b.profitable) - Number(a.profitable) || Number(b.executable) - Number(a.executable) || score(b) - score(a) || (b.quote.repeatProfit ?? -Infinity) - (a.quote.repeatProfit ?? -Infinity))
  return decisions[0]
}
