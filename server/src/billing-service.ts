import { randomBytes, randomUUID } from 'node:crypto'
import {
  ServiceError,
  assertCharacterId,
  assertDeviceCode,
  type Device,
  type Invoice,
  type PaymentProcessingResult,
  type Principal,
  type Subscription,
  type WalletJournalEntry
} from './domain.js'
import type { EntitlementService } from './entitlement.js'
import { parseIsk } from './money.js'
import {
  DeviceLimitError,
  type BillingStore,
  type NewInvoice
} from './store.js'

const PAYMENT_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const PAYMENT_CODE_PATTERN = /(?:^|[^A-Z0-9])(FS-[A-Z0-9]{8})(?=$|[^A-Z0-9])/giu

export interface BillingServiceOptions {
  store: BillingStore
  entitlementService: EntitlementService
  cashierCharacterId: string
  invoiceTtlSeconds?: number
  renewalLeadSeconds?: number
  maxDevicesPerCharacter?: number
  minimumCreditPurchase?: bigint
  maximumCreditPurchase?: bigint
  now?: () => number
  paymentCodeGenerator?: () => string
}

export class BillingService {
  readonly store: BillingStore
  private readonly entitlements: EntitlementService
  private readonly cashierCharacterId: string
  private readonly invoiceTtlSeconds: number
  private readonly renewalLeadSeconds: number
  private readonly maxDevicesPerCharacter: number
  private readonly minimumCreditPurchase: bigint
  private readonly maximumCreditPurchase: bigint
  private readonly now: () => number
  private readonly paymentCodeGenerator: () => string

  constructor(options: BillingServiceOptions) {
    this.store = options.store
    this.entitlements = options.entitlementService
    this.cashierCharacterId = assertCharacterId(options.cashierCharacterId)
    this.invoiceTtlSeconds = positiveInteger(options.invoiceTtlSeconds ?? 86_400, 'invoiceTtlSeconds')
    this.renewalLeadSeconds = nonNegativeInteger(
      options.renewalLeadSeconds ?? 86_400,
      'renewalLeadSeconds'
    )
    this.maxDevicesPerCharacter = positiveInteger(
      options.maxDevicesPerCharacter ?? 3,
      'maxDevicesPerCharacter'
    )
    this.minimumCreditPurchase = options.minimumCreditPurchase ?? parseIsk('10000000')
    this.maximumCreditPurchase = options.maximumCreditPurchase ?? parseIsk('10000000000')
    if (this.minimumCreditPurchase <= 0n || this.maximumCreditPurchase < this.minimumCreditPurchase) {
      throw new Error('Invalid credit purchase limits')
    }
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    this.paymentCodeGenerator = options.paymentCodeGenerator ?? createPaymentCode
  }

  createSubscriptionInvoice(principal: Principal, planId: string): Invoice {
    const plan = this.store.getPlan(planId)
    if (!plan || !plan.enabled) throw new ServiceError('plan_not_found', 'Plan is unavailable', 404)
    return this.createInvoice({
      principal,
      kind: 'subscription',
      planId: plan.id,
      amountMinor: plan.priceMinor,
      durationSeconds: plan.durationSeconds
    })
  }

  createCreditInvoice(principal: Principal, decimalAmount: string): Invoice {
    let amountMinor: bigint
    try {
      amountMinor = parseIsk(decimalAmount)
    } catch {
      throw new ServiceError('invalid_amount', 'amountIsk must be a decimal string with two digits max')
    }
    if (amountMinor < this.minimumCreditPurchase || amountMinor > this.maximumCreditPurchase) {
      throw new ServiceError('amount_out_of_range', 'Credit amount is outside allowed range', 400)
    }
    return this.createInvoice({
      principal,
      kind: 'credit',
      planId: null,
      amountMinor,
      durationSeconds: null
    })
  }

