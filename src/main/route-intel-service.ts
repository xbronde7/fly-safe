import {
  ROUTE_NOT_LIVE_LIMITATION,
  assessRouteSystemRisk,
  buildRouteCorridorAlerts,
  classifyRouteKillmailFreshness,
  estimateRouteHauling,
  summarizeRoute,
  validateRouteIntelRequest,
  validateRouteSystemIds,
  type NormalizedRouteEndpoint,
  type ResolvedRouteEndpoint,
  type RouteIntelRequest,
  type RouteIntelResult,
  type RouteMode,
  type RoutePathSnapshot,
  type RouteRecentPublicKillmailSnapshot,
  type RouteRowsSnapshot,
  type RouteSystemIntel,
  type RouteSystemJumpRow,
  type RouteSystemKillRow,
  type RouteSystemMetadataSource
} from '../shared/route-intel'
import { isWormholeSystemId } from '../shared/system-intel'

export interface RouteSolarSystemIdentity {
  id: number
  name: string
  cached?: boolean
}

export interface RouteSystemResolver {
  resolveSolarSystemId(
    name: string,
    forceRefresh?: boolean
  ): Promise<RouteSolarSystemIdentity | null>
}

export interface RoutePathProvider {
  getRouteSystems(
    originId: number,
    destinationId: number,
    mode: RouteMode,
    forceRefresh?: boolean
  ): Promise<RoutePathSnapshot | readonly number[]>
}

export interface RouteMetadataProvider {
  getSystemMetadata(
    solarSystemId: number,
    forceRefresh?: boolean
  ): Promise<RouteSystemMetadataSource>
}

export interface RouteActivityProvider {
  getSystemKills(
    forceRefresh?: boolean
  ): Promise<RouteRowsSnapshot<RouteSystemKillRow>>
  getSystemJumps(
    forceRefresh?: boolean
  ): Promise<RouteRowsSnapshot<RouteSystemJumpRow>>
}

export interface RouteSystemIntelLookup {
  lookupSystemIntel(
    solarSystemId: number,
    forceRefresh?: boolean
  ): Promise<RouteRecentPublicKillmailSnapshot | null>
}

export interface RouteIntelDependencies extends
  RouteSystemResolver,
  RoutePathProvider,
  RouteMetadataProvider,
  RouteActivityProvider {
  systemIntel?: RouteSystemIntelLookup
}

export interface RouteIntelServiceOptions {
  now?: () => Date
  metadataConcurrency?: number
  recentIntelConcurrency?: number
  maxRecentIntelSystems?: number
  recentIntelCacheTtlMs?: number
  recentIntelForceRefreshCooldownMs?: number
  recentIntelErrorCacheTtlMs?: number
  recentIntelCacheCapacity?: number
}

interface LoadedRows<T> {
  available: boolean
  rows: Map<number, T>
  sourceAt: string | null
  cached: boolean | null
}

interface LoadedMetadata {
  value: RouteSystemMetadataSource | null
  warning: string | null
}

interface LoadedRecentIntel {
  value: RouteRecentPublicKillmailSnapshot | null
  warning: string | null
  checked: boolean
}

interface LoadedRecentIntelBatch {
  rows: LoadedRecentIntel[]
  candidateCount: number
  checkedCount: number
}

interface RecentIntelCacheEntry {
  value: RouteRecentPublicKillmailSnapshot | null
  loadedAt: number
  failedAt: number | null
  warning: string | null
}

export interface RouteSystemHistorySourceResult {
  solarSystemId: number
  killmails: unknown[]
  cached: boolean
}

export interface RouteSystemHistorySource {
  getSystemHistory(
    solarSystemId: number,
    forceRefresh?: boolean
  ): Promise<RouteSystemHistorySourceResult>
  getPublicKillmail?(
    killmailId: number,
    hash: string,
    forceRefresh?: boolean
  ): Promise<{ killmail: unknown; cached: boolean }>
}

export interface ZkillRouteSystemIntelLookupOptions {
  now?: () => Date
  windowHours?: number
}

/**
 * Lightweight route adapter. Full zKill rows are read directly; compact zkbOnly
 * rows hydrate only the newest immutable killmail so route polling stays bounded.
 */
export class ZkillRouteSystemIntelLookup implements RouteSystemIntelLookup {
  private readonly now: () => Date
  private readonly windowHours: number

