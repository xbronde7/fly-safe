import { describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { EsiClient } from '../src/main/esi-client'
import { MARKET_CACHE_TTL, MarketService } from '../src/main/market-service'
import type { MarketOrder } from '../src/shared/market'

describe('MarketService', () => {
  it('builds a daily public Jita catalog for partial autocomplete', async () => {
    const cache = new Cache(':memory:')
    const getMarketTypeIds = vi.fn(async () => ({ ids: [34, 35, 36], pages: 1 }))
    const getUniverseNames = vi.fn(async () => [
      { id: 34, name: 'Tritanium', category: 'inventory_type', cached: false },
      { id: 35, name: 'Pyerite', category: 'inventory_type', cached: false },
      { id: 36, name: 'Mexallon', category: 'inventory_type', cached: false }
    ])
    const service = new MarketService(':memory:', {
      cache,
      esiClient: fakeEsi({
        getMarketTypeIds,
        getUniverseNames,
        resolveInventoryTypes: vi.fn(async (names: readonly string[]) => names.map((inputName) => ({
          inputName,
          type: null,
          cached: false
        })))
      })
    })

    await expect(service.searchInventoryTypes('trit')).resolves.toEqual([
      { typeId: 34, name: 'Tritanium', exact: false }
    ])
    await expect(service.searchInventoryTypes('pyer')).resolves.toEqual([
      { typeId: 35, name: 'Pyerite', exact: false }
    ])
    expect(getMarketTypeIds).toHaveBeenCalledTimes(1)
    expect(getUniverseNames).toHaveBeenCalledTimes(1)
    cache.close()
  })

  it.each([
    'Tritanium*',
    'Tritanium *',
    'Tritanium＊',
    'Tritanium ＊'
  ])('ignores the trailing EVE clipboard star in search: %s', async (query) => {
    const cache = new Cache(':memory:')
    const resolveInventoryTypes = vi.fn(async (names: readonly string[]) => (
      names.map((inputName) => ({
        inputName,
        type: inputName === 'Tritanium' ? { id: 34, name: 'Tritanium' } : null,
        cached: false
      }))
    ))
    const service = new MarketService(':memory:', {
      cache,
      esiClient: fakeEsi({
        getMarketTypeIds: vi.fn(async () => ({ ids: [34], pages: 1 })),
        getUniverseNames: vi.fn(async () => [
          { id: 34, name: 'Tritanium', category: 'inventory_type', cached: false }
        ]),
        resolveInventoryTypes
      })
    })

    await expect(service.searchInventoryTypes(query)).resolves.toEqual([
      { typeId: 34, name: 'Tritanium', exact: true }
    ])
    expect(resolveInventoryTypes).toHaveBeenCalledWith(['Tritanium'], false)
    cache.close()
  })

  it.each(['*', '＊', 'AB*', 'AB＊'])(
    'still rejects an empty or too-short search after removing the marker: %s',
    async (query) => {
      const cache = new Cache(':memory:')
      const service = new MarketService(':memory:', {
        cache,
        esiClient: fakeEsi({})
      })
      await expect(service.searchInventoryTypes(query)).rejects.toThrow(
        'Name must contain from 3 to 100 characters'
      )
      cache.close()
    }
  )

  it('still rejects control characters before normalizing a copied query', async () => {
    const cache = new Cache(':memory:')
    const service = new MarketService(':memory:', {
      cache,
      esiClient: fakeEsi({})
    })
    await expect(service.searchInventoryTypes('Tri\tnit*')).rejects.toThrow(
      'Name must contain from 3 to 100 characters'
    )
    cache.close()
  })

  it('filters to the exact hub station and keeps orders cached for five minutes', async () => {
    const cache = new Cache(':memory:')
    let now = 1_000_000
    const getMarketOrders = vi.fn(async () => ({
      pages: 1,
      orders: [
        order({ orderId: 1, locationId: 60_003_760, price: 6 }),
        order({ orderId: 2, locationId: 60_003_760, isBuyOrder: true, price: 5 }),
        order({ orderId: 3, locationId: 60_000_001, price: 1 })
      ]
    }))
    const service = new MarketService(':memory:', {
      cache,
      now: () => now,
      esiClient: fakeEsi({ getMarketOrders })
    })

    const first = await service.getHubQuote({ typeId: 34, hubId: 'jita', quantity: 2 })
    const second = await service.getHubQuote({ typeId: 34, hubId: 'jita', quantity: 2 })
    now += MARKET_CACHE_TTL.orders + 1
    const expired = await service.getHubQuote({ typeId: 34, hubId: 'jita', quantity: 2 })

    expect(first).toMatchObject({
      cached: false,
      regionalOrderCount: 3,
      stationOrderCount: 2,
      book: { bestSell: 6, bestBuy: 5 }
    })
    expect(second.cached).toBe(true)
    expect(expired.cached).toBe(false)
    expect(getMarketOrders).toHaveBeenCalledTimes(2)
    cache.close()
  })

  it('attaches cached daily history summaries only when requested', async () => {
    const cache = new Cache(':memory:')
    const getMarketHistory = vi.fn(async () => ({ points: [
      { date: '2026-08-23', average: 4, highest: 5, lowest: 3, orderCount: 2, volume: 10 },
      { date: '2026-08-24', average: 6, highest: 7, lowest: 5, orderCount: 3, volume: 30 }
    ] }))
    const service = new MarketService(':memory:', {
      cache,
      esiClient: fakeEsi({
        getMarketOrders: vi.fn(async () => ({ pages: 1, orders: [] })),
        getMarketHistory
      })
    })

    const first = await service.getHubQuote({
      typeId: 34,
      hubId: 'jita',
      includeHistory: true
    })
    const second = await service.getHubQuote({
      typeId: 34,
      hubId: 'jita',
      includeHistory: true
    })

    expect(first.history?.sevenDays).toMatchObject({ volume: 40, weightedAverage: 5.5 })
    expect(first.history?.cached).toBe(false)
    expect(second.history?.cached).toBe(true)
    expect(getMarketHistory).toHaveBeenCalledTimes(1)
    cache.close()
  })

  it('appraises resolved clipboard items and exposes unresolved rows', async () => {
    const cache = new Cache(':memory:')
    const service = new MarketService(':memory:', {
      cache,
      esiClient: fakeEsi({
        resolveInventoryTypes: vi.fn(async (names: readonly string[]) => names.map((inputName) => ({
          inputName,
          type: inputName === 'Tritanium' ? { id: 34, name: 'Tritanium' } : null,
          cached: false
        }))),
        getMarketOrders: vi.fn(async () => ({
          pages: 1,
          orders: [
            order({ orderId: 1, price: 5, volumeRemain: 10 }),
            order({ orderId: 2, isBuyOrder: true, price: 4, volumeRemain: 10 })
          ]
        }))
      })
    })

    const result = await service.appraiseText({
      text: 'Tritanium x2\nUnknown Item',
      hubIds: ['jita']
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ name: 'Tritanium', typeId: 34, quantity: 2 })
    expect(result.unresolved).toEqual([{
      inputName: 'Unknown Item',
      quantity: 1,
      sourceLines: [2],
      reason: 'not-found'
    }])
    expect(result.totals[0]).toMatchObject({
      immediateBuyTotal: 10,
      immediateSellTotal: 8,
      incompleteBuyItems: 0,
      incompleteSellItems: 0
    })
    cache.close()
  })
})

function fakeEsi(overrides: Partial<Record<keyof EsiClient, unknown>>): EsiClient {
  return {
    getMarketOrders: vi.fn(async () => ({ pages: 1, orders: [] })),
    getMarketHistory: vi.fn(async () => ({ points: [] })),
    getMarketTypeIds: vi.fn(async () => ({ ids: [], pages: 1 })),
    getUniverseNames: vi.fn(async () => []),
    resolveInventoryTypes: vi.fn(async () => []),
    ...overrides
  } as unknown as EsiClient
}

function order(overrides: Partial<MarketOrder>): MarketOrder {
  return {
    orderId: 1,
    typeId: 34,
    locationId: 60_003_760,
    systemId: 30_000_142,
    isBuyOrder: false,
    price: 1,
    volumeRemain: 1,
    volumeTotal: overrides.volumeRemain ?? 1,
    minVolume: 1,
    issued: '2026-08-25T00:00:00Z',
    durationDays: 90,
    range: 'station',
    ...overrides
  }
}
