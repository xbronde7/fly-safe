import {
  SHARED_WORKSPACE_COLLECTIONS,
  SHARED_WORKSPACE_ROLES,
  SHARED_WORKSPACE_SHARE_SCOPES,
  type SharedDoctrinePayload,
  type SharedRoutePayload,
  type SharedWatchlistPayload,
  type SharedWorkspaceChange,
  type SharedWorkspaceConsent,
  type SharedWorkspaceMember,
  type SharedWorkspaceMutationResult,
  type SharedWorkspaceRecord,
  type SharedWorkspaceRole,
  type SharedWorkspaceShareScope,
  type SharedWorkspaceSnapshot,
  type SharedWorkspaceSummary
} from '../shared/shared-workspace'
import type {
  SharedWorkspaceChange as WireChange,
  SharedWorkspaceConsent as WireConsent,
  SharedWorkspaceMember as WireMember,
  SharedWorkspaceMutation as WireMutation,
  SharedWorkspaceMutationResult as WireMutationResult,
  SharedWorkspaceRecord as WireRecord,
  SharedWorkspaceSnapshot as WireSnapshot,
  SharedWorkspaceSummary as WireSummary
} from './shared-workspace-service'

const ASSIGNABLE_ROLES = ['commander', 'editor', 'viewer'] as const
const MUTATION_OPERATIONS = ['upsert', 'delete'] as const
const WATCH_ENTITY_TYPES = ['character', 'corporation', 'alliance'] as const
const WATCH_SEVERITIES = ['watch', 'danger', 'critical'] as const
const ROUTE_MODES = ['shortest', 'secure', 'insecure'] as const
const MUTATION_FAILURE_CODES = [
  'member-missing',
  'consent-required',
  'scope-not-consented',
  'forbidden',
  'conflict',
  'mutation-id-reused'
] as const

export function parseGetSharedWorkspaceRequest(value: unknown): { workspaceId: string } {
  const record = exactRequest(value, ['workspaceId'], 'Corp/Fleet workspace retrieval')
  return { workspaceId: requestId(record.workspaceId, 'workspaceId') }
}

export function parseCreateSharedWorkspaceRequest(value: unknown): { name: string } {
  const record = exactRequest(value, ['name'], 'Corp/Fleet workspace creation')
  return { name: normalizedText(record.name, 'name', 120) }
}

export function parseAcceptSharedWorkspaceConsentRequest(value: unknown): {
  workspaceId: string
  policyVersion: number
  scopes: SharedWorkspaceShareScope[]
  expectedWorkspaceRevision: number
} {
  const record = exactRequest(
    value,
    ['workspaceId', 'policyVersion', 'scopes', 'expectedWorkspaceRevision'],
    'Corp/Fleet workspace consent'
  )
  return {
    workspaceId: requestId(record.workspaceId, 'workspaceId'),
    policyVersion: positiveInteger(record.policyVersion, 'policyVersion'),
    scopes: requestScopes(record.scopes),
    expectedWorkspaceRevision: nonNegativeInteger(
      record.expectedWorkspaceRevision,
      'expectedWorkspaceRevision'
    )
  }
}

export function parseRevokeSharedWorkspaceConsentRequest(value: unknown): {
  workspaceId: string
  expectedWorkspaceRevision: number
} {
  const record = exactRequest(
    value,
    ['workspaceId', 'expectedWorkspaceRevision'],
    'Corp/Fleet workspace consent revocation'
  )
  return {
    workspaceId: requestId(record.workspaceId, 'workspaceId'),
    expectedWorkspaceRevision: nonNegativeInteger(
      record.expectedWorkspaceRevision,
      'expectedWorkspaceRevision'
    )
  }
}

