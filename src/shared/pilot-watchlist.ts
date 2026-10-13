export const PILOT_WATCHLIST_ENTITY_TYPES = ['character', 'corporation', 'alliance'] as const
export const PILOT_WATCHLIST_SEVERITIES = ['watch', 'danger', 'critical'] as const
export const PILOT_WATCHLIST_ALERT_SOURCES = [
  'local',
  'dscan',
  'system-killmail',
  'r2z2'
] as const
export const PILOT_WATCHLIST_SOUND_IDS = ['default', 'warning', 'critical', 'radar'] as const

export type PilotWatchlistEntityType = (typeof PILOT_WATCHLIST_ENTITY_TYPES)[number]
export type PilotWatchlistSeverity = (typeof PILOT_WATCHLIST_SEVERITIES)[number]
export type PilotWatchlistAlertSource = (typeof PILOT_WATCHLIST_ALERT_SOURCES)[number]
export type PilotWatchlistSoundId = (typeof PILOT_WATCHLIST_SOUND_IDS)[number]
export type PilotWatchlistEntityKey = `${PilotWatchlistEntityType}:${number}`

export const LEGACY_WATCHLIST_ALERT_SOURCES: readonly PilotWatchlistAlertSource[] = [
  'local',
  'system-killmail'
]
export const DEFAULT_WATCHLIST_COOLDOWN_SECONDS = 60

/**
 * `characterId` remains a required compatibility alias for older renderer code.
 * For corporation/alliance entries it equals `entityId`; new consumers must use
 * the entity helpers below instead of assuming every entry is a pilot.
 */
export interface PilotWatchlistEntry {
  characterId: number
  entityType?: PilotWatchlistEntityType
  entityId?: number
  name: string
  corporationName: string | null
  severity?: PilotWatchlistSeverity
  tags?: string[]
  alertSources?: PilotWatchlistAlertSource[]
  soundId?: PilotWatchlistSoundId | null
  volume?: number | null
  cooldownSeconds?: number
  note: string | null
  alertSoundEnabled: boolean
  addedAt: string
  updatedAt: string
}

export interface PilotWatchlistSnapshot {
  entries: PilotWatchlistEntry[]
  updatedAt: string
}

/** Accepts both legacy character-only payloads and Watchlist 2.0 entities. */
export interface PilotWatchlistUpsertRequest {
  characterId?: number
  entityType?: PilotWatchlistEntityType
  entityId?: number
  name: string
  corporationName?: string | null
  severity?: PilotWatchlistSeverity
  tags?: string[]
  alertSources?: PilotWatchlistAlertSource[]
  soundId?: PilotWatchlistSoundId | null
  volume?: number | null
  cooldownSeconds?: number
  note?: string | null
  alertSoundEnabled?: boolean
}

export interface PilotWatchlistAdvancedPatch {
  severity?: PilotWatchlistSeverity
  tags?: string[]
  alertSources?: PilotWatchlistAlertSource[]
  soundId?: PilotWatchlistSoundId | null
  volume?: number | null
  cooldownSeconds?: number
  note?: string | null
  alertSoundEnabled?: boolean
}

/** `characterId` is retained because the current main-process handler reads it. */
export interface PilotWatchlistRemoveRequest {
  characterId: number
  entityType?: PilotWatchlistEntityType
  entityId?: number
}

export interface WatchlistScanPilot {
  id: number
  name: string
  corporationId?: number | null
  corporationName?: string | null
  allianceId?: number | null
  allianceName?: string | null
}

export interface WatchlistScanResult {
  pilots: readonly WatchlistScanPilot[]
  unresolvedNames: readonly string[]
}

export interface PilotWatchlistMatch {
  entry: PilotWatchlistEntry
  pilot: WatchlistScanPilot | null
  matchedBy: 'character-id' | 'name' | 'corporation-id' | 'alliance-id'
}

export interface PilotWatchlistPresence {
  matches: PilotWatchlistMatch[]
  entered: PilotWatchlistMatch[]
  presentEntityKeys: PilotWatchlistEntityKey[]
}

export interface PilotWatchlistDscanSeenState {
  capturedAt: string | null
  characterIds: number[]
}

export interface PilotWatchlistDscanCandidateDelta {
  newCharacterIds: number[]
  state: PilotWatchlistDscanSeenState
}

