import type { MarketComparisonRequest, MarketHubComparison, MarketHubQuote } from '../../shared/market'

/** Two public price reads at a time; identical output batches share one quote. */
export class ProductionMarketQuoteQueue {
  private active = 0
  private queue: Array<() => void> = []
  private pending = new Map<string, Promise<MarketHubQuote>>()
  private cached = new Map<string, { quote: MarketHubQuote; until: number }>()
  constructor(private readonly compare: (request: MarketComparisonRequest) => Promise<MarketHubComparison>, private readonly now: () => number = Date.now) {}
  request(typeId: number, quantity: number, forceRefresh = false): Promise<MarketHubQuote> {
    const key = `${typeId}:${quantity}`, taskKey = `${key}:${forceRefresh}`
    const hit = this.cached.get(key)
    if (!forceRefresh && hit && hit.until > this.now()) return Promise.resolve(hit.quote)
    const existing = this.pending.get(taskKey)
    if (existing) return existing
    const task = new Promise<MarketHubQuote>((resolve, reject) => {
      this.queue.push(() => {
        this.active++
        void this.compare({ typeId, quantity, hubIds: ['jita'], includeHistory: false, includeDepth: true, forceRefresh }).then(result => {
          const quote = result.quotes.find(q => q.hub.id === 'jita' && q.typeId === typeId && q.quantity === quantity)
          if (!quote) throw new Error('ESI не вернул оценку этой партии в Jita')
          const expiry = Date.parse(quote.expiresAt ?? '')
          this.cached.delete(key)
          this.cached.set(key, { quote, until: Math.min(this.now() + 300000, Number.isFinite(expiry) ? expiry : this.now() + 300000) })
          if (this.cached.size > 128) this.cached.delete(this.cached.keys().next().value!)
          return quote
        }).then(quote => { this.pending.delete(taskKey); this.active--; this.pump(); resolve(quote) }, error => { this.pending.delete(taskKey); this.active--; this.pump(); reject(error) })
      })
    })
    this.pending.set(taskKey, task); this.pump()
    return task
  }
  private pump(): void { while (this.active < 2 && this.queue.length) this.queue.shift()!() }
}
