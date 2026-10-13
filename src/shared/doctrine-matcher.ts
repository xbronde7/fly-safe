import {
  summarizeDscanComposition,
  type DscanDangerousRole,
  type DscanIntelligenceInput
} from './dscan-intelligence'
import { classifyDscanShipRoles, type DscanShipRole } from './clipboard-intel'

export const DOCTRINE_ROLES = [
  'logistics',
  'tackle',
  'ewar',
  'recon',
  'scanner',
  'command',
  'capital',
  'hauler',
  'mining'
] as const satisfies readonly DscanShipRole[]

export interface DoctrineRequirementRange {
  minimum: number
  target: number
  maximum: number | null
}

export interface DoctrineRoleRequirement extends DoctrineRequirementRange {
  role: DscanShipRole
}

export interface DoctrineHullRequirement extends DoctrineRequirementRange {
  typeName: string
  normalizedTypeName: string
}

export interface DoctrineTemplate {
  id: string
  name: string
  description: string | null
  roles: DoctrineRoleRequirement[]
  hulls: DoctrineHullRequirement[]
  createdAt: string
  updatedAt: string
}

export interface DoctrineRoleRequirementInput {
  role: DscanShipRole
  minimum?: number
  target: number
  maximum?: number | null
}

export interface DoctrineHullRequirementInput {
  typeName: string
  minimum?: number
  target: number
  maximum?: number | null
}

export interface DoctrineTemplateInput {
  id?: string
  name: string
  description?: string | null
  roles?: DoctrineRoleRequirementInput[]
  hulls?: DoctrineHullRequirementInput[]
}

export type DoctrineRequirementMatchStatus = 'matched' | 'missing' | 'excess'

export interface DoctrineRoleComparison extends DoctrineRoleRequirement {
  actual: number
  deltaToTarget: number
  status: DoctrineRequirementMatchStatus
  observedHulls: Array<{ typeName: string; count: number }>
  explanation: string
}

export interface DoctrineHullComparison extends DoctrineHullRequirement {
  actual: number
  deltaToTarget: number
  status: DoctrineRequirementMatchStatus
  explanation: string
}

export interface DoctrineMatchResult {
  templateId: string
  templateName: string
  score: number
  status: 'match' | 'partial' | 'mismatch'
  observedTotal: number
  unclassifiedCount: number
  roleComparisons: DoctrineRoleComparison[]
  hullComparisons: DoctrineHullComparison[]
  unrequestedRoles: Array<{ role: DscanShipRole; count: number }>
  explanations: string[]
}

export interface DoctrineTemplateDefaults {
  id: string
  now: string
  createdAt?: string
}

type UnknownRecord = Record<string, unknown>

/** Strictly validate a template before local persistence or IPC use. */
export function validateDoctrineTemplateInput(
  value: unknown,
  defaults: DoctrineTemplateDefaults
): DoctrineTemplate {
  const input = strictRecord(value, ['id', 'name', 'description', 'roles', 'hulls'], 'doctrine')
  const id = input.id === undefined
    ? identifier(defaults.id, 'Doctrine ID')
    : identifier(input.id, 'Doctrine ID')
  const name = requiredText(input.name, 128, 'doctrine name')
  const description = optionalText(input.description, 2_000, 'doctrine description')
  const rawRoles = optionalArray(input.roles, 32, 'doctrine roles')
  const rawHulls = optionalArray(input.hulls, 256, 'doctrine hulls')
  if (rawRoles.length === 0 && rawHulls.length === 0) {
    throw new TypeError('Doctrine requires at least one role or hull')
  }

  const roleKeys = new Set<DscanShipRole>()
  const roles = rawRoles.map((rawRole, index): DoctrineRoleRequirement => {
    const role = strictRecord(
      rawRole,
      ['role', 'minimum', 'target', 'maximum'],
      `doctrine role #${index + 1}`
    )
    if (typeof role.role !== 'string' || !DOCTRINE_ROLES.includes(role.role as DscanShipRole)) {
      throw new TypeError(`Invalid doctrine role #${index + 1}`)
    }
    const roleName = role.role as DscanShipRole
    if (roleKeys.has(roleName)) throw new TypeError(`Duplicate doctrine role: ${roleName}`)
    roleKeys.add(roleName)
    return { role: roleName, ...requirementRange(role, `role ${roleName}`) }
  })

  const hullKeys = new Set<string>()
  const hulls = rawHulls.map((rawHull, index): DoctrineHullRequirement => {
    const hull = strictRecord(
      rawHull,
      ['typeName', 'minimum', 'target', 'maximum'],
      `doctrine hull #${index + 1}`
    )
    const typeName = requiredText(hull.typeName, 256, `hull type #${index + 1}`)
    const normalizedTypeName = normalizeDoctrineTypeName(typeName)
    if (hullKeys.has(normalizedTypeName)) throw new TypeError(`Duplicate doctrine hull: ${typeName}`)
    hullKeys.add(normalizedTypeName)
    return { typeName, normalizedTypeName, ...requirementRange(hull, `hull ${typeName}`) }
  })

  const now = isoTimestamp(defaults.now, 'doctrine change time')
  return {
    id,
    name,
    description,
    roles,
    hulls,
    createdAt: isoTimestamp(defaults.createdAt ?? now, 'doctrine creation time'),
    updatedAt: now
  }
}

