import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  extractWormholeProbeSignatures,
  findWormholeRouteHome,
  parseWormholeStatusText,
  type WormholeChain,
  type WormholeConnection,
  type WormholeHomeRoute,
  type WormholeLifeStatus,
  type WormholeMassStatus,
  type WormholeConnectionUpsertInput,
  type WormholeSignatureObservation,
  type WormholeSystemUpsertInput,
  type WormholeSystemNode
} from '../shared/wormhole-chain'
import type { ProbeRow } from '../shared/clipboard-intel'

interface SystemRow {
  id: string
  solar_system_id: number | null
  name: string
  is_home: number
  first_seen_at: string
  last_seen_at: string
}

interface SignatureRow {
  source_system_node_id: string
  signature_id: string
  group_name: string
  type_name: string | null
  wormhole_code: string | null
  display_name: string | null
  signal_strength: number | null
  distance_meters: number | null
  observed_at: string
}

interface ConnectionRow {
  id: string
  from_system_node_id: string
  to_system_node_id: string
  from_signature_id: string | null
  reverse_signature_id: string | null
  wormhole_code: string | null
  mass_status: WormholeMassStatus
  life_status: WormholeLifeStatus
  discovered_at: string
  updated_at: string
  expires_at: string | null
}

/** Local persistent wormhole map. Contains no SSO or ESI tokens. */
export class WormholeChainStore {
  readonly databasePath: string

  private readonly database: Database.Database
  private readonly now: () => number
  private closed = false