  constructor(
    private readonly source: RouteSystemHistorySource,
    options: ZkillRouteSystemIntelLookupOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.windowHours = positiveFinite(options.windowHours, 24, 'Killmail history window')
  }

  async lookupSystemIntel(
    solarSystemId: number,
    forceRefresh = false
  ): Promise<RouteRecentPublicKillmailSnapshot> {
    if (!positiveId(solarSystemId)) throw new TypeError('Invalid system ID')
    const result = await this.source.getSystemHistory(solarSystemId, forceRefresh)
    if (result.solarSystemId !== solarSystemId || !Array.isArray(result.killmails)) {
      throw new TypeError('zKill returned history for a different system')
    }

    const now = this.now()
    const nowMs = now.getTime()
    const oldestMs = nowMs - this.windowHours * 60 * 60 * 1_000
    const oneHourAgoMs = nowMs - 60 * 60 * 1_000
    const times: number[] = []
    const references: Array<{ killmailId: number; hash: string }> = []
    let invalid = 0
    for (const raw of result.killmails) {
      const record = asRecord(raw)
      const systemId = positiveInteger(record?.solar_system_id)
      const timestamp = typeof record?.killmail_time === 'string'
        ? Date.parse(record.killmail_time)
        : Number.NaN
      const looksLikeFullRow = record !== null && (
        Object.prototype.hasOwnProperty.call(record, 'solar_system_id') ||
        Object.prototype.hasOwnProperty.call(record, 'killmail_time')
      )
      if (looksLikeFullRow) {
        if (systemId === solarSystemId && Number.isFinite(timestamp) &&
            timestamp <= nowMs + 5 * 60_000) {
          if (timestamp >= oldestMs) times.push(timestamp)
        } else {
          invalid += 1
        }
        continue
      }
      const reference = compactKillmailReference(record)
      if (reference) references.push(reference)
      else invalid += 1
    }

    let hydratedCached = true
    let usedNewestOnlyHydration = false
    let hydrationWarning: string | null = null
    if (times.length === 0 && references.length > 0 && this.source.getPublicKillmail) {
      const newest = references[0]
      try {
        const hydrated = await this.source.getPublicKillmail(
          newest.killmailId,
          newest.hash,
          false
        )
        hydratedCached = hydrated.cached
        const killmail = asRecord(hydrated.killmail)
        const systemId = positiveInteger(killmail?.solar_system_id)
        const timestamp = typeof killmail?.killmail_time === 'string'
          ? Date.parse(killmail.killmail_time)
          : Number.NaN
        if (systemId === solarSystemId && Number.isFinite(timestamp) &&
            timestamp >= oldestMs && timestamp <= nowMs + 5 * 60_000) {
          times.push(timestamp)
          usedNewestOnlyHydration = true
        } else {
          invalid += 1
        }
      } catch {
        hydratedCached = false
        hydrationWarning = 'ESI: latest killmail time is temporarily unavailable'
      }
    }
    times.sort((left, right) => right - left)
    const parsedLastHourCount = times.filter((timestamp) => timestamp >= oneHourAgoMs).length
    const endpointCount = times.length + references.length - (usedNewestOnlyHydration ? 1 : 0)
    const lastHourCount = times.length > 0 || references.length === 0
      ? parsedLastHourCount
      : null
    const lowerBound = references.length > 0 && parsedLastHourCount > 0 && endpointCount > parsedLastHourCount

    return {
      count: endpointCount,
      windowHours: this.windowHours,
      lastHourCount,
      lastHourCountLowerBound: lowerBound,
      latestAt: times[0] === undefined ? null : new Date(times[0]).toISOString(),
      fetchedAt: now.toISOString(),
      cached: result.cached && hydratedCached,
      capped: result.killmails.length >= 200,
      warnings: [
        ...(invalid > 0
          ? [`zKill: skipped rows without exact time/system: ${invalid}`]
          : []),
        ...(lowerBound
          ? ['zKill: fights per hour is a lower bound; only the latest killmail was verified exactly']
          : []),
        ...(hydrationWarning ? [hydrationWarning] : [])
      ]
    }
  }
}

/**
 * Coordinates route planning with public, historical activity evidence. ESI and
 * killboard clients remain outside this class and are supplied through adapters.
 */
