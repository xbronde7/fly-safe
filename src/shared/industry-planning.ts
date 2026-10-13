import { calculateIndustryOpportunity, manufacturingQuantity, type IndustryOpportunity, type IndustryLiquidity } from './industry'
import { summarizeMarketBook, type MarketHistoryPoint, type MarketOrder } from './market'

type QuoteInput = Parameters<typeof calculateIndustryOpportunity>[0]

/** Re-quotes whole runs against the actual order depth, never scales a one-run price. */
export function planIndustryOpportunity(input: QuoteInput): IndustryOpportunity {
  const quote = (runs: number): IndustryOpportunity => calculateIndustryOpportunity({ ...input, request: { ...input.request, productionQuantity: undefined, runs } })
  const one = quote(1)
  const fullRuns = one.blueprint.availableRuns
  // Original blueprints are reusable, so their capacity is a bounded single job,
  // not an invented number of remaining runs. Avoid unsafe material quantities.
  const safeLimit = Math.min(100_000, Math.floor(2_147_483_647 / Math.max(input.recipe.productQuantity, ...input.recipe.materials.map(m => m.quantity))))
  const probe = quote(Math.max(1, Math.min(fullRuns ?? safeLimit, safeLimit)))
  const production = probe.maxProductionRuns > 0 ? quote(probe.maxProductionRuns) : null
  const immediate = probe.maxImmediateRuns > 0 ? quote(probe.maxImmediateRuns) : null
  const full = fullRuns !== null && fullRuns <= safeLimit ? quote(fullRuns) : null
  // A maximum-volume BUY batch may include joke bids. Check price-boundary
  // batches too, looking for net profit rather than merely executable volume.
  const candidates = new Set<number>([1, probe.maxImmediateRuns])
  const boundaries = (orders: readonly MarketOrder[], side: 'buy' | 'sell', quantity: (runs: number) => number): void => {
    const limit = probe.maxProductionRuns
    if (!limit) return
    const depth = summarizeMarketBook(orders, quantity(limit))[side === 'buy' ? 'immediateBuy' : 'immediateSell']
    let volume = 0
    for (const level of depth.levels) {
      volume += level.quantity
      let low = 0, high = limit
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (quantity(mid) <= volume) low = mid; else high = mid - 1 }
      if (low > 0) candidates.add(low)
      if (low > 1) candidates.add(low - 1)
      if (low < limit) candidates.add(low + 1)
    }
  }
  boundaries(input.sellOrders.get(input.recipe.productTypeId) ?? [], 'sell', runs => input.recipe.productQuantity * runs)
  for (const material of input.recipe.materials) boundaries(input.buyOrders.get(material.typeId) ?? [], 'buy', runs => manufacturingQuantity(material.quantity, runs, one.blueprint.me, input.request.materialReductionPercent))
  const sorted = [...candidates].filter(runs => runs > 0 && runs <= probe.maxProductionRuns).sort((a, b) => a - b)
  // Bounded CPU work even for pathological books; this is a profitable candidate,
  // not a claim of globally optimized production across all recipes/price points.
  const checked = sorted.length <= 256 ? sorted : [...new Set(Array.from({ length: 256 }, (_, i) => sorted[Math.floor(i * (sorted.length - 1) / 255)]))]
  let best: IndustryOpportunity | null = null
  let hourly: IndustryOpportunity | null = null
  for (const runs of checked) {
    const row = calculateIndustryOpportunity({ ...input, skipCapacity: true, request: { ...input.request, productionQuantity: undefined, salesMode: 'buy', runs } })
    if (row.productionReady && row.outputFill.complete && row.repeatProfit !== null && row.repeatProfit > (best?.repeatProfit ?? 0)) best = row
    if (row.productionReady && row.outputFill.complete && row.repeatProfit !== null && row.repeatProfit > 0 && row.hours > 0 &&
      (!hourly || row.repeatProfit / row.hours > hourly.repeatProfit! / hourly.hours ||
        row.repeatProfit / row.hours === hourly.repeatProfit! / hourly.hours && row.repeatProfit > hourly.repeatProfit!)) hourly = row
  }
  const profitableBuy = best ? quote(best.runs) : null
  const hourlyBuy = hourly ? hourly.runs === best?.runs ? profitableBuy : quote(hourly.runs) : null
  return { ...one, plan: { fullRuns, full, production, immediate, profitableBuy, hourlyBuy, sourceCount: 1 } }
}

/** Calendar days include zero-trade days; the unfinished/publication day is excluded. */
export function industryLiquidity(typeId: number, regionId: number, points: readonly MarketHistoryPoint[], through: string, fetchedAt: string, now: number): IndustryLiquidity {
  const end = Date.parse(`${through}T00:00:00Z`)
  const volumes = new Map(points.filter(p => p.date <= through).map(p => [p.date, p.volume]))
  let total7 = 0, total30 = 0, activeDays30 = 0
  for (let day = 0; day < 30; day++) {
    const volume = volumes.get(new Date(end - day * 86_400_000).toISOString().slice(0, 10)) ?? 0
    total30 += volume
    if (day < 7) total7 += volume
    if (volume > 0) activeDays30++
  }
  const lastTrade = [...volumes].filter(([, volume]) => volume > 0).map(([date]) => date).sort().at(-1) ?? null
  return { typeId, regionId, through, fetchedAt, daily7: total7 / 7, daily30: total30 / 30, volume30: total30, activeDays30, lastTrade, stale: now - end > 4 * 86_400_000 }
}
