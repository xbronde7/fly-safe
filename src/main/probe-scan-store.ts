import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProbeSystemObservation } from '../shared/nearby-anomalies'

interface ProbeScanRow {
  solar_system_id: number
  system_name: string
  anomaly_count: number
  signature_count: number
  row_count: number
  rejected_count: number
  sites_json: string
  observed_at: string
}

export class ProbeScanStore {
  readonly databasePath: string
  private readonly database: Database.Database
  private closed = false

  constructor(databasePath: string) {
    this.databasePath = databasePath
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new Database(databasePath)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = NORMAL')
    this.database.pragma('busy_timeout = 5000')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS probe_system_snapshots (
        solar_system_id INTEGER PRIMARY KEY,
        system_name TEXT NOT NULL,
        anomaly_count INTEGER NOT NULL,
        signature_count INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        rejected_count INTEGER NOT NULL,
        sites_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS probe_system_snapshots_observed_idx
        ON probe_system_snapshots (observed_at DESC);
    `)
  }

  record(observation: ProbeSystemObservation): ProbeSystemObservation {
    this.assertOpen()
    validateObservation(observation)
    this.database.prepare(`
      INSERT INTO probe_system_snapshots (
        solar_system_id, system_name, anomaly_count, signature_count,
        row_count, rejected_count, sites_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(solar_system_id) DO UPDATE SET
        system_name = excluded.system_name,
        anomaly_count = excluded.anomaly_count,
        signature_count = excluded.signature_count,
        row_count = excluded.row_count,
        rejected_count = excluded.rejected_count,
        sites_json = excluded.sites_json,
        observed_at = excluded.observed_at
      WHERE excluded.observed_at >= probe_system_snapshots.observed_at
    `).run(
      observation.solarSystemId,
      observation.systemName,
      observation.anomalyCount,
      observation.signatureCount,
      observation.rowCount,
      observation.rejectedCount,
      JSON.stringify(observation.sites),
      observation.observedAt
    )
    return this.get(observation.solarSystemId)!
  }

  get(solarSystemId: number): ProbeSystemObservation | null {
    this.assertOpen()
    assertPositiveId(solarSystemId)
    const row = this.database.prepare(`
      SELECT solar_system_id, system_name, anomaly_count, signature_count,
             row_count, rejected_count, sites_json, observed_at
      FROM probe_system_snapshots
      WHERE solar_system_id = ?
    `).get(solarSystemId) as ProbeScanRow | undefined
    return row ? toObservation(row) : null
  }

  getMany(solarSystemIds: readonly number[]): Map<number, ProbeSystemObservation> {
    this.assertOpen()
    const uniqueIds = [...new Set(solarSystemIds)]
    if (uniqueIds.length === 0) return new Map()
    if (uniqueIds.length > 128) throw new RangeError('Too many Probe Scanner systems')
    for (const id of uniqueIds) assertPositiveId(id)
    const placeholders = uniqueIds.map(() => '?').join(', ')
    const rows = this.database.prepare(`
      SELECT solar_system_id, system_name, anomaly_count, signature_count,
             row_count, rejected_count, sites_json, observed_at
      FROM probe_system_snapshots
      WHERE solar_system_id IN (${placeholders})
    `).all(...uniqueIds) as ProbeScanRow[]
    return new Map(rows.map((row) => {
      const observation = toObservation(row)
      return [observation.solarSystemId, observation]
    }))
  }

  listRecent(limit = 48): ProbeSystemObservation[] {
    this.assertOpen()
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
      throw new RangeError('Probe Scanner history limit must be from 1 to 128')
    }
    const rows = this.database.prepare(`
      SELECT solar_system_id, system_name, anomaly_count, signature_count,
             row_count, rejected_count, sites_json, observed_at
      FROM probe_system_snapshots
      ORDER BY observed_at DESC, solar_system_id ASC
      LIMIT ?
    `).all(limit) as ProbeScanRow[]
    return rows.map(toObservation)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Probe Scan Store is already closed')
  }
}

function toObservation(row: ProbeScanRow): ProbeSystemObservation {
  let sites: ProbeSystemObservation['sites'] = []
  try {
    const parsed = JSON.parse(row.sites_json) as unknown
    if (Array.isArray(parsed)) {
      sites = parsed.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const candidate = entry as { name?: unknown; count?: unknown }
        return typeof candidate.name === 'string' && candidate.name.trim() &&
          Number.isSafeInteger(candidate.count) && (candidate.count as number) > 0
          ? [{ name: candidate.name, count: candidate.count as number }]
          : []
      })
    }
  } catch {
    sites = []
  }
  return {
    solarSystemId: row.solar_system_id,
    systemName: row.system_name,
    anomalyCount: row.anomaly_count,
    signatureCount: row.signature_count,
    rowCount: row.row_count,
    rejectedCount: row.rejected_count,
    sites,
    observedAt: row.observed_at
  }
}

function validateObservation(value: ProbeSystemObservation): void {
  assertPositiveId(value.solarSystemId)
  if (!value.systemName.trim() || value.systemName.length > 128) {
    throw new TypeError('Invalid Probe Scanner system name')
  }
  for (const count of [
    value.anomalyCount,
    value.signatureCount,
    value.rowCount,
    value.rejectedCount
  ]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('Invalid Probe Scanner count')
    }
  }
  if (value.anomalyCount + value.signatureCount > value.rowCount) {
    throw new TypeError('Probe Scanner counts are inconsistent')
  }
  if (!Number.isFinite(Date.parse(value.observedAt))) {
    throw new TypeError('Invalid Probe Scanner time')
  }
}

function assertPositiveId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Invalid solar-system ID')
  }
}
