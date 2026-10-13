import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { EsiClient } from '../src/main/esi-client'
import { MarketService } from '../src/main/market-service'
import { getMarketHub, marketOrderBookDepth, summarizeMarketBook, type MarketHubQuote, type MarketHubComparison } from '../src/shared/market'
import { industryProductionMarketValue, type IndustryProducedView } from '../src/shared/industry-production'
import { ProductionMarketQuoteQueue } from '../src/renderer/src/industry-market-queue'
import { MarketDepthSide } from '../src/renderer/src/MarketOrderDepth'
import { industryOrder as order } from './industry-fixtures'

const orders = [order(100, 20, true, 10, { orderId: 1 }), order(100, 15, true, 10, { orderId: 2 }), order(100, 30, false, 100, { orderId: 3 })]
const quote = (quantity = 20, source = orders): MarketHubQuote => ({ hub: getMarketHub('jita'), typeId: 100, quantity, book: summarizeMarketBook(source, quantity), depth: marketOrderBookDepth(source), history: null, cached: false, fetchedAt: '2026-10-10T00:00:00Z', regionalOrderCount: source.length, stationOrderCount: source.length })
const row = { job: { productTypeId: 100 }, outputQuantity: 20, totalCost: 203 } as IndustryProducedView
const comparison = (q: MarketHubQuote): MarketHubComparison => ({ typeId: q.typeId, quantity: q.quantity, quotes: [q], cached: q.cached, fetchedAt: q.fetchedAt })

describe('finished goods current-market valuation', () => {
  it('prices a whole BUY batch at one executable limit, not at the top bid', () => {
    const v = industryProductionMarketValue(row, quote(), 5)
    expect(v.buy).toEqual({ unitPrice: 15, gross: 300, net: 285, profit: 82, filled: 20, complete: true })
    expect(v.sell.gross).toBe(600)
    expect(v.sell.net).toBe(552)
    expect(v.sell.profit).toBe(349)
  })
  it('never extrapolates missing BUY volume or absent SELL orders', () => {
    const v = industryProductionMarketValue(row, quote(20, orders.slice(0, 1)), 5)
    expect(v.buy).toMatchObject({ gross: null, net: null, profit: null, filled: 10, complete: false })
    expect(v.sell.net).toBeNull()
    expect(industryProductionMarketValue(row, quote(20, []), 5).buy.net).toBeNull()
  })
  it('keeps current value when costs are unknown and allows actual losses', () => {
    expect(industryProductionMarketValue({ ...row, totalCost: null }, quote(), 5).buy).toMatchObject({ net: 285, profit: null })
    expect(industryProductionMarketValue({ ...row, totalCost: 1000 }, quote(), 5).sell.profit).toBe(-448)
  })
  it('rejects mismatched batches and invalid fees', () => {
    for (const q of [{ ...quote(), typeId: 34 }, quote(1)]) expect(() => industryProductionMarketValue(row, q, 5)).toThrow()
    for (const tax of [NaN, -1, 101]) expect(() => industryProductionMarketValue(row, quote(), tax)).toThrow()
    expect(() => industryProductionMarketValue(row, quote(), 99, 3)).toThrow()
  })
})

