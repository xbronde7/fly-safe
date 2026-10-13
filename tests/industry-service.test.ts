import { describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { IndustryService, INDUSTRY_CATALOG, availableHangarStock, contractBlueprintOffer, isTransientIndustryError, ordersAtIndustryHub, type IndustryEsiAdapter } from '../src/main/industry-service'
import { getMarketHub } from '../src/shared/market'
import { EsiError } from '../src/main/esi-client'
import { industryPurchase as purchase } from './industry-fixtures'
import { INDUSTRY_SCOPES } from '../src/shared/industry'
import { DEFAULT_MASS_SETTINGS } from '../src/shared/industry-mass'
import { industryCatalog, industryRequest, industrySkills, industryOrder, ownIndustryBlueprint } from './industry-fixtures'
function fixture() {
  let characterId = 90000001
  const account = { getAuthorizedSession: vi.fn(async () => ({ accessToken: 'secret-must-not-leak', session: { characterId, characterName: 'Industrialist', scopes: Object.values(INDUSTRY_SCOPES) as string[] } })) }
  const esi: IndustryEsiAdapter = {
    getAuthenticatedCharacterWalletTransactions: vi.fn(async () => []),
    getAuthenticatedCharacterSkills: vi.fn(async () => industrySkills),
    getAuthenticatedCharacterBlueprints: vi.fn(async () => [ownIndustryBlueprint]),
    getAuthenticatedCharacterIndustryJobs: vi.fn(async () => []),
    getAuthenticatedCharacterAssets: vi.fn(async () => []),
    getPublicContracts: vi.fn(async () => []),
    getPublicContractItems: vi.fn(async () => []),
    getIndustrySystems: vi.fn(async () => [{ systemId: 30000144, manufacturingIndex: 0.1 }]),
    getIndustryFacilities: vi.fn(async () => []),
    getMarketPrices: vi.fn(async () => [{ typeId: 34, adjustedPrice: 4, averagePrice: 5 }, { typeId: 35, adjustedPrice: 15, averagePrice: 20 }]),
    getMarketOrders: vi.fn(async () => ({ orders: [industryOrder(34, 5), industryOrder(35, 20), industryOrder(100, 30, true), industryOrder(101, 100)], pages: 1 })),
    getMarketHistory: vi.fn(async () => ({ points: [] })),
    resolveSolarSystemId: vi.fn(async () => ({ id: 30000144, name: 'Perimeter', cached: false })),
    getSolarSystem: vi.fn(async () => ({ id: 30000144, name: 'Perimeter', constellationId: 20000001, securityStatus: 1, securityClass: 'B', stargateIds: [], cached: false }))
  }
  const cache = new Cache(':memory:')
  const service = new IndustryService(account, esi, cache, industryCatalog)
  return { account, esi, service, cache, switchCharacter: () => { characterId++ } }
}
describe('IndustryService', () => {
  it('builds nine distinct long contract jobs while keeping the monitor scan single-run', async () => {
    const f = fixture()
    vi.mocked(f.esi.getAuthenticatedCharacterSkills).mockResolvedValue([...industrySkills, { typeId: 3387, activeLevel: 5, trainedLevel: 5 }, { typeId: 24625, activeLevel: 3, trainedLevel: 3 }])
    const contracts = Array.from({ length: 10 }, (_, i) => ({ contractId: 100 + i, type: 'item_exchange' as const, price: 100, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' }))
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue(contracts)
    vi.mocked(f.esi.getPublicContractItems).mockImplementation(async id => [{ recordId: 1, typeId: 101, quantity: id === 109 ? 2 : 1, included: true, copy: true, me: 0, te: 0, runs: 100 }])
    vi.mocked(f.esi.getMarketHistory).mockResolvedValue({ lastModified: '2026-10-11T12:00:00Z', points: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${String(4 + i).padStart(2, '0')}`, volume: 100000, orderCount: 100, average: 30, highest: 30, lowest: 30 })) })
    const topology = { systems: { 30000142: { name: 'Jita', security: 0.9, neighbors: [30000144] }, 30000144: { name: 'Perimeter', security: 0.9, neighbors: [30000142] } }, factories: { 60000004: { name: 'Perimeter Factory', systemId: 30000144 } } }
    vi.mocked(f.esi.getIndustryFacilities).mockResolvedValue([{ facilityId: 60000004, systemId: 30000144 }])
    const service = new IndustryService(f.account, f.esi, f.cache, industryCatalog, () => Date.parse('2026-10-11T12:00:00Z'), topology)
    const result = await service.scan({ ...industryRequest, blueprintMode: 'contracts', productionSystem: 'Jita', massProduction: DEFAULT_MASS_SETTINGS })
    expect(result.rows[0].runs).toBe(35)
    expect(result.massPlan?.jobs).toHaveLength(9)
    expect(new Set(result.massPlan?.jobs.map(j => j.sourceKey)).size).toBe(9)
    expect(result.massPlan?.jobs.some(j => j.sourceKey === 'contract:109')).toBe(false)
    expect(result.massPlan?.totals.products[0].quantity).toBe(3150)
    expect(result.massPlan?.totals.blueprintPurchase).toBe(900)
    expect(result.massPlan?.totals.transportCost).toBe(10)
    const factories = await service.factories({ scanId: industryRequest.scanId, blueprintTypeId: 101, originSystem: 'Jita', maxJumps: 10, highSecOnly: true })
    expect(factories.rows).toHaveLength(1)
    expect(factories.rows[0].hours).toBeCloseTo(result.rows[0].hours)
    expect(factories.rows[0].profit).toBeCloseTo(result.rows[0].grossRevenue! - result.rows[0].salesTax! - factories.rows[0].materialCost! - factories.rows[0].installationCost! - 100 - 10)
    const monitor = await service.scan({ ...industryRequest, scanId: 'monitor_only', blueprintMode: 'contracts', contractCopiesOnly: true, autoPlan: false, runs: 1 })
    expect(monitor.rows[0].runs).toBe(1)
    expect(monitor.massPlan).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('secret-must-not-leak')
    f.cache.close()
  })
  it('loads only Jita station SELL fallback and Jita SCI, sharing the regional book', async () => {
    const f = fixture()
    vi.mocked(f.esi.getIndustrySystems).mockResolvedValue([{ systemId: 30000142, manufacturingIndex: 0.12 }, { systemId: 30000144, manufacturingIndex: 0.99 }])
    vi.mocked(f.esi.getMarketOrders).mockResolvedValue({ orders: [industryOrder(34, 5), industryOrder(34, 1, false, 999, { locationId: 60000004 }), industryOrder(34, 20, true), industryOrder(35, 5)], pages: 1 })
    const pricing = await f.service.getProductionPricing([34], true)
    expect(pricing.orders).toHaveLength(1); expect(pricing.orders[0].price).toBe(5)
    expect(pricing.jitaCostIndex).toBe(0.12)
    expect(f.esi.getMarketOrders).toHaveBeenCalledWith(10000002, undefined, expect.any(Function))
    await f.service.getProductionPricing([34], false)
    expect(f.esi.getMarketOrders).toHaveBeenCalledTimes(1)
    expect(f.esi.getMarketPrices).toHaveBeenCalledTimes(1)
    f.cache.close()
  })
  it('preserves observed blueprint ME when the next background capture contains jobs only', async () => {
    const f = fixture()
    vi.mocked(f.esi.getAuthenticatedCharacterIndustryJobs).mockResolvedValue([{ jobId: 1, activityId: 1, blueprintTypeId: 101, blueprintItemId: ownIndustryBlueprint.itemId, productTypeId: 100, runs: 2, status: 'delivered', startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-02T00:00:00Z', facilityId: 60003760, stationId: 60003760, cost: 123 }])
    await f.service.getCharacter()
    await f.service.captureJobs()
    expect(f.cache.getIndustryRecords<any>(90000001, 'production-job')[0].value).toMatchObject({ materialEfficiency: 10, materials: [{ typeId: 34, quantity: 18 }, { typeId: 35, quantity: 2 }] })
    f.cache.close()
  })
  it('scans only purchasable copies and ignores own blueprints and stock in BPC monitoring', async () => {
    const f = fixture()
    vi.mocked(f.account.getAuthorizedSession).mockResolvedValue({ accessToken: 'private', session: { characterId: 90000001, characterName: 'Test', scopes: [...Object.values(INDUSTRY_SCOPES), 'esi-assets.read_assets.v1'] } })
    vi.mocked(f.esi.getAuthenticatedCharacterAssets).mockResolvedValue([{ itemId: 10, typeId: 34, quantity: 9999, locationId: 60003760, locationType: 'station', locationFlag: 'Hangar', singleton: false }])
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue([22, 23].map(contractId => ({ contractId, type: 'item_exchange', price: contractId === 22 ? 1 : 100, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' })))
    vi.mocked(f.esi.getPublicContractItems).mockImplementation(async id => [{ recordId: id, typeId: 101, quantity: 1, included: true, copy: id === 23, me: 0, te: 0, runs: id === 23 ? 10 : -1 }])
    const result = await f.service.scan({ ...industryRequest, blueprintMode: 'contracts', contractCopiesOnly: true, autoPlan: true })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].blueprint).toMatchObject({ source: 'contract-copy', contractId: 23 })
    expect(result.rows[0].materials[0].stock).toBeUndefined()
    expect(result.rows[0].materialCost).toBe(70)
    f.cache.close()
  })
  it('persists observed manufacturing jobs independently of expiring cache entries', async () => {
    const f = fixture()
    vi.mocked(f.esi.getAuthenticatedCharacterIndustryJobs).mockResolvedValue([{ jobId: 1, activityId: 1, blueprintTypeId: 101, blueprintItemId: 99, productTypeId: 100, runs: 2, status: 'delivered', startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-02T00:00:00Z', facilityId: 60003760, stationId: 60003760, cost: 123 }])
    await f.service.getCharacter()
    f.cache.clear()
    expect(f.cache.getIndustryRecords(90000001, 'production-job')).toHaveLength(1)
    expect(f.cache.getIndustryRecords(90000002, 'production-job')).toHaveLength(0)
    f.cache.close()
  })
  it('yields cached contract indexing to abort events instead of draining all microtasks', async () => {
    const f = fixture()
    const contracts = Array.from({ length: 200 }, (_, i) => ({ contractId: 1000 + i, type: 'item_exchange' as const, price: 100, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' }))
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue(contracts)
    for (const c of contracts) f.cache.set('industry:contract-index-items:v1', String(c.contractId), [], 600000)
    const controller = new AbortController()
    const progress = vi.fn(event => { if (event.message.startsWith('База контрактов: 1/')) setImmediate(() => controller.abort()) })
    await expect(f.service.scan({ ...industryRequest, blueprintMode: 'contracts' }, progress, controller.signal)).rejects.toThrow('Сканирование остановлено')
    expect(f.esi.getPublicContractItems).not.toHaveBeenCalled()
    f.cache.close()
  })
  it('batches cached contract progress and keeps the final merged source count', async () => {
    const f = fixture()
    const contracts = Array.from({ length: 100 }, (_, i) => ({ contractId: 1000 + i, type: 'item_exchange' as const, price: 1000 + i, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' }))
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue(contracts)
    for (const c of contracts) f.cache.set('industry:contract-index-items:v1', String(c.contractId), [{ recordId: 1, typeId: 101, quantity: 1, included: true, copy: true, me: 0, te: 0, runs: 100 }], 600000)
    const service = new IndustryService(f.account, f.esi, f.cache, industryCatalog, () => Date.parse('2026-10-03T10:00:00Z'))
    const progress = vi.fn()
    const result = await service.scan({ ...industryRequest, blueprintMode: 'combined', autoPlan: true }, progress)
    const contractEvents = progress.mock.calls.filter(([event]) => event.message.startsWith('База контрактов: '))
    expect(contractEvents.length).toBeLessThan(10)
    expect(result.rows[0].plan?.sourceCount).toBe(102)
    expect(result.rows[0].blueprint.source).toBe('owned-original')
    f.cache.close()
  })
  it('combines researched contract, own and market sources and compares actual one-run production profit', async () => {
    const f = fixture()
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue([{ contractId: 22, type: 'item_exchange', price: 1000, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' }])
    vi.mocked(f.esi.getPublicContractItems).mockResolvedValue([{ recordId: 1, typeId: 101, quantity: 1, included: true, copy: true, me: 0, te: 0, runs: 100 }])
    const progress = vi.fn()
    const result = await f.service.scan({ ...industryRequest, blueprintMode: 'combined', autoPlan: true }, progress)
    expect(result.rows[0].runs).toBe(1)
    expect(result.rows[0].blueprint.source).toBe('owned-original')
    expect(result.rows[0].plan?.sourceCount).toBe(3)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ rows: [expect.objectContaining({ runs: 1 })] }))
    expect(f.esi.getPublicContracts).toHaveBeenCalledTimes(1)
    f.cache.close()
  })
  it('refreshes old market and contract presence after slow indexing before final quotes', async () => {
    const f = fixture()
    let now = Date.parse('2026-10-03T10:00:00Z')
    const service = new IndustryService(f.account, f.esi, f.cache, industryCatalog, () => now)
    const orders = [industryOrder(34, 5), industryOrder(35, 20), industryOrder(100, 30, true), industryOrder(101, 100)]
    vi.mocked(f.esi.getMarketOrders).mockResolvedValueOnce({ orders, pages: 1, snapshotAt: '2026-10-03T09:59:00Z' }).mockResolvedValue({ orders: orders.map(o => o.typeId === 34 ? { ...o, price: 10 } : o), pages: 1, snapshotAt: '2026-10-03T10:05:00Z' })
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue([{ contractId: 22, type: 'item_exchange', price: 100, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' }])
    vi.mocked(f.esi.getPublicContractItems).mockImplementation(async () => { now += 360000; return [{ recordId: 1, typeId: 101, quantity: 1, included: true, copy: true, me: 0, te: 0, runs: 100 }] })
    const progress = vi.fn()
    const result = await service.scan({ ...industryRequest, blueprintMode: 'contracts', autoPlan: true }, progress)
    expect(f.esi.getMarketOrders).toHaveBeenCalledTimes(2)
    expect(f.esi.getPublicContracts).toHaveBeenCalledTimes(2)
    expect(result.marketFetchedAt).toBe('2026-10-03T10:05:00Z')
    expect(result.rows[0].materialCost).toBe(120)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('устаревшие цены') }))
    f.cache.close()
  })
  it('includes only ranged buy demand that can accept items at the selected station', () => {
    const topology = { factories: {}, systems: { 30000142: { name: 'Jita', security: 0.9, neighbors: [30000144] }, 30000144: { name: 'Perimeter', security: 0.9, neighbors: [30000142] } } }
    const remote = { locationId: 60000004, systemId: 30000144 }
    const orders = [industryOrder(100, 10, true), industryOrder(100, 11, true, 10, { ...remote, range: 'region' }), industryOrder(100, 12, true, 10, { ...remote, range: '1' }), industryOrder(100, 13, true, 10, { ...remote, range: 'station' }), industryOrder(100, 14, false, 10, { ...remote, range: 'region' }), industryOrder(100, 15, true, 10, { ...remote, range: 'solarsystem' })]
    expect(ordersAtIndustryHub(orders, getMarketHub('jita'), topology).map(o => o.price)).toEqual([10, 11, 12])
  })
  it('caches regional history, counts inactive calendar days, and never treats errors as zero demand', async () => {
    const f = fixture()
    const now = () => Date.parse('2026-10-03T10:00:00Z')
    const service = new IndustryService(f.account, f.esi, f.cache, industryCatalog, now)
    vi.mocked(f.esi.getMarketHistory).mockResolvedValue({ lastModified: '2026-10-02T11:05:00Z', expiresAt: '2026-10-04T11:05:00Z', points: [{ date: '2026-09-15', volume: 1, orderCount: 1, average: 30, highest: 30, lowest: 30 }] })
    const request = { hubId: 'jita' as const, typeIds: [100, 100] }
    const result = await service.liquidity(request)
    expect(result).toHaveLength(1); expect(result[0].daily30).toBe(1 / 30)
    expect(result[0].through).toBe('2026-10-01')
    await service.liquidity(request)
    expect(f.esi.getMarketHistory).toHaveBeenCalledTimes(1)
    vi.mocked(f.esi.getMarketHistory).mockRejectedValue(new Error('offline'))
    expect(await service.liquidity({ ...request, typeIds: [34] })).toEqual([])
    expect(await service.liquidity({ ...request, typeIds: [34] })).toEqual([])
    expect(f.esi.getMarketHistory).toHaveBeenCalledTimes(3)
    await expect(service.liquidity({ ...request, typeIds: [0] })).rejects.toThrow('ликвидности')
    await expect(service.liquidity({ ...request, typeIds: Array(101).fill(100) })).rejects.toThrow('ликвидности')
    f.cache.close()
  })
  it('quotes exact deficits from only the requested direct Hangar, including in factory input snapshots', async () => {
    const f = fixture()
    vi.mocked(f.account.getAuthorizedSession).mockResolvedValue({ accessToken: 'private', session: { characterId: 90000001, characterName: 'Test', scopes: [...Object.values(INDUSTRY_SCOPES), 'esi-assets.read_assets.v1'] } })
    const asset = { itemId: 1, typeId: 34, quantity: 10, locationId: 60003760, locationType: 'station', locationFlag: 'Hangar', singleton: false }
    vi.mocked(f.esi.getAuthenticatedCharacterAssets).mockResolvedValue([asset, { ...asset, itemId: 2, quantity: 999, locationId: 60000004 }, { ...asset, itemId: 3, quantity: 999, locationType: 'item' }])
    const result = await f.service.scan({ ...industryRequest, stockLocationId: 60003760 })
    expect(result.rows[0].materials[0].stock).toMatchObject({ quantity: 10, locationId: 60003760, deficitFill: { requestedQuantity: 10, complete: true, total: 50 } })
    await expect(f.service.scan({ ...industryRequest, stockLocationId: 0 })).rejects.toThrow('место запасов')
    f.cache.close()
  })
  it('archives authorized wallet deals without exposing tokens and retains history on outage', async () => {
    const f = fixture()
    vi.mocked(f.account.getAuthorizedSession).mockResolvedValue({ accessToken: 'private-industry-token', session: { characterId: 901, characterName: 'Test', scopes: ['esi-wallet.read_character_wallet.v1'] } })
    vi.mocked(f.esi.getAuthenticatedCharacterWalletTransactions).mockResolvedValue([purchase])
    const ledger = await f.service.getLedger(true)
    expect(ledger.transactions[0]).toMatchObject({ typeName: 'Tritanium', quantity: 20, unitPrice: 2 })
    expect(JSON.stringify(ledger)).not.toContain('private-industry-token')
    vi.mocked(f.esi.getAuthenticatedCharacterWalletTransactions).mockRejectedValue(new Error('private-industry-token'))
    const fallback = await f.service.getLedger(true)
    expect(fallback.transactions).toHaveLength(1); expect(fallback.syncedAt).toBe(ledger.syncedAt)
    expect(fallback.warnings.join(' ')).toContain('ранее сохранённые')
    expect(JSON.stringify(fallback)).not.toContain('private-industry-token')
    f.cache.close()
  })
  it('does not fetch a wallet without scope or archive a response after character switch', async () => {
    const f = fixture()
    expect((await f.service.getLedger()).warnings.join(' ')).toContain('esi-wallet')
    expect(f.esi.getAuthenticatedCharacterWalletTransactions).not.toHaveBeenCalled()
    vi.mocked(f.account.getAuthorizedSession).mockResolvedValueOnce({ accessToken: 'private', session: { characterId: 901, characterName: 'Test', scopes: ['esi-wallet.read_character_wallet.v1'] } })
    vi.mocked(f.esi.getAuthenticatedCharacterWalletTransactions).mockImplementation(async () => { f.switchCharacter(); return [purchase] })
    await expect(f.service.getLedger()).rejects.toThrow('Персонаж изменился')
    expect(f.cache.getIndustryTransactions(901).transactions).toEqual([])
    f.cache.close()
  })
  it('retries truncated contract JSON but not semantic validation failures', async () => {
    const f = fixture()
    const broken = new EsiError('ESI request failed: Unexpected end of JSON input', null, { cause: new SyntaxError('Unexpected end of JSON input') })
    expect(isTransientIndustryError(broken)).toBe(true)
    expect(isTransientIndustryError(new EsiError('invalid contract ME'))).toBe(false)
    expect(isTransientIndustryError(new EsiError('busy', 503))).toBe(true)
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue([{ contractId: 22, type: 'item_exchange', price: 90, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' }])
    vi.mocked(f.esi.getPublicContractItems).mockRejectedValueOnce(broken).mockResolvedValue([{ recordId: 1, typeId: 101, quantity: 1, included: true, copy: true, me: 0, te: 0, runs: 10 }])
    const progress = vi.fn()
    expect((await f.service.scan({ ...industryRequest, blueprintMode: 'contracts' }, progress)).rows).toHaveLength(1)
    expect(f.esi.getPublicContractItems).toHaveBeenCalledTimes(2)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('не передал полный ответ') }))
    f.cache.close()
  })
  it('compares only confirmed nearby NPC factories, repricing material/time bonuses and enforcing character identity', async () => {
    const f = fixture()
    const topology = { systems: {
      30000142: { name: 'Jita', security: 0.9, neighbors: [30000144] },
      30000144: { name: 'Perimeter', security: 0.9, neighbors: [30000142] }
    }, factories: { 60000004: { name: 'Perimeter Factory', systemId: 30000144 } } }
    vi.mocked(f.esi.getIndustryFacilities).mockResolvedValue([{ facilityId: 60000004, systemId: 30000144 }, { facilityId: 999, systemId: 30000144 }])
    const service = new IndustryService(f.account, f.esi, f.cache, industryCatalog, Date.now, topology)
    const query = { scanId: industryRequest.scanId, blueprintTypeId: 101, originSystem: 'Jita', maxJumps: 10, highSecOnly: true }
    await expect(service.factories(query)).rejects.toThrow('Сначала завершите')
    const original = await service.scan({ ...industryRequest, materialReductionPercent: 50, timeReductionPercent: 50, jobCostReductionPercent: 50 })
    const found = await service.factories(query)
    expect(found.rows).toHaveLength(1); expect(found.rows[0].jumps).toBe(1)
    expect(found.rows[0].materialCost).toBeGreaterThan(original.rows[0].materialCost!)
    expect(found.rows[0].hours).toBeCloseTo(original.rows[0].hours * 2)
    expect(found.rows[0].installationCost).toBeGreaterThan(original.rows[0].installationCost!)
    expect(found.warnings.join(' ')).toContain('0.25%')
    await expect(service.factories({ ...query, maxJumps: 11 })).rejects.toThrow('Некорректный')
    await expect(service.factories({ ...query, brokerFeePercent: -1 })).rejects.toThrow('Брокерская')
    f.switchCharacter(); await expect(service.factories(query)).rejects.toThrow('Персонаж изменился')
    f.cache.close()
  })
  it('selects a contract with enough runs for the requested product quantity', async () => {
    const f = fixture()
    const contract = { contractId: 22, type: 'item_exchange', price: 2, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' }
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue([contract, { ...contract, contractId: 23, price: 100 }])
    vi.mocked(f.esi.getPublicContractItems).mockImplementation(async id => [{ recordId: 1, typeId: 101, quantity: 1, included: true, copy: true, me: 0, te: 0, runs: id === 22 ? 2 : 5 }])
    const result = await f.service.scan({ ...industryRequest, blueprintMode: 'contracts', productionQuantity: 25 })
    expect(result.rows[0].runs).toBe(3); expect(result.rows[0].outputQuantity).toBe(30)
    expect(result.rows[0].blueprint.contractId).toBe(23)
    expect(result.rows[0].blueprint.cost).toBe(60)
    f.cache.close()
  })
  it('finds contract-only recipes, reads actual copy metadata, excludes auctions and requested-item swaps, and streams early quotes', async () => {
    const f = fixture()
    const contract = { contractId: 22, type: 'item_exchange', price: 90, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' }
    const item = { recordId: 1, typeId: 101, quantity: 1, included: true, copy: true, me: 10, te: 20, runs: 10 }
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue([contract, { ...contract, contractId: 23, type: 'auction' }])
    vi.mocked(f.esi.getPublicContractItems).mockResolvedValue([item])
    const service = new IndustryService(f.account, f.esi, f.cache, { ...industryCatalog, blueprints: [{ ...industryCatalog.blueprints[0], marketable: false }] })
    const progress = vi.fn()
    const result = await service.scan({ ...industryRequest, blueprintMode: 'contracts' }, progress)
    expect(result.rows).toHaveLength(1); expect(result.rows[0].blueprint).toMatchObject({ contractId: 22, source: 'contract-copy', me: 10, te: 20 })
    expect(f.esi.getPublicContractItems).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'market', rows: [expect.objectContaining({ blueprintTypeId: 101 })] }))
    expect(contractBlueprintOffer(contract, item, [item, { ...item, included: false }])).toBeNull()
    expect(contractBlueprintOffer(contract, { ...item, me: null }, [item])).toBeNull()
    expect(contractBlueprintOffer(contract, { ...item, copy: null, runs: -1 }, [item])?.copy).toBe(false)
    expect(INDUSTRY_CATALOG.blueprints.find(r => r.blueprintTypeId === 33701)).toMatchObject({ productName: "'Packrat' Mobile Tractor Unit", marketable: false })
    await service.scan({ ...industryRequest, blueprintMode: 'contracts', forceRefresh: true })
    expect(f.esi.getPublicContractItems).toHaveBeenCalledTimes(1)
    f.cache.close()
  })
  it('cancels indexing and resumes with already saved contract contents', async () => {
    const f = fixture(); const controller = new AbortController()
    const contract = { contractId: 22, type: 'item_exchange', price: 90, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' }
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue([contract])
    vi.mocked(f.esi.getPublicContractItems).mockResolvedValue([{ recordId: 1, typeId: 101, quantity: 1, included: true, copy: true, me: 0, te: 0, runs: 10 }])
    await expect(f.service.scan({ ...industryRequest, blueprintMode: 'contracts' }, progress => {
      if (progress.rows?.length) controller.abort()
    }, controller.signal)).rejects.toThrow('Сканирование остановлено')
    await expect(f.service.scan({ ...industryRequest, blueprintMode: 'contracts' })).resolves.toHaveProperty('rows')
    expect(f.esi.getPublicContractItems).toHaveBeenCalledTimes(1); f.cache.close()
  })
  it('does not mark a partially indexed failed contract region as a successful scan', async () => {
    const f = fixture()
    vi.mocked(f.esi.getPublicContracts).mockResolvedValue([{ contractId: 22, type: 'item_exchange', price: 90, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '' }])
    vi.mocked(f.esi.getPublicContractItems).mockRejectedValue(new Error('network failed'))
    await expect(f.service.scan({ ...industryRequest, blueprintMode: 'contracts' })).rejects.toThrow('network failed')
    f.cache.close()
  })
  it('only counts material stacks in directly available personal hangars', () => {
    const base = { itemId: 1, typeId: 34, quantity: 10, locationId: 60003760, locationType: 'station', locationFlag: 'Hangar', singleton: false }
    expect(availableHangarStock([base, { ...base, itemId: 2, quantity: 5 }, { ...base, itemId: 3, locationFlag: 'Cargo' }, { ...base, itemId: 4, locationType: 'item' }, { ...base, itemId: 5, singleton: true }])).toEqual([{ typeId: 34, locationId: 60003760, quantity: 15 }])
  })
  it('loads one complete regional book, streams rows, caches it, and never leaks SSO tokens', async () => {
    const f = fixture(); const progress = vi.fn()
    const result = await f.service.scan(industryRequest, progress)
    expect(result.rows).toHaveLength(1); expect(result.rows[0].marketReady).toBe(true)
    expect(f.esi.getMarketOrders).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'calculating', rows: expect.any(Array) }))
    expect(JSON.stringify(result)).not.toContain('secret-must-not-leak')
    await f.service.scan({ ...industryRequest, scanId: 'second' })
    expect(f.esi.getMarketOrders).toHaveBeenCalledTimes(1)
    await f.service.scan({ ...industryRequest, forceRefresh: true })
    expect(f.esi.getMarketOrders).toHaveBeenCalledTimes(2)
    f.cache.close()
  })
  it('rejects missing/failed skill data instead of treating the character as skill zero', async () => {
    const f = fixture()
    f.account.getAuthorizedSession.mockImplementation(async () => ({ accessToken: 'secret-must-not-leak', session: { characterId: 90000001, characterName: 'Industrialist', scopes: [] } }))
    const snapshot = await f.service.getCharacter()
    expect(snapshot.skills).toBeNull(); expect(snapshot.missingScopes).toContain(INDUSTRY_SCOPES.skills)
    expect(f.esi.getAuthenticatedCharacterSkills).not.toHaveBeenCalled()
    await expect(f.service.scan(industryRequest)).rejects.toThrow(INDUSTRY_SCOPES.skills)
    expect(f.esi.getMarketOrders).not.toHaveBeenCalled(); f.cache.close()
  })
  it('fails a scan on incomplete market data and never caches that failure', async () => {
    const f = fixture()
    vi.mocked(f.esi.getMarketOrders).mockRejectedValueOnce(new Error('page failed'))
    await expect(f.service.scan(industryRequest)).rejects.toThrow('page failed')
    await expect(f.service.scan(industryRequest)).resolves.toHaveProperty('rows')
    expect(f.esi.getMarketOrders).toHaveBeenCalledTimes(2); f.cache.close()
  })
  it('does not return private results after switching character during load', async () => {
    const f = fixture()
    vi.mocked(f.esi.getMarketOrders).mockImplementationOnce(async () => { f.switchCharacter(); return { orders: [], pages: 1 } })
    await expect(f.service.scan(industryRequest)).rejects.toThrow('Персонаж изменился'); f.cache.close()
  })
  it('chooses a real usable owned copy, not fictional combined ME/TE', async () => {
    const f = fixture()
    vi.mocked(f.esi.getAuthenticatedCharacterBlueprints).mockResolvedValue([
      { ...ownIndustryBlueprint, itemId: 1, quantity: -2, runs: 1 },
      { ...ownIndustryBlueprint, itemId: 2, materialEfficiency: 5, timeEfficiency: 10 }
    ])
    const result = await f.service.scan({ ...industryRequest, blueprintMode: 'owned' })
    expect(result.rows[0].blueprint).toMatchObject({ itemId: 2, me: 5, te: 10, source: 'owned-original' })
    f.cache.close()
  })
  it('skips oversized recipes without losing valid smaller manufacturing candidates', async () => {
    const f = fixture()
    const catalog = { ...industryCatalog, blueprints: [...industryCatalog.blueprints, { ...industryCatalog.blueprints[0], blueprintTypeId: 102, materials: [{ typeId: 34, quantity: 2147483647 }] }] }
    const service = new IndustryService(f.account, f.esi, f.cache, catalog)
    const result = await service.scan(industryRequest)
    expect(result.rows).toHaveLength(1)
    expect(result.warnings.some(w => w.includes('Пропущено 1'))).toBe(true)
    f.cache.close()
  })
  it('bundles real CCP recipes and skill modifiers rather than placeholder prices', () => {
    expect(INDUSTRY_CATALOG.build).toBe(3561556)
    expect(INDUSTRY_CATALOG.blueprints.length).toBeGreaterThan(4000)
    expect(INDUSTRY_CATALOG.skills[3380].timeBonus).toBe(-4)
    expect(INDUSTRY_CATALOG.skills[3388].timeBonus).toBe(-3)
    expect(INDUSTRY_CATALOG.blueprints.find(r => r.productName === 'Venture')).toBeDefined()
  })
})
