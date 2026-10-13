import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  DEFAULT_WATCHLIST_COOLDOWN_SECONDS,
  LEGACY_WATCHLIST_ALERT_SOURCES,
  PILOT_WATCHLIST_ALERT_SOURCES,
  PILOT_WATCHLIST_ENTITY_TYPES,
  PILOT_WATCHLIST_SEVERITIES,
  PILOT_WATCHLIST_SOUND_IDS,
  getSupportedPilotWatchlistAlertSources,
  type PilotWatchlistAlertSource,
  type PilotWatchlistEntityType,
  type PilotWatchlistEntry,
  type PilotWatchlistSeverity,
  type PilotWatchlistSnapshot,
  type PilotWatchlistSoundId,
  type PilotWatchlistUpsertRequest
} from '../shared/pilot-watchlist'

const MAX_WATCHLIST_ENTRIES = 500
const MAX_TAGS = 20
const MAX_TAG_LENGTH = 32
const MAX_COOLDOWN_SECONDS = 24 * 60 * 60
const EMPTY_UPDATED_AT = new Date(0).toISOString()

interface PilotWatchlistRow {
  entity_type: PilotWatchlistEntityType
  entity_id: number
  character_id: number
  name: string
  corporation_name: string | null
  severity: PilotWatchlistSeverity
  tags_json: string
  alert_sources_json: string
  sound_id: PilotWatchlistSoundId | null
  volume: number | null
  cooldown_seconds: number
  note: string | null
  alert_sound_enabled: number
  added_at: string
  updated_at: string
}

interface ResolvedEntity {
  type: PilotWatchlistEntityType
  id: number
}

export class PilotWatchlistStore {
  readonly databasePath: string

