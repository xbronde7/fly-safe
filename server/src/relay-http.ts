import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AccessTokenVerifier } from './auth.js'
import { ServiceError } from './domain.js'
import {
  ZkillRelayError,
  type ZkillRelayService,
  type ZkillRelaySource
} from './zkill-relay.js'

const RELAY_ROUTES: ReadonlyArray<{ prefix: string; source: ZkillRelaySource }> = [
  { prefix: '/v1/relay/zkill', source: 'zkill' },
  { prefix: '/v1/relay/r2z2', source: 'r2z2' }
]
const HEADERS_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_MAX_ACTIVE_REQUESTS = 32

export interface RelayHttpServerOptions {
  auth: AccessTokenVerifier
  relay: Pick<ZkillRelayService, 'relay'>
  maxActiveRequests?: number | undefined
  logger?: Pick<Console, 'warn' | 'error'> | undefined
}

interface NormalizedHttpError {
  code: string
  message: string
  httpStatus: number
}

/**
 * Public HTTP surface for the standalone relay. It deliberately has no
 * billing, entitlement, workspace, or administrative dependencies.
 */
export function createRelayHttpServer(options: RelayHttpServerOptions): Server {
  const logger = options.logger ?? console
  const maxActiveRequests = options.maxActiveRequests ?? DEFAULT_MAX_ACTIVE_REQUESTS
  if (!Number.isSafeInteger(maxActiveRequests) || maxActiveRequests < 1) {
    throw new RangeError('maxActiveRequests must be a positive safe integer')
  }
  let activeRequests = 0
  const server = createServer({
    headersTimeout: HEADERS_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    keepAliveTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
    requireHostHeader: true
  }, (request, response) => {
    const requestId = randomUUID()
    setSecurityHeaders(response, requestId)
    if (declaresRequestBody(request)) forceConnectionClose(response)
    const admissionRequired = request.url !== '/healthz'
    if (admissionRequired && activeRequests >= maxActiveRequests) {
      forceConnectionClose(response)
      response.setHeader('Retry-After', '1')
      logger.warn({ requestId, code: 'relay_busy' })
      sendJson(response, 503, {
        error: {
          code: 'relay_busy',
          message: 'Relay is busy; retry later'
        },
        requestId
      }, requestId)
      return
    }
    if (admissionRequired) activeRequests += 1

    void routeRequest(request, response, options, requestId).catch((error: unknown) => {
      const normalized = normalizeError(error)
      if (normalized.httpStatus === 401) {
        response.setHeader('WWW-Authenticate', 'Bearer realm="fly-safe-relay"')
      }
      if (normalized.httpStatus === 405) response.setHeader('Allow', 'GET')

      if (normalized.httpStatus >= 500) logger.error({ requestId, error })
      else logger.warn({ requestId, code: normalized.code })
      sendJson(response, normalized.httpStatus, {
        error: {
          code: normalized.code,
          message: normalized.message
        },
        requestId
      }, requestId)
    }).finally(() => {
      if (admissionRequired) activeRequests -= 1
    })
  })

  const rejectExpectation = (_request: IncomingMessage, response: ServerResponse): void => {
    const requestId = randomUUID()
    setSecurityHeaders(response, requestId)
    forceConnectionClose(response)
    logger.warn({ requestId, code: 'expectation_failed' })
    sendJson(response, 417, {
      error: {
        code: 'expectation_failed',
        message: 'Expect header is not supported'
      },
      requestId
    }, requestId)
  }
  // Never let Node emit an automatic 100 Continue for a bodyless API.
  server.on('checkContinue', rejectExpectation)
  server.on('checkExpectation', rejectExpectation)
  server.maxHeadersCount = 64
  server.maxRequestsPerSocket = 100
  server.maxConnections = 256
  return server
}

/** Stop accepting connections and wait for active relay requests to finish. */
export async function closeRelayHttpServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeIdleConnections()
  })
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RelayHttpServerOptions,
  requestId: string
): Promise<void> {
  const method = request.method ?? ''
  const target = request.url ?? '/'

  if (target === '/healthz') {
    if (method !== 'GET') throw methodNotAllowed()
    assertBodylessRequest(request)
    sendJson(response, 200, { status: 'ok' }, requestId)
    return
  }

  const relayRequest = matchRelayRequest(target)
  if (relayRequest === null) throw new ServiceError('not_found', 'Route not found', 404)

  response.setHeader('Vary', 'Authorization')
  if (method !== 'GET') throw methodNotAllowed()
  assertBodylessRequest(request)
  await authenticateEve(request, options.auth)

  try {
    const relayed = await options.relay.relay({
      method,
      source: relayRequest.source,
      path: relayRequest.path
    })
    response.setHeader('X-Fly-Safe-Relay-Cache', relayed.cacheStatus)
    if (relayed.retryAfter !== null) response.setHeader('Retry-After', relayed.retryAfter)
    sendJson(response, relayed.status, relayed.body, requestId)
  } catch (error) {
    if (error instanceof ZkillRelayError) {
      throw new ServiceError(error.code, error.message, error.httpStatus)
    }
    throw error
  }
}

async function authenticateEve(
  request: IncomingMessage,
  verifier: AccessTokenVerifier
): Promise<void> {
  const authorization = request.headers.authorization
  const match = typeof authorization === 'string'
    ? /^Bearer ([^\s]+)$/u.exec(authorization)
    : null
  if (!match) throw new ServiceError('unauthorized', 'EVE bearer token required', 401)
  await verifier.verify(match[1]!)
}

function matchRelayRequest(
  target: string
): { source: ZkillRelaySource; path: string } | null {
  // Match the raw request target so encoded or dot-segment aliases cannot be
  // normalized into an allowed route before ZkillRelayService sees them.
  if (!target.startsWith('/') || target.startsWith('//')) return null
  for (const route of RELAY_ROUTES) {
    if (target === route.prefix || target.startsWith(`${route.prefix}/`)) {
      return {
        source: route.source,
        path: target.slice(route.prefix.length) || '/'
      }
    }
  }
  return null
}

function methodNotAllowed(): ServiceError {
  return new ServiceError('method_not_allowed', 'Relay only supports GET', 405)
}

function assertBodylessRequest(request: IncomingMessage): void {
  if (declaresRequestBody(request)) {
    throw new ServiceError(
      'request_body_not_allowed',
      'Relay requests must not contain a body',
      400
    )
  }
}

function declaresRequestBody(request: IncomingMessage): boolean {
  return request.headers['transfer-encoding'] !== undefined ||
    (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
}

function forceConnectionClose(response: ServerResponse): void {
  response.shouldKeepAlive = false
  response.setHeader('Connection', 'close')
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
  response.setHeader('Cache-Control', 'private, no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

function normalizeError(error: unknown): NormalizedHttpError {
  if (error instanceof ServiceError) {
    return {
      code: error.code,
      message: error.message,
      httpStatus: error.httpStatus
    }
  }
  return {
    code: 'internal_error',
    message: 'Internal server error',
    httpStatus: 500
  }
}
