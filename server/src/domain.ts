export const ENTITLEMENT_TOKEN_PREFIX = 'EVEI2'
export const ENTITLEMENT_VERSION = 2 as const
export const ENTITLEMENT_PRODUCT = 'eve-local-intel' as const

export interface Principal {
  characterId: string
  characterName: string
  scopes: readonly string[]
}

export interface Plan {
  id: string
  name: string
  priceMinor: bigint
  durationSeconds: number
  features: readonly string[]
  enabled: boolean
}

export type InvoiceKind = 'subscription' | 'credit'
export type InvoiceStatus = 'pending' | 'paid' | 'expired' | 'cancelled'

export interface Invoice {
  id: string
  characterId: string
  characterName: string
  receiverCharacterId: string
  kind: InvoiceKind
  planId: string | null
  amountMinor: bigint
  paymentCode: string
  status: InvoiceStatus
  createdAt: number
  expiresAt: number
  paidAt: number | null
  paymentJournalId: string | null
}

export type SubscriptionStatus = 'active' | 'past_due' | 'cancelled'

export interface Subscription {
  id: string
  characterId: string
  characterName: string
  planId: string
  status: SubscriptionStatus
  autoRenew: boolean
  paidThrough: number
  createdAt: number
  updatedAt: number
}

export type DeviceStatus = 'active' | 'revoked'

export interface Device {
  id: string
  characterId: string
  deviceCode: string
  label: string | null
  status: DeviceStatus
  createdAt: number
  updatedAt: number
  lastSeenAt: number
}

export interface EntitlementClaimsV2 {
  v: typeof ENTITLEMENT_VERSION
  product: typeof ENTITLEMENT_PRODUCT
  kid: string
  entitlementId: string
  revision: number
  subscriptionId: string
  characterId: string
  characterName: string
  deviceId: string
  deviceCode: string
  planId: string
  features: readonly string[]
  issuedAt: number
  notBefore: number
  paidThrough: number
  expiresAt: number
}

export interface IssuedEntitlement {
  id: string
  subscriptionId: string
  deviceId: string
  revision: number
  token: string
  claims: EntitlementClaimsV2
  issuedAt: number
  expiresAt: number
}

export interface WalletJournalEntry {
  journalId: string
  date: string
  refType: string
  description: string
  reason: string | null
  amountMinor: bigint | null
  firstPartyId: string | null
  secondPartyId: string | null
  rawJson: string
}

export type PaymentProcessingStatus = 'matched' | 'ignored'

export interface PaymentProcessingResult {
  journalId: string
  duplicate: boolean
  status: PaymentProcessingStatus
  reason: string
  invoiceId: string | null
  characterId: string | null
  subscriptionId: string | null
}

export class ServiceError extends Error {
  readonly code: string
  readonly httpStatus: number
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: string,
    message: string,
    httpStatus = 400,
    details?: Readonly<Record<string, unknown>>
  ) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.httpStatus = httpStatus
    if (details) this.details = details
  }
}

export function nowSeconds(now: () => number = Date.now): number {
  return Math.floor(now() / 1_000)
}

export function assertCharacterId(value: string): string {
  if (!/^\d{6,20}$/u.test(value)) throw new ServiceError('invalid_character', 'Invalid character ID')
  return value
}

export function assertDeviceCode(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!/^ELI-(?:[A-Z2-7]{4}-){4}[A-Z2-7]{4}$/u.test(normalized)) {
    throw new ServiceError('invalid_device_code', 'Invalid Fly Safe device code')
  }
  return normalized
}
