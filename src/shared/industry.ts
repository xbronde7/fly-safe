import { getMarketHub, isMarketHubId, summarizeMarketBook, type MarketFill, type MarketHubId, type MarketOrder } from './market'
import type { IndustryMassPlan } from './industry-mass'

export const INDUSTRY_SCOPES = {
  skills: 'esi-skills.read_skills.v1',
  blueprints: 'esi-characters.read_blueprints.v1',
  jobs: 'esi-industry.read_character_jobs.v1'
} as const
export const INDUSTRY_SKILL_IDS = { industry: 3380, advancedIndustry: 3388, accounting: 16622, massProduction: 3387, advancedMassProduction: 24625 } as const

export interface IndustrySkill { typeId: number; activeLevel: number; trainedLevel: number }
export interface IndustryBlueprint {
  itemId: number; typeId: number; locationId: number; locationFlag: string
  materialEfficiency: number; timeEfficiency: number; runs: number; quantity: number
}
export interface IndustryJob {
  jobId: number; activityId: number; blueprintTypeId: number; blueprintItemId: number
  productTypeId: number | null; runs: number; status: string; startDate: string; endDate: string
  facilityId: number; stationId: number; cost: number | null
  productName?: string
}
export interface IndustrySkillDefinition {
  name: string; nameRu: string; required: Array<{ typeId: number; level: number }>; timeBonus: number
}
export interface IndustryRecipe {
  blueprintTypeId: number; name: string; productTypeId: number; productName: string; productNameRu: string
  productQuantity: number; time: number; maxRuns: number; marketable: boolean
  materials: Array<{ typeId: number; quantity: number }>; skills: Array<{ typeId: number; level: number }>
}
export interface IndustryCatalog {
  build: number; releasedAt: string; source: string; blueprints: IndustryRecipe[]
  types: Record<string, { name: string; nameRu: string; volume: number }>
  skills: Record<string, IndustrySkillDefinition>; stations: Record<string, number>; systems: Record<string, string>
}
export interface IndustryCharacterSnapshot {
  characterId: number; characterName: string; skills: IndustrySkill[] | null
  blueprints: IndustryBlueprint[] | null; jobs: IndustryJob[] | null
  stock?: Array<{ typeId: number; locationId: number; quantity: number }> | null
  missingScopes: string[]; warnings: string[]; fetchedAt: string
}
export interface IndustryScanRequest {
  scanId: string; buyHubId: MarketHubId; sellHubId: MarketHubId
  blueprintHubIds: MarketHubId[]; blueprintMode: 'buy' | 'contracts' | 'owned' | 'combined'; runs: number
  productionSystem: string; facilityTaxPercent: number; sccPercent: number
  materialReductionPercent: number; timeReductionPercent: number; jobCostReductionPercent: number
  clone: 'omega' | 'alpha'; transportCost: number; forceRefresh?: boolean
  productionQuantity?: number; salesMode?: 'buy' | 'sell'; brokerFeePercent?: number; stockLocationId?: number; autoPlan?: boolean
  contractCopiesOnly?: boolean
  massProduction?: IndustryMassSettings
}
export interface IndustryMassSettings { lines: number; hours: number; minimumHours: number; minimumRuns: number; budget: number; maximumDailySharePercent: number }
export interface IndustryMissingSkill { typeId: number; name: string; required: number; active: number }
export interface IndustryPublicContract { contractId: number; type: string; price: number | null; locationId: number | null; expires: string; title: string }
export interface IndustryContractItem { recordId: number; typeId: number; quantity: number; included: boolean; copy: boolean | null; me: number | null; te: number | null; runs: number | null }
export interface IndustryContractBlueprint {
  contractId: number; price: number; locationId: number; expires: string; title: string
  typeId: number; copy: boolean; me: number; te: number; runs: number; bundled: boolean
}
export interface IndustryMaterialQuote {
  typeId: number; name: string; quantity: number; fill: MarketFill
  stock?: { locationId: number; quantity: number; deficitFill: MarketFill | null; marketUnitPrice: number | null }
}
export interface IndustryOpportunity {
  blueprintTypeId: number; productTypeId: number; productName: string; runs: number; outputQuantity: number
  blueprintName: string; requiredSkills: IndustryMissingSkill[]
  blueprint: { source: 'market' | 'contract-original' | 'contract-copy' | 'owned-original' | 'owned-copy'; itemId: number | null; contractId?: number; cost: number | null; purchaseCost: number | null; locationId: number | null; systemName: string | null; me: number; te: number; availableRuns: number | null }
  materials: IndustryMaterialQuote[]; materialCost: number | null; installationCost: number | null
  grossRevenue: number | null; salesTax: number | null; salesTaxPercent: number; transportCost: number
  repeatProfit: number | null; profit: number | null; marginPercent: number | null
  capitalRequired: number | null; hours: number; profitPerHour: number | null; breakEvenBatches: number | null
  missingSkills: IndustryMissingSkill[]; marketReady: boolean; warnings: string[]; outputFill: MarketFill
  salesMode: 'buy' | 'sell'; brokerFee: number | null; requestedQuantity: number
  sellUnitPrice: number | null; productionReady: boolean; nonMaterialReady?: boolean
  maxMaterialRuns: number; maxBuyRuns: number; maxProductionRuns: number; maxImmediateRuns: number; maxFeasibleRuns: number
  marketSnapshotAt?: string
  plan?: { fullRuns: number | null; full: IndustryOpportunity | null; production: IndustryOpportunity | null; immediate: IndustryOpportunity | null; profitableBuy?: IndustryOpportunity | null; hourlyBuy?: IndustryOpportunity | null; sourceCount: number }
}
export interface IndustryLiquidityRequest { hubId: MarketHubId; typeIds: number[] }
export interface IndustryLiquidity {
  typeId: number; regionId: number; through: string; fetchedAt: string
  daily7: number; daily30: number; volume30: number; activeDays30: number; lastTrade: string | null; stale: boolean
}
export interface IndustryFactoryRequest { scanId: string; blueprintTypeId: number; originSystem: string; maxJumps: number; highSecOnly: boolean; salesMode?: 'buy' | 'sell'; brokerFeePercent?: number }
export interface IndustryFactoryQuote {
  facilityId: number; name: string; systemId: number; systemName: string; security: number; jumps: number
  systemCostIndex: number; installationCost: number | null; materialCost: number | null
  hours: number; profit: number | null; repeatProfit: number | null
}
export interface IndustryFactoryResult { originSystemName: string; rows: IndustryFactoryQuote[]; fetchedAt: string; warnings: string[] }
export interface IndustryScanResult {
  scanId: string; characterId: number; characterName: string; rows: IndustryOpportunity[]
  productionSystemId: number; productionSystemName: string; systemCostIndex: number
  catalogBuild: number; catalogReleasedAt: string; fetchedAt: string; marketFetchedAt: string
  warnings: string[]; request: IndustryScanRequest
  massPlan?: IndustryMassPlan
}
export interface IndustryScanProgress {
  scanId: string; characterId: number; stage: 'market' | 'calculating'; completed: number; total: number
  message: string; rows?: IndustryOpportunity[]
}

