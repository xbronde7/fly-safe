import { parseLocalRoster } from '../shared/local-parser'
import { collectKillmailTypeIds, parseVictimFit } from '../shared/killmail-fit'
import { calculateThreat } from '../shared/threat-score'
import { buildRecentTargetProfile } from '../shared/target-profile'
import type {
  CombatHistoryAttacker,
  CombatHistoryEntry,
  CombatHistoryKind,
  CombatHistoryPageInfo,
  CombatHistoryRequest,
  CorporationGroup,
  PilotCombatHistory,
  PilotIntel,
  PilotIntelRequest,
  RecentTargetProfileRequest,
  RecentTargetProfileSnapshot,
  ScanProgress,
  ScanRequest,
  ScanResult
} from '../shared/types'
import { Cache, type CacheStats } from './cache'
import {
  EsiClient,
  type CharacterAffiliation,
  type CharacterResolution,
  type EsiClientOptions,
  type EsiUniverseType,
  type UniverseName
} from './esi-client'
import {
  ZkillClient,
  ZKILL_HISTORY_PAGE_SIZE,
  type ZkillHistoryResult,
  type ZkillClientOptions,
  type ZkillStatsResult
} from './zkill-client'

export type ScanProgressCallback = (progress: ScanProgress) => void

const MAX_COMBAT_HISTORY_ATTACKERS = 200
const INITIAL_COMBAT_HISTORY_LIMIT = 10
const COMBAT_HISTORY_LOAD_MORE_LIMIT = 50
const MAX_COMBAT_HISTORY_OFFSET = 1_950
const MAX_COMBAT_HISTORY_PAGES = 10

interface CombatHistoryWindow {
  characterId: number
  kind: 'kills' | 'losses'
  killmails: unknown[]
  cached: boolean
  offset: number
  limit: number
  nextOffset: number
  hasMore: boolean
  capped: boolean
}

interface UniverseTypeMetadataResult {
  byId: Map<number, EsiUniverseType>
  failedTypeIds: number[]
}

export interface IntelServiceOptions {
  cache?: Cache
  esiClient?: EsiClient
  zkillClient?: ZkillClient
  esi?: EsiClientOptions
  zkill?: ZkillClientOptions
}

/** Coordinates parsing, public ESI enrichment, zKill stats, scoring, and summaries. */
export class IntelService {
  private readonly cache: Cache
  private readonly esi: EsiClient
  private readonly zkill: ZkillClient
  private readonly ownsCache: boolean

  constructor(databasePath: string, options: IntelServiceOptions = {}) {
    this.ownsCache = options.cache === undefined
    this.cache = options.cache ?? new Cache(databasePath)
    this.esi = options.esiClient ?? new EsiClient(this.cache, options.esi)
    this.zkill = options.zkillClient ?? new ZkillClient(this.cache, options.zkill)
  }

