const DEFAULT_ZKILL_BASE_URL = 'https://zkillboard.com'
const DEFAULT_R2Z2_BASE_URL = 'https://r2z2.zkillboard.com'
const DEFAULT_USER_AGENT = 'Fly-Safe-Relay/0.1 (EVE Online desktop companion backend)'
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1_024 * 1_024
const DEFAULT_REQUEST_INTERVAL_MS = 250
const DEFAULT_CACHE_MAX_ENTRIES = 512
const DEFAULT_CACHE_MAX_BYTES = 32 * 1_024 * 1_024
const MAX_TIMER_DELAY_MS = 2_147_483_647

export type ZkillRelaySource = 'zkill' | 'r2z2'

export type ZkillRelayRouteKind =
  | 'zkill-stats'
  | 'zkill-kills'
  | 'zkill-losses'
  | 'zkill-system-24h'
  | 'r2z2-sequence'
  | 'r2z2-record'

export interface ZkillRelayRequest {
  method: string
  source: ZkillRelaySource
  /**
   * Path after the HTTP API relay prefix. Query strings and fragments are not
   * accepted. zKill paths start with /api; R2Z2 paths start at sequence.json.
   */
  path: string
}

export interface ZkillRelayResponse {
  source: ZkillRelaySource
  routeKind: ZkillRelayRouteKind
  status: number
  body: unknown
  contentType: 'application/json; charset=utf-8'
  retryAfter: string | null
  cacheStatus: 'hit' | 'miss' | 'shared'
}

export interface ZkillRelayClock {
  now(): number
  sleep(milliseconds: number): Promise<void>
}

export type ZkillRelayCacheTtls = Partial<Record<ZkillRelayRouteKind, number>>

export interface ZkillRelayServiceOptions {
  /** Fixed at construction; callers can never select an upstream URL. */
  zkillBaseUrl?: string
  /** Fixed origin/base before the service-owned /ephemeral R2Z2 path. */
  r2z2BaseUrl?: string
  userAgent?: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  requestIntervalMs?: number
  cacheMaxEntries?: number
  cacheMaxBytes?: number
  cacheTtlMs?: number | ZkillRelayCacheTtls
  clock?: Partial<ZkillRelayClock>
}

export type ZkillRelayErrorCode =
  | 'method_not_allowed'
  | 'path_not_allowed'
  | 'upstream_timeout'
  | 'upstream_network_error'
  | 'upstream_response_too_large'
  | 'upstream_invalid_json'

export class ZkillRelayError extends Error {
  readonly code: ZkillRelayErrorCode
  readonly httpStatus: number

