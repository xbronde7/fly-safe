import type { EveAuthorizedSession } from './account-service'
import type {
  EntitlementSummary,
  SubscriptionAccessStatus,
  SubscriptionInvoice,
  SubscriptionPlan,
  SubscriptionSummary
} from '../shared/subscription'

const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60_000
const MAX_RESPONSE_BYTES = 1024 * 1024

export interface EntitlementServiceOptions {
  baseUrl: string
  deviceCode: string
  accountService: EntitlementAccountAdapter
  fetch: typeof fetch
  activateEntitlement: (token: string) => Promise<void>
  refreshIntervalMs?: number
  now?: () => number
  deviceLabel?: string
}

export interface EntitlementAccountAdapter {
  getAuthorizedSession(): Promise<EveAuthorizedSession | null>
}

export class EntitlementService {
  private readonly baseUrl: string | null
  private readonly deviceCode: string
  private readonly accountService: EntitlementAccountAdapter
  private readonly fetch: typeof fetch
  private readonly activateEntitlement: (token: string) => Promise<void>
  private readonly refreshIntervalMs: number
  private readonly now: () => number
  private readonly deviceLabel: string | null
  private timer: ReturnType<typeof setInterval> | null = null
  private operation: Promise<SubscriptionAccessStatus> | null = null
  private entitlementEtag: string | null = null
  private current: SubscriptionAccessStatus

  constructor(options: EntitlementServiceOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.deviceCode = options.deviceCode
    this.accountService = options.accountService
    this.fetch = options.fetch
    this.activateEntitlement = options.activateEntitlement
    this.refreshIntervalMs = normalizeRefreshInterval(options.refreshIntervalMs)
    this.now = options.now ?? Date.now
    this.deviceLabel = normalizeDeviceLabel(options.deviceLabel)
    this.current = emptyStatus(this.baseUrl !== null, this.deviceCode)
  }