export interface ResolvedPilotWatchlistAlertConfig {
  entityType: PilotWatchlistEntityType
  entityId: number
  severity: PilotWatchlistSeverity
  tags: string[]
  alertSources: PilotWatchlistAlertSource[]
  soundId: PilotWatchlistSoundId | null
  volume: number | null
  cooldownSeconds: number
}

export function getPilotWatchlistEntityType(
  entry: Pick<PilotWatchlistEntry, 'entityType'>
): PilotWatchlistEntityType {
  return entry.entityType ?? 'character'
}

export function getPilotWatchlistEntityId(
  entry: Pick<PilotWatchlistEntry, 'entityId' | 'characterId'>
): number {
  return entry.entityId ?? entry.characterId
}

export function toPilotWatchlistEntityKey(
  entityType: PilotWatchlistEntityType,
  entityId: number
): PilotWatchlistEntityKey {
  return `${entityType}:${entityId}`
}

export function getPilotWatchlistEntityKey(
  entry: Pick<PilotWatchlistEntry, 'entityType' | 'entityId' | 'characterId'>
): PilotWatchlistEntityKey {
  return toPilotWatchlistEntityKey(
    getPilotWatchlistEntityType(entry),
    getPilotWatchlistEntityId(entry)
  )
}

export function getPilotWatchlistSeverity(
  entry: Pick<PilotWatchlistEntry, 'severity'>
): PilotWatchlistSeverity {
  return entry.severity ?? 'danger'
}

export function getPilotWatchlistAlertSources(
  entry: Pick<PilotWatchlistEntry, 'entityType' | 'alertSources'>
): PilotWatchlistAlertSource[] {
  const configured = entry.alertSources
    ? [...entry.alertSources]
    : [...LEGACY_WATCHLIST_ALERT_SOURCES]
  const supported = getSupportedPilotWatchlistAlertSources(getPilotWatchlistEntityType(entry))
  return configured.filter((source) => supported.includes(source))
}

export function getSupportedPilotWatchlistAlertSources(
  entityType: PilotWatchlistEntityType
): readonly PilotWatchlistAlertSource[] {
  return entityType === 'character'
    ? PILOT_WATCHLIST_ALERT_SOURCES
    : ['local', 'r2z2']
}

export function resolvePilotWatchlistAlertConfig(
  entry: PilotWatchlistEntry
): ResolvedPilotWatchlistAlertConfig {
  return {
    entityType: getPilotWatchlistEntityType(entry),
    entityId: getPilotWatchlistEntityId(entry),
    severity: getPilotWatchlistSeverity(entry),
    tags: entry.tags ? [...entry.tags] : [],
    alertSources: getPilotWatchlistAlertSources(entry),
    soundId: entry.soundId ?? null,
    volume: entry.volume ?? null,
    cooldownSeconds: entry.cooldownSeconds ?? DEFAULT_WATCHLIST_COOLDOWN_SECONDS
  }
}

export function isPilotWatchlistAlertSourceEnabled(
  entry: PilotWatchlistEntry,
  source: PilotWatchlistAlertSource
): boolean {
  return getPilotWatchlistAlertSources(entry).includes(source)
}

/** Shared cooldown/source decision for Local, D-scan, system killmail and R2Z2 engines. */
export function shouldPlayPilotWatchlistAlert(
  entry: PilotWatchlistEntry,
  source: PilotWatchlistAlertSource,
  lastAlertAtMs: number | null,
  nowMs = Date.now()
): boolean {
  if (!entry.alertSoundEnabled) return false
  return shouldEmitPilotWatchlistAlert(entry, source, lastAlertAtMs, nowMs)
}

/** Source + per-entity cooldown decision shared by visual and native alert channels. */
export function shouldEmitPilotWatchlistAlert(
  entry: PilotWatchlistEntry,
  source: PilotWatchlistAlertSource,
  lastAlertAtMs: number | null,
  nowMs = Date.now()
): boolean {
  if (!isPilotWatchlistAlertSourceEnabled(entry, source)) return false
  if (lastAlertAtMs === null || !Number.isFinite(lastAlertAtMs)) return true
  const cooldownMs = resolvePilotWatchlistAlertConfig(entry).cooldownSeconds * 1_000
  return Number.isFinite(nowMs) && nowMs - lastAlertAtMs >= cooldownMs
}