export function parseAddSharedWorkspaceMemberRequest(value: unknown): {
  workspaceId: string
  characterId: number
  characterName: string
  role: Exclude<SharedWorkspaceRole, 'owner'>
  expectedWorkspaceRevision: number
} {
  const record = exactRequest(
    value,
    ['workspaceId', 'characterId', 'characterName', 'role', 'expectedWorkspaceRevision'],
    'Corp/Fleet workspace member'
  )
  return {
    workspaceId: requestId(record.workspaceId, 'workspaceId'),
    characterId: positiveInteger(record.characterId, 'characterId'),
    characterName: normalizedText(record.characterName, 'characterName', 100),
    role: enumValue(record.role, ASSIGNABLE_ROLES, 'role'),
    expectedWorkspaceRevision: nonNegativeInteger(
      record.expectedWorkspaceRevision,
      'expectedWorkspaceRevision'
    )
  }
}

export function parseApplySharedWorkspaceMutationRequest(value: unknown): {
  workspaceId: string
  mutation: WireMutation
} {
  const record = exactRequest(
    value,
    ['workspaceId', 'mutation'],
    'Corp/Fleet workspace change'
  )
  return {
    workspaceId: requestId(record.workspaceId, 'workspaceId'),
    mutation: requestMutation(record.mutation)
  }
}

export function toPublicSharedWorkspaceSummary(value: WireSummary): SharedWorkspaceSummary {
  return {
    workspaceId: requestId(value.workspaceId, 'workspaceId'),
    name: normalizedText(value.name, 'name', 120),
    policyVersion: positiveInteger(value.policyVersion, 'policyVersion'),
    revision: positiveInteger(value.revision, 'revision'),
    role: enumValue(value.role, SHARED_WORKSPACE_ROLES, 'role'),
    consent: value.consent === null ? null : toPublicConsent(value.consent),
    createdAt: unixTimeToIso(value.createdAt, 'createdAt'),
    updatedAt: unixTimeToIso(value.updatedAt, 'updatedAt')
  }
}

export function toPublicSharedWorkspaceSnapshot(value: WireSnapshot): SharedWorkspaceSnapshot {
  if (value.schemaVersion !== 1) throw invalidBackend('schemaVersion')
  return {
    schemaVersion: 1,
    workspaceId: requestId(value.workspaceId, 'workspaceId'),
    name: normalizedText(value.name, 'name', 120),
    policyVersion: positiveInteger(value.policyVersion, 'policyVersion'),
    revision: positiveInteger(value.revision, 'revision'),
    members: value.members.map(toPublicMember),
    records: value.records.map(toPublicRecord),
    createdAt: unixTimeToIso(value.createdAt, 'createdAt'),
    updatedAt: unixTimeToIso(value.updatedAt, 'updatedAt')
  }
}

export function toPublicSharedWorkspaceMutationResult(
  value: WireMutationResult
): SharedWorkspaceMutationResult {
  if (value.ok) {
    return {
      ok: true,
      applied: booleanValue(value.applied, 'applied'),
      staleBase: booleanValue(value.staleBase, 'staleBase'),
      workspace: toPublicSharedWorkspaceSnapshot(value.workspace),
      record: toPublicRecord(value.record),
      change: value.change === null ? null : toPublicChange(value.change)
    }
  }
  return {
    ok: false,
    code: enumValue(value.code, MUTATION_FAILURE_CODES, 'code'),
    message: normalizedText(value.message, 'message', 500),
    workspaceRevision: nonNegativeInteger(value.workspaceRevision, 'workspaceRevision'),
    currentRecord: value.currentRecord === null ? null : toPublicRecord(value.currentRecord)
  }
}

function requestMutation(value: unknown): WireMutation {
  if (!isRecord(value)) throw new TypeError('Invalid Corp/Fleet workspace mutation')
  const operation = enumValue(value.operation, MUTATION_OPERATIONS, 'operation')
  const commonKeys = [
    'operation',
    'mutationId',
    'collection',
    'recordId',
    'expectedRevision',
    'baseWorkspaceRevision'
  ] as const
  exactKeys(value, operation === 'upsert' ? [...commonKeys, 'payload'] : commonKeys)
  const collection = enumValue(value.collection, SHARED_WORKSPACE_COLLECTIONS, 'collection')
  const common = {
    mutationId: requestId(value.mutationId, 'mutationId'),
    collection,
    recordId: requestId(value.recordId, 'recordId'),
    expectedRevision: nonNegativeInteger(value.expectedRevision, 'expectedRevision'),
    baseWorkspaceRevision: nonNegativeInteger(
      value.baseWorkspaceRevision,
      'baseWorkspaceRevision'
    )
  }
  if (operation === 'delete') return { operation, ...common }
  return {
    operation,
    ...common,
    payload: toWirePayload(collection, value.payload)
  }
}

