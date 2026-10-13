import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AccessTokenVerifier } from './auth.js'
import type { BillingService } from './billing-service.js'
import {
  ServiceError,
  assertDeviceCode,
  type Device,
  type Invoice,
  type IssuedEntitlement,
  type Plan,
  type Principal,
  type Subscription
} from './domain.js'
import type { EntitlementService } from './entitlement.js'
import type { WalletPollService } from './esi-wallet.js'
import { formatIsk } from './money.js'
import type { WorkspaceRole } from './workspace-domain.js'
import type { WorkspaceService } from './workspace-service.js'
import {
  ZkillRelayError,
  type ZkillRelayService,
  type ZkillRelaySource
} from './zkill-relay.js'

const MAX_BODY_BYTES = 32 * 1_024
const OWNER_AUTHORIZATION_HEADER = 'x-fly-safe-owner-authorization'
const WORKSPACE_ACTOR_FEATURE = 'corp_fleet_intel'
const WORKSPACE_OWNER_FEATURES = ['multi_character', 'corp_fleet_intel'] as const
const ENTITLEMENT_DENIAL_CODES = new Set([
  'subscription_required',
  'subscription_expired',
  'feature_not_entitled'
])

export interface ApiServerOptions {
  auth: AccessTokenVerifier
  billing: BillingService
  entitlements: EntitlementService
  workspaces: WorkspaceService
  adminToken: string
  walletPoll?: WalletPollService | undefined
  publicBaseUrl?: string | undefined
  zkillRelay?: Pick<ZkillRelayService, 'relay'> | undefined
  logger?: Pick<Console, 'info' | 'warn' | 'error'> | undefined
}

