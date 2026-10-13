export const MARKET_HUBS = [
  {
    id: 'jita',
    name: 'Jita',
    stationName: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
    stationId: 60_003_760,
    solarSystemId: 30_000_142,
    regionId: 10_000_002
  },
  {
    id: 'amarr',
    name: 'Amarr',
    stationName: 'Amarr VIII (Oris) - Emperor Family Academy',
    stationId: 60_008_494,
    solarSystemId: 30_002_187,
    regionId: 10_000_043
  },
  {
    id: 'dodixie',
    name: 'Dodixie',
    stationName: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant',
    stationId: 60_011_866,
    solarSystemId: 30_002_659,
    regionId: 10_000_032
  },
  {
    id: 'rens',
    name: 'Rens',
    stationName: 'Rens VI - Moon 8 - Brutor Tribe Treasury',
    stationId: 60_004_588,
    solarSystemId: 30_002_510,
    regionId: 10_000_030
  },
  {
    id: 'hek',
    name: 'Hek',
    stationName: 'Hek VIII - Moon 12 - Boundless Creation Factory',
    stationId: 60_005_686,
    solarSystemId: 30_002_053,
    regionId: 10_000_042
  }
] as const

export type MarketHubId = (typeof MARKET_HUBS)[number]['id']
export type MarketHub = (typeof MARKET_HUBS)[number]

export interface MarketOrder {
  orderId: number
  typeId: number
  locationId: number
  systemId: number
  isBuyOrder: boolean
  price: number
  volumeRemain: number
  volumeTotal: number
  minVolume: number
  issued: string
  durationDays: number | null
  range: string
}

export interface MarketHistoryPoint {
  date: string
  average: number
  highest: number
  lowest: number
  orderCount: number
  volume: number
}

export interface MarketDepthLevel {
  price: number
  quantity: number
  orderCount: number
}
export interface MarketOrderBookDepth { buy: MarketDepthLevel[]; sell: MarketDepthLevel[] }

export interface MarketFill {
  requestedQuantity: number
  filledQuantity: number
  missingQuantity: number
  total: number
  averagePrice: number | null
  complete: boolean
  ordersUsed: number
  levels: MarketDepthLevel[]
  /** Industry one-shot limit: every matched unit trades at this submitted price. */
  orderLimitPrice?: number
}

export interface MarketBookSummary {
  bestBuy: number | null
  bestSell: number | null
  spread: number | null
  spreadPercent: number | null
  buyOrderCount: number
  sellOrderCount: number
  buyVolume: number
  sellVolume: number
  immediateBuy: MarketFill
  immediateSell: MarketFill
}

export interface MarketHistorySummary {
  days: number
  points: number
  volume: number
  orderCount: number
  lowest: number | null
  highest: number | null
  weightedAverage: number | null
}

export interface MarketTypeSearchMatch {
  typeId: number
  name: string
  exact: boolean
}

export interface MarketQuoteHistory {
  points: MarketHistoryPoint[]
  sevenDays: MarketHistorySummary
  thirtyDays: MarketHistorySummary
  cached: boolean
}

export interface MarketHubQuote {
  hub: MarketHub
  typeId: number
  quantity: number
  book: MarketBookSummary
  regionalOrderCount: number
  stationOrderCount: number
  history: MarketQuoteHistory | null
  cached: boolean
  fetchedAt: string
  snapshotAt?: string
  expiresAt?: string
  depth?: MarketOrderBookDepth
}

export interface MarketHubComparison {
  typeId: number
  quantity: number
  quotes: MarketHubQuote[]
  cached: boolean
  fetchedAt: string
}

export interface MarketAppraisalItem {
  inputName: string
  name: string
  typeId: number
  quantity: number
  sourceLines: number[]
  quotes: MarketHubQuote[]
}

export interface UnresolvedMarketAppraisalItem {
  inputName: string
  quantity: number
  sourceLines: number[]
  reason: 'not-found'
}

export interface MarketAppraisalHubTotal {
  hub: MarketHub
  immediateBuyTotal: number
  immediateSellTotal: number
  incompleteBuyItems: number
  incompleteSellItems: number
}

export interface MarketAppraisal {
  items: MarketAppraisalItem[]
  unresolved: UnresolvedMarketAppraisalItem[]
  totals: MarketAppraisalHubTotal[]
  ignoredLineCount: number
  warnings: string[]
  cached: boolean
  fetchedAt: string
}

