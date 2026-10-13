import { CACHE_SCOPES, CACHE_TTL, type Cache } from './cache'
import type { PilotContactType } from '../shared/pilot-context'
import type { MarketHistoryPoint, MarketOrder } from '../shared/market'
import type { IndustryBlueprint, IndustryJob, IndustrySkill, IndustryPublicContract, IndustryContractItem } from '../shared/industry'
import {
  MAX_ROUTE_SYSTEMS,
  ROUTE_MODES,
  validateRouteSystemIds,
  type RouteMode,
  type RoutePathSnapshot,
  type RouteWaypointResult
} from '../shared/route-intel'
import type {
  EconomyAssetRow,
  EconomyMarketPrice,
  EconomyOrderRow,
  EconomyTransactionRow
} from '../shared/personal-economy'

// Compatibility-date routes intentionally have no legacy /latest prefix.
const DEFAULT_ESI_BASE_URL = 'https://esi.evetech.net'
const DEFAULT_USER_AGENT = 'Fly-Safe/0.11.0 (desktop application)'
const COMPATIBILITY_DATE = '2026-08-20'
const CONDITIONAL_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

const UNIVERSE_TYPE_CACHE = {
  // v2 includes the inventory group required for exact target-role classification.
  scope: 'esi:universe-type:v2',
  // ESI normally supplies the authoritative max-age. This is only a safe fallback.
  ttlMs: 24 * 60 * 60 * 1_000
} as const

const PUBLIC_MARKET_LOOKUP_CACHE = {
  exactType: { scope: 'esi:market-exact-type:v1', ttlMs: 24 * 60 * 60 * 1_000 },
  prices: { scope: 'esi:market-prices:v1', ttlMs: 60 * 60 * 1_000 }
} as const

const PUBLIC_ROUTE_CACHE = {
  scope: 'esi:route:v1',
  ttlMs: 5 * 60 * 1_000
} as const

const ROUTE_PREFERENCES: Record<RouteMode, 'Shorter' | 'Safer' | 'LessSecure'> = {
  shortest: 'Shorter',
  secure: 'Safer',
  insecure: 'LessSecure'
}

const MAX_MARKET_ORDER_PAGES = 100
const MARKET_ORDER_PAGE_CONCURRENCY = 2
const MAX_AUTHENTICATED_PAGES = 500
const AUTHENTICATED_PAGE_CONCURRENCY = 4
const MAX_WALLET_TRANSACTION_PAGES = 20

const AUTHENTICATED_CACHE = {
  contacts: { scope: 'esi:authenticated-character-contacts:v1', ttlMs: 300_000 },
  contactLabels: { scope: 'esi:authenticated-character-contact-labels:v1', ttlMs: 300_000 },
  characterFleet: { scope: 'esi:authenticated-character-fleet:v1', ttlMs: 60_000 },
  fleetMembers: { scope: 'esi:authenticated-fleet-members:v1', ttlMs: 5_000 },
  wallet: { scope: 'esi:authenticated-character-wallet:v1', ttlMs: 120_000 },
  orders: { scope: 'esi:authenticated-character-orders:v1', ttlMs: 300_000 },
  orderHistory: { scope: 'esi:authenticated-character-order-history:v1', ttlMs: 60 * 60 * 1_000 },
  walletTransactions: {
    scope: 'esi:authenticated-character-wallet-transactions:v1',
    ttlMs: 300_000
  },
  assets: { scope: 'esi:authenticated-character-assets:v1', ttlMs: 60 * 60 * 1_000 },
  universeStructure: {
    scope: 'esi:authenticated-universe-structure:v1',
    ttlMs: 60 * 60 * 1_000
  }
} as const

const CHARACTER_LOCATION_CACHE_TTL = {
  location: 5_000,
  online: 60_000,
  ship: 5_000
} as const
const ESI_RATE_LIMIT_FALLBACK_MS = 1_000
const ESI_INLINE_RETRY_MAX_MS = 30_000
const CHARACTER_LOCATION_RATE_LIMIT_MESSAGE =
  'ESI character-location request paused by rate limit'
const GLOBAL_RATE_LIMIT_MESSAGE = 'ESI request paused by rate limit'

type FetchLike = typeof fetch

interface EsiIdsResponse {
  characters?: Array<{ id: number; name: string }>
  inventory_types?: Array<{ id: number; name: string }>
  systems?: Array<{ id: number; name: string }>
}

interface EsiAffiliationResponse {
  character_id: number
  corporation_id: number
  alliance_id?: number
  faction_id?: number
}

interface EsiNameResponse {
  id: number
  name: string
  category: string
}

interface EsiSolarSystemResponse {
  constellation_id: number
  name: string
  security_class?: string
  security_status: number
  stargates?: number[]
  system_id?: number
}

interface EsiStargateResponse {
  destination: {
    stargate_id: number
    system_id: number
  }
  name: string
  stargate_id?: number
  system_id: number
}

interface EsiConstellationResponse {
  name: string
  region_id: number
}

interface EsiRegionResponse {
  name: string
}

interface EsiUniverseTypeResponse {
  type_id: number
  name: string
  group_id: number
  mass?: number
}

interface EsiUniverseStructureResponse {
  name: string
  owner_id: number
  solar_system_id: number
  type_id?: number
}

interface EsiMarketOrderResponse {
  duration: number
  is_buy_order?: boolean
  issued: string
  location_id: number
  min_volume: number
  order_id: number
  price: number
  range: string
  system_id: number
  type_id: number
  volume_remain: number
  volume_total: number
}

interface EsiMarketHistoryResponse {
  average: number
  date: string
  highest: number
  lowest: number
  order_count: number
  volume: number
}

interface EsiMarketPriceResponse {
  adjusted_price?: number
  average_price?: number
  type_id: number
}

interface EsiRouteResponse {
  route: number[]
}

interface EsiCharacterOrderResponse {
  duration: number
  escrow?: number
  is_buy_order?: boolean
  issued: string
  location_id: number
  min_volume?: number
  order_id: number
  price: number
  region_id: number
  state?: string
  type_id: number
  volume_remain: number
  volume_total: number
}

interface EsiCharacterWalletTransactionResponse {
  client_id: number
  date: string
  is_buy: boolean
  is_personal?: boolean
  location_id: number
  quantity: number
  transaction_id: number
  type_id: number
  unit_price: number
}

interface EsiCharacterAssetResponse {
  is_singleton: boolean
  item_id: number
  location_flag: string
  location_id: number
  location_type: string
  quantity: number
  type_id: number
}

interface EsiSystemKillsResponse {
  npc_kills: number
  pod_kills: number
  ship_kills: number
  system_id: number
}

interface EsiSystemJumpsResponse {
  ship_jumps: number
  system_id: number
}

interface EsiCharacterLocationResponse {
  solar_system_id: number
  station_id?: number
  structure_id?: number
}

interface EsiCharacterOnlineResponse {
  last_login?: string
  last_logout?: string
  logins?: number
  online: boolean
}

interface EsiCharacterShipResponse {
  ship_item_id: number
  ship_name: string
  ship_type_id: number
}

interface EsiCharacterContactResponse {
  contact_id: number
  contact_type: string
  standing: number
  label_ids?: number[]
  is_watched?: boolean
  is_blocked?: boolean
}

interface EsiCharacterContactLabelResponse {
  label_id: number
  label_name: string
}

interface EsiCharacterFleetResponse {
  fleet_id: number
  fleet_boss_id: number
  role: string
  wing_id: number
  squad_id: number
}

interface EsiFleetMemberResponse {
  character_id: number
  join_time: string
  role: string
  role_name: string
  ship_type_id: number
  solar_system_id: number
  squad_id: number
  station_id?: number
  takes_fleet_warp: boolean
  wing_id: number
}

interface ConditionalCacheEnvelope<T> {
  value: T
  etag: string | null
  freshUntil: number
}

interface CharacterLocationCacheEntry {
  value: object
  freshUntil: number
}

interface EsiJsonResponse<T> {
  status: number
  data: T | null
  etag: string | null
  lastModified: string | null
  cacheTtlMs: number | null
  pages: number
  expiresAt: string | null
}

type ConditionalLoad<T> =
  | { notModified: true; ttlMs: number | null }
  | { notModified: false; value: T; etag: string | null; ttlMs: number | null }

interface CachedCharacterIdentity {
  id: number
  name: string
}

export interface SolarSystemIdentity {
  id: number
  name: string
  cached: boolean
}

interface CachedAffiliation {
  characterId: number
  corporationId: number
  allianceId: number | null
  factionId: number | null
}

interface CachedUniverseName {
  id: number
  name: string
  category: string
}

interface CachedSolarSystem {
  id: number
  name: string
  constellationId: number
  securityStatus: number
  securityClass: string | null
  stargateIds: number[]
}

interface CachedStargate {
  id: number
  name: string
  systemId: number
  destinationStargateId: number
  destinationSystemId: number
}

interface CachedConstellation {
  id: number
  name: string
  regionId: number
}

interface CachedRegion {
  id: number
  name: string
}

interface CachedUniverseType {
  id: number
  name: string
  groupId: number
  /** Published base hull mass. ESI omits mass for some non-ship inventory types. */
  massKg: number | null
}

interface CachedAuthenticatedUniverseStructure {
  structureId: number
  name: string
  solarSystemId: number
  typeId: number | null
  ownerId: number
}

export interface CharacterIdentity extends CachedCharacterIdentity {
  inputName: string
  cached: boolean
}

export interface CharacterResolution {
  inputName: string
  character: CharacterIdentity | null
  cached: boolean
}

export interface InventoryTypeIdentity {
  id: number
  name: string
}

export interface InventoryTypeResolution {
  inputName: string
  type: InventoryTypeIdentity | null
  cached: boolean
}

export interface EsiMarketTypesResult {
  ids: number[]
  pages: number
}

export interface EsiMarketOrdersResult {
  orders: MarketOrder[]
  pages: number
  snapshotAt?: string
  expiresAt?: string
}

export interface EsiMarketHistoryResult {
  points: MarketHistoryPoint[]
  lastModified?: string
  expiresAt?: string
}

export interface CharacterAffiliation extends CachedAffiliation {
  cached: boolean
}

export interface UniverseName extends CachedUniverseName {
  cached: boolean
}

export interface PublicKillmail {
  killmail: unknown
  cached: boolean
}

export interface EsiSolarSystem extends CachedSolarSystem {
  cached: boolean
}

export interface EsiStargate extends CachedStargate {
  cached: boolean
}

export interface EsiConstellation extends CachedConstellation {
  cached: boolean
}

export interface EsiRegion extends CachedRegion {
  cached: boolean
}

export interface EsiUniverseType extends CachedUniverseType {
  cached: boolean
}

export interface AuthenticatedUniverseStructure
  extends CachedAuthenticatedUniverseStructure {
  cached: boolean
}

export interface EsiSystemKills {
  solarSystemId: number
  npcKills: number
  podKills: number
  shipKills: number
}

export interface EsiSystemJumps {
  solarSystemId: number
  jumps: number
}

export interface EsiSystemKillsResult {
  rows: EsiSystemKills[]
  cached: boolean
}

export interface EsiSystemJumpsResult {
  rows: EsiSystemJumps[]
  cached: boolean
}

export interface AuthenticatedCharacterLocation {
  solarSystemId: number
  stationId: number | null
  structureId: number | null
}

export interface AuthenticatedCharacterOnline {
  online: boolean
  lastLogin: string | null
  lastLogout: string | null
  logins: number | null
}

