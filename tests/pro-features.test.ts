import { describe, expect, it } from 'vitest'
import {
  PRO_FEATURE_IDS,
  PRO_FEATURES,
  LEGACY_PRO_FEATURE_IDS,
  hasProFeature,
  resolveLicenseProFeatures
} from '../src/shared/pro-features'

describe('Pro feature contract', () => {
  it('uses the six backend entitlement feature identifiers exactly', () => {
    expect(PRO_FEATURE_IDS).toEqual([
      'wormhole_chain_mapper',
      'hunter_planner',
      'multi_character',
      'market_opportunity_radar',
      'dscan_doctrine_matcher',
      'corp_fleet_intel'
    ])
    expect(new Set(PRO_FEATURE_IDS).size).toBe(6)
  })

  it('does not grant Pro to legacy or missing feature claims', () => {
    expect(hasProFeature(undefined, PRO_FEATURES.market)).toBe(false)
    expect(hasProFeature([], PRO_FEATURES.market)).toBe(false)
    expect(hasProFeature([PRO_FEATURES.market], PRO_FEATURES.market)).toBe(true)
  })

  it('migrates absent EVEI1 feature claims without weakening explicit EVEI2 plans', () => {
    expect(resolveLicenseProFeatures(undefined)).toEqual(LEGACY_PRO_FEATURE_IDS)
    expect(resolveLicenseProFeatures(undefined)).not.toContain(PRO_FEATURES.fleet)
    expect(resolveLicenseProFeatures([])).toEqual([])
    expect(resolveLicenseProFeatures([PRO_FEATURES.hunter])).toEqual([PRO_FEATURES.hunter])
  })
})