export interface MarketQuoteRequest {
  typeId: number
  hubId: MarketHubId
  quantity?: number
  includeHistory?: boolean
  includeDepth?: boolean
  forceRefresh?: boolean
}

export interface MarketComparisonRequest {
  typeId: number
  quantity?: number
  hubIds?: MarketHubId[]
  includeHistory?: boolean
  includeDepth?: boolean
  forceRefresh?: boolean
}

export interface MarketAppraisalRequest {
  text: string
  hubIds?: MarketHubId[]
  forceRefresh?: boolean
}

export interface ParsedMarketItem {
  name: string
  quantity: number
  sourceLines: number[]
}

export interface MarketTextParseResult {
  items: ParsedMarketItem[]
  ignoredLineCount: number
  warnings: string[]
}

export const MAX_MARKET_TEXT_LENGTH = 100_000
export const MAX_MARKET_TEXT_LINES = 2_000
export const MAX_MARKET_ITEMS = 500
export const MAX_MARKET_QUANTITY = 2_147_483_647

/** Returns one of the five supported hubs without accepting arbitrary locations. */
export function getMarketHub(hubId: MarketHubId): MarketHub {
  const hub = MARKET_HUBS.find((entry) => entry.id === hubId)
  if (!hub) throw new TypeError('Unknown market hub')
  return hub
}

export function isMarketHubId(value: unknown): value is MarketHubId {
  return typeof value === 'string' && MARKET_HUBS.some((hub) => hub.id === value)
}

/**
 * Parses EVE inventory/multibuy rows and common EFT lines.
 * Supported quantities include `Item<TAB>10`, `Item x10` and `10 x Item`.
 * Plain EFT module lines default to one item; repeated names are aggregated.
 */
