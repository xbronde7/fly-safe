import {
  buildParsedSystemHistoryFacts,
  calculateSystemDanger,
  collectSystemKillmailNameIds,
  isWormholeSystemId,
  parseSystemKillmail,
  type ParsedSystemKillmail
} from '../shared/system-intel'
import type {
  SystemIntel,
  SystemIntelRequest,
  SystemLastHourActivity,
  SystemMetadata,
  SystemZkillHistory
} from '../shared/types'
import { Cache } from './cache'
import {
  EsiClient,
  type EsiClientOptions,
  type EsiConstellation,
  type EsiRegion,
  type EsiSystemJumpsResult,
  type EsiSystemKillsResult,
  type UniverseName
} from './esi-client'
import {
  ZkillClient,
  type ZkillClientOptions,
  type ZkillSystemHistoryResult
} from './zkill-client'

export interface SystemIntelServiceOptions {
  cache?: Cache
  esiClient?: EsiClient
  zkillClient?: ZkillClient
  esi?: EsiClientOptions
  zkill?: ZkillClientOptions
  now?: () => Date
}

interface HierarchyResult {
  constellation: EsiConstellation | null
  region: EsiRegion | null
  cached: boolean
}

interface HydratedKillmails {
  killmails: unknown[]
  cached: boolean
}

/** Builds source-labelled public, historical intelligence for one solar system. */
export class SystemIntelService {
  private readonly cache: Cache
  private readonly esi: EsiClient
  private readonly zkill: ZkillClient
  private readonly ownsCache: boolean
  private readonly now: () => Date

  constructor(databasePath: string, options: SystemIntelServiceOptions = {}) {
    this.ownsCache = options.cache === undefined
    this.cache = options.cache ?? new Cache(databasePath)
    this.esi = options.esiClient ?? new EsiClient(this.cache, options.esi)
    this.zkill = options.zkillClient ?? new ZkillClient(this.cache, options.zkill)
    this.now = options.now ?? (() => new Date())
  }

  async getSystemIntel(request: SystemIntelRequest | number): Promise<SystemIntel> {
    const normalized: SystemIntelRequest =
      typeof request === 'number' ? { solarSystemId: request } : request
    const solarSystemId = normalized.solarSystemId
    if (!Number.isSafeInteger(solarSystemId) || solarSystemId <= 0) {
      throw new TypeError('Invalid solar-system ID')
    }
    const forceRefresh = normalized.forceRefresh ?? false
    const warnings: string[] = []

    // A valid system record is essential; unlike optional activity feeds, failure propagates.
    const system = await this.esi.getSolarSystem(solarSystemId, forceRefresh)
    const isWormhole = isWormholeSystemId(solarSystemId)

    const hierarchyPromise = this.getHierarchy(
      system.constellationId,
      forceRefresh,
      warnings
    )
    const killsPromise: Promise<PromiseSettledResult<EsiSystemKillsResult>> = isWormhole
      ? Promise.resolve({ status: 'rejected', reason: 'wormhole' })
      : settle(this.esi.getSystemKills(forceRefresh))
    const jumpsPromise: Promise<PromiseSettledResult<EsiSystemJumpsResult>> = isWormhole
      ? Promise.resolve({ status: 'rejected', reason: 'wormhole' })
      : settle(this.esi.getSystemJumps(forceRefresh))
    const zkillPromise = settle(this.zkill.getSystemHistory(solarSystemId, forceRefresh))

    const [hierarchy, killsSettled, jumpsSettled, zkillSettled] = await Promise.all([
      hierarchyPromise,
      killsPromise,
      jumpsPromise,
      zkillPromise
    ])
    const metadata: SystemMetadata = {
      id: system.id,
      name: system.name,
      securityStatus: system.securityStatus,
      securityClass: system.securityClass,
      constellationId: system.constellationId,
      constellationName: hierarchy.constellation?.name ?? null,
      regionId: hierarchy.constellation?.regionId ?? null,
      regionName: hierarchy.region?.name ?? null,
      isWormhole
    }
    const activityResult = makeLastHourActivity(
      solarSystemId,
      isWormhole,
      killsSettled,
      jumpsSettled,
      warnings
    )
    const historyResult = await this.makeHistory(
      solarSystemId,
      zkillSettled,
      forceRefresh,
      warnings
    )
    const danger = calculateSystemDanger({
      securityStatus: metadata.securityStatus,
      isWormhole,
      shipKills: activityResult.activity.shipKills,
      podKills: activityResult.activity.podKills,
      jumps: activityResult.activity.jumps,
      zkill24hCount: historyResult.history.count
    })

    return {
      system: metadata,
      lastHour: activityResult.activity,
      zkill24h: historyResult.history,
      danger,
      fetchedAt: this.now().toISOString(),
      cached:
        system.cached &&
        hierarchy.cached &&
        activityResult.cached &&
        historyResult.cached,
      warnings,
      provenance: {
        access: 'public',
        temporal: 'historical',
        liveRosterAvailable: false
      }
    }
  }

