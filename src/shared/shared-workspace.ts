export const SHARED_WORKSPACE_ROLES = ['owner', 'commander', 'editor', 'viewer'] as const
export const SHARED_WORKSPACE_COLLECTIONS = ['watchlist', 'doctrines', 'routes'] as const
export const SHARED_WORKSPACE_SHARE_SCOPES = [
  ...SHARED_WORKSPACE_COLLECTIONS,
  'local-presence'
] as const

export type SharedWorkspaceRole = (typeof SHARED_WORKSPACE_ROLES)[number]
export type SharedWorkspaceCollection = (typeof SHARED_WORKSPACE_COLLECTIONS)[number]
export type SharedWorkspaceShareScope = (typeof SHARED_WORKSPACE_SHARE_SCOPES)[number]
export type SharedWorkspacePermission = 'read' | 'write' | 'manage-members' | 'manage-policy'

export interface SharedWorkspaceConsent {
  policyVersion: number
  acceptedAt: string
  scopes: SharedWorkspaceShareScope[]
}

export interface SharedWorkspaceMember {
  characterId: number
  characterName: string
  role: SharedWorkspaceRole
  consent: SharedWorkspaceConsent | null
  joinedAt: string
  updatedAt: string
}

export interface SharedWatchlistPayload {
  entityType: 'character' | 'corporation' | 'alliance'
  entityId: number
  name: string
  severity: 'watch' | 'danger' | 'critical'
  tags: string[]
  note: string | null
}

export interface SharedDoctrineShipRequirement {
  typeId: number
  minimum: number
  maximum: number | null
  role: string | null
}

export interface SharedDoctrinePayload {
  name: string
  description: string | null
  ships: SharedDoctrineShipRequirement[]
  tags: string[]
}

export interface SharedRoutePayload {
  name: string
  origin: string
  destination: string
  mode: 'shortest' | 'secure' | 'insecure'
  avoidSystemIds: number[]
  tags: string[]
}

export type SharedWorkspacePayload =
  | SharedWatchlistPayload
  | SharedDoctrinePayload
  | SharedRoutePayload

interface SharedWorkspaceRecordBase {
  recordId: string
  revision: number
  workspaceRevision: number
  updatedByCharacterId: number
  updatedAt: string
  deletedAt: string | null
  lastMutationId: string
}

export type SharedWorkspaceRecord =
  | (SharedWorkspaceRecordBase & {
      collection: 'watchlist'
      payload: SharedWatchlistPayload | null
    })
  | (SharedWorkspaceRecordBase & {
      collection: 'doctrines'
      payload: SharedDoctrinePayload | null
    })
  | (SharedWorkspaceRecordBase & {
      collection: 'routes'
      payload: SharedRoutePayload | null
    })

export interface SharedWorkspaceSnapshot {
  schemaVersion: 1
  workspaceId: string
  name: string
  policyVersion: number
  revision: number
  members: SharedWorkspaceMember[]
  records: SharedWorkspaceRecord[]
  createdAt: string
  updatedAt: string
}

/** Token-free list item returned to the renderer for the active EVE character. */
export interface SharedWorkspaceSummary {
  workspaceId: string
  name: string
  policyVersion: number
  revision: number
  role: SharedWorkspaceRole
  consent: SharedWorkspaceConsent | null
  createdAt: string
  updatedAt: string
}

export interface CreateSharedWorkspaceInput {
  workspaceId: string
  name: string
  policyVersion: number
  owner: {
    characterId: number
    characterName: string
  }
}

export interface AcceptSharedWorkspaceConsentInput {
  characterId: number
  policyVersion: number
  scopes: readonly SharedWorkspaceShareScope[]
  expectedWorkspaceRevision: number
}

export type SharedWorkspaceUpsertMutation =
  | SharedWorkspaceUpsert<'watchlist', SharedWatchlistPayload>
  | SharedWorkspaceUpsert<'doctrines', SharedDoctrinePayload>
  | SharedWorkspaceUpsert<'routes', SharedRoutePayload>