export function parseMarketText(text: string): MarketTextParseResult {
  if (typeof text !== 'string') throw new TypeError('Item list must be text')
  if (text.length > MAX_MARKET_TEXT_LENGTH) {
    throw new RangeError(`Item list exceeds ${MAX_MARKET_TEXT_LENGTH} characters`)
  }
  if (text.includes('\0')) throw new TypeError('Item list contains a forbidden character')

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length > MAX_MARKET_TEXT_LINES) {
    throw new RangeError(`Item list contains more than ${MAX_MARKET_TEXT_LINES} rows`)
  }

  const aggregated = new Map<string, ParsedMarketItem>()
  const warnings: string[] = []
  let ignoredLineCount = 0

  const add = (rawName: string, quantity: number, lineNumber: number): void => {
    const name = normalizeMarketItemInput(rawName)
    if (!name) {
      ignoredLineCount += 1
      return
    }
    if (name.length > 128) {
      warnings.push(`Row ${lineNumber}: item name is too long`)
      ignoredLineCount += 1
      return
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_MARKET_QUANTITY) {
      warnings.push(`Row ${lineNumber}: invalid quantity`)
      ignoredLineCount += 1
      return
    }

    const key = normalizeLookupName(name)
    const existing = aggregated.get(key)
    const combined = (existing?.quantity ?? 0) + quantity
    if (combined > MAX_MARKET_QUANTITY) {
      throw new RangeError(`Total quantity of “${name}” is too large`)
    }
    if (existing) {
      existing.quantity = combined
      if (!existing.sourceLines.includes(lineNumber)) existing.sourceLines.push(lineNumber)
    } else {
      if (aggregated.size >= MAX_MARKET_ITEMS) {
        throw new RangeError(`List contains more than ${MAX_MARKET_ITEMS} distinct items`)
      }
      aggregated.set(key, { name, quantity, sourceLines: [lineNumber] })
    }
  }

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1
    const line = rawLine.trim()
    if (!line || isIgnoredEftLine(line) || isTableHeader(line)) {
      ignoredLineCount += 1
      return
    }

    const fitHeader = /^\[\s*([^,\]]+)\s*,[^\]]+\]$/.exec(line)
    if (fitHeader) {
      add(fitHeader[1], 1, lineNumber)
      return
    }

    const tabColumns = rawLine.split('\t').map((part) => part.trim())
    if (tabColumns.length > 1) {
      const quantity = parseQuantity(tabColumns[1])
      if (quantity !== null) {
        add(tabColumns[0], quantity, lineNumber)
      } else {
        warnings.push(`Row ${lineNumber}: invalid quantity`)
        ignoredLineCount += 1
      }
      return
    }

    const trailingQuantity = /^(.+?)\s+[x×]\s*([\d\s,.'’]+)$/i.exec(line)
    if (trailingQuantity) {
      const quantity = parseQuantity(trailingQuantity[2])
      if (quantity === null) {
        warnings.push(`Row ${lineNumber}: invalid quantity`)
        ignoredLineCount += 1
      } else {
        add(trailingQuantity[1], quantity, lineNumber)
      }
      return
    }

    const leadingQuantity = /^([\d\s,.'’]+)\s*[x×]\s+(.+)$/i.exec(line)
    if (leadingQuantity) {
      const quantity = parseQuantity(leadingQuantity[1])
      if (quantity === null) {
        warnings.push(`Row ${lineNumber}: invalid quantity`)
        ignoredLineCount += 1
      } else {
        add(leadingQuantity[2], quantity, lineNumber)
      }
      return
    }

    // Multibuy and many appraisal tools also use `10 Tritanium` without an `x`.
    // Pure numeric prefixes are safe for common names such as `200mm AutoCannon`.
    const plainLeadingQuantity = /^([\d\s,.'’]+)\s+(.+)$/.exec(line)
    if (plainLeadingQuantity) {
      const quantity = parseQuantity(plainLeadingQuantity[1])
      if (quantity !== null) {
        add(plainLeadingQuantity[2], quantity, lineNumber)
        return
      }
    }

    // EFT represents a loaded charge as `Module, Charge`. Both are real items.
    const eftParts = line.split(',').map((part) => part.trim()).filter(Boolean)
    if (eftParts.length === 2) {
      add(eftParts[0], 1, lineNumber)
      add(eftParts[1], 1, lineNumber)
      return
    }

    add(line, 1, lineNumber)
  })

  return { items: [...aggregated.values()], ignoredLineCount, warnings }
}

/** Full price ladder, independent of the quantity requested for an execution quote. */
export function marketOrderBookDepth(orders: readonly MarketOrder[]): MarketOrderBookDepth {
  const unique = new Map(orders.filter(isUsableMarketOrder).map(o => [o.orderId, o]))
  const side = (buy: boolean): MarketDepthLevel[] => {
    const levels = new Map<number, MarketDepthLevel>()
    for (const o of unique.values()) if (o.isBuyOrder === buy) {
      const level = levels.get(o.price) ?? { price: o.price, quantity: 0, orderCount: 0 }
      level.quantity += o.volumeRemain; level.orderCount++; levels.set(o.price, level)
    }
    return [...levels.values()].sort((a, b) => buy ? b.price - a.price : a.price - b.price)
  }
  return { buy: side(true), sell: side(false) }
}

/** Calculates executable totals from exact-station orders, including incomplete depth. */
export function summarizeMarketBook(
  orders: readonly MarketOrder[],
  quantity: number
): MarketBookSummary {
  assertQuantity(quantity)
  const valid = orders.filter(isUsableMarketOrder)
  const buyOrders = valid.filter((order) => order.isBuyOrder)
  const sellOrders = valid.filter((order) => !order.isBuyOrder)
  const bestBuy = maxOrNull(buyOrders.map((order) => order.price))
  const bestSell = minOrNull(sellOrders.map((order) => order.price))
  const spread = bestBuy === null || bestSell === null ? null : bestSell - bestBuy
  const spreadPercent = spread === null || bestSell === null || bestSell === 0
    ? null
    : spread / bestSell * 100

  return {
    bestBuy,
    bestSell,
    spread,
    spreadPercent,
    buyOrderCount: buyOrders.length,
    sellOrderCount: sellOrders.length,
    buyVolume: sum(buyOrders.map((order) => order.volumeRemain)),
    sellVolume: sum(sellOrders.map((order) => order.volumeRemain)),
    immediateBuy: calculateMarketFill(sellOrders, quantity, 'ascending'),
    immediateSell: calculateMarketFill(buyOrders, quantity, 'descending')
  }
}

export function summarizeMarketHistory(
  points: readonly MarketHistoryPoint[],
  days: number
): MarketHistorySummary {
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new RangeError('History period must be from 1 to 365 days')
  }
  const selected = [...points]
    .filter(isUsableHistoryPoint)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-days)
  const volume = sum(selected.map((point) => point.volume))
  const weightedTotal = sum(selected.map((point) => point.average * point.volume))

  return {
    days,
    points: selected.length,
    volume,
    orderCount: sum(selected.map((point) => point.orderCount)),
    lowest: minOrNull(selected.map((point) => point.lowest)),
    highest: maxOrNull(selected.map((point) => point.highest)),
    weightedAverage: volume > 0 ? weightedTotal / volume : null
  }
}

export function normalizeMarketLookupName(name: string): string {
  return normalizeLookupName(name)
}

/**
 * EVE clipboard item labels can carry a decorative trailing `*` marker.
 * Strip only terminal ASCII/full-width stars; asterisks inside a real name stay intact.
 */
export function normalizeMarketItemInput(value: string): string {
  return normalizeItemName(value).replace(/(?:\s*[*＊])+$/u, '').trim()
}

function calculateMarketFill(
  orders: readonly MarketOrder[],
  requestedQuantity: number,
  direction: 'ascending' | 'descending'
): MarketFill {
  const sorted = [...orders].sort((left, right) =>
    direction === 'ascending'
      ? left.price - right.price || left.issued.localeCompare(right.issued)
      : right.price - left.price || left.issued.localeCompare(right.issued)
  )
  const levels: MarketDepthLevel[] = []
  let remaining = requestedQuantity
  let total = 0
  let ordersUsed = 0

  for (const order of sorted) {
    if (remaining <= 0) break
    const filled = Math.min(remaining, order.volumeRemain)
    // EVE will not execute less than an order's minimum volume.
    if (filled < Math.min(order.minVolume, order.volumeRemain)) continue
    total += filled * order.price
    remaining -= filled
    ordersUsed += 1

    const level = levels.at(-1)
    if (level && level.price === order.price) {
      level.quantity += filled
      level.orderCount += 1
    } else {
      levels.push({ price: order.price, quantity: filled, orderCount: 1 })
    }
  }

  const filledQuantity = requestedQuantity - remaining
  return {
    requestedQuantity,
    filledQuantity,
    missingQuantity: remaining,
    total,
    averagePrice: filledQuantity > 0 ? total / filledQuantity : null,
    complete: remaining === 0,
    ordersUsed,
    levels
  }
}

function isUsableMarketOrder(order: MarketOrder): boolean {
  return (
    Number.isSafeInteger(order.orderId) && order.orderId > 0 &&
    Number.isFinite(order.price) && order.price > 0 &&
    Number.isSafeInteger(order.volumeRemain) && order.volumeRemain > 0 &&
    Number.isSafeInteger(order.minVolume) && order.minVolume > 0
  )
}

function isUsableHistoryPoint(point: MarketHistoryPoint): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
    Number.isFinite(point.average) && point.average >= 0 &&
    Number.isFinite(point.highest) && point.highest >= 0 &&
    Number.isFinite(point.lowest) && point.lowest >= 0 &&
    Number.isSafeInteger(point.orderCount) && point.orderCount >= 0 &&
    Number.isSafeInteger(point.volume) && point.volume >= 0
  )
}

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_MARKET_QUANTITY) {
    throw new RangeError(`Quantity must be from 1 to ${MAX_MARKET_QUANTITY}`)
  }
}