export class RouteIntelService {
  private readonly now: () => Date
  private readonly metadataConcurrency: number
  private readonly recentIntelConcurrency: number
  private readonly maxRecentIntelSystems: number
  private readonly recentIntelCacheTtlMs: number
  private readonly recentIntelForceRefreshCooldownMs: number
  private readonly recentIntelErrorCacheTtlMs: number
  private readonly recentIntelCacheCapacity: number
  private readonly recentIntelCache = new Map<number, RecentIntelCacheEntry>()

  constructor(
    private readonly dependencies: RouteIntelDependencies,
    options: RouteIntelServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.metadataConcurrency = positiveConcurrency(options.metadataConcurrency, 8)
    this.recentIntelConcurrency = positiveConcurrency(options.recentIntelConcurrency, 2)
    this.maxRecentIntelSystems = positiveConcurrency(options.maxRecentIntelSystems, 16)
    this.recentIntelCacheTtlMs = nonNegativeFinite(
      options.recentIntelCacheTtlMs,
      10 * 60 * 1_000,
      'Killmail history TTL'
    )
    this.recentIntelForceRefreshCooldownMs = nonNegativeFinite(
      options.recentIntelForceRefreshCooldownMs,
      60 * 1_000,
      'Killmail history cooldown'
    )
    this.recentIntelErrorCacheTtlMs = nonNegativeFinite(
      options.recentIntelErrorCacheTtlMs,
      60 * 1_000,
      'Killmail history error TTL'
    )
    this.recentIntelCacheCapacity = positiveBoundedInteger(
      options.recentIntelCacheCapacity,
      1_024,
      10_000,
      'Killmail history cache size'
    )
  }

