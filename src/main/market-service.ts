import {
  MARKET_HUBS,
  getMarketHub,
  isMarketHubId,
  normalizeMarketItemInput,
  normalizeMarketLookupName,
  parseMarketText,
  summarizeMarketBook,
  marketOrderBookDepth,
  summarizeMarketHistory,
  type MarketAppraisal,
  type MarketAppraisalHubTotal,
  type MarketAppraisalItem,
  type MarketAppraisalRequest,
  type MarketComparisonRequest,
  type MarketHubComparison,
  type MarketHubId,
  type MarketHubQuote,
  type MarketQuoteHistory,
  type MarketQuoteRequest,
  type MarketTypeSearchMatch
} from '../shared/market'
import { Cache } from './cache'
import {
  EsiClient,
  type EsiClientOptions,
  type InventoryTypeResolution
} from './esi-client'

export const MARKET_CACHE_TTL = {
  orders: 5 * 60 * 1_000,
  history: 24 * 60 * 60 * 1_000,
  typeCatalog: 24 * 60 * 60 * 1_000
} as const

export const MARKET_CACHE_SCOPES = {
  orders: 'esi:market-orders:v1',
  history: 'esi:market-history:v1',
  typeCatalog: 'esi:market-type-catalog:v1'
} as const

const MAX_SEARCH_MATCHES = 50
const MAX_APPRAISAL_ITEMS = 100
const MARKET_REQUEST_CONCURRENCY = 2

export interface MarketServiceOptions {
  cache?: Cache
  esiClient?: EsiClient
  esi?: EsiClientOptions
  now?: () => number
}

interface CachedOrders {
  orders: Awaited<ReturnType<EsiClient['getMarketOrders']>>['orders']
  pages: number
  snapshotAt?: string
  expiresAt?: string
}

interface CachedHistory {
  points: Awaited<ReturnType<EsiClient['getMarketHistory']>>['points']
}

interface LoadedOrders extends CachedOrders {
  cached: boolean
}

interface LoadedHistory extends CachedHistory {
  cached: boolean
}

interface CachedTypeCatalog {
  matches: MarketTypeSearchMatch[]
}

/** Public ESI market search, hub quotes and clipboard appraisal. */
export class MarketService {
  private readonly cache: Cache
  private readonly esi: EsiClient
  private readonly ownsCache: boolean
  private readonly now: () => number
  private readonly orderLoads = new Map<string, Promise<LoadedOrders>>()
  private readonly historyLoads = new Map<string, Promise<LoadedHistory>>()
  private typeCatalogLoad: Promise<CachedTypeCatalog> | null = null

  constructor(databasePath: string, options: MarketServiceOptions = {}) {
    this.ownsCache = options.cache === undefined
    this.cache = options.cache ?? new Cache(databasePath)
    this.esi = options.esiClient ?? new EsiClient(this.cache, options.esi)
    this.now = options.now ?? Date.now
  }

  /** Autocomplete for public, published inventory type names. */
  async searchInventoryTypes(
    query: string,
    limit = 20,
    forceRefresh = false
  ): Promise<MarketTypeSearchMatch[]> {
    const normalizedQuery = validateSearchQuery(query)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_MATCHES) {
      throw new RangeError(`Search limit must be from 1 to ${MAX_SEARCH_MATCHES}`)
    }

    if (/^\d+$/.test(normalizedQuery)) {
      const typeId = Number(normalizedQuery)
      if (Number.isSafeInteger(typeId) && typeId > 0) {
        try {
          const type = await this.esi.getUniverseType(typeId, forceRefresh)
          return [{ typeId: type.id, name: type.name, exact: true }]
        } catch {
          return []
        }
      }
    }