  constructor(databasePath: string, now: () => number = Date.now) {
    if (typeof databasePath !== 'string' || !databasePath.trim()) {
      throw new TypeError('Invalid wormhole-map path')
    }
    this.databasePath = databasePath
    this.now = now
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new Database(databasePath)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = NORMAL')
    this.database.pragma('busy_timeout = 5000')
    this.database.pragma('foreign_keys = ON')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS wormhole_systems (
        id TEXT PRIMARY KEY,
        solar_system_id INTEGER UNIQUE CHECK (solar_system_id IS NULL OR solar_system_id > 0),
        name TEXT NOT NULL,
        is_home INTEGER NOT NULL DEFAULT 0 CHECK (is_home IN (0, 1)),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS wormhole_systems_home_idx
        ON wormhole_systems (is_home, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS wormhole_signatures (
        source_system_node_id TEXT NOT NULL REFERENCES wormhole_systems(id) ON DELETE CASCADE,
        signature_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        type_name TEXT,
        wormhole_code TEXT,
        display_name TEXT,
        signal_strength REAL CHECK (
          signal_strength IS NULL OR (signal_strength >= 0 AND signal_strength <= 100)
        ),
        distance_meters REAL CHECK (distance_meters IS NULL OR distance_meters >= 0),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (source_system_node_id, signature_id)
      );

      CREATE INDEX IF NOT EXISTS wormhole_signatures_observed_idx
        ON wormhole_signatures (observed_at DESC);

      CREATE TABLE IF NOT EXISTS wormhole_connections (
        id TEXT PRIMARY KEY,
        from_system_node_id TEXT NOT NULL REFERENCES wormhole_systems(id) ON DELETE CASCADE,
        to_system_node_id TEXT NOT NULL REFERENCES wormhole_systems(id) ON DELETE CASCADE,
        from_signature_id TEXT,
        reverse_signature_id TEXT,
        wormhole_code TEXT,
        mass_status TEXT NOT NULL,
        life_status TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        CHECK (from_system_node_id <> to_system_node_id),
        CHECK (mass_status IN ('stable', 'reduced', 'critical', 'collapsed', 'unknown')),
        CHECK (life_status IN ('stable', 'end-of-life', 'collapsed', 'unknown'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS wormhole_connections_signature_idx
        ON wormhole_connections (from_system_node_id, from_signature_id)
        WHERE from_signature_id IS NOT NULL;
    `)
  }

  upsertSystem(input: WormholeSystemUpsertInput): WormholeSystemNode {
    this.assertOpen()
    const value = normalizeSystemInput(input, this.clockIso())
    const bySolarSystem = value.solarSystemId === null
      ? undefined
      : this.database.prepare(`
          SELECT id, solar_system_id, name, is_home, first_seen_at, last_seen_at
          FROM wormhole_systems WHERE solar_system_id = ?
        `).get(value.solarSystemId) as SystemRow | undefined
    if (bySolarSystem && value.id !== null && value.id !== bySolarSystem.id) {
      throw new TypeError(`Solar system is already linked to node: ${bySolarSystem.id}`)
    }
    const id = value.id ?? bySolarSystem?.id ?? (
      value.solarSystemId === null ? `chain:${randomUUID()}` : `eve:${value.solarSystemId}`
    )
    const existing = this.getSystemRow(id, false)
    const firstSeenAt = earlierTimestamp(existing?.first_seen_at, value.seenAt)
    const lastSeenAt = laterTimestamp(existing?.last_seen_at, value.seenAt)
    const isHome = value.isHome ?? (existing?.is_home === 1)

    this.database.transaction(() => {
      if (isHome) this.database.prepare('UPDATE wormhole_systems SET is_home = 0').run()
      this.database.prepare(`
        INSERT INTO wormhole_systems (
          id, solar_system_id, name, is_home, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          solar_system_id = excluded.solar_system_id,
          name = excluded.name,
          is_home = excluded.is_home,
          first_seen_at = excluded.first_seen_at,
          last_seen_at = excluded.last_seen_at
      `).run(
        id,
        value.solarSystemId ?? existing?.solar_system_id ?? null,
        value.name,
        isHome ? 1 : 0,
        firstSeenAt,
        lastSeenAt
      )
    })()
    return toSystem(this.getSystemRow(id))
  }

  setHome(systemNodeId: string): WormholeSystemNode {
    this.assertOpen()
    const id = identifier(systemNodeId, 'Home-system ID')
    this.getSystemRow(id)
    this.database.transaction(() => {
      this.database.prepare('UPDATE wormhole_systems SET is_home = 0').run()
      this.database.prepare('UPDATE wormhole_systems SET is_home = 1 WHERE id = ?').run(id)
    })()
    return toSystem(this.getSystemRow(id))
  }

  recordProbeScan(
    sourceSystemNodeId: string,
    rows: readonly ProbeRow[],
    observedAt: string = this.clockIso()
  ): WormholeSignatureObservation[] {
    this.assertOpen()
    const source = identifier(sourceSystemNodeId, 'Source-system ID')
    this.getSystemRow(source)
    const timestamp = isoTimestamp(observedAt, 'scan time')
    const observations = extractWormholeProbeSignatures(rows, {
      sourceSystemNodeId: source,
      observedAt: timestamp
    })
    const statement = this.database.prepare(`
      INSERT INTO wormhole_signatures (
        source_system_node_id, signature_id, group_name, type_name, wormhole_code,
        display_name, signal_strength, distance_meters, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_system_node_id, signature_id) DO UPDATE SET
        group_name = excluded.group_name,
        type_name = excluded.type_name,
        wormhole_code = COALESCE(excluded.wormhole_code, wormhole_signatures.wormhole_code),
        display_name = excluded.display_name,
        signal_strength = excluded.signal_strength,
        distance_meters = excluded.distance_meters,
        observed_at = excluded.observed_at
    `)
    this.database.transaction(() => {
      for (const observation of observations) {
        statement.run(
          observation.sourceSystemNodeId,
          observation.signatureId,
          observation.group,
          observation.typeName,
          observation.wormholeCode,
          observation.name,
          observation.signalStrength,
          observation.distanceMeters,
          observation.observedAt
        )
      }
      this.database.prepare(`
        UPDATE wormhole_systems SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?
      `).run(timestamp, source)
    })()
    return observations
  }

  upsertConnection(input: WormholeConnectionUpsertInput): WormholeConnection {
    this.assertOpen()
    const value = normalizeConnectionInput(input, this.clockIso())
    this.getSystemRow(value.fromSystemNodeId)
    this.getSystemRow(value.toSystemNodeId)
    const bySignature = typeof value.fromSignatureId !== 'string'
      ? undefined
      : this.database.prepare(`
          SELECT id, from_system_node_id, to_system_node_id, from_signature_id,
                 reverse_signature_id, wormhole_code, mass_status, life_status,
                 discovered_at, updated_at, expires_at
          FROM wormhole_connections
          WHERE from_system_node_id = ? AND from_signature_id = ?
        `).get(value.fromSystemNodeId, value.fromSignatureId) as ConnectionRow | undefined
    const id = value.id ?? bySignature?.id ?? `connection:${randomUUID()}`
    const existing = this.getConnectionRow(id, false)
    const discoveredAt = earlierTimestamp(existing?.discovered_at, value.discoveredAt)
    const updatedAt = laterTimestamp(existing?.updated_at, value.updatedAt)

    this.database.prepare(`
      INSERT INTO wormhole_connections (
        id, from_system_node_id, to_system_node_id, from_signature_id,
        reverse_signature_id, wormhole_code, mass_status, life_status,
        discovered_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        from_system_node_id = excluded.from_system_node_id,
        to_system_node_id = excluded.to_system_node_id,
        from_signature_id = excluded.from_signature_id,
        reverse_signature_id = excluded.reverse_signature_id,
        wormhole_code = excluded.wormhole_code,
        mass_status = excluded.mass_status,
        life_status = excluded.life_status,
        discovered_at = excluded.discovered_at,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(
      id,
      value.fromSystemNodeId,
      value.toSystemNodeId,
      value.fromSignatureId === undefined
        ? existing?.from_signature_id ?? null
        : value.fromSignatureId,
      value.reverseSignatureId === undefined
        ? existing?.reverse_signature_id ?? null
        : value.reverseSignatureId,
      value.wormholeCode === undefined
        ? existing?.wormhole_code ?? null
        : value.wormholeCode,
      value.massStatus ?? existing?.mass_status ?? 'unknown',
      value.lifeStatus ?? existing?.life_status ?? 'unknown',
      discoveredAt,
      updatedAt,
      value.expiresAt === undefined ? existing?.expires_at ?? null : value.expiresAt
    )
    return toConnection(this.getConnectionRow(id))
  }

  updateConnectionStatusFromText(
    connectionId: string,
    statusText: string,
    updatedAt: string = this.clockIso()
  ): WormholeConnection {
    this.assertOpen()
    const id = identifier(connectionId, 'Connection ID')
    const existing = toConnection(this.getConnectionRow(id))
    const reading = parseWormholeStatusText(statusText)
    return this.upsertConnection({
      ...existing,
      massStatus: reading.massStatus === 'unknown' ? existing.massStatus : reading.massStatus,
      lifeStatus: reading.lifeStatus === 'unknown' ? existing.lifeStatus : reading.lifeStatus,
      updatedAt
    })
  }

  getChain(): WormholeChain {
    this.assertOpen()
    const systems = (this.database.prepare(`
      SELECT id, solar_system_id, name, is_home, first_seen_at, last_seen_at
      FROM wormhole_systems ORDER BY is_home DESC, name COLLATE NOCASE ASC, id ASC
    `).all() as SystemRow[]).map(toSystem)
    const signatures = (this.database.prepare(`
      SELECT source_system_node_id, signature_id, group_name, type_name, wormhole_code,
             display_name, signal_strength, distance_meters, observed_at
      FROM wormhole_signatures
      ORDER BY source_system_node_id ASC, signature_id ASC
    `).all() as SignatureRow[]).map(toSignature)
    const connections = (this.database.prepare(`
      SELECT id, from_system_node_id, to_system_node_id, from_signature_id,
             reverse_signature_id, wormhole_code, mass_status, life_status,
             discovered_at, updated_at, expires_at
      FROM wormhole_connections ORDER BY discovered_at ASC, id ASC
    `).all() as ConnectionRow[]).map(toConnection)
    return { systems, signatures, connections }
  }

  findRouteHome(
    startSystemNodeId: string,
    at: string = this.clockIso()
  ): WormholeHomeRoute | null {
    return findWormholeRouteHome(this.getChain(), startSystemNodeId, at)
  }

  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  private getSystemRow(id: string, required?: true): SystemRow
  private getSystemRow(id: string, required: false): SystemRow | undefined
  private getSystemRow(id: string, required = true): SystemRow | undefined {
    const row = this.database.prepare(`
      SELECT id, solar_system_id, name, is_home, first_seen_at, last_seen_at
      FROM wormhole_systems WHERE id = ?
    `).get(id) as SystemRow | undefined
    if (!row && required) throw new TypeError(`Chain system not found: ${id}`)
    return row
  }

  private getConnectionRow(id: string, required?: true): ConnectionRow
  private getConnectionRow(id: string, required: false): ConnectionRow | undefined
  private getConnectionRow(id: string, required = true): ConnectionRow | undefined {
    const row = this.database.prepare(`
      SELECT id, from_system_node_id, to_system_node_id, from_signature_id,
             reverse_signature_id, wormhole_code, mass_status, life_status,
             discovered_at, updated_at, expires_at
      FROM wormhole_connections WHERE id = ?
    `).get(id) as ConnectionRow | undefined
    if (!row && required) throw new TypeError(`Connection not found: ${id}`)
    return row
  }

  private clockIso(): string {
    const value = this.now()
    if (!Number.isFinite(value)) throw new TypeError('Invalid system clock')
    return new Date(value).toISOString()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Wormhole map is already closed')
  }
}

function normalizeSystemInput(
  input: WormholeSystemUpsertInput,
  fallbackTimestamp: string
): {
  id: string | null
  solarSystemId: number | null
  name: string
  isHome: boolean | undefined
  seenAt: string
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid chain system')
  }
  const id = input.id === undefined ? null : identifier(input.id, 'Chain-system ID')
  const solarSystemId = input.solarSystemId === undefined || input.solarSystemId === null
    ? null
    : positiveInteger(input.solarSystemId, 'Solar-system ID')
  const name = text(input.name, 128, 'system name')
  if (input.isHome !== undefined && typeof input.isHome !== 'boolean') {
    throw new TypeError('Invalid field: home system')
  }
  return {
    id,
    solarSystemId,
    name,
    isHome: input.isHome,
    seenAt: isoTimestamp(input.seenAt ?? fallbackTimestamp, 'system seen time')
  }
}

function normalizeConnectionInput(
  input: WormholeConnectionUpsertInput,
  fallbackTimestamp: string
): {
  id: string | null
  fromSystemNodeId: string
  toSystemNodeId: string
  fromSignatureId: string | null | undefined
  reverseSignatureId: string | null | undefined
  wormholeCode: string | null | undefined
  massStatus: WormholeMassStatus | undefined
  lifeStatus: WormholeLifeStatus | undefined
  discoveredAt: string
  updatedAt: string
  expiresAt: string | null | undefined
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Invalid chain connection')
  }
  const fromSystemNodeId = identifier(input.fromSystemNodeId, 'connection source system')
  const toSystemNodeId = identifier(input.toSystemNodeId, 'connection destination system')
  if (fromSystemNodeId === toSystemNodeId) throw new TypeError('Connection requires two systems')
  const discoveredAt = isoTimestamp(input.discoveredAt ?? fallbackTimestamp, 'discovery time')
  const updatedAt = isoTimestamp(input.updatedAt ?? fallbackTimestamp, 'update time')
  const expiresAt = input.expiresAt === undefined
    ? undefined
    : input.expiresAt === null
      ? null
      : isoTimestamp(input.expiresAt, 'connection lifetime')
  return {
    id: input.id === undefined ? null : identifier(input.id, 'Connection ID'),
    fromSystemNodeId,
    toSystemNodeId,
    fromSignatureId: input.fromSignatureId === undefined
      ? undefined
      : signatureId(input.fromSignatureId),
    reverseSignatureId: input.reverseSignatureId === undefined
      ? undefined
      : signatureId(input.reverseSignatureId),
    wormholeCode: input.wormholeCode === undefined
      ? undefined
      : wormholeCode(input.wormholeCode),
    massStatus: enumValue(
      input.massStatus,
      ['stable', 'reduced', 'critical', 'collapsed', 'unknown'],
      'mass status'
    ),
    lifeStatus: enumValue(
      input.lifeStatus,
      ['stable', 'end-of-life', 'collapsed', 'unknown'],
      'lifetime status'
    ),
    discoveredAt,
    updatedAt,
    expiresAt
  }
}

function toSystem(row: SystemRow): WormholeSystemNode {
  return {
    id: row.id,
    solarSystemId: row.solar_system_id,
    name: row.name,
    isHome: row.is_home === 1,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  }
}

function toSignature(row: SignatureRow): WormholeSignatureObservation {
  return {
    sourceSystemNodeId: row.source_system_node_id,
    signatureId: row.signature_id,
    group: row.group_name,
    typeName: row.type_name,
    wormholeCode: row.wormhole_code,
    name: row.display_name,
    signalStrength: row.signal_strength,
    distanceMeters: row.distance_meters,
    observedAt: row.observed_at
  }
}

function toConnection(row: ConnectionRow): WormholeConnection {
  return {
    id: row.id,
    fromSystemNodeId: row.from_system_node_id,
    toSystemNodeId: row.to_system_node_id,
    fromSignatureId: row.from_signature_id,
    reverseSignatureId: row.reverse_signature_id,
    wormholeCode: row.wormhole_code,
    massStatus: row.mass_status,
    lifeStatus: row.life_status,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  }
}

function signatureId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const result = text(value, 7, 'Signature ID').toUpperCase()
  if (!/^[A-Z]{3}-\d{3}$/.test(result)) throw new TypeError('Invalid field: signature ID')
  return result
}

function wormholeCode(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const result = text(value, 4, 'wormhole code').toUpperCase()
  if (!/^(?:K162|[A-Z]\d{3})$/.test(result)) throw new TypeError('Invalid field: wormhole code')
  return result
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return value as T
}

function earlierTimestamp(left: string | undefined, right: string): string {
  return left === undefined || Date.parse(right) < Date.parse(left) ? right : left
}

function laterTimestamp(left: string | undefined, right: string): string {
  return left === undefined || Date.parse(right) > Date.parse(left) ? right : left
}

function identifier(value: unknown, label: string): string {
  return text(value, 128, label)
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid field: ${label}`)
  const result = value
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
  if (!result || result.length > maximum) throw new TypeError(`Invalid field: ${label}`)
  return result
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return value
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Invalid field: ${label}`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid field: ${label}`)
  return new Date(parsed).toISOString()
}