  async analyze(request: RouteIntelRequest): Promise<RouteIntelResult> {
    const validated = validateRouteIntelRequest(request)
    const evaluatedAt = this.now().toISOString()
    const [origin, destination] = await Promise.all([
      this.resolveEndpoint(validated.origin, request.origin, validated.forceRefresh),
      this.resolveEndpoint(validated.destination, request.destination, validated.forceRefresh)
    ])
    if (origin.id === destination.id) {
      throw new TypeError('Origin and destination systems are the same')
    }
    if (isWormholeSystemId(origin.id) || isWormholeSystemId(destination.id)) {
      throw new TypeError(
        'ESI cannot build a stargate route from or to a WH system. Specify a known exit to K-space.'
      )
    }

    const rawPath = await this.dependencies.getRouteSystems(
      origin.id,
      destination.id,
      validated.mode,
      validated.forceRefresh
    )
    const pathSnapshot = normalizePathSnapshot(rawPath)
    const systemIds = validateRouteSystemIds(
      pathSnapshot.systemIds,
      origin.id,
      destination.id
    )
    const warnings: string[] = [ROUTE_NOT_LIVE_LIMITATION]

    const [metadata, killsResult, jumpsResult] = await Promise.all([
      mapConcurrent(systemIds, this.metadataConcurrency, (systemId) =>
        this.loadMetadata(systemId, validated.forceRefresh)
      ),
      settle(this.dependencies.getSystemKills(validated.forceRefresh)),
      settle(this.dependencies.getSystemJumps(validated.forceRefresh))
    ])

    const kills = loadKillRows(killsResult, warnings)
    const jumps = loadJumpRows(jumpsResult, warnings)
    const recentIntel = await this.loadRecentIntel(
      systemIds,
      metadata,
      kills,
      validated.includeRecentPublicKillmails,
      validated.forceRefresh
    )
    if (recentIntel.candidateCount > recentIntel.checkedCount) {
      warnings.push(
        `zKill: checked ${recentIntel.checkedCount} of ${recentIntel.candidateCount} candidate systems; the cap protects the upstream from overload`
      )
    }
    const aggregateRetrievedAt = kills.available || jumps.available ? evaluatedAt : null

    const systems = systemIds.map((systemId, index): RouteSystemIntel => {
      const metadataResult = metadata[index] ?? { value: null, warning: null }
      const recentResult = recentIntel.rows[index] ?? {
        value: null,
        warning: null,
        checked: false
      }
      const systemWarnings: string[] = []
      if (metadataResult.warning) systemWarnings.push(metadataResult.warning)
      if (recentResult.warning) systemWarnings.push(recentResult.warning)
      if (recentResult.value?.warnings) systemWarnings.push(...recentResult.value.warnings)

      const metadataValue = metadataResult.value
      const isWormhole = metadataValue?.isWormhole ?? isWormholeSystemId(systemId)
      const killRow = kills.rows.get(systemId)
      const jumpRow = jumps.rows.get(systemId)
      const shipKills = isWormhole
        ? null
        : kills.available
          ? killRow?.shipKills ?? 0
          : null
      const podKills = isWormhole
        ? null
        : kills.available
          ? killRow?.podKills ?? 0
          : null
      const jumpCount = isWormhole
        ? null
        : jumps.available
          ? jumpRow?.jumps ?? 0
          : null
      const recentCount = recentResult.value?.count ?? null
      const recentWindow = recentResult.value?.windowHours ?? null
      const recentLastHour = recentResult.value?.lastHourCount ?? null
      const recentLastHourLowerBound =
        recentResult.value?.lastHourCountLowerBound === true
      const latestAt = normalizeTimestamp(recentResult.value?.latestAt)
      const freshness = recentResult.checked
        ? classifyRouteKillmailFreshness(latestAt, evaluatedAt)
        : { freshness: 'unknown' as const, ageMinutes: null }
      const risk = assessRouteSystemRisk({
        securityStatus: metadataValue?.securityStatus ?? null,
        isWormhole,
        shipKills,
        podKills,
        jumps: jumpCount,
        recentPublicKillmails: recentCount,
        recentKillmailWindowHours: recentWindow,
        recentPublicKillmailsLastHour: recentLastHour,
        recentPublicKillmailsLastHourLowerBound: recentLastHourLowerBound,
        latestPublicKillmailAgeMinutes: freshness.ageMinutes
      })

      return {
        index,
        systemId,
        name: metadataValue?.name ?? endpointName(systemId, origin, destination),
        securityStatus: metadataValue?.securityStatus ?? null,
        isWormhole,
        activity: {
          shipKills,
          podKills,
          jumps: jumpCount,
          recentPublicKillmails: recentCount,
          recentKillmailWindowHours: recentWindow,
          recentPublicKillmailsLastHour: recentLastHour,
          recentPublicKillmailsLastHourLowerBound: recentLastHourLowerBound,
          latestPublicKillmailAt: latestAt,
          latestPublicKillmailAgeMinutes: freshness.ageMinutes,
          killmailFreshness: freshness.freshness,
          recentIntelChecked: recentResult.checked,
          aggregateRetrievedAt,
          killsSourceAt: kills.sourceAt,
          jumpsSourceAt: jumps.sourceAt,
          recentIntelSourceAt: normalizeTimestamp(recentResult.value?.fetchedAt),
          aggregateCached: combineCacheState(kills.cached, jumps.cached),
          recentIntelCached: typeof recentResult.value?.cached === 'boolean'
            ? recentResult.value.cached
            : null,
          access: 'public',
          temporal: 'historical'
        },
        risk,
        warnings: uniqueStrings(systemWarnings)
      }
    })

    for (const system of systems) {
      for (const warning of system.warnings) {
        warnings.push(`${system.name ?? system.systemId}: ${warning}`)
      }
    }
    if (pathSnapshot.fetchedAt && normalizeTimestamp(pathSnapshot.fetchedAt) === null) {
      warnings.push('Route source returned an invalid timestamp')
    }

    const summary = summarizeRoute(systems)
    const corridorAlerts = buildRouteCorridorAlerts(systems)
    return {
      request: { origin, destination, mode: validated.mode },
      systems,
      summary,
      corridorAlerts,
      hauling: validated.hauling
        ? estimateRouteHauling(validated.hauling, summary.jumps)
        : null,
      evaluatedAt,
      confidence: summary.confidence,
      warnings: uniqueStrings(warnings),
      sourceTimestamps: {
        route: normalizeTimestamp(pathSnapshot.fetchedAt),
        systemKills: kills.sourceAt,
        systemJumps: jumps.sourceAt
      },
      sourceCache: {
        route: typeof pathSnapshot.cached === 'boolean' ? pathSnapshot.cached : null,
        systemKills: kills.cached,
        systemJumps: jumps.cached
      },
      provenance: {
        route: 'public-planning',
        activity: 'public-historical-aggregate',
        recentKillmails: 'optional-public-historical',
        liveCampDetection: false
      }
    }
  }

