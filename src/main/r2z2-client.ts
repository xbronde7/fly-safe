const DEFAULT_R2Z2_BASE_URL = 'https://r2z2.zkillboard.com/ephemeral'
const DEFAULT_USER_AGENT = 'Fly-Safe/0.11.0 (desktop application)'

export const R2Z2_RATE_POLICY = {
  maxRequestsPerSecond: 15,
  recommendedSuccessIntervalMs: 100,
  minimumNotFoundPollMs: 6_000
} as const

type FetchLike = typeof fetch

export interface R2z2Clock {
  now(): number
  sleep(milliseconds: number): Promise<void>
}

export interface R2z2RateLimitMetadata {
  documentedLimitPerSecond: 15
  responseLimit: number | null
  responseRemaining: number | null
  responseResetAt: string | null
}

export interface R2z2RequestMetadata {
  status: number
  requestedAt: string
  completedAt: string
  retryAfterMs: number | null
  rateLimit: R2z2RateLimitMetadata
}

export interface R2z2SequenceDiscovery {
  sequenceId: number
  request: R2z2RequestMetadata
}

export interface R2z2RecordResult {
  kind: 'record'
  sequenceId: number
  record: unknown
  request: R2z2RequestMetadata
}

export interface R2z2NotFoundResult {
  kind: 'not-found'
  sequenceId: number
  recommendedPollAfterMs: number
  request: R2z2RequestMetadata
}

export type R2z2SequenceResult = R2z2RecordResult | R2z2NotFoundResult

export interface R2z2BatchResult {
  fromSequenceId: number
  nextSequenceId: number
  records: Array<{ sequenceId: number; record: unknown }>
  requests: R2z2RequestMetadata[]
  stopReason: 'batch-limit' | 'not-found'
  recommendedPollAfterMs: number
}

export interface R2z2ClientOptions {
  baseUrl?: string
  userAgent?: string
  fetch?: FetchLike
  timeoutMs?: number
  clock?: Partial<R2z2Clock>
}

export class R2z2Error extends Error {
  readonly status: number | null
  readonly sequenceId: number | null
  readonly recommendedRetryAfterMs: number
  readonly request: R2z2RequestMetadata | null

  constructor(
    message: string,
    options: {
      status?: number | null
      sequenceId?: number | null
      recommendedRetryAfterMs?: number
      request?: R2z2RequestMetadata | null
      cause?: unknown
    } = {}
  ) {
    super(message, { cause: options.cause })
    this.name = 'R2z2Error'
    this.status = options.status ?? null
    this.sequenceId = options.sequenceId ?? null
    this.recommendedRetryAfterMs = Math.max(0, options.recommendedRetryAfterMs ?? 0)
    this.request = options.request ?? null
  }
}

/** Read-only, sequential R2Z2 client. It never uploads killmails. */
export class R2z2Client {
  private readonly baseUrl: string
  private readonly userAgent: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly clock: R2z2Clock

