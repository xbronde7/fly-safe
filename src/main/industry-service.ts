import catalogData from './data/industry-catalog.json'
import locationData from './data/industry-locations.json'
import { industryDistances, type IndustryTopology } from '../shared/industry-factories'
import { Cache } from './cache'
import type { EsiClient } from './esi-client'
import type { PersonalEconomyAccountAdapter } from './personal-economy-service'
import type { EconomyAssetRow } from '../shared/personal-economy'
import type { IndustryLedgerSnapshot } from '../shared/industry-ledger'
import { getMarketHub, isMarketHubId, type MarketOrder, type MarketHub } from '../shared/market'
import { industryLiquidity, planIndustryOpportunity } from '../shared/industry-planning'
import { industryProducedJob, type IndustryProductionPricing } from '../shared/industry-production'
import { quoteIndustryMassJob, massJobCashProfit, industryMassReasons, shortlistIndustryMassSources, planIndustryMassProduction, type IndustryMassSource, type IndustryMassPlan } from '../shared/industry-mass'
import {
  INDUSTRY_SCOPES, calculateIndustryOpportunity, validateIndustryRequest, industryRuns,
  type IndustryBlueprint, type IndustryCatalog, type IndustryCharacterSnapshot, type IndustryOpportunity,
  type IndustryJob, type IndustryScanProgress, type IndustryScanRequest, type IndustryScanResult, type IndustrySkill,
  type IndustryContractBlueprint, type IndustryPublicContract, type IndustryContractItem, type IndustryFactoryRequest, type IndustryFactoryResult, type IndustryLiquidityRequest, type IndustryLiquidity, type IndustryRecipe
} from '../shared/industry'

export const INDUSTRY_CATALOG = catalogData as IndustryCatalog
export type IndustryEsiAdapter = Pick<EsiClient, 'getAuthenticatedCharacterWalletTransactions' | 'getAuthenticatedCharacterSkills' | 'getAuthenticatedCharacterBlueprints' | 'getAuthenticatedCharacterIndustryJobs' | 'getAuthenticatedCharacterAssets' | 'getIndustrySystems' | 'getIndustryFacilities' | 'getMarketPrices' | 'getMarketOrders' | 'getMarketHistory' | 'resolveSolarSystemId' | 'getSolarSystem' | 'getPublicContracts' | 'getPublicContractItems'>
interface RegionalBook { orders: MarketOrder[]; fetchedAt: string; snapshotAt?: string; expiresAt?: string }

export class IndustryService {
  private readonly regionLoads = new Map<number, Promise<RegionalBook>>()
  private readonly historyLoads = new Map<string, Promise<IndustryLiquidity | null>>()
  private lastQuotes: { scanId: string; characterId: number; inputs: Map<number, Parameters<typeof calculateIndustryOpportunity>[0]> } | null = null
  constructor(
    private readonly account: PersonalEconomyAccountAdapter,
    private readonly esi: IndustryEsiAdapter,
    private readonly cache: Cache,
    private readonly catalog: IndustryCatalog = INDUSTRY_CATALOG,
    private readonly now: () => number = Date.now,
    private readonly topology: IndustryTopology = locationData
  ) {}

