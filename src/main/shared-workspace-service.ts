import type { EveAuthorizedSession } from './account-service'

const MAX_REQUEST_BYTES = 32 * 1_024
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024
const REQUEST_TIMEOUT_MS = 20_000
const MAX_ARRAY_ENTRIES = 10_000
const MAX_JSON_DEPTH = 24
const MAX_JSON_NODES = 50_000

const WORKSPACE_ROLES = ['owner', 'commander', 'editor', 'viewer'] as const
const ASSIGNABLE_WORKSPACE_ROLES = ['commander', 'editor', 'viewer'] as const
const WORKSPACE_COLLECTIONS = ['watchlist', 'doctrines', 'routes'] as const
const WORKSPACE_CONSENT_SCOPES = [...WORKSPACE_COLLECTIONS, 'local-presence'] as const
const MUTATION_FAILURE_CODES = [
  'member-missing',
  'consent-required',
  'scope-not-consented',
  'forbidden',
  'conflict',
  'mutation-id-reused'
] as const

const LOCAL_ERROR_CODES = [
  'invalid_configuration',
  'invalid_request',
  'authentication_required',
  'authentication_failed',
  'network_error',
  'request_timeout',
  'response_too_large',
  'invalid_response',
  'backend_error'
] as const

export type SharedWorkspaceRole = (typeof WORKSPACE_ROLES)[number]
export type SharedWorkspaceAssignableRole = (typeof ASSIGNABLE_WORKSPACE_ROLES)[number]
export type SharedWorkspaceCollection = (typeof WORKSPACE_COLLECTIONS)[number]
export type SharedWorkspaceConsentScope = (typeof WORKSPACE_CONSENT_SCOPES)[number]
export type SharedWorkspaceLocalErrorCode = (typeof LOCAL_ERROR_CODES)[number]

export interface SharedWorkspaceConsent {
  policyVersion: number
  scopes: readonly SharedWorkspaceConsentScope[]
  acceptedAt: number
}

export interface SharedWorkspaceConsentHistoryEntry extends SharedWorkspaceConsent {
  event: 'accepted' | 'revoked'
  revokedAt: number | null
  occurredAt: number
}

export interface SharedWorkspaceMember {
  characterId: string
  characterName: string
  role: SharedWorkspaceRole
  consent: SharedWorkspaceConsent | null
  joinedAt: number
  updatedAt: number
}

export interface SharedWorkspaceRecord {
  collection: SharedWorkspaceCollection
  recordId: string
  revision: number
  workspaceRevision: number
  payload: Readonly<Record<string, unknown>> | null
  updatedByCharacterId: string
  updatedAt: number
  deletedAt: number | null
  lastMutationId: string
}

export interface SharedWorkspaceSnapshot {
  schemaVersion: 1
  workspaceId: string
  name: string
  policyVersion: number
  revision: number
  members: readonly SharedWorkspaceMember[]
  records: readonly SharedWorkspaceRecord[]
  createdAt: number
  updatedAt: number
}

export interface SharedWorkspaceSummary {
  workspaceId: string
  name: string
  policyVersion: number
  revision: number
  role: SharedWorkspaceRole
  consent: SharedWorkspaceConsent | null
  createdAt: number
  updatedAt: number
}

export interface SharedWorkspaceChange {
  workspaceId: string
  workspaceRevision: number
  mutationId: string
  collection: SharedWorkspaceCollection
  recordId: string
  recordRevision: number
  operation: 'upsert' | 'delete'
  changedByCharacterId: string
  changedAt: number
}

export interface SharedWorkspacePullPage {
  workspaceId: string
  fromWorkspaceRevision: number
  throughWorkspaceRevision: number
  changes: readonly SharedWorkspaceChange[]
  records: readonly SharedWorkspaceRecord[]
  hasMore: boolean
}

export type SharedWorkspaceMutation = {
  operation: 'upsert'
  mutationId: string
  collection: SharedWorkspaceCollection
  recordId: string
  expectedRevision: number
  baseWorkspaceRevision: number
  payload: Readonly<Record<string, unknown>>
} | {
  operation: 'delete'
  mutationId: string
  collection: SharedWorkspaceCollection
  recordId: string
  expectedRevision: number
  baseWorkspaceRevision: number
}

export type SharedWorkspaceMutationFailureCode = (typeof MUTATION_FAILURE_CODES)[number]

export type SharedWorkspaceMutationResult = {
  ok: true
  applied: boolean
  staleBase: boolean
  workspace: SharedWorkspaceSnapshot
  record: SharedWorkspaceRecord
  change: SharedWorkspaceChange | null
} | {
  ok: false
  code: SharedWorkspaceMutationFailureCode
  message: string
  workspaceRevision: number
  currentRecord: SharedWorkspaceRecord | null
}

