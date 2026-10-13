import type { PilotStats } from '../shared/types'
import { normalizeZkillStats } from '../shared/threat-score'
import { CACHE_SCOPES, CACHE_TTL, type Cache } from './cache'

const DEFAULT_ZKILL_BASE_URL = 'https://zkillboard.com'
const DEFAULT_USER_AGENT = 'Fly-Safe/0.11.0 (desktop application)'
const MAX_CONCURRENCY = 3
const MAX_TIMER_DELAY_MS = 2_147_483_647

export const ZKILL_REQUEST_START_INTERVAL_MS = 250
export const ZKILL_HISTORY_PAGE_SIZE = 200

type FetchLike = typeof fetch

export interface ZkillClock {
  now(): number
  sleep(milliseconds: number): Promise<void>
}

export interface ZkillStatsResult {
  characterId: number
  stats: PilotStats | null
  cached: boolean
  error: string | null
}

export type ZkillHistoryKind = 'kills' | 'losses'

export interface ZkillHistoryResult {
  characterId: number
  kind: ZkillHistoryKind
  page: number
  killmails: unknown[]
  cached: boolean
}

export interface ZkillSystemHistoryResult {
  solarSystemId: number
  killmails: unknown[]
  cached: boolean
}

export interface ZkillClientOptions {
  baseUrl?: string
  userAgent?: string
  fetch?: FetchLike
  timeoutMs?: number
  maxAttempts?: number
  requestIntervalMs?: number
  clock?: Partial<ZkillClock>
}

export class ZkillError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ZkillError'
    this.status = status
  }
}

/** Rate-friendly zKill client with paced request starts and three stats workers. */
export class ZkillClient {
  private readonly cache: Cache
  private readonly baseUrl: string
  private readonly userAgent: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly requestIntervalMs: number
  private readonly clock: ZkillClock
  private requestStartQueue: Promise<void> = Promise.resolve()
  private lastRequestStartedAt: number | null = null
  private serverNotBefore = 0

  constructor(cache: Cache, options: ZkillClientOptions = {}) {
    const requestIntervalMs = options.requestIntervalMs ?? ZKILL_REQUEST_START_INTERVAL_MS
    if (!Number.isFinite(requestIntervalMs) || requestIntervalMs < 0) {
      throw new RangeError('zKill request interval must be a non-negative finite number')
    }

    this.cache = cache
    this.baseUrl = (options.baseUrl ?? DEFAULT_ZKILL_BASE_URL).replace(/\/$/, '')
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 12_000
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
    this.requestIntervalMs = requestIntervalMs
    this.clock = {
      now: options.clock?.now ?? (() => Date.now()),
      sleep: options.clock?.sleep ?? delay
    }
  }

  async getCharacterStats(
    characterId: number,
    forceRefresh = false
  ): Promise<ZkillStatsResult> {
    const key = String(characterId)
    const hit = forceRefresh
      ? null
      : this.cache.get<PilotStats>(CACHE_SCOPES.zkillStats, key)

    if (hit) {
      return { characterId, stats: hit.value, cached: true, error: null }
    }

    await this.waitForServerCooldown()

    try {
      const raw = await this.requestJson(
        `/api/stats/characterID/${encodeURIComponent(characterId)}/kills/`
      )
      const stats = normalizeZkillStats(raw)
      this.cache.set(CACHE_SCOPES.zkillStats, key, stats, CACHE_TTL.zkillStats)
      return { characterId, stats, cached: false, error: null }
    } catch (error) {
      return {
        characterId,
        stats: null,
        cached: false,
        error: errorMessage(error)
      }
    }
  }

  async getStatsForCharacters(
    characterIds: readonly number[],
    forceRefresh = false,
    onSettled?: (result: ZkillStatsResult) => void
  ): Promise<ZkillStatsResult[]> {
    const uniqueIds = [
      ...new Set(characterIds.filter((id) => Number.isSafeInteger(id) && id > 0))
    ]

    return mapConcurrent(uniqueIds, MAX_CONCURRENCY, async (characterId) => {
      const result = await this.getCharacterStats(characterId, forceRefresh)
      try {
        onSettled?.(result)
      } catch {
        // UI progress handlers must not abort a scan.
      }
      return result
    })
  }

  async getStats(
    characterIds: readonly number[],
    forceRefresh = false,
    onSettled?: (result: ZkillStatsResult) => void
  ): Promise<ZkillStatsResult[]> {
    return this.getStatsForCharacters(characterIds, forceRefresh, onSettled)
  }

  async getCharacterHistory(
    characterId: number,
    kind: ZkillHistoryKind,
    forceRefresh = false,
    page = 1
  ): Promise<ZkillHistoryResult> {
    if (!Number.isSafeInteger(characterId) || characterId <= 0) {
      throw new TypeError('Invalid EVE character ID')
    }
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new RangeError('Invalid zKill history page')
    }

    const key = `${kind}:${characterId}:page:${page}`
    const hit = forceRefresh
      ? null
      : this.cache.get<unknown[]>(CACHE_SCOPES.zkillHistory, key)

    if (hit) {
      return { characterId, kind, page, killmails: hit.value, cached: true }
    }

    await this.waitForServerCooldown()

    const raw = await this.requestJson(
      `/api/${kind}/characterID/${encodeURIComponent(characterId)}/page/${page}/`
    )
    if (!Array.isArray(raw)) {
      throw new ZkillError('zKill history returned an unexpected response')
    }

