import { describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { EsiClient } from '../src/main/esi-client'

describe('EsiClient public market routes', () => {
  it('reports oldest page snapshot and expiry rather than relabeling old server data as now', async () => {
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, { baseUrl: 'https://esi.test', maxAttempts: 1, fetch: vi.fn<typeof fetch>(async input => {
      const second = new URL(String(input)).searchParams.get('page') === '2'
      return jsonResponse([rawOrder(second ? 2 : 1)], 200, { 'X-Pages': '2', 'Last-Modified': second ? 'Sat, 03 Oct 2026 09:59:00 GMT' : 'Sat, 03 Oct 2026 10:00:00 GMT', 'Expires': second ? 'Sat, 03 Oct 2026 10:04:00 GMT' : 'Sat, 03 Oct 2026 10:05:00 GMT' })
    }) })
    expect(await esi.getMarketOrders(10000002, 34)).toMatchObject({ snapshotAt: '2026-10-03T09:59:00.000Z', expiresAt: '2026-10-03T10:04:00.000Z' })
    cache.close()
  })
  it.each([undefined, null, -1, 1.5, '90'])('keeps safe executable quotes with unknown duration metadata %s', async duration => {
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, { baseUrl: 'https://esi.test', maxAttempts: 1,
      fetch: vi.fn<typeof fetch>(async () => jsonResponse([{ ...rawOrder(1), duration }])) })
    const result = await esi.getMarketOrders(10_000_002)
    expect(result.orders[0]).toMatchObject({ durationDays: null, price: 5.5, volumeRemain: 100 })
    cache.close()
  })
  it('accepts zero-duration ESI orders without losing executable prices or regional volume', async () => {
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, { baseUrl: 'https://esi.test', maxAttempts: 1,
      fetch: vi.fn<typeof fetch>(async () => jsonResponse([{ ...rawOrder(1), duration: 0 }])) })
    const result = await esi.getMarketOrders(10_000_002)
    expect(result.orders).toEqual([expect.objectContaining({ durationDays: 0, price: 5.5, volumeRemain: 100 })])
    cache.close()
  })
  it('loads every regional order page and maps only the requested type', async () => {
    const cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/markets/10000002/orders/')
      expect(url.searchParams.get('order_type')).toBe('all')
      expect(url.searchParams.get('type_id')).toBe('34')
      expect(new Headers(init?.headers).get('Authorization')).toBeNull()
      const page = Number(url.searchParams.get('page'))
      return jsonResponse(
        [rawOrder(page)],
        200,
        page === 1 ? { 'X-Pages': '2' } : {}
      )
    })
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    const result = await esi.getMarketOrders(10_000_002, 34)

    expect(result.pages).toBe(2)
    expect(result.orders).toHaveLength(2)
    expect(result.orders[0]).toMatchObject({
      orderId: 1,
      typeId: 34,
      locationId: 60_003_760,
      isBuyOrder: false,
      price: 5.5,
      volumeRemain: 100
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    cache.close()
  })

  it('loads and deduplicates the active regional market type catalog', async () => {
    const cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/markets/10000002/types/')
      const page = Number(url.searchParams.get('page'))
      return jsonResponse(page === 1 ? [34, 35] : [35, 36], 200, page === 1 ? { 'X-Pages': '2' } : {})
    })
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    await expect(esi.getMarketTypeIds(10_000_002)).resolves.toEqual({
      ids: [34, 35, 36],
      pages: 2
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    cache.close()
  })

  it('resolves only exact inventory names and negatively caches fuzzy misses', async () => {
    const cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(['Tritanium', 'Trit'])
      return jsonResponse({
        inventory_types: [
          { id: 34, name: 'Tritanium' },
          { id: 35, name: 'Pyerite' }
        ]
      })
    })
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    await expect(esi.resolveInventoryTypes(['Tritanium', 'Trit'])).resolves.toEqual([
      { inputName: 'Tritanium', type: { id: 34, name: 'Tritanium' }, cached: false },
      { inputName: 'Trit', type: null, cached: false }
    ])
    await expect(esi.resolveInventoryTypes([' tritanium ', 'Trit'])).resolves.toEqual([
      { inputName: 'tritanium', type: { id: 34, name: 'Tritanium' }, cached: true },
      { inputName: 'Trit', type: null, cached: true }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    cache.close()
  })

  it('validates and sorts daily regional history', async () => {
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      maxAttempts: 1,
      fetch: vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input))
        expect(url.pathname).toBe('/markets/10000002/history/')
        expect(url.searchParams.get('type_id')).toBe('34')
        return jsonResponse([
          { average: 6, date: '2026-08-24', highest: 7, lowest: 5, order_count: 12, volume: 200 },
          { average: 5, date: '2026-08-23', highest: 6, lowest: 4, order_count: 10, volume: 100 }
        ])
      })
    })

    await expect(esi.getMarketHistory(10_000_002, 34)).resolves.toEqual({
      points: [
        { average: 5, date: '2026-08-23', highest: 6, lowest: 4, orderCount: 10, volume: 100 },
        { average: 6, date: '2026-08-24', highest: 7, lowest: 5, orderCount: 12, volume: 200 }
      ]
    })
    cache.close()
  })
})

function rawOrder(page: number): Record<string, unknown> {
  return {
    duration: 90,
    is_buy_order: page === 2,
    issued: '2026-08-25T00:00:00Z',
    location_id: 60_003_760,
    min_volume: 1,
    order_id: page,
    price: page === 1 ? 5.5 : 5,
    range: 'station',
    system_id: 30_000_142,
    type_id: 34,
    volume_remain: 100,
    volume_total: 100
  }
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}