export interface AuthenticatedCharacterShip {
  shipItemId: number
  shipName: string
  shipTypeId: number
}

export interface AuthenticatedCharacterContact {
  contactId: number
  contactType: PilotContactType
  standing: number
  labelIds: number[]
  watched: boolean
  blocked: boolean
}

export interface AuthenticatedCharacterContactLabel {
  labelId: number
  name: string
}

export interface AuthenticatedCharacterContactsResult {
  contacts: AuthenticatedCharacterContact[]
  cached: boolean
}

export interface AuthenticatedCharacterContactLabelsResult {
  labels: AuthenticatedCharacterContactLabel[]
  cached: boolean
}

export interface AuthenticatedCharacterFleet {
  fleetId: number
  fleetBossId: number
  role: string
  wingId: number | null
  squadId: number | null
  cached: boolean
}

export interface AuthenticatedFleetMember {
  characterId: number
  joinedAt: string
  role: string
  roleName: string
  shipTypeId: number
  solarSystemId: number
  squadId: number | null
  stationId: number | null
  takesFleetWarp: boolean
  wingId: number | null
}

export interface AuthenticatedFleetMembersResult {
  members: AuthenticatedFleetMember[]
  cached: boolean
}

export const ESI_AUTH_SCOPES = {
  location: 'esi-location.read_location.v1',
  online: 'esi-location.read_online.v1',
  ship: 'esi-location.read_ship_type.v1'
} as const

/** Additional read-only scopes required by PilotContextService. */
export const ESI_PILOT_CONTEXT_SCOPES = {
  contacts: 'esi-characters.read_contacts.v1',
  fleet: 'esi-fleets.read_fleet.v1'
} as const

export const ESI_UI_SCOPES = {
  waypoint: 'esi-ui.write_waypoint.v1'
} as const

export interface EsiClientOptions {
  baseUrl?: string
  userAgent?: string
  fetch?: FetchLike
  timeoutMs?: number
  maxAttempts?: number
  now?: () => number
}

export class EsiError extends Error {
  readonly status: number | null
  readonly retryAfterMs: number | null