  async analyze(
    request: ScanRequest | string,
    onProgress?: ScanProgressCallback,
    forceRefreshForRawText = false
  ): Promise<ScanResult> {
    const startedAt = Date.now()
    const normalizedRequest: ScanRequest =
      typeof request === 'string'
        ? { rawText: request, forceRefresh: forceRefreshForRawText }
        : request
    const forceRefresh = normalizedRequest.forceRefresh ?? false
    const preview = parseLocalRoster(normalizedRequest.rawText)
    const names = preview.names
    const warnings: string[] = []
    let completed = 0

    if (preview.rejected > 0) {
      warnings.push(`Rows skipped because they do not look like pilot names: ${preview.rejected}`)
    }

    reportProgress(onProgress, { completed: 0, total: names.length, currentName: null })

    if (names.length === 0) {
      return emptyResult(startedAt, warnings)
    }

    let resolutions: CharacterResolution[]
    try {
      resolutions = await this.esi.resolveCharacterIds(names, forceRefresh)
    } catch (error) {
      warnings.push(`ESI: could not resolve pilots (${messageOf(error)})`)
      for (const name of names) {
        completed += 1
        reportProgress(onProgress, {
          completed,
          total: names.length,
          currentName: name
        })
      }
      return makeResult(startedAt, [], names, warnings)
    }

    const unresolvedNames = resolutions
      .filter((resolution) => resolution.character === null)
      .map((resolution) => resolution.inputName)
    const resolved = resolutions.filter(
      (resolution): resolution is CharacterResolution & {
        character: NonNullable<CharacterResolution['character']>
      } => resolution.character !== null
    )

    if (unresolvedNames.length > 0) {
      warnings.push(`ESI found no pilots: ${unresolvedNames.length}`)
      for (const name of unresolvedNames) {
        completed += 1
        reportProgress(onProgress, {
          completed,
          total: names.length,
          currentName: name
        })
      }
    }

    const characterIds = resolved.map((item) => item.character.id)
    let affiliations: CharacterAffiliation[] = []
    try {
      affiliations = await this.esi.getAffiliations(characterIds, forceRefresh)
      if (affiliations.length !== characterIds.length) {
        warnings.push(
          `ESI returned incomplete corporation data: ${affiliations.length}/${characterIds.length}`
        )
      }
    } catch (error) {
      warnings.push(`ESI: corporations unavailable (${messageOf(error)})`)
    }

    const affiliationByCharacter = new Map(
      affiliations.map((affiliation) => [affiliation.characterId, affiliation])
    )
    const organizationIds = [
      ...new Set(
        affiliations.flatMap((affiliation) => [
          affiliation.corporationId,
          ...(affiliation.allianceId === null ? [] : [affiliation.allianceId])
        ])
      )
    ]

    let universeNames: UniverseName[] = []
    if (organizationIds.length > 0) {
      try {
        universeNames = await this.esi.getUniverseNames(organizationIds, forceRefresh)
      } catch (error) {
      warnings.push(`ESI: corporation names unavailable (${messageOf(error)})`)
      }
    }
    const universeNameById = new Map(universeNames.map((item) => [item.id, item]))
    const resolutionByCharacterId = new Map(
      resolved.map((resolution) => [resolution.character.id, resolution])
    )
    const makePilot = (
      resolution: (typeof resolved)[number],
      statsResult: ZkillStatsResult
    ): PilotIntel => {
      const character = resolution.character
      const affiliation = affiliationByCharacter.get(character.id)
      const corporation = affiliation
        ? universeNameById.get(affiliation.corporationId)
        : undefined
      const alliance =
        affiliation?.allianceId === null || affiliation?.allianceId === undefined
          ? undefined
          : universeNameById.get(affiliation.allianceId)
      const threat = calculateThreat(statsResult.stats)
      const cached =
        resolution.cached &&
        (affiliation?.cached ?? false) &&
        (corporation?.cached ?? false) &&
        (affiliation?.allianceId === null || (alliance?.cached ?? false)) &&
        statsResult.cached

      return {
        id: character.id,
        name: character.name,
        corporationId: affiliation?.corporationId ?? null,
        corporationName: corporation?.name ?? null,
        allianceId: affiliation?.allianceId ?? null,
        allianceName: alliance?.name ?? null,
        factionId: affiliation?.factionId ?? null,
        stats: statsResult.stats,
        threatScore: threat.score,
        threatLevel: threat.level,
        reasons: threat.reasons,
        zkillUrl: `https://zkillboard.com/character/${character.id}/`,
        cached,
        error: statsResult.error
      }
    }

    const statsResults = await this.zkill.getStatsForCharacters(
      characterIds,
      forceRefresh,
      (result) => {
        completed += 1
        const resolution = resolutionByCharacterId.get(result.characterId)
        const readyPilot = resolution ? makePilot(resolution, result) : undefined
        reportProgress(onProgress, {
          completed,
          total: names.length,
          currentName: resolution?.character.name ?? resolution?.inputName ?? null,
          ...(readyPilot ? { readyPilot } : {})
        })
      }
    )
    const statsByCharacter = new Map(
      statsResults.map((result) => [result.characterId, result])
    )

    const failedStats = statsResults.filter((result) => result.error !== null).length
    if (failedStats > 0) {
      warnings.push(`zKill: statistics unavailable for pilots: ${failedStats}`)
    }

    const pilots = resolved.map((resolution): PilotIntel => makePilot(
      resolution,
      statsByCharacter.get(resolution.character.id) ?? missingStats(resolution.character.id)
    ))

    pilots.sort(
      (left, right) =>
        right.threatScore - left.threatScore || left.name.localeCompare(right.name)
    )

    return makeResult(startedAt, pilots, unresolvedNames, warnings)
  }

