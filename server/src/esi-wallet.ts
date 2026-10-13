import { isLosslessNumber, parse, stringify } from 'lossless-json'
import type { CashierAccessTokenProvider } from './auth.js'
import type { BillingService } from './billing-service.js'
import type { PaymentProcessingResult, WalletJournalEntry } from './domain.js'
import { parseIskSource } from './money.js'
import type { BillingStore, WalletPollState } from './store.js'

const RETRYABLE_STATUS = new Set([420, 429, 500, 502, 503, 504])

export interface EsiWalletCache {
  etag: string | null
  lastModified: string | null
}

export interface EsiWalletFetchResult {
  notModified: boolean
  entries: WalletJournalEntry[]
  etag: string | null
  lastModified: string | null
  nextPollAt: number
  pages: number
}

export interface EsiWalletJournalClientOptions {
  userAgent: string
  compatibilityDate?: string
  baseUrl?: string
  fetch?: typeof fetch
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  random?: () => number
  maxAttempts?: number
}

export class EsiWalletJournalClient {
  private readonly userAgent: string
  private readonly compatibilityDate: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly random: () => number
  private readonly maxAttempts: number

  constructor(options: EsiWalletJournalClientOptions) {
    if (!options.userAgent.trim() || options.userAgent.length > 256) throw new Error('Invalid ESI user agent')
    this.userAgent = options.userAgent.trim()
    this.compatibilityDate = options.compatibilityDate ?? '2020-01-01'
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(this.compatibilityDate)) {
      throw new Error('Invalid ESI compatibility date')
    }
    this.baseUrl = (options.baseUrl ?? 'https://esi.evetech.net').replace(/\/$/u, '')
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.random = options.random ?? Math.random
    this.maxAttempts = options.maxAttempts ?? 4
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 10) {
      throw new Error('maxAttempts must be between 1 and 10')
    }
  }

  async fetchJournal(
    characterId: string,
    accessToken: string,
    cache: EsiWalletCache
  ): Promise<EsiWalletFetchResult> {
    const first = await this.fetchPage(characterId, accessToken, 1, cache)
    if (first.response.status === 304) {
      return {
        notModified: true,
        entries: [],
        etag: first.response.headers.get('etag') ?? cache.etag,
        lastModified: first.response.headers.get('last-modified') ?? cache.lastModified,
        nextPollAt: calculateNextPollAt(first.response.headers, this.now()),
        pages: 0
      }
    }
    assertSuccess(first.response)
    const pages = parsePageCount(first.response.headers.get('x-pages'))
    const entries = parseWalletJournal(await first.response.text())
    let nextPollAt = calculateNextPollAt(first.response.headers, this.now())

    for (let page = 2; page <= pages; page += 1) {
      const result = await this.fetchPage(characterId, accessToken, page, {
        etag: null,
        lastModified: null
      })
      assertSuccess(result.response)
      entries.push(...parseWalletJournal(await result.response.text()))
      nextPollAt = Math.max(nextPollAt, errorLimitDelay(result.response.headers, this.now()))
    }
    nextPollAt = Math.max(nextPollAt, errorLimitDelay(first.response.headers, this.now()))

    return {
      notModified: false,
      entries,
      etag: first.response.headers.get('etag'),
      lastModified: first.response.headers.get('last-modified'),
      nextPollAt,
      pages
    }
  }

  private async fetchPage(
    characterId: string,
    accessToken: string,
    page: number,
    cache: EsiWalletCache
  ): Promise<{ response: Response }> {
    const url = new URL(`/characters/${encodeURIComponent(characterId)}/wallet/journal`, this.baseUrl)
    url.searchParams.set('page', String(page))
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': this.userAgent,
      'X-Compatibility-Date': this.compatibilityDate
    }
    if (cache.etag) headers['If-None-Match'] = cache.etag
    if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified

    let lastError: unknown
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        const response = await fetchWithTimeout(this.fetchImpl, url, {
          method: 'GET',
          headers,
          redirect: 'error'
        })
        if (!RETRYABLE_STATUS.has(response.status) || attempt === this.maxAttempts - 1) {
          return { response }
        }
        await drain(response)
        await this.sleep(retryDelayMilliseconds(response.headers, attempt, this.now(), this.random()))
      } catch (error) {
        lastError = error
        if (attempt === this.maxAttempts - 1) throw error
        await this.sleep(exponentialDelayMilliseconds(attempt, this.random()))
      }
    }
    throw lastError ?? new Error('ESI wallet request failed')
  }
}

export interface WalletPollServiceOptions {
  store: BillingStore
  billing: BillingService
  client: EsiWalletJournalClient
  tokenProvider: CashierAccessTokenProvider
  cashierCharacterId: string
  now?: () => number
}

export interface WalletPollSummary {
  skipped: boolean
  notModified: boolean
  fetched: number
  matched: number
  ignored: number
  duplicates: number
  pages: number
  nextPollAt: number
}

export class WalletPollService {
  private readonly store: BillingStore
  private readonly billing: BillingService
  private readonly client: EsiWalletJournalClient
  private readonly tokenProvider: CashierAccessTokenProvider
  private readonly cashierCharacterId: string
  private readonly now: () => number

  constructor(options: WalletPollServiceOptions) {
    this.store = options.store
    this.billing = options.billing
    this.client = options.client
    this.tokenProvider = options.tokenProvider
    this.cashierCharacterId = options.cashierCharacterId
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  }