    const lookup = normalizeMarketLookupName(normalizedQuery)
    const [exactResolution, catalog] = await Promise.all([
      this.esi.resolveInventoryTypes([normalizedQuery], forceRefresh),
      this.loadTypeCatalog(forceRefresh)
    ])
    const exactType = exactResolution[0]?.type ?? null
    const candidates = catalog.matches
      .filter((entry) => normalizeMarketLookupName(entry.name).includes(lookup))
    if (exactType && !candidates.some((entry) => entry.typeId === exactType.id)) {
      candidates.push({ typeId: exactType.id, name: exactType.name, exact: true })
    }
    return candidates
      .map((entry): MarketTypeSearchMatch => ({
        ...entry,
        exact: normalizeMarketLookupName(entry.name) === lookup
      }))
      .sort((left, right) =>
        Number(right.exact) - Number(left.exact) ||
        startsWithRank(right.name, lookup) - startsWithRank(left.name, lookup) ||
        left.name.localeCompare(right.name, 'en')
      )
      .slice(0, limit)
  }

  /** Exact-station executable quote; regional history can be attached on demand. */
  async getHubQuote(request: MarketQuoteRequest): Promise<MarketHubQuote> {
    const normalized = validateQuoteRequest(request)
    const hub = getMarketHub(normalized.hubId)
    const orders = await this.loadOrders(
      hub.regionId,
      normalized.typeId,
      normalized.forceRefresh
    )
    const stationOrders = orders.orders.filter(
      (order) => order.locationId === hub.stationId && order.typeId === normalized.typeId
    )
    const history = normalized.includeHistory
      ? await this.makeHistory(hub.regionId, normalized.typeId, normalized.forceRefresh)
      : null

    return {
      hub,
      typeId: normalized.typeId,
      quantity: normalized.quantity,
      book: summarizeMarketBook(stationOrders, normalized.quantity),
      regionalOrderCount: orders.orders.length,
      stationOrderCount: stationOrders.length,
      history,
      cached: orders.cached && (history?.cached ?? true),
      fetchedAt: orders.snapshotAt ?? this.timestamp(),
      snapshotAt: orders.snapshotAt,
      expiresAt: orders.expiresAt,
      ...(normalized.includeDepth ? { depth: marketOrderBookDepth(stationOrders) } : {})
    }
  }

  /** Compares the same quantity across an explicit, deduplicated hub allow-list. */
  async compareHubs(request: MarketComparisonRequest): Promise<MarketHubComparison> {
    const normalized = validateComparisonRequest(request)
    const quotes = await mapConcurrent(
      normalized.hubIds,
      MARKET_REQUEST_CONCURRENCY,
      (hubId) => this.getHubQuote({
        typeId: normalized.typeId,
        hubId,
        quantity: normalized.quantity,
        includeHistory: normalized.includeHistory,
        includeDepth: normalized.includeDepth,
        forceRefresh: normalized.forceRefresh
      })
    )
    return {
      typeId: normalized.typeId,
      quantity: normalized.quantity,
      quotes,
      cached: quotes.every((quote) => quote.cached),
      fetchedAt: quotes.map(q => q.fetchedAt).sort()[0] ?? this.timestamp()
    }
  }

  /** Resolves an inventory/EFT clipboard and calculates buy/sell totals in selected hubs. */
  async appraiseText(request: MarketAppraisalRequest): Promise<MarketAppraisal> {
    if (!request || typeof request !== 'object') throw new TypeError('Invalid valuation request')
    const parsed = parseMarketText(request.text)
    if (parsed.items.length > MAX_APPRAISAL_ITEMS) {
      throw new RangeError(`No more than ${MAX_APPRAISAL_ITEMS} items can be valued at once`)
    }
    const hubIds = validateHubIds(request.hubIds)
    const forceRefresh = request.forceRefresh === true
    if (parsed.items.length === 0) {
      return {
        items: [],
        unresolved: [],
        totals: emptyTotals(hubIds),
        ignoredLineCount: parsed.ignoredLineCount,
        warnings: parsed.warnings,
        cached: true,
        fetchedAt: this.timestamp()
      }
    }

    const resolutions = await this.esi.resolveInventoryTypes(
      parsed.items.map((item) => item.name),
      forceRefresh
    )
    const resolutionsByName = new Map(
      resolutions.map((resolution) => [
        normalizeMarketLookupName(resolution.inputName),
        resolution
      ])
    )
    const resolvedRows = parsed.items.flatMap((item) => {
      const resolution = resolutionsByName.get(normalizeMarketLookupName(item.name))
      return resolution?.type ? [{ item, resolution }] : []
    })
    const tasks = resolvedRows.flatMap(({ item, resolution }) =>
      hubIds.map((hubId) => ({ item, resolution, hubId }))
    )
    const quoteRows = await mapConcurrent(
      tasks,
      MARKET_REQUEST_CONCURRENCY,
      async ({ item, resolution, hubId }) => ({
        item,
        resolution,
        hubId,
        quote: await this.getHubQuote({
          typeId: resolution.type!.id,
          hubId,
          quantity: item.quantity,
          includeHistory: false,
          forceRefresh
        })
      })
    )

    const quotesByItem = new Map<string, MarketHubQuote[]>()
    for (const row of quoteRows) {
      const key = normalizeMarketLookupName(row.item.name)
      const quotes = quotesByItem.get(key) ?? []
      quotes.push(row.quote)
      quotesByItem.set(key, quotes)
    }
    const items: MarketAppraisalItem[] = resolvedRows.map(({ item, resolution }) => ({
      inputName: item.name,
      name: resolution.type!.name,
      typeId: resolution.type!.id,
      quantity: item.quantity,
      sourceLines: item.sourceLines,
      quotes: hubIds.flatMap((hubId) => {
        const quote = quotesByItem
          .get(normalizeMarketLookupName(item.name))
          ?.find((entry) => entry.hub.id === hubId)
        return quote ? [quote] : []
      })
    }))
    const unresolved = parsed.items.flatMap((item) => {
      const resolution = resolutionsByName.get(normalizeMarketLookupName(item.name))
      return resolution?.type ? [] : [{
        inputName: item.name,
        quantity: item.quantity,
        sourceLines: item.sourceLines,
        reason: 'not-found' as const
      }]
    })

    return {
      items,
      unresolved,
      totals: calculateTotals(items, hubIds),
      ignoredLineCount: parsed.ignoredLineCount,
      warnings: parsed.warnings,
      cached:
        resolutions.every((resolution) => resolution.cached) &&
        items.every((item) => item.quotes.every((quote) => quote.cached)),
      fetchedAt: this.timestamp()
    }
  }

  close(): void {
    if (this.ownsCache) this.cache.close()
  }

  private async makeHistory(
    regionId: number,
    typeId: number,
    forceRefresh: boolean
  ): Promise<MarketQuoteHistory> {
    const history = await this.loadHistory(regionId, typeId, forceRefresh)
    return {
      points: history.points,
      sevenDays: summarizeMarketHistory(history.points, 7),
      thirtyDays: summarizeMarketHistory(history.points, 30),
      cached: history.cached
    }
  }

  private async loadOrders(
    regionId: number,
    typeId: number,
    forceRefresh: boolean
  ): Promise<LoadedOrders> {
    const key = `${regionId}:${typeId}`
    if (!forceRefresh) {
      const hit = this.cache.get<CachedOrders>(MARKET_CACHE_SCOPES.orders, key, this.now())
      if (hit) return { ...hit.value, snapshotAt: hit.value.snapshotAt ?? new Date(hit.createdAt).toISOString(), expiresAt: hit.value.expiresAt ?? new Date(hit.expiresAt).toISOString(), cached: true }
      const pending = this.orderLoads.get(key)
      if (pending) return pending
    }

    const load = (async (): Promise<LoadedOrders> => {
      const result = await this.esi.getMarketOrders(regionId, typeId)
      const value: CachedOrders = { orders: result.orders, pages: result.pages, snapshotAt: result.snapshotAt ?? this.timestamp(), expiresAt: result.expiresAt ?? new Date(this.now() + MARKET_CACHE_TTL.orders).toISOString() }
      this.cache.set(
        MARKET_CACHE_SCOPES.orders,
        key,
        value,
        Math.max(1, Math.min(MARKET_CACHE_TTL.orders, Date.parse(value.expiresAt!) - this.now())),
        this.now()
      )
      return { ...value, cached: false }
    })()
    if (!forceRefresh) this.orderLoads.set(key, load)
    try {
      return await load
    } finally {
      if (!forceRefresh && this.orderLoads.get(key) === load) this.orderLoads.delete(key)
    }
  }

  private async loadHistory(
    regionId: number,
    typeId: number,
    forceRefresh: boolean
  ): Promise<LoadedHistory> {
    const key = `${regionId}:${typeId}`
    if (!forceRefresh) {
      const hit = this.cache.get<CachedHistory>(MARKET_CACHE_SCOPES.history, key, this.now())
      if (hit) return { ...hit.value, cached: true }
      const pending = this.historyLoads.get(key)
      if (pending) return pending
    }

    const load = (async (): Promise<LoadedHistory> => {
      const result = await this.esi.getMarketHistory(regionId, typeId)
      const value: CachedHistory = { points: result.points }
      this.cache.set(
        MARKET_CACHE_SCOPES.history,
        key,
        value,
        MARKET_CACHE_TTL.history,
        this.now()
      )
      return { ...value, cached: false }
    })()
    if (!forceRefresh) this.historyLoads.set(key, load)
    try {
      return await load
    } finally {
      if (!forceRefresh && this.historyLoads.get(key) === load) this.historyLoads.delete(key)
    }
  }

  private async loadTypeCatalog(forceRefresh: boolean): Promise<CachedTypeCatalog> {
    const regionId = getMarketHub('jita').regionId
    const key = String(regionId)
    if (!forceRefresh) {
      const hit = this.cache.get<CachedTypeCatalog>(
        MARKET_CACHE_SCOPES.typeCatalog,
        key,
        this.now()
      )
      if (hit) return hit.value
      if (this.typeCatalogLoad) return this.typeCatalogLoad
    }

    const load = (async (): Promise<CachedTypeCatalog> => {
      const marketTypes = await this.esi.getMarketTypeIds(regionId)
      // Hydrate in ESI's supported batches. Only names are retained in the daily local index.
      const names = await this.esi.getUniverseNames(marketTypes.ids, forceRefresh)
      const value: CachedTypeCatalog = {
        matches: names.flatMap((entry): MarketTypeSearchMatch[] =>
          entry.category === 'inventory_type'
            ? [{ typeId: entry.id, name: entry.name, exact: false }]
            : []
        )
      }
      this.cache.set(
        MARKET_CACHE_SCOPES.typeCatalog,
        key,
        value,
        MARKET_CACHE_TTL.typeCatalog,
        this.now()
      )
      return value
    })()
    if (!forceRefresh) this.typeCatalogLoad = load
    try {
      return await load
    } finally {
      if (!forceRefresh && this.typeCatalogLoad === load) this.typeCatalogLoad = null
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }
}