  async getCombatHistory(request: CombatHistoryRequest): Promise<PilotCombatHistory> {
    const characterId = request.characterId
    if (!Number.isSafeInteger(characterId) || characterId <= 0) {
      throw new TypeError('Invalid pilot ID')
    }
    const requestedKind = request.kind
    if (requestedKind !== undefined && requestedKind !== 'kill' && requestedKind !== 'loss') {
      throw new TypeError('Invalid battle-history type')
    }
    const maximumLimit = requestedKind === undefined
      ? INITIAL_COMBAT_HISTORY_LIMIT
      : COMBAT_HISTORY_LOAD_MORE_LIMIT
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > maximumLimit)
    ) {
      throw new RangeError(requestedKind === undefined
        ? 'From 1 to 10 battles of each type are allowed'
        : 'You can load from 1 to 50 battles at a time')
    }
    if (
      request.offset !== undefined &&
      (!Number.isSafeInteger(request.offset) || request.offset < 0 ||
        request.offset > MAX_COMBAT_HISTORY_OFFSET)
    ) {
      throw new RangeError('Invalid battle-history offset')
    }
    if (requestedKind === undefined && request.offset !== undefined && request.offset !== 0) {
      throw new RangeError('Offset is allowed only when loading one battle type')
    }
    const limit = request.limit ?? (requestedKind === undefined ? 5 : COMBAT_HISTORY_LOAD_MORE_LIMIT)
    const offset = requestedKind === undefined ? 0 : (request.offset ?? 0)
    const forceRefresh = request.forceRefresh ?? false
    const warnings: string[] = []

    const requestedKinds: Array<'kills' | 'losses'> = requestedKind === 'kill'
      ? ['kills']
      : requestedKind === 'loss'
        ? ['losses']
        : ['kills', 'losses']
    const settledWindows = await Promise.allSettled(requestedKinds.map((kind) => (
      this.loadCombatHistoryWindow(characterId, kind, offset, limit, forceRefresh)
    )))
    const windows = new Map<'kills' | 'losses', CombatHistoryWindow>()
    requestedKinds.forEach((kind, index) => {
      const result = settledWindows[index]
      if (result.status === 'fulfilled') {
        windows.set(kind, result.value)
        return
      }
      if (requestedKind !== undefined) throw result.reason
      warnings.push(`zKill ${kind}: ${messageOf(result.reason)}`)
      windows.set(kind, emptyCombatHistoryWindow(characterId, kind, offset, limit))
    })

    const killsResult = windows.get('kills')
    const lossesResult = windows.get('losses')
    const killsHydrated = await this.hydrateKillmails(
      killsResult?.killmails ?? [],
      forceRefresh,
      warnings
    )
    const lossesHydrated = await this.hydrateKillmails(
      lossesResult?.killmails ?? [],
      forceRefresh,
      warnings
    )
    const rawKillmails = [...killsHydrated.killmails, ...lossesHydrated.killmails]
    const ids = collectHistoryNameIds(rawKillmails)

    let universeNames: UniverseName[] = []
    if (ids.length > 0) {
      try {
        universeNames = await this.esi.getUniverseNames(ids, forceRefresh)
      } catch (error) {
        warnings.push(`ESI: participant and fit names unavailable (${messageOf(error)})`)
      }
    }
    const names = new Map(universeNames.map(({ id, name }) => [id, name]))
    const victimTypeMetadata = await this.resolveUniverseTypeMetadata(
      collectVictimShipTypeIds(killsHydrated.killmails),
      forceRefresh
    )
    if (victimTypeMetadata.failedTypeIds.length > 0) {
      warnings.push(
        `ESI: victim hull groups unavailable: ${victimTypeMetadata.failedTypeIds.length}`
      )
    }
    const victimGroupIds = new Map(
      [...victimTypeMetadata.byId.values()].map(({ id, groupId }) => [id, groupId])
    )
    const kills = killsHydrated.killmails.flatMap((killmail) => {
      const entry = makeCombatHistoryEntry(
        killmail,
        'kill',
        characterId,
        names,
        victimGroupIds
      )
      return entry ? [entry] : []
    })
    const losses = lossesHydrated.killmails.flatMap((killmail) => {
      const entry = makeCombatHistoryEntry(
        killmail,
        'loss',
        characterId,
        names,
        victimGroupIds
      )
      return entry ? [entry] : []
    })

    const skipped = rawKillmails.length - kills.length - losses.length
    if (skipped > 0) warnings.push(`Incomplete killmails skipped: ${skipped}`)

    return {
      characterId,
      fetchedAt: new Date().toISOString(),
      cached:
        [...windows.values()].every((window) => window.cached) &&
        killsHydrated.cached &&
        lossesHydrated.cached,
      kills,
      losses,
      pageInfo: {
        ...(killsResult
          ? { kill: combatHistoryPageInfo(killsResult) }
          : {}),
        ...(lossesResult
          ? { loss: combatHistoryPageInfo(lossesResult) }
          : {})
      },
      warnings
    }
  }

  private async loadCombatHistoryWindow(
    characterId: number,
    kind: 'kills' | 'losses',
    offset: number,
    limit: number,
    forceRefresh: boolean
  ): Promise<CombatHistoryWindow> {
    const requiredRows = offset + limit + 1
    const rawRows: unknown[] = []
    let cached = true

    for (let page = 1; page <= MAX_COMBAT_HISTORY_PAGES; page += 1) {
      const result = await this.zkill.getCharacterHistory(
        characterId,
        kind,
        forceRefresh,
        page
      )
      cached = cached && result.cached
      rawRows.push(...result.killmails)

      const uniqueRows = uniqueKillmails(rawRows)
      if (uniqueRows.length >= requiredRows || result.killmails.length < ZKILL_HISTORY_PAGE_SIZE) {
        const selected = uniqueRows.slice(offset, offset + limit)
        return {
          characterId,
          kind,
          killmails: selected,
          cached,
          offset,
          limit,
          nextOffset: offset + selected.length,
          hasMore: uniqueRows.length > offset + selected.length,
          capped: false
        }
      }
    }

    const uniqueRows = uniqueKillmails(rawRows)
    const selected = uniqueRows.slice(offset, offset + limit)
    return {
      characterId,
      kind,
      killmails: selected,
      cached,
      offset,
      limit,
      nextOffset: offset + selected.length,
      hasMore: uniqueRows.length > offset + selected.length,
      capped: true
    }
  }

  async getRecentTargetProfile(
    request: RecentTargetProfileRequest
  ): Promise<RecentTargetProfileSnapshot> {
    const characterId = request.characterId
    if (!Number.isSafeInteger(characterId) || characterId <= 0) {
      throw new TypeError('Invalid pilot ID')
    }
    if (
      request.limit !== undefined &&
      (!Number.isFinite(request.limit) || request.limit < 1 || request.limit > 10)
    ) {
      throw new RangeError('From 1 to 10 recent kills are allowed')
    }

    const limit = Math.min(10, Math.max(1, Math.floor(request.limit ?? 10)))
    const forceRefresh = request.forceRefresh ?? false
    const warnings: string[] = []

    let history: ZkillHistoryResult
    try {
      history = await this.zkill.getCharacterHistory(characterId, 'kills', forceRefresh)
    } catch (error) {
      warnings.push(`zKill kills: ${messageOf(error)}`)
      return {
        characterId,
        fetchedAt: new Date().toISOString(),
        cached: false,
        requestedSampleSize: 0,
        sampleSize: 0,
        complete: false,
        profile: buildRecentTargetProfile([]),
        warnings
      }
    }

    const selected = uniqueKillmails(history.killmails).slice(0, limit)
    const hydrated = await this.hydrateKillmails(selected, forceRefresh, warnings)
    const victimTypeIds = collectVictimShipTypeIds(hydrated.killmails)
    const uniqueTypeIds = [...new Set(victimTypeIds)]

    const typeMetadata = await this.resolveUniverseTypeMetadata(uniqueTypeIds, forceRefresh)
    let fallbackTypeNames: UniverseName[] = []
    if (typeMetadata.failedTypeIds.length > 0) {
      warnings.push(`ESI: victim hull groups unavailable: ${typeMetadata.failedTypeIds.length}`)
      try {
        fallbackTypeNames = await this.esi.getUniverseNames(
          typeMetadata.failedTypeIds,
          forceRefresh
        )
      } catch (error) {
        warnings.push(`ESI: victim hull names unavailable (${messageOf(error)})`)
      }
    }
    const fallbackNames = new Map(fallbackTypeNames.map(({ id, name }) => [id, name]))
    const observations = victimTypeIds.map((typeId) => {
      const metadata = typeMetadata.byId.get(typeId)
      return {
        shipName: metadata?.name ?? fallbackNames.get(typeId) ?? null,
        shipTypeId: typeId,
        groupId: metadata?.groupId ?? null
      }
    })
    const missingVictimTypes = selected.length - observations.length
    if (missingVictimTypes > 0) {
      warnings.push(`Killmails without victim hull type: ${missingVictimTypes}`)
    }

    return {
      characterId,
      fetchedAt: new Date().toISOString(),
      cached:
        history.cached &&
        hydrated.cached &&
        typeMetadata.failedTypeIds.length === 0 &&
        [...typeMetadata.byId.values()].every(({ cached }) => cached) &&
        fallbackTypeNames.every(({ cached }) => cached),
      requestedSampleSize: selected.length,
      sampleSize: observations.length,
      complete:
        observations.length === selected.length &&
        typeMetadata.failedTypeIds.length === 0,
      profile: buildRecentTargetProfile(observations),
      warnings
    }
  }

  async getPilotIntel(request: PilotIntelRequest): Promise<PilotIntel> {
    const characterId = request.characterId
    if (!Number.isSafeInteger(characterId) || characterId <= 0) {
      throw new TypeError('Invalid pilot ID')
    }
    const forceRefresh = request.forceRefresh ?? false
    const names = await this.esi.getUniverseNames([characterId], forceRefresh)
    const identity = names.find((entry) => entry.id === characterId && entry.category === 'character')
    if (!identity?.name) throw new Error('ESI did not return a pilot name')

    // Do not resolve the name through /universe/ids again. NPC attackers such as
    // Drifters are valid `character` entities in a killmail and /universe/names,
    // but the name-search route may classify them outside its `characters` list.
    // A historical drilldown must therefore remain usable even when zKill has no
    // standalone stats profile for that entity.
    let affiliation: CharacterAffiliation | null = null
    let affiliationError: string | null = null
    try {
      affiliation = (await this.esi.getAffiliations([characterId], forceRefresh))[0] ?? null
    } catch (error) {
      affiliationError = `ESI: organization unavailable (${messageOf(error)})`
    }

    const organizationIds = affiliation
      ? [
          affiliation.corporationId,
          ...(affiliation.allianceId === null ? [] : [affiliation.allianceId])
        ]
      : []
    let organizations: UniverseName[] = []
    if (organizationIds.length > 0) {
      try {
        organizations = await this.esi.getUniverseNames(organizationIds, forceRefresh)
      } catch (error) {
        affiliationError = `ESI: organization names unavailable (${messageOf(error)})`
      }
    }
    const organizationById = new Map(organizations.map((entry) => [entry.id, entry]))

    const statsResult = (
      await this.zkill.getStatsForCharacters([characterId], forceRefresh)
    )[0] ?? missingStats(characterId)
    const threat = calculateThreat(statsResult.stats)
    const corporation = affiliation
      ? organizationById.get(affiliation.corporationId)
      : undefined
    const alliance = affiliation?.allianceId
      ? organizationById.get(affiliation.allianceId)
      : undefined

    return {
      id: characterId,
      name: identity.name,
      corporationId: affiliation?.corporationId ?? null,
      corporationName: corporation?.name ?? null,
      allianceId: affiliation?.allianceId ?? null,
      allianceName: alliance?.name ?? null,
      factionId: affiliation?.factionId ?? null,
      stats: statsResult.stats,
      threatScore: threat.score,
      threatLevel: threat.level,
      reasons: threat.reasons,
      zkillUrl: `https://zkillboard.com/character/${characterId}/`,
      cached:
        identity.cached &&
        (affiliation?.cached ?? false) &&
        (corporation?.cached ?? false) &&
        (affiliation?.allianceId === null || affiliation?.allianceId === undefined || (alliance?.cached ?? false)) &&
        statsResult.cached,
      error: statsResult.error ?? affiliationError
    }
  }

  private async hydrateKillmails(
    rawKillmails: readonly unknown[],
    forceRefresh: boolean,
    warnings: string[]
  ): Promise<{ killmails: unknown[]; cached: boolean }> {
    let allCached = true
    const hydrated = await mapConcurrent(rawKillmails, 3, async (raw) => {
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

    return { killmails: hydrated, cached: allCached }
  }

  private async resolveUniverseTypeMetadata(
    typeIds: readonly number[],
    forceRefresh: boolean
  ): Promise<UniverseTypeMetadataResult> {
    const uniqueTypeIds = [...new Set(
      typeIds.filter((typeId) => Number.isSafeInteger(typeId) && typeId > 0)
    )]
    const rows = await mapConcurrent(uniqueTypeIds, 3, async (typeId) => {
      try {
        return { typeId, metadata: await this.esi.getUniverseType(typeId, forceRefresh) }
      } catch {
        return { typeId, metadata: null }
      }
    })
    const byId = new Map<number, EsiUniverseType>()
    const failedTypeIds: number[] = []
    for (const row of rows) {
      if (row.metadata) byId.set(row.typeId, row.metadata)
      else failedTypeIds.push(row.typeId)
    }
    return { byId, failedTypeIds }
  }

  clearCache(): void {
    this.cache.clear()
  }

  getCacheStats(): CacheStats {
    return this.cache.stats()
  }

  close(): void {
    if (this.ownsCache) this.cache.close()
  }
}

function emptyResult(startedAt: number, warnings: string[]): ScanResult {
  return makeResult(startedAt, [], [], warnings)
}

function makeResult(
  startedAt: number,
  pilots: PilotIntel[],
  unresolvedNames: string[],
  warnings: string[]
): ScanResult {
  const dangerous = pilots.filter(
    (pilot) => pilot.threatLevel === 'critical' || pilot.threatLevel === 'high'
  ).length
  const unknown =
    unresolvedNames.length + pilots.filter((pilot) => pilot.threatLevel === 'unknown').length

  return {
    scannedAt: new Date().toISOString(),
    pilots,
    unresolvedNames,
    warnings,
    summary: {
      total: pilots.length + unresolvedNames.length,
      resolved: pilots.length,
      dangerous,
      unknown,
      cached: pilots.filter((pilot) => pilot.cached).length,
      durationMs: Math.max(0, Date.now() - startedAt),
      corporationGroups: groupCorporations(pilots)
    }
  }
}

function groupCorporations(pilots: readonly PilotIntel[]): CorporationGroup[] {
  const groups = new Map<string, CorporationGroup>()

  for (const pilot of pilots) {
    const key = pilot.corporationId === null ? 'unknown' : String(pilot.corporationId)
    const current = groups.get(key)
    if (current) {
      current.count += 1
    } else {
      groups.set(key, {
        id: pilot.corporationId,
        name: pilot.corporationName ?? 'Unknown corporation',
        count: 1
      })
    }
  }

  return [...groups.values()].sort(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name)
  )
}