  async liquidity(value: IndustryLiquidityRequest): Promise<IndustryLiquidity[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['hubId', 'typeIds'].includes(k)) || !isMarketHubId(value.hubId) || !Array.isArray(value.typeIds) || value.typeIds.length > 100 || !value.typeIds.every(id => Number.isSafeInteger(id) && id > 0 && !!this.catalog.types[id])) throw new TypeError('Некорректный запрос ликвидности')
    const regionId = getMarketHub(value.hubId).regionId
    const ids = [...new Set(value.typeIds)], rows: IndustryLiquidity[] = []
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const typeId = ids[next++], key = `${regionId}:${typeId}`
        const cached = this.cache.get<IndustryLiquidity>('industry:liquidity:v1', key)
        if (cached) { rows.push(cached.value); continue }
        let task = this.historyLoads.get(key)
        if (!task) {
          task = (async () => {
            try {
              const history = await this.esi.getMarketHistory(regionId, typeId)
              // History is published after downtime. Last-Modified identifies the
              // publication day, not the last day on which this item happened to trade.
              const modified = history.lastModified ? Date.parse(history.lastModified) : this.now()
              const day = Math.floor(modified / 86_400_000) * 86_400_000
              const offset = history.lastModified || new Date(modified).getUTCHours() >= 12 ? 1 : 2
              const through = new Date(day - offset * 86_400_000).toISOString().slice(0, 10)
              const row = industryLiquidity(typeId, regionId, history.points, through, new Date(this.now()).toISOString(), this.now())
              const expiry = history.expiresAt ? Date.parse(history.expiresAt) : this.now() + 3_600_000
              this.cache.set('industry:liquidity:v1', key, row, Math.max(1, Math.min(86_400_000, expiry - this.now())))
              // Pace uncached history reads; two workers stay below a burst even
              // when nearby CDN responses happen to return in a few milliseconds.
              await waitForIndustryRetry(500)
              return row
            } catch { return null } // Unavailable is not zero demand; do not cache failures.
            finally { this.historyLoads.delete(key) }
          })()
          this.historyLoads.set(key, task)
        }
        const row = await task
        if (row) rows.push(row)
      }
    }
    await Promise.all([worker(), worker()])
    return rows
  }

  async getLedger(forceRefresh = false): Promise<IndustryLedgerSnapshot> {
    const authorized = await this.account.getAuthorizedSession()
    if (!authorized) throw new Error('Войдите через EVE SSO для журнала покупок')
    const { characterId, scopes } = authorized.session
    const warnings: string[] = []
    if (!scopes.includes('esi-wallet.read_character_wallet.v1')) {
      warnings.push('Нужно разрешение esi-wallet.read_character_wallet.v1. Переподключите персонажа через EVE SSO.')
    } else {
      try {
        const rows = await this.esi.getAuthenticatedCharacterWalletTransactions(characterId, authorized.accessToken, forceRefresh)
        await this.assertCharacter(characterId)
        this.cache.saveIndustryTransactions(characterId, rows, new Date(this.now()).toISOString())
      } catch {
        await this.assertCharacter(characterId)
        warnings.push('Кошелёк ESI временно недоступен. Показаны ранее сохранённые сделки; новые цены ещё не подтверждены.')
      }
    }
    await this.assertCharacter(characterId)
    const saved = this.cache.getIndustryTransactions(characterId)
    return { characterId, ...saved, warnings, transactions: saved.transactions.map(row => ({ ...row, typeName: this.catalog.types[row.typeId]?.name ?? `Type #${row.typeId}` })) }
  }

  async getCharacter(forceRefresh = false): Promise<IndustryCharacterSnapshot> {
    const authorized = await this.account.getAuthorizedSession()
    if (!authorized) throw new Error('Войдите через EVE SSO для расчёта под своего персонажа')
    const { characterId, scopes } = authorized.session
    const session = authorized.session as { characterName?: string }
    const token = authorized.accessToken
    const warnings: string[] = []
    const load = async <T>(label: string, task: () => Promise<T>): Promise<T | null> => {
      try { return await task() } catch { warnings.push(`${label}: ESI временно недоступен; данные неизвестны`); return null }
    }
    const [skills, blueprints, jobs, assets] = await Promise.all([
      scopes.includes(INDUSTRY_SCOPES.skills) ? load<IndustrySkill[]>('Навыки', () => this.esi.getAuthenticatedCharacterSkills(characterId, token, forceRefresh)) : null,
      scopes.includes(INDUSTRY_SCOPES.blueprints) ? load<IndustryBlueprint[]>('Чертежи', () => this.esi.getAuthenticatedCharacterBlueprints(characterId, token, forceRefresh)) : null,
      scopes.includes(INDUSTRY_SCOPES.jobs) ? load<IndustryJob[]>('Задания', () => this.esi.getAuthenticatedCharacterIndustryJobs(characterId, token, forceRefresh)) : null,
      scopes.includes('esi-assets.read_assets.v1') ? load<EconomyAssetRow[]>('Запасы', () => this.esi.getAuthenticatedCharacterAssets(characterId, token, forceRefresh)) : null
    ])
    await this.assertCharacter(characterId)
    this.persistJobs(characterId, jobs ?? [], blueprints ?? [])
    return {
      characterId, characterName: session.characterName ?? `Character #${characterId}`,
      skills, blueprints, jobs: jobs?.map(j => ({ ...j, productName: j.productTypeId ? this.catalog.types[j.productTypeId]?.name ?? `Type #${j.productTypeId}` : this.catalog.types[j.blueprintTypeId]?.name ?? `Blueprint #${j.blueprintTypeId}` })) ?? null,
      stock: assets ? availableHangarStock(assets) : null,
      missingScopes: [...Object.values(INDUSTRY_SCOPES), 'esi-assets.read_assets.v1'].filter(scope => !scopes.includes(scope)), warnings,
      fetchedAt: new Date(this.now()).toISOString()
    }
  }

  async captureJobs(signal?: AbortSignal): Promise<void> {
    const authorized = await this.account.getAuthorizedSession()
    if (!authorized || signal?.aborted || !authorized.session.scopes.includes(INDUSTRY_SCOPES.jobs)) return
    const id = authorized.session.characterId
    const jobs = await this.esi.getAuthenticatedCharacterIndustryJobs(id, authorized.accessToken)
    await this.assertCharacter(id)
    if (!signal?.aborted) this.persistJobs(id, jobs)
  }
  private persistJobs(characterId: number, jobs: readonly IndustryJob[], blueprints: readonly IndustryBlueprint[] = []): void {
    const existing = new Map(this.cache.getIndustryRecords<ReturnType<typeof industryProducedJob>>(characterId, 'production-job').map(r => [r.key, r.value]))
    for (const job of jobs) {
      const previous = existing.get(String(job.jobId))
      const record = industryProducedJob(job, this.catalog, previous?.firstSeen ?? new Date(this.now()).toISOString(), blueprints.find(b => b.itemId === job.blueprintItemId), previous ?? undefined)
      if (record && JSON.stringify(record) !== JSON.stringify(previous)) this.cache.saveIndustryRecord(characterId, 'production-job', String(job.jobId), record)
    }
  }

  async getProductionPricing(missingTypeIds: number[], needsJobFee: boolean, forceRefresh = false): Promise<IndustryProductionPricing> {
    const result: IndustryProductionPricing = { orders: [], adjustedPrices: [], jitaCostIndex: null, fetchedAt: null }
    // Reuse the paced regional book; no per-job/per-material request fan-out.
    const tasks: Promise<void>[] = []
    if (missingTypeIds.length) tasks.push((async () => {
      const book = await this.loadRegion(getMarketHub('jita').regionId, forceRefresh, () => {})
      const ids = new Set(missingTypeIds)
      result.orders = book.orders.filter(o => ids.has(o.typeId) && !o.isBuyOrder && o.locationId === getMarketHub('jita').stationId)
      result.fetchedAt = book.snapshotAt ?? book.fetchedAt
    })())
    if (needsJobFee) tasks.push((async () => {
      const [prices, systems] = await Promise.all([this.esi.getMarketPrices(forceRefresh), this.esi.getIndustrySystems(forceRefresh)])
      result.adjustedPrices = prices.map(p => ({ typeId: p.typeId, adjustedPrice: p.adjustedPrice }))
      result.jitaCostIndex = systems.find(s => s.systemId === getMarketHub('jita').solarSystemId)?.manufacturingIndex ?? null
    })())
    const results = await Promise.allSettled(tasks)
    if (results.some(r => r.status === 'rejected') && !result.orders.length && result.jitaCostIndex === null) throw new Error('Рынок / индекс Jita недоступен для оценки')
    return result
  }

  async scan(value: IndustryScanRequest, progress?: (event: IndustryScanProgress) => void, signal?: AbortSignal): Promise<IndustryScanResult> {
    const request = validateIndustryRequest(value)
    const quoteInputs = new Map<number, Parameters<typeof calculateIndustryOpportunity>[0]>()
    const quote = (input: Parameters<typeof calculateIndustryOpportunity>[0]): ReturnType<typeof calculateIndustryOpportunity> => {
      input = { ...input, stock: scanStock }
      const row = request.autoPlan ? planIndustryOpportunity(input) : calculateIndustryOpportunity(input)
      row.marketSnapshotAt = [...books.values()].map(b => b.snapshotAt ?? b.fetchedAt).sort()[0]
      quoteInputs.set(input.recipe.blueprintTypeId, input)
      return row
    }
    const assertScanCharacter = async (id: number): Promise<void> => {
      if (signal?.aborted) throw new Error('Сканирование остановлено. Прочитанные контракты сохранены; показанные цены — предварительные, минимум ещё не подтверждён.')
      await this.assertCharacter(id)
    }
    const character = await this.getCharacter(request.forceRefresh)
    const stockLocation = request.stockLocationId ?? getMarketHub(request.buyHubId).stationId
    const scanStock = !request.contractCopiesOnly && character.stock ? new Map(character.stock.filter(s => s.locationId === stockLocation).map(s => [s.typeId, s.quantity])) : undefined
    if (!character.skills) throw new Error(`Не удалось получить активные навыки. Разрешите ${INDUSTRY_SCOPES.skills} в EVE Developers и заново подключите персонажа`)
    if (request.blueprintMode === 'owned' && !character.blueprints) throw new Error(`Для своих чертежей нужны данные ${INDUSTRY_SCOPES.blueprints}`)
    if (request.blueprintMode === 'owned' && !character.jobs) throw new Error(`Для проверки занятых чертежей нужны данные ${INDUSTRY_SCOPES.jobs}`)
    const productionSystemId = /^\d+$/.test(request.productionSystem) ? Number(request.productionSystem) : (await this.esi.resolveSolarSystemId(request.productionSystem))?.id
    if (!productionSystemId || !Number.isSafeInteger(productionSystemId)) throw new Error('Система производства не найдена')
    const [system, indexes, prices] = await Promise.all([
      this.esi.getSolarSystem(productionSystemId), this.esi.getIndustrySystems(request.forceRefresh), this.esi.getMarketPrices(request.forceRefresh)
    ])
    let index = indexes.find(i => i.systemId === productionSystemId)
    if (!index) throw new Error('Нет manufacturing cost index для выбранной системы')
    const regionIds = new Set([getMarketHub(request.buyHubId).regionId, getMarketHub(request.sellHubId).regionId])
    if (['buy', 'combined'].includes(request.blueprintMode)) for (const hub of request.blueprintHubIds) regionIds.add(getMarketHub(hub).regionId)
    const books = new Map<number, RegionalBook>()
    // Bound region-level concurrency as each regional load already pages two at a time.
    for (const regionId of regionIds) {
      progress?.({ scanId: request.scanId, characterId: character.characterId, stage: 'market', completed: books.size, total: regionIds.size, message: `Рынок региона ${regionId}: загрузка ордеров` })
      books.set(regionId, await this.loadRegion(regionId, request.forceRefresh === true, (completed, total) => progress?.({
        scanId: request.scanId, characterId: character.characterId, stage: 'market', completed, total, message: `Регион ${regionId}: страницы ${completed}/${total}`
      })))
      await assertScanCharacter(character.characterId)
    }
    const buyHub = getMarketHub(request.buyHubId)
    const sellHub = getMarketHub(request.sellHubId)
    let buyOrders = groupOrders(ordersAtIndustryHub(books.get(buyHub.regionId)!.orders, buyHub, this.topology))
    let sellOrders = groupOrders(ordersAtIndustryHub(books.get(sellHub.regionId)!.orders, sellHub, this.topology))
    const blueprintRegions = new Set<number>(request.blueprintHubIds.map(id => getMarketHub(id).regionId))
    let blueprintOrders = groupOrders([...books].filter(([id]) => blueprintRegions.has(id)).flatMap(([, book]) => book.orders))
    let adjustedPrices = new Map(prices.flatMap(p => p.adjustedPrice === null ? [] : [[p.typeId, p.adjustedPrice] as const]))
    const busyBlueprintIds = new Set((character.jobs ?? []).filter(j => ['active', 'paused', 'ready'].includes(j.status)).map(j => j.blueprintItemId))
    const ownedByType = new Map<number, IndustryBlueprint[]>()
    for (const b of character.blueprints ?? []) {
      const list = ownedByType.get(b.typeId) ?? []
      list.push(b); ownedByType.set(b.typeId, list)
    }
    const contractOffers = new Map<number, IndustryContractBlueprint[]>()
    const contractWarnings: string[] = []
    const candidateQuotes = new Map<string, { input: Parameters<typeof calculateIndustryOpportunity>[0]; row: IndustryOpportunity; score: number }>()
    const plannedQuotes = new Map<number, { key: string; row: IndustryOpportunity }>()
    const massSources = new Map<number, { key: string; sources: IndustryMassSource[]; row: IndustryOpportunity }>()
    const bestQuote = (recipe: IndustryRecipe): IndustryScanResult['rows'][number] => {
      const runs = request.autoPlan ? 1 : industryRuns(recipe, request)
      const own = (ownedByType.get(recipe.blueprintTypeId) ?? []).filter(b => character.jobs !== null && !busyBlueprintIds.has(b.itemId) && (b.quantity !== -2 || b.runs >= runs) && !['AssetSafety', 'Locked'].includes(b.locationFlag))
        .sort((a, b) => b.materialEfficiency - a.materialEfficiency || b.timeEfficiency - a.timeEfficiency)[0]
      const candidates: Parameters<typeof calculateIndustryOpportunity>[0][] = []
      const base = { recipe, catalog: this.catalog, skills: character.skills!, busyBlueprintIds, buyOrders, sellOrders, blueprintOrders, adjustedPrices, systemCostIndex: index!.manufacturingIndex, stock: scanStock }
      if (request.massProduction) {
        const settings = request.massProduction
        const sourceInputs: Array<{ key: string; capacity: number; input: Parameters<typeof calculateIndustryOpportunity>[0] }> = []
        const addMass = (key: string, capacity: number, mode: 'buy' | 'contracts' | 'owned', extra: Partial<Parameters<typeof calculateIndustryOpportunity>[0]>): void => {
          sourceInputs.push({ key, capacity, input: { ...base, stock: undefined, request: { ...request, blueprintMode: mode }, ...extra } })
        }
        if (character.jobs !== null && ['combined', 'owned'].includes(request.blueprintMode)) for (const b of ownedByType.get(recipe.blueprintTypeId) ?? []) {
          if (!busyBlueprintIds.has(b.itemId) && b.quantity !== -2 && !['AssetSafety', 'Locked'].includes(b.locationFlag)) addMass(`owned:${b.itemId}`, 1, 'owned', { ownedBlueprint: b })
        }
        if (['combined', 'contracts'].includes(request.blueprintMode)) for (const b of contractOffers.get(recipe.blueprintTypeId) ?? []) {
          if (!b.bundled && Date.parse(b.expires) > this.now() && (!b.copy || b.runs >= settings.minimumRuns)) addMass(`contract:${b.contractId}`, 1, 'contracts', { contractBlueprint: b })
        }
        if (['combined', 'buy'].includes(request.blueprintMode) && recipe.marketable) for (const o of blueprintOrders.get(recipe.blueprintTypeId) ?? []) {
          if (!o.isBuyOrder && o.volumeRemain > 0 && o.minVolume <= 1 && this.catalog.stations[o.locationId]) addMass(`market:${o.orderId}`, Math.min(settings.lines, o.volumeRemain), 'buy', { blueprintOrders: new Map([[recipe.blueprintTypeId, [o]]]) })
        }
        const key = JSON.stringify(sourceInputs.map(s => [s.key, s.capacity, s.input.ownedBlueprint, s.input.contractBlueprint, s.input.request.blueprintMode === 'buy' ? s.input.blueprintOrders.get(recipe.blueprintTypeId) : null]))
        const saved = massSources.get(recipe.blueprintTypeId)
        if (saved?.key === key) return saved.row
        // Bound per-type work. Rank full-cycle blueprint outlay, not one-run profit.
        const ranked = sourceInputs.map(s => ({ ...s, price: s.input.contractBlueprint?.price ?? (s.input.ownedBlueprint ? 0 : s.input.blueprintOrders.get(recipe.blueprintTypeId)?.[0]?.price ?? Infinity) }))
          .sort((a, b) => a.price - b.price || a.key.localeCompare(b.key)).slice(0, 16)
        const sources = ranked.flatMap(s => { try { return [{ ...s, quote: { ...quoteIndustryMassJob(s.input, settings), marketSnapshotAt: [...books.values()].map(b => b.snapshotAt ?? b.fetchedAt).sort()[0] } }] } catch (e) { if (e instanceof RangeError) return []; throw e } })
        sources.sort((a, b) => Number(!industryMassReasons(b.quote, settings).length) - Number(!industryMassReasons(a.quote, settings).length) || (massJobCashProfit(b.quote) ?? -Infinity) - (massJobCashProfit(a.quote) ?? -Infinity))
        const selected = sources[0]
        const row = selected?.quote ?? { ...quoteIndustryMassJob({ ...base, stock: undefined, request: { ...request, blueprintMode: 'contracts' } }, settings), marketSnapshotAt: [...books.values()].map(b => b.snapshotAt ?? b.fetchedAt).sort()[0] }
        if (selected) quoteInputs.set(recipe.blueprintTypeId, { ...selected.input, request: { ...selected.input.request, runs: row.runs, productionQuantity: undefined } })
        massSources.set(recipe.blueprintTypeId, { key, sources, row })
        return row
      }
      const add = (mode: 'buy' | 'contracts' | 'owned', ownedBlueprint?: IndustryBlueprint, contractBlueprint?: IndustryContractBlueprint): void => { candidates.push({ ...base, request: { ...request, blueprintMode: mode, ...(request.autoPlan ? { runs: 1, productionQuantity: undefined } : {}) }, ownedBlueprint, contractBlueprint }) }
      if (request.blueprintMode === 'combined') {
        if (recipe.marketable && (blueprintOrders.get(recipe.blueprintTypeId) ?? []).some(o => !o.isBuyOrder && this.catalog.stations[o.locationId])) add('buy')
        if (own) add('owned', own)
        for (const offer of contractOffers.get(recipe.blueprintTypeId) ?? []) if (Date.parse(offer.expires) > this.now()) add('contracts', undefined, offer)
      } else if (request.contractCopiesOnly) {
        for (const offer of contractOffers.get(recipe.blueprintTypeId) ?? []) if (offer.copy && Date.parse(offer.expires) > this.now()) add('contracts', undefined, offer)
      } else {
        add(request.blueprintMode, request.blueprintMode === 'owned' ? own : undefined, request.blueprintMode === 'contracts' ? cheapestContractBlueprint(contractOffers.get(recipe.blueprintTypeId) ?? [], runs, this.now()) : undefined)
      }
      if (!candidates.length) add('buy')
      // Compare real ME/TE costs, not just blueprint sticker prices. BUY is the
      // conservative default; where it cannot fill one run, rank SELL estimates.
      const candidateKey = (input: Parameters<typeof calculateIndustryOpportunity>[0]): string => JSON.stringify([recipe.blueprintTypeId, input.request.blueprintMode, input.ownedBlueprint, input.contractBlueprint])
      const ranked = candidates.map(input => {
        const key = candidateKey(input)
        let cached = candidateQuotes.get(key)
        if (!cached) {
          const row = calculateIndustryOpportunity({ ...input, skipCapacity: true })
          cached = { input, row, score: row.repeatProfit ?? (row.materialCost !== null && row.installationCost !== null && row.sellUnitPrice !== null && row.blueprint.cost !== null ? row.sellUnitPrice * row.outputQuantity * (1 - (row.salesTaxPercent + (request.brokerFeePercent ?? 3)) / 100) - row.materialCost - row.installationCost - row.transportCost - (row.blueprint.source.endsWith('copy') ? row.blueprint.cost : 0) : -Infinity) }
          candidateQuotes.set(key, cached)
        }
        return cached
      })
        .sort((a, b) => b.score - a.score || (a.row.blueprint.purchaseCost ?? Infinity) - (b.row.blueprint.purchaseCost ?? Infinity))
      const key = candidateKey(ranked[0].input)
      let planned = plannedQuotes.get(recipe.blueprintTypeId)
      if (!planned || planned.key !== key) {
        planned = { key, row: quote(ranked[0].input) }
        plannedQuotes.set(recipe.blueprintTypeId, planned)
      }
      return planned.row.plan ? { ...planned.row, plan: { ...planned.row.plan, sourceCount: candidates.length } } : planned.row
    }
    if (request.blueprintMode === 'combined') {
      const initial = this.catalog.blueprints.filter(r => ownedByType.has(r.blueprintTypeId) || r.marketable && blueprintOrders.has(r.blueprintTypeId))
      const pending: IndustryOpportunity[] = []
      for (let i = 0; i < initial.length; i++) {
        try { pending.push(bestQuote(initial[i])) } catch (error) { if (!(error instanceof RangeError)) throw error }
        if ((i + 1) % 25 === 0 || i === initial.length - 1) progress?.({ scanId: request.scanId, characterId: character.characterId, stage: 'market', completed: i + 1, total: initial.length, message: 'Рынок и свои чертежи · предварительные расчёты; контракты ещё индексируются', rows: pending.splice(0) })
        await new Promise<void>(resolve => setImmediate(resolve))
        await assertScanCharacter(character.characterId)
      }
    }
    if (['contracts', 'combined'].includes(request.blueprintMode)) {
      const blueprintTypes = new Set(this.catalog.blueprints.map(r => r.blueprintTypeId))
      const contracts = new Map<number, IndustryPublicContract>()
      for (const region of blueprintRegions) {
        progress?.({ scanId: request.scanId, characterId: character.characterId, stage: 'market', completed: contracts.size, total: 0, message: `База контрактов: загрузка региона ${region}` })
        for (const c of await this.esi.getPublicContracts(region, request.forceRefresh)) {
          if (c.type === 'item_exchange' && c.price !== null && c.locationId !== null && Date.parse(c.expires) > this.now()) contracts.set(c.contractId, c)
        }
        await assertScanCharacter(character.characterId)
      }
      let completed = 0
      let unavailableMetadata = 0
      let index = 0
      let failure: unknown
      const list = [...contracts.values()]
      const recipesByType = new Map(this.catalog.blueprints.map(r => [r.blueprintTypeId, r]))
      const pendingTypes = new Set<number>()
      let lastProgress = 0
      const publishContracts = (): void => {
        const readyRows = [...pendingTypes].flatMap(typeId => {
          try { return [bestQuote(recipesByType.get(typeId)!)] }
          catch (error) { if (error instanceof RangeError) return []; throw error }
        })
        pendingTypes.clear()
        lastProgress = this.now()
        progress?.({ scanId: request.scanId, characterId: character.characterId, stage: 'market', completed, total: list.length, message: `База контрактов: ${completed}/${list.length} · найдено типов чертежей ${contractOffers.size}`, rows: readyRows })
      }
      // Cache each immutable contract's contents in SQLite. Interrupted indexing resumes
      // from cached items; two workers avoid an unbounded burst of ESI requests.
      const worker = async (): Promise<void> => {
        while (index < list.length && failure === undefined) {
          const c = list[index++]
          await assertScanCharacter(character.characterId)
          let items: IndustryContractItem[]
          try {
            const saved = this.cache.get<IndustryContractItem[]>('industry:contract-index-items:v1', String(c.contractId))
            if (saved) items = saved.value
            else {
              let attempt = 0
              while (true) {
                try { items = await this.esi.getPublicContractItems(c.contractId); break }
                catch (error) {
                  if (!isTransientIndustryError(error) || ++attempt > 5) throw error
                  const limited = error instanceof Error && 'status' in error && Number(error.status) === 429
                  const wait = error instanceof Error && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number' ? Math.max(1000, error.retryAfterMs) : limited ? 10_000 : Math.min(10_000, 1000 * 2 ** (attempt - 1))
                  progress?.({ scanId: request.scanId, characterId: character.characterId, stage: 'market', completed, total: list.length, message: `ESI ${limited ? 'ограничил запросы' : 'не передал полный ответ'}: повтор контракта #${c.contractId} через ${Math.ceil(wait / 1000)} сек. Найденные расчёты сохранены.` })
                  await waitForIndustryRetry(wait, signal)
                }
              }
            }
            // A contract's issued inventory cannot be edited; its live presence/price
            // are still checked against each refreshed regional list. No failed
            // response is persisted here. Keep immutable metadata until expiry.
            if (!saved) this.cache.set('industry:contract-index-items:v1', String(c.contractId), items, Math.max(1, Date.parse(c.expires) - this.now()))
          }
          catch (error) {
            // Accepted/expired/private contracts can disappear between list and contents.
            if (error instanceof Error && 'status' in error && [403, 404].includes(Number(error.status))) items = []
            else throw error
          }
          if (!items.some(i => !i.included)) {
            for (const item of items.filter(i => blueprintTypes.has(i.typeId))) {
              const offer = contractBlueprintOffer(c, item, items)
              if (!offer) { unavailableMetadata++; continue }
              if (request.contractCopiesOnly && !offer.copy) continue
              const current = contractOffers.get(item.typeId) ?? []
              current.push(offer); contractOffers.set(item.typeId, current)
              pendingTypes.add(item.typeId)
            }
          }
          completed++
          if (this.now() - lastProgress >= 250) publishContracts()
          // Resolved auth/cache promises otherwise keep the microtask queue busy
          // for the entire cached index and starve native UI/abort IPC handling.
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
      await Promise.all([worker().catch(error => { failure = error }), worker().catch(error => { failure = error })])
      publishContracts()
      if (failure !== undefined) throw failure
      contractWarnings.push(`База публичных контрактов выбранных регионов: проверено ${completed} контрактов продажи, найдено ${contractOffers.size} типов чертежей. Аукционы, обмены с доплатой предметами и недоступные контракты не учитываются.`)
      if (unavailableMetadata) contractWarnings.push(`Для ${unavailableMetadata} чертежей контракт не отдал ME/TE/запуски: такие предложения исключены, параметры не выдумываются.`)
    }
    // Long contract indexing must not turn its initial price book into a fresh
    // final quote. Reload expired books and re-quote all rows before completion.
    if ([...books.values()].some(b => this.now() - Date.parse(b.fetchedAt) >= 300_000 || b.expiresAt && Date.parse(b.expiresAt) <= this.now())) {
      progress?.({ scanId: request.scanId, characterId: character.characterId, stage: 'market', completed: 0, total: regionIds.size, message: 'Контракты прочитаны · обновляю устаревшие цены перед итоговым расчётом' })
      for (const region of regionIds) {
        books.set(region, await this.loadRegion(region, true, () => {}))
        await assertScanCharacter(character.characterId)
      }
      buyOrders = groupOrders(ordersAtIndustryHub(books.get(buyHub.regionId)!.orders, buyHub, this.topology))
      sellOrders = groupOrders(ordersAtIndustryHub(books.get(sellHub.regionId)!.orders, sellHub, this.topology))
      blueprintOrders = groupOrders([...books].filter(([id]) => blueprintRegions.has(id)).flatMap(([, book]) => book.orders))
      const [freshIndexes, freshPrices] = await Promise.all([this.esi.getIndustrySystems(true), this.esi.getMarketPrices(true)])
      index = freshIndexes.find(i => i.systemId === productionSystemId)
      if (!index) throw new Error('Нет актуального manufacturing cost index')
      adjustedPrices = new Map(freshPrices.flatMap(p => p.adjustedPrice === null ? [] : [[p.typeId, p.adjustedPrice] as const]))
      candidateQuotes.clear()
      plannedQuotes.clear()
      massSources.clear()
      if (['contracts', 'combined'].includes(request.blueprintMode)) {
        const live = new Map<number, IndustryPublicContract>()
        for (const region of blueprintRegions) {
          for (const contract of await this.esi.getPublicContracts(region, true)) if (contract.type === 'item_exchange' && Date.parse(contract.expires) > this.now()) live.set(contract.contractId, contract)
          await assertScanCharacter(character.characterId)
        }
        for (const [typeId, offers] of contractOffers) {
          const confirmed = offers.flatMap(offer => { const contract = live.get(offer.contractId); return contract?.price !== null && contract?.price !== undefined && contract.locationId !== null ? [{ ...offer, price: contract.price, locationId: contract.locationId, expires: contract.expires }] : [] })
          if (confirmed.length) contractOffers.set(typeId, confirmed)
          else contractOffers.delete(typeId)
        }
        contractWarnings.push('Список контрактов повторно проверен после индексации. Новые предложения требуют следующего прохода; список ESI также кешируется (до 30 минут). Перед оплатой проверяйте контракт в EVE.')
      }
    }
    const recipes = this.catalog.blueprints.filter(r => request.blueprintMode === 'combined' ? contractOffers.has(r.blueprintTypeId) || ownedByType.has(r.blueprintTypeId) || r.marketable && blueprintOrders.has(r.blueprintTypeId) : request.blueprintMode === 'buy' ? r.marketable : request.blueprintMode === 'contracts' ? contractOffers.has(r.blueprintTypeId) : ownedByType.has(r.blueprintTypeId))
    const rows: IndustryScanResult['rows'] = []
    let oversizedRecipes = 0
    const pendingRows: IndustryOpportunity[] = []
    for (let i = 0; i < recipes.length; i++) {
      const batch = [recipes[i]].flatMap(recipe => {
        try {
          return [bestQuote(recipe)]
        } catch (error) {
          if (!(error instanceof RangeError)) throw error
          oversizedRecipes += 1
          return []
        }
      })
      rows.push(...batch)
      pendingRows.push(...batch)
      const completed = i + 1
      if (completed % 25 === 0 || completed === recipes.length) progress?.({ scanId: request.scanId, characterId: character.characterId, stage: 'calculating', completed, total: recipes.length, message: `Проверено ${completed}/${recipes.length} чертежей`, rows: pendingRows.splice(0) })
      await new Promise<void>(resolve => setImmediate(resolve))
      await assertScanCharacter(character.characterId)
    }
    await assertScanCharacter(character.characterId)
    let massPlan: IndustryMassPlan | undefined
    if (request.massProduction) {
      const sources = [...massSources.values()].flatMap(s => s.sources)
      const shortlist = shortlistIndustryMassSources(sources, request.massProduction)
      const ids = [...new Set(shortlist.map(s => s.quote.productTypeId))]
      const demand: IndustryLiquidity[] = []
      for (let i = 0; i < ids.length; i += 25) {
        progress?.({ scanId: request.scanId, characterId: character.characterId, stage: 'calculating', completed: i, total: ids.length, message: `План ${request.massProduction.lines} линий · проверяю спрос ${i}/${ids.length}` })
        demand.push(...await this.liquidity({ hubId: request.sellHubId, typeIds: ids.slice(i, i + 25) }))
        await assertScanCharacter(character.characterId)
      }
      const base = sources[0]?.input ?? { recipe: this.catalog.blueprints[0], catalog: this.catalog, request, skills: character.skills!, busyBlueprintIds, buyOrders, sellOrders, blueprintOrders, adjustedPrices, systemCostIndex: index.manufacturingIndex }
      // All sources use the same regional books. Recheck age after history reads;
      // a stale plan is never labelled fresh merely because computation just ended.
      massPlan = planIndustryMassProduction(sources, base, request.massProduction, character, demand)
      if ([...books.values()].some(b => this.now() - Date.parse(b.snapshotAt ?? b.fetchedAt) > 600000)) massPlan.warnings.push('Пока проверяли спрос, рынку исполнилось более 10 минут. План устарел — обновите цены перед закупкой.')
    }
    await assertScanCharacter(character.characterId)
    this.lastQuotes = { scanId: request.scanId, characterId: character.characterId, inputs: quoteInputs }
    return {
      scanId: request.scanId, characterId: character.characterId, characterName: character.characterName, rows,
      productionSystemId, productionSystemName: system.name, systemCostIndex: index.manufacturingIndex,
      catalogBuild: this.catalog.build, catalogReleasedAt: this.catalog.releasedAt, fetchedAt: new Date(this.now()).toISOString(),
      marketFetchedAt: [...books.values()].map(b => b.snapshotAt ?? b.fetchedAt).sort()[0], request, massPlan,
      warnings: [...character.warnings, ...contractWarnings,
        ...(oversizedRecipes ? [`Пропущено ${oversizedRecipes} рецептов: партия превышает безопасный лимит количества. Уменьшите запуски.`] : []),
        'Расчёт — снимок ESI, не текущий тик EVE: ордера кешируются сервером примерно на 5 минут. SELL закупается на выбранной станции; BUY включает покрывающие её региональные и дистанционные заявки. Multibuy: цена всего количества одного материала = самая дорогая использованная заявка; мгновенная продажа = самая дешёвая принимающая заявка. Это единая лимитная цена партии, а не средняя по стакану.',
        request.massProduction ? 'Массовый режим: отдельные чертежи, длинные многопрогонные партии, полная покупка BPC/BPO. До 16 предложений на тип; общий план — ограниченный подбор до 80 кандидатов, не глобальный оптимум.' : 'Чертежи: рынок, публичные контракты и доступные собственные. В объединённом режиме выбрано предложение с лучшей прибылью прогона при реальном ME/TE; покупка BPO показана отдельно, BPC расходуется. Собственные BPC без истории стоимости не считаются подтверждённо бесплатными: проверьте цену приобретения.',
        'Налог сооружения, бонусы и статус Alpha/Omega заданы вручную. Проверьте ограничения выбранной фабрики, импланты и доставку.',
        'Все материалы оценены по полной закупочной цене: свои запасы не считаются бесплатными. Перевозка — указанная сумма на партию.'
      ]
    }
  }

  async factories(value: IndustryFactoryRequest): Promise<IndustryFactoryResult> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['scanId', 'blueprintTypeId', 'originSystem', 'maxJumps', 'highSecOnly', 'salesMode', 'brokerFeePercent'].includes(k)) ||
      typeof value.scanId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.scanId) || !Number.isSafeInteger(value.blueprintTypeId) || value.blueprintTypeId < 1 ||
      typeof value.originSystem !== 'string' || !value.originSystem.trim() || value.originSystem.length > 80 || !Number.isSafeInteger(value.maxJumps) || value.maxJumps < 0 || value.maxJumps > 10 || typeof value.highSecOnly !== 'boolean') throw new TypeError('Некорректный поиск фабрик')
    const saved = this.lastQuotes
    if (!saved || saved.scanId !== value.scanId) throw new Error('Сначала завершите расчёт производства; параметры предыдущего расчёта устарели')
    await this.assertCharacter(saved.characterId)
    const input = saved.inputs.get(value.blueprintTypeId)
    if (!input) throw new Error('Чертёж не найден в последнем расчёте')
    const salesRequest = validateIndustryRequest({ ...input.request, salesMode: value.salesMode ?? input.request.salesMode, brokerFeePercent: value.brokerFeePercent ?? input.request.brokerFeePercent })
    const origin = Object.entries(this.topology.systems).find(([id, system]) => id === value.originSystem.trim() || system.name.toLowerCase() === value.originSystem.trim().toLowerCase())
    if (!origin) throw new Error('Начальная система не найдена в SDE')
    const distances = industryDistances(this.topology, Number(origin[0]), value.maxJumps, value.highSecOnly)
    const [facilities, indexes] = await Promise.all([this.esi.getIndustryFacilities(), this.esi.getIndustrySystems()])
    const costs = new Map(indexes.map(i => [i.systemId, i.manufacturingIndex]))
    const rows = facilities.flatMap(f => {
      const station = this.topology.factories[f.facilityId], system = this.topology.systems[f.systemId], jumps = distances.get(f.systemId), sci = costs.get(f.systemId)
      if (!station || station.systemId !== f.systemId || !system || jumps === undefined || sci === undefined) return []
      const row = calculateIndustryOpportunity({ ...input, systemCostIndex: sci, request: { ...salesRequest, productionSystem: system.name, facilityTaxPercent: 0.25, materialReductionPercent: 0, timeReductionPercent: 0, jobCostReductionPercent: 0 } })
      return [{ facilityId: f.facilityId, name: station.name, systemId: f.systemId, systemName: system.name, security: system.security, jumps,
        systemCostIndex: sci, installationCost: row.installationCost, materialCost: row.materialCost, hours: row.hours, profit: input.request.massProduction ? massJobCashProfit(row) : row.profit, repeatProfit: row.repeatProfit }]
    }).sort((a, b) => (a.installationCost ?? Infinity) - (b.installationCost ?? Infinity) || a.jumps - b.jumps || a.name.localeCompare(b.name))
    await this.assertCharacter(saved.characterId)
    return { originSystemName: origin[1].name, rows, fetchedAt: new Date(this.now()).toISOString(), warnings: [
      'Только NPC-станции из публичного списка ESI с услугой Factory в SDE. Полного списка частных заводов, их доступа, топлива, ригов и тарифов ESI не даёт.',
      'Модель NPC: налог 0.25% EIV, бонусы материалов/времени/SCI 0%; SCC и клон взяты из расчёта. Это оценка: проверьте окно запуска в EVE и возможность изготовления выбранного предмета.',
      'Маршруты по обычным воротам SDE, без Ansiblex и червоточин. Доставка задана вручную и не зависит автоматически от числа прыжков. Рынок — снимок последнего расчёта.'
    ] }
  }

  private async assertCharacter(expectedId: number): Promise<void> {
    const current = await this.account.getAuthorizedSession()
    if (current?.session.characterId !== expectedId) throw new Error('Персонаж изменился во время загрузки. Повторите расчёт')
  }
  private async loadRegion(regionId: number, force: boolean, progress: (completed: number, total: number) => void): Promise<RegionalBook> {
    const scope = 'industry:regional-book:v2'
    if (!force) {
      const cached = this.cache.get<RegionalBook>(scope, String(regionId))
      if (cached) return cached.value
    }
    const existing = this.regionLoads.get(regionId)
    if (existing) return existing
    const operation = (async () => {
      const response = await this.esi.getMarketOrders(regionId, undefined, progress)
      // Never store a partial book: a failed page invalidates the whole quote.
      const book = { orders: response.orders, fetchedAt: new Date(this.now()).toISOString(), snapshotAt: response.snapshotAt, expiresAt: response.expiresAt }
      this.cache.set(scope, String(regionId), book, Math.max(1, Math.min(300_000, response.expiresAt ? Date.parse(response.expiresAt) - this.now() : 300_000)))
      return book
    })()
    this.regionLoads.set(regionId, operation)
    try { return await operation } finally { this.regionLoads.delete(regionId) }
  }
}