  private readonly database: Database.Database
  private closed = false

  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    this.databasePath = databasePath
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })

    this.database = new Database(databasePath)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = NORMAL')
    this.database.pragma('busy_timeout = 5000')
    this.initializeSchema()
  }

  list(): PilotWatchlistSnapshot {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT entity_type, entity_id, character_id, name, corporation_name,
             severity, tags_json, alert_sources_json, sound_id, volume,
             cooldown_seconds, note, alert_sound_enabled, added_at, updated_at
      FROM pilot_watchlist
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'danger' THEN 1 ELSE 2 END,
        updated_at DESC,
        name COLLATE NOCASE ASC
    `).all() as PilotWatchlistRow[]

    return {
      entries: rows.map(toEntry),
      updatedAt: rows.reduce(
        (latest, row) => row.updated_at > latest ? row.updated_at : latest,
        EMPTY_UPDATED_AT
      )
    }
  }

  upsert(request: PilotWatchlistUpsertRequest): PilotWatchlistSnapshot {
    this.assertOpen()
    const entity = resolveEntity(request)
    const name = validateRequiredText(request.name, 128, entityNameLabel(entity.type))
    const existing = this.find(entity.type, entity.id)
    if (!existing && this.count() >= MAX_WATCHLIST_ENTRIES) {
      throw new Error(`Watchlist cannot contain more than ${MAX_WATCHLIST_ENTRIES} entries`)
    }

    const corporationName = request.corporationName === undefined
      ? existing?.corporationName ?? null
      : validateOptionalText(request.corporationName, 256, 'corporation')
    const severity = request.severity === undefined
      ? existing?.severity ?? 'danger'
      : validateSeverity(request.severity)
    const tags = request.tags === undefined
      ? existing?.tags ?? []
      : normalizeTags(request.tags)
    const alertSources = request.alertSources === undefined
      ? existing?.alertSources ?? defaultAlertSources(entity.type)
      : validateAlertSourcesForEntity(request.alertSources, entity.type)
    const soundId = request.soundId === undefined
      ? existing?.soundId ?? null
      : validateSoundId(request.soundId)
    const volume = request.volume === undefined
      ? existing?.volume ?? null
      : validateVolume(request.volume)
    const cooldownSeconds = request.cooldownSeconds === undefined
      ? existing?.cooldownSeconds ?? DEFAULT_WATCHLIST_COOLDOWN_SECONDS
      : validateCooldown(request.cooldownSeconds)
    const note = request.note === undefined
      ? existing?.note ?? null
      : validateOptionalText(request.note, 500, 'note')
    const alertSoundEnabled = request.alertSoundEnabled === undefined
      ? existing?.alertSoundEnabled ?? true
      : validateBoolean(request.alertSoundEnabled, 'sound alert')
    const updatedAt = new Date(this.now()).toISOString()
    const addedAt = existing?.addedAt ?? updatedAt

    this.database.prepare(`
      INSERT INTO pilot_watchlist (
        entity_type, entity_id, character_id, name, corporation_name,
        severity, tags_json, alert_sources_json, sound_id, volume,
        cooldown_seconds, note, alert_sound_enabled, added_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        character_id = excluded.character_id,
        name = excluded.name,
        corporation_name = excluded.corporation_name,
        severity = excluded.severity,
        tags_json = excluded.tags_json,
        alert_sources_json = excluded.alert_sources_json,
        sound_id = excluded.sound_id,
        volume = excluded.volume,
        cooldown_seconds = excluded.cooldown_seconds,
        note = excluded.note,
        alert_sound_enabled = excluded.alert_sound_enabled,
        updated_at = excluded.updated_at
    `).run(
      entity.type,
      entity.id,
      entity.id,
      name,
      corporationName,
      severity,
      JSON.stringify(tags),
      JSON.stringify(alertSources),
      soundId,
      volume,
      cooldownSeconds,
      note,
      alertSoundEnabled ? 1 : 0,
      addedAt,
      updatedAt
    )
    return this.list()
  }

  /** Atomic import/update used by EVE contacts: either every row is applied or none. */
  bulkUpsert(requests: readonly PilotWatchlistUpsertRequest[]): PilotWatchlistSnapshot {
    this.assertOpen()
    if (!Array.isArray(requests) || requests.length > MAX_WATCHLIST_ENTRIES) {
      throw new RangeError(`Watchlist batch cannot exceed ${MAX_WATCHLIST_ENTRIES}`)
    }

    const newEntityKeys = new Set<string>()
    for (const request of requests) {
      const entity = resolveEntity(request)
      if (!this.find(entity.type, entity.id)) {
        newEntityKeys.add(`${entity.type}:${entity.id}`)
      }
    }
    if (this.count() + newEntityKeys.size > MAX_WATCHLIST_ENTRIES) {
      throw new Error(`Watchlist cannot contain more than ${MAX_WATCHLIST_ENTRIES} entries`)
    }

    const apply = this.database.transaction((rows: readonly PilotWatchlistUpsertRequest[]) => {
      for (const request of rows) this.upsert(request)
    })
    apply(requests)
    return this.list()
  }

  /** Legacy removal used by the existing main handler; IDs are globally stable in EVE. */
  remove(characterId: number): PilotWatchlistSnapshot {
    this.assertOpen()
    this.database.prepare('DELETE FROM pilot_watchlist WHERE entity_id = ?')
      .run(validateEntityId(characterId))
    return this.list()
  }

  removeEntity(entityType: PilotWatchlistEntityType, entityId: number): PilotWatchlistSnapshot {
    this.assertOpen()
    this.database.prepare('DELETE FROM pilot_watchlist WHERE entity_type = ? AND entity_id = ?')
      .run(validateEntityType(entityType), validateEntityId(entityId))
    return this.list()
  }

  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  private initializeSchema(): void {
    const table = this.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pilot_watchlist'
    `).get() as { name: string } | undefined

    if (!table) {
      createWatchlistV2Table(this.database, 'pilot_watchlist')
      createWatchlistIndexes(this.database)
      return
    }

    const columns = new Set((this.database.prepare('PRAGMA table_info(pilot_watchlist)')
      .all() as Array<{ name: string }>).map((column) => column.name))
    if (columns.has('entity_type') && columns.has('entity_id')) {
      createWatchlistIndexes(this.database)
      return
    }

    const migrate = this.database.transaction(() => {
      createWatchlistV2Table(this.database, 'pilot_watchlist_v2')
      this.database.prepare(`
        INSERT INTO pilot_watchlist_v2 (
          entity_type, entity_id, character_id, name, corporation_name,
          severity, tags_json, alert_sources_json, sound_id, volume,
          cooldown_seconds, note, alert_sound_enabled, added_at, updated_at
        )
        SELECT
          'character', character_id, character_id, name, corporation_name,
          'danger', '[]', ?, NULL, NULL, ?, note, alert_sound_enabled,
          added_at, updated_at
        FROM pilot_watchlist
      `).run(JSON.stringify(LEGACY_WATCHLIST_ALERT_SOURCES), DEFAULT_WATCHLIST_COOLDOWN_SECONDS)
      this.database.exec(`
        DROP TABLE pilot_watchlist;
        ALTER TABLE pilot_watchlist_v2 RENAME TO pilot_watchlist;
      `)
      createWatchlistIndexes(this.database)
    })
    migrate()
  }

  private find(entityType: PilotWatchlistEntityType, entityId: number): PilotWatchlistEntry | null {
    const row = this.database.prepare(`
      SELECT entity_type, entity_id, character_id, name, corporation_name,
             severity, tags_json, alert_sources_json, sound_id, volume,
             cooldown_seconds, note, alert_sound_enabled, added_at, updated_at
      FROM pilot_watchlist
      WHERE entity_type = ? AND entity_id = ?
    `).get(entityType, entityId) as PilotWatchlistRow | undefined
    return row ? toEntry(row) : null
  }

  private count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM pilot_watchlist')
      .get() as { count: number } | undefined
    return row?.count ?? 0
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Watchlist is already closed')
  }
}