export interface SharedWorkspacePresence {
  characterId: string
  characterName: string
  solarSystemId: string
  solarSystemName: string | null
  revision: number
  observedAt: number
  expiresAt: number
}

export interface SharedWorkspaceOperationResult {
  applied: boolean
  workspace: SharedWorkspaceSnapshot
}

export interface SharedWorkspacePresenceResult {
  applied: boolean
  presence: SharedWorkspacePresence | null
}

export interface SharedWorkspaceClearPresenceResult {
  applied: boolean
}

export interface SharedWorkspaceCreateInput {
  workspaceId: string
  name: string
  policyVersion: number
  mutationId: string
}

export interface SharedWorkspaceConsentInput {
  policyVersion: number
  scopes: readonly SharedWorkspaceConsentScope[]
  expectedWorkspaceRevision: number
  mutationId: string
}

export interface SharedWorkspaceRevisionInput {
  expectedWorkspaceRevision: number
  mutationId: string
}

export interface SharedWorkspaceAddMemberInput extends SharedWorkspaceRevisionInput {
  characterId: string
  characterName: string
  role: SharedWorkspaceAssignableRole
}

export interface SharedWorkspaceSetMemberRoleInput extends SharedWorkspaceRevisionInput {
  role: SharedWorkspaceAssignableRole
}

export interface SharedWorkspacePolicyInput extends SharedWorkspaceRevisionInput {
  policyVersion: number
}

export interface SharedWorkspacePresenceInput {
  solarSystemId: string
  solarSystemName?: string | null
  ttlSeconds: number
  expectedRevision: number
  mutationId: string
}

export interface SharedWorkspaceClearPresenceInput {
  expectedRevision: number
  mutationId: string
}

export interface SharedWorkspaceAccount {
  /** Active-character access token; it stays in Electron main and becomes Authorization. */
  getAuthorizedSession(): Promise<EveAuthorizedSession | null>
  /**
   * Optional paid-owner credential for a different active alt. It is sent only in the dedicated
   * owner header; the active character remains the actor represented by Authorization.
   */
  getOwnerAuthorizedSession?(): Promise<EveAuthorizedSession | null>
}

export interface SharedWorkspaceServiceOptions {
  baseUrl: string
  account: SharedWorkspaceAccount
  fetch: typeof fetch
}

/**
 * Stable transport error. Backend codes are preserved verbatim when their envelope is valid;
 * client-side failures use one of SharedWorkspaceLocalErrorCode.
 */
export class SharedWorkspaceServiceError extends Error {
  readonly code: string
  readonly httpStatus: number | null
  readonly requestId: string | null

  constructor(
    code: string,
    message: string,
    options: { httpStatus?: number | null; requestId?: string | null } = {}
  ) {
    super(message)
    this.name = 'SharedWorkspaceServiceError'
    this.code = code
    this.httpStatus = options.httpStatus ?? null
    this.requestId = options.requestId ?? null
  }
}

/** Main-process REST client for character-authenticated Corp/Fleet workspaces. */
export class SharedWorkspaceService {
  private readonly baseUrl: string
  private readonly account: SharedWorkspaceAccount
  private readonly fetch: typeof fetch