function toWirePayload(
  collection: (typeof SHARED_WORKSPACE_COLLECTIONS)[number],
  value: unknown
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError('Invalid Corp/Fleet workspace payload')
  if (collection === 'watchlist') {
    exactKeys(value, ['entityType', 'entityId', 'name', 'severity', 'tags', 'note'])
    return {
      entityType: enumValue(value.entityType, WATCH_ENTITY_TYPES, 'entityType'),
      entityId: String(positiveInteger(value.entityId, 'entityId')),
      name: normalizedText(value.name, 'name', 200),
      severity: enumValue(value.severity, WATCH_SEVERITIES, 'severity'),
      tags: normalizedTags(value.tags),
      note: nullableText(value.note, 'note', 2_000)
    }
  }
  if (collection === 'doctrines') {
    exactKeys(value, ['name', 'description', 'ships', 'tags'])
    if (!Array.isArray(value.ships) || value.ships.length > 500) {
      throw new TypeError('Invalid doctrine ship list')
    }
    return {
      name: normalizedText(value.name, 'name', 120),
      description: nullableText(value.description, 'description', 5_000),
      ships: value.ships.map((entry) => {
        if (!isRecord(entry)) throw new TypeError('Invalid doctrine ship')
        exactKeys(entry, ['typeId', 'minimum', 'maximum', 'role'])
        const minimum = nonNegativeInteger(entry.minimum, 'minimum')
        const maximum = entry.maximum === null
          ? null
          : nonNegativeInteger(entry.maximum, 'maximum')
        if (maximum !== null && maximum < minimum) {
          throw new TypeError('maximum cannot be less than minimum')
        }
        return {
          typeId: positiveInteger(entry.typeId, 'typeId'),
          minimum,
          maximum,
          role: nullableText(entry.role, 'role', 100)
        }
      }),
      tags: normalizedTags(value.tags)
    }
  }
  exactKeys(value, ['name', 'origin', 'destination', 'mode', 'avoidSystemIds', 'tags'])
  if (!Array.isArray(value.avoidSystemIds) || value.avoidSystemIds.length > 256) {
    throw new TypeError('Invalid avoidSystemIds list')
  }
  return {
    name: normalizedText(value.name, 'name', 120),
    origin: normalizedText(value.origin, 'origin', 120),
    destination: normalizedText(value.destination, 'destination', 120),
    mode: enumValue(value.mode, ROUTE_MODES, 'mode'),
    avoidSystemIds: [...new Set(value.avoidSystemIds.map((entry) =>
      positiveInteger(entry, 'avoidSystemId')))].sort((left, right) => left - right),
    tags: normalizedTags(value.tags)
  }
}

function toPublicConsent(value: WireConsent): SharedWorkspaceConsent {
  return {
    policyVersion: positiveInteger(value.policyVersion, 'policyVersion'),
    scopes: value.scopes.map((scope) =>
      enumValue(scope, SHARED_WORKSPACE_SHARE_SCOPES, 'scope')),
    acceptedAt: unixTimeToIso(value.acceptedAt, 'acceptedAt')
  }
}

function toPublicMember(value: WireMember): SharedWorkspaceMember {
  return {
    characterId: decimalIdToSafeNumber(value.characterId, 'characterId'),
    characterName: normalizedText(value.characterName, 'characterName', 100),
    role: enumValue(value.role, SHARED_WORKSPACE_ROLES, 'role'),
    consent: value.consent === null ? null : toPublicConsent(value.consent),
    joinedAt: unixTimeToIso(value.joinedAt, 'joinedAt'),
    updatedAt: unixTimeToIso(value.updatedAt, 'updatedAt')
  }
}

