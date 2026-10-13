import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  normalizeEncounterPilotName,
  validateEncounterPilotSearchQuery,
  validateEncounterRecentQuery,
  validateEncounterSnapshotInput,
  type EncounterDscanHull,
  type EncounterJournalPage,
  type EncounterLocalPilot,
  type EncounterPilotSearchPage,
  type EncounterSnapshot,
  type NormalizedEncounterSnapshotInput
} from '../shared/encounter-journal'

export const ENCOUNTER_STORE_DEFAULTS = {
  maxSnapshots: 10_000,
  retentionDays: 30
} as const

export interface EncounterJournalStoreOptions {
  maxSnapshots?: number
  retentionDays?: number
}

interface SnapshotRow {
  id: number
  captured_at: string
  recorded_at: string
  solar_system_id: number
  solar_system_name: string | null
  own_ship_type_id: number | null
  own_ship_type_name: string | null
  own_ship_custom_name: string | null
}

interface LocalPilotRow {
  character_id: number | null
  name: string
  corporation_name: string | null
}

interface AnalysisPilotRow extends LocalPilotRow {
  snapshot_id: number
  position: number
}

interface DscanHullRow {
  type_id: number | null
  type_name: string | null
  count: number
}

interface SearchRow extends SnapshotRow, LocalPilotRow {}

/**
 * Local-only encounter journal. Its fixed schema stores system/ship/Local/D-scan
 * observations and has no generic metadata or token column.
 */
export class EncounterJournalStore {
  readonly databasePath: string
  readonly maxSnapshots: number
  readonly retentionDays: number

  private readonly database: Database.Database
  private readonly now: () => number
  private closed = false

  constructor(
    databasePath: string,
    options: EncounterJournalStoreOptions = {},
    now: () => number = Date.now
  ) {
    if (typeof databasePath !== 'string' || !databasePath.trim()) {
      throw new TypeError('Invalid encounter-journal path')
    }
    this.databasePath = databasePath
    this.maxSnapshots = storeOption(
      options.maxSnapshots,
      ENCOUNTER_STORE_DEFAULTS.maxSnapshots,
      1,
      100_000,
      'snapshot limit'
    )
    this.retentionDays = storeOption(
      options.retentionDays,
      ENCOUNTER_STORE_DEFAULTS.retentionDays,
      1,
      3_650,
      'retention period'
    )
    this.now = now

    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new Database(databasePath)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = NORMAL')
    this.database.pragma('busy_timeout = 5000')
    this.database.pragma('foreign_keys = ON')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS encounter_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        solar_system_id INTEGER NOT NULL CHECK (solar_system_id > 0),
        solar_system_name TEXT,
        own_ship_type_id INTEGER CHECK (own_ship_type_id IS NULL OR own_ship_type_id > 0),
        own_ship_type_name TEXT,
        own_ship_custom_name TEXT
      );