/** Compare a D-scan multiset with an explicit saved fleet doctrine. */
export function matchDscanDoctrine(
  rows: readonly DscanIntelligenceInput[] | null | undefined,
  template: DoctrineTemplate
): DoctrineMatchResult {
  const composition = summarizeDscanComposition(rows)
  const allRoleCounts = Object.fromEntries(DOCTRINE_ROLES.map((role) => [role, 0])) as Record<
    DscanShipRole,
    number
  >
  for (const dangerousRole of Object.keys(composition.roleCounts) as DscanDangerousRole[]) {
    allRoleCounts[dangerousRole] = composition.roleCounts[dangerousRole]
  }
  // Roles excluded from tactical alerts are still present on classified hulls.
  for (const hull of composition.hulls) {
    if (!hull.typeName) continue
    for (const role of classifyNonDangerousRoles(hull.typeName)) allRoleCounts[role] += hull.count
  }

  const roleComparisons = template.roles.map((requirement): DoctrineRoleComparison => {
    const actual = allRoleCounts[requirement.role]
    const observedHulls = composition.hulls
      .filter((hull) => hull.typeName && hullMatchesRole(hull.typeName, requirement.role))
      .map((hull) => ({ typeName: hull.typeName!, count: hull.count }))
      .sort((left, right) => right.count - left.count || left.typeName.localeCompare(right.typeName))
    const status = requirementStatus(actual, requirement)
    return {
      ...requirement,
      actual,
      deltaToTarget: actual - requirement.target,
      status,
      observedHulls,
      explanation: explainRequirement(requirement.role, actual, requirement, status, observedHulls)
    }
  })

  const hullCounts = new Map(composition.hulls.map((hull) => [hull.normalizedType, hull.count]))
  const hullComparisons = template.hulls.map((requirement): DoctrineHullComparison => {
    const actual = hullCounts.get(requirement.normalizedTypeName) ?? 0
    const status = requirementStatus(actual, requirement)
    return {
      ...requirement,
      actual,
      deltaToTarget: actual - requirement.target,
      status,
      explanation: explainRequirement(requirement.typeName, actual, requirement, status)
    }
  })

  const requestedRoles = new Set(template.roles.map((requirement) => requirement.role))
  const unrequestedRoles = DOCTRINE_ROLES
    .filter((role) => !requestedRoles.has(role) && allRoleCounts[role] > 0)
    .map((role) => ({ role, count: allRoleCounts[role] }))
    .sort((left, right) => right.count - left.count || left.role.localeCompare(right.role))
  const comparisons = [...roleComparisons, ...hullComparisons]
  const score = doctrineScore(comparisons)
  const hasFailure = comparisons.some((comparison) => comparison.status !== 'matched')
  return {
    templateId: template.id,
    templateName: template.name,
    score,
    status: !hasFailure ? 'match' : score >= 50 ? 'partial' : 'mismatch',
    observedTotal: composition.totalCount,
    unclassifiedCount: composition.hulls
      .filter((hull) => hull.roles.length === 0 && (
        !hull.typeName || classifyNonDangerousRoles(hull.typeName).length === 0
      ))
      .reduce((total, hull) => total + hull.count, 0),
    roleComparisons,
    hullComparisons,
    unrequestedRoles,
    explanations: comparisons.map((comparison) => comparison.explanation)
  }
}