function validateSearchQuery(query: string): string {
  if (typeof query !== 'string') throw new TypeError('Search query must be text')
  const raw = query.trim()
  if (raw.length > 128 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new RangeError('Name must contain from 3 to 100 characters')
  }
  const normalized = normalizeMarketItemInput(raw)
  const shortNumericId = /^\d{1,2}$/.test(normalized)
  if (
    (!shortNumericId && normalized.length < 3) ||
    normalized.length > 100
  ) {
    throw new RangeError('Name must contain from 3 to 100 characters')
  }
  return normalized
}

function validateQuoteRequest(request: MarketQuoteRequest): Required<MarketQuoteRequest> {
  if (!request || typeof request !== 'object') throw new TypeError('Invalid price request')
  const typeId = validatePositiveId(request.typeId, 'typeId')
  if (!isMarketHubId(request.hubId)) throw new TypeError('Unknown market hub')
  const quantity = request.quantity ?? 1
  for (const key of ['includeDepth', 'includeHistory', 'forceRefresh'] as const) if (request[key] !== undefined && typeof request[key] !== 'boolean') throw new TypeError(`Invalid market flag: ${key}`)
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_147_483_647) {
    throw new RangeError('Invalid item quantity')
  }
  return {
    typeId,
    hubId: request.hubId,
    quantity,
    includeHistory: request.includeHistory === true,
    includeDepth: request.includeDepth === true,
    forceRefresh: request.forceRefresh === true
  }
}

