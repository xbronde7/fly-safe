import { validateIndustryRequest, type IndustryOpportunity, type IndustryScanRequest } from './industry'
import { industryBuyDecision } from './industry-decision'

export interface IndustryMonitorConfig {
  enabled: boolean; notifications: boolean; intervalMinutes: number
  minimumProfit: number; minimumMargin: number; budget: number
  request: IndustryScanRequest
}
export interface IndustryMonitorDeal {
  contractId: number; blueprintTypeId: number; productName: string; runs: number; quantity: number
  profit: number; hourly: number; margin: number; capital: number; contractPrice: number
  foundAt: string; marketAt: string; exceptional: boolean; row: IndustryOpportunity
}
export interface IndustryMonitorSnapshot {
  characterId: number | null; config: IndustryMonitorConfig; running: boolean
  lastStarted: string | null; lastCompleted: string | null; nextCheck: string | null
  message: string; error: string | null; deals: IndustryMonitorDeal[]
}
export const DEFAULT_INDUSTRY_MONITOR: IndustryMonitorConfig = {
  enabled: false, notifications: true, intervalMinutes: 10, minimumProfit: 10_000_000, minimumMargin: 20, budget: 0,
  request: { scanId: 'monitor', buyHubId: 'jita', sellHubId: 'jita', blueprintHubIds: ['jita', 'amarr', 'dodixie', 'rens', 'hek'], blueprintMode: 'contracts', contractCopiesOnly: true,
    runs: 1, productionSystem: 'Jita', facilityTaxPercent: 0.25, sccPercent: 4, materialReductionPercent: 0, timeReductionPercent: 0, jobCostReductionPercent: 0, clone: 'omega', transportCost: 0, autoPlan: false, salesMode: 'buy', brokerFeePercent: 3 }
}
export function validateIndustryMonitor(value: unknown): IndustryMonitorConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Некорректные настройки монитора')
  const c = value as IndustryMonitorConfig
  if (Object.keys(c).some(k => !['enabled', 'notifications', 'intervalMinutes', 'minimumProfit', 'minimumMargin', 'budget', 'request'].includes(k)) || typeof c.enabled !== 'boolean' || typeof c.notifications !== 'boolean') throw new TypeError('Некорректные настройки монитора')
  if (!Number.isInteger(c.intervalMinutes) || c.intervalMinutes < 5 || c.intervalMinutes > 1440) throw new RangeError('Интервал: 5–1440 минут')
  for (const key of ['minimumProfit', 'minimumMargin', 'budget'] as const) if (!Number.isFinite(c[key]) || c[key] < 0 || c[key] > (key === 'minimumMargin' ? 100000 : 1e15)) throw new RangeError('Некорректный порог уведомлений')
  const request = validateIndustryRequest({ ...c.request, massProduction: undefined })
  return { ...c, request: { ...request, blueprintMode: 'contracts', contractCopiesOnly: true, salesMode: 'buy', runs: 1, autoPlan: false, productionQuantity: undefined, stockLocationId: undefined, massProduction: undefined } }
}
export function industryMonitorDeal(row: IndustryOpportunity, config: IndustryMonitorConfig, now: number): IndustryMonitorDeal | null {
  if (row.blueprint.source !== 'contract-copy' || !row.blueprint.contractId || !row.marketSnapshotAt) return null
  const age = now - Date.parse(row.marketSnapshotAt)
  if (!Number.isFinite(age) || age < -60000 || age > 600000) return null
  if (row.runs !== 1) return null
  const d = industryBuyDecision({ ...row, plan: undefined }, { sort: 'profit', budget: config.budget, materialMode: 'market' })
  if (!d.profitable || d.quote.blueprint.source !== 'contract-copy') return null
  const q = d.quote
  return { contractId: row.blueprint.contractId, blueprintTypeId: row.blueprintTypeId, productName: row.productName, runs: q.runs, quantity: q.outputQuantity,
    profit: q.repeatProfit!, hourly: d.hourly!, margin: d.margin ?? 0, capital: q.capitalRequired!, contractPrice: q.blueprint.purchaseCost!,
    foundAt: new Date(now).toISOString(), marketAt: row.marketSnapshotAt, exceptional: q.repeatProfit! >= config.minimumProfit && (d.margin ?? 0) >= config.minimumMargin, row: { ...q, marketSnapshotAt: row.marketSnapshotAt, plan: undefined } }
}