function missingStats(characterId: number): ZkillStatsResult {
  return {
    characterId,
    stats: null,
    cached: false,
    error: 'zKill returned no result'
  }
}

function reportProgress(
  callback: ScanProgressCallback | undefined,
  progress: ScanProgress
): void {
  try {
    callback?.(progress)
  } catch {
    // Progress is best effort; a renderer callback cannot invalidate scan data.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function positiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function finiteNonNegative(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function uniqueKillmails(rawKillmails: readonly unknown[]): unknown[] {
  const seen = new Set<number>()
  const result: unknown[] = []

  for (const raw of rawKillmails) {
    const killmail = asRecord(raw)
    const killmailId = killmail ? positiveInteger(killmail.killmail_id) : null
    if (killmailId !== null) {
      if (seen.has(killmailId)) continue
      seen.add(killmailId)
    }
    result.push(raw)
  }

  return result
}

function emptyCombatHistoryWindow(
  characterId: number,
  kind: 'kills' | 'losses',
  offset: number,
  limit: number
): CombatHistoryWindow {
  return {
    characterId,
    kind,
    killmails: [],
    cached: false,
    offset,
    limit,
    nextOffset: offset,
    hasMore: false,
    capped: false
  }
}

function combatHistoryPageInfo(window: CombatHistoryWindow): CombatHistoryPageInfo {
  return {
    offset: window.offset,
    limit: window.limit,
    nextOffset: window.nextOffset,
    hasMore: window.hasMore,
    ...(window.capped ? { capped: true } : {})
  }
}

function hasFullVictim(raw: unknown): boolean {
  const killmail = asRecord(raw)
  const victim = killmail ? asRecord(killmail.victim) : null
  return victim !== null &&
    positiveInteger(victim.ship_type_id) !== null &&
    Array.isArray(killmail?.attackers)
}

function killmailReference(
  raw: unknown
): { killmailId: number; hash: string } | null {
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

function collectHistoryNameIds(
  rawKillmails: readonly unknown[]
): number[] {
  const ids = new Set<number>()

  for (const raw of rawKillmails) {
    for (const typeId of collectKillmailTypeIds(raw)) ids.add(typeId)

    const killmail = asRecord(raw)
    if (!killmail) continue
    const solarSystemId = positiveInteger(killmail.solar_system_id)
    if (solarSystemId !== null) ids.add(solarSystemId)

    const victim = asRecord(killmail.victim)
    if (victim) {
      const victimCharacterId = positiveInteger(victim.character_id)
      const victimCorporationId = positiveInteger(victim.corporation_id)
      if (victimCharacterId !== null) ids.add(victimCharacterId)
      if (victimCorporationId !== null) ids.add(victimCorporationId)
    }

    if (Array.isArray(killmail.attackers)) {
      for (const value of killmail.attackers) {
        const attacker = asRecord(value)
        if (!attacker) continue
        const attackerCharacterId = positiveInteger(attacker.character_id)
        if (attackerCharacterId === null) continue
        for (const id of [
          attackerCharacterId,
          positiveInteger(attacker.corporation_id),
          positiveInteger(attacker.alliance_id),
          positiveInteger(attacker.ship_type_id),
          positiveInteger(attacker.weapon_type_id)
        ]) {
          if (id !== null) ids.add(id)
        }
      }
    }
  }

  return [...ids]
}

function collectVictimShipTypeIds(rawKillmails: readonly unknown[]): number[] {
  return rawKillmails.flatMap((raw) => {
    const killmail = asRecord(raw)
    const victim = killmail ? asRecord(killmail.victim) : null
    const typeId = victim ? positiveInteger(victim.ship_type_id) : null
    return typeId === null ? [] : [typeId]
  })
}

function makeCombatHistoryEntry(
  raw: unknown,
  kind: CombatHistoryKind,
  characterId: number,
  names: Map<number, string>,
  victimGroupIds: ReadonlyMap<number, number>
): CombatHistoryEntry | null {
  const killmail = asRecord(raw)
  if (!killmail) return null
  const killmailId = positiveInteger(killmail.killmail_id)
  const solarSystemId = positiveInteger(killmail.solar_system_id)
  const rawTime = killmail.killmail_time
  const time = typeof rawTime === 'string' ? Date.parse(rawTime) : NaN
  const victim = asRecord(killmail.victim)
  const victimFit = parseVictimFit(raw, names)
  if (
    killmailId === null ||
    solarSystemId === null ||
    !Number.isFinite(time) ||
    !victim ||
    !victimFit
  ) {
    return null
  }

  const victimCharacterId = positiveInteger(victim.character_id)
  const victimCorporationId = positiveInteger(victim.corporation_id)
  const attackers = Array.isArray(killmail.attackers) ? killmail.attackers : []
  const attacker = asRecord(
    attackers.find((value) => {
      const item = asRecord(value)
      return item && positiveInteger(item.character_id) === characterId
    })
  )
  const attackerShipTypeId = attacker ? positiveInteger(attacker.ship_type_id) : null
  const parsedAttackers = parseCombatHistoryAttackers(attackers, names, characterId)
  const zkb = asRecord(killmail.zkb)

  return {
    kind,
    killmailId,
    time: new Date(time).toISOString(),
    solarSystemId,
    solarSystemName: names.get(solarSystemId) ?? null,
    victimCharacterId,
    victimName: victimCharacterId === null ? null : names.get(victimCharacterId) ?? null,
    victimCorporationName:
      victimCorporationId === null ? null : names.get(victimCorporationId) ?? null,
    victimFit,
    victimShipGroupId: victimGroupIds.get(victimFit.shipTypeId) ?? null,
    attackerShipTypeId,
    attackerShipName:
      attackerShipTypeId === null ? null : names.get(attackerShipTypeId) ?? null,
    pilotFinalBlow: attacker?.final_blow === true,
    attackers: parsedAttackers.attackers,
    attackerCount: parsedAttackers.attackerCount,
    attackersCapped: parsedAttackers.attackersCapped,
    nonCapsuleerAttackerCount: parsedAttackers.nonCapsuleerAttackerCount,
    totalValue: zkb ? finiteNonNegative(zkb.totalValue) : null,
    solo: zkb?.solo === true
  }
}

function parseCombatHistoryAttackers(
  rawAttackers: readonly unknown[],
  names: ReadonlyMap<number, string>,
  focusedCharacterId: number
): {
  attackers: CombatHistoryAttacker[]
  attackerCount: number
  attackersCapped: boolean
  nonCapsuleerAttackerCount: number
} {
  const byCharacterId = new Map<number, CombatHistoryAttacker>()
  let nonCapsuleerAttackerCount = 0

  for (const raw of rawAttackers) {
    const attacker = asRecord(raw)
    if (!attacker) continue
    const characterId = positiveInteger(attacker.character_id)
    if (characterId === null) {
      nonCapsuleerAttackerCount += 1
      continue
    }

    const corporationId = positiveInteger(attacker.corporation_id)
    const allianceId = positiveInteger(attacker.alliance_id)
    const shipTypeId = positiveInteger(attacker.ship_type_id)
    const weaponTypeId = positiveInteger(attacker.weapon_type_id)
    const candidate: CombatHistoryAttacker = {
      characterId,
      name: names.get(characterId) ?? null,
      corporationId,
      corporationName: corporationId === null ? null : names.get(corporationId) ?? null,
      allianceId,
      allianceName: allianceId === null ? null : names.get(allianceId) ?? null,
      shipTypeId,
      shipName: shipTypeId === null ? null : names.get(shipTypeId) ?? null,
      weaponTypeId,
      weaponName: weaponTypeId === null ? null : names.get(weaponTypeId) ?? null,
      damageDone: finiteNonNegative(attacker.damage_done) ?? 0,
      finalBlow: attacker.final_blow === true
    }
    const current = byCharacterId.get(characterId)
    if (!current) {
      byCharacterId.set(characterId, candidate)
      continue
    }
    const preferred = candidate.damageDone > current.damageDone ? candidate : current
    byCharacterId.set(characterId, {
      ...preferred,
      finalBlow: current.finalBlow || candidate.finalBlow
    })
  }

  const allAttackers = [...byCharacterId.values()].sort((left, right) =>
    Number(right.finalBlow) - Number(left.finalBlow) ||
    right.damageDone - left.damageDone ||
    (left.name ?? String(left.characterId)).localeCompare(
      right.name ?? String(right.characterId),
      'ru'
    )
  )

  const visibleAttackers = allAttackers.slice(0, MAX_COMBAT_HISTORY_ATTACKERS)
  if (
    allAttackers.length > MAX_COMBAT_HISTORY_ATTACKERS &&
    !visibleAttackers.some((attacker) => attacker.characterId === focusedCharacterId)
  ) {
    const focusedAttacker = allAttackers.find(
      (attacker) => attacker.characterId === focusedCharacterId
    )
    if (focusedAttacker) visibleAttackers[visibleAttackers.length - 1] = focusedAttacker
  }

  return {
    attackers: visibleAttackers,
    attackerCount: allAttackers.length,
    attackersCapped: allAttackers.length > MAX_COMBAT_HISTORY_ATTACKERS,
    nonCapsuleerAttackerCount
  }
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
