import type { EconomyTransactionRow } from './personal-economy'
import type { IndustryOpportunity } from './industry'

export interface IndustryLedgerTransaction extends EconomyTransactionRow { typeName: string }
export interface IndustryLedgerSnapshot {
  characterId: number
  transactions: IndustryLedgerTransaction[]
  syncedAt: string | null
  warnings: string[]
}
export interface PurchaseBasis { quantity: number; total: number; unitPrice: number }
export type IndustryMaterialCostMode = 'market' | 'mixed' | 'purchases'

export function validLedgerTransaction(row: EconomyTransactionRow): boolean {
  return [row.transactionId, row.typeId, row.quantity, row.locationId, row.clientId].every(n => Number.isSafeInteger(n) && n > 0) &&
    Number.isFinite(Date.parse(row.date)) && Number.isFinite(row.unitPrice) && row.unitPrice >= 0 &&
    Number.isFinite(row.unitPrice * row.quantity) && typeof row.buy === 'boolean' && typeof row.personal === 'boolean'
}

/** Historical purchase prices only. This deliberately does not claim to be inventory. */
export function industryPurchaseBasis(transactions: readonly EconomyTransactionRow[], since: string): Map<number, PurchaseBasis> {
  const result = new Map<number, PurchaseBasis>()
  const cutoff = Date.parse(since)
  if (!Number.isFinite(cutoff)) return result
  for (const row of transactions) {
    if (!validLedgerTransaction(row) || !row.personal || !row.buy || Date.parse(row.date) < cutoff) continue
    const previous = result.get(row.typeId)
    const quantity = (previous?.quantity ?? 0) + row.quantity
    const total = (previous?.total ?? 0) + row.quantity * row.unitPrice
    if (!Number.isSafeInteger(quantity) || !Number.isFinite(total)) continue
    result.set(row.typeId, { quantity, total, unitPrice: total / quantity })
  }
  return result
}

export function industryPurchaseQuote(row: IndustryOpportunity, purchases: ReadonlyMap<number, PurchaseBasis>, basis: 'first' | 'repeat', mode: IndustryMaterialCostMode = 'purchases', stockLocationId?: number) {
  const materials = row.materials.map(material => {
    const purchase = purchases.get(material.typeId)
    const snapshot = material.stock && (stockLocationId === undefined || material.stock.locationId === stockLocationId) ? material.stock : undefined
    const ownQuantity = mode === 'mixed' ? snapshot?.quantity ?? 0 : mode === 'purchases' ? Math.min(material.quantity, purchase?.quantity ?? 0) : 0
    const historicalQuantity = Math.min(ownQuantity, purchase?.quantity ?? 0)
    const valuedQuantity = ownQuantity - historicalQuantity
    const marketQuantity = mode === 'purchases' ? 0 : material.quantity - ownQuantity
    const fill = mode === 'mixed' && snapshot ? snapshot.deficitFill : material.fill
    const marketCost = marketQuantity === 0 ? 0 : fill?.complete ? fill.total : null
    const ownCost = valuedQuantity > 0 && snapshot?.marketUnitPrice == null ? null : historicalQuantity * (purchase?.unitPrice ?? 0) + valuedQuantity * (snapshot?.marketUnitPrice ?? 0)
    const complete = mode !== 'purchases' || ownQuantity === material.quantity
    const cost = !complete || ownCost === null || marketCost === null ? null : ownCost + marketCost
    const reasons: string[] = []
    if (!complete) reasons.push(`Не хватает истории покупок: ${material.quantity - ownQuantity} шт.`)
    if (ownCost === null) reasons.push('Нет ни цены покупки, ни sell-цены для оценки своих запасов')
    if (marketCost === null) reasons.push(`Не хватает sell-ордеров на закупку: ${fill?.missingQuantity ?? marketQuantity} шт.`)
    return { ...material, purchasedQuantity: purchase?.quantity ?? 0, unitPrice: purchase?.unitPrice ?? null,
      ownQuantity, historicalQuantity, valuedQuantity, marketQuantity, ownCost, marketCost, cost, reasons }
  })
  const materialCost = materials.every(m => m.cost !== null) ? materials.reduce((total, m) => total + m.cost!, 0) : null
  const marketCost = materials.every(m => m.marketCost !== null) ? materials.reduce((total, m) => total + m.marketCost!, 0) : null
  const blueprintCost = basis === 'first' || row.blueprint.source === 'contract-copy' ? row.blueprint.cost : 0
  const hasRuns = row.blueprint.availableRuns === null || row.blueprint.availableRuns >= row.runs
  const profit = materialCost === null || row.grossRevenue === null || row.installationCost === null ||
    row.salesTax === null || row.brokerFee === null || blueprintCost === null || row.blueprint.cost === null || !hasRuns ? null :
    row.grossRevenue - row.salesTax - row.brokerFee - materialCost - row.installationCost - row.transportCost - blueprintCost
  return { materials, materialCost, marketCost, profit, totalCost: profit === null || row.grossRevenue === null ? null : row.grossRevenue - profit }
}