  constructor(options: SharedWorkspaceServiceOptions) {
    if (!isRecord(options)) {
      throw clientError('invalid_configuration', 'Invalid workspace-backend configuration')
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    if (!options.account || typeof options.account.getAuthorizedSession !== 'function') {
      throw clientError('invalid_configuration', 'EVE SSO account service is not configured')
    }
    if (
      options.account.getOwnerAuthorizedSession !== undefined &&
      typeof options.account.getOwnerAuthorizedSession !== 'function'
    ) {
      throw clientError('invalid_configuration', 'Invalid owner EVE SSO account service')
    }
    if (typeof options.fetch !== 'function') {
      throw clientError('invalid_configuration', 'Workspace-backend HTTP transport is not configured')
    }
    this.account = options.account
    this.fetch = options.fetch
  }

  async listWorkspaces(): Promise<SharedWorkspaceSummary[]> {
    const value = await this.authorizedRequest('/v1/workspaces')
    return parseArrayField(value, 'workspaces', parseWorkspaceSummary)
  }

  async createWorkspace(
    input: SharedWorkspaceCreateInput
  ): Promise<SharedWorkspaceOperationResult> {
    const body = {
      workspaceId: requestId(input.workspaceId, 'workspaceId'),
      name: requestText(input.name, 'name', 120),
      policyVersion: requestPositiveInteger(input.policyVersion, 'policyVersion'),
      mutationId: requestId(input.mutationId, 'mutationId')
    }
    return parseOperationResult(await this.authorizedRequest('/v1/workspaces', 'POST', body))
  }

  async getWorkspace(workspaceId: string): Promise<SharedWorkspaceSnapshot> {
    const value = await this.authorizedRequest(workspacePath(workspaceId))
    return parseWorkspaceSnapshot(requiredRecordField(value, 'workspace'))
  }

  /** Alias that makes the filtered-snapshot behavior explicit to callers. */
  getSnapshot(workspaceId: string): Promise<SharedWorkspaceSnapshot> {
    return this.getWorkspace(workspaceId)
  }

  async getConsentHistory(workspaceId: string): Promise<SharedWorkspaceConsentHistoryEntry[]> {
    const value = await this.authorizedRequest(`${workspacePath(workspaceId)}/consent`)
    return parseArrayField(value, 'consents', parseConsentHistory)
  }

  async acceptConsent(
    workspaceId: string,
    input: SharedWorkspaceConsentInput
  ): Promise<SharedWorkspaceOperationResult> {
    const body = {
      policyVersion: requestPositiveInteger(input.policyVersion, 'policyVersion'),
      scopes: requestScopes(input.scopes),
      expectedWorkspaceRevision: requestNonNegativeInteger(
        input.expectedWorkspaceRevision,
        'expectedWorkspaceRevision'
      ),
      mutationId: requestId(input.mutationId, 'mutationId')
    }
    return parseOperationResult(await this.authorizedRequest(
      `${workspacePath(workspaceId)}/consent`,
      'PUT',
      body
    ))
  }

  async revokeConsent(
    workspaceId: string,
    input: SharedWorkspaceRevisionInput
  ): Promise<SharedWorkspaceOperationResult> {
    return parseOperationResult(await this.authorizedRequest(
      `${workspacePath(workspaceId)}/consent`,
      'DELETE',
      revisionBody(input)
    ))
  }

  async listMembers(workspaceId: string): Promise<SharedWorkspaceMember[]> {
    const value = await this.authorizedRequest(`${workspacePath(workspaceId)}/members`)
    return parseArrayField(value, 'members', parseMember)
  }

  async addMember(
    workspaceId: string,
    input: SharedWorkspaceAddMemberInput
  ): Promise<SharedWorkspaceOperationResult> {
    const body = {
      characterId: requestCharacterId(input.characterId, 'characterId'),
      characterName: requestText(input.characterName, 'characterName', 100),
      role: requestAssignableRole(input.role),
      ...revisionBody(input)
    }
    return parseOperationResult(await this.authorizedRequest(
      `${workspacePath(workspaceId)}/members`,
      'POST',
      body
    ))
  }

  async setMemberRole(
    workspaceId: string,
    characterId: string,
    input: SharedWorkspaceSetMemberRoleInput
  ): Promise<SharedWorkspaceOperationResult> {
    const path = `${workspacePath(workspaceId)}/members/${encodeURIComponent(
      requestCharacterId(characterId, 'characterId')
    )}`
    return parseOperationResult(await this.authorizedRequest(path, 'PATCH', {
      role: requestAssignableRole(input.role),
      ...revisionBody(input)
    }))
  }

  async removeMember(
    workspaceId: string,
    characterId: string,
    input: SharedWorkspaceRevisionInput
  ): Promise<SharedWorkspaceOperationResult> {
    const path = `${workspacePath(workspaceId)}/members/${encodeURIComponent(
      requestCharacterId(characterId, 'characterId')
    )}`
    return parseOperationResult(await this.authorizedRequest(path, 'DELETE', revisionBody(input)))
  }

  async updatePolicy(
    workspaceId: string,
    input: SharedWorkspacePolicyInput
  ): Promise<SharedWorkspaceOperationResult> {
    return parseOperationResult(await this.authorizedRequest(
      `${workspacePath(workspaceId)}/policy`,
      'PATCH',
      {
        policyVersion: requestPositiveInteger(input.policyVersion, 'policyVersion'),
        ...revisionBody(input)
      }
    ))
  }

  async applyMutation(
    workspaceId: string,
    mutation: SharedWorkspaceMutation
  ): Promise<SharedWorkspaceMutationResult> {
    const body = requestMutation(mutation)
    const value = await this.authorizedRequest(
      `${workspacePath(workspaceId)}/mutations`,
      'POST',
      body
    )
    return parseMutationResult(requiredRecordField(value, 'result'))
  }

  async pullChanges(
    workspaceId: string,
    afterWorkspaceRevision = 0,
    limit = 100
  ): Promise<SharedWorkspacePullPage> {
    const after = requestNonNegativeInteger(afterWorkspaceRevision, 'afterWorkspaceRevision')
    const normalizedLimit = requestIntegerRange(limit, 'limit', 1, 500)
    const query = new URLSearchParams({
      afterWorkspaceRevision: String(after),
      limit: String(normalizedLimit)
    })
    const value = await this.authorizedRequest(
      `${workspacePath(workspaceId)}/changes?${query.toString()}`
    )
    return parsePullPage(requiredRecordField(value, 'page'))
  }

  async listRecords(
    workspaceId: string,
    collection?: SharedWorkspaceCollection
  ): Promise<SharedWorkspaceRecord[]> {
    const query = collection === undefined
      ? ''
      : `?${new URLSearchParams({ collection: requestCollection(collection) }).toString()}`
    const value = await this.authorizedRequest(`${workspacePath(workspaceId)}/records${query}`)
    return parseArrayField(value, 'records', parseRecord)
  }

  async listPresence(workspaceId: string): Promise<SharedWorkspacePresence[]> {
    const value = await this.authorizedRequest(`${workspacePath(workspaceId)}/presence`)
    return parseArrayField(value, 'presence', parsePresence)
  }

  async upsertPresence(
    workspaceId: string,
    input: SharedWorkspacePresenceInput
  ): Promise<SharedWorkspacePresenceResult> {
    const body = {
      solarSystemId: requestDecimalId(input.solarSystemId, 'solarSystemId'),
      ...(input.solarSystemName === undefined
        ? {}
        : {
            solarSystemName: input.solarSystemName === null
              ? null
              : requestText(input.solarSystemName, 'solarSystemName', 100)
          }),
      ttlSeconds: requestIntegerRange(input.ttlSeconds, 'ttlSeconds', 30, 300),
      expectedRevision: requestNonNegativeInteger(input.expectedRevision, 'expectedRevision'),
      mutationId: requestId(input.mutationId, 'mutationId')
    }
    return parsePresenceResult(await this.authorizedRequest(
      `${workspacePath(workspaceId)}/presence`,
      'PUT',
      body
    ))
  }

  async clearPresence(
    workspaceId: string,
    input: SharedWorkspaceClearPresenceInput
  ): Promise<SharedWorkspaceClearPresenceResult> {
    return parseClearPresenceResult(await this.authorizedRequest(
      `${workspacePath(workspaceId)}/presence`,
      'DELETE',
      {
        expectedRevision: requestNonNegativeInteger(input.expectedRevision, 'expectedRevision'),
        mutationId: requestId(input.mutationId, 'mutationId')
      }
    ))
  }

  private async authorizedRequest(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
    body?: Readonly<Record<string, unknown>>
  ): Promise<unknown> {
    let authorized: EveAuthorizedSession | null
    try {
      authorized = await this.account.getAuthorizedSession()
    } catch {
      throw clientError('authentication_failed', 'Could not refresh EVE SSO session')
    }
    if (!isAuthorizedSession(authorized)) {
      throw clientError('authentication_required', 'Sign in through EVE Online is required')
    }

    let ownerAuthorized: EveAuthorizedSession | null = null
    if (this.account.getOwnerAuthorizedSession) {
      try {
        ownerAuthorized = await this.account.getOwnerAuthorizedSession()
      } catch {
        throw clientError('authentication_failed', 'Could not refresh owner EVE SSO session')
      }
      if (ownerAuthorized !== null && !isAuthorizedSession(ownerAuthorized)) {
        throw clientError('authentication_failed', 'Owner EVE SSO session is corrupted')
      }
    }
    const ownerAccessToken = ownerAuthorized &&
      ownerAuthorized.session.characterId !== authorized.session.characterId
      ? ownerAuthorized.accessToken
      : null

    const serializedBody = body === undefined ? undefined : serializeRequestBody(body)
    let response: Response
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${authorized.accessToken}`,
          ...(ownerAccessToken === null
            ? {}
            : { 'x-fly-safe-owner-authorization': `Bearer ${ownerAccessToken}` }),
          ...(serializedBody === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: serializedBody,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      if (isTimeoutError(error)) {
        throw clientError('request_timeout', 'Workspace-backend request timed out')
      }
      throw clientError('network_error', 'Could not reach workspace backend')
    }

    let value: unknown
    try {
      value = await readJsonResponse(response)
    } catch (error) {
      if (error instanceof SharedWorkspaceServiceError) throw error
      throw clientError('network_error', 'Workspace-backend connection was interrupted')
    }

    if (!response.ok) {
      throw parseBackendError(
        value,
        response,
        ownerAccessToken === null
          ? [authorized.accessToken]
          : [authorized.accessToken, ownerAccessToken]
      )
    }
    return value
  }
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw clientError('invalid_configuration', 'Workspace-backend URL is not configured')
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw clientError('invalid_configuration', 'Invalid workspace-backend URL')
  }
  const local = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
    || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw clientError(
      'invalid_configuration',
      'Workspace backend requires HTTPS; HTTP is allowed only for localhost'
    )
  }
  if (url.username || url.password || url.search || url.hash) {
    throw clientError('invalid_configuration', 'Workspace-backend URL contains forbidden parts')
  }
  return url.toString().replace(/\/+$/u, '')
}

function workspacePath(value: string): string {
  return `/v1/workspaces/${encodeURIComponent(requestId(value, 'workspaceId'))}`
}

function revisionBody(input: SharedWorkspaceRevisionInput): Record<string, unknown> {
  return {
    expectedWorkspaceRevision: requestNonNegativeInteger(
      input.expectedWorkspaceRevision,
      'expectedWorkspaceRevision'
    ),
    mutationId: requestId(input.mutationId, 'mutationId')
  }
}

function requestMutation(value: SharedWorkspaceMutation): Record<string, unknown> {
  if (!isRecord(value) || (value.operation !== 'upsert' && value.operation !== 'delete')) {
    throw clientError('invalid_request', 'Invalid workspace mutation')
  }
  const common = {
    operation: value.operation,
    mutationId: requestId(value.mutationId, 'mutationId'),
    collection: requestCollection(value.collection),
    recordId: requestId(value.recordId, 'recordId'),
    expectedRevision: requestNonNegativeInteger(value.expectedRevision, 'expectedRevision'),
    baseWorkspaceRevision: requestNonNegativeInteger(
      value.baseWorkspaceRevision,
      'baseWorkspaceRevision'
    )
  }
  if (value.operation === 'delete') return common
  return { ...common, payload: cloneJsonObject(value.payload, 'payload') }
}

function requestScopes(value: readonly SharedWorkspaceConsentScope[]): SharedWorkspaceConsentScope[] {
  if (!Array.isArray(value)) throw clientError('invalid_request', 'scopes must be an array')
  const scopes = value.map((scope) => requestEnum(scope, WORKSPACE_CONSENT_SCOPES, 'scope'))
  return [...new Set(scopes)].sort((left, right) =>
    WORKSPACE_CONSENT_SCOPES.indexOf(left) - WORKSPACE_CONSENT_SCOPES.indexOf(right)
  )
}

function requestId(value: unknown, field: string): string {
  if (typeof value !== 'string') throw clientError('invalid_request', `${field} must be a string`)
  const normalized = value.normalize('NFKC').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(normalized)) {
    throw clientError('invalid_request', `Invalid field ${field}`)
  }
  return normalized
}

function requestCharacterId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{6,20}$/u.test(value) || /^0+$/u.test(value)) {
    throw clientError('invalid_request', `Invalid field ${field}`)
  }
  return value.replace(/^0+(?=\d)/u, '')
}

function requestDecimalId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{1,20}$/u.test(value) || /^0+$/u.test(value)) {
    throw clientError('invalid_request', `Invalid field ${field}`)
  }
  return value.replace(/^0+(?=\d)/u, '')
}

function requestText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string') throw clientError('invalid_request', `${field} must be a string`)
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!normalized || normalized.length > maximumLength || normalized.includes('\0')) {
    throw clientError('invalid_request', `Invalid field ${field}`)
  }
  return normalized
}

function requestPositiveInteger(value: unknown, field: string): number {
  const result = requestNonNegativeInteger(value, field)
  if (result === 0) throw clientError('invalid_request', `${field} must be greater than zero`)
  return result
}

function requestNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw clientError('invalid_request', `${field} must be a non-negative whole number`)
  }
  return value as number
}

function requestIntegerRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number {
  const result = requestNonNegativeInteger(value, field)
  if (result < minimum || result > maximum) {
    throw clientError('invalid_request', `${field} is outside the allowed range`)
  }
  return result
}

function requestCollection(value: unknown): SharedWorkspaceCollection {
  return requestEnum(value, WORKSPACE_COLLECTIONS, 'collection')
}

function requestAssignableRole(value: unknown): SharedWorkspaceAssignableRole {
  return requestEnum(value, ASSIGNABLE_WORKSPACE_ROLES, 'role')
}

function requestEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string
): Values[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw clientError('invalid_request', `Invalid field ${field}`)
  }
  return value as Values[number]
}

function serializeRequestBody(value: Readonly<Record<string, unknown>>): string {
  const normalized = cloneJsonObject(value, 'request body')
  const result = JSON.stringify(normalized)
  if (Buffer.byteLength(result, 'utf8') > MAX_REQUEST_BYTES) {
    throw clientError('invalid_request', 'Workspace-backend request is too large')
  }
  return result
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw clientError('invalid_response', 'Workspace backend did not return JSON')
  }
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw clientError('response_too_large', 'Workspace-backend response is too large')
  }
  const bytes = await readLimitedBytes(response)
  if (bytes.byteLength === 0) {
    throw clientError('invalid_response', 'Workspace backend returned an empty response')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw clientError('invalid_response', 'Workspace backend returned invalid UTF-8')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw clientError('invalid_response', 'Workspace backend returned invalid JSON')
  }
}

async function readLimitedBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_RESPONSE_BYTES) {
      void reader.cancel()
      throw clientError('response_too_large', 'Workspace-backend response is too large')
    }
    chunks.push(value)
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function parseBackendError(
  value: unknown,
  response: Response,
  accessTokens: readonly string[]
): SharedWorkspaceServiceError {
  const envelope = isRecord(value) ? value : null
  const error = envelope && isRecord(envelope.error) ? envelope.error : null
  const code = error && typeof error.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/u.test(error.code)
    ? error.code
    : 'backend_error'
  const rawMessage = error && typeof error.message === 'string' && error.message.trim()
    ? error.message.trim()
    : `Workspace backend responded ${response.status}`
  const message = accessTokens.reduce(
    (redacted, accessToken) => redacted.replaceAll(accessToken, '[redacted]'),
    rawMessage
  ).slice(0, 500)
  const bodyRequestId = envelope && typeof envelope.requestId === 'string'
    ? envelope.requestId
    : null
  const requestIdValue = bodyRequestId ?? response.headers.get('x-request-id')
  const requestId = requestIdValue && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestIdValue)
    ? requestIdValue
    : null
  return new SharedWorkspaceServiceError(code, message, {
    httpStatus: response.status,
    requestId
  })
}

function parseOperationResult(value: unknown): SharedWorkspaceOperationResult {
  const record = responseRecord(value, 'workspace operation')
  return {
    applied: responseBoolean(record, 'applied'),
    workspace: parseWorkspaceSnapshot(requiredRecordField(record, 'workspace'))
  }
}

function parseWorkspaceSnapshot(value: unknown): SharedWorkspaceSnapshot {
  const record = responseRecord(value, 'workspace')
  if (record.schemaVersion !== 1) invalidResponse('schemaVersion')
  return {
    schemaVersion: 1,
    workspaceId: responseId(record, 'workspaceId'),
    name: responseText(record, 'name', 120),
    policyVersion: responsePositiveInteger(record, 'policyVersion'),
    revision: responsePositiveInteger(record, 'revision'),
    members: responseArray(record, 'members', parseMember),
    records: responseArray(record, 'records', parseRecord),
    createdAt: responseUnixTime(record, 'createdAt'),
    updatedAt: responseUnixTime(record, 'updatedAt')
  }
}

function parseWorkspaceSummary(value: unknown): SharedWorkspaceSummary {
  const record = responseRecord(value, 'workspace summary')
  return {
    workspaceId: responseId(record, 'workspaceId'),
    name: responseText(record, 'name', 120),
    policyVersion: responsePositiveInteger(record, 'policyVersion'),
    revision: responsePositiveInteger(record, 'revision'),
    role: responseEnum(record, 'role', WORKSPACE_ROLES),
    consent: responseNullableRecord(record, 'consent', parseConsent),
    createdAt: responseUnixTime(record, 'createdAt'),
    updatedAt: responseUnixTime(record, 'updatedAt')
  }
}

function parseConsent(value: unknown): SharedWorkspaceConsent {
  const record = responseRecord(value, 'workspace consent')
  return {
    policyVersion: responsePositiveInteger(record, 'policyVersion'),
    scopes: responseEnumArray(record, 'scopes', WORKSPACE_CONSENT_SCOPES),
    acceptedAt: responseUnixTime(record, 'acceptedAt')
  }
}

function parseConsentHistory(value: unknown): SharedWorkspaceConsentHistoryEntry {
  const record = responseRecord(value, 'workspace consent history')
  return {
    ...parseConsent(record),
    event: responseEnum(record, 'event', ['accepted', 'revoked'] as const),
    revokedAt: responseNullableUnixTime(record, 'revokedAt'),
    occurredAt: responseUnixTime(record, 'occurredAt')
  }
}

function parseMember(value: unknown): SharedWorkspaceMember {
  const record = responseRecord(value, 'workspace member')
  return {
    characterId: responseCharacterId(record, 'characterId'),
    characterName: responseText(record, 'characterName', 100),
    role: responseEnum(record, 'role', WORKSPACE_ROLES),
    consent: responseNullableRecord(record, 'consent', parseConsent),
    joinedAt: responseUnixTime(record, 'joinedAt'),
    updatedAt: responseUnixTime(record, 'updatedAt')
  }
}

function parseRecord(value: unknown): SharedWorkspaceRecord {
  const record = responseRecord(value, 'workspace record')
  return {
    collection: responseEnum(record, 'collection', WORKSPACE_COLLECTIONS),
    recordId: responseId(record, 'recordId'),
    revision: responsePositiveInteger(record, 'revision'),
    workspaceRevision: responsePositiveInteger(record, 'workspaceRevision'),
    payload: record.payload === null ? null : cloneJsonObject(record.payload, 'payload', true),
    updatedByCharacterId: responseCharacterId(record, 'updatedByCharacterId'),
    updatedAt: responseUnixTime(record, 'updatedAt'),
    deletedAt: responseNullableUnixTime(record, 'deletedAt'),
    lastMutationId: responseId(record, 'lastMutationId')
  }
}

function parseChange(value: unknown): SharedWorkspaceChange {
  const record = responseRecord(value, 'workspace change')
  return {
    workspaceId: responseId(record, 'workspaceId'),
    workspaceRevision: responsePositiveInteger(record, 'workspaceRevision'),
    mutationId: responseId(record, 'mutationId'),
    collection: responseEnum(record, 'collection', WORKSPACE_COLLECTIONS),
    recordId: responseId(record, 'recordId'),
    recordRevision: responsePositiveInteger(record, 'recordRevision'),
    operation: responseEnum(record, 'operation', ['upsert', 'delete'] as const),
    changedByCharacterId: responseCharacterId(record, 'changedByCharacterId'),
    changedAt: responseUnixTime(record, 'changedAt')
  }
}

function parsePullPage(value: unknown): SharedWorkspacePullPage {
  const record = responseRecord(value, 'workspace change page')
  return {
    workspaceId: responseId(record, 'workspaceId'),
    fromWorkspaceRevision: responseNonNegativeInteger(record, 'fromWorkspaceRevision'),
    throughWorkspaceRevision: responseNonNegativeInteger(record, 'throughWorkspaceRevision'),
    changes: responseArray(record, 'changes', parseChange),
    records: responseArray(record, 'records', parseRecord),
    hasMore: responseBoolean(record, 'hasMore')
  }
}

function parseMutationResult(value: unknown): SharedWorkspaceMutationResult {
  const record = responseRecord(value, 'workspace mutation result')
  const ok = responseBoolean(record, 'ok')
  if (ok) {
    return {
      ok: true,
      applied: responseBoolean(record, 'applied'),
      staleBase: responseBoolean(record, 'staleBase'),
      workspace: parseWorkspaceSnapshot(requiredRecordField(record, 'workspace')),
      record: parseRecord(requiredRecordField(record, 'record')),
      change: responseNullableRecord(record, 'change', parseChange)
    }
  }
  return {
    ok: false,
    code: responseEnum(record, 'code', MUTATION_FAILURE_CODES),
    message: responseText(record, 'message', 500),
    workspaceRevision: responseNonNegativeInteger(record, 'workspaceRevision'),
    currentRecord: responseNullableRecord(record, 'currentRecord', parseRecord)
  }
}

function parsePresence(value: unknown): SharedWorkspacePresence {
  const record = responseRecord(value, 'workspace presence')
  return {
    characterId: responseCharacterId(record, 'characterId'),
    characterName: responseText(record, 'characterName', 100),
    solarSystemId: responseDecimalId(record, 'solarSystemId'),
    solarSystemName: responseNullableText(record, 'solarSystemName', 100),
    revision: responsePositiveInteger(record, 'revision'),
    observedAt: responseUnixTime(record, 'observedAt'),
    expiresAt: responseUnixTime(record, 'expiresAt')
  }
}

function parsePresenceResult(value: unknown): SharedWorkspacePresenceResult {
  const record = responseRecord(value, 'workspace presence result')
  return {
    applied: responseBoolean(record, 'applied'),
    presence: responseNullableRecord(record, 'presence', parsePresence)
  }
}

function parseClearPresenceResult(value: unknown): SharedWorkspaceClearPresenceResult {
  return { applied: responseBoolean(responseRecord(value, 'workspace presence result'), 'applied') }
}

function parseArrayField<T>(
  value: unknown,
  field: string,
  parser: (entry: unknown) => T
): T[] {
  return responseArray(responseRecord(value, 'response'), field, parser)
}

function responseRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) invalidResponse(name)
  return value
}

function requiredRecordField(value: unknown, field: string): Record<string, unknown> {
  const record = responseRecord(value, 'response')
  return responseRecord(record[field], field)
}

function responseArray<T>(
  value: Record<string, unknown>,
  field: string,
  parser: (entry: unknown) => T
): T[] {
  const input = value[field]
  if (!Array.isArray(input) || input.length > MAX_ARRAY_ENTRIES) invalidResponse(field)
  return input.map(parser)
}

function responseEnumArray<const Values extends readonly string[]>(
  value: Record<string, unknown>,
  field: string,
  allowed: Values
): Values[number][] {
  const result = responseArray(value, field, (entry) => {
    if (typeof entry !== 'string' || !allowed.includes(entry)) invalidResponse(field)
    return entry as Values[number]
  })
  if (new Set(result).size !== result.length) invalidResponse(field)
  return result
}

function responseNullableRecord<T>(
  value: Record<string, unknown>,
  field: string,
  parser: (entry: unknown) => T
): T | null {
  return value[field] === null ? null : parser(value[field])
}

function responseText(value: Record<string, unknown>, field: string, maximumLength: number): string {
  const result = value[field]
  if (typeof result !== 'string' || !result || result.length > maximumLength || result.includes('\0')) {
    invalidResponse(field)
  }
  return result
}

function responseNullableText(
  value: Record<string, unknown>,
  field: string,
  maximumLength: number
): string | null {
  return value[field] === null ? null : responseText(value, field, maximumLength)
}

function responseId(value: Record<string, unknown>, field: string): string {
  const result = responseText(value, field, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(result)) invalidResponse(field)
  return result
}

function responseCharacterId(value: Record<string, unknown>, field: string): string {
  const result = value[field]
  if (typeof result !== 'string' || !/^\d{6,20}$/u.test(result) || /^0+$/u.test(result)) {
    invalidResponse(field)
  }
  return result
}

function responseDecimalId(value: Record<string, unknown>, field: string): string {
  const result = value[field]
  if (typeof result !== 'string' || !/^\d{1,20}$/u.test(result) || /^0+$/u.test(result)) {
    invalidResponse(field)
  }
  return result
}

function responsePositiveInteger(value: Record<string, unknown>, field: string): number {
  const result = responseNonNegativeInteger(value, field)
  if (result === 0) invalidResponse(field)
  return result
}

function responseNonNegativeInteger(value: Record<string, unknown>, field: string): number {
  const result = value[field]
  if (!Number.isSafeInteger(result) || (result as number) < 0) invalidResponse(field)
  return result as number
}

function responseUnixTime(value: Record<string, unknown>, field: string): number {
  return responseNonNegativeInteger(value, field)
}

function responseNullableUnixTime(value: Record<string, unknown>, field: string): number | null {
  return value[field] === null ? null : responseUnixTime(value, field)
}

function responseBoolean(value: Record<string, unknown>, field: string): boolean {
  if (typeof value[field] !== 'boolean') invalidResponse(field)
  return value[field] as boolean
}

function responseEnum<const Values extends readonly string[]>(
  value: Record<string, unknown>,
  field: string,
  allowed: Values
): Values[number] {
  const result = value[field]
  if (typeof result !== 'string' || !allowed.includes(result)) invalidResponse(field)
  return result as Values[number]
}

function cloneJsonObject(
  value: unknown,
  field: string,
  response = false
): Record<string, unknown> {
  try {
    const state = { nodes: 0 }
    const cloned = cloneJsonValue(value, 0, state)
    if (!isRecord(cloned)) throw clientError('invalid_request', `${field} must be a JSON object`)
    return cloned
  } catch (error) {
    if (response && error instanceof SharedWorkspaceServiceError) invalidResponse(field)
    throw error
  }
}

function cloneJsonValue(value: unknown, depth: number, state: { nodes: number }): unknown {
  state.nodes += 1
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) {
    throw clientError('invalid_request', 'JSON is too complex')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry, depth + 1, state))
  if (!isPlainRecord(value)) throw clientError('invalid_request', 'Value is not JSON')
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw clientError('invalid_request', 'Forbidden JSON field name')
    }
    result[key] = cloneJsonValue(entry, depth + 1, state)
  }
  return result
}

function invalidResponse(field: string): never {
  throw clientError('invalid_response', `Workspace backend returned invalid field ${field}`)
}

function clientError(code: SharedWorkspaceLocalErrorCode, message: string): SharedWorkspaceServiceError {
  return new SharedWorkspaceServiceError(code, message)
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function isAuthorizedSession(value: unknown): value is EveAuthorizedSession {
  if (!isRecord(value) || typeof value.accessToken !== 'string' || value.accessToken.length === 0) {
    return false
  }
  const session = value.session
  return isRecord(session) &&
    Number.isSafeInteger(session.characterId) &&
    (session.characterId as number) > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
