import { generateKeyPairSync } from 'node:crypto'
import { BillingService } from '../src/billing-service.js'
import type { Plan, Principal, WalletJournalEntry } from '../src/domain.js'
import { EntitlementService, EntitlementSigner } from '../src/entitlement.js'
import { parseIsk } from '../src/money.js'
import { SqliteBillingStore } from '../src/store.js'
import { WorkspaceService } from '../src/workspace-service.js'

export const CASHIER_ID = '90000099'
export const PRINCIPAL: Principal = {
  characterId: '90000001',
  characterName: 'Test Pilot',
  scopes: []
}
export const DEVICE_CODE = 'ELI-AAAA-AAAA-AAAA-AAAA-AAAA'
export const PLAN: Plan = {
  id: 'pro-30d',
  name: 'Pro 30 days',
  priceMinor: parseIsk('100000000'),
  durationSeconds: 30 * 86_400,
  features: ['wormhole_chain_mapper', 'hunter_planner', 'corp_fleet_intel'],
  enabled: true
}

export function createFixture(paymentCodes = ['FS-ABCDEFGH']): {
  store: SqliteBillingStore
  billing: BillingService
  entitlements: EntitlementService
  signer: EntitlementSigner
  workspaces: WorkspaceService
  setNow(value: number): void
} {
  let clock = 1_700_000_000
  let codeIndex = 0
  const store = new SqliteBillingStore(':memory:')
  store.upsertPlan(PLAN)
  const { privateKey } = generateKeyPairSync('ed25519')
  const signer = new EntitlementSigner({ privateKey, keyId: 'test-key-01' })
  const entitlements = new EntitlementService({
    store,
    signer,
    graceSeconds: 172_800,
    now: () => clock
  })
  const billing = new BillingService({
    store,
    entitlementService: entitlements,
    cashierCharacterId: CASHIER_ID,
    renewalLeadSeconds: 86_400,
    now: () => clock,
    paymentCodeGenerator: () => paymentCodes[codeIndex++] ?? `FS-ZZZZZZ${codeIndex}`
  })
  const workspaces = new WorkspaceService({ store, now: () => clock })
  return { store, billing, entitlements, signer, workspaces, setNow: (value) => { clock = value } }
}

export function walletEntry(input: {
  journalId?: string
  amountIsk?: string
  reason?: string | null
  timestamp?: number
  refType?: string
  payerId?: string
} = {}): WalletJournalEntry {
  const timestamp = input.timestamp ?? 1_700_000_000
  return {
    journalId: input.journalId ?? '990000000000000001',
    date: new Date(timestamp * 1_000).toISOString(),
    refType: input.refType ?? 'player_donation',
    description: 'Player donation',
    reason: input.reason === undefined ? 'FS-ABCDEFGH' : input.reason,
    amountMinor: parseIsk(input.amountIsk ?? '100000000'),
    firstPartyId: input.payerId ?? PRINCIPAL.characterId,
    secondPartyId: CASHIER_ID,
    rawJson: '{}'
  }
}