  private async resolveEndpoint(
    endpoint: NormalizedRouteEndpoint,
    input: string | number,
    forceRefresh: boolean
  ): Promise<ResolvedRouteEndpoint> {
    if (endpoint.kind === 'id') {
      return { id: endpoint.value as number, name: null, input }
    }

    const name = endpoint.value as string
    const resolved = await this.dependencies.resolveSolarSystemId(name, forceRefresh)
    if (!resolved) throw new TypeError(`Solar system not found: ${name}`)
    if (!Number.isSafeInteger(resolved.id) || resolved.id <= 0 ||
        typeof resolved.name !== 'string' || resolved.name.trim() === '') {
      throw new TypeError(`Source returned an invalid system for: ${name}`)
    }
    return { id: resolved.id, name: resolved.name.trim(), input }
  }

  private async loadMetadata(
    systemId: number,
    forceRefresh: boolean
  ): Promise<LoadedMetadata> {
    try {
      const value = await this.dependencies.getSystemMetadata(systemId, forceRefresh)
      if (value.id !== systemId || typeof value.name !== 'string' || value.name.trim() === '' ||
          !Number.isFinite(value.securityStatus) ||
          value.securityStatus < -1 || value.securityStatus > 1) {
        return { value: null, warning: 'system metadata is invalid' }
      }
      return {
        value: { ...value, name: value.name.trim() },
        warning: null
      }
    } catch (error) {
      return {
        value: null,
        warning: `system metadata unavailable (${messageOf(error)})`
      }
    }
  }

  private async loadRecentIntel(
    systemIds: readonly number[],
    metadata: readonly LoadedMetadata[],
    kills: LoadedRows<RouteSystemKillRow>,
    include: boolean,
    forceRefresh: boolean
  ): Promise<LoadedRecentIntelBatch> {
    const emptyRows = (): LoadedRecentIntel[] =>
      systemIds.map(() => ({ value: null, warning: null, checked: false }))
    if (!include || !this.dependencies.systemIntel) {
      return { rows: emptyRows(), candidateCount: 0, checkedCount: 0 }
    }

    const candidates = selectRecentIntelCandidates(systemIds, metadata, kills)
    const selected = candidates.slice(0, this.maxRecentIntelSystems)
    const loaded = await mapConcurrent(selected, this.recentIntelConcurrency, async ({ systemId }) => {
      const nowMs = this.now().getTime()
      const cached = this.readRecentIntelCache(systemId)
      const cacheAge = cached ? Math.max(0, nowMs - cached.loadedAt) : Number.POSITIVE_INFINITY
      const failureAge = cached?.failedAt === null || cached?.failedAt === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, nowMs - cached.failedAt)
      const failureCoolingDown = cached !== undefined && cached.failedAt !== null &&
        failureAge < this.recentIntelErrorCacheTtlMs
      const successfulValueReusable = cached !== undefined && cached.failedAt === null &&
        (forceRefresh
          ? cacheAge < this.recentIntelForceRefreshCooldownMs
          : cacheAge < this.recentIntelCacheTtlMs)
      const canReuse = failureCoolingDown || successfulValueReusable
      if (canReuse && cached) {
        return {
          systemId,
          loaded: {
            value: cached.value ? { ...cached.value, cached: true } : null,
            warning: cached.warning,
            checked: true
          } satisfies LoadedRecentIntel
        }
      }

      const rememberFailure = (warning: string): {
        systemId: number
        loaded: LoadedRecentIntel
      } => {
        const entry: RecentIntelCacheEntry = {
          value: cached?.value ?? null,
          loadedAt: cached?.loadedAt ?? nowMs,
          failedAt: nowMs,
          warning
        }
        this.writeRecentIntelCache(systemId, entry)
        return {
          systemId,
          loaded: {
            value: entry.value ? { ...entry.value, cached: true } : null,
            warning,
            checked: true
          }
        }
      }

      try {
        const value = await this.dependencies.systemIntel?.lookupSystemIntel(
          systemId,
          // Route memory cache owns freshness. Bypass the generic one-hour zKill cache
          // only when this bounded candidate set is actually due for refresh.
          true
        ) ?? null
        if (value === null) {
          this.writeRecentIntelCache(systemId, {
            value: null,
            loadedAt: nowMs,
            failedAt: null,
            warning: null
          })
          return {
            systemId,
            loaded: { value: null, warning: null, checked: true } satisfies LoadedRecentIntel
          }
        }
        if ((value.count !== null &&
            (!Number.isSafeInteger(value.count) || value.count < 0)) ||
            !Number.isFinite(value.windowHours) || value.windowHours <= 0 ||
            (value.lastHourCount !== undefined && value.lastHourCount !== null &&
              (!Number.isSafeInteger(value.lastHourCount) || value.lastHourCount < 0))) {
          return rememberFailure(cached?.value
          ? 'killmail history returned invalid data; last cache shown'
          : 'killmail history returned invalid data')
        }
        const latestAt = normalizeTimestamp(value.latestAt)
        const timestampWarning = value.latestAt !== null && value.latestAt !== undefined &&
          latestAt === null
          ? 'killmail history returned invalid latest-fight time'
          : null
        const normalized: RouteRecentPublicKillmailSnapshot = {
          ...value,
          latestAt,
          warnings: value.warnings ? [...value.warnings] : undefined
        }
        this.writeRecentIntelCache(systemId, {
          value: normalized,
          loadedAt: nowMs,
          failedAt: timestampWarning ? nowMs : null,
          warning: timestampWarning
        })
        return {
          systemId,
          loaded: {
            value: normalized,
            warning: timestampWarning,
            checked: true
          } satisfies LoadedRecentIntel
        }
      } catch (error) {
        return rememberFailure(cached?.value
          ? `killmail history not refreshed; last cache shown (${messageOf(error)})`
          : `killmail history unavailable (${messageOf(error)})`)
      }
    })