  /** Lightweight public-history adapter shared with Camp Radar to preserve one zKill pacer. */
  getSystemHistory(
    solarSystemId: number,
    forceRefresh = false
  ): Promise<ZkillSystemHistoryResult> {
    return this.zkill.getSystemHistory(solarSystemId, forceRefresh)
  }

  /** Immutable ESI killmail hydration used only for the newest route reference. */
  getPublicKillmail(
    killmailId: number,
    hash: string,
    forceRefresh = false
  ): ReturnType<EsiClient['getPublicKillmail']> {
    return this.esi.getPublicKillmail(killmailId, hash, forceRefresh)
  }

  /** Alias useful to coordinators that expose analyze-style service methods. */
  async analyze(request: SystemIntelRequest | number): Promise<SystemIntel> {
    return this.getSystemIntel(request)
  }

  clearCache(): void {
    this.cache.clear()
  }

  close(): void {
    if (this.ownsCache) this.cache.close()
  }

  private async getHierarchy(
    constellationId: number,
    forceRefresh: boolean,
    warnings: string[]
  ): Promise<HierarchyResult> {
    let constellation: EsiConstellation
    try {
      constellation = await this.esi.getConstellation(constellationId, forceRefresh)
    } catch (error) {
      warnings.push(`ESI: constellation unavailable (${messageOf(error)})`)
      return { constellation: null, region: null, cached: false }
    }

    try {
      const region = await this.esi.getRegion(constellation.regionId, forceRefresh)
      return {
        constellation,
        region,
        cached: constellation.cached && region.cached
      }
    } catch (error) {
      warnings.push(`ESI: region unavailable (${messageOf(error)})`)
      return { constellation, region: null, cached: false }
    }
  }

  private async makeHistory(
    solarSystemId: number,
    result: PromiseSettledResult<ZkillSystemHistoryResult>,
    forceRefresh: boolean,
    warnings: string[]
  ): Promise<{ history: SystemZkillHistory; cached: boolean }> {
    if (result.status === 'rejected') {
      warnings.push(`zKill: system history unavailable (${messageOf(result.reason)})`)
      return {
        history: emptyHistory(null),
        cached: false
      }
    }

    const hydrated = await this.hydrateKillmails(result.value.killmails, forceRefresh, warnings)
    const parsed = hydrated.killmails.flatMap((raw): ParsedSystemKillmail[] => {
      const killmail = parseSystemKillmail(raw, solarSystemId)
      return killmail ? [killmail] : []
    })
    const invalidCount = hydrated.killmails.length - parsed.length
    if (invalidCount > 0) warnings.push(`zKill: incomplete killmails skipped: ${invalidCount}`)

    const ids = collectSystemKillmailNameIds(parsed)
    let resolvedNames: UniverseName[] = []
    let namesCached = true
    if (ids.length > 0) {
      try {
        resolvedNames = await this.esi.getUniverseNames(ids, forceRefresh)
        namesCached = resolvedNames.length === ids.length && resolvedNames.every((item) => item.cached)
        if (resolvedNames.length !== ids.length) {
          warnings.push(`ESI: history names incomplete: ${resolvedNames.length}/${ids.length}`)
        }
      } catch (error) {
        namesCached = false
        warnings.push(`ESI: ship and pilot names unavailable (${messageOf(error)})`)
      }
    }
    const names = new Map(resolvedNames.map(({ id, name }) => [id, name]))
    const facts = buildParsedSystemHistoryFacts(parsed, names, invalidCount)

    return {
      history: {
        count: facts.count,
        latest: facts.latest,
        sourceCapped: facts.sourceCapped,
        latestCapped: facts.latestCapped,
        capped: facts.capped,
        observedShips: facts.observedShips,
        observedShipsCapped: facts.observedShipsCapped,
        observedPilots: facts.observedPilots,
        observedPilotsCapped: facts.observedPilotsCapped,
        source: 'zKillboard',
        access: 'public',
        temporal: 'historical'
      },
      cached: result.value.cached && hydrated.cached && namesCached
    }
  }

