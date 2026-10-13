export const PERSONAL_ECONOMY_SCOPES = [
  'esi-wallet.read_character_wallet.v1',
  'esi-markets.read_character_orders.v1',
  'esi-assets.read_assets.v1',
  'esi-universe.read_structures.v1'
] as const

export type PersonalEconomyScope = (typeof PERSONAL_ECONOMY_SCOPES)[number]

export interface EconomyTypeName {
  id: number
  name: string
}

export interface EconomyMarketPrice {
  typeId: number
  averagePrice: number | null
  adjustedPrice: number | null
}

export interface EconomyAssetRow {
  itemId: number
  typeId: number
  quantity: number
  locationId: number
  locationType: string
  locationFlag: string
  singleton: boolean
}

export interface EconomyAssetRootLocation {
  itemId: number
  locationId: number
  locationType: string
  unresolved: boolean
  structureCandidate: boolean
}

export interface EconomyAssetRootIds {
  publicLocationIds: number[]
  structureIds: number[]
}

export interface EconomyAssetLocationResolution {
  locationId: number
  locationType: string
  locationName: string | null
  unresolved: boolean
}

export interface EconomyAssetLocationDetail {
  locationId: number
  locationType: string
  locationName: string | null
  quantity: number
  stacks: number
  estimatedValue: number | null
  unresolved: boolean
}

export interface EconomyOrderRow {
  orderId: number
  typeId: number
  locationId: number
  regionId: number
  buyOrder: boolean
  price: number
  volumeRemain: number
  volumeTotal: number
  minVolume: number
  issued: string
  durationDays: number
  escrow: number
  state: 'open' | 'cancelled' | 'expired'
}

export interface EconomyTransactionRow {
  transactionId: number
  date: string
  typeId: number
  quantity: number
  unitPrice: number
  buy: boolean
  personal: boolean
  locationId: number
  clientId: number
}

export interface EconomyAssetTypeSummary {
  typeId: number
  typeName: string | null
  quantity: number
  stacks: number
  locations: number
  locationDetails: EconomyAssetLocationDetail[]
  averagePrice: number | null
  estimatedValue: number | null
}

export interface EconomyOrderView extends EconomyOrderRow {
  typeName: string | null
  grossRemaining: number
  expiresAt: string | null
}

export interface EconomyTransactionView extends EconomyTransactionRow {
  typeName: string | null
  gross: number
}

export interface PersonalEconomyInput {
  characterId: number
  grantedScopes: readonly string[]
  balance?: number | null
  assets?: readonly EconomyAssetRow[]
  orders?: readonly EconomyOrderRow[]
  orderHistory?: readonly EconomyOrderRow[]
  transactions?: readonly EconomyTransactionRow[]
  typeNames?: readonly EconomyTypeName[]
  marketPrices?: readonly EconomyMarketPrice[]
  assetLocationResolutions?: readonly EconomyAssetLocationResolution[]
  fetchedAt?: string
  warnings?: readonly string[]
}