  start(): void {
    if (this.timer || !this.baseUrl) return
    void this.sync()
    this.timer = setInterval(() => void this.sync(), this.refreshIntervalMs)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status(): SubscriptionAccessStatus {
    return cloneStatus(this.current)
  }

  async listPlans(): Promise<SubscriptionPlan[]> {
    this.requireConfigured()
    const response = await this.request('/v1/plans')
    const plans = isRecord(response) && Array.isArray(response.plans) ? response.plans : response
    if (!Array.isArray(plans)) throw new Error('Backend вернул некорректный список тарифов')
    return plans.map(parsePlan)
  }

  async createInvoice(planId: string): Promise<SubscriptionInvoice> {
    if (!validId(planId)) throw new TypeError('Некорректный тариф подписки')
    const response = await this.authorizedRequest('/v1/invoices', {
      method: 'POST',
      body: JSON.stringify({ planId })
    })
    const invoice = parseInvoice(unwrap(response, 'invoice'))
    this.current = {
      ...this.current,
      state: invoice.status === 'pending' ? 'pending_payment' : this.current.state,
      invoice,
      message: invoice.status === 'pending'
        ? 'Переведите точную сумму указанному персонажу. Проверка ESI может занять до часа.'
        : this.current.message
    }
    return { ...invoice }
  }

  async getInvoice(invoiceId: string): Promise<SubscriptionInvoice> {
    if (!validId(invoiceId)) throw new TypeError('Некорректный invoice')
    const response = await this.authorizedRequest(`/v1/invoices/${encodeURIComponent(invoiceId)}`)
    const invoice = parseInvoice(unwrap(response, 'invoice'))
    this.current = { ...this.current, invoice }
    if (invoice.status === 'paid') await this.sync()
    return { ...invoice }
  }

  sync(): Promise<SubscriptionAccessStatus> {
    if (this.operation) return this.operation
    this.operation = this.performSync().finally(() => {
      this.operation = null
    })
    return this.operation
  }

  private async performSync(): Promise<SubscriptionAccessStatus> {
    if (!this.baseUrl) {
      this.current = emptyStatus(false, this.deviceCode)
      return this.status()
    }

    const authorized = await this.accountService.getAuthorizedSession()
    if (!authorized) {
      this.current = {
        ...emptyStatus(true, this.deviceCode),
        state: 'disconnected',
        message: 'Войдите через EVE Online, чтобы проверить подписку.'
      }
      return this.status()
    }

    const checkedAt = Math.floor(this.now() / 1_000)
    const characterId = String(authorized.session.characterId)
    if (this.current.characterId !== null && this.current.characterId !== characterId) {
      this.entitlementEtag = null
      this.current = emptyStatus(true, this.deviceCode)
    }
    this.current = {
      ...this.current,
      state: 'checking',
      characterId,
      characterName: authorized.session.characterName,
      lastCheckedAt: checkedAt,
      nextCheckAt: checkedAt + Math.floor(this.refreshIntervalMs / 1_000),
      message: null
    }

    try {
      await this.request('/v1/devices', {
        method: 'POST',
        token: authorized.accessToken,
        body: JSON.stringify({
          deviceCode: this.deviceCode,
          ...(this.deviceLabel ? { label: this.deviceLabel } : {})
        })
      })

      const [accountResponse, entitlementResponse] = await Promise.all([
        this.request('/v1/account', { token: authorized.accessToken }),
        this.requestDetailed(
          `/v1/entitlements/current?deviceCode=${encodeURIComponent(this.deviceCode)}`,
          {
            token: authorized.accessToken,
            allowNoEntitlement: true,
            ifNoneMatch: this.entitlementEtag
          }
        )
      ])
      const account = unwrap(accountResponse, 'account')
      const subscription = parseOptionalSubscription(
        isRecord(account) ? account.subscription : null
      )

      if (entitlementResponse.status === 304) {
        if (!this.current.entitlement) {
          this.entitlementEtag = null
          throw new Error('Backend вернул 304 без сохранённого entitlement')
        }
        const entitlement = this.current.entitlement
        const nowSeconds = Math.floor(this.now() / 1_000)
        this.current = {
          ...this.current,
          state: entitlement.paidThrough <= nowSeconds ? 'grace' : 'active',
          subscription,
          message: entitlement.paidThrough <= nowSeconds
            ? 'Работает льготный период. Продлите подписку.'
            : null
        }
        return this.status()
      }

      if (entitlementResponse.body === null) {
        this.entitlementEtag = null
        this.current = {
          ...this.current,
          state: subscription ? 'pending_payment' : 'payment_required',
          subscription,
          entitlement: null,
          message: subscription
            ? 'Оплата ещё не подтверждена или срок подписки закончился.'
            : 'Выберите тариф и создайте счёт на оплату в ISK.'
        }
        return this.status()
      }

      const token = requiredString(entitlementResponse.body, 'token')
      const entitlement = parseEntitlement(unwrap(entitlementResponse.body, 'entitlement'))
      await this.activateEntitlement(token)
      this.entitlementEtag = entitlementResponse.etag
      const nowSeconds = Math.floor(this.now() / 1_000)
      this.current = {
        ...this.current,
        state: entitlement.paidThrough <= nowSeconds ? 'grace' : 'active',
        subscription,
        entitlement,
        message: entitlement.paidThrough <= nowSeconds
          ? 'Работает льготный период. Продлите подписку.'
          : null
      }
      return this.status()
    } catch (error) {
      this.current = {
        ...this.current,
        state: this.current.entitlement ? 'offline' : 'error',
        message: publicError(error)
      }
      return this.status()
    }
  }

  private async authorizedRequest(path: string, init: RequestOptions = {}): Promise<unknown> {
    const authorized = await this.accountService.getAuthorizedSession()
    if (!authorized) throw new Error('Требуется вход через EVE Online')
    return this.request(path, { ...init, token: authorized.accessToken })
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    return (await this.requestDetailed(path, options)).body
  }

  private async requestDetailed(path: string, options: RequestOptions = {}): Promise<HttpResult> {
    const baseUrl = this.requireConfigured()
    const response = await this.fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.ifNoneMatch ? { 'if-none-match': options.ifNoneMatch } : {})
      },
      body: options.body,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    })
    if (response.status === 304 && options.ifNoneMatch) {
      return { body: null, etag: options.ifNoneMatch, status: 304 }
    }
    if (options.allowNoEntitlement && (response.status === 402 || response.status === 404)) {
      return { body: null, etag: null, status: response.status }
    }
    const text = await readLimitedText(response)
    const body = text ? parseJson(text) : null
    if (!response.ok) {
      const errorBody = isRecord(body) && isRecord(body.error) ? body.error : body
      const message = isRecord(errorBody) && typeof errorBody.message === 'string'
        ? errorBody.message
        : `Backend подписки ответил ${response.status}`
      throw new Error(message.slice(0, 500))
    }
    return { body, etag: response.headers.get('etag'), status: response.status }
  }

  private requireConfigured(): string {
    if (!this.baseUrl) throw new Error('URL backend подписки не встроен в эту сборку')
    return this.baseUrl
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  token?: string
  body?: string
  allowNoEntitlement?: boolean
  ifNoneMatch?: string | null
}

interface HttpResult {
  body: unknown
  etag: string | null
  status: number
}

function normalizeBaseUrl(value: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
    return url.toString().replace(/\/$/u, '')
  } catch {
    return null
  }
}

function normalizeRefreshInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REFRESH_INTERVAL_MS
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 24 * 60 * 60_000) {
    throw new TypeError('Некорректный интервал entitlement')
  }
  return value
}

function normalizeDeviceLabel(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().slice(0, 80)
  return normalized || null
}