export function validateIndustryRequest(value: unknown): IndustryScanRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Некорректный запрос производства')
  const r = value as Record<string, unknown>
  const allowed = new Set(['scanId', 'buyHubId', 'sellHubId', 'blueprintHubIds', 'blueprintMode', 'runs', 'productionSystem', 'facilityTaxPercent', 'sccPercent', 'materialReductionPercent', 'timeReductionPercent', 'jobCostReductionPercent', 'clone', 'transportCost', 'forceRefresh', 'productionQuantity', 'salesMode', 'brokerFeePercent', 'stockLocationId', 'autoPlan', 'contractCopiesOnly', 'massProduction'])
  if (Object.keys(r).some(k => !allowed.has(k))) throw new TypeError('Неизвестное поле расчёта')
  if (typeof r.scanId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(r.scanId)) throw new TypeError('Некорректный ID сканирования')
  if (!isMarketHubId(r.buyHubId) || !isMarketHubId(r.sellHubId)) throw new TypeError('Неизвестный торговый хаб')
  if (!Array.isArray(r.blueprintHubIds) || !r.blueprintHubIds.length || r.blueprintHubIds.length > 5 || !r.blueprintHubIds.every(isMarketHubId)) throw new TypeError('Выберите регионы чертежей')
  if (!['buy', 'contracts', 'owned', 'combined'].includes(String(r.blueprintMode))) throw new TypeError('Некорректный источник чертежа')
  if (!Number.isSafeInteger(r.runs) || Number(r.runs) < 1 || Number(r.runs) > 100_000) throw new RangeError('Запуски: от 1 до 100000')
  if (typeof r.productionSystem !== 'string' || !r.productionSystem.trim() || r.productionSystem.length > 80 || /[\u0000-\u001f]/.test(r.productionSystem)) throw new TypeError('Укажите систему производства')
  for (const key of ['facilityTaxPercent', 'sccPercent', 'materialReductionPercent', 'timeReductionPercent', 'jobCostReductionPercent', 'transportCost']) {
    if (typeof r[key] !== 'number' || !Number.isFinite(r[key]) || Number(r[key]) < 0 || Number(r[key]) > (key === 'transportCost' ? 1e15 : key === 'facilityTaxPercent' ? 10 : key === 'sccPercent' ? 100 : 90)) throw new RangeError(`Некорректное значение ${key}`)
  }
  if (r.clone !== 'alpha' && r.clone !== 'omega') throw new TypeError('Выберите Alpha или Omega')
  if (r.forceRefresh !== undefined && typeof r.forceRefresh !== 'boolean') throw new TypeError('Некорректный режим обновления')
  if (r.autoPlan !== undefined && typeof r.autoPlan !== 'boolean') throw new TypeError('Некорректный автоматический расчёт')
  if (r.contractCopiesOnly !== undefined && typeof r.contractCopiesOnly !== 'boolean') throw new TypeError('Некорректный фильтр BPC')
  if (r.contractCopiesOnly === true && r.blueprintMode !== 'contracts') throw new TypeError('Монитор BPC использует только контракты')
  if (r.massProduction !== undefined) {
    const m = r.massProduction as IndustryMassSettings
    if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some(k => !['lines', 'hours', 'minimumHours', 'minimumRuns', 'budget', 'maximumDailySharePercent'].includes(k)) || !Number.isInteger(m.lines) || m.lines < 1 || m.lines > 11 || !Number.isFinite(m.hours) || m.hours < 1 || m.hours > 720 || !Number.isFinite(m.minimumHours) || m.minimumHours <= 0 || m.minimumHours > m.hours || !Number.isInteger(m.minimumRuns) || m.minimumRuns < 2 || m.minimumRuns > 100000 || !Number.isFinite(m.budget) || m.budget < 0 || m.budget > 1e15 || !Number.isFinite(m.maximumDailySharePercent) || m.maximumDailySharePercent < 1 || m.maximumDailySharePercent > 100) throw new RangeError('Массовое производство: 1–11 линий, 1–720 часов, минимум 2 прогона, доля спроса 1–100%')
    if (r.contractCopiesOnly) throw new TypeError('Монитор BPC и массовый план — разные режимы')
  }
  if (r.productionQuantity !== undefined && (!Number.isSafeInteger(r.productionQuantity) || Number(r.productionQuantity) < 1 || Number(r.productionQuantity) > 100_000)) throw new RangeError('Количество продукции: от 1 до 100000')
  if (r.stockLocationId !== undefined && (!Number.isSafeInteger(r.stockLocationId) || Number(r.stockLocationId) < 1)) throw new RangeError('Некорректное место запасов')
  if (r.salesMode !== undefined && r.salesMode !== 'buy' && r.salesMode !== 'sell') throw new TypeError('Некорректный способ продажи')
  if (r.brokerFeePercent !== undefined && (typeof r.brokerFeePercent !== 'number' || !Number.isFinite(r.brokerFeePercent) || r.brokerFeePercent < 0 || r.brokerFeePercent > 10)) throw new RangeError('Брокерская комиссия: от 0 до 10%')
  return { ...(r as unknown as IndustryScanRequest), productionSystem: r.productionSystem.trim(), blueprintHubIds: [...new Set(r.blueprintHubIds as MarketHubId[])] }
}