export function ordersAtIndustryHub(orders: readonly MarketOrder[], hub: MarketHub, topology: IndustryTopology): MarketOrder[] {
  const distances = industryDistances(topology, hub.solarSystemId, 40, false)
  return orders.filter(o => {
    if (o.locationId === hub.stationId) return true
    if (!o.isBuyOrder) return false
    if (o.range === 'region') return true // Input is strictly the hub's regional book.
    if (o.range === 'solarsystem') return o.systemId === hub.solarSystemId
    if (!/^\d+$/.test(o.range)) return false
    return (distances.get(o.systemId) ?? Infinity) <= Number(o.range)
  })
}

export function contractBlueprintOffer(contract: IndustryPublicContract, item: IndustryContractItem, items: readonly IndustryContractItem[]): IndustryContractBlueprint | null {
  const copy = item.copy ?? (item.runs === -1 ? false : item.runs !== null && item.runs > 0 ? true : null)
  if (contract.type !== 'item_exchange' || contract.price === null || contract.locationId === null || items.some(i => !i.included) || !item.included || copy === null || item.me === null || item.te === null || item.runs === null || copy && item.runs < 1 || !copy && item.runs !== -1) return null
  return { contractId: contract.contractId, price: contract.price, locationId: contract.locationId, expires: contract.expires, title: contract.title,
    typeId: item.typeId, copy, me: item.me, te: item.te, runs: item.runs, bundled: items.length > 1 || item.quantity > 1 }
}
export function isTransientIndustryError(error: unknown): boolean {
  if (!(error instanceof Error) || !('status' in error)) return false
  return error.status === 429 || typeof error.status === 'number' && error.status >= 500 && error.status <= 599 ||
    error.status === null && error.cause instanceof Error
}
function cheapestContractBlueprint(offers: readonly IndustryContractBlueprint[], runs: number, now: number): IndustryContractBlueprint | undefined {
  return offers.filter(c => Date.parse(c.expires) > now)
    .sort((a, b) => Number(a.copy && a.runs < runs) - Number(b.copy && b.runs < runs) || (a.copy ? a.price / a.runs * runs : a.price) - (b.copy ? b.price / b.runs * runs : b.price) || b.me - a.me || b.te - a.te)[0]
}
async function waitForIndustryRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Сканирование остановлено. Прочитанные контракты сохранены; показанные цены — предварительные, минимум ещё не подтверждён.')
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Сканирование остановлено. Прочитанные контракты сохранены; показанные цены — предварительные, минимум ещё не подтверждён.')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function groupOrders(orders: readonly MarketOrder[]): Map<number, MarketOrder[]> {
  const groups = new Map<number, MarketOrder[]>()
  for (const o of orders) { const list = groups.get(o.typeId) ?? []; list.push(o); groups.set(o.typeId, list) }
  return groups
}

export function availableHangarStock(assets: readonly EconomyAssetRow[]): Array<{ typeId: number; locationId: number; quantity: number }> {
  const grouped = new Map<string, { typeId: number; locationId: number; quantity: number }>()
  // Only directly available station/structure hangars. Fitted items, ships,
  // containers, Asset Safety, corporation assets and cargo are not free factory stock.
  for (const asset of assets) {
    if (asset.locationFlag !== 'Hangar' || asset.singleton || !['station', 'other'].includes(asset.locationType)) continue
    const key = `${asset.locationId}:${asset.typeId}`
    const row = grouped.get(key) ?? { typeId: asset.typeId, locationId: asset.locationId, quantity: 0 }
    row.quantity += asset.quantity; grouped.set(key, row)
  }
  return [...grouped.values()]
}
