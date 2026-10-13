import type { Plan } from './domain.js'
import { parseIsk } from './money.js'
import type { BillingStore } from './store.js'

const ALL_PRO_FEATURES = [
  'wormhole_chain_mapper',
  'hunter_planner',
  'multi_character',
  'market_opportunity_radar',
  'dscan_doctrine_matcher',
  'corp_fleet_intel'
] as const

export const DEFAULT_PLANS: readonly Plan[] = [
  {
    id: 'pro-30d',
    name: 'Fly Safe Pro — 30 days',
    priceMinor: parseIsk('100000000'),
    durationSeconds: 30 * 86_400,
    features: ALL_PRO_FEATURES,
    enabled: true
  },
  {
    id: 'pro-90d',
    name: 'Fly Safe Pro — 90 days',
    priceMinor: parseIsk('250000000'),
    durationSeconds: 90 * 86_400,
    features: ALL_PRO_FEATURES,
    enabled: true
  },
  {
    id: 'pro-360d',
    name: 'Fly Safe Pro — 360 days',
    priceMinor: parseIsk('1000000000'),
    durationSeconds: 360 * 86_400,
    features: ALL_PRO_FEATURES,
    enabled: true
  }
]

export function seedDefaultPlans(store: BillingStore): void {
  for (const plan of DEFAULT_PLANS) store.upsertPlan(plan)
}