function emptyStatus(configured: boolean, deviceCode: string): SubscriptionAccessStatus {
  return {
    state: configured ? 'disconnected' : 'unavailable',
    backendConfigured: configured,
    characterId: null,
    characterName: null,
    deviceCode,
    subscription: null,
    entitlement: null,
    invoice: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    message: configured ? null : 'Backend подписки не настроен в этой сборке.'
  }
}

function parsePlan(value: unknown): SubscriptionPlan {
  if (!isRecord(value)) throw new Error('Некорректный тариф')
  return {
    id: requiredId(value, 'id'),
    name: requiredString(value, 'name'),
    amountIsk: moneyString(value.priceIsk ?? value.amountIsk),
    durationSeconds: positiveInteger(value.durationSeconds, 'durationSeconds'),
    features: stringArray(value.features, 'features')
  }
}

function parseInvoice(value: unknown): SubscriptionInvoice {
  if (!isRecord(value)) throw new Error('Некорректный invoice')
  const status = requiredString(value, 'status')
  if (!['pending', 'paid', 'expired', 'cancelled'].includes(status)) {
    throw new Error('Некорректный статус invoice')
  }
  return {
    id: requiredId(value, 'id'),
    planId: value.planId === null ? null : requiredId(value, 'planId'),
    status: status as SubscriptionInvoice['status'],
    receiverCharacterId: numericId(value.receiverCharacterId, 'receiverCharacterId'),
    receiverCharacterName: optionalString(value.receiverCharacterName),
    amountIsk: moneyString(value.amountIsk),
    paymentCode: typeof value.paymentCode === 'string'
      ? requiredString(value, 'paymentCode')
      : requiredString(value, 'reason'),
    createdAt: unixTime(value.createdAt, 'createdAt'),
    expiresAt: unixTime(value.expiresAt, 'expiresAt'),
    paidAt: value.paidAt === null || value.paidAt === undefined
      ? null
      : unixTime(value.paidAt, 'paidAt')
  }
}

function parseOptionalSubscription(value: unknown): SubscriptionSummary | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new Error('Некорректная подписка')
  const state = requiredString(value, 'status')
  if (!['active', 'past_due', 'cancelled'].includes(state)) {
    throw new Error('Некорректный статус подписки')
  }
  return {
    id: requiredId(value, 'id'),
    planId: requiredId(value, 'planId'),
    status: state as SubscriptionSummary['status'],
    autoRenew: value.autoRenew === true,
    paidThrough: unixTime(value.paidThrough, 'paidThrough')
  }
}

function parseEntitlement(value: unknown): EntitlementSummary {
  if (!isRecord(value)) throw new Error('Некорректный entitlement')
  return {
    id: requiredId(value, 'id'),
    revision: positiveInteger(value.revision, 'revision'),
    issuedAt: unixTime(value.issuedAt, 'issuedAt'),
    expiresAt: unixTime(value.expiresAt, 'expiresAt'),
    paidThrough: unixTime(value.paidThrough, 'paidThrough'),
    planId: requiredId(value, 'planId'),
    features: stringArray(value.features, 'features')
  }
}

function unwrap(value: unknown, key: string): unknown {
  return isRecord(value) && key in value ? value[key] : value
}

function requiredString(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== 'string' || !value[field].trim()) {
    throw new Error(`Некорректное поле ${field}`)
  }
  return value[field].trim()
}

function requiredId(value: Record<string, unknown>, field: string): string {
  const result = requiredString(value, field)
  if (!validId(result)) throw new Error(`Некорректное поле ${field}`)
  return result
}

function numericId(value: unknown, field: string): string {
  const normalized = typeof value === 'number' ? String(value) : value
  if (typeof normalized !== 'string' || !/^\d{6,20}$/u.test(normalized)) {
    throw new Error(`Некорректное поле ${field}`)
  }
  return normalized
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Некорректное поле ${field}`)
  }
  return value as number
}

function unixTime(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Некорректное поле ${field}`)
  }
  return value as number
}

function moneyString(value: unknown): string {
  const normalized = typeof value === 'number' ? String(value) : value
  if (typeof normalized !== 'string' || !/^\d+(?:\.\d{1,2})?$/u.test(normalized)) {
    throw new Error('Некорректная сумма ISK')
  }
  return normalized
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Некорректное поле ${field}`)
  }
  return [...value]
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value)
}

async function readLimitedText(response: Response): Promise<string> {
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('Ответ backend подписки слишком большой')
  }
  return text
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('Backend подписки вернул некорректный JSON')
  }
}

function publicError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 500)
    : 'Не удалось обновить entitlement'
}

function cloneStatus(value: SubscriptionAccessStatus): SubscriptionAccessStatus {
  return {
    ...value,
    subscription: value.subscription ? { ...value.subscription } : null,
    entitlement: value.entitlement
      ? { ...value.entitlement, features: [...value.entitlement.features] }
      : null,
    invoice: value.invoice ? { ...value.invoice } : null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