export function industryRuns(recipe: IndustryRecipe, request: IndustryScanRequest): number {
  return request.productionQuantity === undefined ? request.runs : Math.ceil(request.productionQuantity / recipe.productQuantity)
}

/** EVE Multibuy and immediate selling submit one price per item type.
 * It is not the sum of independent purchases/sales at each book level.
 * CCP: https://www.eveonline.com/news/view/multibuy-all-the-things
 * https://support.eveonline.com/hc/en-us/articles/203218932-Buy-and-Sell-Orders
 */
export function industryLimitFill(fill: MarketFill, side: 'buy' | 'sell'): MarketFill {
  if (!fill.levels.length) return fill
  const price = side === 'buy' ? Math.max(...fill.levels.map(l => l.price)) : Math.min(...fill.levels.map(l => l.price))
  return { ...fill, total: fill.filledQuantity * price, averagePrice: price, orderLimitPrice: price }
}

/** Changes the sales assumption on the same immutable market snapshot. */
export function industrySalesView(row: IndustryOpportunity, mode: 'buy' | 'sell', brokerFeePercent: number): IndustryOpportunity {
  if (!Number.isFinite(brokerFeePercent) || brokerFeePercent < 0 || brokerFeePercent > 10) return { ...row, salesMode: mode, profit: null, repeatProfit: null, brokerFee: null, marketReady: false, capitalRequired: null, profitPerHour: null, marginPercent: null, breakEvenBatches: null, warnings: [...row.warnings, 'Брокерская комиссия: от 0 до 10% — исправьте значение'] }
  const grossRevenue = mode === 'buy' ? row.outputFill.complete ? row.outputFill.total : null : row.sellUnitPrice === null ? null : row.sellUnitPrice * row.outputQuantity
  const salesTax = grossRevenue === null ? null : grossRevenue * row.salesTaxPercent / 100
  const brokerFee = mode === 'buy' ? 0 : grossRevenue === null ? null : grossRevenue * brokerFeePercent / 100
  const hasRuns = row.blueprint.availableRuns === null || row.blueprint.availableRuns >= row.runs
  const operatingProfit = row.materialCost === null || row.installationCost === null || grossRevenue === null || salesTax === null || brokerFee === null || !hasRuns ? null : grossRevenue - salesTax - brokerFee - row.materialCost - row.installationCost - row.transportCost
  const profit = operatingProfit === null || row.blueprint.cost === null ? null : operatingProfit - row.blueprint.cost
  const repeatProfit = operatingProfit === null || row.blueprint.cost === null ? null : row.blueprint.source === 'contract-copy' ? operatingProfit - row.blueprint.cost : operatingProfit
  const warnings = row.warnings.filter(w => !w.startsWith('SELL —') && !w.startsWith('Не хватает buy-') && !w.startsWith('Нет sell-цены'))
  if (grossRevenue === null) warnings.push(mode === 'buy' ? 'Не хватает buy-ордеров на всю готовую партию' : 'Нет sell-цены для оценки продажи ордером')
  if (mode === 'sell') warnings.push('SELL — оценка по минимальной цене конкурентов, не обещание продажи. Покупателя и срок ожидания ESI не гарантирует; комиссия задана вручную, изменения ордера не учтены.')
  const capitalRequired = row.materialCost === null || row.installationCost === null || row.blueprint.purchaseCost === null || mode === 'sell' && brokerFee === null ? null : row.materialCost + row.installationCost + row.transportCost + row.blueprint.purchaseCost + (brokerFee ?? 0)
  return { ...row, salesMode: mode, grossRevenue, salesTax, brokerFee, profit, repeatProfit, warnings, capitalRequired,
    maxFeasibleRuns: mode === 'buy' ? row.maxImmediateRuns : row.maxProductionRuns,
    marketReady: row.productionReady && profit !== null,
    profitPerHour: profit !== null && row.hours > 0 ? profit / row.hours : null,
    marginPercent: profit !== null && capitalRequired !== null && capitalRequired > 0 ? profit / capitalRequired * 100 : null,
    breakEvenBatches: !row.blueprint.source.endsWith('copy') && row.blueprint.cost !== null && repeatProfit !== null && repeatProfit > 0 ? Math.max(1, Math.ceil(row.blueprint.cost / repeatProfit)) : null }
}
// A confirmed executable bound, limited to the requested batch. Minimum-volume
// orders can make smaller batches unfillable: always re-quote the returned bound.
function executableRuns(orders: readonly MarketOrder[], limit: number, quantity: (runs: number) => number, side: 'buy' | 'sell'): number {
  const volume = summarizeMarketBook(orders, 1)[side === 'buy' ? 'sellVolume' : 'buyVolume']
  const runsFor = (amount: number, upper: number): number => {
    let low = 0, high = upper
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (quantity(mid) <= amount) low = mid; else high = mid - 1 }
    return low
  }
  let candidate = runsFor(volume, limit)
  for (let attempt = 0; candidate > 0 && attempt < 32; attempt++) {
    const fill = summarizeMarketBook(orders, quantity(candidate))[side === 'buy' ? 'immediateBuy' : 'immediateSell']
    if (fill.complete) return candidate
    candidate = runsFor(fill.filledQuantity, candidate - 1)
  }
  return 0
}