interface SharedWorkspaceUpsert<
  Collection extends SharedWorkspaceCollection,
  Payload extends SharedWorkspacePayload
> {
  operation: 'upsert'
  mutationId: string
  collection: Collection
  recordId: string
  /** 0 creates; an existing record or tombstone requires its exact revision. */
  expectedRevision: number
  /** Informational cursor. Different records may merge despite a stale cursor. */
  baseWorkspaceRevision: number
  payload: Payload
}

export interface SharedWorkspaceDeleteMutation {
  operation: 'delete'
  mutationId: string
  collection: SharedWorkspaceCollection
  recordId: string
  expectedRevision: number
  baseWorkspaceRevision: number
}

export type SharedWorkspaceMutation = SharedWorkspaceUpsertMutation | SharedWorkspaceDeleteMutation

export interface SharedWorkspaceChange {
  workspaceId: string
  workspaceRevision: number
  mutationId: string
  collection: SharedWorkspaceCollection
  recordId: string
  recordRevision: number
  operation: 'upsert' | 'delete'
  changedByCharacterId: number
  changedAt: string
}

export type SharedWorkspaceMutationFailureCode =
  | 'member-missing'
  | 'consent-required'
  | 'scope-not-consented'
  | 'forbidden'
  | 'conflict'
  | 'mutation-id-reused'

export type SharedWorkspaceMutationResult =
  | {
      ok: true
      applied: boolean
      staleBase: boolean
      workspace: SharedWorkspaceSnapshot
      record: SharedWorkspaceRecord
      change: SharedWorkspaceChange | null
    }
  | {
      ok: false
      code: SharedWorkspaceMutationFailureCode
      message: string
      workspaceRevision: number
      currentRecord: SharedWorkspaceRecord | null
    }

export interface SharedWorkspacePullRequest {
  workspaceId: string
  afterWorkspaceRevision: number
  limit?: number
}

export interface SharedWorkspacePullPage {
  workspaceId: string
  fromWorkspaceRevision: number
  throughWorkspaceRevision: number
  changes: SharedWorkspaceChange[]
  records: SharedWorkspaceRecord[]
  hasMore: boolean
}

/** Live service adapter. Domain code remains usable with local or cloud transports. */
export interface SharedWorkspaceTransport {
  pull(request: SharedWorkspacePullRequest): Promise<SharedWorkspacePullPage>
  push(
    workspaceId: string,
    actorCharacterId: number,
    mutation: SharedWorkspaceMutation
  ): Promise<SharedWorkspaceMutationResult>
}

export class SharedWorkspaceDomainError extends Error {
  readonly code: 'conflict' | 'forbidden' | 'member-missing' | 'invalid-consent'

  constructor(
    code: SharedWorkspaceDomainError['code'],
    message: string
  ) {
    super(message)
    this.name = 'SharedWorkspaceDomainError'
    this.code = code
  }
}