    this.cache.set(
      CACHE_SCOPES.zkillHistory,
      key,
      raw,
      CACHE_TTL.zkillHistory
    )
    return { characterId, kind, page, killmails: raw, cached: false }
  }

  /** Public killmail observations from the last 24 hours; never a live roster. */
  async getSystemHistory(
    solarSystemId: number,
    forceRefresh = false
  ): Promise<ZkillSystemHistoryResult> {
    if (!Number.isSafeInteger(solarSystemId) || solarSystemId <= 0) {
      throw new TypeError('Invalid EVE solar system ID')
    }

    const key = String(solarSystemId)
    const hit = forceRefresh
      ? null
      : this.cache.get<unknown[]>(CACHE_SCOPES.zkillSystemHistory, key)
    if (hit) return { solarSystemId, killmails: hit.value, cached: true }

    await this.waitForServerCooldown()

    const raw = await this.requestJson(
      `/api/systemID/${encodeURIComponent(solarSystemId)}/pastSeconds/86400/page/1/`
    )
    if (!Array.isArray(raw)) {
      throw new ZkillError('zKill system history returned an unexpected response')
    }

    this.cache.set(
      CACHE_SCOPES.zkillSystemHistory,
      key,
      raw,
      CACHE_TTL.zkillSystemHistory
    )
    return { solarSystemId, killmails: raw, cached: false }
  }

  private async requestJson(path: string): Promise<unknown> {
    let lastError: unknown

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let timeout: ReturnType<typeof setTimeout> | null = null

      try {
        const controller = new AbortController()
        const response = await this.startRequest(() => {
          timeout = setTimeout(() => controller.abort(), this.timeoutMs)
          return this.fetchImpl(`${this.baseUrl}${path}`, {
            method: 'GET',
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
              'Accept-Encoding': 'gzip',
              'User-Agent': this.userAgent
            }
          })
        })

        if (!response.ok) {
          const retryAfterMs = parseRetryAfterMilliseconds(
            response.headers.get('retry-after'),
            this.clock.now()
          )
          if (retryAfterMs !== null) {
            this.extendServerCooldown(retryAfterMs)
          }
          const detail = (await response.text()).slice(0, 300)
          const error = new ZkillError(
            `zKill ${response.status}: ${detail || response.statusText}`,
            response.status
          )
          if (!isRetryableStatus(response.status) || attempt === this.maxAttempts) {
            throw error
          }
          lastError = error
          if (retryAfterMs === 0) {
            // Preserve the existing retry yield even when the server permits an
            // immediate retry. The request-start gate still applies pacing.
            await this.clock.sleep(0)
          } else if (retryAfterMs !== null) {
            await this.waitForServerCooldown()
          } else {
            await this.sleepFor(retryDelay(attempt))
          }
          continue
        }

        try {
          return (await response.json()) as unknown
        } catch (error) {
          throw new ZkillError('zKill returned invalid JSON', response.status, {
            cause: error
          })
        }
      } catch (error) {
        lastError = error
        const status = error instanceof ZkillError ? error.status : null
        const retryable = status === null || (status !== null && isRetryableStatus(status))
        if (!retryable || attempt === this.maxAttempts) break
        await this.sleepFor(retryDelay(attempt))
      } finally {
        if (timeout !== null) clearTimeout(timeout)
      }
    }

    const message = errorMessage(lastError)
    throw new ZkillError(`zKill request failed: ${message}`, null, {
      cause: lastError
    })
  }

  /**
   * Invoke fetch while holding a short scheduler turn, then release the turn
   * without waiting for the response. A manually resolved queue keeps later
   * calls moving even when pacing or fetch startup throws.
   */
  private async startRequest(request: () => Promise<Response>): Promise<Response> {
    const previousTurn = this.requestStartQueue
    let releaseTurn!: () => void
    this.requestStartQueue = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })

    await previousTurn

    let startedRequest!: Promise<Response>
    try {
      await this.waitForRequestStartWindow()

      this.lastRequestStartedAt = this.clock.now()
      startedRequest = request()
    } finally {
      releaseTurn()
    }

    return startedRequest
  }

  private extendServerCooldown(delayMs: number): void {
    this.serverNotBefore = Math.max(
      this.serverNotBefore,
      safeTimestampAfter(this.clock.now(), delayMs)
    )
  }

  private async waitForServerCooldown(): Promise<void> {
    while (true) {
      const waitMs = this.serverNotBefore - this.clock.now()
      if (waitMs <= 0) return
      await this.clock.sleep(Math.min(waitMs, MAX_TIMER_DELAY_MS))
    }
  }

  private async waitForRequestStartWindow(): Promise<void> {
    while (true) {
      const now = this.clock.now()
      const pacedNotBefore = this.lastRequestStartedAt === null
        ? now
        : safeTimestampAfter(this.lastRequestStartedAt, this.requestIntervalMs)
      const waitMs = Math.max(this.serverNotBefore, pacedNotBefore) - now
      if (waitMs <= 0) return
      await this.clock.sleep(Math.min(waitMs, MAX_TIMER_DELAY_MS))
    }
  }

  private async sleepFor(milliseconds: number): Promise<void> {
    let remaining = milliseconds
    while (remaining > 0) {
      const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS)
      await this.clock.sleep(chunk)
      remaining -= chunk
    }
  }
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  let nextIndex = 0

  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    }
  )

  await Promise.all(runners)
  return results
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function retryDelay(attempt: number): number {
  // Deterministic exponential backoff keeps tests stable and caps UI stalls.
  return Math.min(8_000, 500 * 2 ** (attempt - 1))
}

function parseRetryAfterMilliseconds(value: string | null, now: number): number | null {
  if (value === null) return null

  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    if (!Number.isSafeInteger(seconds)) return null
    return Math.min(Number.MAX_SAFE_INTEGER, seconds * 1_000)
  }

  const timestamp = Date.parse(trimmed)
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, timestamp - now)
}

function safeTimestampAfter(timestamp: number, delayMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, timestamp + delayMs)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return error === undefined ? 'unknown error' : String(error)
}