export function industrySkillLevels(skills: readonly IndustrySkill[]): Map<number, number> {
  return new Map(skills.map(s => [s.typeId, s.activeLevel]))
}
export function industrySalesTaxPercent(levels: ReadonlyMap<number, number>): number {
  return 7.5 * (1 - 0.11 * (levels.get(INDUSTRY_SKILL_IDS.accounting) ?? 0))
}
export function industrySlots(skills: readonly IndustrySkill[]): number {
  const levels = industrySkillLevels(skills)
  return 1 + (levels.get(INDUSTRY_SKILL_IDS.massProduction) ?? 0) + (levels.get(INDUSTRY_SKILL_IDS.advancedMassProduction) ?? 0)
}
export function requiredIndustrySkills(recipe: IndustryRecipe, levels: ReadonlyMap<number, number>, definitions: IndustryCatalog['skills']): IndustryMissingSkill[] {
  const requirements = new Map<number, number>()
  const visit = (id: number, level: number): void => {
    if ((requirements.get(id) ?? 0) >= level) return
    requirements.set(id, level)
    for (const parent of definitions[id]?.required ?? []) visit(parent.typeId, parent.level)
  }
  for (const s of recipe.skills) visit(s.typeId, s.level)
  return [...requirements]
    .map(([typeId, required]) => ({ typeId, required, active: levels.get(typeId) ?? 0, name: definitions[typeId]?.name ?? `Skill #${typeId}` }))
}
export function missingIndustrySkills(recipe: IndustryRecipe, levels: ReadonlyMap<number, number>, definitions: IndustryCatalog['skills']): IndustryMissingSkill[] {
  return requiredIndustrySkills(recipe, levels, definitions).filter(s => s.active < s.required)
}
export function manufacturingQuantity(base: number, runs: number, me: number, reductionPercent: number): number {
  const raw = base * runs * (1 - me / 100) * (1 - reductionPercent / 100)
  const quantity = Math.max(runs, Math.ceil(Math.round((raw + Number.EPSILON) * 100) / 100))
  if (!Number.isSafeInteger(quantity) || quantity > 2_147_483_647) throw new RangeError('Слишком большая партия материалов')
  return quantity
}
export function manufacturingHours(recipe: IndustryRecipe, runs: number, te: number, reduction: number, levels: ReadonlyMap<number, number>, definitions: IndustryCatalog['skills']): number {
  let multiplier = (1 - te / 100) * (1 - reduction / 100)
  for (const id of new Set([3380, 3388, ...recipe.skills.map(s => s.typeId)])) {
    multiplier *= 1 + (definitions[id]?.timeBonus ?? 0) * (levels.get(id) ?? 0) / 100
  }
  return recipe.time * runs * multiplier / 3600
}

