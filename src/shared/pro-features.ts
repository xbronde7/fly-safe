export const PRO_FEATURES = {
  wormhole: 'wormhole_chain_mapper',
  hunter: 'hunter_planner',
  characters: 'multi_character',
  market: 'market_opportunity_radar',
  doctrine: 'dscan_doctrine_matcher',
  fleet: 'corp_fleet_intel'
} as const

export type ProFeatureId = (typeof PRO_FEATURES)[keyof typeof PRO_FEATURES]
export const PRO_FEATURE_IDS = Object.freeze(Object.values(PRO_FEATURES)) as readonly ProFeatureId[]
export const LEGACY_PRO_FEATURE_IDS = Object.freeze(
  PRO_FEATURE_IDS.filter((feature) => feature !== PRO_FEATURES.fleet)
) as readonly ProFeatureId[]

/** EVEI1 keeps local Pro access; cloud Corp/Fleet requires a server-backed EVEI2 subscription. */
export function resolveLicenseProFeatures(
  features: readonly string[] | undefined
): readonly string[] {
  return features === undefined ? LEGACY_PRO_FEATURE_IDS : features
}

export function hasProFeature(
  features: readonly string[] | null | undefined,
  feature: ProFeatureId
): boolean {
  return Array.isArray(features) && features.includes(feature)
}