function toPublicRecord(value: WireRecord): SharedWorkspaceRecord {
  const collection = enumValue(value.collection, SHARED_WORKSPACE_COLLECTIONS, 'collection')
  const base = {
    recordId: requestId(value.recordId, 'recordId'),
    revision: positiveInteger(value.revision, 'revision'),
    workspaceRevision: positiveInteger(value.workspaceRevision, 'workspaceRevision'),
    updatedByCharacterId: decimalIdToSafeNumber(
      value.updatedByCharacterId,
      'updatedByCharacterId'
    ),
    updatedAt: unixTimeToIso(value.updatedAt, 'updatedAt'),
    deletedAt: value.deletedAt === null ? null : unixTimeToIso(value.deletedAt, 'deletedAt'),
    lastMutationId: requestId(value.lastMutationId, 'lastMutationId')
  }
  if (collection === 'watchlist') {
    return {
      ...base,
      collection,
      payload: value.payload === null ? null : toPublicWatchlistPayload(value.payload)
    }
  }
  if (collection === 'doctrines') {
    return {
      ...base,
      collection,
      payload: value.payload === null ? null : toPublicDoctrinePayload(value.payload)
    }
  }
  return {
    ...base,
    collection,
    payload: value.payload === null ? null : toPublicRoutePayload(value.payload)
  }
}

function toPublicWatchlistPayload(value: Readonly<Record<string, unknown>>): SharedWatchlistPayload {
  exactKeys(value, ['entityType', 'entityId', 'name', 'severity', 'tags', 'note'], 'watchlist payload')
  return {
    entityType: enumValue(value.entityType, WATCH_ENTITY_TYPES, 'entityType'),
    entityId: decimalIdToSafeNumber(value.entityId, 'entityId'),
    name: normalizedText(value.name, 'name', 200),
    severity: enumValue(value.severity, WATCH_SEVERITIES, 'severity'),
    tags: normalizedTags(value.tags),
    note: nullableText(value.note, 'note', 2_000)
  }
}

function toPublicDoctrinePayload(value: Readonly<Record<string, unknown>>): SharedDoctrinePayload {
  exactKeys(value, ['name', 'description', 'ships', 'tags'], 'doctrine payload')
  if (!Array.isArray(value.ships) || value.ships.length > 500) throw invalidBackend('ships')
  return {
    name: normalizedText(value.name, 'name', 120),
    description: nullableText(value.description, 'description', 5_000),
    ships: value.ships.map((entry) => {
      if (!isRecord(entry)) throw invalidBackend('ship')
      exactKeys(entry, ['typeId', 'minimum', 'maximum', 'role'])
      const minimum = nonNegativeInteger(entry.minimum, 'minimum')
      const maximum = entry.maximum === null
        ? null
        : nonNegativeInteger(entry.maximum, 'maximum')
      if (maximum !== null && maximum < minimum) throw invalidBackend('maximum')
      return {
        typeId: positiveInteger(entry.typeId, 'typeId'),
        minimum,
        maximum,
        role: nullableText(entry.role, 'role', 100)
      }
    }),
    tags: normalizedTags(value.tags)
  }
}

function toPublicRoutePayload(value: Readonly<Record<string, unknown>>): SharedRoutePayload {
  exactKeys(
    value,
    ['name', 'origin', 'destination', 'mode', 'avoidSystemIds', 'tags'],
    'route payload'
  )
  if (!Array.isArray(value.avoidSystemIds) || value.avoidSystemIds.length > 256) {
    throw invalidBackend('avoidSystemIds')
  }
  return {
    name: normalizedText(value.name, 'name', 120),
    origin: normalizedText(value.origin, 'origin', 120),
    destination: normalizedText(value.destination, 'destination', 120),
    mode: enumValue(value.mode, ROUTE_MODES, 'mode'),
    avoidSystemIds: [...new Set(value.avoidSystemIds.map((entry) =>
      positiveInteger(entry, 'avoidSystemId')))].sort((left, right) => left - right),
    tags: normalizedTags(value.tags)
  }
}