export function calculateIndustryOpportunity(input: {
  recipe: IndustryRecipe; catalog: IndustryCatalog; request: IndustryScanRequest
  skills: readonly IndustrySkill[]; ownedBlueprint?: IndustryBlueprint; contractBlueprint?: IndustryContractBlueprint; busyBlueprintIds?: ReadonlySet<number>
  buyOrders: ReadonlyMap<number, readonly MarketOrder[]>; sellOrders: ReadonlyMap<number, readonly MarketOrder[]>
  blueprintOrders: ReadonlyMap<number, readonly MarketOrder[]>; adjustedPrices: ReadonlyMap<number, number>; systemCostIndex: number
  stock?: ReadonlyMap<number, number>
  /** Internal fast assessment; final capacity is still independently re-quoted. */
  skipCapacity?: boolean
}): IndustryOpportunity {
  const { recipe, catalog, adjustedPrices } = input
  const request = { ...input.request, runs: industryRuns(input.recipe, input.request) }
  const salesMode = request.salesMode ?? 'buy'
  const levels = industrySkillLevels(input.skills)
  const owned = input.ownedBlueprint
  const contract = input.contractBlueprint
  const warnings: string[] = []
  const me = contract?.me ?? owned?.materialEfficiency ?? 0
  const te = contract?.te ?? owned?.timeEfficiency ?? 0
  const offered = (input.blueprintOrders.get(recipe.blueprintTypeId) ?? [])
    .filter(o => !o.isBuyOrder && o.volumeRemain > 0 && o.minVolume <= 1 && catalog.stations[o.locationId] !== undefined)
    .sort((a, b) => a.price - b.price || a.locationId - b.locationId)[0]
  const purchaseCost = contract?.price ?? (request.blueprintMode === 'owned' ? (owned ? 0 : null) : request.blueprintMode === 'contracts' ? null : offered?.price ?? null)
  const blueprintCost = contract?.copy ? contract.price / contract.runs * request.runs : purchaseCost
  const locationId = contract?.locationId ?? (request.blueprintMode === 'owned' ? owned?.locationId ?? null : request.blueprintMode === 'contracts' ? null : offered?.locationId ?? null)
  if (blueprintCost === null) warnings.push(request.blueprintMode === 'owned' ? 'Нет подходящего собственного чертежа' : 'Нет BPO в выбранных регионах; копии и исследованные BPO продаются через контракты')
  if (owned && owned.quantity === -2 && owned.runs < request.runs) warnings.push('Недостаточно запусков в BPC')
  if (contract?.copy && contract.runs < request.runs) warnings.push('Недостаточно запусков в BPC контракта на запрошенную партию')
  if (owned && input.busyBlueprintIds?.has(owned.itemId)) warnings.push('Чертёж занят текущим заданием')
  if (owned?.quantity === -2) warnings.push('Стоимость уже имеющегося BPC не включена; повторная партия потребует новой копии, если запуски закончатся')
  if (contract?.copy) warnings.push('Цена BPC на прогон = полная цена контракта / доступные запуски. При покупке оплачивается весь контракт; оставшиеся запуски остаются в копии.')
  if (contract?.bundled) warnings.push('Контракт содержит пакет: списана полная цена всего пакета, прочие предметы не считаются доходом')
  if (contract) warnings.push(`Контракт #${contract.contractId}: перед покупкой проверьте доступность, место и содержимое в EVE`)
  if (locationId && locationId !== getMarketHub(request.buyHubId).stationId) warnings.push('Чертёж находится вне хаба закупки: требуется доставка')
  const materials = recipe.materials.map(m => {
    const quantity = manufacturingQuantity(m.quantity, request.runs, me, request.materialReductionPercent)
    const orders = input.buyOrders.get(m.typeId) ?? []
    const book = summarizeMarketBook(orders, quantity)
    const available = Math.min(quantity, input.stock?.get(m.typeId) ?? 0)
    return { typeId: m.typeId, name: catalog.types[m.typeId]?.name ?? `Type #${m.typeId}`, quantity, fill: industryLimitFill(book.immediateBuy, 'buy'),
      stock: input.stock ? { locationId: request.stockLocationId ?? getMarketHub(request.buyHubId).stationId, quantity: available, marketUnitPrice: book.bestSell,
        deficitFill: available === quantity ? null : industryLimitFill(summarizeMarketBook(orders, quantity - available).immediateBuy, 'buy') } : undefined }
  })
  const materialCost = materials.every(m => m.fill.complete) ? materials.reduce((sum, m) => sum + m.fill.total, 0) : null
  if (materialCost === null) warnings.push('Не хватает sell-ордеров материалов на всю партию')
  const outputQuantity = recipe.productQuantity * request.runs
  if (!Number.isSafeInteger(outputQuantity) || outputQuantity > 2_147_483_647) throw new RangeError('Слишком большая партия продукции')
  const outputBook = summarizeMarketBook(input.sellOrders.get(recipe.productTypeId) ?? [], outputQuantity)
  const outputFill = industryLimitFill(outputBook.immediateSell, 'sell')
  const grossRevenue = salesMode === 'buy' ? outputFill.complete ? outputFill.total : null : outputBook.bestSell === null ? null : outputBook.bestSell * outputQuantity
  if (grossRevenue === null) warnings.push(salesMode === 'buy' ? 'Не хватает buy-ордеров на всю готовую партию' : 'Нет sell-цены для оценки продажи ордером')
  if (salesMode === 'sell') warnings.push('SELL — оценка по минимальной цене конкурентов, не обещание продажи. Покупателя и срок ожидания ESI не гарантирует; комиссия задана вручную, изменения ордера не учтены.')
  // EIV is the unmodified, ME=0 material recipe valued at ESI adjusted prices.
  const eiv = recipe.materials.every(m => adjustedPrices.has(m.typeId))
    ? recipe.materials.reduce((sum, m) => sum + m.quantity * adjustedPrices.get(m.typeId)!, 0) * request.runs : null
  const installationCost = eiv === null ? null : eiv * (
    input.systemCostIndex * (1 - request.jobCostReductionPercent / 100) +
    (request.facilityTaxPercent + request.sccPercent + (request.clone === 'alpha' ? 0.25 : 0)) / 100
  )
  if (installationCost === null) warnings.push('Нет adjusted price: стоимость запуска неизвестна')
  const taxPercent = industrySalesTaxPercent(levels)
  const salesTax = grossRevenue === null ? null : grossRevenue * taxPercent / 100
  const brokerFee = salesMode === 'buy' ? 0 : grossRevenue === null ? null : grossRevenue * (request.brokerFeePercent ?? 3) / 100
  const operatingCost = materialCost === null || installationCost === null ? null : materialCost + installationCost + request.transportCost
  const copyRuns = contract?.copy ? contract.runs : owned?.quantity === -2 ? owned.runs : null
  const operatingProfit = operatingCost === null || grossRevenue === null || salesTax === null || brokerFee === null || copyRuns !== null && copyRuns < request.runs ? null : grossRevenue - salesTax - brokerFee - operatingCost
  // A purchased copy is consumable: repeating the batch requires buying another copy.
  const repeatProfit = operatingProfit === null || blueprintCost === null ? null : contract?.copy ? operatingProfit - blueprintCost : operatingProfit
  const capitalRequired = operatingCost === null || purchaseCost === null || salesMode === 'sell' && brokerFee === null ? null : operatingCost + purchaseCost + (brokerFee ?? 0)
  const profit = operatingProfit === null || blueprintCost === null ? null : operatingProfit - blueprintCost
  const missingSkills = missingIndustrySkills(recipe, levels, catalog.skills)
  const hours = manufacturingHours(recipe, request.runs, te, request.timeReductionPercent, levels, catalog.skills)
  const jobDurationAllowed = request.runs === 1 || hours <= 30 * 24
  if (!jobDurationAllowed) warnings.push('Партия длиннее 30 дней: уменьшите число запусков одного задания')
  const confirmedBatchRuns = (limit: number, buyers: boolean): number => {
    // Minimum lots can disallow a smaller count imposed by another constraint.
    for (let attempt = 0; attempt < 32 && limit > 0; attempt++) {
      const next = Math.min(limit, ...recipe.materials.map(m => executableRuns(input.buyOrders.get(m.typeId) ?? [], limit, runs => manufacturingQuantity(m.quantity, runs, me, request.materialReductionPercent), 'buy')),
        buyers ? executableRuns(input.sellOrders.get(recipe.productTypeId) ?? [], limit, runs => recipe.productQuantity * runs, 'sell') : limit)
      if (next === limit) return limit
      limit = next
    }
    return 0
  }
  const maxMaterialRuns = input.skipCapacity ? materialCost === null ? 0 : request.runs : confirmedBatchRuns(request.runs, false)
  const maxBuyRuns = input.skipCapacity ? outputFill.complete ? request.runs : 0 : executableRuns(input.sellOrders.get(recipe.productTypeId) ?? [], request.runs, runs => recipe.productQuantity * runs, 'sell')
  const productionLimit = Math.min(maxMaterialRuns, copyRuns ?? request.runs, hours > 0 ? Math.max(1, Math.floor(request.runs * 720 / hours)) : request.runs)
  const maxProductionRuns = input.skipCapacity ? productionLimit : confirmedBatchRuns(productionLimit, false)
  const maxImmediateRuns = input.skipCapacity ? Math.min(maxProductionRuns, maxBuyRuns) : confirmedBatchRuns(Math.min(maxProductionRuns, maxBuyRuns), true)
  const maxFeasibleRuns = salesMode === 'buy' ? maxImmediateRuns : maxProductionRuns
  const nonMaterialReady = blueprintCost !== null && missingSkills.length === 0 && jobDurationAllowed && installationCost !== null && (copyRuns === null || copyRuns >= request.runs) && (!owned || !input.busyBlueprintIds?.has(owned.itemId))
  const productionReady = nonMaterialReady && materialCost !== null
  return {
    blueprintTypeId: recipe.blueprintTypeId, productTypeId: recipe.productTypeId, productName: recipe.productName,
    blueprintName: recipe.name, requiredSkills: requiredIndustrySkills(recipe, levels, catalog.skills),
    runs: request.runs, outputQuantity,
    blueprint: { source: contract ? contract.copy ? 'contract-copy' : 'contract-original' : request.blueprintMode !== 'owned' ? 'market' : owned?.quantity === -2 ? 'owned-copy' : 'owned-original', contractId: contract?.contractId, itemId: owned?.itemId ?? null, cost: blueprintCost, purchaseCost, locationId, systemName: locationId ? catalog.systems[catalog.stations[locationId]] ?? null : null, me, te, availableRuns: contract?.copy ? contract.runs : owned?.quantity === -2 ? owned.runs : null },
    materials, materialCost, installationCost, grossRevenue, salesTax, salesTaxPercent: taxPercent, transportCost: request.transportCost,
    repeatProfit, profit, capitalRequired, marginPercent: profit !== null && capitalRequired !== null && capitalRequired > 0 ? profit / capitalRequired * 100 : null,
    hours, profitPerHour: profit !== null && hours > 0 ? profit / hours : null,
    breakEvenBatches: !contract?.copy && blueprintCost !== null && repeatProfit !== null && repeatProfit > 0 ? Math.max(1, Math.ceil(blueprintCost / repeatProfit)) : null,
    salesMode, brokerFee, sellUnitPrice: outputBook.bestSell, productionReady, nonMaterialReady, requestedQuantity: request.productionQuantity ?? outputQuantity, maxMaterialRuns, maxBuyRuns, maxProductionRuns, maxImmediateRuns, maxFeasibleRuns,
    missingSkills, marketReady: profit !== null && missingSkills.length === 0 && jobDurationAllowed && (!owned || (owned.quantity !== -2 || owned.runs >= request.runs) && !input.busyBlueprintIds?.has(owned.itemId)), warnings, outputFill
  }
}

export function jobReadyToDeliver(job: IndustryJob, now: number): boolean {
  return job.status === 'ready' || (job.status === 'active' && Date.parse(job.endDate) <= now)
}
