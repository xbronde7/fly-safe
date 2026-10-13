import { describe, expect, it } from 'vitest'
import {
  buildPersonalEconomySnapshot,
  collectEconomyAssetRootIds,
  collectEconomyTypeIds,
  PERSONAL_ECONOMY_SCOPES,
  resolveEconomyAssetRoots
} from '../src/shared/personal-economy'

describe('personal economy aggregation', () => {
  it('summarizes assets, orders and 30-day trade without overstating unpriced assets', () => {
    const snapshot = buildPersonalEconomySnapshot({
      characterId: 90_000_001,
      grantedScopes: PERSONAL_ECONOMY_SCOPES,
      fetchedAt: '2026-08-25T12:00:00Z',
      balance: 1_500_000_000,
      typeNames: [{ id: 34, name: 'Tritanium' }, { id: 35, name: 'Pyerite' }],
      marketPrices: [{ typeId: 34, averagePrice: 5, adjustedPrice: 4 }],
      assetLocationResolutions: [
        { locationId: 60003760, locationType: 'station', locationName: 'Jita IV', unresolved: false },
        { locationId: 60008494, locationType: 'station', locationName: 'Amarr VIII', unresolved: false }
      ],
      assets: [
        { itemId: 1, typeId: 34, quantity: 1_000, locationId: 60003760, locationType: 'station', locationFlag: 'Hangar', singleton: false },
        { itemId: 2, typeId: 34, quantity: 500, locationId: 60008494, locationType: 'station', locationFlag: 'Hangar', singleton: false },
        { itemId: 3, typeId: 35, quantity: 10, locationId: 60003760, locationType: 'station', locationFlag: 'Hangar', singleton: false }
      ],
      orders: [{
        orderId: 10,
        typeId: 34,
        locationId: 60003760,
        regionId: 10000002,
        buyOrder: false,
        price: 6,
        volumeRemain: 300,
        volumeTotal: 500,
        minVolume: 1,
        issued: '2026-08-24T12:00:00Z',
        durationDays: 30,
        escrow: 0,
        state: 'open'
      }],
      transactions: [
        { transactionId: 100, date: '2026-08-24T10:00:00Z', typeId: 34, quantity: 100, unitPrice: 4, buy: true, personal: true, locationId: 60003760, clientId: 90_000_002 },
        { transactionId: 101, date: '2026-08-24T11:00:00Z', typeId: 34, quantity: 50, unitPrice: 7, buy: false, personal: true, locationId: 60003760, clientId: 90_000_003 },
        { transactionId: 102, date: '2026-06-01T11:00:00Z', typeId: 34, quantity: 1, unitPrice: 999, buy: false, personal: true, locationId: 60003760, clientId: 90_000_003 }
      ]
    })

    expect(snapshot.balance).toBe(1_500_000_000)
    expect(snapshot.assets).toMatchObject({
      stackCount: 3,
      typeCount: 2,
      estimatedValue: 7_500,
      pricedTypeCount: 1,
      unpricedTypeCount: 1,
      coverage: 0.5
    })
    expect(snapshot.assets.top[0]).toMatchObject({
      typeName: 'Tritanium',
      quantity: 1_500,
      stacks: 2,
      locations: 2,
      locationDetails: [
        {
          locationId: 60003760,
          locationType: 'station',
          locationName: 'Jita IV',
          quantity: 1_000,
          stacks: 1,
          estimatedValue: 5_000,
          unresolved: false
        },
        {
          locationId: 60008494,
          locationType: 'station',
          locationName: 'Amarr VIII',
          quantity: 500,
          stacks: 1,
          estimatedValue: 2_500,
          unresolved: false
        }
      ],
      estimatedValue: 7_500
    })
    expect(snapshot.orders).toMatchObject({ sellCount: 1, buyCount: 0, sellGrossRemaining: 1_800 })
    expect(snapshot.trade30d).toEqual({
      buys: 400,
      sales: 350,
      net: -50,
      transactionCount: 2,
      itemsBought: 100,
      itemsSold: 50
    })
    expect(snapshot.transactions).toHaveLength(3)
    expect(snapshot.missingScopes).toEqual([])
  })

  it('reports missing permissions and ignores malformed rows', () => {
    const snapshot = buildPersonalEconomySnapshot({
      characterId: 7,
      grantedScopes: ['esi-assets.read_assets.v1'],
      fetchedAt: '2026-08-25T00:00:00Z',
      assets: [{ itemId: 1, typeId: -1, quantity: 0, locationId: 0, locationType: '', locationFlag: '', singleton: false }],
      warnings: [' orders unavailable ', 'orders unavailable']
    })

    expect(snapshot.missingScopes).toEqual([
      'esi-wallet.read_character_wallet.v1',
      'esi-markets.read_character_orders.v1',
      'esi-universe.read_structures.v1'
    ])
    expect(snapshot.assets.typeCount).toBe(0)
    expect(snapshot.warnings).toEqual(['orders unavailable'])
  })

  it('collects unique positive type IDs across all sources', () => {
    expect(collectEconomyTypeIds({
      assets: [{ itemId: 1, typeId: 34, quantity: 1, locationId: 1, locationType: 'station', locationFlag: 'Hangar', singleton: false }],
      orders: [{ orderId: 1, typeId: 35, locationId: 1, regionId: 1, buyOrder: false, price: 1, volumeRemain: 1, volumeTotal: 1, minVolume: 1, issued: '2026-08-25T00:00:00Z', durationDays: 1, escrow: 0, state: 'open' }],
      transactions: [{ transactionId: 1, date: '2026-08-25T00:00:00Z', typeId: 34, quantity: 1, unitPrice: 1, buy: true, personal: true, locationId: 1, clientId: 1 }]
    })).toEqual([34, 35])
  })

  it('walks nested item locations to one station root before counting places', () => {
    const assets = [
      { itemId: 10, typeId: 587, quantity: 1, locationId: 60003760, locationType: 'station', locationFlag: 'Hangar', singleton: true },
      { itemId: 20, typeId: 34, quantity: 100, locationId: 10, locationType: 'item', locationFlag: 'Cargo', singleton: false },
      { itemId: 30, typeId: 34, quantity: 200, locationId: 20, locationType: 'item', locationFlag: 'Cargo', singleton: false }
    ]

    expect(resolveEconomyAssetRoots(assets)).toEqual([
      { itemId: 10, locationId: 60003760, locationType: 'station', unresolved: false, structureCandidate: false },
      { itemId: 20, locationId: 60003760, locationType: 'station', unresolved: false, structureCandidate: false },
      { itemId: 30, locationId: 60003760, locationType: 'station', unresolved: false, structureCandidate: false }
    ])
    expect(collectEconomyAssetRootIds(assets)).toEqual({
      publicLocationIds: [60003760],
      structureIds: []
    })

    const snapshot = buildPersonalEconomySnapshot({
      characterId: 1,
      grantedScopes: PERSONAL_ECONOMY_SCOPES,
      fetchedAt: '2026-08-25T00:00:00Z',
      assets,
      typeNames: [{ id: 34, name: 'Tritanium' }],
      marketPrices: [{ typeId: 34, averagePrice: 5, adjustedPrice: null }],
      assetLocationResolutions: [{
        locationId: 60003760,
        locationType: 'station',
        locationName: 'Jita IV',
        unresolved: false
      }]
    })
    expect(snapshot.assets.top.find((entry) => entry.typeId === 34)).toMatchObject({
      quantity: 300,
      stacks: 2,
      locations: 1,
      locationDetails: [{
        locationId: 60003760,
        locationName: 'Jita IV',
        quantity: 300,
        stacks: 2,
        estimatedValue: 1_500,
        unresolved: false
      }]
    })
  })

  it('marks only a missing item parent as a structure candidate and guards cycles', () => {
    const structureId = 1_041_132_165_591
    const assets = [
      { itemId: 40, typeId: 34, quantity: 1, locationId: 41, locationType: 'item', locationFlag: 'Cargo', singleton: false },
      { itemId: 41, typeId: 35, quantity: 1, locationId: 40, locationType: 'item', locationFlag: 'Cargo', singleton: false },
      { itemId: 50, typeId: 36, quantity: 1, locationId: structureId, locationType: 'item', locationFlag: 'Hangar', singleton: false }
    ]

    const roots = resolveEconomyAssetRoots(assets)
    expect(roots.slice(0, 2).every((root) => (
      root.unresolved && !root.structureCandidate
    ))).toBe(true)
    expect(roots[2]).toEqual({
      itemId: 50,
      locationId: structureId,
      locationType: 'item',
      unresolved: true,
      structureCandidate: true
    })
    expect(collectEconomyAssetRootIds(assets)).toEqual({
      publicLocationIds: [],
      structureIds: [structureId]
    })
  })

  it('sorts location details by the largest share of the type first', () => {
    const snapshot = buildPersonalEconomySnapshot({
      characterId: 1,
      grantedScopes: PERSONAL_ECONOMY_SCOPES,
      fetchedAt: '2026-08-25T00:00:00Z',
      assets: [
        { itemId: 1, typeId: 34, quantity: 2, locationId: 60000001, locationType: 'station', locationFlag: 'Hangar', singleton: false },
        { itemId: 2, typeId: 34, quantity: 9, locationId: 60000002, locationType: 'station', locationFlag: 'Hangar', singleton: false }
      ],
      marketPrices: [{ typeId: 34, averagePrice: 10, adjustedPrice: null }],
      assetLocationResolutions: [
        { locationId: 60000001, locationType: 'station', locationName: 'Small', unresolved: false },
        { locationId: 60000002, locationType: 'station', locationName: 'Primary', unresolved: false }
      ]
    })

    expect(snapshot.assets.top[0].locationDetails.map((location) => location.locationName))
      .toEqual(['Primary', 'Small'])
  })
})