  async poll(force = false): Promise<WalletPollSummary> {
    const now = this.now()
    const state = this.store.getWalletPollState(this.cashierCharacterId)
    if (!force && state && state.nextPollAt > now) {
      return emptySummary(true, state.nextPollAt)
    }

    try {
      const token = await this.tokenProvider.getAccessToken()
      const result = await this.client.fetchJournal(this.cashierCharacterId, token, {
        etag: state?.etag ?? null,
        lastModified: state?.lastModified ?? null
      })
      const processing = result.entries
        .sort((left, right) => Date.parse(left.date) - Date.parse(right.date))
        .map((entry) => this.billing.processWalletEntry(entry))
      this.store.saveWalletPollState({
        cashierCharacterId: this.cashierCharacterId,
        etag: result.etag,
        lastModified: result.lastModified,
        nextPollAt: Math.max(now + 30, Math.floor(result.nextPollAt / 1_000)),
        consecutiveFailures: 0,
        updatedAt: now
      })
      return summarize(result, processing)
    } catch (error) {
      const failures = (state?.consecutiveFailures ?? 0) + 1
      const retryAt = now + Math.min(3_600, 15 * 2 ** Math.min(failures - 1, 8))
      this.store.saveWalletPollState({
        cashierCharacterId: this.cashierCharacterId,
        etag: state?.etag ?? null,
        lastModified: state?.lastModified ?? null,
        nextPollAt: retryAt,
        consecutiveFailures: failures,
        updatedAt: now
      })
      throw error
    }
  }
}

export function parseWalletJournal(text: string): WalletJournalEntry[] {
  let value: unknown
  try {
    value = parse(text)
  } catch {
    throw new Error('ESI wallet journal returned invalid JSON')
  }
  if (!Array.isArray(value)) throw new Error('ESI wallet journal must be an array')
  return value.map((item) => parseWalletEntry(item))
}

function parseWalletEntry(value: unknown): WalletJournalEntry {
  if (!isRecord(value)) throw new Error('Invalid ESI wallet journal entry')
  return {
    journalId: integerIdentifier(value.id, 'id'),
    date: requiredString(value.date, 'date'),
    refType: requiredString(value.ref_type, 'ref_type'),
    description: requiredString(value.description, 'description'),
    reason: optionalString(value.reason, 'reason'),
    amountMinor: value.amount === undefined ? null : parseIskSource(value.amount),
    firstPartyId: optionalIdentifier(value.first_party_id, 'first_party_id'),
    secondPartyId: optionalIdentifier(value.second_party_id, 'second_party_id'),
    rawJson: stringify(value) ?? '{}'
  }
}

function calculateNextPollAt(headers: Headers, nowMilliseconds: number): number {
  const cacheControl = headers.get('cache-control')
  const maxAge = cacheControl ? /(?:^|,)\s*max-age=(\d+)/iu.exec(cacheControl)?.[1] : undefined
  if (maxAge) {
    const seconds = Number(maxAge)
    if (Number.isSafeInteger(seconds)) return nowMilliseconds + clamp(seconds, 30, 7_200) * 1_000
  }
  const expires = headers.get('expires')
  if (expires) {
    const timestamp = Date.parse(expires)
    if (Number.isFinite(timestamp)) return Math.max(nowMilliseconds + 30_000, timestamp)
  }
  return nowMilliseconds + 3_600_000
}

function errorLimitDelay(headers: Headers, nowMilliseconds: number): number {
  const remain = Number(headers.get('x-esi-error-limit-remain'))
  const reset = Number(headers.get('x-esi-error-limit-reset'))
  if (Number.isFinite(remain) && remain <= 5 && Number.isFinite(reset) && reset > 0) {
    return nowMilliseconds + reset * 1_000
  }
  return nowMilliseconds
}

function retryDelayMilliseconds(
  headers: Headers,
  attempt: number,
  nowMilliseconds: number,
  random: number
): number {
  const retryAfter = headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1_000)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return clamp(date - nowMilliseconds, 0, 60_000)
  }
  return exponentialDelayMilliseconds(attempt, random)
}

function exponentialDelayMilliseconds(attempt: number, random: number): number {
  return Math.min(30_000, 250 * 2 ** attempt + Math.floor(clamp(random, 0, 1) * 100))
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: URL,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  timer.unref()
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer()
  } catch {
    // Retry does not depend on an error body.
  }
}

function assertSuccess(response: Response): void {
  if (!response.ok) throw new Error(`ESI wallet journal failed (${response.status})`)
}

function parsePageCount(value: string | null): number {
  if (value === null) return 1
  const pages = Number(value)
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > 1_000) {
    throw new Error('Invalid ESI X-Pages header')
  }
  return pages
}

function integerIdentifier(value: unknown, field: string): string {
  if (typeof value === 'string' && /^[1-9]\d*$/u.test(value)) return value
  if (isLosslessNumber(value)) {
    const source = value.toString()
    if (/^[1-9]\d*$/u.test(source)) return source
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  throw new Error(`Invalid ESI ${field}`)
}

function optionalIdentifier(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : integerIdentifier(value, field)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ESI ${field}`)
  return value
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`Invalid ESI ${field}`)
  return value
}

function summarize(
  result: EsiWalletFetchResult,
  processing: PaymentProcessingResult[]
): WalletPollSummary {
  return {
    skipped: false,
    notModified: result.notModified,
    fetched: result.entries.length,
    matched: processing.filter((item) => !item.duplicate && item.status === 'matched').length,
    ignored: processing.filter((item) => !item.duplicate && item.status === 'ignored').length,
    duplicates: processing.filter((item) => item.duplicate).length,
    pages: result.pages,
    nextPollAt: Math.floor(result.nextPollAt / 1_000)
  }
}

function emptySummary(skipped: boolean, nextPollAt: number): WalletPollSummary {
  return {
    skipped,
    notModified: false,
    fetched: 0,
    matched: 0,
    ignored: 0,
    duplicates: 0,
    pages: 0,
    nextPollAt
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