  constructor(
    code: ZkillRelayErrorCode,
    message: string,
    httpStatus: number,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ZkillRelayError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export interface ZkillRelayRoute {
  source: ZkillRelaySource
  kind: ZkillRelayRouteKind
  path: string
  upstreamPath: string
}

interface StoredRelayResponse {
  route: ZkillRelayRoute
  status: number
  bodyText: string
  bodyBytes: number
  retryAfter: string | null
}

interface CacheEntry {
  response: StoredRelayResponse
  expiresAt: number
}

const DEFAULT_CACHE_TTLS: Readonly<Record<ZkillRelayRouteKind, number>> = {
  'zkill-stats': 5 * 60_000,
  'zkill-kills': 60_000,
  'zkill-losses': 60_000,
  'zkill-system-24h': 60_000,
  'r2z2-sequence': 750,
  'r2z2-record': 60 * 60_000
}

/**
 * Bounded, read-only relay for the exact zKillboard and R2Z2 resources used by
 * Fly Safe. One instance owns one global request-start gate for both upstreams.
 */
export class ZkillRelayService {
  private readonly zkillBaseUrl: string
  private readonly r2z2BaseUrl: string
  private readonly userAgent: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly requestIntervalMs: number
  private readonly cacheMaxEntries: number
  private readonly cacheMaxBytes: number
  private readonly cacheTtls: Readonly<Record<ZkillRelayRouteKind, number>>
  private readonly clock: ZkillRelayClock
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<StoredRelayResponse>>()
  private cacheBytes = 0
  private requestStartQueue: Promise<void> = Promise.resolve()
  private lastRequestStartedAt: number | null = null

  constructor(options: ZkillRelayServiceOptions = {}) {
    this.zkillBaseUrl = normalizeFixedBaseUrl(
      options.zkillBaseUrl ?? DEFAULT_ZKILL_BASE_URL,
      'zKill'
    )
    this.r2z2BaseUrl = normalizeFixedBaseUrl(
      options.r2z2BaseUrl ?? DEFAULT_R2Z2_BASE_URL,
      'R2Z2'
    )
    this.userAgent = validateUserAgent(options.userAgent ?? DEFAULT_USER_AGENT)
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = positiveIntegerOption(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs')
    if (this.timeoutMs > MAX_TIMER_DELAY_MS) throw new RangeError('timeoutMs is too large')
    this.maxResponseBytes = positiveIntegerOption(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes'
    )
    this.requestIntervalMs = nonNegativeFiniteOption(
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS,
      'requestIntervalMs'
    )
    this.cacheMaxEntries = positiveIntegerOption(
      options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
      'cacheMaxEntries'
    )
    this.cacheMaxBytes = positiveIntegerOption(
      options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES,
      'cacheMaxBytes'
    )
    this.cacheTtls = cacheTtls(options.cacheTtlMs)
    this.clock = {
      now: options.clock?.now ?? Date.now,
      sleep: options.clock?.sleep ?? delay
    }
  }

  async relay(request: ZkillRelayRequest): Promise<ZkillRelayResponse> {
    if (request.method !== 'GET') {
      throw new ZkillRelayError('method_not_allowed', 'Relay only supports GET', 405)
    }

    const route = resolveZkillRelayRoute(request.source, request.path)
    if (route === null) {
      throw new ZkillRelayError('path_not_allowed', 'Relay path is not allowed', 404)
    }

    const key = `${route.source}:${route.path}`
    const cached = this.readCache(key)
    if (cached !== null) return materialize(cached, 'hit')

    const shared = this.inFlight.get(key)
    if (shared) return materialize(await shared, 'shared')

    const pending = this.startPacedRequest(route)
    this.inFlight.set(key, pending)
    void pending.then(
      (result) => {
        this.inFlight.delete(key)
        if (result.status >= 200 && result.status < 300) this.writeCache(key, result)
      },
      () => {
        this.inFlight.delete(key)
      }
    )
    return materialize(await pending, 'miss')
  }

  clearCache(): void {
    this.cache.clear()
    this.cacheBytes = 0
  }

  private async startPacedRequest(route: ZkillRelayRoute): Promise<StoredRelayResponse> {
    const previousTurn = this.requestStartQueue
    let releaseTurn!: () => void
    this.requestStartQueue = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })

    await previousTurn
    try {
      if (this.lastRequestStartedAt !== null && this.requestIntervalMs > 0) {
        const elapsed = Math.max(0, this.clock.now() - this.lastRequestStartedAt)
        const remaining = this.requestIntervalMs - elapsed
        if (remaining > 0) await this.clock.sleep(remaining)
      }
      this.lastRequestStartedAt = this.clock.now()
      return this.requestUpstream(route)
    } finally {
      releaseTurn()
    }
  }

  private async requestUpstream(route: ZkillRelayRoute): Promise<StoredRelayResponse> {
    const baseUrl = route.source === 'zkill' ? this.zkillBaseUrl : this.r2z2BaseUrl
    const targetUrl = `${baseUrl}${route.upstreamPath}`
    const controller = new AbortController()
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new RelayTimeoutSignal())
      }, this.timeoutMs)
    })

    const operation = async (): Promise<StoredRelayResponse> => {
      const response = await this.fetchImpl(targetUrl, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'User-Agent': this.userAgent
        }
      })
      const bodyText = await readBoundedUtf8(response, this.maxResponseBytes)
      const normalizedBody = normalizeJsonBody(bodyText, response.status, response.ok, route)
      return {
        route,
        status: response.status,
        bodyText: normalizedBody,
        bodyBytes: Buffer.byteLength(normalizedBody),
        retryAfter: safeRetryAfter(response.headers.get('retry-after'))
      }
    }

    try {
      return await Promise.race([operation(), timeoutPromise])
    } catch (error) {
      if (timedOut || error instanceof RelayTimeoutSignal) {
        throw new ZkillRelayError(
          'upstream_timeout',
          `${route.source} request timed out`,
          504,
          { cause: error }
        )
      }
      if (error instanceof ZkillRelayError) throw error
      throw new ZkillRelayError(
        'upstream_network_error',
        `${route.source} network request failed`,
        502,
        { cause: error }
      )
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  private readCache(key: string): StoredRelayResponse | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.clock.now()) {
      this.deleteCacheEntry(key, entry)
      return null
    }

    // Refresh insertion order to maintain bounded LRU eviction.
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.response
  }

  private writeCache(key: string, response: StoredRelayResponse): void {
    const ttl = this.cacheTtls[response.route.kind]
    if (ttl === 0 || response.bodyBytes > this.cacheMaxBytes) return

    const existing = this.cache.get(key)
    if (existing) this.deleteCacheEntry(key, existing)
    this.pruneExpiredCache()

    while (
      this.cache.size >= this.cacheMaxEntries ||
      this.cacheBytes + response.bodyBytes > this.cacheMaxBytes
    ) {
      const oldest = this.cache.entries().next().value as [string, CacheEntry] | undefined
      if (!oldest) break
      this.deleteCacheEntry(oldest[0], oldest[1])
    }

    if (this.cacheBytes + response.bodyBytes > this.cacheMaxBytes) return
    this.cache.set(key, {
      response,
      expiresAt: this.clock.now() + ttl
    })
    this.cacheBytes += response.bodyBytes
  }

  private pruneExpiredCache(): void {
    const now = this.clock.now()
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.deleteCacheEntry(key, entry)
    }
  }

  private deleteCacheEntry(key: string, entry: CacheEntry): void {
    if (!this.cache.delete(key)) return
    this.cacheBytes = Math.max(0, this.cacheBytes - entry.response.bodyBytes)
  }
}