export function createApiServer(options: ApiServerOptions): Server {
  if (options.adminToken.length < 32) throw new Error('ADMIN_TOKEN must contain at least 32 characters')
  const logger = options.logger ?? console
  return createServer((request, response) => {
    const requestId = randomUUID()
    void routeRequest(request, response, options, requestId).catch((error: unknown) => {
      const normalized = normalizeError(error)
      if (normalized.httpStatus >= 500) logger.error({ requestId, error })
      else logger.warn({ requestId, code: normalized.code })
      sendJson(response, normalized.httpStatus, {
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details ? { details: normalized.details } : {})
        },
        requestId
      }, requestId)
    })
  })
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiServerOptions,
  requestId: string
): Promise<void> {
  setSecurityHeaders(response, requestId)
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', options.publicBaseUrl ?? 'http://localhost')

  if (method === 'GET' && url.pathname === '/healthz') {
    sendJson(response, 200, { status: 'ok' }, requestId)
    return
  }
  if (method === 'GET' && url.pathname === '/v1/plans') {
    sendJson(response, 200, { plans: options.billing.store.listPlans(true).map(planJson) }, requestId)
    return
  }
  if (method === 'GET' && url.pathname === '/v1/keys') {
    response.setHeader('Cache-Control', 'public, max-age=300')
    sendJson(response, 200, { keys: [await options.entitlements.publicJwk()] }, requestId)
    return
  }

  if (url.pathname.startsWith('/v1/admin/')) {
    authenticateAdmin(request, options.adminToken)
    if (method === 'POST' && url.pathname === '/v1/admin/wallet/poll') {
      if (!options.walletPoll) throw new ServiceError('wallet_poll_unavailable', 'Wallet poll is not configured', 503)
      const summary = await options.walletPoll.poll(true)
      const renewed = options.billing.renewEligibleSubscriptions()
      sendJson(response, 200, { wallet: summary, renewed: renewed.map(subscriptionJson) }, requestId)
      return
    }
    if (method === 'POST' && url.pathname === '/v1/admin/subscriptions/renew') {
      const renewed = options.billing.renewEligibleSubscriptions()
      sendJson(response, 200, { renewed: renewed.map(subscriptionJson) }, requestId)
      return
    }
    throw new ServiceError('not_found', 'Route not found', 404)
  }

  const principal = await authenticateEve(request, options.auth)

  const relayRequest = matchZkillRelayRequest(url)
  if (relayRequest !== null) {
    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('Vary', 'Authorization')
    if (!options.zkillRelay) {
      throw new ServiceError(
        'zkill_relay_unavailable',
        'zKill relay is not configured',
        503
      )
    }
    try {
      const relayed = await options.zkillRelay.relay({
        method,
        source: relayRequest.source,
        path: relayRequest.path
      })
      response.setHeader('X-Fly-Safe-Relay-Cache', relayed.cacheStatus)
      if (relayed.retryAfter !== null) {
        response.setHeader('Retry-After', relayed.retryAfter)
      }
      sendJson(response, relayed.status, relayed.body, requestId)
      return
    } catch (error) {
      if (error instanceof ZkillRelayError) {
        if (error.code === 'method_not_allowed') response.setHeader('Allow', 'GET')
        throw new ServiceError(error.code, error.message, error.httpStatus)
      }
      throw error
    }
  }

  if (url.pathname === '/v1/workspaces' || url.pathname.startsWith('/v1/workspaces/')) {
    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('Vary', 'Authorization, X-Fly-Safe-Owner-Authorization')
    await authorizeWorkspaceActor(request, principal, options)
  }

  if (url.pathname === '/v1/workspaces') {
    if (method === 'GET') {
      sendJson(response, 200, { workspaces: options.workspaces.listWorkspaces(principal) }, requestId)
      return
    }
    if (method === 'POST') {
      const body = await readJsonObject(request)
      const result = options.workspaces.createWorkspace(principal, {
        workspaceId: requiredString(body, 'workspaceId'),
        name: requiredString(body, 'name'),
        policyVersion: requiredInteger(body, 'policyVersion'),
        mutationId: requiredString(body, 'mutationId')
      })
      sendJson(response, result.applied ? 201 : 200, result, requestId)
      return
    }
  }

  const workspaceMatch = /^\/v1\/workspaces\/([^/]+)$/u.exec(url.pathname)
  if (method === 'GET' && workspaceMatch) {
    const workspace = options.workspaces.getWorkspace(principal, decodePathPart(workspaceMatch[1]!))
    sendJson(response, 200, { workspace }, requestId)
    return
  }

  const workspacePolicyMatch = /^\/v1\/workspaces\/([^/]+)\/policy$/u.exec(url.pathname)
  if (method === 'PATCH' && workspacePolicyMatch) {
    const body = await readJsonObject(request)
    const result = options.workspaces.updatePolicy(
      principal,
      decodePathPart(workspacePolicyMatch[1]!),
      {
        policyVersion: requiredInteger(body, 'policyVersion'),
        expectedWorkspaceRevision: requiredInteger(body, 'expectedWorkspaceRevision'),
        mutationId: requiredString(body, 'mutationId')
      }
    )
    sendJson(response, 200, result, requestId)
    return
  }

  const workspaceMembersMatch = /^\/v1\/workspaces\/([^/]+)\/members$/u.exec(url.pathname)
  if (workspaceMembersMatch) {
    const workspaceId = decodePathPart(workspaceMembersMatch[1]!)
    if (method === 'GET') {
      sendJson(response, 200, { members: options.workspaces.listMembers(principal, workspaceId) }, requestId)
      return
    }
    if (method === 'POST') {
      const body = await readJsonObject(request)
      const result = options.workspaces.addMember(principal, workspaceId, {
        characterId: requiredString(body, 'characterId'),
        characterName: requiredString(body, 'characterName'),
        role: requiredString(body, 'role') as WorkspaceRole,
        expectedWorkspaceRevision: requiredInteger(body, 'expectedWorkspaceRevision'),
        mutationId: requiredString(body, 'mutationId')
      })
      sendJson(response, 201, result, requestId)
      return
    }
  }

  const workspaceMemberMatch = /^\/v1\/workspaces\/([^/]+)\/members\/(\d{6,20})$/u.exec(url.pathname)
  if (workspaceMemberMatch) {
    const workspaceId = decodePathPart(workspaceMemberMatch[1]!)
    const memberCharacterId = workspaceMemberMatch[2]!
    if (method === 'PATCH') {
      const body = await readJsonObject(request)
      const result = options.workspaces.setMemberRole(principal, workspaceId, memberCharacterId, {
        role: requiredString(body, 'role') as WorkspaceRole,
        expectedWorkspaceRevision: requiredInteger(body, 'expectedWorkspaceRevision'),
        mutationId: requiredString(body, 'mutationId')
      })
      sendJson(response, 200, result, requestId)
      return
    }
    if (method === 'DELETE') {
      const body = await readJsonObject(request)
      const result = options.workspaces.removeMember(principal, workspaceId, memberCharacterId, {
        expectedWorkspaceRevision: requiredInteger(body, 'expectedWorkspaceRevision'),
        mutationId: requiredString(body, 'mutationId')
      })
      sendJson(response, 200, result, requestId)
      return
    }
  }

  const workspaceConsentMatch = /^\/v1\/workspaces\/([^/]+)\/consent$/u.exec(url.pathname)
  if (workspaceConsentMatch) {
    const workspaceId = decodePathPart(workspaceConsentMatch[1]!)
    if (method === 'GET') {
      sendJson(response, 200, {
        consents: options.workspaces.getConsentHistory(principal, workspaceId)
      }, requestId)
      return
    }
    if (method === 'PUT') {
      const body = await readJsonObject(request)
      const result = options.workspaces.acceptConsent(principal, workspaceId, {
        policyVersion: requiredInteger(body, 'policyVersion'),
        scopes: requiredArray(body, 'scopes'),
        expectedWorkspaceRevision: requiredInteger(body, 'expectedWorkspaceRevision'),
        mutationId: requiredString(body, 'mutationId')
      })
      sendJson(response, 200, result, requestId)
      return
    }
    if (method === 'DELETE') {
      const body = await readJsonObject(request)
      const result = options.workspaces.revokeConsent(principal, workspaceId, {
        expectedWorkspaceRevision: requiredInteger(body, 'expectedWorkspaceRevision'),
        mutationId: requiredString(body, 'mutationId')
      })
      sendJson(response, 200, result, requestId)
      return
    }
  }

  const workspaceRecordsMatch = /^\/v1\/workspaces\/([^/]+)\/records$/u.exec(url.pathname)
  if (method === 'GET' && workspaceRecordsMatch) {
    const records = options.workspaces.listRecords(
      principal,
      decodePathPart(workspaceRecordsMatch[1]!),
      url.searchParams.get('collection') ?? undefined
    )
    sendJson(response, 200, { records }, requestId)
    return
  }

  const workspaceMutationsMatch = /^\/v1\/workspaces\/([^/]+)\/mutations$/u.exec(url.pathname)
  if (method === 'POST' && workspaceMutationsMatch) {
    const body = await readJsonObject(request)
    const result = options.workspaces.applyMutation(
      principal,
      decodePathPart(workspaceMutationsMatch[1]!),
      body
    )
    sendJson(response, 200, { result }, requestId)
    return
  }

  const workspaceChangesMatch = /^\/v1\/workspaces\/([^/]+)\/changes$/u.exec(url.pathname)
  if (method === 'GET' && workspaceChangesMatch) {
    const page = options.workspaces.pullChanges(
      principal,
      decodePathPart(workspaceChangesMatch[1]!),
      queryInteger(url, 'afterWorkspaceRevision', 0),
      queryInteger(url, 'limit', 100)
    )
    sendJson(response, 200, { page }, requestId)
    return
  }

  const workspacePresenceMatch = /^\/v1\/workspaces\/([^/]+)\/presence$/u.exec(url.pathname)
  if (workspacePresenceMatch) {
    const workspaceId = decodePathPart(workspacePresenceMatch[1]!)
    if (method === 'GET') {
      sendJson(response, 200, {
        presence: options.workspaces.listPresence(principal, workspaceId)
      }, requestId)
      return
    }
    if (method === 'PUT') {
      const body = await readJsonObject(request)
      const result = options.workspaces.upsertPresence(principal, workspaceId, {
        solarSystemId: requiredString(body, 'solarSystemId'),
        solarSystemName: optionalString(body, 'solarSystemName'),
        ttlSeconds: requiredInteger(body, 'ttlSeconds'),
        expectedRevision: requiredInteger(body, 'expectedRevision'),
        mutationId: requiredString(body, 'mutationId')
      })
      sendJson(response, 200, result, requestId)
      return
    }
    if (method === 'DELETE') {
      const body = await readJsonObject(request)
      const result = options.workspaces.clearPresence(principal, workspaceId, {
        expectedRevision: requiredInteger(body, 'expectedRevision'),
        mutationId: requiredString(body, 'mutationId')
      })
      sendJson(response, 200, result, requestId)
      return
    }
  }

  if (method === 'POST' && url.pathname === '/v1/invoices') {
    const body = await readJsonObject(request)
    const planId = requiredString(body, 'planId')
    const invoice = options.billing.createSubscriptionInvoice(principal, planId)
    sendJson(response, 201, { invoice: invoiceJson(invoice) }, requestId)
    return
  }
  if (method === 'POST' && url.pathname === '/v1/credit-invoices') {
    const body = await readJsonObject(request)
    const amountIsk = requiredString(body, 'amountIsk')
    const invoice = options.billing.createCreditInvoice(principal, amountIsk)
    sendJson(response, 201, { invoice: invoiceJson(invoice) }, requestId)
    return
  }

  const invoiceMatch = /^\/v1\/invoices\/([A-Za-z0-9-]{8,64})$/u.exec(url.pathname)
  if (method === 'GET' && invoiceMatch) {
    const invoice = options.billing.getInvoice(principal, invoiceMatch[1]!)
    sendJson(response, 200, { invoice: invoiceJson(invoice) }, requestId)
    return
  }

  if (method === 'GET' && url.pathname === '/v1/account') {
    const subscription = options.billing.store.getSubscriptionForCharacter(principal.characterId)
    sendJson(response, 200, {
      account: {
        characterId: principal.characterId,
        characterName: principal.characterName,
        creditBalanceIsk: formatIsk(options.billing.store.getCreditBalance(principal.characterId)),
        subscription: subscription ? subscriptionJson(subscription) : null,
        devices: options.billing.store.listDevices(principal.characterId).map(deviceJson)
      }
    }, requestId)
    return
  }

  if (method === 'POST' && url.pathname === '/v1/devices') {
    const body = await readJsonObject(request)
    const device = options.billing.registerDevice(
      principal,
      requiredString(body, 'deviceCode'),
      optionalString(body, 'label')
    )
    sendJson(response, 201, { device: deviceJson(device) }, requestId)
    return
  }

  const deviceMatch = /^\/v1\/devices\/([A-Za-z0-9-]{8,64})$/u.exec(url.pathname)
  if (method === 'DELETE' && deviceMatch) {
    options.billing.revokeDevice(principal, deviceMatch[1]!)
    response.statusCode = 204
    response.end()
    return
  }

  if (method === 'GET' && url.pathname === '/v1/entitlements/current') {
    const deviceCode = assertDeviceCode(url.searchParams.get('deviceCode') ?? '')
    const entitlement = options.entitlements.getOrIssue(principal.characterId, deviceCode)
    const etag = `"entitlement-${entitlement.id}-${entitlement.revision}"`
    response.setHeader('ETag', etag)
    response.setHeader('Cache-Control', 'private, no-store')
    if (request.headers['if-none-match'] === etag) {
      response.statusCode = 304
      response.end()
      return
    }
    sendJson(response, 200, entitlementJson(entitlement), requestId)
    return
  }

  if (method === 'PATCH' && url.pathname === '/v1/subscription') {
    const body = await readJsonObject(request)
    if (typeof body.autoRenew !== 'boolean') {
      throw new ServiceError('invalid_body', 'autoRenew must be boolean')
    }
    const subscription = options.billing.setAutoRenew(principal, body.autoRenew)
    sendJson(response, 200, { subscription: subscriptionJson(subscription) }, requestId)
    return
  }

  throw new ServiceError('not_found', 'Route not found', 404)
}

