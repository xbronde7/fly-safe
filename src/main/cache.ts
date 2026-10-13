import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { validLedgerTransaction } from '../shared/industry-ledger'
import type { EconomyTransactionRow } from '../shared/personal-economy'

export const CACHE_TTL = {
  characterIds: 7 * 24 * 60 * 60 * 1_000,
  solarSystemIds: 30 * 24 * 60 * 60 * 1_000,
  affiliations: 24 * 60 * 60 * 1_000,
  universeNames: 24 * 60 * 60 * 1_000,
  zkillStats: 6 * 60 * 60 * 1_000,
  zkillHistory: 60 * 60 * 1_000,
  zkillSystemHistory: 60 * 60 * 1_000,
  esiKillmail: 30 * 24 * 60 * 60 * 1_000,
  universeSystem: 7 * 24 * 60 * 60 * 1_000,
  universeStargate: 30 * 24 * 60 * 60 * 1_000,
  universeConstellation: 7 * 24 * 60 * 60 * 1_000,
  universeRegion: 7 * 24 * 60 * 60 * 1_000,
  systemKills: 60 * 60 * 1_000,
  systemJumps: 60 * 60 * 1_000
} as const

export const CACHE_SCOPES = {
  characterIds: 'esi:character-id',
  solarSystemIds: 'esi:solar-system-id',
  affiliations: 'esi:affiliation',
  universeNames: 'esi:universe-name',
  // v3 uses role-safe group classification and excludes `other` from coverage.
  zkillStats: 'zkill:stats:v3',
  zkillHistory: 'zkill:history:v1',
  zkillSystemHistory: 'zkill:system-history:v1',
  esiKillmail: 'esi:killmail:v1',
  // v2 includes the stargate IDs required for bounded nearby-system discovery.
  universeSystem: 'esi:universe-system:v2',
  universeStargate: 'esi:universe-stargate:v1',
  universeConstellation: 'esi:universe-constellation:v1',
  universeRegion: 'esi:universe-region:v1',
  systemKills: 'esi:system-kills:v1',
  systemJumps: 'esi:system-jumps:v1'
} as const

export interface CacheHit<T> {
  value: T
  createdAt: number
  expiresAt: number
}

export interface CacheStats {
  entries: number
  databasePath: string
}

interface CacheRow {
  value_json: string
  created_at: number
  expires_at: number
}

/**
 * Small namespaced JSON cache backed by SQLite.
 *
 * Expired and malformed rows are treated as misses and removed immediately.
 * Callers only write successful API responses, so transient HTTP errors never
 * poison subsequent scans.
 */
export class Cache {
  readonly databasePath: string

  private readonly database: Database.Database
  private readonly selectStatement: Database.Statement<[string, string], CacheRow>
  private readonly upsertStatement: Database.Statement
  private readonly deleteStatement: Database.Statement<[string, string]>
  private readonly deleteExpiredStatement: Database.Statement<[number]>
  private readonly clearStatement: Database.Statement
  private readonly countStatement: Database.Statement<[], { count: number }>
  private closed = false