function classifyNonDangerousRoles(typeName: string): DscanShipRole[] {
  // Kept local to avoid double-counting dangerous roles already summarized above.
  const roles = lazyClassify(typeName)
  return roles.filter((role) => !(
    ['capital', 'tackle', 'logistics', 'recon', 'ewar', 'command'] as DscanShipRole[]
  ).includes(role))
}

function hullMatchesRole(typeName: string, role: DscanShipRole): boolean {
  return lazyClassify(typeName).includes(role)
}

function lazyClassify(typeName: string): DscanShipRole[] {
  return classifyDscanShipRoles(typeName)
}

function doctrineScore(
  comparisons: ReadonlyArray<DoctrineRoleComparison | DoctrineHullComparison>
): number {
  let achieved = 0
  let possible = 0
  for (const comparison of comparisons) {
    const weight = Math.max(comparison.target, comparison.minimum, 1)
    possible += weight
    if (comparison.actual < comparison.minimum) {
      achieved += weight * (comparison.minimum === 0 ? 1 : comparison.actual / comparison.minimum)
    } else if (comparison.maximum !== null && comparison.actual > comparison.maximum) {
      achieved += weight * (comparison.maximum === 0 ? 0 : comparison.maximum / comparison.actual)
    } else if (comparison.target > 0 && comparison.actual < comparison.target) {
      achieved += weight * (comparison.actual / comparison.target)
    } else {
      achieved += weight
    }
  }
  return possible === 0 ? 0 : Math.round((achieved / possible) * 100)
}

function requirementStatus(
  actual: number,
  requirement: DoctrineRequirementRange
): DoctrineRequirementMatchStatus {
  if (actual < requirement.minimum) return 'missing'
  if (requirement.maximum !== null && actual > requirement.maximum) return 'excess'
  return 'matched'
}

function explainRequirement(
  label: string,
  actual: number,
  requirement: DoctrineRequirementRange,
  status: DoctrineRequirementMatchStatus,
  observedHulls: Array<{ typeName: string; count: number }> = []
): string {
  const range = requirement.maximum === null
    ? `minimum ${requirement.minimum}, target ${requirement.target}`
    : `${requirement.minimum}–${requirement.maximum}, target ${requirement.target}`
  const verdict = status === 'matched' ? 'matched' : status === 'missing' ? 'missing' : 'excess'
  const evidence = observedHulls.length === 0
    ? ''
    : `; ${observedHulls.map((hull) => `${hull.typeName} ×${hull.count}`).join(', ')}`
  return `${label}: found ${actual}, required ${range} — ${verdict}${evidence}`
}

function requirementRange(record: UnknownRecord, label: string): DoctrineRequirementRange {
  const target = nonNegativeInteger(record.target, `target: ${label}`)
  const minimum = record.minimum === undefined
    ? target
    : nonNegativeInteger(record.minimum, `minimum: ${label}`)
  const maximum = record.maximum === undefined || record.maximum === null
    ? null
    : nonNegativeInteger(record.maximum, `maximum: ${label}`)
  if (minimum > target) throw new TypeError(`Minimum exceeds target: ${label}`)
  if (maximum !== null && target > maximum) throw new TypeError(`Target exceeds maximum: ${label}`)
  return { minimum, target, maximum }
}

export function normalizeDoctrineTypeName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US')
}

function strictRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  const record = value as UnknownRecord
  const allowed = new Set(keys)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown ${label} field: ${key}`)
  }
  return record
}

function optionalArray(value: unknown, maximum: number, label: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`Invalid field: ${label}`)
  return value
}

function identifier(value: unknown, label: string): string {
  return requiredText(value, 128, label)
}

function requiredText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid field: ${label}`)
  const result = value
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
  if (!result || result.length > maximum) throw new TypeError(`Invalid field: ${label}`)
  return result
}

function optionalText(value: unknown, maximum: number, label: string): string | null {
  if (value === undefined || value === null) return null
  return requiredText(value, maximum, label)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100_000) {
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
