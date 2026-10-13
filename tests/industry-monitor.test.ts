import { describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { IndustryMonitorService } from '../src/main/industry-monitor-service'
import { DEFAULT_INDUSTRY_MONITOR, industryMonitorDeal, validateIndustryMonitor } from '../src/shared/industry-monitor'
import { planIndustryOpportunity } from '../src/shared/industry-planning'
import type { IndustryScanProgress, IndustryScanResult, IndustryScanRequest } from '../src/shared/industry'
import { parseNativeAlertRequest } from '../src/main/native-alert-ipc'
import { industryCatalog as catalog, industryRecipe as recipe, industryRequest as request, industrySkills as skills, industryOrder as order } from './industry-fixtures'

const now = Date.parse('2026-10-10T10:00:00Z')
const config = { ...DEFAULT_INDUSTRY_MONITOR, enabled: true, minimumProfit: 0, minimumMargin: 0 }
function row() {
  return { ...planIndustryOpportunity({ recipe, catalog, request: { ...request, blueprintMode: 'contracts' }, skills, systemCostIndex: 0.1,
    contractBlueprint: { contractId: 22, typeId: 101, price: 100, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '', copy: true, me: 0, te: 0, runs: 10, bundled: false },
    buyOrders: new Map([[34, [order(34, 5)]], [35, [order(35, 20)]]]), sellOrders: new Map([[100, [order(100, 30, true)]]]), blueprintOrders: new Map(), adjustedPrices: new Map([[34, 4], [35, 15]]) }), marketSnapshotAt: new Date(now).toISOString() }
}
function fixture() {
  const cache = new Cache(':memory:')
  let time = now, id: number | null = 901
  const scan = vi.fn(async (_r: IndustryScanRequest, progress?: (p: IndustryScanProgress) => void) => {
    const r = row(); r.marketSnapshotAt = new Date(time).toISOString()
    progress?.({ scanId: 'test', characterId: id!, stage: 'calculating', completed: 1, total: 1, message: 'ready', rows: [r] })
    return { characterId: id, rows: [r] } as IndustryScanResult
  })
  const notify = vi.fn(() => true)
  const monitor = new IndustryMonitorService({ scan }, cache, async () => id, notify, () => time)
  return { cache, scan, notify, monitor, advance: () => { time += 600000 }, switchTo: (value: number | null) => { id = value } }
}
describe('background BPC monitoring', () => {
  it('forces purchased BPC/full-market BUY and validates bounded options', () => {
    const c = validateIndustryMonitor({ ...config, request: { ...DEFAULT_INDUSTRY_MONITOR.request, blueprintMode: 'combined', contractCopiesOnly: false, salesMode: 'sell', stockLocationId: 123 } })
    expect(c.request).toMatchObject({ blueprintMode: 'contracts', contractCopiesOnly: true, salesMode: 'buy', autoPlan: false, runs: 1 })
    expect(c.request.stockLocationId).toBeUndefined()
    expect(() => validateIndustryMonitor({ ...config, intervalMinutes: 1 })).toThrow()
    expect(() => validateIndustryMonitor({ ...config, minimumProfit: NaN })).toThrow()
    expect(() => validateIndustryMonitor({ ...config, token: 'secret' })).toThrow()
  })
  it('requires real matching BUY and fresh market prices, excluding own copies', () => {
    expect(industryMonitorDeal(row(), config, now)?.exceptional).toBe(true)
    expect(industryMonitorDeal(row(), config, now + 600001)).toBeNull()
    expect(industryMonitorDeal({ ...row(), blueprint: { ...row().blueprint, source: 'owned-copy' } }, config, now)).toBeNull()
    expect(industryMonitorDeal({ ...row(), plan: undefined, outputFill: { ...row().outputFill, complete: false } }, config, now)).toBeNull()
    const deal = industryMonitorDeal(row(), config, now)!
    expect(deal.runs).toBe(1)
    expect(industryMonitorDeal({ ...row(), runs: 2 }, config, now)).toBeNull()
    expect(deal.row.runs).toBe(deal.runs)
    expect(deal.row.outputQuantity).toBe(deal.quantity)
    expect(deal.capital).toBeGreaterThan(deal.contractPrice)
  })
  it('runs while enabled, spaces cycles and persists duplicate suppression across restart/cache clear', async () => {
    const f = fixture()
    await f.monitor.configure(config)
    await vi.waitFor(async () => expect((await f.monitor.snapshot()).lastCompleted).not.toBeNull())
    expect(f.notify).toHaveBeenCalledTimes(1)
    await f.monitor.tick(); expect(f.scan).toHaveBeenCalledTimes(1)
    f.advance(); await f.monitor.tick(); expect(f.scan).toHaveBeenCalledTimes(2); expect(f.notify).toHaveBeenCalledTimes(1)
    f.monitor.stop(); f.cache.clear()
    const restarted = new IndustryMonitorService({ scan: f.scan }, f.cache, async () => 901, f.notify, () => now + 1200000)
    await restarted.tick()
    expect(f.notify).toHaveBeenCalledTimes(1)
    restarted.stop(); f.cache.close()
  })
  it('does not notify with the switch off and keeps profitable results below alert thresholds', async () => {
    const f = fixture()
    await f.monitor.configure({ ...config, notifications: false, minimumProfit: 1e12 })
    await vi.waitFor(async () => expect((await f.monitor.snapshot()).lastCompleted).not.toBeNull())
    expect(f.notify).not.toHaveBeenCalled()
    expect((await f.monitor.snapshot()).deals).toHaveLength(1)
    expect((await f.monitor.snapshot()).deals[0].exceptional).toBe(false)
    await f.monitor.configure({ ...config, enabled: false })
    f.advance(); await f.monitor.tick(); expect(f.scan).toHaveBeenCalledTimes(1)
    f.monitor.stop(); f.cache.close()
  })
  it('aborts on disable or identity change and never overlaps scans or leaks old-character alerts', async () => {
    const f = fixture()
    let release!: (r: IndustryScanResult) => void
    let signal!: AbortSignal
    let progress!: (p: IndustryScanProgress) => void
    f.scan.mockImplementation((_r, callback, ...rest: unknown[]) => {
      progress = callback!; signal = rest[0] as AbortSignal
      return new Promise(resolve => { release = resolve })
    })
    await f.monitor.configure(config)
    await vi.waitFor(() => expect(f.scan).toHaveBeenCalledTimes(1))
    await f.monitor.tick(); expect(f.scan).toHaveBeenCalledTimes(1)
    f.switchTo(902); await f.monitor.snapshot(); expect(signal.aborted).toBe(true)
    progress({ scanId: 'old', characterId: 901, stage: 'calculating', completed: 1, total: 1, message: 'old', rows: [row()] })
    release({ characterId: 901, rows: [row()] } as IndustryScanResult)
    await vi.waitFor(async () => expect((await f.monitor.snapshot()).characterId).toBe(902))
    expect(f.notify).not.toHaveBeenCalled()
    expect((await f.monitor.snapshot()).deals).toEqual([])
    expect((await f.monitor.snapshot()).config.enabled).toBe(false)
    f.monitor.stop(); f.cache.close()
  })
  it('preserves partial results on failure and schedules a bounded retry', async () => {
    const f = fixture()
    f.scan.mockImplementation(async (_r, progress) => {
      progress?.({ scanId: 'test', characterId: 901, stage: 'calculating', completed: 1, total: 2, message: 'part', rows: [row()] })
      await new Promise(resolve => setTimeout(resolve, 1))
      throw new Error('ESI offline')
    })
    await f.monitor.configure(config)
    await vi.waitFor(async () => expect((await f.monitor.snapshot()).error).toBe('ESI offline'))
    expect((await f.monitor.snapshot()).deals).toHaveLength(1)
    expect((await f.monitor.snapshot()).nextCheck).not.toBeNull()
    f.monitor.stop(); f.cache.close()
  })
  it('allows notification activation only in the known Industry workspace', () => {
    expect(parseNativeAlertRequest({ title: 'BPC', body: 'Profit', kind: 'info', workspace: 'industry' }).workspace).toBe('industry')
    expect(() => parseNativeAlertRequest({ title: 'BPC', body: 'Profit', kind: 'info', workspace: 'https://evil.test' })).toThrow(TypeError)
  })
  it('immediately aborts a running cycle when switched off and ignores its later progress', async () => {
    const f = fixture()
    let release!: (r: IndustryScanResult) => void
    let signal!: AbortSignal
    let progress!: (p: IndustryScanProgress) => void
    f.scan.mockImplementation((_r, callback, ...rest: unknown[]) => { progress = callback!; signal = rest[0] as AbortSignal; return new Promise(resolve => { release = resolve }) })
    await f.monitor.configure(config)
    await vi.waitFor(() => expect(f.scan).toHaveBeenCalledTimes(1))
    await f.monitor.configure({ ...config, enabled: false })
    expect(signal.aborted).toBe(true)
    progress({ scanId: 'stopped', characterId: 901, stage: 'calculating', completed: 1, total: 1, message: 'old', rows: [row()] })
    release({ characterId: 901, rows: [row()] } as IndustryScanResult)
    await vi.waitFor(async () => expect((await f.monitor.snapshot()).running).toBe(false))
    expect(f.notify).not.toHaveBeenCalled()
    expect((await f.monitor.snapshot()).deals).toEqual([])
    f.monitor.stop(); f.cache.close()
  })
  it('bounds notification bursts without marking unshown contracts as delivered', async () => {
    const f = fixture()
    const rows = Array.from({ length: 8 }, (_, i) => ({ ...row(), blueprintTypeId: i + 1, blueprint: { ...row().blueprint, contractId: 100 + i } }))
    f.scan.mockImplementation(async () => ({ characterId: 901, rows } as IndustryScanResult))
    await f.monitor.configure(config)
    await vi.waitFor(async () => expect((await f.monitor.snapshot()).lastCompleted).not.toBeNull())
    expect(f.notify).toHaveBeenCalledTimes(5)
    expect(f.cache.getIndustryRecords(901, 'monitor-seen')).toHaveLength(5)
    f.monitor.stop(); f.cache.close()
  })
})
