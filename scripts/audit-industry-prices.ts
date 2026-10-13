/** Read-only public ESI audit. No character data, token, purchases or orders sent.
 * npx esbuild scripts/audit-industry-prices.ts --bundle --platform=node --format=esm --outfile=/tmp/fly-safe-price-audit.mjs
 * node /tmp/fly-safe-price-audit.mjs [blueprintTypeId]
 */
import catalogData from '../src/main/data/industry-catalog.json'
import { getMarketHub, summarizeMarketBook, type MarketOrder, type MarketHistoryPoint } from '../src/shared/market'
import { industryLimitFill, manufacturingQuantity, type IndustryCatalog } from '../src/shared/industry'
import { industryLiquidity } from '../src/shared/industry-planning'

const catalog = catalogData as IndustryCatalog
const blueprintId = Number(process.argv[2] ?? 33701)
const recipe = catalog.blueprints.find(r => r.blueprintTypeId === blueprintId)
if (!recipe) throw new Error('Unknown manufacturing blueprint')
const hub = getMarketHub('jita')
async function get(path: string): Promise<{ data: any; pages: number; modified: string | null; expires: string | null }> {
  const response = await fetch(`https://esi.evetech.net/latest${path}`, { headers: { 'User-Agent': 'Fly-Safe-public-price-audit', 'X-Compatibility-Date': '2026-09-01' }, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`ESI ${response.status}`)
  return { data: await response.json(), pages: Number(response.headers.get('x-pages') ?? 1), modified: response.headers.get('last-modified'), expires: response.headers.get('expires') }
}
async function orders(typeId: number): Promise<{ rows: MarketOrder[]; modified: string | null; expires: string | null }> {
  const path = `/markets/${hub.regionId}/orders/?order_type=all&type_id=${typeId}`
  const first = await get(`${path}&page=1`), raw = [...first.data]
  if (first.pages > 50) throw new Error('Unexpected audit page count')
  for (let page = 2; page <= first.pages; page++) raw.push(...(await get(`${path}&page=${page}`)).data)
  const rows: MarketOrder[] = [...new Map<number, any>(raw.map(o => [o.order_id, o])).values()].filter(o => o.location_id === hub.stationId).map(o => ({ orderId: o.order_id, typeId: o.type_id, locationId: o.location_id, systemId: o.system_id, isBuyOrder: o.is_buy_order, price: o.price, volumeRemain: o.volume_remain, volumeTotal: o.volume_total, minVolume: o.min_volume, issued: o.issued, durationDays: o.duration, range: o.range }))
  return { rows, modified: first.modified, expires: first.expires }
}
const books = new Map<number, Awaited<ReturnType<typeof orders>>>()
for (const id of new Set([recipe.productTypeId, ...recipe.materials.map(m => m.typeId)])) books.set(id, await orders(id))
console.log(JSON.stringify({ product: recipe.productName, blueprintId, checkedAt: new Date().toISOString(), assumption: 'ME 0, Jita station orders only. No blueprint price or authenticated skills assumed.' }))
for (const runs of [1, 30, 100]) {
  const materials = recipe.materials.map(m => {
    const quantity = manufacturingQuantity(m.quantity, runs, 0, 0), book = books.get(m.typeId)!
    const depth = summarizeMarketBook(book.rows, quantity), limit = industryLimitFill(depth.immediateBuy, 'buy')
    return { typeId: m.typeId, name: catalog.types[m.typeId]?.name, quantity, bestAsk: depth.bestSell, limitAsk: limit.orderLimitPrice, complete: limit.complete, weightedCostBeforeFix: depth.immediateBuy.total, multibuyCost: limit.total, difference: limit.total - depth.immediateBuy.total, modified: book.modified }
  })
  const output = summarizeMarketBook(books.get(recipe.productTypeId)!.rows, recipe.productQuantity * runs)
  console.log(JSON.stringify({ runs, materials, materialCost: materials.every(m => m.complete) ? materials.reduce((s, m) => s + m.multibuyCost, 0) : null, buyRevenueAtDepth: output.immediateSell.total, buyRevenueAtSingleLimit: industryLimitFill(output.immediateSell, 'sell').total, buyComplete: output.immediateSell.complete, sellAsk: output.bestSell }))
}
const history = await get(`/markets/${hub.regionId}/history/?type_id=${recipe.productTypeId}`)
const modifiedDay = Math.floor(Date.parse(history.modified ?? new Date().toISOString()) / 86400000) * 86400000
const through = new Date(modifiedDay - 86400000).toISOString().slice(0, 10)
const points: MarketHistoryPoint[] = history.data.map((p: any) => ({ date: p.date, volume: p.volume, average: p.average, highest: p.highest, lowest: p.lowest, orderCount: p.order_count }))
console.log(JSON.stringify({ liquidity: industryLiquidity(recipe.productTypeId, hub.regionId, points, through, new Date().toISOString(), Date.now()), serverModified: history.modified }))
