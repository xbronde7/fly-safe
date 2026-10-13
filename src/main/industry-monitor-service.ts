import type { Cache } from './cache'
import type { IndustryService } from './industry-service'
import { DEFAULT_INDUSTRY_MONITOR, industryMonitorDeal, validateIndustryMonitor, type IndustryMonitorConfig, type IndustryMonitorDeal, type IndustryMonitorSnapshot } from '../shared/industry-monitor'

export class IndustryMonitorService {
  private state: IndustryMonitorSnapshot = { characterId: null, config: DEFAULT_INDUSTRY_MONITOR, running: false, lastStarted: null, lastCompleted: null, nextCheck: null, message: 'Монитор выключен', error: null, deals: [] }
  private timer: ReturnType<typeof setInterval> | null = null
  private controller: AbortController | null = null
  private cycle: Promise<void> | null = null
  private stopped = false
  private generation = 0
  constructor(private readonly service: Pick<IndustryService, 'scan'>, private readonly cache: Cache,
    private readonly identity: () => Promise<number | null>, private readonly notify: (deal: IndustryMonitorDeal, characterId: number) => boolean,
    private readonly now: () => number = Date.now) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => void this.tick().catch(() => {}), 15000)
    this.timer.unref?.()
    void this.tick().catch(() => {})
  }
  stop(): void { this.stopped = true; this.generation++; this.controller?.abort(); if (this.timer) clearInterval(this.timer); this.timer = null }
  private async refreshIdentity(): Promise<void> {
    const id = await this.identity()
    if (this.stopped || id === this.state.characterId) return
    this.generation++; this.controller?.abort()
    let config = DEFAULT_INDUSTRY_MONITOR
    if (id) {
      const saved = this.cache.getIndustryRecords<IndustryMonitorConfig>(id, 'monitor-config')[0]
      if (saved) { try { config = validateIndustryMonitor(saved.value) } catch {} }
    }
    this.state = { characterId: id, config, running: false, lastStarted: null, lastCompleted: null, nextCheck: null, message: id ? config.enabled ? 'Ожидаю проход' : 'Монитор выключен' : 'Войдите в EVE SSO', error: null, deals: [] }
  }
  async snapshot(): Promise<IndustryMonitorSnapshot> { await this.refreshIdentity(); return structuredClone(this.state) }
  async configure(value: unknown): Promise<IndustryMonitorSnapshot> {
    const config = validateIndustryMonitor(value)
    await this.refreshIdentity()
    if (!this.state.characterId) throw new Error('Войдите в EVE SSO')
    this.generation++; this.controller?.abort()
    this.cache.saveIndustryRecord(this.state.characterId, 'monitor-config', 'settings', config)
    this.state = { ...this.state, config, nextCheck: null, error: null, deals: [], message: config.enabled ? 'Монитор включён · ожидаю проход' : 'Монитор выключен' }
    void this.tick().catch(() => {})
    return structuredClone(this.state)
  }
  async tick(): Promise<void> {
    if (this.stopped) return
    await this.refreshIdentity()
    if (this.stopped || this.cycle || !this.state.characterId || !this.state.config.enabled || this.state.nextCheck && Date.parse(this.state.nextCheck) > this.now()) return
    const task = this.run()
    this.cycle = task
    try { await task } finally { if (this.cycle === task) this.cycle = null }
  }
  private async run(): Promise<void> {
    const characterId = this.state.characterId!, config = this.state.config, generation = this.generation
    const controller = new AbortController(); this.controller = controller
    const live = (): boolean => !this.stopped && !controller.signal.aborted && this.generation === generation && this.state.characterId === characterId
    this.state = { ...this.state, running: true, lastStarted: new Date(this.now()).toISOString(), nextCheck: null, error: null, deals: [], message: 'Проверяю BPC и рыночные ресурсы…' }
    const seen = new Set(this.cache.getIndustryRecords(characterId, 'monitor-seen').map(r => r.key))
    const found = new Map<number, IndustryMonitorDeal>()
    let notifications = 0
    let progressQueue = Promise.resolve()
    const accept = (rows: Parameters<typeof industryMonitorDeal>[0][]): void => {
      if (!live()) return
      for (const row of rows) {
        const deal = industryMonitorDeal(row, config, this.now())
        if (!deal) { found.delete(row.blueprintTypeId); continue }
        found.set(deal.blueprintTypeId, deal)
        if (deal.exceptional && config.notifications && notifications < 5 && !seen.has(String(deal.contractId))) {
          let shown = false
          try { shown = this.notify(deal, characterId) } catch {}
          if (shown && live()) { notifications++; seen.add(String(deal.contractId)); this.cache.saveIndustryRecord(characterId, 'monitor-seen', String(deal.contractId), { at: deal.foundAt }) }
        }
      }
      this.state.deals = [...found.values()].sort((a, b) => b.profit - a.profit).slice(0, 100)
    }
    try {
      const result = await this.service.scan({ ...config.request, scanId: `monitor_${this.now()}`, forceRefresh: false }, event => {
        if (!live() || event.characterId !== characterId) return
        this.state.message = event.message
        if (event.rows) {
          const rows = event.rows
          progressQueue = progressQueue.then(async () => {
            if (!live()) return
            await this.refreshIdentity()
            if (live()) accept(rows)
          }).catch(() => {})
        }
      }, controller.signal)
      await progressQueue
      await this.refreshIdentity()
      if (!live()) return
      if (result.characterId !== characterId) throw new Error('Персонаж изменился; монитор приостановлен')
      // Remove contracts that disappeared or stopped being profitable at final re-quote.
      found.clear(); accept(result.rows)
      this.state.lastCompleted = new Date(this.now()).toISOString()
      this.state.message = `Проход завершён · прибыльных BPC: ${found.size}`
    } catch (error) {
      if (live()) { this.state.error = error instanceof Error ? error.message : 'Ошибка ESI'; this.state.message = 'Проход не завершён · найденное предварительно, повторю позже' }
    } finally {
      if (live()) { this.state.running = false; this.state.nextCheck = new Date(this.now() + config.intervalMinutes * 60000).toISOString() }
      else if (!this.stopped && this.state.characterId === characterId) this.state.running = false
      if (this.controller === controller) this.controller = null
    }
  }
}