  getInvoice(principal: Principal, invoiceId: string): Invoice {
    let invoice = this.store.getInvoice(invoiceId)
    if (!invoice || invoice.characterId !== principal.characterId) {
      throw new ServiceError('invoice_not_found', 'Invoice not found', 404)
    }
    if (invoice.status === 'pending' && invoice.expiresAt <= this.now()) {
      this.store.markInvoiceExpired(invoice.id)
      invoice = { ...invoice, status: 'expired' }
    }
    return invoice
  }

  registerDevice(principal: Principal, rawDeviceCode: string, rawLabel?: string | null): Device {
    const deviceCode = assertDeviceCode(rawDeviceCode)
    const label = normalizeDeviceLabel(rawLabel)
    try {
      return this.store.registerDevice({
        characterId: principal.characterId,
        deviceCode,
        label,
        now: this.now(),
        maxActive: this.maxDevicesPerCharacter
      })
    } catch (error) {
      if (error instanceof DeviceLimitError) {
        throw new ServiceError('device_limit_reached', error.message, 409, { limit: error.limit })
      }
      throw error
    }
  }

  revokeDevice(principal: Principal, deviceId: string): void {
    const revoked = this.store.revokeDevice(deviceId, principal.characterId, this.now())
    if (!revoked) throw new ServiceError('device_not_found', 'Active device not found', 404)
    this.entitlements.revokeForDevice(principal.characterId, deviceId)
  }

  setAutoRenew(principal: Principal, autoRenew: boolean): Subscription {
    const subscription = this.store.getSubscriptionForCharacter(principal.characterId)
    if (!subscription) throw new ServiceError('subscription_not_found', 'Subscription not found', 404)
    const updated: Subscription = { ...subscription, autoRenew, updatedAt: this.now() }
    this.store.saveSubscription(updated)
    return updated
  }