async function authenticateEve(
  request: IncomingMessage,
  verifier: AccessTokenVerifier
): Promise<Principal> {
  return authenticateEveAuthorization(request.headers.authorization, verifier, 'EVE bearer token required')
}

async function authorizeWorkspaceActor(
  request: IncomingMessage,
  actor: Principal,
  options: Pick<ApiServerOptions, 'auth' | 'entitlements'>
): Promise<void> {
  try {
    options.entitlements.assertFeature(actor.characterId, WORKSPACE_ACTOR_FEATURE)
    return
  } catch (error) {
    if (!isEntitlementDenial(error)) throw error

    const ownerAuthorization = request.headers[OWNER_AUTHORIZATION_HEADER]
    // The extra credential is an optional fallback. Without it, preserve the actor's precise
    // subscription/feature error instead of turning every unlicensed request into a 401.
    if (ownerAuthorization === undefined) throw error

    const owner = await authenticateEveAuthorization(
      ownerAuthorization,
      options.auth,
      'Owner EVE bearer token required'
    )
    if (owner.characterId === actor.characterId) throw error
    for (const feature of WORKSPACE_OWNER_FEATURES) {
      options.entitlements.assertFeature(owner.characterId, feature)
    }
  }
}

async function authenticateEveAuthorization(
  authorization: string | readonly string[] | undefined,
  verifier: AccessTokenVerifier,
  missingMessage: string
): Promise<Principal> {
  const match = typeof authorization === 'string'
    ? /^Bearer ([^\s]+)$/u.exec(authorization)
    : null
  if (!match) throw new ServiceError('unauthorized', missingMessage, 401)
  return verifier.verify(match[1]!)
}