    const bySystem = new Map(loaded.map(({ systemId, loaded: row }) => [systemId, row]))
    return {
      rows: systemIds.map((systemId) =>
        bySystem.get(systemId) ?? { value: null, warning: null, checked: false }
      ),
      candidateCount: candidates.length,
      checkedCount: selected.length
    }
  }

  private readRecentIntelCache(systemId: number): RecentIntelCacheEntry | undefined {
    const entry = this.recentIntelCache.get(systemId)
    if (!entry) return undefined
    // Refresh insertion order so the bounded Map behaves as an LRU cache.
    this.recentIntelCache.delete(systemId)
    this.recentIntelCache.set(systemId, entry)
    return entry
  }

  private writeRecentIntelCache(systemId: number, entry: RecentIntelCacheEntry): void {
    this.recentIntelCache.delete(systemId)
    this.recentIntelCache.set(systemId, entry)
    while (this.recentIntelCache.size > this.recentIntelCacheCapacity) {
      const oldestSystemId = this.recentIntelCache.keys().next().value as number | undefined
      if (oldestSystemId === undefined) break
      this.recentIntelCache.delete(oldestSystemId)
    }
  }
}

function normalizePathSnapshot(
  raw: RoutePathSnapshot | readonly number[]
): RoutePathSnapshot {
  if (isNumberArray(raw)) return { systemIds: raw }
  return {
    systemIds: raw.systemIds,
    fetchedAt: raw.fetchedAt,
    cached: raw.cached
  }
}

function isNumberArray(
  value: RoutePathSnapshot | readonly number[]
): value is readonly number[] {
  return Array.isArray(value)
}

function loadKillRows(
  result: PromiseSettledResult<RouteRowsSnapshot<RouteSystemKillRow>>,
  warnings: string[]
): LoadedRows<RouteSystemKillRow> {
  if (result.status === 'rejected') {
    warnings.push(`ESI: hourly losses unavailable (${messageOf(result.reason)})`)
    return unavailableRows()
  }
  const rows = new Map<number, RouteSystemKillRow>()
  let invalid = 0
  for (const row of result.value.rows) {
    if (!positiveId(row?.solarSystemId) ||
        !nonNegativeInteger(row?.shipKills) || !nonNegativeInteger(row?.podKills)) {
      invalid += 1
      continue
    }
    rows.set(row.solarSystemId, {
      solarSystemId: row.solarSystemId,
      shipKills: row.shipKills,
      podKills: row.podKills
    })
  }
  if (invalid > 0) warnings.push(`ESI: loss rows skipped: ${invalid}`)
  return {
    available: true,
    rows,
    sourceAt: normalizeTimestamp(result.value.fetchedAt),
    cached: typeof result.value.cached === 'boolean' ? result.value.cached : null
  }
}

