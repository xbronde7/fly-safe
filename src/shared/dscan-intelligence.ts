import { classifyDscanShipRoles, type DscanShipRole } from './clipboard-intel'

export const DSCAN_DANGEROUS_ROLES = [
  'capital',
  'tackle',
  'logistics',
  'recon',
  'ewar',
  'command'
] as const satisfies readonly DscanShipRole[]

export type DscanDangerousRole = (typeof DSCAN_DANGEROUS_ROLES)[number]

/** Exact English names currently published by ESI for probes able to scan ships. */
export const COMBAT_SCANNER_PROBE_TYPE_NAMES = [
  'Combat Scanner Probe I',
  'Sisters Combat Scanner Probe',
  'Satori-Horigu Combat Scanner Probe'
] as const

/**
 * Deliberately loose at the boundary so stale or partially enriched renderer data
 * can be ignored instead of crashing an intelligence update.
 */
export interface DscanIntelligenceRow {
  readonly type?: unknown
  readonly typeId?: unknown
}

export type DscanIntelligenceInput = DscanIntelligenceRow | null | undefined

export interface DscanHullComposition {
  /** Stable within a comparison: a positive type ID is preferred over the normalized name. */
  key: string
  typeId: number | null
  typeName: string | null
  normalizedType: string | null
  count: number
  roles: DscanDangerousRole[]
  combatScannerProbe: boolean
}

export interface DscanComposition {
  totalCount: number
  ignoredCount: number
  hulls: DscanHullComposition[]
  roleCounts: Record<DscanDangerousRole, number>
  combatScannerProbeCount: number
}

export interface DscanHullDelta extends Omit<DscanHullComposition, 'count'> {
  previousCount: number
  currentCount: number
  /** Positive in `added`, negative in `removed`. */
  delta: number
}

export interface DscanChanges {
  hasBaseline: boolean
  addedCount: number
  removedCount: number
  netCount: number
  added: DscanHullDelta[]
  removed: DscanHullDelta[]
}

export interface DscanAlertHull {
  key: string
  typeId: number | null
  typeName: string | null
  count: number
  addedCount: number
}

export type DscanAlert =
  | {
      kind: 'role'
      role: DscanDangerousRole
      count: number
      addedCount: number
      hulls: DscanAlertHull[]
    }
  | {
      kind: 'combat-scanner-probes'
      count: number
      addedCount: number
      hulls: DscanAlertHull[]
    }

export interface DscanIntelligence {
  composition: DscanComposition
  changes: DscanChanges
  alerts: DscanAlert[]
}

interface MutableHullBucket {
  key: string
  typeId: number | null
  count: number
  names: Map<string, { typeName: string; count: number }>
}

const COMBAT_SCANNER_PROBE_TYPES = new Set(
  COMBAT_SCANNER_PROBE_TYPE_NAMES.map((name) => normalizeDscanTypeName(name))
)

/** Normalize a D-scan type for equality without changing its renderer label. */
export function normalizeDscanTypeName(value: unknown): string | null {
  const cleaned = cleanDscanTypeName(value)
  return cleaned?.toLocaleLowerCase('en-US') ?? null
}

/** Exact normalized type-name match; custom object names are never inspected. */
export function isCombatScannerProbeType(typeName: unknown): boolean {
  const normalized = normalizeDscanTypeName(typeName)
  return normalized !== null && COMBAT_SCANNER_PROBE_TYPES.has(normalized)
}