export interface PersonalEconomySnapshot {
  characterId: number
  fetchedAt: string
  grantedScopes: string[]
  missingScopes: PersonalEconomyScope[]
  balance: number | null
  assets: {
    stackCount: number
    typeCount: number
    totalQuantity: number
    estimatedValue: number
    pricedTypeCount: number
    unpricedTypeCount: number
    coverage: number
    top: EconomyAssetTypeSummary[]
  }
  orders: {
    open: EconomyOrderView[]
    recentClosed: EconomyOrderView[]
    buyCount: number
    sellCount: number
    escrow: number
    sellGrossRemaining: number
  }
  trade30d: {
    buys: number
    sales: number
    net: number
    transactionCount: number
    itemsBought: number
    itemsSold: number
  }
  transactions: EconomyTransactionView[]
  warnings: string[]
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_ASSET_LOCATION_DEPTH = 64

/**
 * Resolves each asset to its outer location. ESI represents contents as
 * item -> parent-item links, while stations and systems terminate the chain.
 * Missing parents are structure candidates; cycles and excessive depth stay
 * unresolved and are never sent to the structure endpoint.
 */
export function resolveEconomyAssetRoots(
  rows: readonly EconomyAssetRow[]
): EconomyAssetRootLocation[] {
  const assets = rows.flatMap(normalizeAssetRow)
  const byItemId = new Map<number, EconomyAssetRow>()
  for (const asset of assets) {
    if (!byItemId.has(asset.itemId)) byItemId.set(asset.itemId, asset)
  }

  return assets.map((asset) => {
    let locationId = asset.locationId
    let locationType = normalizedLocationType(asset.locationType)
    const visited = new Set<number>([asset.itemId])

    for (let depth = 0; locationType === 'item'; depth += 1) {
      if (visited.has(locationId)) {
        return {
          itemId: asset.itemId,
          locationId,
          locationType,
          unresolved: true,
          structureCandidate: false
        }
      }
      if (depth >= MAX_ASSET_LOCATION_DEPTH) {
        return {
          itemId: asset.itemId,
          locationId,
          locationType,
          unresolved: true,
          structureCandidate: false
        }
      }

      const parent = byItemId.get(locationId)
      if (!parent) {
        return {
          itemId: asset.itemId,
          locationId,
          locationType,
          unresolved: true,
          structureCandidate: true
        }
      }
      visited.add(locationId)
      locationId = parent.locationId
      locationType = normalizedLocationType(parent.locationType)
    }

    return {
      itemId: asset.itemId,
      locationId,
      locationType,
      unresolved: locationType !== 'station' && locationType !== 'solar_system',
      structureCandidate: false
    }
  })
}

export function collectEconomyAssetRootIds(
  rows: readonly EconomyAssetRow[]
): EconomyAssetRootIds {
  const roots = resolveEconomyAssetRoots(rows)
  return {
    publicLocationIds: [...new Set(roots
      .filter((root) => root.locationType === 'station' || root.locationType === 'solar_system')
      .map((root) => root.locationId))],
    structureIds: [...new Set(roots
      .filter((root) => root.structureCandidate)
      .map((root) => root.locationId))]
  }
}

export function buildPersonalEconomySnapshot(input: PersonalEconomyInput): PersonalEconomySnapshot {
  assertPositiveSafeInteger(input.characterId, 'characterId')
  const fetchedAt = validIsoDate(input.fetchedAt) ?? new Date().toISOString()
  const fetchedAtMs = Date.parse(fetchedAt)
  const grantedScopes = [...new Set(input.grantedScopes.filter(cleanText))]
  const grantedSet = new Set(grantedScopes)
  const missingScopes = PERSONAL_ECONOMY_SCOPES.filter((scope) => !grantedSet.has(scope))
  const names = new Map(
    (input.typeNames ?? [])
      .filter((entry) => positiveSafeInteger(entry.id) !== null && cleanText(entry.name))
      .map((entry) => [entry.id, entry.name.trim()])
  )
  const prices = new Map(
    (input.marketPrices ?? []).flatMap((entry) => {
      const typeId = positiveSafeInteger(entry.typeId)
      if (typeId === null) return []
      return [[typeId, finiteNonNegative(entry.averagePrice) ?? finiteNonNegative(entry.adjustedPrice)]] as const
    })
  )

  const locationResolutions = new Map(
    (input.assetLocationResolutions ?? []).flatMap((entry) => {
      const locationId = positiveSafeInteger(entry.locationId)
      const locationType = normalizedLocationType(entry.locationType)
      if (locationId === null) return []
      return [[locationId, {
        locationId,
        locationType,
        locationName: cleanText(entry.locationName) ? entry.locationName.trim() : null,
        unresolved: entry.unresolved === true
      } satisfies EconomyAssetLocationResolution]] as const
    })
  )

  const normalizedAssets = (input.assets ?? []).flatMap(normalizeAssetRow)
  const rootsByItemId = new Map(
    resolveEconomyAssetRoots(normalizedAssets).map((root) => [root.itemId, root])
  )
  const assetByType = new Map<number, {
    quantity: number
    stacks: number
    locations: Map<string, {
      locationId: number
      locationType: string
      locationName: string | null
      quantity: number
      stacks: number
      unresolved: boolean
    }>
  }>()
  for (const asset of normalizedAssets) {
    const root = rootsByItemId.get(asset.itemId)
    if (!root) continue
    const resolution = locationResolutions.get(root.locationId)
    const locationId = root.locationId
    const locationType = resolution?.locationType ?? root.locationType
    const locationKey = `${locationType}:${locationId}`
    const current = assetByType.get(asset.typeId) ?? {
      quantity: 0,
      stacks: 0,
      locations: new Map()
    }
    const currentLocation = current.locations.get(locationKey) ?? {
      locationId,
      locationType,
      locationName: resolution?.locationName ?? null,
      quantity: 0,
      stacks: 0,
      unresolved: resolution?.unresolved ?? true
    }
    current.quantity += asset.quantity
    current.stacks += 1
    currentLocation.quantity += asset.quantity
    currentLocation.stacks += 1
    current.locations.set(locationKey, currentLocation)
    assetByType.set(asset.typeId, current)
  }
  const assetTypes: EconomyAssetTypeSummary[] = [...assetByType].map(([typeId, summary]) => {
    const averagePrice = prices.get(typeId) ?? null
    const locationDetails: EconomyAssetLocationDetail[] = [...summary.locations.values()]
      .map((location) => ({
        ...location,
        estimatedValue: averagePrice === null ? null : averagePrice * location.quantity
      }))
      .sort(compareAssetLocations)
    return {
      typeId,
      typeName: names.get(typeId) ?? null,
      quantity: summary.quantity,
      stacks: summary.stacks,
      locations: summary.locations.size,
      locationDetails,
      averagePrice,
      estimatedValue: averagePrice === null ? null : averagePrice * summary.quantity
    }
  }).sort((left, right) => (
    (right.estimatedValue ?? -1) - (left.estimatedValue ?? -1) ||
    right.quantity - left.quantity ||
    (left.typeName ?? String(left.typeId)).localeCompare(right.typeName ?? String(right.typeId))
  ))
  const pricedAssets = assetTypes.filter((entry) => entry.estimatedValue !== null)

  const openOrders = normalizeOrders(input.orders ?? [], names, 'open')
  const recentClosed = normalizeOrders(input.orderHistory ?? [], names)
    .sort((left, right) => Date.parse(right.issued) - Date.parse(left.issued))
    .slice(0, 100)
  const transactions = normalizeTransactions(input.transactions ?? [], names)
    .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
  const recentTransactions = transactions.filter((entry) => {
    const time = Date.parse(entry.date)
    return Number.isFinite(time) && time >= fetchedAtMs - THIRTY_DAYS_MS && time <= fetchedAtMs
  })
  const buys = sum(recentTransactions.filter((entry) => entry.buy).map((entry) => entry.gross))
  const sales = sum(recentTransactions.filter((entry) => !entry.buy).map((entry) => entry.gross))

  return {
    characterId: input.characterId,
    fetchedAt,
    grantedScopes,
    missingScopes,
    balance: finiteNonNegative(input.balance) ?? null,
    assets: {
      stackCount: [...assetByType.values()].reduce((total, entry) => total + entry.stacks, 0),
      typeCount: assetTypes.length,
      totalQuantity: [...assetByType.values()].reduce((total, entry) => total + entry.quantity, 0),
      estimatedValue: sum(pricedAssets.map((entry) => entry.estimatedValue ?? 0)),
      pricedTypeCount: pricedAssets.length,
      unpricedTypeCount: assetTypes.length - pricedAssets.length,
      coverage: assetTypes.length === 0 ? 0 : pricedAssets.length / assetTypes.length,
      top: assetTypes.slice(0, 100)
    },
    orders: {
      open: openOrders.sort((left, right) => Date.parse(right.issued) - Date.parse(left.issued)),
      recentClosed,
      buyCount: openOrders.filter((entry) => entry.buyOrder).length,
      sellCount: openOrders.filter((entry) => !entry.buyOrder).length,
      escrow: sum(openOrders.map((entry) => entry.escrow)),
      sellGrossRemaining: sum(
        openOrders.filter((entry) => !entry.buyOrder).map((entry) => entry.grossRemaining)
      )
    },
    trade30d: {
      buys,
      sales,
      net: sales - buys,
      transactionCount: recentTransactions.length,
      itemsBought: sum(recentTransactions.filter((entry) => entry.buy).map((entry) => entry.quantity)),
      itemsSold: sum(recentTransactions.filter((entry) => !entry.buy).map((entry) => entry.quantity))
    },
    transactions: transactions.slice(0, 200),
    warnings: [...new Set((input.warnings ?? []).filter(cleanText).map((value) => value.trim()))]
  }
}

export function collectEconomyTypeIds(input: {
  assets?: readonly EconomyAssetRow[]
  orders?: readonly EconomyOrderRow[]
  orderHistory?: readonly EconomyOrderRow[]
  transactions?: readonly EconomyTransactionRow[]
}): number[] {
  return [...new Set([
    ...(input.assets ?? []).map((entry) => entry.typeId),
    ...(input.orders ?? []).map((entry) => entry.typeId),
    ...(input.orderHistory ?? []).map((entry) => entry.typeId),
    ...(input.transactions ?? []).map((entry) => entry.typeId)
  ].filter((value): value is number => positiveSafeInteger(value) !== null))]
}

function normalizeAssetRow(row: EconomyAssetRow): EconomyAssetRow[] {
  const itemId = positiveSafeInteger(row.itemId)
  const typeId = positiveSafeInteger(row.typeId)
  const quantity = positiveSafeInteger(row.quantity)
  const locationId = positiveSafeInteger(row.locationId)
  if (itemId === null || typeId === null || quantity === null || locationId === null) return []
  return [{
    ...row,
    itemId,
    typeId,
    quantity,
    locationId,
    locationType: normalizedLocationType(row.locationType),
    locationFlag: cleanText(row.locationFlag) ? row.locationFlag.trim() : 'Unknown',
    singleton: row.singleton === true
  }]
}

function normalizedLocationType(value: unknown): string {
  return cleanText(value) ? value.trim().toLowerCase() : 'other'
}

function compareAssetLocations(
  left: EconomyAssetLocationDetail,
  right: EconomyAssetLocationDetail
): number {
  return (
    (right.estimatedValue ?? -1) - (left.estimatedValue ?? -1) ||
    right.quantity - left.quantity ||
    Number(left.unresolved) - Number(right.unresolved) ||
    (left.locationName ?? '').localeCompare(right.locationName ?? '') ||
    left.locationId - right.locationId
  )
}

function normalizeOrders(
  rows: readonly EconomyOrderRow[],
  names: ReadonlyMap<number, string>,
  forcedState?: EconomyOrderRow['state']
): EconomyOrderView[] {
  return rows.flatMap((row): EconomyOrderView[] => {
    const orderId = positiveSafeInteger(row.orderId)
    const typeId = positiveSafeInteger(row.typeId)
    const locationId = positiveSafeInteger(row.locationId)
    const regionId = positiveSafeInteger(row.regionId)
    const price = finiteNonNegative(row.price)
    const volumeRemain = nonNegativeSafeInteger(row.volumeRemain)
    const volumeTotal = nonNegativeSafeInteger(row.volumeTotal)
    const issued = validIsoDate(row.issued)
    const durationDays = nonNegativeSafeInteger(row.durationDays)
    if (
      orderId === null || typeId === null || locationId === null || regionId === null ||
      price === null || volumeRemain === null || volumeTotal === null || issued === null ||
      durationDays === null
    ) return []
    const state = forcedState ?? (row.state === 'cancelled' || row.state === 'expired' ? row.state : 'open')
    const expiryMs = Date.parse(issued) + durationDays * 24 * 60 * 60 * 1_000
    return [{
      ...row,
      orderId,
      typeId,
      locationId,
      regionId,
      price,
      volumeRemain,
      volumeTotal,
      minVolume: nonNegativeSafeInteger(row.minVolume) ?? 0,
      issued,
      durationDays,
      escrow: finiteNonNegative(row.escrow) ?? 0,
      state,
      typeName: names.get(typeId) ?? null,
      grossRemaining: price * volumeRemain,
      expiresAt: Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null
    }]
  })
}

function normalizeTransactions(
  rows: readonly EconomyTransactionRow[],
  names: ReadonlyMap<number, string>
): EconomyTransactionView[] {
  return rows.flatMap((row): EconomyTransactionView[] => {
    const transactionId = positiveSafeInteger(row.transactionId)
    const typeId = positiveSafeInteger(row.typeId)
    const quantity = positiveSafeInteger(row.quantity)
    const unitPrice = finiteNonNegative(row.unitPrice)
    const date = validIsoDate(row.date)
    const locationId = positiveSafeInteger(row.locationId)
    const clientId = positiveSafeInteger(row.clientId)
    if (
      transactionId === null || typeId === null || quantity === null || unitPrice === null ||
      date === null || locationId === null || clientId === null
    ) return []
    return [{
      ...row,
      transactionId,
      typeId,
      quantity,
      unitPrice,
      date,
      locationId,
      clientId,
      typeName: names.get(typeId) ?? null,
      gross: unitPrice * quantity
    }]
  })
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (positiveSafeInteger(value) === null) throw new TypeError(`Invalid ${label}`)
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function cleanText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1_024
}

function validIsoDate(value: unknown): string | null {
  if (!cleanText(value)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