/** Resolve only canonical Fly Safe paths; never accepts a URL, query, or fragment. */
export function resolveZkillRelayRoute(
  source: ZkillRelaySource,
  path: string
): ZkillRelayRoute | null {
  if (source === 'zkill') {
    const stats = /^\/api\/stats\/characterID\/([1-9]\d*)\/kills\/$/u.exec(path)
    if (stats && canonicalPositiveInteger(stats[1]!)) {
      return { source, kind: 'zkill-stats', path, upstreamPath: path }
    }

    const history = /^\/api\/(kills|losses)\/characterID\/([1-9]\d*)\/page\/([1-9]\d*)\/$/u.exec(path)
    if (
      history &&
      canonicalPositiveInteger(history[2]!) &&
      canonicalPositiveInteger(history[3]!)
    ) {
      return {
        source,
        kind: history[1] === 'kills' ? 'zkill-kills' : 'zkill-losses',
        path,
        upstreamPath: path
      }
    }

    const system = /^\/api\/systemID\/([1-9]\d*)\/pastSeconds\/86400\/page\/1\/$/u.exec(path)
    if (system && canonicalPositiveInteger(system[1]!)) {
      return { source, kind: 'zkill-system-24h', path, upstreamPath: path }
    }
    return null
  }

  if (source === 'r2z2') {
    if (path === '/sequence.json') {
      return {
        source,
        kind: 'r2z2-sequence',
        path,
        upstreamPath: '/ephemeral/sequence.json'
      }
    }
    const record = /^\/([1-9]\d*)\.json$/u.exec(path)
    if (record && canonicalPositiveInteger(record[1]!)) {
      return {
        source,
        kind: 'r2z2-record',
        path,
        upstreamPath: `/ephemeral/${record[1]!}.json`
      }
    }
  }
  return null
}

function materialize(
  stored: StoredRelayResponse,
  cacheStatus: ZkillRelayResponse['cacheStatus']
): ZkillRelayResponse {
  return {
    source: stored.route.source,
    routeKind: stored.route.kind,
    status: stored.status,
    body: JSON.parse(stored.bodyText) as unknown,
    contentType: 'application/json; charset=utf-8',
    retryAfter: stored.retryAfter,
    cacheStatus
  }
}