  processWalletEntry(entry: WalletJournalEntry): PaymentProcessingResult {
    let refreshCharacterId: string | null = null
    const result = this.store.transaction(() => {
      const occurredAt = parseEsiDate(entry.date)
      const payerCharacterId = derivePayerCharacterId(entry, this.cashierCharacterId)
      const inserted = this.store.insertPayment(
        entry,
        this.cashierCharacterId,
        payerCharacterId,
        occurredAt
      )
      if (!inserted) return this.duplicateResult(entry.journalId)

      const ignored = (reason: string, invoiceId: string | null = null): PaymentProcessingResult => {
        this.store.finishPayment(entry.journalId, 'ignored', reason, invoiceId)
        return {
          journalId: entry.journalId,
          duplicate: false,
          status: 'ignored',
          reason,
          invoiceId,
          characterId: payerCharacterId,
          subscriptionId: null
        }
      }

      if (entry.refType !== 'player_donation') return ignored('unsupported_ref_type')
      if (entry.amountMinor === null || entry.amountMinor <= 0n) return ignored('non_positive_amount')
      if (!payerCharacterId) return ignored('cashier_party_not_identifiable')

      const reasonMissing = entry.reason === null || entry.reason.trim() === ''
      let invoice: ReturnType<BillingStore['findInvoiceByPaymentCode']>
      if (reasonMissing) {
        const candidates = this.store.findPayableInvoicesForPayment({
          payerCharacterId,
          receiverCharacterId: this.cashierCharacterId,
          amountMinor: entry.amountMinor,
          occurredAt
        })
        if (candidates.length === 0) return ignored('invoice_not_found_without_reason')
        if (candidates.length > 1) return ignored('ambiguous_invoice_without_reason')
        invoice = candidates[0] ?? null
      } else {
        const paymentCodes = extractPaymentCodes(entry.reason)
        if (paymentCodes.length !== 1) return ignored('missing_or_ambiguous_payment_code')
        invoice = this.store.findInvoiceByPaymentCode(paymentCodes[0]!)
        if (!invoice) return ignored('invoice_not_found')
      }
      if (!invoice) throw new Error('Invoice candidate disappeared')
      if (invoice.status === 'paid' || invoice.status === 'cancelled') {
        return ignored('invoice_not_payable', invoice.id)
      }
      if (invoice.receiverCharacterId !== this.cashierCharacterId) {
        return ignored('wrong_receiver', invoice.id)
      }
      if (invoice.characterId !== payerCharacterId) return ignored('wrong_payer', invoice.id)
      if (invoice.amountMinor !== entry.amountMinor) return ignored('wrong_amount', invoice.id)
      if (occurredAt < invoice.createdAt - 300 || occurredAt > invoice.expiresAt) {
        return ignored('outside_invoice_window', invoice.id)
      }
      if (!this.store.markInvoicePaid(invoice.id, entry.journalId, occurredAt)) {
        return ignored('invoice_race_lost', invoice.id)
      }

      const credited = this.store.postLedger({
        id: `payment:${entry.journalId}`,
        characterId: invoice.characterId,
        deltaMinor: entry.amountMinor,
        kind: 'payment',
        invoiceId: invoice.id,
        paymentJournalId: entry.journalId,
        subscriptionId: null,
        note: `Wallet payment ${entry.journalId}`,
        createdAt: occurredAt
      })
      if (!credited) throw new Error('Payment ledger idempotency invariant failed')

      let subscriptionId: string | null = null
      if (invoice.kind === 'subscription') {
        if (!invoice.planId || !invoice.durationSeconds) {
          throw new Error('Subscription invoice snapshot is incomplete')
        }
        const existing = this.store.getSubscriptionForCharacter(invoice.characterId)
        const subscription: Subscription = existing
          ? {
              ...existing,
              characterName: invoice.characterName,
              planId: invoice.planId,
              status: 'active',
              paidThrough: Math.max(existing.paidThrough, occurredAt) + invoice.durationSeconds,
              updatedAt: occurredAt
            }
          : {
              id: randomUUID(),
              characterId: invoice.characterId,
              characterName: invoice.characterName,
              planId: invoice.planId,
              status: 'active',
              autoRenew: true,
              paidThrough: occurredAt + invoice.durationSeconds,
              createdAt: occurredAt,
              updatedAt: occurredAt
            }
        this.store.saveSubscription(subscription)
        const charged = this.store.postLedger({
          id: `invoice:${invoice.id}`,
          characterId: invoice.characterId,
          deltaMinor: -invoice.amountMinor,
          kind: 'subscription_charge',
          invoiceId: invoice.id,
          paymentJournalId: null,
          subscriptionId: subscription.id,
          note: `Subscription purchase ${invoice.id}`,
          createdAt: occurredAt
        })
        if (!charged) throw new Error('Subscription charge idempotency invariant failed')
        subscriptionId = subscription.id
        refreshCharacterId = invoice.characterId
      }

      this.store.finishPayment(entry.journalId, 'matched', 'invoice_paid', invoice.id)
      return {
        journalId: entry.journalId,
        duplicate: false,
        status: 'matched',
        reason: 'invoice_paid',
        invoiceId: invoice.id,
        characterId: invoice.characterId,
        subscriptionId
      } satisfies PaymentProcessingResult
    })

    if (refreshCharacterId) this.entitlements.refreshCharacter(refreshCharacterId)
    return result
  }

  renewEligibleSubscriptions(): Subscription[] {
    const now = this.now()
    const cutoff = now + this.renewalLeadSeconds
    const renewed: Subscription[] = []
    for (const candidate of this.store.listRenewableSubscriptions(cutoff)) {
      const updated = this.store.transaction(() => {
        const current = this.store.getSubscription(candidate.id)
        if (!current || !current.autoRenew || current.status === 'cancelled') return null
        if (current.paidThrough > cutoff) return null
        const plan = this.store.getPlan(current.planId)
        if (!plan || !plan.enabled) return null
        if (this.store.getCreditBalance(current.characterId) < plan.priceMinor) {
          if (current.paidThrough <= now && current.status !== 'past_due') {
            const pastDue = { ...current, status: 'past_due' as const, updatedAt: now }
            this.store.saveSubscription(pastDue)
          }
          return null
        }
        const oldPaidThrough = current.paidThrough
        const posted = this.store.postLedger({
          id: `renewal:${current.id}:${oldPaidThrough}`,
          characterId: current.characterId,
          deltaMinor: -plan.priceMinor,
          kind: 'renewal_charge',
          invoiceId: null,
          paymentJournalId: null,
          subscriptionId: current.id,
          note: `Automatic renewal from ${oldPaidThrough}`,
          createdAt: now
        })
        if (!posted) return null
        const renewal: Subscription = {
          ...current,
          status: 'active',
          paidThrough: Math.max(oldPaidThrough, now) + plan.durationSeconds,
          updatedAt: now
        }
        this.store.saveSubscription(renewal)
        return renewal
      })
      if (updated) {
        renewed.push(updated)
        this.entitlements.refreshCharacter(updated.characterId)
      }
    }
    return renewed
  }

