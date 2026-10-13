import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  validateDoctrineTemplateInput,
  type DoctrineHullRequirement,
  type DoctrineRoleRequirement,
  type DoctrineTemplate
} from '../shared/doctrine-matcher'
import type { DscanShipRole } from '../shared/clipboard-intel'

interface TemplateRow {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
}

interface RoleRow {
  role: DscanShipRole
  minimum_count: number
  target_count: number
  maximum_count: number | null
}

interface HullRow {
  type_name: string
  normalized_type_name: string
  minimum_count: number
  target_count: number
  maximum_count: number | null
}

/** Local saved doctrine templates with normalized role and hull requirements. */
export class DoctrineTemplateStore {
  readonly databasePath: string

  private readonly database: Database.Database
  private readonly now: () => number
  private closed = false

  constructor(databasePath: string, now: () => number = Date.now) {
    if (typeof databasePath !== 'string' || !databasePath.trim()) {
      throw new TypeError('Invalid doctrine-store path')
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
      CREATE TABLE IF NOT EXISTS doctrine_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS doctrine_templates_updated_idx
        ON doctrine_templates (updated_at DESC, name COLLATE NOCASE ASC);

      CREATE TABLE IF NOT EXISTS doctrine_role_requirements (
        doctrine_id TEXT NOT NULL REFERENCES doctrine_templates(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        role TEXT NOT NULL,
        minimum_count INTEGER NOT NULL CHECK (minimum_count >= 0),
        target_count INTEGER NOT NULL CHECK (target_count >= minimum_count),
        maximum_count INTEGER CHECK (maximum_count IS NULL OR maximum_count >= target_count),
        PRIMARY KEY (doctrine_id, position),
        UNIQUE (doctrine_id, role)
      );

      CREATE TABLE IF NOT EXISTS doctrine_hull_requirements (
        doctrine_id TEXT NOT NULL REFERENCES doctrine_templates(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        type_name TEXT NOT NULL,
        normalized_type_name TEXT NOT NULL,
        minimum_count INTEGER NOT NULL CHECK (minimum_count >= 0),
        target_count INTEGER NOT NULL CHECK (target_count >= minimum_count),
        maximum_count INTEGER CHECK (maximum_count IS NULL OR maximum_count >= target_count),
        PRIMARY KEY (doctrine_id, position),
        UNIQUE (doctrine_id, normalized_type_name)
      );
    `)
  }

  save(input: unknown): DoctrineTemplate {
    this.assertOpen()
    const rawId = readCandidateId(input)
    const fallbackId = rawId ?? `doctrine:${randomUUID()}`
    const existing = rawId === null ? undefined : this.get(rawId, false)
    const timestamp = this.clockIso()
    const template = validateDoctrineTemplateInput(input, {
      id: fallbackId,
      now: timestamp,
      createdAt: existing?.createdAt
    })

    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO doctrine_templates (id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          updated_at = excluded.updated_at
      `).run(
        template.id,
        template.name,
        template.description,
        template.createdAt,
        template.updatedAt
      )
      this.database.prepare('DELETE FROM doctrine_role_requirements WHERE doctrine_id = ?')
        .run(template.id)
      this.database.prepare('DELETE FROM doctrine_hull_requirements WHERE doctrine_id = ?')
        .run(template.id)

      const insertRole = this.database.prepare(`
        INSERT INTO doctrine_role_requirements (
          doctrine_id, position, role, minimum_count, target_count, maximum_count
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      template.roles.forEach((role, position) => {
        insertRole.run(
          template.id,
          position,
          role.role,
          role.minimum,
          role.target,
          role.maximum
        )
      })
      const insertHull = this.database.prepare(`
        INSERT INTO doctrine_hull_requirements (
          doctrine_id, position, type_name, normalized_type_name,
          minimum_count, target_count, maximum_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      template.hulls.forEach((hull, position) => {
        insertHull.run(
          template.id,
          position,
          hull.typeName,
          hull.normalizedTypeName,
          hull.minimum,
          hull.target,
          hull.maximum
        )
      })
    })()
    return this.get(template.id)
  }

  get(idInput: string): DoctrineTemplate
  get(idInput: string, required: false): DoctrineTemplate | undefined
  get(idInput: string, required = true): DoctrineTemplate | undefined {
    this.assertOpen()
    const id = identifier(idInput)
    const row = this.database.prepare(`
      SELECT id, name, description, created_at, updated_at
      FROM doctrine_templates WHERE id = ?
    `).get(id) as TemplateRow | undefined
    if (!row) {
      if (required) throw new TypeError(`Doctrine not found: ${id}`)
      return undefined
    }
    return this.hydrate(row)
  }

  list(): DoctrineTemplate[] {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT id, name, description, created_at, updated_at
      FROM doctrine_templates
      ORDER BY updated_at DESC, name COLLATE NOCASE ASC, id ASC
    `).all() as TemplateRow[]
    return rows.map((row) => this.hydrate(row))
  }

  delete(idInput: string): boolean {
    this.assertOpen()
    const result = this.database.prepare('DELETE FROM doctrine_templates WHERE id = ?')
      .run(identifier(idInput))
    return result.changes > 0
  }

  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }

  private hydrate(row: TemplateRow): DoctrineTemplate {
    const roles = (this.database.prepare(`
      SELECT role, minimum_count, target_count, maximum_count
      FROM doctrine_role_requirements
      WHERE doctrine_id = ? ORDER BY position ASC
    `).all(row.id) as RoleRow[]).map((role): DoctrineRoleRequirement => ({
      role: role.role,
      minimum: role.minimum_count,
      target: role.target_count,
      maximum: role.maximum_count
    }))
    const hulls = (this.database.prepare(`
      SELECT type_name, normalized_type_name, minimum_count, target_count, maximum_count
      FROM doctrine_hull_requirements
      WHERE doctrine_id = ? ORDER BY position ASC
    `).all(row.id) as HullRow[]).map((hull): DoctrineHullRequirement => ({
      typeName: hull.type_name,
      normalizedTypeName: hull.normalized_type_name,
      minimum: hull.minimum_count,
      target: hull.target_count,
      maximum: hull.maximum_count
    }))
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      roles,
      hulls,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private clockIso(): string {
    const value = this.now()
    if (!Number.isFinite(value)) throw new TypeError('Invalid system clock')
    return new Date(value).toISOString()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Doctrine store is already closed')
  }
}

function readCandidateId(input: unknown): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const id = (input as { id?: unknown }).id
  return typeof id === 'string' ? identifier(id) : null
}

function identifier(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid doctrine ID')
  const result = value
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
  if (!result || result.length > 128) throw new TypeError('Invalid doctrine ID')
  return result
}
