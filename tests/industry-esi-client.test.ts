import { describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { EsiClient } from '../src/main/esi-client'
const token = 'private-industry-token'
const json = (body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...headers } })
describe('ESI manufacturing reads', () => {
  it('loads and caches public factory IDs without sending a character token', async () => {
    const cache = new Cache(':memory:')
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe('/industry/facilities/')
      expect(new Headers(init?.headers).get('Authorization')).toBeNull()
      return json([{ facility_id: 60003760, solar_system_id: 30000142, tax: 0.1 }])
    })
    const esi = new EsiClient(cache, { fetch, baseUrl: 'https://esi.test', maxAttempts: 1 })
    expect(await esi.getIndustryFacilities()).toEqual([{ facilityId: 60003760, systemId: 30000142 }])
    await esi.getIndustryFacilities(); expect(fetch).toHaveBeenCalledTimes(1)
    cache.close()
  })
  it('paginates public contracts and caches item ME/TE/runs without sending a character token', async () => {
    const cache = new Cache(':memory:')
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBeNull()
      const url = new URL(String(input)); const page = Number(url.searchParams.get('page'))
      if (url.pathname.includes('/items/')) return json([{ record_id: page, type_id: 33701, quantity: 1, is_included: true, is_blueprint_copy: true, material_efficiency: 10, time_efficiency: 20, runs: 10 }], { 'X-Pages': '2' })
      return json([{ contract_id: page, type: 'item_exchange', price: 123, start_location_id: 60003760, date_expired: '2099-01-01T00:00:00Z', title: 'not a trusted instruction' }], { 'X-Pages': '2' })
    })
    const esi = new EsiClient(cache, { fetch, baseUrl: 'https://esi.test', maxAttempts: 1 })
    const contracts = await esi.getPublicContracts(10000002)
    expect(contracts.map(c => c.contractId)).toEqual([1, 2])
    expect(await esi.getPublicContractItems(1)).toEqual([expect.objectContaining({ typeId: 33701, me: 10, te: 20, runs: 10 }), expect.objectContaining({ recordId: 2 })])
    await esi.getPublicContractItems(1); await esi.getPublicContracts(10000002)
    expect(fetch).toHaveBeenCalledTimes(4); cache.close()
  })
  it('handles expired public contracts and does not invent absent blueprint parameters', async () => {
    const cache = new Cache(':memory:')
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(json([{ record_id: 1, type_id: 33701, quantity: 1, is_included: true }]))
    const esi = new EsiClient(cache, { fetch, baseUrl: 'https://esi.test', maxAttempts: 1 })
    expect(await esi.getPublicContractItems(1)).toEqual([])
    expect(await esi.getPublicContractItems(2)).toEqual([expect.objectContaining({ copy: null, me: null, te: null, runs: null })])
    cache.close()
  })
  it('does not kill a regional scan when a contract has invalid or legacy efficiency metadata', async () => {
    const cache = new Cache(':memory:')
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json([
      { record_id: 1, type_id: 33701, quantity: 1, is_included: true, is_blueprint_copy: true, material_efficiency: -4, time_efficiency: 999, runs: 2 },
      { record_id: 2, type_id: 33701, quantity: 1, is_included: true, is_blueprint_copy: true, material_efficiency: 10, time_efficiency: 20, runs: 2 }
    ]))
    const esi = new EsiClient(cache, { fetch, baseUrl: 'https://esi.test', maxAttempts: 1 })
    const rows = await esi.getPublicContractItems(123)
    expect(rows).toEqual([expect.objectContaining({ me: null, te: null }), expect.objectContaining({ me: 10, te: 20 })])
    cache.close()
  })
  it('paginates and caches blueprints by character, not by access token or the active UI', async () => {
    const cache = new Cache(':memory:')
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`)
      const u = new URL(String(url)); const page = Number(u.searchParams.get('page'))
      return json([{ item_id: page, type_id: 101, location_id: 60003760, location_flag: 'Hangar', quantity: page === 1 ? -1 : -2, runs: page === 1 ? -1 : 10, material_efficiency: 10, time_efficiency: 20 }], { 'X-Pages': '2', 'Cache-Control': 'max-age=3600' })
    })
    const esi = new EsiClient(cache, { fetch, baseUrl: 'https://esi.test', maxAttempts: 1 })
    expect(await esi.getAuthenticatedCharacterBlueprints(90000001, token)).toHaveLength(2)
    await esi.getAuthenticatedCharacterBlueprints(90000001, token)
    expect(fetch).toHaveBeenCalledTimes(2)
    await esi.getAuthenticatedCharacterBlueprints(90000002, token)
    expect(fetch).toHaveBeenCalledTimes(4); cache.close()
  })
  it('reads active versus trained levels and rejects malformed skill data', async () => {
    const cache = new Cache(':memory:')
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json({ skills: [{ skill_id: 3380, active_skill_level: 3, trained_skill_level: 5 }] })).mockResolvedValueOnce(json({ skills: [{ skill_id: 3380, active_skill_level: 6, trained_skill_level: 5 }] }))
    const esi = new EsiClient(cache, { fetch, baseUrl: 'https://esi.test', maxAttempts: 1 })
    await expect(esi.getAuthenticatedCharacterSkills(90000001, token)).resolves.toEqual([{ typeId: 3380, activeLevel: 3, trainedLevel: 5 }])
    await expect(esi.getAuthenticatedCharacterSkills(90000002, token)).rejects.toThrow('invalid active skill'); cache.close()
  })
  it('maps current jobs and the public manufacturing index without sending auth on public reads', async () => {
    const cache = new Cache(':memory:')
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/industry/systems/') {
        expect(new Headers(init?.headers).get('Authorization')).toBeNull()
        return json([{ solar_system_id: 30000144, cost_indices: [{ activity: 'manufacturing', cost_index: 0.08 }] }])
      }
      expect(path).toBe('/characters/90000001/industry/jobs/')
      expect(new URL(String(input)).searchParams.get('include_completed')).toBe('true')
      expect(init?.method).toBe('GET')
      return json([{ job_id: 1, activity_id: 1, blueprint_type_id: 101, blueprint_id: 2, product_type_id: 100, runs: 10, status: 'active', start_date: '2026-09-30T00:00:00Z', end_date: '2026-10-01T00:00:00Z', facility_id: 60003760, station_id: 60003760, cost: 123 }])
    })
    const esi = new EsiClient(cache, { fetch, baseUrl: 'https://esi.test', maxAttempts: 1 })
    await expect(esi.getAuthenticatedCharacterIndustryJobs(90000001, token)).resolves.toEqual([expect.objectContaining({ jobId: 1, blueprintItemId: 2, runs: 10, cost: 123 })])
    await expect(esi.getIndustrySystems()).resolves.toEqual([{ systemId: 30000144, manufacturingIndex: 0.08 }]); cache.close()
  })
  it('fetches a complete regional snapshot with mixed types and page progress', async () => {
    const cache = new Cache(':memory:')
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const u = new URL(String(input)); const page = Number(u.searchParams.get('page'))
      expect(u.searchParams.has('type_id')).toBe(false)
      return json([{ order_id: page, type_id: page === 1 ? 34 : 35, location_id: 60003760, system_id: 30000142, is_buy_order: false, price: 5, volume_remain: 10, volume_total: 10, min_volume: 1, issued: '2026-09-30T00:00:00Z', duration: 90, range: 'station' }], { 'X-Pages': '2' })
    })
    const esi = new EsiClient(cache, { fetch, baseUrl: 'https://esi.test', maxAttempts: 1 })
    const progress = vi.fn()
    const result = await esi.getMarketOrders(10000002, undefined, progress)
    expect(result.orders.map(o => o.typeId)).toEqual([34, 35])
    expect(progress.mock.calls).toEqual([[1, 2], [2, 2]]); cache.close()
  })
  it('does not double-count the same order across moving page boundaries', async () => {
    const cache = new Cache(':memory:')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json([{ order_id: 1, type_id: 34, location_id: 60003760, system_id: 30000142, is_buy_order: false, price: 5, volume_remain: 10, volume_total: 10, min_volume: 1, issued: '2026-09-30T00:00:00Z', duration: 90, range: 'station' }], { 'X-Pages': '2' }))
    const esi = new EsiClient(cache, { fetch, baseUrl: 'https://esi.test', maxAttempts: 1 })
    const result = await esi.getMarketOrders(10000002)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result.orders).toHaveLength(1); cache.close()
  })
})