      CREATE INDEX IF NOT EXISTS encounter_snapshots_time_idx
        ON encounter_snapshots (captured_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS encounter_snapshots_system_time_idx
        ON encounter_snapshots (solar_system_id, captured_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS encounter_local_pilots (
        snapshot_id INTEGER NOT NULL REFERENCES encounter_snapshots(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        character_id INTEGER CHECK (character_id IS NULL OR character_id > 0),
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        corporation_name TEXT,
        PRIMARY KEY (snapshot_id, position)
      );

      CREATE INDEX IF NOT EXISTS encounter_local_pilots_character_idx
        ON encounter_local_pilots (character_id, snapshot_id DESC);
      CREATE INDEX IF NOT EXISTS encounter_local_pilots_name_idx
        ON encounter_local_pilots (normalized_name, snapshot_id DESC);

      CREATE TABLE IF NOT EXISTS encounter_dscan_hulls (
        snapshot_id INTEGER NOT NULL REFERENCES encounter_snapshots(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        type_id INTEGER CHECK (type_id IS NULL OR type_id > 0),
        type_name TEXT,
        count INTEGER NOT NULL CHECK (count > 0),
        PRIMARY KEY (snapshot_id, position),
        CHECK (type_id IS NOT NULL OR type_name IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS encounter_dscan_hulls_type_idx
        ON encounter_dscan_hulls (type_id, snapshot_id DESC);
    `)
    this.prune()
  }

  record(input: unknown): EncounterSnapshot {
    this.assertOpen()
    const timestamp = validClock(this.now)
    const normalized = validateEncounterSnapshotInput(input, () => timestamp)
    const recordedAt = new Date(timestamp).toISOString()
    const retentionCutoff = timestamp - this.retentionDays * 86_400_000
    if (Date.parse(normalized.capturedAt) < retentionCutoff) {
      throw new TypeError('Snapshot is older than the configured retention period')
    }
    const id = this.database.transaction(() => {
      const result = this.database.prepare(`
        INSERT INTO encounter_snapshots (
          captured_at, recorded_at, solar_system_id, solar_system_name,
          own_ship_type_id, own_ship_type_name, own_ship_custom_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.capturedAt,
        recordedAt,
        normalized.currentSystem.solarSystemId,
        normalized.currentSystem.name,
        normalized.ownShip?.typeId ?? null,
        normalized.ownShip?.typeName ?? null,
        normalized.ownShip?.customName ?? null
      )
      const id = Number(result.lastInsertRowid)
      const insertPilot = this.database.prepare(`
        INSERT INTO encounter_local_pilots (
          snapshot_id, position, character_id, name, normalized_name, corporation_name
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      normalized.localPilots.forEach((pilot, position) => {
        insertPilot.run(
          id,
          position,
          pilot.characterId,
          pilot.name,
          normalizeEncounterPilotName(pilot.name),
          pilot.corporationName
        )
      })
      const insertHull = this.database.prepare(`
        INSERT INTO encounter_dscan_hulls (
          snapshot_id, position, type_id, type_name, count
        ) VALUES (?, ?, ?, ?, ?)
      `)
      normalized.dscanHulls.forEach((hull, position) => {
        insertHull.run(id, position, hull.typeId, hull.typeName, hull.count)
      })
      this.pruneInternal(timestamp, id)
      return id
    })()

    return this.hydrate(this.getSnapshotRow(id), normalized.localPilots, normalized.dscanHulls)
  }

  listRecent(queryInput: unknown = {}): EncounterJournalPage {
    this.assertOpen()
    const query = validateEncounterRecentQuery(queryInput)
    const conditions: string[] = []
    const values: Array<string | number> = []
    if (query.before !== null) {
      conditions.push('captured_at < ?')
      values.push(query.before)
    }
    if (query.solarSystemId !== null) {
      conditions.push('solar_system_id = ?')
      values.push(query.solarSystemId)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.database.prepare(`
      SELECT id, captured_at, recorded_at, solar_system_id, solar_system_name,
             own_ship_type_id, own_ship_type_name, own_ship_custom_name
      FROM encounter_snapshots
      ${where}
      ORDER BY captured_at DESC, id DESC
      LIMIT ?
    `).all(...values, query.limit + 1) as SnapshotRow[]
    const visible = rows.slice(0, query.limit)
    return {
      snapshots: visible.map((row) => this.hydrate(row)),
      hasMore: rows.length > visible.length
    }
  }

  /** Character ID is authoritative when both ID and name are supplied. */
  searchPilot(queryInput: unknown): EncounterPilotSearchPage {
    this.assertOpen()
    const query = validateEncounterPilotSearchQuery(queryInput)
    const conditions = [
      query.characterId !== null ? 'p.character_id = ?' : 'p.normalized_name = ?'
    ]
    const values: Array<string | number> = [query.characterId ?? query.normalizedName!]
    if (query.since !== null) {
      conditions.push('s.captured_at >= ?')
      values.push(query.since)
    }
    if (query.before !== null) {
      conditions.push('s.captured_at < ?')
      values.push(query.before)
    }
    const rows = this.database.prepare(`
      SELECT s.id, s.captured_at, s.recorded_at, s.solar_system_id,
             s.solar_system_name, s.own_ship_type_id, s.own_ship_type_name,
             s.own_ship_custom_name, p.character_id, p.name, p.corporation_name
      FROM encounter_local_pilots p
      JOIN encounter_snapshots s ON s.id = p.snapshot_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.captured_at DESC, s.id DESC
      LIMIT ?
    `).all(...values, query.limit + 1) as SearchRow[]
    const visible = rows.slice(0, query.limit)
    return {
      matches: visible.map((row) => ({
        snapshot: this.hydrate(row),
        matchedPilot: toLocalPilot(row)
      })),
      hasMore: rows.length > visible.length
    }
  }

  count(): number {
    this.assertOpen()
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM encounter_snapshots')
      .get() as { count: number }
    return row.count
  }

  /** Internal full-retention read for local analytics; never exposed as raw IPC data. */
  listForAnalysis(since?: string, limit = this.maxSnapshots): EncounterSnapshot[] {
    this.assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxSnapshots) {
      throw new TypeError('Invalid encounter-analytics limit')
    }
    let normalizedSince: string | null = null
    if (since !== undefined) {
      const timestamp = Date.parse(since)
      if (!Number.isFinite(timestamp)) throw new TypeError('Invalid encounter-analytics date')
      normalizedSince = new Date(timestamp).toISOString()
    }
    const rows = this.database.prepare(`
      SELECT id, captured_at, recorded_at, solar_system_id, solar_system_name,
             own_ship_type_id, own_ship_type_name, own_ship_custom_name
      FROM encounter_snapshots
      ${normalizedSince === null ? '' : 'WHERE captured_at >= ?'}
      ORDER BY captured_at DESC, id DESC
      LIMIT ?
    `).all(...(normalizedSince === null ? [limit] : [normalizedSince, limit])) as SnapshotRow[]
    if (rows.length === 0) return []

    const pilotsBySnapshot = new Map<number, EncounterLocalPilot[]>()
    for (let offset = 0; offset < rows.length; offset += 500) {
      const ids = rows.slice(offset, offset + 500).map((row) => row.id)
      const placeholders = ids.map(() => '?').join(', ')
      const pilots = this.database.prepare(`
        SELECT snapshot_id, position, character_id, name, corporation_name
        FROM encounter_local_pilots
        WHERE snapshot_id IN (${placeholders})
        ORDER BY snapshot_id ASC, position ASC
      `).all(...ids) as AnalysisPilotRow[]
      for (const pilot of pilots) {
        const list = pilotsBySnapshot.get(pilot.snapshot_id) ?? []
        list.push(toLocalPilot(pilot))
        pilotsBySnapshot.set(pilot.snapshot_id, list)
      }
    }
    return rows.map((row) => this.hydrate(row, pilotsBySnapshot.get(row.id) ?? [], []))
  }

  /** Applies both age and hard-count retention and returns deleted snapshots. */
  prune(): number {
    this.assertOpen()
    return this.pruneInternal(validClock(this.now))
  }

  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  private pruneInternal(referenceTime: number, protectedId: number | null = null): number {
    const cutoff = new Date(referenceTime - this.retentionDays * 86_400_000).toISOString()
    const expired = protectedId === null
      ? this.database.prepare(`
          DELETE FROM encounter_snapshots
          WHERE captured_at < ?
        `).run(cutoff).changes
      : this.database.prepare(`
          DELETE FROM encounter_snapshots
          WHERE captured_at < ? AND id <> ?
        `).run(cutoff, protectedId).changes
    const beyondCap = protectedId === null
      ? this.database.prepare(`
          DELETE FROM encounter_snapshots
          WHERE id IN (
            SELECT id
            FROM encounter_snapshots
            ORDER BY captured_at DESC, id DESC
            LIMIT -1 OFFSET ?
          )
        `).run(this.maxSnapshots).changes
      : this.database.prepare(`
          DELETE FROM encounter_snapshots
          WHERE id <> ? AND id IN (
            SELECT id
            FROM encounter_snapshots
            WHERE id <> ?
            ORDER BY captured_at DESC, id DESC
            LIMIT -1 OFFSET ?
          )
        `).run(protectedId, protectedId, this.maxSnapshots - 1).changes
    return expired + beyondCap
  }

  private getSnapshotRow(id: number): SnapshotRow {
    const row = this.database.prepare(`
      SELECT id, captured_at, recorded_at, solar_system_id, solar_system_name,
             own_ship_type_id, own_ship_type_name, own_ship_custom_name
      FROM encounter_snapshots
      WHERE id = ?
    `).get(id) as SnapshotRow | undefined
    if (!row) throw new Error('Encounter snapshot not found after saving')
    return row
  }

  private hydrate(
    row: SnapshotRow,
    knownPilots?: EncounterLocalPilot[],
    knownHulls?: EncounterDscanHull[]
  ): EncounterSnapshot {
    const localPilots = knownPilots ?? (this.database.prepare(`
      SELECT character_id, name, corporation_name
      FROM encounter_local_pilots
      WHERE snapshot_id = ?
      ORDER BY position ASC
    `).all(row.id) as LocalPilotRow[]).map(toLocalPilot)
    const dscanHulls = knownHulls ?? (this.database.prepare(`
      SELECT type_id, type_name, count
      FROM encounter_dscan_hulls
      WHERE snapshot_id = ?
      ORDER BY position ASC
    `).all(row.id) as DscanHullRow[]).map(toDscanHull)

    return {
      id: row.id,
      capturedAt: row.captured_at,
      recordedAt: row.recorded_at,
      currentSystem: {
        solarSystemId: row.solar_system_id,
        name: row.solar_system_name
      },
      ownShip: row.own_ship_type_id === null
        ? null
        : {
            typeId: row.own_ship_type_id,
            typeName: row.own_ship_type_name,
            customName: row.own_ship_custom_name
          },
      localPilots,
      dscanHulls
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Encounter journal is already closed')
  }
}

function toLocalPilot(row: LocalPilotRow): EncounterLocalPilot {
  return {
    characterId: row.character_id,
    name: row.name,
    corporationName: row.corporation_name
  }
}

function toDscanHull(row: DscanHullRow): EncounterDscanHull {
  return {
    typeId: row.type_id,
    typeName: row.type_name,
    count: row.count
  }
}

function storeOption(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return value
}

function validClock(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value)) throw new TypeError('Invalid system clock')
  return value
}