function isEntitlementDenial(error: unknown): error is ServiceError {
  return error instanceof ServiceError && ENTITLEMENT_DENIAL_CODES.has(error.code)
}

function authenticateAdmin(request: IncomingMessage, expected: string): void {
  const authorization = request.headers.authorization
  const match = authorization ? /^Bearer ([^\s]+)$/u.exec(authorization) : null
  if (!match || !constantTimeEqual(match[1]!, expected)) {
    throw new ServiceError('unauthorized', 'Admin bearer token required', 401)
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new ServiceError('unsupported_media_type', 'Content-Type must be application/json', 415)
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.byteLength
    if (length > MAX_BODY_BYTES) throw new ServiceError('body_too_large', 'Request body is too large', 413)
    chunks.push(buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ServiceError('invalid_json', 'Request body is not valid JSON')
  }
  if (!isRecord(value)) throw new ServiceError('invalid_body', 'Request body must be an object')
  return value
}

function planJson(plan: Plan): Record<string, unknown> {
  return {
    id: plan.id,
    name: plan.name,
    priceIsk: formatIsk(plan.priceMinor),
    durationSeconds: plan.durationSeconds,
    features: plan.features,
    enabled: plan.enabled
  }
}

function invoiceJson(invoice: Invoice): Record<string, unknown> {
  return {
    id: invoice.id,
    kind: invoice.kind,
    planId: invoice.planId,
    status: invoice.status,
    receiverCharacterId: invoice.receiverCharacterId,
    amountIsk: formatIsk(invoice.amountMinor),
    reason: invoice.paymentCode,
    createdAt: invoice.createdAt,
    expiresAt: invoice.expiresAt,
    paidAt: invoice.paidAt,
    paymentJournalId: invoice.paymentJournalId
  }
}

function subscriptionJson(subscription: Subscription): Record<string, unknown> {
  return {
    id: subscription.id,
    planId: subscription.planId,
    status: subscription.status,
    autoRenew: subscription.autoRenew,
    paidThrough: subscription.paidThrough,
    updatedAt: subscription.updatedAt
  }
}

function deviceJson(device: Device): Record<string, unknown> {
  return {
    id: device.id,
    deviceCode: device.deviceCode,
    label: device.label,
    status: device.status,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt
  }
}

function entitlementJson(entitlement: IssuedEntitlement): Record<string, unknown> {
  return {
    token: entitlement.token,
    entitlement: {
      id: entitlement.id,
      revision: entitlement.revision,
      issuedAt: entitlement.issuedAt,
      expiresAt: entitlement.expiresAt,
      paidThrough: entitlement.claims.paidThrough,
      planId: entitlement.claims.planId,
      features: entitlement.claims.features
    }
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  requestId: string
): void {
  if (response.headersSent) {
    response.end()
    return
  }
  setSecurityHeaders(response, requestId)
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', body.byteLength)
  response.end(body)
}

function setSecurityHeaders(response: ServerResponse, requestId: string): void {
  response.setHeader('X-Request-Id', requestId)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'DENY')
}

function normalizeError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error
  return new ServiceError('internal_error', 'Internal server error', 500)
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new ServiceError('invalid_body', `${field} must be a non-empty string`)
  }
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new ServiceError('invalid_body', `${field} must be a string`)
  return value
}

function requiredInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ServiceError('invalid_body', `${field} must be a non-negative integer`)
  }
  return value
}

function requiredArray(body: Record<string, unknown>, field: string): readonly unknown[] {
  const value = body[field]
  if (!Array.isArray(value)) throw new ServiceError('invalid_body', `${field} must be an array`)
  return value
}

function queryInteger(url: URL, field: string, fallback: number): number {
  const raw = url.searchParams.get(field)
  if (raw === null) return fallback
  if (!/^\d+$/u.test(raw)) throw new ServiceError('invalid_query', `${field} must be an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new ServiceError('invalid_query', `${field} is too large`)
  return value
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ServiceError('invalid_path', 'Invalid path encoding')
  }
}

function matchZkillRelayRequest(
  url: URL
): { source: ZkillRelaySource; path: string } | null {
  const routes: ReadonlyArray<{ prefix: string; source: ZkillRelaySource }> = [
    { prefix: '/v1/relay/zkill', source: 'zkill' },
    { prefix: '/v1/relay/r2z2', source: 'r2z2' }
  ]
  for (const route of routes) {
    if (
      url.pathname === route.prefix ||
      url.pathname.startsWith(`${route.prefix}/`)
    ) {
      const suffix = url.pathname.slice(route.prefix.length) || '/'
      // Preserve the query in the strict service path so it is rejected by the allowlist.
      return { source: route.source, path: `${suffix}${url.search}` }
    }
  }
  return null
}

function constantTimeEqual(value: string, expected: string): boolean {
  const left = Buffer.from(value)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
