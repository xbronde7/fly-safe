import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FinanceAssetList } from '../src/renderer/src/FinanceWorkspace'
import type { EconomyAssetTypeSummary } from '../src/shared/personal-economy'

function asset(
  overrides: Partial<EconomyAssetTypeSummary> = {}
): EconomyAssetTypeSummary {
  return {
    typeId: 34,
    typeName: 'Tritanium',
    quantity: 1_500,
    stacks: 2,
    locations: 2,
    averagePrice: 5,
    estimatedValue: 7_500,
    locationDetails: [
      {
        locationId: 60_003_760,
        locationType: 'station',
        locationName: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
        quantity: 1_000,
        stacks: 1,
        estimatedValue: 5_000,
        unresolved: false
      },
      {
        locationId: 60_008_494,
        locationType: 'station',
        locationName: 'Amarr VIII (Oris) - Emperor Family Academy',
        quantity: 500,
        stacks: 1,
        estimatedValue: 2_500,
        unresolved: false
      }
    ],
    ...overrides
  }
}

describe('finance asset locations', () => {
  it('shows the primary station and totals without a horizontally scrolling table', () => {
    const markup = renderToStaticMarkup(<FinanceAssetList assets={[asset()]} />)

    expect(markup).toContain('finance-asset-list')
    expect(markup).not.toContain('<table')
    expect(markup).toContain('Tritanium')
    expect(markup).toContain('1,500 units · 2 stacks')
    expect(markup).toContain('Jita IV - Moon 4 - Caldari Navy Assembly Plant')
    expect(markup).toContain('7,500 ISK')
  })

  it('keeps one location flat and puts only additional locations in native details', () => {
    const oneLocation = asset({
      locations: 1,
      quantity: 1,
      stacks: 1,
      locationDetails: [{
        locationId: 60_003_760,
        locationType: 'station',
        locationName: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
        quantity: 1,
        stacks: 1,
        estimatedValue: 5,
        unresolved: false
      }]
    })
    const flatMarkup = renderToStaticMarkup(<FinanceAssetList assets={[oneLocation]} />)
    const expandedMarkup = renderToStaticMarkup(<FinanceAssetList assets={[asset()]} />)

    expect(flatMarkup).not.toContain('<details')
    expect(flatMarkup).toContain('1 unit · 1 stack')
    expect(expandedMarkup).toContain('<details class="finance-asset-locations"')
    expect(expandedMarkup).toContain('1 more location')
    expect(expandedMarkup).toContain('Amarr VIII (Oris) - Emperor Family Academy')
    expect(expandedMarkup).toContain('500 units · 1 stack')
  })

  it('labels unresolved roots honestly instead of inventing a station name', () => {
    const markup = renderToStaticMarkup(<FinanceAssetList assets={[asset({
      locations: 1,
      locationDetails: [{
        locationId: 1_030_000_000_001,
        locationType: 'other',
        locationName: null,
        quantity: 1_500,
        stacks: 2,
        estimatedValue: 7_500,
        unresolved: true
      }]
    })]} />)

    expect(markup).toContain('Location #1030000000001')
    expect(markup).toContain('Could not retrieve location name')
    expect(markup).not.toContain('Station #1030000000001')
  })

  it('labels an inaccessible private structure as a structure', () => {
    const markup = renderToStaticMarkup(<FinanceAssetList assets={[asset({
      locations: 1,
      locationDetails: [{
        locationId: 1_041_132_165_591,
        locationType: 'structure',
        locationName: null,
        quantity: 1_500,
        stacks: 2,
        estimatedValue: 7_500,
        unresolved: true
      }]
    })]} />)

    expect(markup).toContain('Structure #1041132165591')
  })
})
