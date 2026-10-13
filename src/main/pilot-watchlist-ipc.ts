import {
  PILOT_WATCHLIST_ALERT_SOURCES,
  PILOT_WATCHLIST_ENTITY_TYPES,
  PILOT_WATCHLIST_SEVERITIES,
  PILOT_WATCHLIST_SOUND_IDS,
  type PilotWatchlistAlertSource,
  type PilotWatchlistEntityType,
  type PilotWatchlistRemoveRequest,
  type PilotWatchlistSeverity,
  type PilotWatchlistSoundId,
  type PilotWatchlistUpsertRequest
} from '../shared/pilot-watchlist'

const MAX_TAGS = 20
const MAX_TAG_LENGTH = 32
const MAX_COOLDOWN_SECONDS = 24 * 60 * 60

const UPSERT_KEYS = new Set([
  'characterId',
  'entityType',
  'entityId',
  'name',
  'corporationName',
  'severity',
  'tags',
  'alertSources',
  'soundId',
  'volume',
  'cooldownSeconds',
  'note',
  'alertSoundEnabled'
])

const REMOVE_KEYS = new Set(['characterId', 'entityType', 'entityId'])

export function parsePilotWatchlistUpsertRequest(value: unknown): PilotWatchlistUpsertRequest {
  const record = requireRecord(value)
  rejectUnknownKeys(record, UPSERT_KEYS)
  const explicitV2Identity = record.entityType !== undefined || record.entityId !== undefined
  const entityType = record.entityType === undefined
    ? 'character'
    : parseEntityType(record.entityType)
  const entityId = resolveEntityId(record, explicitV2Identity)
  const name = parseRequiredText(
    record.name,
    128,
    entityType === 'character' ? 'pilot name' : 'entity name'
  )
  const corporationName = record.corporationName === undefined
    ? undefined
    : parseOptionalText(record.corporationName, 256, 'corporation')
  const note = record.note === undefined
    ? undefined
    : parseOptionalText(record.note, 500, 'note')
  const alertSoundEnabled = record.alertSoundEnabled === undefined
    ? undefined
    : parseBoolean(record.alertSoundEnabled, 'sound alert')

  const request: PilotWatchlistUpsertRequest = {
    characterId: entityId,
    name,
    corporationName,
    note,
    alertSoundEnabled
  }
  // Preserve the exact legacy parser shape for existing callers and tests.
  if (explicitV2Identity) {
    request.entityType = entityType
    request.entityId = entityId
  }
  if (record.severity !== undefined) request.severity = parseSeverity(record.severity)
  if (record.tags !== undefined) request.tags = parseTags(record.tags)
  if (record.alertSources !== undefined) {
    request.alertSources = parseAlertSources(record.alertSources)
  }
  if (record.soundId !== undefined) request.soundId = parseSoundId(record.soundId)
  if (record.volume !== undefined) request.volume = parseVolume(record.volume)
  if (record.cooldownSeconds !== undefined) {
    request.cooldownSeconds = parseCooldown(record.cooldownSeconds)
  }
  return request
}

export function parsePilotWatchlistRemoveRequest(value: unknown): PilotWatchlistRemoveRequest {
  const record = requireRecord(value)
  rejectUnknownKeys(record, REMOVE_KEYS)
  const explicitV2Identity = record.entityType !== undefined || record.entityId !== undefined
  const entityType = record.entityType === undefined
    ? 'character'
    : parseEntityType(record.entityType)
  const entityId = resolveEntityId(record, explicitV2Identity)
  return explicitV2Identity
    ? { characterId: entityId, entityType, entityId }
    : { characterId: entityId }
}

function resolveEntityId(record: Record<string, unknown>, explicitV2Identity: boolean): number {
  const rawEntityId = record.entityId
  const rawCharacterId = record.characterId
  const entityId = rawEntityId === undefined
    ? parseEntityId(rawCharacterId, explicitV2Identity ? 'entity' : 'pilot')
    : parseEntityId(rawEntityId, 'entity')
  if (
    rawCharacterId !== undefined &&
    parseEntityId(rawCharacterId, explicitV2Identity ? 'entity' : 'pilot') !== entityId
  ) {
    throw new TypeError('Entity ID and compatibility ID do not match')
  }
  return entityId
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid watchlist request')
  }
  return value as Record<string, unknown>
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError('Watchlist request contains unknown fields')
  }
}

function parseEntityType(value: unknown): PilotWatchlistEntityType {
  if (typeof value === 'string' && PILOT_WATCHLIST_ENTITY_TYPES.includes(value as PilotWatchlistEntityType)) {
    return value as PilotWatchlistEntityType
  }
  throw new TypeError('Invalid entity type')
}

function parseEntityId(value: unknown, label: 'pilot' | 'entity'): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`Invalid ${label} ID`)
  }
  return Number(value)
}

function parseSeverity(value: unknown): PilotWatchlistSeverity {
  if (typeof value === 'string' && PILOT_WATCHLIST_SEVERITIES.includes(value as PilotWatchlistSeverity)) {
    return value as PilotWatchlistSeverity
  }
  throw new TypeError('Invalid danger level')
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new TypeError('Invalid watchlist tags')
  }
  const tags: string[] = []
  const seen = new Set<string>()
  for (const rawTag of value) {
    const tag = parseRequiredText(rawTag, MAX_TAG_LENGTH, 'tag')
    const key = tag.toLocaleLowerCase('en-US')
    if (!seen.has(key)) {
      seen.add(key)
      tags.push(tag)
    }
  }
  return tags
}

function parseAlertSources(value: unknown): PilotWatchlistAlertSource[] {
  if (!Array.isArray(value) || value.length > PILOT_WATCHLIST_ALERT_SOURCES.length) {
    throw new TypeError('Invalid alert sources')
  }
  const sources: PilotWatchlistAlertSource[] = []
  for (const source of value) {
    if (
      typeof source !== 'string' ||
      !PILOT_WATCHLIST_ALERT_SOURCES.includes(source as PilotWatchlistAlertSource) ||
      sources.includes(source as PilotWatchlistAlertSource)
    ) {
      throw new TypeError('Invalid alert sources')
    }
    sources.push(source as PilotWatchlistAlertSource)
  }
  return sources
}

function parseSoundId(value: unknown): PilotWatchlistSoundId | null {
  if (value === null) return null
  if (typeof value === 'string' && PILOT_WATCHLIST_SOUND_IDS.includes(value as PilotWatchlistSoundId)) {
    return value as PilotWatchlistSoundId
  }
  throw new TypeError('Invalid alert sound')
}

function parseVolume(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('Volume must be from 0 to 1')
  }
  return value
}

function parseCooldown(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_COOLDOWN_SECONDS) {
    throw new TypeError('Invalid alert cooldown')
  }
  return Number(value)
}

function parseRequiredText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid field: ${label}`)
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return trimmed
}

function parseOptionalText(value: unknown, maxLength: number, label: string): string | null {
  if (value === null) return null
  return parseRequiredText(value, maxLength, label)
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`Invalid field: ${label}`)
  return value
}