function toPublicChange(value: WireChange): SharedWorkspaceChange {
  return {
    workspaceId: requestId(value.workspaceId, 'workspaceId'),
    workspaceRevision: positiveInteger(value.workspaceRevision, 'workspaceRevision'),
    mutationId: requestId(value.mutationId, 'mutationId'),
    collection: enumValue(value.collection, SHARED_WORKSPACE_COLLECTIONS, 'collection'),
    recordId: requestId(value.recordId, 'recordId'),
    recordRevision: positiveInteger(value.recordRevision, 'recordRevision'),
    operation: enumValue(value.operation, MUTATION_OPERATIONS, 'operation'),
    changedByCharacterId: decimalIdToSafeNumber(
      value.changedByCharacterId,
      'changedByCharacterId'
    ),
    changedAt: unixTimeToIso(value.changedAt, 'changedAt')
  }
}

function exactRequest(
  value: unknown,
  allowedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`Invalid ${label} request`)
  exactKeys(value, allowedKeys)
  return value
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  label = 'Corp/Fleet request'
): void {
  const allowed = new Set(allowedKeys)
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`Invalid ${label}: unknown fields`)
  }
}

function requestId(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid field ${field}`)
  const result = value.normalize('NFKC').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(result)) {
    throw new TypeError(`Invalid field ${field}`)
  }
  return result
}

function requestScopes(value: unknown): SharedWorkspaceShareScope[] {
  if (!Array.isArray(value) || value.length > SHARED_WORKSPACE_SHARE_SCOPES.length) {
    throw new TypeError('Invalid Corp/Fleet scopes')
  }
  const scopes = [...new Set(value.map((entry) =>
    enumValue(entry, SHARED_WORKSPACE_SHARE_SCOPES, 'scope')))]
  return scopes.sort((left, right) =>
    SHARED_WORKSPACE_SHARE_SCOPES.indexOf(left) - SHARED_WORKSPACE_SHARE_SCOPES.indexOf(right))
}

function normalizedTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) throw new TypeError('Invalid tags')
  return [...new Set(value.map((entry) => normalizedText(entry, 'tag', 64)))].sort((left, right) =>
    left.localeCompare(right, 'en'))
}

function normalizedText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid field ${field}`)
  const result = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!result || result.length > maximumLength || result.includes('\0')) {
    throw new TypeError(`Invalid field ${field}`)
  }
  return result
}

function nullableText(value: unknown, field: string, maximumLength: number): string | null {
  if (value === null) return null
  return normalizedText(value, field, maximumLength)
}

function positiveInteger(value: unknown, field: string): number {
  const result = nonNegativeInteger(value, field)
  if (result === 0) throw new TypeError(`Invalid field ${field}`)
  return result
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Invalid field ${field}`)
  }
  return value as number
}

function decimalIdToSafeNumber(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^\d{1,20}$/u.test(value) || /^0+$/u.test(value)) {
    throw invalidBackend(field)
  }
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0 || String(result) !== value.replace(/^0+(?=\d)/u, '')) {
    throw invalidBackend(field)
  }
  return result
}

function unixTimeToIso(value: unknown, field: string): string {
  const seconds = nonNegativeInteger(value, field)
  if (seconds > 253_402_300_799) throw invalidBackend(field)
  const date = new Date(seconds * 1_000)
  if (!Number.isFinite(date.getTime())) throw invalidBackend(field)
  return date.toISOString()
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidBackend(field)
  return value
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string
): Values[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`Invalid field ${field}`)
  }
  return value as Values[number]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidBackend(field: string): TypeError {
  return new TypeError(`Corp/Fleet backend returned invalid field ${field}`)
}
