export type SubscriptionPlanId = string

export interface SubscriptionPlan {
  id: SubscriptionPlanId
  name: string
  amountIsk: string
  durationSeconds: number
  features: string[]
}

export type SubscriptionInvoiceState = 'pending' | 'paid' | 'expired' | 'cancelled'

export interface SubscriptionInvoice {
  id: string
  planId: string | null
  status: SubscriptionInvoiceState
  receiverCharacterId: string
  receiverCharacterName: string | null
  amountIsk: string
  paymentCode: string
  createdAt: number
  expiresAt: number
  paidAt: number | null
}

export interface SubscriptionSummary {
  id: string
  planId: string
  status: 'active' | 'past_due' | 'cancelled'
  autoRenew: boolean
  paidThrough: number
}

export interface EntitlementSummary {
  id: string
  revision: number
  issuedAt: number
  expiresAt: number
  paidThrough: number
  planId: string
  features: string[]
}

export type EntitlementSyncState =
  | 'unavailable'
  | 'disconnected'
  | 'checking'
  | 'payment_required'
  | 'pending_payment'
  | 'active'
  | 'grace'
  | 'offline'
  | 'error'

export interface SubscriptionAccessStatus {
  state: EntitlementSyncState
  backendConfigured: boolean
  characterId: string | null
  characterName: string | null
  deviceCode: string
  subscription: SubscriptionSummary | null
  entitlement: EntitlementSummary | null
  invoice: SubscriptionInvoice | null
  lastCheckedAt: number | null
  nextCheckAt: number | null
  message: string | null
}