function loadJumpRows(
  result: PromiseSettledResult<RouteRowsSnapshot<RouteSystemJumpRow>>,
  warnings: string[]
): LoadedRows<RouteSystemJumpRow> {
  if (result.status === 'rejected') {
    warnings.push(`ESI: hourly jumps unavailable (${messageOf(result.reason)})`)
    return unavailableRows()
  }
  const rows = new Map<number, RouteSystemJumpRow>()
  let invalid = 0
  for (const row of result.value.rows) {
    if (!positiveId(row?.solarSystemId) || !nonNegativeInteger(row?.jumps)) {
      invalid += 1
      continue
    }
    rows.set(row.solarSystemId, {
      solarSystemId: row.solarSystemId,
      jumps: row.jumps
    })
  }
  if (invalid > 0) warnings.push(`ESI: jump rows skipped: ${invalid}`)
  return {
    available: true,
    rows,
    sourceAt: normalizeTimestamp(result.value.fetchedAt),
    cached: typeof result.value.cached === 'boolean' ? result.value.cached : null
  }
}

function unavailableRows<T>(): LoadedRows<T> {
  return { available: false, rows: new Map(), sourceAt: null, cached: null }
}

function endpointName(
  systemId: number,
  origin: ResolvedRouteEndpoint,
  destination: ResolvedRouteEndpoint
): string | null {
  if (systemId === origin.id) return origin.name
  if (systemId === destination.id) return destination.name
  return null
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}

function combineCacheState(
  left: boolean | null,
  right: boolean | null
): boolean | null {
  if (left === null && right === null) return null
  if (left === false || right === false) return false
  if (left === true && right === true) return true
  return null
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function positiveConcurrency(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Concurrency must be a positive whole number')
  }
  return value
}

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string
): number {
  const normalized = value ?? fallback
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > maximum) {
    throw new RangeError(`${label} must be a whole number from 1 to ${maximum}`)
  }
  return normalized
}

function nonNegativeFinite(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const normalized = value ?? fallback
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be finite and non-negative`)
  }
  return normalized
}

function positiveFinite(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive finite number`)
  }
  return normalized
}

function selectRecentIntelCandidates(
  systemIds: readonly number[],
  metadata: readonly LoadedMetadata[],
  kills: LoadedRows<RouteSystemKillRow>
): Array<{ systemId: number; score: number; index: number }> {
  return systemIds.flatMap((systemId, index) => {
    if (index === 0) return []
    const system = metadata[index]?.value ?? null
    if (system?.isWormhole === true || isWormholeSystemId(systemId)) return []
    const killRow = kills.rows.get(systemId)
    const shipKills = kills.available ? killRow?.shipKills ?? 0 : 0
    const podKills = kills.available ? killRow?.podKills ?? 0 : 0
    const losses = shipKills + podKills
    const securityStatus = system?.securityStatus ?? null

    // A bounded candidate set is intentional: query every system on a 40-jump
    // route would abuse zKill and then hydrate stale evidence too slowly to help.
    if (losses === 0 && securityStatus !== null && securityStatus >= 0.5) return []
    const securityPriority = securityStatus === null
      ? 100
      : securityStatus < 0
        ? 400
        : securityStatus < 0.5
          ? 250
          : 0
    return [{
      systemId,
      index,
      score: podKills * 2_000 + shipKills * 1_000 + securityPriority +
        (index === systemIds.length - 1 ? 500 : 0)
    }]
  }).sort((left, right) => right.score - left.score || left.index - right.index)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null
}

function compactKillmailReference(
  record: Record<string, unknown> | null
): { killmailId: number; hash: string } | null {
  if (!record) return null
  const killmailId = positiveInteger(record.killmail_id)
  const zkb = asRecord(record.zkb)
  const hash = zkb?.hash
  if (killmailId === null || typeof hash !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(hash)) return null
  return { killmailId, hash }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))]
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'unknown error'
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await promise }
  } catch (reason) {
    return { status: 'rejected', reason }
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(values[index] as T, index)
      }
    }
  )
  await Promise.all(workers)
  return results
}