  private async hydrateKillmails(
    rawKillmails: readonly unknown[],
    forceRefresh: boolean,
    warnings: string[]
  ): Promise<HydratedKillmails> {
    let allCached = true
    const killmails = await mapConcurrent(rawKillmails, 3, async (raw) => {
      if (hasFullVictim(raw)) return raw
      const reference = killmailReference(raw)
      if (!reference) return raw

      try {
        const result = await this.esi.getPublicKillmail(
          reference.killmailId,
          reference.hash,
          forceRefresh
        )
        if (!result.cached) allCached = false
        return mergeZkillMetadata(result.killmail, raw)
      } catch (error) {
        allCached = false
        warnings.push(`Killmail ${reference.killmailId}: ${messageOf(error)}`)
        return raw
      }
    })
    return { killmails, cached: allCached }
  }
}

function makeLastHourActivity(
  solarSystemId: number,
  isWormhole: boolean,
  killsResult: PromiseSettledResult<EsiSystemKillsResult>,
  jumpsResult: PromiseSettledResult<EsiSystemJumpsResult>,
  warnings: string[]
): { activity: SystemLastHourActivity; cached: boolean } {
  if (isWormhole) {
    return {
      activity: historicalActivity(null, null, null, null),
      cached: true
    }
  }

  let shipKills: number | null = null
  let podKills: number | null = null
  let npcKills: number | null = null
  let jumps: number | null = null
  let killsCached = false
  let jumpsCached = false

  if (killsResult.status === 'fulfilled') {
    const row = killsResult.value.rows.find((item) => item.solarSystemId === solarSystemId)
    shipKills = row?.shipKills ?? 0
    podKills = row?.podKills ?? 0
    npcKills = row?.npcKills ?? 0
    killsCached = killsResult.value.cached
  } else {
    warnings.push(`ESI: kills per hour unavailable (${messageOf(killsResult.reason)})`)
  }

  if (jumpsResult.status === 'fulfilled') {
    const row = jumpsResult.value.rows.find((item) => item.solarSystemId === solarSystemId)
    jumps = row?.jumps ?? 0
    jumpsCached = jumpsResult.value.cached
  } else {
    warnings.push(`ESI: jumps per hour unavailable (${messageOf(jumpsResult.reason)})`)
  }

  return {
    activity: historicalActivity(shipKills, podKills, npcKills, jumps),
    cached: killsCached && jumpsCached
  }
}

function historicalActivity(
  shipKills: number | null,
  podKills: number | null,
  npcKills: number | null,
  jumps: number | null
): SystemLastHourActivity {
  return {
    shipKills,
    podKills,
    npcKills,
    jumps,
    source: 'ESI',
    access: 'public',
    temporal: 'historical'
  }
}

function emptyHistory(count: number | null): SystemZkillHistory {
  return {
    count,
    latest: [],
    sourceCapped: false,
    latestCapped: false,
    capped: false,
    observedShips: [],
    observedShipsCapped: false,
    observedPilots: [],
    observedPilotsCapped: false,
    source: 'zKillboard',
    access: 'public',
    temporal: 'historical'
  }
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason })
  )
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function hasFullVictim(raw: unknown): boolean {
  const killmail = asRecord(raw)
  const victim = killmail ? asRecord(killmail.victim) : null
  return victim !== null && positiveInteger(victim.ship_type_id) !== null
}

function killmailReference(raw: unknown): { killmailId: number; hash: string } | null {
  const killmail = asRecord(raw)
  const zkb = killmail ? asRecord(killmail.zkb) : null
  const killmailId = killmail ? positiveInteger(killmail.killmail_id) : null
  const hash = zkb?.hash
  if (killmailId === null || typeof hash !== 'string' || !/^[a-f0-9]{40}$/i.test(hash)) {
    return null
  }
  return { killmailId, hash }
}

function mergeZkillMetadata(killmail: unknown, zkillRecord: unknown): unknown {
  const hydrated = asRecord(killmail)
  const source = asRecord(zkillRecord)
  if (!hydrated || !source) return killmail
  return source.zkb === undefined ? hydrated : { ...hydrated, zkb: source.zkb }
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= items.length) return
        results[index] = await worker(items[index])
      }
    }
  )
  await Promise.all(runners)
  return results
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