  constructor(message: string, status: number | null = null, options?: ErrorOptions, retryAfterMs: number | null = null) {
    super(message, options)
    this.name = 'EsiError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** Internal marker that prevents the generic request loop from retrying a handled 429. */
class ImmediateEsiError extends EsiError {}

/** Public ESI data plus explicit token-per-call character routes; tokens are never retained. */
export class EsiClient {
  private readonly cache: Cache
  private readonly baseUrl: string
  private readonly userAgent: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly now: () => number
  private readonly characterLocationCache = new Map<string, CharacterLocationCacheEntry>()
  private readonly characterLocationInFlight = new Map<string, Promise<object>>()
  private globalBlockedUntil = 0
  private globalBlockedStatus = 429

  constructor(cache: Cache, options: EsiClientOptions = {}) {
    this.cache = cache
    this.baseUrl = (options.baseUrl ?? DEFAULT_ESI_BASE_URL).replace(/\/$/, '')
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
    this.now = options.now ?? Date.now
  }

  async resolveCharacterIds(
    names: readonly string[],
    forceRefresh = false
  ): Promise<CharacterResolution[]> {
    const uniqueNames = deduplicateNames(names)
    const results = new Map<string, CharacterResolution>()
    const missing: string[] = []

    for (const name of uniqueNames) {
      const key = normalizeName(name)
      const hit = forceRefresh
        ? null
        : this.cache.get<CachedCharacterIdentity | null>(CACHE_SCOPES.characterIds, key)

      if (hit) {
        const character = hit.value
          ? { ...hit.value, inputName: name, cached: true }
          : null
        results.set(key, { inputName: name, character, cached: true })
      } else {
        missing.push(name)
      }
    }

    for (const batch of chunks(missing, 500)) {
      const response = await this.requestJson<EsiIdsResponse>('/universe/ids/', {
        method: 'POST',
        body: JSON.stringify(batch)
      })
      const returned = new Map(
        (response.characters ?? []).map((character) => [normalizeName(character.name), character])
      )

      for (const inputName of batch) {
        const key = normalizeName(inputName)
        const match = returned.get(key)
        const cachedValue: CachedCharacterIdentity | null = match
          ? { id: match.id, name: match.name }
          : null

        this.cache.set(
          CACHE_SCOPES.characterIds,
          key,
          cachedValue,
          CACHE_TTL.characterIds
        )
        results.set(key, {
          inputName,
          character: cachedValue
            ? { ...cachedValue, inputName, cached: false }
            : null,
          cached: false
        })
      }
    }

    return uniqueNames.map((name) =>
      results.get(normalizeName(name)) ?? { inputName: name, character: null, cached: false }
    )
  }

  /** Resolves one exact solar-system name without requiring SSO. */
  async resolveSolarSystemId(
    name: string,
    forceRefresh = false
  ): Promise<SolarSystemIdentity | null> {
    const normalizedInput = name.trim()
    if (!normalizedInput || normalizedInput.length > 128) {
      throw new TypeError('Invalid solar system name')
    }
    const key = normalizeName(normalizedInput)
    const hit = forceRefresh
      ? null
      : this.cache.get<{ id: number; name: string } | null>(CACHE_SCOPES.solarSystemIds, key)
    if (hit) return hit.value ? { ...hit.value, cached: true } : null

    const response = await this.requestJson<EsiIdsResponse>('/universe/ids/', {
      method: 'POST',
      body: JSON.stringify([normalizedInput])
    })
    const match = (response.systems ?? []).find(
      (system) => normalizeName(system.name) === key && Number.isSafeInteger(system.id) && system.id > 0
    )
    const value = match ? { id: match.id, name: match.name } : null
    this.cache.set(CACHE_SCOPES.solarSystemIds, key, value, CACHE_TTL.solarSystemIds)
    return value ? { ...value, cached: false } : null
  }

  /** Resolves exact public inventory type names in batches. No SSO is required. */
  async resolveInventoryTypes(
    names: readonly string[],
    forceRefresh = false
  ): Promise<InventoryTypeResolution[]> {
    const uniqueNames = deduplicateNames(names)
    if (uniqueNames.length > 500) throw new RangeError('Too many inventory type names')
    for (const name of uniqueNames) assertMarketSearchText(name, 'inventory type name')

    const results = new Map<string, InventoryTypeResolution>()
    const missing: string[] = []
    for (const name of uniqueNames) {
      const key = normalizeName(name)
      const hit = forceRefresh
        ? null
        : this.cache.get<InventoryTypeIdentity | null>(
            PUBLIC_MARKET_LOOKUP_CACHE.exactType.scope,
            key
          )
      if (hit) {
        results.set(key, { inputName: name, type: hit.value, cached: true })
      } else {
        missing.push(name)
      }
    }

    for (const batch of chunks(missing, 500)) {
      const response = await this.requestJson<EsiIdsResponse>('/universe/ids/', {
        method: 'POST',
        body: JSON.stringify(batch)
      })
      const returned = new Map(
        (response.inventory_types ?? [])
          .filter((item) => positiveIdOrNull(item?.id) !== null && optionalString(item?.name))
          .map((item) => [normalizeName(item.name), { id: item.id, name: item.name }])
      )

      for (const inputName of batch) {
        const key = normalizeName(inputName)
        // Keep a local equality check as defense against malformed or future-compatible responses.
        const value = returned.get(key) ?? null
        this.cache.set(
          PUBLIC_MARKET_LOOKUP_CACHE.exactType.scope,
          key,
          value,
          PUBLIC_MARKET_LOOKUP_CACHE.exactType.ttlMs
        )
        results.set(key, { inputName, type: value, cached: false })
      }
    }

    return uniqueNames.map((name) =>
      results.get(normalizeName(name)) ?? { inputName: name, type: null, cached: false }
    )
  }

  /** Lists public inventory type IDs that currently have orders in a region. */
  async getMarketTypeIds(regionId: number): Promise<EsiMarketTypesResult> {
    assertPositiveId(regionId, 'market region')
    const first = await this.requestJsonResponse<number[]>(
      `/markets/${encodeURIComponent(regionId)}/types/?page=1`,
      { method: 'GET' }
    )
    if (!Array.isArray(first.data)) throw new EsiError('ESI market types returned an unexpected response')
    if (first.pages > MAX_MARKET_ORDER_PAGES) {
      throw new EsiError('ESI market types returned too many pages')
    }
    const pageResponses = await mapConcurrentEsi(
      Array.from({ length: first.pages - 1 }, (_, index) => index + 2),
      MARKET_ORDER_PAGE_CONCURRENCY,
      (page) => this.requestJson<number[]>(
        `/markets/${encodeURIComponent(regionId)}/types/?page=${page}`,
        { method: 'GET' }
      )
    )
    const ids = deduplicateIds([first.data, ...pageResponses].flat())
    return { ids, pages: first.pages }
  }

  /** Loads every public regional order for one inventory type. Caching belongs to MarketService. */
  async getMarketOrders(regionId: number, typeId?: number, onProgress?: (completed: number, total: number) => void): Promise<EsiMarketOrdersResult> {
    assertPositiveId(regionId, 'market region')
    if (typeId !== undefined) assertPositiveId(typeId, 'market type')
    const params = new URLSearchParams({ order_type: 'all', page: '1' })
    if (typeId !== undefined) params.set('type_id', String(typeId))
    const first = await this.requestJsonResponse<EsiMarketOrderResponse[]>(
      `/markets/${encodeURIComponent(regionId)}/orders/?${params.toString()}`,
      { method: 'GET' }
    )
    if (!Array.isArray(first.data)) throw new EsiError('ESI market orders returned an unexpected response')
    if (first.pages > (typeId === undefined ? 500 : MAX_MARKET_ORDER_PAGES)) {
      throw new EsiError('ESI market orders returned too many pages')
    }
    let completed = 1
    onProgress?.(completed, first.pages)

    const pageResponses = await mapConcurrentEsi(
      Array.from({ length: first.pages - 1 }, (_, index) => index + 2),
      MARKET_ORDER_PAGE_CONCURRENCY,
      async (page) => {
        const pageParams = new URLSearchParams({
          order_type: 'all',
          page: String(page)
        })
        if (typeId !== undefined) pageParams.set('type_id', String(typeId))
        const response = await this.requestJsonResponse<EsiMarketOrderResponse[]>(
          `/markets/${encodeURIComponent(regionId)}/orders/?${pageParams.toString()}`,
          { method: 'GET' }
        )
        if (!Array.isArray(response.data)) throw new EsiError('ESI market orders returned an unexpected page')
        onProgress?.(++completed, first.pages)
        return response
      }
    )
    const responses = [first, ...pageResponses]
    const rawOrders = responses.flatMap(r => r.data!)
    const uniqueOrders = new Map<number, MarketOrder>()
    // Page boundaries may move while a large regional book is being read.
    // Counting the same order twice would fabricate executable volume.
    for (const raw of rawOrders) {
      const order = parseMarketOrder(raw, typeId ?? raw.type_id)
      uniqueOrders.set(order.orderId, order)
    }
    return {
      orders: [...uniqueOrders.values()],
      pages: first.pages,
      snapshotAt: oldestHeaderDate(responses.map(r => r.lastModified)),
      expiresAt: oldestHeaderDate(responses.map(r => r.expiresAt))
    }
  }

  async getPublicContracts(regionId: number, forceRefresh = false): Promise<IndustryPublicContract[]> {
    assertPositiveId(regionId, 'contract region')
    const result = await this.getConditionalCached<IndustryPublicContract[]>('esi:public-contracts:v1', String(regionId), 1_800_000, forceRefresh, async etag => {
      const first = await this.requestJsonResponse<Array<Record<string, unknown>>>(`/contracts/public/${regionId}/?page=1`, { method: 'GET', headers: etag ? { 'If-None-Match': etag } : undefined }, true)
      if (first.status === 304) return { notModified: true, ttlMs: first.cacheTtlMs }
      if (!Array.isArray(first.data) || first.pages > 500) throw new EsiError('ESI contracts returned invalid pages')
      const rest = await mapConcurrentEsi(Array.from({ length: first.pages - 1 }, (_, i) => i + 2), 2, async page => {
        const data = await this.requestJson<Array<Record<string, unknown>>>(`/contracts/public/${regionId}/?page=${page}`, { method: 'GET' })
        if (!Array.isArray(data)) throw new EsiError('ESI contracts returned an invalid page')
        return data
      })
      const contracts = new Map<number, IndustryPublicContract>()
      for (const c of [first.data, ...rest].flat()) {
        const contractId = requiredPositiveId(c.contract_id as number, 'contract')
        contracts.set(contractId, { contractId, type: requiredString(c.type as string, 'contract type'),
          price: c.price === undefined ? null : requiredNonNegativeFiniteNumber(c.price as number, 'contract price'),
          locationId: c.start_location_id === undefined ? null : requiredPositiveId(c.start_location_id as number, 'contract location'),
          expires: requiredIsoTimestamp(c.date_expired as string, 'contract expiry'), title: typeof c.title === 'string' ? c.title : '' })
      }
      return { notModified: false, value: [...contracts.values()], etag: first.etag, ttlMs: first.cacheTtlMs }
    })
    return result.value
  }

  async getPublicContractItems(contractId: number): Promise<IndustryContractItem[]> {
    assertPositiveId(contractId, 'contract')
    const result = await this.getConditionalCached<IndustryContractItem[]>('esi:public-contract-items:v1', String(contractId), 3_600_000, false, async etag => {
      const first = await this.requestJsonResponse<Array<Record<string, unknown>>>(`/contracts/public/items/${contractId}/?page=1`, { method: 'GET', headers: etag ? { 'If-None-Match': etag } : undefined }, true)
      if (first.status === 304) return { notModified: true, ttlMs: first.cacheTtlMs }
      if (first.status === 204) return { notModified: false, value: [], etag: null, ttlMs: 300_000 }
      if (!Array.isArray(first.data) || first.pages > 100) throw new EsiError('ESI contract items returned invalid pages')
      const rest = await mapConcurrentEsi(Array.from({ length: first.pages - 1 }, (_, i) => i + 2), 2, async page => {
        const data = await this.requestJson<Array<Record<string, unknown>>>(`/contracts/public/items/${contractId}/?page=${page}`, { method: 'GET' })
        if (!Array.isArray(data)) throw new EsiError('ESI contract items returned an invalid page')
        return data
      })
      const items = new Map<number, IndustryContractItem>()
      for (const c of [first.data, ...rest].flat()) {
        if (typeof c.is_included !== 'boolean' || c.is_blueprint_copy !== undefined && typeof c.is_blueprint_copy !== 'boolean') throw new EsiError('ESI contract item returned invalid flags')
        const recordId = requiredPositiveId(c.record_id as number, 'contract item')
        items.set(recordId, { recordId, typeId: requiredPositiveId(c.type_id as number, 'contract item type'), quantity: requiredPositiveSafeInteger(c.quantity as number, 'contract quantity'),
          included: c.is_included, copy: typeof c.is_blueprint_copy === 'boolean' ? c.is_blueprint_copy : null,
          // Contract inventories include non-blueprints and legacy/sentinel metadata.
          // An unknown efficiency invalidates only this blueprint quote, not the region.
          me: Number.isSafeInteger(c.material_efficiency) && Number(c.material_efficiency) >= 0 && Number(c.material_efficiency) <= 10 ? c.material_efficiency as number : null,
          te: Number.isSafeInteger(c.time_efficiency) && Number(c.time_efficiency) >= 0 && Number(c.time_efficiency) <= 20 ? c.time_efficiency as number : null,
          runs: Number.isSafeInteger(c.runs) && Number(c.runs) >= -1 ? c.runs as number : null })
      }
      return { notModified: false, value: [...items.values()], etag: first.etag, ttlMs: first.cacheTtlMs }
    })
    return result.value
  }

  /** Read-only manufacturing endpoints. Cache keys always include the character ID. */
  async getAuthenticatedCharacterSkills(characterId: number, accessToken: string, forceRefresh = false): Promise<IndustrySkill[]> {
    return this.getIndustryCharacterData(characterId, accessToken, 'skills', forceRefresh, false, raw => {
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { skills?: unknown }).skills)) throw new EsiError('ESI skills returned an unexpected response')
      return ((raw as { skills: Array<Record<string, unknown>> }).skills).map(s => ({
        typeId: requiredPositiveId(s.skill_id as number, 'skill'),
        activeLevel: industryLevel(s.active_skill_level, 'active skill', 5),
        trainedLevel: industryLevel(s.trained_skill_level, 'trained skill', 5)
      }))
    })
  }

  async getAuthenticatedCharacterBlueprints(characterId: number, accessToken: string, forceRefresh = false): Promise<IndustryBlueprint[]> {
    return this.getIndustryCharacterData(characterId, accessToken, 'blueprints', forceRefresh, true, raw => {
      if (!Array.isArray(raw)) throw new EsiError('ESI blueprints returned an unexpected response')
      return raw.map((b: Record<string, unknown>) => {
        if (!Number.isSafeInteger(b.quantity) || !Number.isSafeInteger(b.runs) || Number(b.runs) < -1 || Number(b.quantity) < -2 || Number(b.quantity) === 0) throw new EsiError('ESI returned an invalid blueprint')
        return {
          itemId: requiredPositiveId(b.item_id as number, 'blueprint item'),
          typeId: requiredPositiveId(b.type_id as number, 'blueprint type'),
          locationId: requiredPositiveId(b.location_id as number, 'blueprint location'),
          locationFlag: requiredString(b.location_flag as string, 'blueprint location flag'),
          materialEfficiency: industryLevel(b.material_efficiency, 'blueprint ME', 10),
          timeEfficiency: industryLevel(b.time_efficiency, 'blueprint TE', 20),
          runs: b.runs as number, quantity: b.quantity as number
        }
      })
    })
  }

  async getAuthenticatedCharacterIndustryJobs(characterId: number, accessToken: string, forceRefresh = false): Promise<IndustryJob[]> {
    return this.getIndustryCharacterData(characterId, accessToken, 'industry/jobs', forceRefresh, false, raw => {
      if (!Array.isArray(raw)) throw new EsiError('ESI industry jobs returned an unexpected response')
      return raw.map((j: Record<string, unknown>) => ({
        jobId: requiredPositiveId(j.job_id as number, 'industry job'),
        activityId: requiredPositiveId(j.activity_id as number, 'industry activity'),
        blueprintTypeId: requiredPositiveId(j.blueprint_type_id as number, 'job blueprint'),
        blueprintItemId: requiredPositiveId(j.blueprint_id as number, 'job blueprint item'),
        productTypeId: j.product_type_id === undefined ? null : requiredPositiveId(j.product_type_id as number, 'job product'),
        runs: requiredPositiveSafeInteger(j.runs as number, 'job runs'),
        status: requiredString(j.status as string, 'job status'),
        startDate: requiredIsoTimestamp(j.start_date as string, 'job start'),
        endDate: requiredIsoTimestamp(j.end_date as string, 'job end'),
        facilityId: requiredPositiveId(j.facility_id as number, 'job facility'),
        stationId: requiredPositiveId(j.station_id as number, 'job station'),
        cost: j.cost === undefined ? null : requiredNonNegativeFiniteNumber(j.cost as number, 'job cost')
      }))
    })
  }

  async getIndustryFacilities(forceRefresh = false): Promise<Array<{ facilityId: number; systemId: number }>> {
    const result = await this.getConditionalCached<Array<{ facilityId: number; systemId: number }>>('esi:industry-facilities:v1', 'all', 3_600_000, forceRefresh, async etag => {
      const response = await this.requestJsonResponse<Array<{ facility_id: number; solar_system_id: number }>>('/industry/facilities/', { method: 'GET', headers: etag ? { 'If-None-Match': etag } : undefined }, true)
      if (response.status === 304) return { notModified: true, ttlMs: response.cacheTtlMs }
      if (!Array.isArray(response.data)) throw new EsiError('ESI facilities returned an unexpected response')
      const value = response.data.map(f => ({ facilityId: requiredPositiveId(f.facility_id, 'facility'), systemId: requiredPositiveId(f.solar_system_id, 'facility system') }))
      return { notModified: false, value, etag: response.etag, ttlMs: response.cacheTtlMs }
    })
    return result.value
  }

  async getIndustrySystems(forceRefresh = false): Promise<Array<{ systemId: number; manufacturingIndex: number }>> {
    const result = await this.getConditionalCached<Array<{ systemId: number; manufacturingIndex: number }>>('esi:industry-systems:v1', 'all', 3_600_000, forceRefresh, async etag => {
      const response = await this.requestJsonResponse<Array<{ solar_system_id: number; cost_indices: Array<{ activity: string; cost_index: number }> }>>('/industry/systems/', { method: 'GET', headers: etag ? { 'If-None-Match': etag } : undefined }, true)
      if (response.status === 304) return { notModified: true, ttlMs: response.cacheTtlMs }
      if (!Array.isArray(response.data)) throw new EsiError('ESI industry systems returned an unexpected response')
      const value = response.data.flatMap(s => {
        const index = s.cost_indices.find(i => i.activity === 'manufacturing')
        if (!index) return []
        return [{ systemId: requiredPositiveId(s.solar_system_id, 'industry system'), manufacturingIndex: requiredNonNegativeFiniteNumber(index.cost_index, 'manufacturing index') }]
      })
      return { notModified: false, value, etag: response.etag, ttlMs: response.cacheTtlMs }
    })
    return result.value
  }

  private async getIndustryCharacterData<T>(characterId: number, accessToken: string, route: string, forceRefresh: boolean, paginated: boolean, parse: (raw: unknown) => T): Promise<T> {
    assertPositiveId(characterId, 'character')
    const result = await this.getConditionalCached<T>(`esi:character-industry:${route}:${route === 'industry/jobs' ? 'completed-v2' : 'v1'}`, String(characterId), route === 'industry/jobs' ? 300_000 : 3_600_000, forceRefresh, async etag => {
      const path = `/characters/${encodeURIComponent(characterId)}/${route}/${route === 'industry/jobs' ? '?include_completed=true' : ''}`
      const response = paginated
        ? await this.requestAuthenticatedPages((page) => `${path}?page=${page}`, accessToken, etag)
        : await this.requestJsonResponse<unknown>(path, authenticatedGet(accessToken, etag ? { 'If-None-Match': etag } : undefined), true)
      if (response.status === 304) return { notModified: true, ttlMs: response.cacheTtlMs }
      return { notModified: false, value: parse(response.data), etag: response.etag, ttlMs: response.cacheTtlMs }
    })
    return result.value
  }

  /** Loads public daily regional market history for one inventory type. */
  async getMarketHistory(regionId: number, typeId: number): Promise<EsiMarketHistoryResult> {
    assertPositiveId(regionId, 'market region')
    assertPositiveId(typeId, 'market type')
    const params = new URLSearchParams({ type_id: String(typeId) })
    const response = await this.requestJsonResponse<EsiMarketHistoryResponse[]>(
      `/markets/${encodeURIComponent(regionId)}/history/?${params.toString()}`,
      { method: 'GET' }
    )
    const raw = response.data
    if (!Array.isArray(raw)) throw new EsiError('ESI market history returned an unexpected response')
    const points = raw.map(parseMarketHistoryPoint).sort((left, right) =>
      left.date.localeCompare(right.date)
    )
    return { points, lastModified: oldestHeaderDate([response.lastModified]), expiresAt: oldestHeaderDate([response.expiresAt]) }
  }

  /** Global public adjusted and average prices. No SSO token is sent. */
  async getMarketPrices(forceRefresh = false): Promise<EconomyMarketPrice[]> {
    const cacheConfig = PUBLIC_MARKET_LOOKUP_CACHE.prices
    const result = await this.getConditionalCached<EconomyMarketPrice[]>(
      cacheConfig.scope,
      'global',
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestJsonResponse<EsiMarketPriceResponse[]>(
          '/markets/prices/',
          {
            method: 'GET',
            ...(etag ? { headers: { 'If-None-Match': etag } } : {})
          },
          true
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        if (!Array.isArray(response.data)) {
          throw new EsiError('ESI market prices returned an unexpected response')
        }
        return {
          notModified: false,
          value: response.data.map(parseEconomyMarketPrice),
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return result.value
  }

  /** Public ESI route planner. The result is historical/planning data, not live intel. */
  async getRouteSystems(
    originId: number,
    destinationId: number,
    mode: RouteMode,
    forceRefresh = false
  ): Promise<RoutePathSnapshot> {
    assertPositiveId(originId, 'route origin system')
    assertPositiveId(destinationId, 'route destination system')
    if (originId === destinationId) throw new TypeError('Route endpoints must be different')
    if (!ROUTE_MODES.includes(mode)) throw new TypeError('Invalid route mode')

    const key = `${originId}:${destinationId}:${mode}`
    const result = await this.getConditionalCached<Omit<RoutePathSnapshot, 'cached'>>(
      PUBLIC_ROUTE_CACHE.scope,
      key,
      PUBLIC_ROUTE_CACHE.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestJsonResponse<EsiRouteResponse>(
          `/route/${encodeURIComponent(originId)}/${encodeURIComponent(destinationId)}`,
          {
            method: 'POST',
            body: JSON.stringify({
              preference: ROUTE_PREFERENCES[mode],
              security_penalty: 50
            }),
            ...(etag ? { headers: { 'If-None-Match': etag } } : {})
          },
          true
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        if (!response.data || !Array.isArray(response.data.route) ||
            response.data.route.length === 0 || response.data.route.length > MAX_ROUTE_SYSTEMS) {
          throw new EsiError('ESI route planner returned an unexpected response')
        }
        const systemIds = validateRouteSystemIds(response.data.route, originId, destinationId)
        return {
          notModified: false,
          value: {
            systemIds,
            fetchedAt: new Date(this.now()).toISOString()
          },
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return { ...result.value, cached: result.cached }
  }

  /** Requires esi-ui.write_waypoint.v1. Access token is never retained. */
  async setAuthenticatedAutopilotWaypoint(
    destinationId: number,
    accessToken: string,
    options: { addToBeginning?: boolean; clearOtherWaypoints?: boolean } = {}
  ): Promise<void> {
    assertPositiveId(destinationId, 'autopilot destination')
    const params = new URLSearchParams({
      add_to_beginning: options.addToBeginning === true ? 'true' : 'false',
      clear_other_waypoints: options.clearOtherWaypoints === true ? 'true' : 'false',
      destination_id: String(destinationId)
    })
    const response = await this.requestJsonResponse<never>(
      `/ui/autopilot/waypoint/?${params.toString()}`,
      { ...authenticatedGet(accessToken), method: 'POST' },
      false,
      undefined,
      'no-retry'
    )
    if (response.status !== 204) {
      throw new EsiError(`ESI waypoint returned unexpected status ${response.status}`, response.status)
    }
  }

  /**
   * Installs an exact corridor while keeping the final destination recoverable:
   * the destination is written first, then intermediate points are prepended.
   */
  async setAuthenticatedAutopilotRoute(
    destinationIds: readonly number[],
    accessToken: string
  ): Promise<RouteWaypointResult> {
    if (!Array.isArray(destinationIds) || destinationIds.length === 0) {
      throw new TypeError('Autopilot route must contain at least one destination')
    }
    if (destinationIds.length > 256) {
      throw new RangeError('Autopilot route cannot contain more than 256 waypoints')
    }
    const normalized: number[] = []
    for (const destinationId of destinationIds) {
      assertPositiveId(destinationId, 'autopilot destination')
      if (normalized.at(-1) !== destinationId) normalized.push(destinationId)
    }

    const finalDestination = normalized.at(-1) as number
    await this.setAuthenticatedAutopilotWaypoint(finalDestination, accessToken, {
      clearOtherWaypoints: true,
      addToBeginning: false
    })
    for (const destinationId of normalized.slice(0, -1).reverse()) {
      await this.setAuthenticatedAutopilotWaypoint(destinationId, accessToken, {
        clearOtherWaypoints: false,
        addToBeginning: true
      })
    }
    return { destinationIds: normalized, waypointsSet: normalized.length }
  }

  async getAffiliations(
    characterIds: readonly number[],
    forceRefresh = false
  ): Promise<CharacterAffiliation[]> {
    const uniqueIds = deduplicateIds(characterIds)
    const results = new Map<number, CharacterAffiliation>()
    const missing: number[] = []

    for (const characterId of uniqueIds) {
      const hit = forceRefresh
        ? null
        : this.cache.get<CachedAffiliation>(
            CACHE_SCOPES.affiliations,
            String(characterId)
          )
      if (hit) {
        results.set(characterId, { ...hit.value, cached: true })
      } else {
        missing.push(characterId)
      }
    }

    for (const batch of chunks(missing, 1_000)) {
      const response = await this.requestJson<EsiAffiliationResponse[]>(
        '/characters/affiliation/',
        { method: 'POST', body: JSON.stringify(batch) }
      )

      for (const item of response) {
        const value: CachedAffiliation = {
          characterId: item.character_id,
          corporationId: item.corporation_id,
          allianceId: item.alliance_id ?? null,
          factionId: item.faction_id ?? null
        }
        this.cache.set(
          CACHE_SCOPES.affiliations,
          String(item.character_id),
          value,
          CACHE_TTL.affiliations
        )
        results.set(item.character_id, { ...value, cached: false })
      }
    }

    return uniqueIds.flatMap((id) => {
      const result = results.get(id)
      return result ? [result] : []
    })
  }

  async getUniverseNames(
    ids: readonly number[],
    forceRefresh = false
  ): Promise<UniverseName[]> {
    const uniqueIds = deduplicateIds(ids)
    const results = new Map<number, UniverseName>()
    const missing: number[] = []

    for (const id of uniqueIds) {
      const hit = forceRefresh
        ? null
        : this.cache.get<CachedUniverseName>(CACHE_SCOPES.universeNames, String(id))
      if (hit) {
        results.set(id, { ...hit.value, cached: true })
      } else {
        missing.push(id)
      }
    }

    for (const batch of chunks(missing, 1_000)) {
      const response = await this.requestJson<EsiNameResponse[]>('/universe/names/', {
        method: 'POST',
        body: JSON.stringify(batch)
      })

      for (const item of response) {
        const value: CachedUniverseName = {
          id: item.id,
          name: item.name,
          category: item.category
        }
        this.cache.set(
          CACHE_SCOPES.universeNames,
          String(item.id),
          value,
          CACHE_TTL.universeNames
        )
        results.set(item.id, { ...value, cached: false })
      }
    }

    return uniqueIds.flatMap((id) => {
      const result = results.get(id)
      return result ? [result] : []
    })
  }

  async getPublicKillmail(
    killmailId: number,
    hash: string,
    forceRefresh = false
  ): Promise<PublicKillmail> {
    if (!Number.isSafeInteger(killmailId) || killmailId <= 0) {
      throw new TypeError('Invalid killmail ID')
    }
    if (!/^[a-f0-9]{40}$/i.test(hash)) {
      throw new TypeError('Invalid killmail hash')
    }

    const key = `${killmailId}:${hash.toLowerCase()}`
    const hit = forceRefresh
      ? null
      : this.cache.get<unknown>(CACHE_SCOPES.esiKillmail, key)
    if (hit) return { killmail: hit.value, cached: true }

    const killmail = await this.requestJson<unknown>(
      `/killmails/${encodeURIComponent(killmailId)}/${encodeURIComponent(hash)}/`,
      { method: 'GET' }
    )
    this.cache.set(
      CACHE_SCOPES.esiKillmail,
      key,
      killmail,
      CACHE_TTL.esiKillmail
    )
    return { killmail, cached: false }
  }

  async getSolarSystem(
    solarSystemId: number,
    forceRefresh = false
  ): Promise<EsiSolarSystem> {
    assertPositiveId(solarSystemId, 'solar system')
    const key = String(solarSystemId)
    const hit = forceRefresh
      ? null
      : this.cache.get<CachedSolarSystem>(CACHE_SCOPES.universeSystem, key)
    if (hit) return { ...hit.value, cached: true }

    const raw = await this.requestJson<EsiSolarSystemResponse>(
      `/universe/systems/${encodeURIComponent(solarSystemId)}/`,
      { method: 'GET' }
    )
    if (raw.system_id !== undefined &&
        requiredPositiveId(raw.system_id, 'solar system') !== solarSystemId) {
      throw new EsiError('ESI solar system response did not match the requested system')
    }
    const value: CachedSolarSystem = {
      id: solarSystemId,
      name: requiredString(raw.name, 'system name'),
      constellationId: requiredPositiveId(raw.constellation_id, 'constellation'),
      securityStatus: requiredFiniteNumber(raw.security_status, 'security status'),
      securityClass: optionalString(raw.security_class),
      stargateIds: requiredPositiveIdArray(raw.stargates, 'solar system stargates', 128)
    }
    this.cache.set(
      CACHE_SCOPES.universeSystem,
      key,
      value,
      CACHE_TTL.universeSystem
    )
    return { ...value, cached: false }
  }

  async getStargate(stargateId: number, forceRefresh = false): Promise<EsiStargate> {
    assertPositiveId(stargateId, 'stargate')
    const key = String(stargateId)
    const hit = forceRefresh
      ? null
      : this.cache.get<CachedStargate>(CACHE_SCOPES.universeStargate, key)
    if (hit) return { ...hit.value, cached: true }

    const raw = await this.requestJson<EsiStargateResponse>(
      `/universe/stargates/${encodeURIComponent(stargateId)}/`,
      { method: 'GET' }
    )
    if (!raw.destination || typeof raw.destination !== 'object') {
      throw new EsiError('ESI returned an invalid stargate destination')
    }
    if (raw.stargate_id !== undefined &&
        requiredPositiveId(raw.stargate_id, 'stargate') !== stargateId) {
      throw new EsiError('ESI stargate response did not match the requested stargate')
    }
    const value: CachedStargate = {
      id: stargateId,
      name: requiredString(raw.name, 'stargate name'),
      systemId: requiredPositiveId(raw.system_id, 'stargate system'),
      destinationStargateId: requiredPositiveId(
        raw.destination.stargate_id,
        'destination stargate'
      ),
      destinationSystemId: requiredPositiveId(
        raw.destination.system_id,
        'destination system'
      )
    }
    this.cache.set(
      CACHE_SCOPES.universeStargate,
      key,
      value,
      CACHE_TTL.universeStargate
    )
    return { ...value, cached: false }
  }

  async getConstellation(
    constellationId: number,
    forceRefresh = false
  ): Promise<EsiConstellation> {
    assertPositiveId(constellationId, 'constellation')
    const key = String(constellationId)
    const hit = forceRefresh
      ? null
      : this.cache.get<CachedConstellation>(CACHE_SCOPES.universeConstellation, key)
    if (hit) return { ...hit.value, cached: true }

    const raw = await this.requestJson<EsiConstellationResponse>(
      `/universe/constellations/${encodeURIComponent(constellationId)}/`,
      { method: 'GET' }
    )
    const value: CachedConstellation = {
      id: constellationId,
      name: requiredString(raw.name, 'constellation name'),
      regionId: requiredPositiveId(raw.region_id, 'region')
    }
    this.cache.set(
      CACHE_SCOPES.universeConstellation,
      key,
      value,
      CACHE_TTL.universeConstellation
    )
    return { ...value, cached: false }
  }

  async getRegion(regionId: number, forceRefresh = false): Promise<EsiRegion> {
    assertPositiveId(regionId, 'region')
    const key = String(regionId)
    const hit = forceRefresh
      ? null
      : this.cache.get<CachedRegion>(CACHE_SCOPES.universeRegion, key)
    if (hit) return { ...hit.value, cached: true }

    const raw = await this.requestJson<EsiRegionResponse>(
      `/universe/regions/${encodeURIComponent(regionId)}/`,
      { method: 'GET' }
    )
    const value: CachedRegion = {
      id: regionId,
      name: requiredString(raw.name, 'region name')
    }
    this.cache.set(CACHE_SCOPES.universeRegion, key, value, CACHE_TTL.universeRegion)
    return { ...value, cached: false }
  }

  /** Public inventory type metadata. No SSO token is accepted or retained. */
  async getUniverseType(typeId: number, forceRefresh = false): Promise<EsiUniverseType> {
    assertPositiveId(typeId, 'universe type')
    const result = await this.getConditionalCached<CachedUniverseType>(
      UNIVERSE_TYPE_CACHE.scope,
      String(typeId),
      UNIVERSE_TYPE_CACHE.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestJsonResponse<EsiUniverseTypeResponse>(
          `/universe/types/${encodeURIComponent(typeId)}/`,
          {
            method: 'GET',
            ...(etag ? { headers: { 'If-None-Match': etag } } : {})
          },
          true
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        if (!response.data || typeof response.data !== 'object') {
          throw new EsiError('ESI universe type returned an unexpected response')
        }

        const returnedTypeId = requiredPositiveId(response.data.type_id, 'universe type')
        if (returnedTypeId !== typeId) {
          throw new EsiError('ESI universe type response did not match the requested type')
        }
        return {
          notModified: false,
          value: {
            id: returnedTypeId,
            name: requiredString(response.data.name, 'universe type name'),
            groupId: requiredPositiveId(response.data.group_id, 'universe type group'),
            massKg: positiveFiniteNumberOrNull(response.data.mass)
          },
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return { ...result.value, cached: result.cached }
  }

  /** Global public one-hour aggregates. Missing systems are interpreted by the service. */
  async getSystemKills(forceRefresh = false): Promise<EsiSystemKillsResult> {
    const key = 'global'
    const hit = forceRefresh
      ? null
      : this.cache.get<EsiSystemKills[]>(CACHE_SCOPES.systemKills, key)
    if (hit) return { rows: hit.value, cached: true }

    const raw = await this.requestJson<EsiSystemKillsResponse[]>('/universe/system_kills/', {
      method: 'GET'
    })
    if (!Array.isArray(raw)) throw new EsiError('ESI system kills returned an unexpected response')
    const rows = raw.flatMap((item): EsiSystemKills[] => {
      const solarSystemId = positiveIdOrNull(item?.system_id)
      if (solarSystemId === null) return []
      return [{
        solarSystemId,
        npcKills: nonNegativeInteger(item.npc_kills),
        podKills: nonNegativeInteger(item.pod_kills),
        shipKills: nonNegativeInteger(item.ship_kills)
      }]
    })
    this.cache.set(CACHE_SCOPES.systemKills, key, rows, CACHE_TTL.systemKills)
    return { rows, cached: false }
  }

  /** Global public one-hour jump aggregates. Missing systems are interpreted by the service. */
  async getSystemJumps(forceRefresh = false): Promise<EsiSystemJumpsResult> {
    const key = 'global'
    const hit = forceRefresh
      ? null
      : this.cache.get<EsiSystemJumps[]>(CACHE_SCOPES.systemJumps, key)
    if (hit) return { rows: hit.value, cached: true }

    const raw = await this.requestJson<EsiSystemJumpsResponse[]>('/universe/system_jumps/', {
      method: 'GET'
    })
    if (!Array.isArray(raw)) throw new EsiError('ESI system jumps returned an unexpected response')
    const rows = raw.flatMap((item): EsiSystemJumps[] => {
      const solarSystemId = positiveIdOrNull(item?.system_id)
      return solarSystemId === null
        ? []
        : [{ solarSystemId, jumps: nonNegativeInteger(item.ship_jumps) }]
    })
    this.cache.set(CACHE_SCOPES.systemJumps, key, rows, CACHE_TTL.systemJumps)
    return { rows, cached: false }
  }

  /** Requires esi-location.read_location.v1. The access token is never retained. */
  async getAuthenticatedCharacterLocation(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedCharacterLocation> {
    assertPositiveId(characterId, 'character')
    const request = authenticatedGet(accessToken)
    return this.getCharacterLocationState(
      `location:${characterId}`,
      CHARACTER_LOCATION_CACHE_TTL.location,
      forceRefresh,
      async () => {
        const raw = await this.requestJson<EsiCharacterLocationResponse>(
          `/characters/${encodeURIComponent(characterId)}/location/`,
          request,
          (response) => this.beginCharacterLocationCooldown(response)
        )
        return {
          solarSystemId: requiredPositiveId(raw.solar_system_id, 'solar system'),
          stationId: positiveIdOrNull(raw.station_id),
          structureId: positiveIdOrNull(raw.structure_id)
        }
      }
    )
  }

  async getCharacterLocation(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedCharacterLocation> {
    return this.getAuthenticatedCharacterLocation(characterId, accessToken, forceRefresh)
  }

  /** Requires esi-location.read_online.v1. The access token is never retained. */
  async getAuthenticatedCharacterOnline(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedCharacterOnline> {
    assertPositiveId(characterId, 'character')
    const request = authenticatedGet(accessToken)
    return this.getCharacterLocationState(
      `online:${characterId}`,
      CHARACTER_LOCATION_CACHE_TTL.online,
      forceRefresh,
      async () => {
        const raw = await this.requestJson<EsiCharacterOnlineResponse>(
          `/characters/${encodeURIComponent(characterId)}/online/`,
          request,
          (response) => this.beginCharacterLocationCooldown(response)
        )
        return {
          online: raw.online === true,
          lastLogin: optionalString(raw.last_login),
          lastLogout: optionalString(raw.last_logout),
          logins: Number.isSafeInteger(raw.logins) && (raw.logins ?? -1) >= 0
            ? raw.logins ?? null
            : null
        }
      }
    )
  }

  async getCharacterOnline(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedCharacterOnline> {
    return this.getAuthenticatedCharacterOnline(characterId, accessToken, forceRefresh)
  }

  /** Requires esi-location.read_ship_type.v1. The access token is never retained. */
  async getAuthenticatedCharacterShip(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedCharacterShip> {
    assertPositiveId(characterId, 'character')
    const request = authenticatedGet(accessToken)
    return this.getCharacterLocationState(
      `ship:${characterId}`,
      CHARACTER_LOCATION_CACHE_TTL.ship,
      forceRefresh,
      async () => {
        const raw = await this.requestJson<EsiCharacterShipResponse>(
          `/characters/${encodeURIComponent(characterId)}/ship/`,
          request,
          (response) => this.beginCharacterLocationCooldown(response)
        )
        return {
          shipItemId: requiredPositiveNumber(raw.ship_item_id, 'ship item'),
          shipName: normalizeEscapedShipName(requiredString(raw.ship_name, 'ship name')),
          shipTypeId: requiredPositiveId(raw.ship_type_id, 'ship type')
        }
      }
    )
  }

  async getCharacterShip(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedCharacterShip> {
    return this.getAuthenticatedCharacterShip(characterId, accessToken, forceRefresh)
  }

  /** Requires esi-wallet.read_character_wallet.v1. */
  async getAuthenticatedCharacterWallet(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<number> {
    assertPositiveId(characterId, 'character')
    const cacheConfig = AUTHENTICATED_CACHE.wallet
    const result = await this.getConditionalCached<number>(
      cacheConfig.scope,
      String(characterId),
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestJsonResponse<number>(
          `/characters/${encodeURIComponent(characterId)}/wallet/`,
          authenticatedGet(accessToken, etag ? { 'If-None-Match': etag } : undefined),
          true
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        return {
          notModified: false,
          value: requiredFiniteNumber(response.data, 'wallet balance'),
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return result.value
  }

  /** Requires esi-markets.read_character_orders.v1. */
  async getAuthenticatedCharacterOrders(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<EconomyOrderRow[]> {
    assertPositiveId(characterId, 'character')
    const cacheConfig = AUTHENTICATED_CACHE.orders
    const result = await this.getConditionalCached<EconomyOrderRow[]>(
      cacheConfig.scope,
      String(characterId),
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestAuthenticatedPages<EsiCharacterOrderResponse>(
          (page) => `/characters/${encodeURIComponent(characterId)}/orders/${page === 1 ? '' : `?page=${page}`}`,
          accessToken,
          etag
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        return {
          notModified: false,
          value: (response.data ?? []).map((row) => parseEconomyOrder(row, 'open')),
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return result.value
  }

  /** Requires esi-markets.read_character_orders.v1. Handles every history page. */
  async getAuthenticatedCharacterOrderHistory(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<EconomyOrderRow[]> {
    assertPositiveId(characterId, 'character')
    const cacheConfig = AUTHENTICATED_CACHE.orderHistory
    const result = await this.getConditionalCached<EconomyOrderRow[]>(
      cacheConfig.scope,
      String(characterId),
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestAuthenticatedPages<EsiCharacterOrderResponse>(
          (page) => `/characters/${encodeURIComponent(characterId)}/orders/history/?page=${page}`,
          accessToken,
          etag
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        return {
          notModified: false,
          value: (response.data ?? []).map((row) => parseEconomyOrder(row, 'history')),
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return result.value
  }

  /** Requires esi-wallet.read_character_wallet.v1. Follows the from_id history cursor. */
  async getAuthenticatedCharacterWalletTransactions(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<EconomyTransactionRow[]> {
    assertPositiveId(characterId, 'character')
    const cacheConfig = AUTHENTICATED_CACHE.walletTransactions
    const result = await this.getConditionalCached<EconomyTransactionRow[]>(
      cacheConfig.scope,
      String(characterId),
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const path = `/characters/${encodeURIComponent(characterId)}/wallet/transactions/`
        const first = await this.requestJsonResponse<EsiCharacterWalletTransactionResponse[]>(
          path,
          authenticatedGet(accessToken, etag ? { 'If-None-Match': etag } : undefined),
          true
        )
        if (first.status === 304) {
          return { notModified: true, ttlMs: first.cacheTtlMs }
        }
        if (!Array.isArray(first.data)) {
          throw new EsiError('ESI wallet transactions returned an unexpected response')
        }

        const rows = [...first.data]
        const seen = new Set(rows.map((row) => row.transaction_id))
        let pageRows = first.data
        let cursor = minimumPositiveId(pageRows.map((row) => row.transaction_id))
        let reachedEnd = cursor === null
        for (let page = 2; page <= MAX_WALLET_TRANSACTION_PAGES; page += 1) {
          if (cursor === null) break
          const response = await this.requestJsonResponse<EsiCharacterWalletTransactionResponse[]>(
            `${path}?from_id=${encodeURIComponent(cursor)}`,
            authenticatedGet(accessToken)
          )
          if (!Array.isArray(response.data)) {
            throw new EsiError('ESI wallet transactions returned an unexpected page')
          }
          const additions = response.data.filter((row) => !seen.has(row.transaction_id))
          for (const row of additions) seen.add(row.transaction_id)
          rows.push(...additions)
          if (additions.length === 0) {
            reachedEnd = true
            break
          }
          const nextCursor = minimumPositiveId(response.data.map((row) => row.transaction_id))
          if (nextCursor === null || nextCursor >= cursor) {
            throw new EsiError('ESI wallet transaction cursor did not advance')
          }
          pageRows = response.data
          cursor = nextCursor
        }
        if (!reachedEnd && pageRows.length > 0) {
          throw new EsiError('ESI wallet transactions exceeded the safety page limit')
        }

        return {
          notModified: false,
          value: rows.map(parseEconomyTransaction),
          etag: first.etag,
          ttlMs: first.cacheTtlMs
        }
      }
    )
    return result.value
  }

  /** Requires esi-assets.read_assets.v1. Handles every asset page. */
  async getAuthenticatedCharacterAssets(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<EconomyAssetRow[]> {
    assertPositiveId(characterId, 'character')
    const cacheConfig = AUTHENTICATED_CACHE.assets
    const result = await this.getConditionalCached<EconomyAssetRow[]>(
      cacheConfig.scope,
      String(characterId),
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestAuthenticatedPages<EsiCharacterAssetResponse>(
          (page) => `/characters/${encodeURIComponent(characterId)}/assets/?page=${page}`,
          accessToken,
          etag
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        return {
          notModified: false,
          value: (response.data ?? []).map(parseEconomyAsset),
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return result.value
  }

  /**
   * Requires esi-universe.read_structures.v1 and access to the structure.
   * Successful responses are isolated by character in the persistent cache.
   */
  async getAuthenticatedUniverseStructure(
    characterId: number,
    structureId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedUniverseStructure> {
    assertPositiveId(characterId, 'character')
    assertPositiveNumber(structureId, 'structure')
    const cacheConfig = AUTHENTICATED_CACHE.universeStructure
    const result = await this.getConditionalCached<CachedAuthenticatedUniverseStructure>(
      cacheConfig.scope,
      `${characterId}:${structureId}`,
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestJsonResponse<EsiUniverseStructureResponse>(
          `/universe/structures/${encodeURIComponent(structureId)}/`,
          authenticatedGet(accessToken, etag ? { 'If-None-Match': etag } : undefined),
          true
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        return {
          notModified: false,
          value: parseAuthenticatedUniverseStructure(structureId, response.data),
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return { ...result.value, cached: result.cached }
  }

  /** Requires esi-characters.read_contacts.v1. Handles all ESI pages. */
  async getAuthenticatedCharacterContacts(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedCharacterContactsResult> {
    assertPositiveId(characterId, 'character')
    const cacheConfig = AUTHENTICATED_CACHE.contacts
    const result = await this.getConditionalCached<AuthenticatedCharacterContact[]>(
      cacheConfig.scope,
      String(characterId),
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const first = await this.requestJsonResponse<EsiCharacterContactResponse[]>(
          `/characters/${encodeURIComponent(characterId)}/contacts/?page=1`,
          authenticatedGet(accessToken, etag ? { 'If-None-Match': etag } : undefined),
          true
        )
        if (first.status === 304) return { notModified: true, ttlMs: first.cacheTtlMs }
        if (!Array.isArray(first.data)) {
          throw new EsiError('ESI contacts returned an unexpected response')
        }

        const rows = [...first.data]
        for (let page = 2; page <= first.pages; page += 1) {
          const response = await this.requestJsonResponse<EsiCharacterContactResponse[]>(
            `/characters/${encodeURIComponent(characterId)}/contacts/?page=${page}`,
            authenticatedGet(accessToken)
          )
          if (!Array.isArray(response.data)) {
            throw new EsiError('ESI contacts returned an unexpected page')
          }
          if (
            first.lastModified &&
            response.lastModified &&
            first.lastModified !== response.lastModified
          ) {
            throw new EsiError('ESI contacts changed while pages were being read')
          }
          rows.push(...response.data)
        }

        return {
          notModified: false,
          value: rows.map(parseAuthenticatedContact),
          etag: first.etag,
          ttlMs: first.cacheTtlMs
        }
      }
    )
    return { contacts: result.value, cached: result.cached }
  }

  /** Requires esi-characters.read_contacts.v1. */
  async getAuthenticatedCharacterContactLabels(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedCharacterContactLabelsResult> {
    assertPositiveId(characterId, 'character')
    const cacheConfig = AUTHENTICATED_CACHE.contactLabels
    const result = await this.getConditionalCached<AuthenticatedCharacterContactLabel[]>(
      cacheConfig.scope,
      String(characterId),
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestJsonResponse<EsiCharacterContactLabelResponse[]>(
          `/characters/${encodeURIComponent(characterId)}/contacts/labels/`,
          authenticatedGet(accessToken, etag ? { 'If-None-Match': etag } : undefined),
          true
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        if (!Array.isArray(response.data)) {
          throw new EsiError('ESI contact labels returned an unexpected response')
        }
        return {
          notModified: false,
          value: response.data.map(parseAuthenticatedContactLabel),
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return { labels: result.value, cached: result.cached }
  }

  /** Requires esi-fleets.read_fleet.v1. ESI returns 404 when not in a fleet. */
  async getAuthenticatedCharacterFleet(
    characterId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedCharacterFleet> {
    assertPositiveId(characterId, 'character')
    const cacheConfig = AUTHENTICATED_CACHE.characterFleet
    const result = await this.getConditionalCached<Omit<AuthenticatedCharacterFleet, 'cached'>>(
      cacheConfig.scope,
      String(characterId),
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestJsonResponse<EsiCharacterFleetResponse>(
          `/characters/${encodeURIComponent(characterId)}/fleet/`,
          authenticatedGet(accessToken, etag ? { 'If-None-Match': etag } : undefined),
          true
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        return {
          notModified: false,
          value: parseAuthenticatedCharacterFleet(response.data),
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return { ...result.value, cached: result.cached }
  }

  /** Requires esi-fleets.read_fleet.v1 and the token character to be the requested fleet's boss. */
  async getAuthenticatedFleetMembers(
    fleetId: number,
    accessToken: string,
    forceRefresh = false
  ): Promise<AuthenticatedFleetMembersResult> {
    assertPositiveNumber(fleetId, 'fleet')
    const cacheConfig = AUTHENTICATED_CACHE.fleetMembers
    const result = await this.getConditionalCached<AuthenticatedFleetMember[]>(
      cacheConfig.scope,
      String(fleetId),
      cacheConfig.ttlMs,
      forceRefresh,
      async (etag) => {
        const response = await this.requestJsonResponse<EsiFleetMemberResponse[]>(
          `/fleets/${encodeURIComponent(fleetId)}/members/`,
          authenticatedGet(accessToken, etag ? { 'If-None-Match': etag } : undefined),
          true
        )
        if (response.status === 304) {
          return { notModified: true, ttlMs: response.cacheTtlMs }
        }
        if (!Array.isArray(response.data)) {
          throw new EsiError('ESI fleet members returned an unexpected response')
        }
        return {
          notModified: false,
          value: response.data.map(parseAuthenticatedFleetMember),
          etag: response.etag,
          ttlMs: response.cacheTtlMs
        }
      }
    )
    return { members: result.value, cached: result.cached }
  }

  private getCharacterLocationState<T extends object>(
    key: string,
    ttlMs: number,
    forceRefresh: boolean,
    load: () => Promise<T>
  ): Promise<T> {
    const now = this.now()
    const cached = this.characterLocationCache.get(key)

    if (!forceRefresh && cached && cached.freshUntil > now) {
      return Promise.resolve(cloneFlatObject(cached.value as T))
    }

    // A fresh local value is safe during an upstream cooldown. Forced/stale
    // reads and new network work remain blocked until the server deadline.
    if (this.globalBlockedUntil > now) {
      return Promise.reject(this.characterLocationCooldownError())
    }

    const existing = this.characterLocationInFlight.get(key)
    if (existing) {
      return this.resolveCharacterLocationOperation(existing)
    }

    const operation: Promise<object> = (async () => {
      const value = await load()
      const retained = cloneFlatObject(value)
      this.characterLocationCache.set(key, {
        value: retained,
        freshUntil: this.now() + ttlMs
      })
      return retained
    })()

    this.characterLocationInFlight.set(key, operation)
    void operation.finally(() => {
      if (this.characterLocationInFlight.get(key) === operation) {
        this.characterLocationInFlight.delete(key)
      }
    }).catch(() => undefined)

    return this.resolveCharacterLocationOperation(operation)
  }

  private resolveCharacterLocationOperation<T extends object>(
    operation: Promise<object>
  ): Promise<T> {
    return operation.then(
      (value) => cloneFlatObject(value as T),
      (error: unknown) => {
        if (error instanceof EsiError && error.status === 429) {
          throw this.characterLocationCooldownError()
        }
        throw error
      }
    )
  }

  private beginCharacterLocationCooldown(_response: Response): EsiError {
    return this.characterLocationCooldownError()
  }

  private characterLocationCooldownError(): EsiError {
    return new ImmediateEsiError(CHARACTER_LOCATION_RATE_LIMIT_MESSAGE, 429)
  }

  private beginGlobalCooldown(response: Response, explicitRetryAfterMs?: number): void {
    const now = this.now()
    const retryAfterMs = explicitRetryAfterMs ?? parseRetryAfterMilliseconds(
      response.headers.get('retry-after'),
      now
    ) ?? ESI_RATE_LIMIT_FALLBACK_MS
    const blockedUntil = now + retryAfterMs
    if (blockedUntil >= this.globalBlockedUntil) {
      this.globalBlockedUntil = blockedUntil
      this.globalBlockedStatus = response.status
    }
  }

  private globalCooldownError(): EsiError {
    return new ImmediateEsiError(
      this.globalBlockedStatus === 429
        ? GLOBAL_RATE_LIMIT_MESSAGE
        : 'ESI request paused by server Retry-After',
      this.globalBlockedStatus, undefined, Math.max(1000, this.globalBlockedUntil - this.now())
    )
  }

  private async requestAuthenticatedPages<T>(
    pathForPage: (page: number) => string,
    accessToken: string,
    etag: string | null
  ): Promise<EsiJsonResponse<T[]>> {
    const first = await this.requestJsonResponse<T[]>(
      pathForPage(1),
      authenticatedGet(accessToken, etag ? { 'If-None-Match': etag } : undefined),
      true
    )
    if (first.status === 304) return first
    if (!Array.isArray(first.data)) {
      throw new EsiError('ESI paged route returned an unexpected response')
    }
    if (first.pages > MAX_AUTHENTICATED_PAGES) {
      throw new EsiError('ESI paged route returned too many pages')
    }

    const remaining = await mapConcurrentEsi(
      Array.from({ length: first.pages - 1 }, (_, index) => index + 2),
      AUTHENTICATED_PAGE_CONCURRENCY,
      (page) => this.requestJsonResponse<T[]>(pathForPage(page), authenticatedGet(accessToken))
    )
    const rows = [...first.data]
    for (const response of remaining) {
      if (!Array.isArray(response.data)) {
        throw new EsiError('ESI paged route returned an unexpected page')
      }
      if (
        first.lastModified &&
        response.lastModified &&
        first.lastModified !== response.lastModified
      ) {
        throw new EsiError('ESI data changed while pages were being read')
      }
      rows.push(...response.data)
    }
    return { ...first, data: rows }
  }

  private async getConditionalCached<T>(
    scope: string,
    key: string,
    fallbackTtlMs: number,
    forceRefresh: boolean,
    load: (etag: string | null) => Promise<ConditionalLoad<T>>
  ): Promise<{ value: T; cached: boolean }> {
    const now = this.now()
    const rawHit = forceRefresh
      ? null
      : this.cache.get<ConditionalCacheEnvelope<T>>(scope, key, now)
    const hit = rawHit && isConditionalCacheEnvelope<T>(rawHit.value)
      ? rawHit.value
      : null

    if (hit && hit.freshUntil > now) return { value: hit.value, cached: true }

    const loaded = await load(hit?.etag ?? null)
    const ttlMs = loaded.ttlMs ?? fallbackTtlMs
    if (loaded.notModified) {
      if (!hit) throw new EsiError('ESI returned 304 without a cached response')
      const envelope: ConditionalCacheEnvelope<T> = {
        ...hit,
        freshUntil: now + Math.max(0, ttlMs)
      }
      this.cache.set(scope, key, envelope, CONDITIONAL_CACHE_RETENTION_MS, now)
      return { value: envelope.value, cached: true }
    }

    const envelope: ConditionalCacheEnvelope<T> = {
      value: loaded.value,
      etag: loaded.etag,
      freshUntil: now + Math.max(0, ttlMs)
    }
    this.cache.set(scope, key, envelope, CONDITIONAL_CACHE_RETENTION_MS, now)
    return { value: envelope.value, cached: false }
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    onRateLimit?: (response: Response) => EsiError
  ): Promise<T> {
    const response = await this.requestJsonResponse<T>(path, init, false, onRateLimit)
    if (response.data === null) throw new EsiError('ESI returned an empty response')
    return response.data
  }

  private async requestJsonResponse<T>(
    path: string,
    init: RequestInit,
    allowNotModified = false,
    onRateLimit?: (response: Response) => EsiError,
    retryPolicy: 'safe' | 'no-retry' = 'safe'
  ): Promise<EsiJsonResponse<T>> {
    let lastError: unknown
    const maximumAttempts = retryPolicy === 'no-retry' ? 1 : this.maxAttempts

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (this.globalBlockedUntil > this.now()) throw this.globalCooldownError()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': this.userAgent,
            'X-Compatibility-Date': COMPATIBILITY_DATE,
            ...init.headers
          }
        })

        if (allowNotModified && response.status === 304) {
          return responseMetadata<T>(response, null)
        }

        if (!response.ok) {
          if (response.status === 429) {
            this.beginGlobalCooldown(response)
            throw onRateLimit?.(response) ?? this.globalCooldownError()
          }
          const retryAfterMs = parseRetryAfterMilliseconds(
            response.headers.get('retry-after'),
            this.now()
          )
          if (isRetryableStatus(response.status) && retryAfterMs !== null &&
              retryAfterMs > ESI_INLINE_RETRY_MAX_MS) {
            this.beginGlobalCooldown(response, retryAfterMs)
            throw new ImmediateEsiError(
              `ESI ${response.status}: server requested retry later`,
              response.status
            )
          }
          const detail = (await response.text()).slice(0, 300)
          const error = new EsiError(
            `ESI ${response.status}: ${detail || response.statusText}`,
            response.status
          )
          if (!isRetryableStatus(response.status) || attempt === maximumAttempts) {
            throw error
          }
          lastError = error
          await delay(retryDelay(response.headers.get('retry-after'), attempt, this.now()))
          continue
        }

        if (response.status === 204) return responseMetadata<T>(response, null)

        return responseMetadata(response, (await response.json()) as T)
      } catch (error) {
        lastError = error
        if (error instanceof ImmediateEsiError) break
        const status = error instanceof EsiError ? error.status : null
        const retryable = status === null || (status !== null && isRetryableStatus(status))
        if (!retryable || attempt === maximumAttempts) break
        await delay(retryDelay(null, attempt, this.now()))
      } finally {
        clearTimeout(timeout)
      }
    }

    if (lastError instanceof EsiError) throw lastError
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    throw new EsiError(`ESI request failed: ${message}`, null, {
      cause: lastError
    })
  }
}

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase('en-US')
}

function industryLevel(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new EsiError(`ESI returned invalid ${label}`)
  return value as number
}

function assertMarketSearchText(value: string, label: string): void {
  if (
    value.length < 1 ||
    value.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`Invalid ${label}`)
  }
}

function parseMarketOrder(raw: EsiMarketOrderResponse, requestedTypeId: number): MarketOrder {
  if (!raw || typeof raw !== 'object') {
    throw new EsiError('ESI returned an invalid market order')
  }
  const typeId = requiredPositiveId(raw.type_id, 'market order type')
  if (typeId !== requestedTypeId) {
    throw new EsiError('ESI market order did not match the requested type')
  }
  const price = requiredFiniteNumber(raw.price, 'market order price')
  if (price <= 0) throw new EsiError('ESI returned an invalid market order price')
  const volumeRemain = requiredNonNegativeSafeInteger(raw.volume_remain, 'market remaining volume')
  const volumeTotal = requiredPositiveSafeInteger(raw.volume_total, 'market total volume')
  const minVolume = requiredPositiveSafeInteger(raw.min_volume, 'market minimum volume')
  if (volumeRemain > volumeTotal || minVolume > volumeTotal) {
    throw new EsiError('ESI returned inconsistent market order volume')
  }
  const issued = requiredIsoTimestamp(raw.issued, 'market order issue time')

  return {
    orderId: requiredPositiveId(raw.order_id, 'market order'),
    typeId,
    locationId: requiredPositiveId(raw.location_id, 'market order location'),
    systemId: requiredPositiveId(raw.system_id, 'market order system'),
    isBuyOrder: raw.is_buy_order === true,
    price,
    volumeRemain,
    volumeTotal,
    minVolume,
    issued,
    // Duration is descriptive, not executable price/volume. Preserve zero and
    // represent absent/legacy metadata as unknown rather than failing the region.
    durationDays: Number.isSafeInteger(raw.duration) && raw.duration >= 0 ? raw.duration : null,
    range: requiredString(raw.range, 'market order range')
  }
}

function parseMarketHistoryPoint(raw: EsiMarketHistoryResponse): MarketHistoryPoint {
  if (!raw || typeof raw !== 'object') {
    throw new EsiError('ESI returned an invalid market history point')
  }
  const date = requiredString(raw.date, 'market history date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    throw new EsiError('ESI returned an invalid market history date')
  }
  const average = requiredNonNegativeFiniteNumber(raw.average, 'market history average')
  const highest = requiredNonNegativeFiniteNumber(raw.highest, 'market history high')
  const lowest = requiredNonNegativeFiniteNumber(raw.lowest, 'market history low')
  if (lowest > highest) throw new EsiError('ESI returned inconsistent market history prices')
  return {
    date,
    average,
    highest,
    lowest,
    orderCount: requiredNonNegativeSafeInteger(raw.order_count, 'market history order count'),
    volume: requiredNonNegativeSafeInteger(raw.volume, 'market history volume')
  }
}

function parseEconomyMarketPrice(raw: EsiMarketPriceResponse): EconomyMarketPrice {
  if (!raw || typeof raw !== 'object') {
    throw new EsiError('ESI returned an invalid market price')
  }
  return {
    typeId: requiredPositiveId(raw.type_id, 'market price type'),
    averagePrice: optionalNonNegativeFiniteNumber(raw.average_price, 'average market price'),
    adjustedPrice: optionalNonNegativeFiniteNumber(raw.adjusted_price, 'adjusted market price')
  }
}

function parseEconomyOrder(
  raw: EsiCharacterOrderResponse,
  source: 'open' | 'history'
): EconomyOrderRow {
  if (!raw || typeof raw !== 'object') {
    throw new EsiError('ESI returned an invalid character order')
  }
  const volumeRemain = requiredNonNegativeSafeInteger(raw.volume_remain, 'order remaining volume')
  const volumeTotal = requiredPositiveSafeInteger(raw.volume_total, 'order total volume')
  if (volumeRemain > volumeTotal) {
    throw new EsiError('ESI returned inconsistent character order volume')
  }
  const minVolume = raw.min_volume === undefined
    ? 1
    : requiredNonNegativeSafeInteger(raw.min_volume, 'order minimum volume')
  const price = requiredNonNegativeFiniteNumber(raw.price, 'character order price')
  const escrow = raw.escrow === undefined
    ? 0
    : requiredNonNegativeFiniteNumber(raw.escrow, 'character order escrow')

  return {
    orderId: requiredPositiveId(raw.order_id, 'character order'),
    typeId: requiredPositiveId(raw.type_id, 'character order type'),
    locationId: requiredPositiveId(raw.location_id, 'character order location'),
    regionId: requiredPositiveId(raw.region_id, 'character order region'),
    buyOrder: raw.is_buy_order === true,
    price,
    volumeRemain,
    volumeTotal,
    minVolume,
    issued: requiredIsoTimestamp(raw.issued, 'character order issue time'),
    durationDays: requiredNonNegativeSafeInteger(raw.duration, 'character order duration'),
    escrow,
    state: source === 'open' ? 'open' : parseHistoricalOrderState(raw.state)
  }
}

function parseHistoricalOrderState(value: unknown): EconomyOrderRow['state'] {
  if (value === 'cancelled' || value === 'expired') return value
  throw new EsiError('ESI returned an invalid historical order state')
}

function parseEconomyTransaction(
  raw: EsiCharacterWalletTransactionResponse
): EconomyTransactionRow {
  if (!raw || typeof raw !== 'object') {
    throw new EsiError('ESI returned an invalid wallet transaction')
  }
  return {
    transactionId: requiredPositiveId(raw.transaction_id, 'wallet transaction'),
    date: requiredIsoTimestamp(raw.date, 'wallet transaction date'),
    typeId: requiredPositiveId(raw.type_id, 'wallet transaction type'),
    quantity: requiredPositiveSafeInteger(raw.quantity, 'wallet transaction quantity'),
    unitPrice: requiredNonNegativeFiniteNumber(raw.unit_price, 'wallet transaction unit price'),
    buy: raw.is_buy === true,
    personal: raw.is_personal === true,
    locationId: requiredPositiveId(raw.location_id, 'wallet transaction location'),
    clientId: requiredPositiveId(raw.client_id, 'wallet transaction client')
  }
}

function parseEconomyAsset(raw: EsiCharacterAssetResponse): EconomyAssetRow {
  if (!raw || typeof raw !== 'object') {
    throw new EsiError('ESI returned an invalid character asset')
  }
  const rawQuantity = requiredInteger(raw.quantity, 'asset quantity')
  const singleton = raw.is_singleton === true
  const quantity = rawQuantity > 0
    ? rawQuantity
    : singleton && (rawQuantity === -1 || rawQuantity === -2)
      ? 1
      : 0
  if (quantity <= 0 || !Number.isSafeInteger(quantity)) {
    throw new EsiError('ESI returned an invalid asset quantity')
  }
  return {
    itemId: requiredPositiveNumber(raw.item_id, 'asset item'),
    typeId: requiredPositiveId(raw.type_id, 'asset type'),
    quantity,
    locationId: requiredPositiveNumber(raw.location_id, 'asset location'),
    locationType: requiredString(raw.location_type, 'asset location type'),
    locationFlag: requiredString(raw.location_flag, 'asset location flag'),
    singleton
  }
}

function parseAuthenticatedUniverseStructure(
  structureId: number,
  raw: EsiUniverseStructureResponse | null
): CachedAuthenticatedUniverseStructure {
  if (!raw || typeof raw !== 'object') {
    throw new EsiError('ESI universe structure returned an unexpected response')
  }
  return {
    structureId,
    name: requiredString(raw.name, 'universe structure name'),
    solarSystemId: requiredPositiveId(raw.solar_system_id, 'universe structure solar system'),
    typeId: raw.type_id === undefined
      ? null
      : requiredPositiveId(raw.type_id, 'universe structure type'),
    ownerId: requiredPositiveId(raw.owner_id, 'universe structure owner')
  }
}

function deduplicateNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const rawName of names) {
    const name = rawName.trim()
    const key = normalizeName(name)
    if (!name || seen.has(key)) continue
    seen.add(key)
    result.push(name)
  }
  return result
}

function deduplicateIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))]
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size))
  }
  return result
}

async function mapConcurrentEsi<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const result = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      result[index] = await work(items[index])
    }
  })
  await Promise.all(workers)
  return result
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function retryDelay(retryAfter: string | null, attempt: number, now: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      const milliseconds = seconds * 1_000
      if (Number.isFinite(milliseconds)) return milliseconds
    }

    const timestamp = Date.parse(retryAfter)
    if (Number.isFinite(timestamp)) {
      return Math.max(0, timestamp - now)
    }
  }
  return Math.min(4_000, 400 * 2 ** (attempt - 1))
}

function parseRetryAfterMilliseconds(retryAfter: string | null, now: number): number | null {
  const normalized = retryAfter?.trim() ?? ''
  if (!normalized) return null

  const seconds = Number(normalized)
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1_000
    return Number.isFinite(milliseconds) ? milliseconds : null
  }

  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function cloneFlatObject<T extends object>(value: T): T {
  return { ...value }
}

function authenticatedGet(
  accessToken: string,
  additionalHeaders?: Record<string, string>
): RequestInit {
  const token = accessToken.trim()
  if (!token) throw new TypeError('Access token is required')
  return {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, ...additionalHeaders }
  }
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid ${label} ID`)
}

function assertPositiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`Invalid ${label} ID`)
  }
}

function positiveIdOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null
}

function requiredPositiveId(value: unknown, label: string): number {
  const parsed = positiveIdOrNull(value)
  if (parsed === null) throw new EsiError(`ESI returned an invalid ${label} ID`)
  return parsed
}

function requiredPositiveIdArray(
  value: unknown,
  label: string,
  maximumLength: number
): number[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new EsiError(`ESI returned invalid ${label}`)
  }
  const ids: number[] = []
  const seen = new Set<number>()
  for (const item of value) {
    const id = requiredPositiveId(item, label)
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function requiredPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new EsiError(`ESI returned an invalid ${label} ID`)
  }
  return value
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EsiError(`ESI returned an invalid ${label}`)
  }
  return value
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new EsiError(`ESI returned an invalid ${label}`)
  }
  return value
}

function requiredNonNegativeFiniteNumber(value: unknown, label: string): number {
  const parsed = requiredFiniteNumber(value, label)
  if (parsed < 0) throw new EsiError(`ESI returned an invalid ${label}`)
  return parsed
}

function optionalNonNegativeFiniteNumber(value: unknown, label: string): number | null {
  return value === undefined || value === null
    ? null
    : requiredNonNegativeFiniteNumber(value, label)
}

function requiredPositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new EsiError(`ESI returned an invalid ${label}`)
  }
  return value as number
}

function requiredNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new EsiError(`ESI returned an invalid ${label}`)
  }
  return value as number
}

function requiredIsoTimestamp(value: unknown, label: string): string {
  const parsed = requiredString(value, label)
  if (!Number.isFinite(Date.parse(parsed))) throw new EsiError(`ESI returned an invalid ${label}`)
  return parsed
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EsiError(`ESI returned an invalid ${label}`)
  }
  return value
}

/**
 * Some ship names arrive double-serialized as a Python unicode literal, for example
 * `u'\u041c\u043e\u0439 \u043a\u043e\u0440\u0430\u0431\u043b\u044c'`.
 * Decode only that complete, well-formed shape. Ordinary names and malformed literals
 * remain byte-for-byte unchanged.
 */
function normalizeEscapedShipName(value: string): string {
  if (value.length < 4 || (value[0] !== 'u' && value[0] !== 'U')) return value

  const quote = value[1]
  if ((quote !== "'" && quote !== '"') || value.at(-1) !== quote) return value

  const body = value.slice(2, -1)
  let decoded = ''
  let sawUnicodeEscape = false

  for (let index = 0; index < body.length;) {
    const character = body[index]
    if (character !== '\\') {
      // An unescaped matching quote means this is not one complete Python literal.
      if (character === quote || character === '\n' || character === '\r') return value
      decoded += character
      index += 1
      continue
    }

    const escapeType = body[index + 1]
    if (escapeType === '\\' || escapeType === quote) {
      decoded += escapeType
      index += 2
      continue
    }

    if (escapeType === 'u') {
      const highOrScalar = parseFixedHexEscape(body, index + 2, 4)
      if (highOrScalar === null) return value

      if (highOrScalar >= 0xd800 && highOrScalar <= 0xdbff) {
        if (body.slice(index + 6, index + 8) !== '\\u') return value
        const low = parseFixedHexEscape(body, index + 8, 4)
        if (low === null || low < 0xdc00 || low > 0xdfff) return value
        decoded += String.fromCodePoint(
          0x10000 + ((highOrScalar - 0xd800) << 10) + (low - 0xdc00)
        )
        index += 12
      } else {
        if (highOrScalar >= 0xdc00 && highOrScalar <= 0xdfff) return value
        decoded += String.fromCodePoint(highOrScalar)
        index += 6
      }
      sawUnicodeEscape = true
      continue
    }

    if (escapeType === 'U') {
      const codePoint = parseFixedHexEscape(body, index + 2, 8)
      if (
        codePoint === null ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return value
      }
      decoded += String.fromCodePoint(codePoint)
      index += 10
      sawUnicodeEscape = true
      continue
    }

    return value
  }

  return sawUnicodeEscape && decoded.trim() ? decoded : value
}

function parseFixedHexEscape(value: string, start: number, length: number): number | null {
  const digits = value.slice(start, start + length)
  return digits.length === length && /^[0-9a-f]+$/i.test(digits)
    ? Number.parseInt(digits, 16)
    : null
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0
}

function minimumPositiveId(values: readonly number[]): number | null {
  let minimum: number | null = null
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) continue
    minimum = minimum === null ? value : Math.min(minimum, value)
  }
  return minimum
}

function responseMetadata<T>(response: Response, data: T | null): EsiJsonResponse<T> {
  const pagesHeader = response.headers.get('x-pages')
  const pages = pagesHeader === null ? 1 : Number(pagesHeader)
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 10_000) {
    throw new EsiError('ESI returned an invalid page count')
  }

  return {
    status: response.status,
    data,
    etag: optionalHeader(response.headers.get('etag')),
    lastModified: optionalHeader(response.headers.get('last-modified')),
    cacheTtlMs: cacheTtlFromHeader(response.headers.get('cache-control')),
    pages,
    expiresAt: optionalHeader(response.headers.get('expires'))
  }
}

function oldestHeaderDate(values: Array<string | null>): string | undefined {
  const times = values.flatMap(value => value && Number.isFinite(Date.parse(value)) ? [Date.parse(value)] : [])
  return times.length ? new Date(Math.min(...times)).toISOString() : undefined
}

function optionalHeader(value: string | null): string | null {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function cacheTtlFromHeader(cacheControl: string | null): number | null {
  const match = /(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*"?(\d+)"?/i.exec(cacheControl ?? '')
  if (!match) return null
  const seconds = Number(match[1])
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : null
}

function isConditionalCacheEnvelope<T>(value: unknown): value is ConditionalCacheEnvelope<T> {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    Object.prototype.hasOwnProperty.call(record, 'value') &&
    (record.etag === null || typeof record.etag === 'string') &&
    typeof record.freshUntil === 'number' &&
    Number.isFinite(record.freshUntil)
  )
}

function parseAuthenticatedContact(raw: EsiCharacterContactResponse): AuthenticatedCharacterContact {
  const contactType = parseContactType(raw?.contact_type)
  const standing = requiredFiniteNumber(raw?.standing, 'contact standing')
  if (standing < -10 || standing > 10) {
    throw new EsiError('ESI returned an invalid contact standing')
  }
  const labelIds = Array.isArray(raw?.label_ids)
    ? deduplicateIds(raw.label_ids)
    : []

  return {
    contactId: requiredPositiveId(raw?.contact_id, 'contact'),
    contactType,
    standing,
    labelIds,
    watched: raw?.is_watched === true,
    blocked: raw?.is_blocked === true
  }
}

function parseContactType(value: unknown): PilotContactType {
  if (
    value === 'character' ||
    value === 'corporation' ||
    value === 'alliance' ||
    value === 'faction'
  ) {
    return value
  }
  throw new EsiError('ESI returned an invalid contact type')
}

function parseAuthenticatedContactLabel(
  raw: EsiCharacterContactLabelResponse
): AuthenticatedCharacterContactLabel {
  return {
    labelId: requiredPositiveId(raw?.label_id, 'contact label'),
    name: requiredString(raw?.label_name, 'contact label name')
  }
}

function parseAuthenticatedCharacterFleet(
  raw: EsiCharacterFleetResponse | null
): Omit<AuthenticatedCharacterFleet, 'cached'> {
  if (!raw || typeof raw !== 'object') {
    throw new EsiError('ESI character fleet returned an unexpected response')
  }
  return {
    fleetId: requiredPositiveNumber(raw.fleet_id, 'fleet'),
    fleetBossId: requiredPositiveId(raw.fleet_boss_id, 'fleet boss'),
    role: requiredString(raw.role, 'fleet role'),
    wingId: positiveNumberOrNull(raw.wing_id),
    squadId: positiveNumberOrNull(raw.squad_id)
  }
}

function parseAuthenticatedFleetMember(raw: EsiFleetMemberResponse): AuthenticatedFleetMember {
  return {
    characterId: requiredPositiveId(raw?.character_id, 'fleet member'),
    joinedAt: requiredString(raw?.join_time, 'fleet join time'),
    role: requiredString(raw?.role, 'fleet member role'),
    roleName: requiredString(raw?.role_name, 'fleet member role name'),
    shipTypeId: requiredPositiveId(raw?.ship_type_id, 'fleet member ship type'),
    solarSystemId: requiredPositiveId(raw?.solar_system_id, 'fleet member solar system'),
    squadId: positiveNumberOrNull(raw?.squad_id),
    stationId: positiveNumberOrNull(raw?.station_id),
    takesFleetWarp: raw?.takes_fleet_warp === true,
    wingId: positiveNumberOrNull(raw?.wing_id)
  }
}

function positiveNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : null
}

function positiveFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}