function validateComparisonRequest(request: MarketComparisonRequest): {
  typeId: number
  quantity: number
  hubIds: MarketHubId[]
  includeHistory: boolean
  includeDepth: boolean
  forceRefresh: boolean
} {
  if (!request || typeof request !== 'object') throw new TypeError('Invalid comparison request')
  const firstHub = validateQuoteRequest({
    typeId: request.typeId,
    hubId: request.hubIds?.[0] ?? 'jita',
    quantity: request.quantity,
    includeHistory: request.includeHistory,
    includeDepth: request.includeDepth,
    forceRefresh: request.forceRefresh
  })
  return {
    typeId: firstHub.typeId,
    quantity: firstHub.quantity,
    hubIds: validateHubIds(request.hubIds),
    includeHistory: firstHub.includeHistory,
    includeDepth: firstHub.includeDepth,
    forceRefresh: firstHub.forceRefresh
  }
}

function validateHubIds(value: readonly MarketHubId[] | undefined): MarketHubId[] {
  if (value === undefined) return MARKET_HUBS.map((hub) => hub.id)
  if (!Array.isArray(value) || value.length < 1 || value.length > MARKET_HUBS.length) {
    throw new RangeError(`Select from 1 to ${MARKET_HUBS.length} hubs`)
  }
  const result: MarketHubId[] = []
  for (const hubId of value) {
    if (!isMarketHubId(hubId)) throw new TypeError('Unknown market hub')
    if (!result.includes(hubId)) result.push(hubId)
  }
  return result
}

function validatePositiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid ${label}`)
  return value
}

function startsWithRank(name: string, normalizedQuery: string): number {
  return Number(normalizeMarketLookupName(name).startsWith(normalizedQuery))
}

function calculateTotals(
  items: readonly MarketAppraisalItem[],
  hubIds: readonly MarketHubId[]
): MarketAppraisalHubTotal[] {
  return hubIds.map((hubId) => {
    const quotes = items.flatMap((item) => {
      const quote = item.quotes.find((entry) => entry.hub.id === hubId)
      return quote ? [quote] : []
    })
    return {
      hub: getMarketHub(hubId),
      immediateBuyTotal: quotes.reduce((total, quote) => total + quote.book.immediateBuy.total, 0),
      immediateSellTotal: quotes.reduce((total, quote) => total + quote.book.immediateSell.total, 0),
      incompleteBuyItems: quotes.filter((quote) => !quote.book.immediateBuy.complete).length,
      incompleteSellItems: quotes.filter((quote) => !quote.book.immediateSell.complete).length
    }
  })
}

function emptyTotals(hubIds: readonly MarketHubId[]): MarketAppraisalHubTotal[] {
  return hubIds.map((hubId) => ({
    hub: getMarketHub(hubId),
    immediateBuyTotal: 0,
    immediateSellTotal: 0,
    incompleteBuyItems: 0,
    incompleteSellItems: 0
  }))
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>
): Promise<R[]> {
  const result = new Array<R>(values.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next
      next += 1
      result[index] = await work(values[index])
    }
  })
  await Promise.all(workers)
  return result
}