  private createInvoice(input: {
    principal: Principal
    kind: 'subscription' | 'credit'
    planId: string | null
    amountMinor: bigint
    durationSeconds: number | null
  }): Invoice {
    const now = this.now()
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const invoice: NewInvoice = {
        id: randomUUID(),
        characterId: input.principal.characterId,
        characterName: input.principal.characterName,
        receiverCharacterId: this.cashierCharacterId,
        kind: input.kind,
        planId: input.planId,
        amountMinor: input.amountMinor,
        durationSeconds: input.durationSeconds,
        paymentCode: this.paymentCodeGenerator().toUpperCase(),
        createdAt: now,
        expiresAt: now + this.invoiceTtlSeconds
      }
      try {
        return this.store.createInvoice(invoice)
      } catch (error) {
        if (!isUniquePaymentCodeError(error)) throw error
      }
    }
    throw new Error('Unable to allocate unique payment code')
  }

  private duplicateResult(journalId: string): PaymentProcessingResult {
    const existing = this.store.getPayment(journalId)
    if (!existing) throw new Error('Duplicate journal entry disappeared')
    return {
      journalId,
      duplicate: true,
      status: existing.status === 'matched' ? 'matched' : 'ignored',
      reason: existing.statusReason ?? 'already_received',
      invoiceId: existing.invoiceId,
      characterId: existing.payerCharacterId,
      subscriptionId: existing.invoiceId
        ? this.store.getSubscriptionForCharacter(existing.payerCharacterId ?? '')?.id ?? null
        : null
    }
  }
}

export function derivePayerCharacterId(
  entry: Pick<WalletJournalEntry, 'amountMinor' | 'firstPartyId' | 'secondPartyId'>,
  cashierCharacterId: string
): string | null {
  if (entry.amountMinor === null || entry.amountMinor <= 0n) return null
  if (entry.secondPartyId === cashierCharacterId && entry.firstPartyId !== cashierCharacterId) {
    return entry.firstPartyId
  }
  if (entry.firstPartyId === cashierCharacterId && entry.secondPartyId !== cashierCharacterId) {
    return entry.secondPartyId
  }
  return null
}

export function extractPaymentCodes(reason: string | null): string[] {
  if (!reason) return []
  const codes = new Set<string>()
  for (const match of reason.toUpperCase().matchAll(PAYMENT_CODE_PATTERN)) {
    if (match[1]) codes.add(match[1])
  }
  return [...codes]
}

function createPaymentCode(): string {
  const random = randomBytes(8)
  let suffix = ''
  for (let index = 0; index < 8; index += 1) {
    suffix += PAYMENT_CODE_ALPHABET[random[index]! % PAYMENT_CODE_ALPHABET.length]
  }
  return `FS-${suffix}`
}

function parseEsiDate(value: string): number {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new ServiceError('invalid_wallet_date', 'Invalid ESI date')
  return Math.floor(milliseconds / 1_000)
}

function normalizeDeviceLabel(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === '') return null
  const normalized = value.trim()
  if (normalized.length > 80 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ServiceError('invalid_device_label', 'Device label is invalid')
  }
  return normalized
}

function isUniquePaymentCodeError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: invoices\.payment_code/u.test(error.message)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}