/** Replaces the displayed economics; filters/sorting use this same cost basis. */
export function industryMaterialCostView(row: IndustryOpportunity, purchases: ReadonlyMap<number, PurchaseBasis>, mode: IndustryMaterialCostMode, stockLocationId?: number): IndustryOpportunity {
  if (mode === 'market') return row
  const first = industryPurchaseQuote(row, purchases, 'first', mode, stockLocationId)
  const repeat = industryPurchaseQuote(row, purchases, 'repeat', mode, stockLocationId)
  const profit = first.profit, repeatProfit = repeat.profit
  const capitalRequired = mode !== 'mixed' ? row.capitalRequired : first.marketCost === null || row.installationCost === null || row.blueprint.purchaseCost === null || row.brokerFee === null ? null : first.marketCost + row.installationCost + row.blueprint.purchaseCost + row.transportCost + row.brokerFee
  const productionReady = mode === 'mixed' ? row.nonMaterialReady === true && first.materialCost !== null : row.productionReady && first.materialCost !== null
  const warnings = mode === 'mixed' ? row.warnings.filter(w => w !== 'Не хватает sell-ордеров материалов на всю партию') : [...row.warnings]
  for (const material of first.materials) for (const reason of material.reasons) warnings.push(`${material.name}: ${reason}`)
  if (mode === 'mixed' && row.materials.some(m => !m.stock || stockLocationId !== undefined && m.stock.locationId !== stockLocationId)) warnings.push('Снимок запасов недоступен или место изменилось: посчитана полная закупка с рынка. Пересчитайте для выбранного Hangar.')
  if (mode === 'mixed' && first.materials.some(m => m.valuedQuantity > 0)) warnings.push('Для части своих запасов нет цены покупки: использована текущая минимальная sell-цена, не нулевая стоимость.')
  // Mixed-mode bounds confirm the full requested batch only. Smaller batches need a
  // new quote: minimum order lots and ME rounding can change the executable depth.
  const fullMaterialRuns = first.materialCost === null ? 0 : row.runs
  const fullProductionRuns = productionReady ? row.runs : 0
  const fullImmediateRuns = productionReady && row.outputFill.complete ? row.runs : 0
  return { ...row, materialCost: first.materialCost, profit, repeatProfit, capitalRequired, productionReady,
    marketReady: productionReady && profit !== null, warnings,
    ...(mode === 'mixed' ? { maxMaterialRuns: fullMaterialRuns, maxProductionRuns: fullProductionRuns, maxImmediateRuns: fullImmediateRuns, maxFeasibleRuns: row.salesMode === 'buy' ? fullImmediateRuns : fullProductionRuns } : {}),
    profitPerHour: profit !== null && row.hours > 0 ? profit / row.hours : null,
    marginPercent: profit !== null && capitalRequired !== null && capitalRequired > 0 ? profit / capitalRequired * 100 : null,
    breakEvenBatches: row.blueprint.source.endsWith('copy') || row.blueprint.cost === null || repeatProfit === null || repeatProfit <= 0 ? null : Math.max(1, Math.ceil(row.blueprint.cost / repeatProfit)) }
}