  constructor(databasePath: string) {
    this.databasePath = databasePath

    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true })
    }

    this.database = new Database(databasePath)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = NORMAL')
    this.database.pragma('busy_timeout = 5000')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        scope TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (scope, cache_key)
      );

      CREATE INDEX IF NOT EXISTS cache_entries_expires_at_idx
        ON cache_entries (expires_at);
      CREATE TABLE IF NOT EXISTS industry_wallet_transactions (
        character_id INTEGER NOT NULL,
        transaction_id INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (character_id, transaction_id)
      );
      CREATE TABLE IF NOT EXISTS industry_wallet_sync (
        character_id INTEGER PRIMARY KEY,
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS industry_records (
        character_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        record_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (character_id, kind, record_key)
      );
    `)

    this.selectStatement = this.database.prepare(
      `SELECT value_json, created_at, expires_at
       FROM cache_entries
       WHERE scope = ? AND cache_key = ?`
    )
    this.upsertStatement = this.database.prepare(
      `INSERT INTO cache_entries (scope, cache_key, value_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, cache_key) DO UPDATE SET
         value_json = excluded.value_json,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    )
    this.deleteStatement = this.database.prepare(
      'DELETE FROM cache_entries WHERE scope = ? AND cache_key = ?'
    )
    this.deleteExpiredStatement = this.database.prepare(
      'DELETE FROM cache_entries WHERE expires_at <= ?'
    )
    this.clearStatement = this.database.prepare('DELETE FROM cache_entries')
    this.countStatement = this.database.prepare(
      'SELECT COUNT(*) AS count FROM cache_entries'
    )
  }

  get<T>(scope: string, key: string, now = Date.now()): CacheHit<T> | null {
    this.assertOpen()
    const row = this.selectStatement.get(scope, key)
    if (!row) return null

    if (row.expires_at <= now) {
      this.deleteStatement.run(scope, key)
      return null
    }

    try {
      return {
        value: JSON.parse(row.value_json) as T,
        createdAt: row.created_at,
        expiresAt: row.expires_at
      }
    } catch {
      this.deleteStatement.run(scope, key)
      return null
    }
  }

  set<T>(scope: string, key: string, value: T, ttlMs: number, now = Date.now()): void {
    this.assertOpen()
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError('Cache TTL must be a positive finite number')
    }

    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw new TypeError('Cache value must be JSON serializable')
    }

    this.upsertStatement.run(scope, key, serialized, now, now + ttlMs)
  }

  delete(scope: string, key: string): boolean {
    this.assertOpen()
    return this.deleteStatement.run(scope, key).changes > 0
  }

  purgeExpired(now = Date.now()): number {
    this.assertOpen()
    return this.deleteExpiredStatement.run(now).changes
  }

  clear(): void {
    this.assertOpen()
    this.clearStatement.run()
  }

  count(): number {
    this.assertOpen()
    this.purgeExpired()
    return this.countStatement.get()?.count ?? 0
  }

  stats(): CacheStats {
    return {
      entries: this.count(),
      databasePath: this.databasePath
    }
  }

  saveIndustryTransactions(characterId: number, rows: readonly EconomyTransactionRow[], syncedAt: string): void {
    this.assertOpen()
    if (!Number.isSafeInteger(characterId) || characterId <= 0 || !Number.isFinite(Date.parse(syncedAt)) || rows.some(row => !validLedgerTransaction(row))) throw new TypeError('Invalid wallet ledger data')
    const insert = this.database.prepare('INSERT OR IGNORE INTO industry_wallet_transactions (character_id, transaction_id, value_json) VALUES (?, ?, ?)')
    const sync = this.database.prepare('INSERT INTO industry_wallet_sync (character_id, synced_at) VALUES (?, ?) ON CONFLICT(character_id) DO UPDATE SET synced_at = excluded.synced_at')
    this.database.transaction(() => {
      for (const row of rows) if (row.personal) insert.run(characterId, row.transactionId, JSON.stringify(row))
      sync.run(characterId, syncedAt)
    })()
  }

  getIndustryTransactions(characterId: number): { transactions: EconomyTransactionRow[]; syncedAt: string | null } {
    this.assertOpen()
    if (!Number.isSafeInteger(characterId) || characterId <= 0) throw new TypeError('Invalid ledger character')
    const rows = this.database.prepare('SELECT value_json FROM industry_wallet_transactions WHERE character_id = ?').all(characterId) as Array<{ value_json: string }>
    const transactions = rows.map(row => JSON.parse(row.value_json) as EconomyTransactionRow).filter(validLedgerTransaction)
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.transactionId - a.transactionId)
    const sync = this.database.prepare('SELECT synced_at FROM industry_wallet_sync WHERE character_id = ?').get(characterId) as { synced_at: string } | undefined
    return { transactions, syncedAt: sync?.synced_at ?? null }
  }

  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  getIndustryRecords<T>(characterId: number, kind: string): Array<{ key: string; value: T }> {
    this.assertOpen()
    const rows = this.database.prepare('SELECT record_key, value_json FROM industry_records WHERE character_id = ? AND kind = ?').all(characterId, kind) as Array<{ record_key: string; value_json: string }>
    return rows.flatMap(row => { try { return [{ key: row.record_key, value: JSON.parse(row.value_json) as T }] } catch { return [] } })
  }

  saveIndustryRecord(characterId: number, kind: string, key: string, value: unknown): void {
    this.assertOpen()
    if (!Number.isSafeInteger(characterId) || characterId <= 0 || !['monitor-config', 'monitor-seen', 'production-job', 'production-cost'].includes(kind) || !key || key.length > 100) throw new TypeError('Invalid industry record')
    this.database.prepare('INSERT INTO industry_records (character_id, kind, record_key, value_json) VALUES (?, ?, ?, ?) ON CONFLICT(character_id, kind, record_key) DO UPDATE SET value_json = excluded.value_json').run(characterId, kind, key, JSON.stringify(value))
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Cache is closed')
  }
}

export { Cache as IntelCache }