function createWatchlistV2Table(database: Database.Database, tableName: string): void {
  if (tableName !== 'pilot_watchlist' && tableName !== 'pilot_watchlist_v2') {
    throw new TypeError('Invalid watchlist table name')
  }
  database.exec(`
    CREATE TABLE ${tableName} (
      entity_type TEXT NOT NULL
        CHECK (entity_type IN ('character', 'corporation', 'alliance')),
      entity_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      corporation_name TEXT,
      severity TEXT NOT NULL DEFAULT 'danger'
        CHECK (severity IN ('watch', 'danger', 'critical')),
      tags_json TEXT NOT NULL DEFAULT '[]',
      alert_sources_json TEXT NOT NULL DEFAULT '["local","system-killmail"]',
      sound_id TEXT
        CHECK (sound_id IS NULL OR sound_id IN ('default', 'warning', 'critical', 'radar')),
      volume REAL CHECK (volume IS NULL OR (volume >= 0 AND volume <= 1)),
      cooldown_seconds INTEGER NOT NULL DEFAULT 60
        CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 86400),
      note TEXT,
      alert_sound_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (alert_sound_enabled IN (0, 1)),
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );
  `)
}

function createWatchlistIndexes(database: Database.Database): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS pilot_watchlist_updated_at_idx
      ON pilot_watchlist (updated_at DESC);
    CREATE INDEX IF NOT EXISTS pilot_watchlist_entity_id_idx
      ON pilot_watchlist (entity_id);
  `)
}

function toEntry(row: PilotWatchlistRow): PilotWatchlistEntry {
  return {
    characterId: row.entity_id,
    entityType: validateEntityType(row.entity_type),
    entityId: validateEntityId(row.entity_id),
    name: row.name,
    corporationName: row.corporation_name,
    severity: validateSeverity(row.severity),
    tags: parseStoredTags(row.tags_json),
    alertSources: parseStoredSources(row.alert_sources_json, row.entity_type),
    soundId: validateSoundId(row.sound_id),
    volume: validateVolume(row.volume),
    cooldownSeconds: validateCooldown(row.cooldown_seconds),
    note: row.note,
    alertSoundEnabled: row.alert_sound_enabled === 1,
    addedAt: row.added_at,
    updatedAt: row.updated_at
  }
}

function resolveEntity(request: PilotWatchlistUpsertRequest): ResolvedEntity {
  const type = validateEntityType(request.entityType ?? 'character')
  const rawId = request.entityId ?? request.characterId
  const id = request.entityType === undefined && request.entityId === undefined
    ? validateLegacyCharacterId(rawId)
    : validateEntityId(rawId)
  if (
    request.entityId !== undefined &&
    request.characterId !== undefined &&
    request.entityId !== request.characterId
  ) {
    throw new TypeError('Entity ID and compatibility ID do not match')
  }
  return { type, id }
}

function validateLegacyCharacterId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError('Invalid pilot ID')
  }
  return Number(value)
}

function entityNameLabel(entityType: PilotWatchlistEntityType): string {
  if (entityType === 'corporation') return 'corporation name'
  if (entityType === 'alliance') return 'alliance name'
  return 'pilot name'
}

function validateEntityType(value: unknown): PilotWatchlistEntityType {
  if (typeof value === 'string' && PILOT_WATCHLIST_ENTITY_TYPES.includes(value as PilotWatchlistEntityType)) {
    return value as PilotWatchlistEntityType
  }
  throw new TypeError('Invalid entity type')
}

function validateEntityId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError('Invalid entity ID')
  }
  return Number(value)
}

function validateSeverity(value: unknown): PilotWatchlistSeverity {
  if (typeof value === 'string' && PILOT_WATCHLIST_SEVERITIES.includes(value as PilotWatchlistSeverity)) {
    return value as PilotWatchlistSeverity
  }
  throw new TypeError('Invalid danger level')
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new TypeError('Invalid watchlist tags')
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const rawTag of value) {
    const tag = validateRequiredText(rawTag, MAX_TAG_LENGTH, 'tag')
    const key = tag.toLocaleLowerCase('en-US')
    if (!seen.has(key)) {
      seen.add(key)
      result.push(tag)
    }
  }
  return result
}

function validateAlertSources(value: unknown): PilotWatchlistAlertSource[] {
  if (!Array.isArray(value) || value.length > PILOT_WATCHLIST_ALERT_SOURCES.length) {
    throw new TypeError('Invalid alert sources')
  }
  const result: PilotWatchlistAlertSource[] = []
  for (const source of value) {
    if (
      typeof source !== 'string' ||
      !PILOT_WATCHLIST_ALERT_SOURCES.includes(source as PilotWatchlistAlertSource) ||
      result.includes(source as PilotWatchlistAlertSource)
    ) {
      throw new TypeError('Invalid alert sources')
    }
    result.push(source as PilotWatchlistAlertSource)
  }
  return result
}

function validateAlertSourcesForEntity(
  value: unknown,
  entityType: PilotWatchlistEntityType
): PilotWatchlistAlertSource[] {
  const supported = getSupportedPilotWatchlistAlertSources(entityType)
  return validateAlertSources(value).filter((source) => supported.includes(source))
}

function defaultAlertSources(entityType: PilotWatchlistEntityType): PilotWatchlistAlertSource[] {
  const supported = getSupportedPilotWatchlistAlertSources(entityType)
  return LEGACY_WATCHLIST_ALERT_SOURCES.filter((source) => supported.includes(source))
}

function validateSoundId(value: unknown): PilotWatchlistSoundId | null {
  if (value === null) return null
  if (typeof value === 'string' && PILOT_WATCHLIST_SOUND_IDS.includes(value as PilotWatchlistSoundId)) {
    return value as PilotWatchlistSoundId
  }
  throw new TypeError('Invalid alert sound')
}

function validateVolume(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('Volume must be from 0 to 1')
  }
  return value
}

function validateCooldown(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_COOLDOWN_SECONDS) {
    throw new TypeError('Invalid alert cooldown')
  }
  return Number(value)
}

function parseStoredTags(value: string): string[] {
  try {
    return normalizeTags(JSON.parse(value))
  } catch {
    return []
  }
}

function parseStoredSources(
  value: string,
  entityType: PilotWatchlistEntityType = 'character'
): PilotWatchlistAlertSource[] {
  try {
    return validateAlertSourcesForEntity(JSON.parse(value), entityType)
  } catch {
    return defaultAlertSources(entityType)
  }
}

function validateRequiredText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid field: ${label}`)
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return trimmed
}

function validateOptionalText(
  value: string | null,
  maxLength: number,
  label: string
): string | null {
  if (value === null) return null
  return validateRequiredText(value, maxLength, label)
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`Invalid field: ${label}`)
  return value
}