  constructor(options: R2z2ClientOptions = {}) {
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    if (userAgent.trim() === '') {
      throw new TypeError('R2Z2 requires a nonblank User-Agent')
    }

    this.baseUrl = (options.baseUrl ?? DEFAULT_R2Z2_BASE_URL).replace(/\/+$/, '')
    this.userAgent = userAgent
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 12_000)
    this.clock = {
      now: options.clock?.now ?? (() => Date.now()),
      sleep: options.clock?.sleep ?? delay
    }
  }

  async discoverSequence(): Promise<R2z2SequenceDiscovery> {
    const response = await this.request('/sequence.json')
    if (!response.response.ok) {
      throw this.httpError('R2Z2 sequence discovery failed', response, null)
    }

    const raw = await readJson(response.response, response.metadata)
    const record = asRecord(raw)
    const sequenceId = record ? positiveInteger(record.sequence) : null
    if (sequenceId === null) {
      throw new R2z2Error('R2Z2 sequence discovery returned invalid JSON', {
        status: response.metadata.status,
        request: response.metadata
      })
    }

    return { sequenceId, request: response.metadata }
  }

  async getSequence(sequenceId: number): Promise<R2z2SequenceResult> {
    validateSequenceId(sequenceId)
    const response = await this.request(`/${sequenceId}.json`)

    if (response.response.status === 404) {
      const recommendedPollAfterMs = Math.max(
        R2Z2_RATE_POLICY.minimumNotFoundPollMs,
        response.metadata.retryAfterMs ?? 0
      )
      return {
        kind: 'not-found',
        sequenceId,
        recommendedPollAfterMs,
        request: response.metadata
      }
    }

    if (!response.response.ok) {
      throw this.httpError(`R2Z2 sequence ${sequenceId} failed`, response, sequenceId)
    }

    return {
      kind: 'record',
      sequenceId,
      record: await readJson(response.response, response.metadata),
      request: response.metadata
    }
  }

  /**
   * Fetch consecutive sequence files one at a time. A 404 ends the batch and
   * returns a retry recommendation; this method never sleeps for that 404.
   */
  async getBatch(fromSequenceId: number, maximumRecords = 25): Promise<R2z2BatchResult> {
    validateSequenceId(fromSequenceId)
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 250) {
      throw new RangeError('R2Z2 maximumRecords must be an integer from 1 to 250')
    }

    const records: R2z2BatchResult['records'] = []
    const requests: R2z2RequestMetadata[] = []
    let nextSequenceId = fromSequenceId

    while (records.length < maximumRecords) {
      if (records.length > 0) {
        await this.clock.sleep(R2Z2_RATE_POLICY.recommendedSuccessIntervalMs)
      }

      const result = await this.getSequence(nextSequenceId)
      requests.push(result.request)
      if (result.kind === 'not-found') {
        return {
          fromSequenceId,
          nextSequenceId,
          records,
          requests,
          stopReason: 'not-found',
          recommendedPollAfterMs: result.recommendedPollAfterMs
        }
      }

      records.push({ sequenceId: nextSequenceId, record: result.record })
      nextSequenceId += 1
    }

    return {
      fromSequenceId,
      nextSequenceId,
      records,
      requests,
      stopReason: 'batch-limit',
      recommendedPollAfterMs: R2Z2_RATE_POLICY.recommendedSuccessIntervalMs
    }
  }

  private async request(path: string): Promise<{
    response: Response
    metadata: R2z2RequestMetadata
  }> {
    const requestedAtMs = this.clock.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'User-Agent': this.userAgent
        }
      })
      const completedAtMs = this.clock.now()
      return {
        response,
        metadata: requestMetadata(response, requestedAtMs, completedAtMs)
      }
    } catch (error) {
      const retryAfterMs = R2Z2_RATE_POLICY.minimumNotFoundPollMs
      throw new R2z2Error(
        error instanceof Error && error.name === 'AbortError'
          ? 'R2Z2 request timed out'
          : 'R2Z2 network request failed',
        { recommendedRetryAfterMs: retryAfterMs, cause: error }
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  private httpError(
    prefix: string,
    result: { response: Response; metadata: R2z2RequestMetadata },
    sequenceId: number | null
  ): R2z2Error {
    const retryAfterMs = Math.max(
      result.metadata.retryAfterMs ?? 0,
      result.response.status === 403
        ? 60 * 60 * 1_000
        : isRetryableStatus(result.response.status)
          ? R2Z2_RATE_POLICY.minimumNotFoundPollMs
          : 0
    )
    return new R2z2Error(`${prefix}: HTTP ${result.response.status}`, {
      status: result.response.status,
      sequenceId,
      recommendedRetryAfterMs: retryAfterMs,
      request: result.metadata
    })
  }
}

function requestMetadata(
  response: Response,
  requestedAtMs: number,
  completedAtMs: number
): R2z2RequestMetadata {
  return {
    status: response.status,
    requestedAt: new Date(requestedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), completedAtMs),
    rateLimit: {
      documentedLimitPerSecond: 15,
      responseLimit: headerNumber(response.headers, 'ratelimit-limit', 'x-ratelimit-limit'),
      responseRemaining: headerNumber(
        response.headers,
        'ratelimit-remaining',
        'x-ratelimit-remaining'
      ),
      responseResetAt: parseResetAt(
        response.headers.get('ratelimit-reset') ?? response.headers.get('x-ratelimit-reset')
      )
    }
  }
}

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null
}

function parseResetAt(value: string | null): string | null {
  if (!value) return null
  const numeric = Number(value)
  const timestamp = Number.isFinite(numeric)
    ? (numeric >= 100_000_000_000 ? numeric : numeric * 1_000)
    : Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function headerNumber(headers: Headers, ...names: string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name)
    if (raw === null || raw.trim() === '') continue
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) return value
  }
  return null
}

async function readJson(response: Response, request: R2z2RequestMetadata): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch (error) {
    throw new R2z2Error('R2Z2 returned invalid JSON', {
      status: response.status,
      request,
      cause: error
    })
  }
}

function validateSequenceId(sequenceId: number): void {
  if (!Number.isSafeInteger(sequenceId) || sequenceId < 1) {
    throw new TypeError('Invalid R2Z2 sequence ID')
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