describe('complete order depth', () => {
  it('aggregates by price, deduplicates orders, sorts both sides and ignores unusable orders', () => {
    const depth = marketOrderBookDepth([...orders, orders[0], order(100, 15, true, 5, { orderId: 4 }), order(100, 29, false, 9, { orderId: 5 }), order(100, 0, true, 5, { orderId: 6 })])
    expect(depth.buy).toEqual([{ price: 20, quantity: 10, orderCount: 1 }, { price: 15, quantity: 15, orderCount: 2 }])
    expect(depth.sell.map(l => l.price)).toEqual([29, 30])
    expect(marketOrderBookDepth([])).toEqual({ buy: [], sell: [] })
  })
  it('keeps deep levels independently of quote quantity, exact station only, with actual source time', async () => {
    const cache = new Cache(':memory:')
    let now = Date.parse('2026-10-10T00:00:00Z')
    const source = Array.from({ length: 40 }, (_, i) => order(100, i + 1, false, 100, { orderId: i + 1 }))
    const getMarketOrders = vi.fn(async () => ({ orders: [...source, order(100, 0.5, false, 10, { orderId: 99, locationId: 60000001 })], pages: 1, snapshotAt: '2026-10-09T23:59:00Z', expiresAt: '2026-10-10T00:02:00Z' }))
    const service = new MarketService(':memory:', { cache, now: () => now, esiClient: { getMarketOrders } as unknown as EsiClient })
    expect((await service.getHubQuote({ typeId: 100, hubId: 'jita' })).depth).toBeUndefined()
    now += 60000
    const q = (await service.compareHubs({ typeId: 100, hubIds: ['jita'], quantity: 1, includeDepth: true })).quotes[0]
    expect(q.depth?.sell).toHaveLength(40)
    expect(q.depth?.sell[39].price).toBe(40)
    expect(q.book.immediateBuy.levels).toHaveLength(1)
    expect(q.cached).toBe(true)
    expect(q.fetchedAt).toBe('2026-10-09T23:59:00Z')
    now += 60001
    await service.getHubQuote({ typeId: 100, hubId: 'jita', includeDepth: true })
    expect(getMarketOrders).toHaveBeenCalledTimes(2)
    await service.getHubQuote({ typeId: 100, hubId: 'jita', forceRefresh: true })
    expect(getMarketOrders).toHaveBeenCalledTimes(3)
    await expect(service.getHubQuote({ typeId: 100, hubId: 'jita', includeDepth: 'yes' as never })).rejects.toThrow()
    cache.close()
  })
  it('renders price/volume/cumulative/order count and offers all remaining levels', () => {
    const levels = Array.from({ length: 80 }, (_, i) => ({ price: i + 1, quantity: 10, orderCount: 2 }))
    const html = renderToStaticMarkup(<MarketDepthSide title="SELL" levels={levels} />)
    expect(html).toContain('Накоплено'); expect(html).toContain('Ордеров')
    expect(html).toContain('осталось 55'); expect(html.match(/<tr>/g)).toHaveLength(26)
    expect(html).toContain('250')
  })
})

describe('public production quote queue', () => {
  it('coalesces equal batches, respects expiry and supports manual refresh', async () => {
    let now = 0
    const compare = vi.fn(async () => comparison({ ...quote(), expiresAt: new Date(1000).toISOString() }))
    const queue = new ProductionMarketQuoteQueue(compare, () => now)
    const first = queue.request(100, 20), duplicate = queue.request(100, 20)
    expect(first).toBe(duplicate)
    await first; await queue.request(100, 20)
    expect(compare).toHaveBeenCalledTimes(1)
    now = 1001; await queue.request(100, 20); await queue.request(100, 20, true)
    expect(compare).toHaveBeenCalledTimes(3)
    expect(compare.mock.calls[2][0]).toMatchObject({ hubIds: ['jita'], includeDepth: true, includeHistory: false, forceRefresh: true })
  })
  it('limits concurrent reads to two, retries failures and rejects wrong batch quotes', async () => {
    const releases: Array<() => void> = []
    let active = 0, peak = 0
    const queue = new ProductionMarketQuoteQueue(async request => { active++; peak = Math.max(peak, active); await new Promise<void>(r => releases.push(r)); active--; return comparison({ ...quote(request.quantity), typeId: request.typeId }) })
    const tasks = [1, 2, 3, 4].map(id => queue.request(id, 20))
    expect(releases).toHaveLength(2)
    releases.splice(0).forEach(r => r()); await new Promise(r => setTimeout(r, 0))
    expect(releases).toHaveLength(2)
    releases.splice(0).forEach(r => r()); await Promise.all(tasks)
    expect(peak).toBe(2)
    const compare = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(comparison(quote(1))).mockResolvedValue(comparison(quote()))
    const retry = new ProductionMarketQuoteQueue(compare)
    await expect(retry.request(100, 20)).rejects.toThrow('offline')
    await new Promise(r => setTimeout(r, 0))
    await expect(retry.request(100, 20)).rejects.toThrow('этой партии')
    await new Promise(r => setTimeout(r, 0))
    expect((await retry.request(100, 20)).quantity).toBe(20)
  })
})