function parseQuantity(raw: string): number | null {
  const value = raw.trim()
  if (!/^(?:\d+|\d{1,3}(?:[\s,.'’]\d{3})+)$/.test(value)) return null
  const parsed = Number(value.replace(/[\s,.'’]/g, ''))
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_MARKET_QUANTITY
    ? parsed
    : null
}

function normalizeItemName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeLookupName(value: string): string {
  return normalizeItemName(value).toLocaleLowerCase('en-US')
}

function isIgnoredEftLine(line: string): boolean {
  return (
    /^\[(?:empty|пусто)\s/i.test(line) ||
    /^(?:empty|пусто)\s+(?:high|med|low|rig|subsystem)/i.test(line) ||
    /^[-=]{3,}$/.test(line) ||
    /^(?:cargo|drone bay|fighter bay|implant set|карго|трюм дронов)\s*:?$/i.test(line)
  )
}

function isTableHeader(line: string): boolean {
  const normalized = normalizeLookupName(line).replace(/\s+/g, '')
  return (
    normalized === 'itemquantity' ||
    normalized === 'itemqty' ||
    normalized === 'namequantity' ||
    normalized === 'nameqty' ||
    normalized === 'предметколичество' ||
    normalized === 'предметкол-во' ||
    normalized === 'названиеколичество' ||
    normalized === 'названиекол-во'
  )
}

function minOrNull(values: readonly number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null
}

function maxOrNull(values: readonly number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