/** Aggregate duplicate D-scan rows into deterministic hull/type composition. */
export function summarizeDscanComposition(
  rows: readonly DscanIntelligenceInput[] | null | undefined
): DscanComposition {
  const buckets = new Map<string, MutableHullBucket>()
  let ignoredCount = 0

  for (const input of rows ?? []) {
    if (!input || typeof input !== 'object') {
      ignoredCount += 1
      continue
    }

    const typeId = positiveTypeId(input.typeId)
    const typeName = cleanDscanTypeName(input.type)
    const normalizedType = normalizeDscanTypeName(typeName)
    if (typeId === null && normalizedType === null) {
      ignoredCount += 1
      continue
    }

    const key = typeId === null ? `name:${normalizedType}` : `id:${typeId}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { key, typeId, count: 0, names: new Map() }
      buckets.set(key, bucket)
    }
    bucket.count += 1

    if (typeName && normalizedType) {
      const variant = bucket.names.get(normalizedType)
      if (variant) variant.count += 1
      else bucket.names.set(normalizedType, { typeName, count: 1 })
    }
  }

  const hulls = [...buckets.values()].map(finalizeHullBucket).sort(compareComposition)
  const roleCounts = emptyRoleCounts()
  let combatScannerProbeCount = 0

  for (const hull of hulls) {
    for (const role of hull.roles) roleCounts[role] += hull.count
    if (hull.combatScannerProbe) combatScannerProbeCount += hull.count
  }

  return {
    totalCount: hulls.reduce((total, hull) => total + hull.count, 0),
    ignoredCount,
    hulls,
    roleCounts,
    combatScannerProbeCount
  }
}

/** Compare snapshots as multisets. A null/undefined previous scan means “no baseline yet”. */
export function compareDscanScans(
  previousRows: readonly DscanIntelligenceInput[] | null | undefined,
  currentRows: readonly DscanIntelligenceInput[] | null | undefined
): DscanChanges {
  const current = summarizeDscanComposition(currentRows)
  if (previousRows === null || previousRows === undefined) {
    return emptyChanges()
  }
  return compareCompositions(summarizeDscanComposition(previousRows), current)
}

/** Build the renderer-facing current composition, deltas, and active tactical alerts. */
export function analyzeDscanIntelligence(
  currentRows: readonly DscanIntelligenceInput[] | null | undefined,
  previousRows: readonly DscanIntelligenceInput[] | null | undefined = null
): DscanIntelligence {
  const composition = summarizeDscanComposition(currentRows)
  const changes = previousRows === null || previousRows === undefined
    ? emptyChanges()
    : compareCompositions(summarizeDscanComposition(previousRows), composition)

  return {
    composition,
    changes,
    alerts: buildAlerts(composition, changes)
  }
}

function cleanDscanTypeName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .trim()
    .replace(/\s+/gu, ' ')
  return cleaned || null
}

function positiveTypeId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function finalizeHullBucket(bucket: MutableHullBucket): DscanHullComposition {
  const selectedName = [...bucket.names.entries()].sort((left, right) => (
    right[1].count - left[1].count || left[0].localeCompare(right[0], 'en-US')
  ))[0]
  const typeName = selectedName?.[1].typeName ?? null
  const normalizedType = selectedName?.[0] ?? null
  const roles = typeName
    ? classifyDscanShipRoles(typeName).filter(isDangerousRole)
    : []

  return {
    key: bucket.key,
    typeId: bucket.typeId,
    typeName,
    normalizedType,
    count: bucket.count,
    roles,
    combatScannerProbe: isCombatScannerProbeType(typeName)
  }
}

function isDangerousRole(role: DscanShipRole): role is DscanDangerousRole {
  return (DSCAN_DANGEROUS_ROLES as readonly DscanShipRole[]).includes(role)
}

function emptyRoleCounts(): Record<DscanDangerousRole, number> {
  return Object.fromEntries(DSCAN_DANGEROUS_ROLES.map((role) => [role, 0])) as Record<
    DscanDangerousRole,
    number
  >
}

function compareCompositions(previous: DscanComposition, current: DscanComposition): DscanChanges {
  const previousByKey = new Map(previous.hulls.map((hull) => [hull.key, hull]))
  const currentByKey = new Map(current.hulls.map((hull) => [hull.key, hull]))
  const added: DscanHullDelta[] = []
  const removed: DscanHullDelta[] = []

  for (const key of new Set([...previousByKey.keys(), ...currentByKey.keys()])) {
    const previousHull = previousByKey.get(key)
    const currentHull = currentByKey.get(key)
    const previousCount = previousHull?.count ?? 0
    const currentCount = currentHull?.count ?? 0
    const delta = currentCount - previousCount
    if (delta === 0) continue

    const source = delta > 0 ? currentHull : previousHull
    if (!source) continue
    const change: DscanHullDelta = {
      key: source.key,
      typeId: source.typeId,
      typeName: source.typeName,
      normalizedType: source.normalizedType,
      roles: [...source.roles],
      combatScannerProbe: source.combatScannerProbe,
      previousCount,
      currentCount,
      delta
    }
    ;(delta > 0 ? added : removed).push(change)
  }

  added.sort(compareDelta)
  removed.sort(compareDelta)
  return {
    hasBaseline: true,
    addedCount: added.reduce((total, hull) => total + hull.delta, 0),
    removedCount: removed.reduce((total, hull) => total - hull.delta, 0),
    netCount: current.totalCount - previous.totalCount,
    added,
    removed
  }
}

function emptyChanges(): DscanChanges {
  return {
    hasBaseline: false,
    addedCount: 0,
    removedCount: 0,
    netCount: 0,
    added: [],
    removed: []
  }
}

function buildAlerts(composition: DscanComposition, changes: DscanChanges): DscanAlert[] {
  const addedByKey = new Map(changes.added.map((hull) => [hull.key, hull.delta]))
  const alerts: DscanAlert[] = []

  for (const role of DSCAN_DANGEROUS_ROLES) {
    const hulls = composition.hulls.filter((hull) => hull.roles.includes(role))
    if (hulls.length === 0) continue
    const alertHulls = hulls.map((hull) => alertHull(hull, addedByKey))
    alerts.push({
      kind: 'role',
      role,
      count: alertHulls.reduce((total, hull) => total + hull.count, 0),
      addedCount: alertHulls.reduce((total, hull) => total + hull.addedCount, 0),
      hulls: alertHulls
    })
  }

  const probeHulls = composition.hulls.filter((hull) => hull.combatScannerProbe)
  if (probeHulls.length > 0) {
    const hulls = probeHulls.map((hull) => alertHull(hull, addedByKey))
    alerts.push({
      kind: 'combat-scanner-probes',
      count: hulls.reduce((total, hull) => total + hull.count, 0),
      addedCount: hulls.reduce((total, hull) => total + hull.addedCount, 0),
      hulls
    })
  }

  return alerts
}

function alertHull(
  hull: DscanHullComposition,
  addedByKey: ReadonlyMap<string, number>
): DscanAlertHull {
  return {
    key: hull.key,
    typeId: hull.typeId,
    typeName: hull.typeName,
    count: hull.count,
    addedCount: addedByKey.get(hull.key) ?? 0
  }
}

function compareComposition(left: DscanHullComposition, right: DscanHullComposition): number {
  return right.count - left.count || compareLabels(left, right)
}

function compareDelta(left: DscanHullDelta, right: DscanHullDelta): number {
  return Math.abs(right.delta) - Math.abs(left.delta) || compareLabels(left, right)
}

function compareLabels(
  left: Pick<DscanHullComposition, 'normalizedType' | 'key'>,
  right: Pick<DscanHullComposition, 'normalizedType' | 'key'>
): number {
  const leftLabel = left.normalizedType ?? left.key
  const rightLabel = right.normalizedType ?? right.key
  return leftLabel.localeCompare(rightLabel, 'en-US')
}