async function readBoundedUtf8(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && /^\d+$/u.test(contentLength)) {
    const advertisedBytes = Number(contentLength)
    if (Number.isSafeInteger(advertisedBytes) && advertisedBytes > maximumBytes) {
      throw responseTooLarge(maximumBytes)
    }
  }

  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value) continue
      total += chunk.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw responseTooLarge(maximumBytes)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new ZkillRelayError(
      'upstream_invalid_json',
      'Upstream returned invalid UTF-8 JSON',
      502,
      { cause: error }
    )
  }
}

function normalizeJsonBody(
  bodyText: string,
  status: number,
  ok: boolean,
  route: ZkillRelayRoute
): string {
  if (bodyText.trim() === '') {
    if (!ok) return upstreamErrorBody(status)
    throw invalidJson(route, 'empty response body')
  }

  let body: unknown
  try {
    body = JSON.parse(bodyText) as unknown
  } catch (error) {
    if (!ok) return upstreamErrorBody(status)
    throw invalidJson(route, 'invalid JSON', error)
  }

  if (ok && !expectedTopLevel(route.kind, body)) {
    throw invalidJson(route, 'unexpected JSON shape')
  }
  return bodyText
}

function expectedTopLevel(kind: ZkillRelayRouteKind, body: unknown): boolean {
  if (kind === 'zkill-kills' || kind === 'zkill-losses' || kind === 'zkill-system-24h') {
    return Array.isArray(body)
  }
  return typeof body === 'object' && body !== null && !Array.isArray(body)
}

function invalidJson(route: ZkillRelayRoute, detail: string, cause?: unknown): ZkillRelayError {
  return new ZkillRelayError(
    'upstream_invalid_json',
    `${route.source} returned ${detail}`,
    502,
    cause === undefined ? undefined : { cause }
  )
}

function upstreamErrorBody(status: number): string {
  return JSON.stringify({
    error: {
      code: 'upstream_http_error',
      status
    }
  })
}

function responseTooLarge(maximumBytes: number): ZkillRelayError {
  return new ZkillRelayError(
    'upstream_response_too_large',
    `Upstream response exceeded ${maximumBytes} bytes`,
    502
  )
}

function safeRetryAfter(value: string | null): string | null {
  if (value === null || value.length === 0 || value.length > 128) return null
  return /^[\t\x20-\x7e]+$/u.test(value) ? value : null
}

function canonicalPositiveInteger(value: string): boolean {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 && String(number) === value
}

function normalizeFixedBaseUrl(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${name} base URL must be absolute`)
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new TypeError(`${name} base URL must use HTTP(S) without credentials`)
  }
  if (url.search || url.hash) throw new TypeError(`${name} base URL cannot contain query or fragment`)
  return url.toString().replace(/\/+$/u, '')
}

function validateUserAgent(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 8 || normalized.length > 256 || /[\r\n]/u.test(normalized)) {
    throw new TypeError('Relay User-Agent must be descriptive and contain 8-256 characters')
  }
  return normalized
}

function cacheTtls(
  configured: number | ZkillRelayCacheTtls | undefined
): Readonly<Record<ZkillRelayRouteKind, number>> {
  if (typeof configured === 'number') {
    const ttl = ttlOption(configured, 'cacheTtlMs')
    return {
      'zkill-stats': ttl,
      'zkill-kills': ttl,
      'zkill-losses': ttl,
      'zkill-system-24h': ttl,
      'r2z2-sequence': ttl,
      'r2z2-record': ttl
    }
  }

  const result = { ...DEFAULT_CACHE_TTLS }
  if (configured) {
    for (const kind of Object.keys(DEFAULT_CACHE_TTLS) as ZkillRelayRouteKind[]) {
      const value = configured[kind]
      if (value !== undefined) result[kind] = ttlOption(value, `cacheTtlMs.${kind}`)
    }
  }
  return result
}

function ttlOption(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function positiveIntegerOption(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeFiniteOption(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`${name} must be a non-negative finite number`)
  }
  return value
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

class RelayTimeoutSignal extends Error {}