export function normalizePilotWatchlistName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US')
}

export function findPilotWatchlistMatches(
  entries: readonly PilotWatchlistEntry[],
  scan: WatchlistScanResult
): PilotWatchlistMatch[] {
  const pilotById = new Map(scan.pilots.map((pilot) => [pilot.id, pilot]))
  const unresolvedNames = new Set(
    scan.unresolvedNames.map(normalizePilotWatchlistName).filter(Boolean)
  )

  const matches: PilotWatchlistMatch[] = []
  for (const entry of entries) {
    const entityType = getPilotWatchlistEntityType(entry)
    const entityId = getPilotWatchlistEntityId(entry)

    if (entityType === 'character') {
      const byId = pilotById.get(entityId)
      if (byId) {
        matches.push({ entry, pilot: byId, matchedBy: 'character-id' })
        continue
      }
      const normalizedName = normalizePilotWatchlistName(entry.name)
      if (unresolvedNames.has(normalizedName)) {
        matches.push({ entry, pilot: null, matchedBy: 'name' })
      }
      continue
    }

    const pilot = scan.pilots.find((candidate) => (
      entityType === 'corporation'
        ? candidate.corporationId === entityId
        : candidate.allianceId === entityId
    ))
    if (pilot) {
      matches.push({
        entry,
        pilot,
        matchedBy: entityType === 'corporation' ? 'corporation-id' : 'alliance-id'
      })
    }
  }
  return matches
}

/** All resolved pilots affected by character, corporation, or alliance entries. */
export function findPilotWatchlistMatchedPilotIds(
  entries: readonly PilotWatchlistEntry[],
  scan: Pick<WatchlistScanResult, 'pilots'>
): number[] {
  const ids = new Set<number>()
  for (const pilot of scan.pilots) {
    if (entries.some((entry) => {
      const entityType = getPilotWatchlistEntityType(entry)
      const entityId = getPilotWatchlistEntityId(entry)
      if (entityType === 'character') return pilot.id === entityId
      if (entityType === 'corporation') return pilot.corporationId === entityId
      return pilot.allianceId === entityId
    })) {
      ids.add(pilot.id)
    }
  }
  return [...ids].sort((left, right) => left - right)
}

/** A D-scan capture alerts each correlated pilot once, even as system history refreshes. */
export function reconcilePilotWatchlistDscanCandidates(
  previous: PilotWatchlistDscanSeenState,
  capturedAt: string,
  candidateCharacterIds: readonly number[]
): PilotWatchlistDscanCandidateDelta {
  const seen = previous.capturedAt === capturedAt
    ? new Set(previous.characterIds)
    : new Set<number>()
  const newCharacterIds: number[] = []
  for (const characterId of candidateCharacterIds) {
    if (!Number.isSafeInteger(characterId) || characterId <= 0 || seen.has(characterId)) continue
    seen.add(characterId)
    newCharacterIds.push(characterId)
  }
  newCharacterIds.sort((left, right) => left - right)
  return {
    newCharacterIds,
    state: {
      capturedAt,
      characterIds: [...seen].sort((left, right) => left - right)
    }
  }
}

/** Backfill stays in the feed but is excluded from operational watchlist reactions. */
export function filterOperationalPilotWatchlistAlerts<
  T extends { historicalBackfill: boolean }
>(alerts: readonly T[]): T[] {
  return alerts.filter((alert) => !alert.historicalBackfill)
}

/**
 * Finds watchlist entities that entered the newest scan. The legacy numeric
 * presence array remains compatible with the current Local alert integration.
 */
export function reconcilePilotWatchlistPresence(
  previousPresentEntityKeys: readonly PilotWatchlistEntityKey[],
  entries: readonly PilotWatchlistEntry[],
  scan: WatchlistScanResult
): PilotWatchlistPresence {
  const previous = new Set(previousPresentEntityKeys)
  const matches = findPilotWatchlistMatches(entries, scan)
  const entered = matches.filter(({ entry }) => !previous.has(getPilotWatchlistEntityKey(entry)))
  const presentEntityKeys = [...new Set(
    matches.map(({ entry }) => getPilotWatchlistEntityKey(entry))
  )].sort((left, right) => left.localeCompare(right, 'en-US'))

  return { matches, entered, presentEntityKeys }
}