export function createSharedWorkspace(
  input: CreateSharedWorkspaceInput,
  now = new Date().toISOString()
): SharedWorkspaceSnapshot {
  const timestamp = normalizeIsoDate(now, 'workspace timestamp')
  const policyVersion = positiveInteger(input.policyVersion, 'policy version')
  const ownerId = positiveInteger(input.owner.characterId, 'owner character ID')
  return {
    schemaVersion: 1,
    workspaceId: cleanText(input.workspaceId, 'workspace ID', 128),
    name: cleanText(input.name, 'workspace name', 120),
    policyVersion,
    revision: 1,
    members: [{
      characterId: ownerId,
      characterName: cleanText(input.owner.characterName, 'owner name', 100),
      role: 'owner',
      // Even the creator must explicitly accept current policy and scopes.
      consent: null,
      joinedAt: timestamp,
      updatedAt: timestamp
    }],
    records: [],
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

export function acceptSharedWorkspaceConsent(
  workspace: SharedWorkspaceSnapshot,
  input: AcceptSharedWorkspaceConsentInput,
  now = new Date().toISOString()
): SharedWorkspaceSnapshot {
  validateWorkspace(workspace)
  requireWorkspaceRevision(workspace, input.expectedWorkspaceRevision)
  const timestamp = normalizeIsoDate(now, 'consent timestamp')
  const characterId = positiveInteger(input.characterId, 'character ID')
  if (input.policyVersion !== workspace.policyVersion) {
    throw new SharedWorkspaceDomainError('invalid-consent', 'Consent policy version is not current')
  }
  const member = workspace.members.find((entry) => entry.characterId === characterId)
  if (!member) throw new SharedWorkspaceDomainError('member-missing', 'Workspace member not found')
  const scopes = normalizeScopes(input.scopes)
  const members = workspace.members.map((entry): SharedWorkspaceMember => entry.characterId === characterId
    ? {
        ...entry,
        consent: { policyVersion: workspace.policyVersion, acceptedAt: timestamp, scopes },
        updatedAt: timestamp
      }
    : cloneMember(entry))
  return nextWorkspace(workspace, { members }, timestamp)
}

export function revokeSharedWorkspaceConsent(
  workspace: SharedWorkspaceSnapshot,
  characterId: number,
  expectedWorkspaceRevision: number,
  now = new Date().toISOString()
): SharedWorkspaceSnapshot {
  validateWorkspace(workspace)
  requireWorkspaceRevision(workspace, expectedWorkspaceRevision)
  const timestamp = normalizeIsoDate(now, 'consent timestamp')
  const normalizedId = positiveInteger(characterId, 'character ID')
  if (!workspace.members.some((entry) => entry.characterId === normalizedId)) {
    throw new SharedWorkspaceDomainError('member-missing', 'Workspace member not found')
  }
  const members = workspace.members.map((entry): SharedWorkspaceMember => entry.characterId === normalizedId
    ? { ...entry, consent: null, updatedAt: timestamp }
    : cloneMember(entry))
  return nextWorkspace(workspace, { members }, timestamp)
}

export function addSharedWorkspaceMember(
  workspace: SharedWorkspaceSnapshot,
  actorCharacterId: number,
  member: { characterId: number; characterName: string; role: Exclude<SharedWorkspaceRole, 'owner'> },
  expectedWorkspaceRevision: number,
  now = new Date().toISOString()
): SharedWorkspaceSnapshot {
  validateWorkspace(workspace)
  requireWorkspaceRevision(workspace, expectedWorkspaceRevision)
  requireAccess(workspace, actorCharacterId, 'manage-members')
  const timestamp = normalizeIsoDate(now, 'member timestamp')
  const characterId = positiveInteger(member.characterId, 'member character ID')
  if (workspace.members.some((entry) => entry.characterId === characterId)) {
    throw new SharedWorkspaceDomainError('conflict', 'Workspace member already exists')
  }
  if (member.role !== 'commander' && member.role !== 'editor' && member.role !== 'viewer') {
    throw new TypeError('New member role must be commander, editor or viewer')
  }
  return nextWorkspace(workspace, {
    members: workspace.members.concat({
      characterId,
      characterName: cleanText(member.characterName, 'member name', 100),
      role: member.role,
      consent: null,
      joinedAt: timestamp,
      updatedAt: timestamp
    })
  }, timestamp)
}

export function setSharedWorkspaceMemberRole(
  workspace: SharedWorkspaceSnapshot,
  actorCharacterId: number,
  memberCharacterId: number,
  role: Exclude<SharedWorkspaceRole, 'owner'>,
  expectedWorkspaceRevision: number,
  now = new Date().toISOString()
): SharedWorkspaceSnapshot {
  validateWorkspace(workspace)
  requireWorkspaceRevision(workspace, expectedWorkspaceRevision)
  requireAccess(workspace, actorCharacterId, 'manage-members')
  const timestamp = normalizeIsoDate(now, 'member timestamp')
  const memberId = positiveInteger(memberCharacterId, 'member character ID')
  const member = workspace.members.find((entry) => entry.characterId === memberId)
  if (!member) throw new SharedWorkspaceDomainError('member-missing', 'Workspace member not found')
  if (member.role === 'owner') {
    throw new SharedWorkspaceDomainError('forbidden', 'Owner role cannot be changed by this operation')
  }
  if (role !== 'commander' && role !== 'editor' && role !== 'viewer') {
    throw new TypeError('Member role must be commander, editor or viewer')
  }
  const members = workspace.members.map((entry): SharedWorkspaceMember => entry.characterId === memberId
    ? { ...entry, role, updatedAt: timestamp }
    : cloneMember(entry))
  return nextWorkspace(workspace, { members }, timestamp)
}

export function updateSharedWorkspacePolicy(
  workspace: SharedWorkspaceSnapshot,
  actorCharacterId: number,
  policyVersion: number,
  expectedWorkspaceRevision: number,
  now = new Date().toISOString()
): SharedWorkspaceSnapshot {
  validateWorkspace(workspace)
  requireWorkspaceRevision(workspace, expectedWorkspaceRevision)
  requireAccess(workspace, actorCharacterId, 'manage-policy')
  const nextPolicy = positiveInteger(policyVersion, 'policy version')
  if (nextPolicy <= workspace.policyVersion) {
    throw new SharedWorkspaceDomainError('conflict', 'Policy version must increase')
  }
  // Existing consent stays auditable but is no longer current.
  return nextWorkspace(workspace, { policyVersion: nextPolicy }, normalizeIsoDate(now, 'policy timestamp'))
}

export function canSharedWorkspaceRole(
  role: SharedWorkspaceRole,
  permission: SharedWorkspacePermission
): boolean {
  if (permission === 'read') return true
  if (permission === 'write') return role !== 'viewer'
  return role === 'owner'
}

export function applySharedWorkspaceMutation(
  workspace: SharedWorkspaceSnapshot,
  actorCharacterId: number,
  mutation: SharedWorkspaceMutation,
  now = new Date().toISOString()
): SharedWorkspaceMutationResult {
  validateWorkspace(workspace)
  validateMutation(mutation)
  const timestamp = normalizeIsoDate(now, 'mutation timestamp')
  const actorId = positiveInteger(actorCharacterId, 'actor character ID')
  const current = findRecord(workspace, mutation.collection, mutation.recordId)
  const access = accessFailure(workspace, actorId, mutation.collection)
  if (access) return { ...access, currentRecord: current }

  const sameMutation = workspace.records.find((record) => record.lastMutationId === mutation.mutationId)
  if (sameMutation) {
    if (sameMutation.collection !== mutation.collection || sameMutation.recordId !== mutation.recordId) {
      return failure(
        workspace,
        'mutation-id-reused',
        'Mutation ID was already used for another record',
        current
      )
    }
    return {
      ok: true,
      applied: false,
      staleBase: mutation.baseWorkspaceRevision < workspace.revision,
      workspace,
      record: sameMutation,
      change: null
    }
  }

  const currentRevision = current?.revision ?? 0
  if (mutation.expectedRevision !== currentRevision) {
    return failure(
      workspace,
      'conflict',
      `Expected record revision ${mutation.expectedRevision}; current revision is ${currentRevision}`,
      current
    )
  }
  if (mutation.operation === 'delete' && !current) {
    return failure(workspace, 'conflict', 'Cannot delete a record that does not exist', null)
  }

  const workspaceRevision = workspace.revision + 1
  const record = buildRecord(mutation, actorId, currentRevision + 1, workspaceRevision, timestamp)
  const records = workspace.records
    .filter((entry) => entry.collection !== mutation.collection || entry.recordId !== mutation.recordId)
    .concat(record)
    .sort(compareRecords)
  const next = nextWorkspace(workspace, { records }, timestamp)
  const change: SharedWorkspaceChange = {
    workspaceId: workspace.workspaceId,
    workspaceRevision,
    mutationId: mutation.mutationId,
    collection: mutation.collection,
    recordId: mutation.recordId,
    recordRevision: record.revision,
    operation: mutation.operation,
    changedByCharacterId: actorId,
    changedAt: timestamp
  }
  return {
    ok: true,
    applied: true,
    staleBase: mutation.baseWorkspaceRevision < workspace.revision,
    workspace: next,
    record,
    change
  }
}

function accessFailure(
  workspace: SharedWorkspaceSnapshot,
  characterId: number,
  collection: SharedWorkspaceCollection
): Extract<SharedWorkspaceMutationResult, { ok: false }> | null {
  const member = workspace.members.find((entry) => entry.characterId === characterId)
  if (!member) return failure(workspace, 'member-missing', 'Workspace member not found', null)
  if (!member.consent || member.consent.policyVersion !== workspace.policyVersion) {
    return failure(workspace, 'consent-required', 'Current workspace policy is not accepted', null)
  }
  if (!canSharedWorkspaceRole(member.role, 'write')) {
    return failure(workspace, 'forbidden', 'Member role cannot edit shared records', null)
  }
  if (!member.consent.scopes.includes(collection)) {
    return failure(
      workspace,
      'scope-not-consented',
      `Member did not consent to share ${collection}`,
      null
    )
  }
  return null
}

function requireAccess(
  workspace: SharedWorkspaceSnapshot,
  characterId: number,
  permission: SharedWorkspacePermission
): SharedWorkspaceMember {
  const normalizedId = positiveInteger(characterId, 'actor character ID')
  const member = workspace.members.find((entry) => entry.characterId === normalizedId)
  if (!member) throw new SharedWorkspaceDomainError('member-missing', 'Workspace member not found')
  if (!member.consent || member.consent.policyVersion !== workspace.policyVersion) {
    throw new SharedWorkspaceDomainError('forbidden', 'Current workspace policy is not accepted')
  }
  if (!canSharedWorkspaceRole(member.role, permission)) {
    throw new SharedWorkspaceDomainError('forbidden', `Role cannot ${permission}`)
  }
  return member
}

function buildRecord(
  mutation: SharedWorkspaceMutation,
  actorCharacterId: number,
  revision: number,
  workspaceRevision: number,
  updatedAt: string
): SharedWorkspaceRecord {
  const base: SharedWorkspaceRecordBase = {
    recordId: mutation.recordId,
    revision,
    workspaceRevision,
    updatedByCharacterId: actorCharacterId,
    updatedAt,
    deletedAt: mutation.operation === 'delete' ? updatedAt : null,
    lastMutationId: mutation.mutationId
  }
  if (mutation.operation === 'delete') {
    if (mutation.collection === 'watchlist') return { ...base, collection: 'watchlist', payload: null }
    if (mutation.collection === 'doctrines') return { ...base, collection: 'doctrines', payload: null }
    return { ...base, collection: 'routes', payload: null }
  }
  if (mutation.collection === 'watchlist') {
    return { ...base, collection: 'watchlist', payload: normalizeWatchlist(mutation.payload) }
  }
  if (mutation.collection === 'doctrines') {
    return { ...base, collection: 'doctrines', payload: normalizeDoctrine(mutation.payload) }
  }
  return { ...base, collection: 'routes', payload: normalizeRoute(mutation.payload) }
}

function validateMutation(mutation: SharedWorkspaceMutation): void {
  if (!mutation || typeof mutation !== 'object') throw new TypeError('Mutation must be an object')
  if (mutation.operation !== 'upsert' && mutation.operation !== 'delete') {
    throw new TypeError('Invalid mutation operation')
  }
  if (!SHARED_WORKSPACE_COLLECTIONS.includes(mutation.collection)) {
    throw new TypeError('Invalid shared collection')
  }
  cleanText(mutation.mutationId, 'mutation ID', 128)
  cleanText(mutation.recordId, 'record ID', 128)
  nonNegativeInteger(mutation.expectedRevision, 'expected record revision')
  nonNegativeInteger(mutation.baseWorkspaceRevision, 'base workspace revision')
  if (mutation.operation === 'upsert') {
    if (mutation.collection === 'watchlist') normalizeWatchlist(mutation.payload)
    else if (mutation.collection === 'doctrines') normalizeDoctrine(mutation.payload)
    else normalizeRoute(mutation.payload)
  }
}

function normalizeWatchlist(payload: SharedWatchlistPayload): SharedWatchlistPayload {
  if (!payload || !['character', 'corporation', 'alliance'].includes(payload.entityType)) {
    throw new TypeError('Invalid shared watchlist entity type')
  }
  if (!['watch', 'danger', 'critical'].includes(payload.severity)) {
    throw new TypeError('Invalid shared watchlist severity')
  }
  return {
    entityType: payload.entityType,
    entityId: positiveInteger(payload.entityId, 'watchlist entity ID'),
    name: cleanText(payload.name, 'watchlist name', 200),
    severity: payload.severity,
    tags: normalizeTags(payload.tags),
    note: optionalText(payload.note, 'watchlist note', 2_000)
  }
}

function normalizeDoctrine(payload: SharedDoctrinePayload): SharedDoctrinePayload {
  if (!payload || !Array.isArray(payload.ships) || payload.ships.length > 500) {
    throw new TypeError('Invalid doctrine ship requirements')
  }
  return {
    name: cleanText(payload.name, 'doctrine name', 120),
    description: optionalText(payload.description, 'doctrine description', 5_000),
    ships: payload.ships.map((ship) => {
      const minimum = nonNegativeInteger(ship.minimum, 'minimum ship count')
      const maximum = ship.maximum === null
        ? null
        : nonNegativeInteger(ship.maximum, 'maximum ship count')
      if (maximum !== null && maximum < minimum) {
        throw new TypeError('Maximum ship count cannot be below minimum')
      }
      return {
        typeId: positiveInteger(ship.typeId, 'ship type ID'),
        minimum,
        maximum,
        role: optionalText(ship.role, 'doctrine role', 100)
      }
    }),
    tags: normalizeTags(payload.tags)
  }
}

function normalizeRoute(payload: SharedRoutePayload): SharedRoutePayload {
  if (!payload || !['shortest', 'secure', 'insecure'].includes(payload.mode)) {
    throw new TypeError('Invalid shared route mode')
  }
  if (!Array.isArray(payload.avoidSystemIds) || payload.avoidSystemIds.length > 256) {
    throw new TypeError('Invalid avoided systems')
  }
  return {
    name: cleanText(payload.name, 'route name', 120),
    origin: cleanText(payload.origin, 'route origin', 120),
    destination: cleanText(payload.destination, 'route destination', 120),
    mode: payload.mode,
    avoidSystemIds: [...new Set(payload.avoidSystemIds.map((id) =>
      positiveInteger(id, 'avoided system ID')))].sort((left, right) => left - right),
    tags: normalizeTags(payload.tags)
  }
}

function findRecord(
  workspace: SharedWorkspaceSnapshot,
  collection: SharedWorkspaceCollection,
  recordId: string
): SharedWorkspaceRecord | null {
  return workspace.records.find((record) =>
    record.collection === collection && record.recordId === recordId
  ) ?? null
}

function failure(
  workspace: SharedWorkspaceSnapshot,
  code: SharedWorkspaceMutationFailureCode,
  message: string,
  currentRecord: SharedWorkspaceRecord | null
): Extract<SharedWorkspaceMutationResult, { ok: false }> {
  return { ok: false, code, message, workspaceRevision: workspace.revision, currentRecord }
}

function nextWorkspace(
  workspace: SharedWorkspaceSnapshot,
  patch: Partial<Pick<SharedWorkspaceSnapshot, 'policyVersion' | 'members' | 'records'>>,
  updatedAt: string
): SharedWorkspaceSnapshot {
  return {
    ...workspace,
    policyVersion: patch.policyVersion ?? workspace.policyVersion,
    revision: workspace.revision + 1,
    members: (patch.members ?? workspace.members).map(cloneMember),
    records: (patch.records ?? workspace.records).map(cloneRecord),
    updatedAt
  }
}

function cloneMember(member: SharedWorkspaceMember): SharedWorkspaceMember {
  return {
    ...member,
    consent: member.consent ? { ...member.consent, scopes: [...member.consent.scopes] } : null
  }
}

function cloneRecord(record: SharedWorkspaceRecord): SharedWorkspaceRecord {
  if (record.collection === 'watchlist') {
    return {
      ...record,
      payload: record.payload ? { ...record.payload, tags: [...record.payload.tags] } : null
    }
  }
  if (record.collection === 'doctrines') {
    return {
      ...record,
      payload: record.payload ? {
        ...record.payload,
        ships: record.payload.ships.map((ship) => ({ ...ship })),
        tags: [...record.payload.tags]
      } : null
    }
  }
  return {
    ...record,
    payload: record.payload ? {
      ...record.payload,
      avoidSystemIds: [...record.payload.avoidSystemIds],
      tags: [...record.payload.tags]
    } : null
  }
}

function compareRecords(left: SharedWorkspaceRecord, right: SharedWorkspaceRecord): number {
  return left.collection.localeCompare(right.collection) || left.recordId.localeCompare(right.recordId)
}

function requireWorkspaceRevision(workspace: SharedWorkspaceSnapshot, expected: number): void {
  nonNegativeInteger(expected, 'expected workspace revision')
  if (expected !== workspace.revision) {
    throw new SharedWorkspaceDomainError(
      'conflict',
      `Expected workspace revision ${expected}; current revision is ${workspace.revision}`
    )
  }
}

function validateWorkspace(workspace: SharedWorkspaceSnapshot): void {
  if (!workspace || workspace.schemaVersion !== 1 || !Number.isSafeInteger(workspace.revision) ||
      workspace.revision < 1 || !Array.isArray(workspace.members) ||
      !Array.isArray(workspace.records)) {
    throw new TypeError('Invalid shared workspace snapshot')
  }
}

function normalizeScopes(scopes: readonly SharedWorkspaceShareScope[]): SharedWorkspaceShareScope[] {
  if (!Array.isArray(scopes)) throw new TypeError('Consent scopes must be an array')
  const result = [...new Set(scopes)]
  if (result.some((scope) => !SHARED_WORKSPACE_SHARE_SCOPES.includes(scope))) {
    throw new TypeError('Invalid consent scope')
  }
  return result.sort((left, right) =>
    SHARED_WORKSPACE_SHARE_SCOPES.indexOf(left) - SHARED_WORKSPACE_SHARE_SCOPES.indexOf(right)
  )
}

function normalizeTags(tags: readonly string[]): string[] {
  if (!Array.isArray(tags) || tags.length > 50) throw new TypeError('Invalid tags')
  return [...new Set(tags.map((tag) => cleanText(tag, 'tag', 64)))].sort((left, right) =>
    left.localeCompare(right, 'en')
  )
}

function cleanText(value: string, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`)
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maximumLength || normalized.includes('\0')) {
    throw new TypeError(`Invalid ${label}`)
  }
  return normalized
}

function optionalText(value: string | null, label: string, maximumLength: number): string | null {
  if (value === null) return null
  return cleanText(value, label, maximumLength)
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be positive`)
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be non-negative`)
  return value
}

function normalizeIsoDate(value: string, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date`)
  }
  return new Date(value).toISOString()
}
