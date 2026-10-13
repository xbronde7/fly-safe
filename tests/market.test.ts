import { describe, expect, it } from 'vitest'
import {
  MARKET_HUBS,
  parseMarketText,
  summarizeMarketBook,
  summarizeMarketHistory,
  type MarketOrder
} from '../src/shared/market'

describe('market shared model', () => {
  it('contains the exact stations and regions for all five trade hubs', () => {
    expect(MARKET_HUBS.map(({ id, stationId, solarSystemId, regionId }) => ({
      id,
      stationId,
      solarSystemId,
      regionId
    })))
      .toEqual([
        { id: 'jita', stationId: 60_003_760, solarSystemId: 30_000_142, regionId: 10_000_002 },
        { id: 'amarr', stationId: 60_008_494, solarSystemId: 30_002_187, regionId: 10_000_043 },
        { id: 'dodixie', stationId: 60_011_866, solarSystemId: 30_002_659, regionId: 10_000_032 },
        { id: 'rens', stationId: 60_004_588, solarSystemId: 30_002_510, regionId: 10_000_030 },
        { id: 'hek', stationId: 60_005_686, solarSystemId: 30_002_053, regionId: 10_000_042 }
      ])
  })

  it('parses inventory rows and EFT while aggregating duplicate items', () => {
    const result = parseMarketText([
      'Item\tQuantity',
      '[Rifter, Clipboard fit]',
      '200mm AutoCannon II',
      '200mm AutoCannon II',
      'Republic Fleet EMP S x1,000',
      'Nanite Repair Paste\t2 500',
      'Rocket Launcher II, Caldari Navy Inferno Rocket',
      '[Empty Low slot]',
      ''
    ].join('\n'))

    expect(result.warnings).toEqual([])
    expect(result.items).toEqual([
      { name: 'Rifter', quantity: 1, sourceLines: [2] },
      { name: '200mm AutoCannon II', quantity: 2, sourceLines: [3, 4] },
      { name: 'Republic Fleet EMP S', quantity: 1_000, sourceLines: [5] },
      { name: 'Nanite Repair Paste', quantity: 2_500, sourceLines: [6] },
      { name: 'Rocket Launcher II', quantity: 1, sourceLines: [7] },
      { name: 'Caldari Navy Inferno Rocket', quantity: 1, sourceLines: [7] }
    ])
    expect(result.ignoredLineCount).toBe(3)
  })

  it('strips trailing EVE clipboard stars from appraisal items only', () => {
    const result = parseMarketText([
      'Tritanium*',
      'Tritanium',
      'Pyerite＊\t2',
      'Mexallon * x3',
      'Isogen ＊',
      'Republic * Fleet EMP S',
      'Prototype＊Core',
      '*'
    ].join('\n'))

    expect(result.warnings).toEqual([])
    expect(result.items).toEqual([
      { name: 'Tritanium', quantity: 2, sourceLines: [1, 2] },
      { name: 'Pyerite', quantity: 2, sourceLines: [3] },
      { name: 'Mexallon', quantity: 3, sourceLines: [4] },
      { name: 'Isogen', quantity: 1, sourceLines: [5] },
      { name: 'Republic * Fleet EMP S', quantity: 1, sourceLines: [6] },
      { name: 'Prototype＊Core', quantity: 1, sourceLines: [7] }
    ])
    expect(result.ignoredLineCount).toBe(1)
  })

  it('rejects malformed quantities instead of resolving them as item names', () => {
    const result = parseMarketText('Tritanium\t0\nMexallon x0\n10 Isogen')

    expect(result.items).toEqual([{ name: 'Isogen', quantity: 10, sourceLines: [3] }])
    expect(result.warnings).toHaveLength(2)
    expect(result.ignoredLineCount).toBe(2)
  })

  it('walks executable depth in the correct direction and reports missing volume', () => {
    const orders = [
      order({ orderId: 1, price: 10, volumeRemain: 5 }),
      order({ orderId: 2, price: 12, volumeRemain: 10, minVolume: 5 }),
      order({ orderId: 3, isBuyOrder: true, price: 9, volumeRemain: 4 }),
      order({ orderId: 4, isBuyOrder: true, price: 8, volumeRemain: 10 })
    ]

    const book = summarizeMarketBook(orders, 8)

    expect(book).toMatchObject({
      bestBuy: 9,
      bestSell: 10,
      spread: 1,
      spreadPercent: 10,
      buyVolume: 14,
      sellVolume: 15
    })
    expect(book.immediateBuy).toMatchObject({
      filledQuantity: 5,
      missingQuantity: 3,
      total: 50,
      complete: false
    })
    expect(book.immediateSell).toMatchObject({
      filledQuantity: 8,
      missingQuantity: 0,
      total: 68,
      averagePrice: 8.5,
      complete: true
    })
  })

  it('summarizes only the latest requested daily history points', () => {
    const result = summarizeMarketHistory([
      { date: '2026-08-20', average: 10, highest: 11, lowest: 9, orderCount: 2, volume: 10 },
      { date: '2026-08-21', average: 20, highest: 22, lowest: 18, orderCount: 3, volume: 30 },
      { date: '2026-08-22', average: 30, highest: 35, lowest: 25, orderCount: 4, volume: 10 }
    ], 2)

    expect(result).toEqual({
      days: 2,
      points: 2,
      volume: 40,
      orderCount: 7,
      lowest: 18,
      highest: 35,
      weightedAverage: 22.5
    })
  })
})

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
