import {
  buildPersonalEconomySnapshot,
  collectEconomyAssetRootIds,
  collectEconomyTypeIds,
  resolveEconomyAssetRoots,
  type EconomyAssetLocationResolution,
  type EconomyAssetRow,
  type EconomyMarketPrice,
  type EconomyOrderRow,
  type EconomyTransactionRow,
  type PersonalEconomySnapshot
} from '../shared/personal-economy'

export interface PersonalEconomyAuthorizedSession {
  accessToken: string
  session: {
    characterId: number
    scopes: readonly string[]
  }
}

export interface PersonalEconomyAccountAdapter {
  getAuthorizedSession(): Promise<PersonalEconomyAuthorizedSession | null>
}

export interface PersonalEconomyEsiAdapter {
  getAuthenticatedCharacterWallet(
    characterId: number,
    accessToken: string,
    forceRefresh?: boolean
  ): Promise<number>
  getAuthenticatedCharacterOrders(
    characterId: number,
    accessToken: string,
    forceRefresh?: boolean
  ): Promise<EconomyOrderRow[]>
  getAuthenticatedCharacterOrderHistory(
    characterId: number,
    accessToken: string,
    forceRefresh?: boolean
  ): Promise<EconomyOrderRow[]>
  getAuthenticatedCharacterWalletTransactions(
    characterId: number,
    accessToken: string,
    forceRefresh?: boolean
  ): Promise<EconomyTransactionRow[]>
  getAuthenticatedCharacterAssets(
    characterId: number,
    accessToken: string,
    forceRefresh?: boolean
  ): Promise<EconomyAssetRow[]>
  getMarketPrices(forceRefresh?: boolean): Promise<EconomyMarketPrice[]>
  getUniverseNames(
    ids: readonly number[],
    forceRefresh?: boolean
  ): Promise<Array<{ id: number; name: string; category?: string }>>
  getAuthenticatedUniverseStructure(
    characterId: number,
    structureId: number,
    accessToken: string,
    forceRefresh?: boolean
  ): Promise<{
    structureId: number
    name: string
    solarSystemId: number
    typeId: number | null
    ownerId: number
  }>
}

export interface PersonalEconomyRequest {
  forceRefresh?: boolean
}

/** Loads only scopes actually present in the current token and returns a partial snapshot safely. */
export class PersonalEconomyService {
  private inFlight: Promise<PersonalEconomySnapshot> | null = null

  constructor(
    private readonly account: PersonalEconomyAccountAdapter,
    private readonly esi: PersonalEconomyEsiAdapter,
    private readonly now: () => Date = () => new Date()
  ) {}

  getSnapshot(request: PersonalEconomyRequest = {}): Promise<PersonalEconomySnapshot> {
    if (this.inFlight && request.forceRefresh !== true) return this.inFlight
    const operation = this.loadSnapshot(request.forceRefresh === true)
    if (request.forceRefresh !== true) {
      this.inFlight = operation
      void operation.finally(() => {
        if (this.inFlight === operation) this.inFlight = null
      }).catch(() => undefined)
    }
    return operation
  }

  private async loadSnapshot(forceRefresh: boolean): Promise<PersonalEconomySnapshot> {
    const authorized = await this.account.getAuthorizedSession()
    if (!authorized) throw new Error('Sign in through an EVE Online character is required')

    const { characterId, scopes } = authorized.session
    const accessToken = authorized.accessToken
    const scopeSet = new Set(scopes)
    const warnings: string[] = []

    const walletPromise = scopeSet.has('esi-wallet.read_character_wallet.v1')
      ? settled('wallet', this.esi.getAuthenticatedCharacterWallet(characterId, accessToken, forceRefresh), warnings, accessToken)
      : Promise.resolve<number | null>(null)
    const transactionsPromise = scopeSet.has('esi-wallet.read_character_wallet.v1')
      ? settled('transactions', this.esi.getAuthenticatedCharacterWalletTransactions(characterId, accessToken, forceRefresh), warnings, accessToken)
      : Promise.resolve<EconomyTransactionRow[] | null>(null)
    const ordersPromise = scopeSet.has('esi-markets.read_character_orders.v1')
      ? settled('open orders', this.esi.getAuthenticatedCharacterOrders(characterId, accessToken, forceRefresh), warnings, accessToken)
      : Promise.resolve<EconomyOrderRow[] | null>(null)
    const orderHistoryPromise = scopeSet.has('esi-markets.read_character_orders.v1')
      ? settled('order history', this.esi.getAuthenticatedCharacterOrderHistory(characterId, accessToken, forceRefresh), warnings, accessToken)
      : Promise.resolve<EconomyOrderRow[] | null>(null)
    const assetsPromise = scopeSet.has('esi-assets.read_assets.v1')
      ? settled('assets', this.esi.getAuthenticatedCharacterAssets(characterId, accessToken, forceRefresh), warnings, accessToken)
      : Promise.resolve<EconomyAssetRow[] | null>(null)

    const [balance, transactions, orders, orderHistory, assets] = await Promise.all([
      walletPromise,
      transactionsPromise,
      ordersPromise,
      orderHistoryPromise,
      assetsPromise
    ])
    const typeIds = collectEconomyTypeIds({
      assets: assets ?? [],
      orders: orders ?? [],
      orderHistory: orderHistory ?? [],
      transactions: transactions ?? []
    })
    const assetRows = assets ?? []
    const roots = resolveEconomyAssetRoots(assetRows)
    const rootIds = collectEconomyAssetRootIds(assetRows)
    const publicRootTypes = new Map(
      roots
        .filter((root) => root.locationType === 'station' || root.locationType === 'solar_system')
        .map((root) => [root.locationId, root.locationType])
    )
    const universeNameIds = [...new Set([...typeIds, ...rootIds.publicLocationIds])]
    const [universeNames, marketPrices, structureLocations] = await Promise.all([
      universeNameIds.length === 0
        ? Promise.resolve([])
        : settled(
            'item and location names',
            this.esi.getUniverseNames(universeNameIds, forceRefresh),
            warnings,
            accessToken
          ).then((value) => value ?? []),
      assets && assets.length > 0
        ? settled('average asset prices', this.esi.getMarketPrices(forceRefresh), warnings, accessToken).then((value) => value ?? [])
        : Promise.resolve([]),
      resolvePrivateStructureLocations({
        characterId,
        structureIds: rootIds.structureIds,
        accessToken,
        forceRefresh,
        granted: scopeSet.has('esi-universe.read_structures.v1'),
        esi: this.esi,
        warnings
      })
    ])
    const typeIdSet = new Set(typeIds)
    const publicNames = new Map(
      universeNames
        .filter((entry) => rootIds.publicLocationIds.includes(entry.id))
        .map((entry) => [entry.id, entry.name])
    )
    const assetLocationResolutions: EconomyAssetLocationResolution[] = [
      ...rootIds.publicLocationIds.map((locationId) => ({
        locationId,
        locationType: publicRootTypes.get(locationId) ?? 'other',
        locationName: publicNames.get(locationId) ?? null,
        unresolved: !publicNames.has(locationId)
      })),
      ...structureLocations
    ]

    return buildPersonalEconomySnapshot({
      characterId,
      grantedScopes: scopes,
      balance,
      assets: assets ?? [],
      orders: orders ?? [],
      orderHistory: orderHistory ?? [],
      transactions: transactions ?? [],
      typeNames: universeNames.filter((entry) => typeIdSet.has(entry.id)),
      marketPrices,
      assetLocationResolutions,
      fetchedAt: this.now().toISOString(),
      warnings
    })
  }
}

async function resolvePrivateStructureLocations(input: {
  characterId: number
  structureIds: readonly number[]
  accessToken: string
  forceRefresh: boolean
  granted: boolean
  esi: PersonalEconomyEsiAdapter
  warnings: string[]
}): Promise<EconomyAssetLocationResolution[]> {
  const fallback = (locationId: number): EconomyAssetLocationResolution => ({
    locationId,
    locationType: 'structure',
    locationName: null,
    unresolved: true
  })
  if (!input.granted || input.structureIds.length === 0) {
    return input.structureIds.map(fallback)
  }

  let failed = 0
  const results = await mapConcurrent(input.structureIds, 4, async (structureId) => {
    try {
      const structure = await input.esi.getAuthenticatedUniverseStructure(
        input.characterId,
        structureId,
        input.accessToken,
        input.forceRefresh
      )
      return {
        locationId: structureId,
        locationType: 'structure',
        locationName: structure.name,
        unresolved: false
      } satisfies EconomyAssetLocationResolution
    } catch {
      failed += 1
      return fallback(structureId)
    }
  })
  if (failed > 0) {
    input.warnings.push(
      `ESI: private structure names unavailable (${failed} of ${input.structureIds.length})`
    )
  }
  return results
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor
        cursor += 1
        results[index] = await operation(values[index])
      }
    }
  )
  await Promise.all(workers)
  return results
}

async function settled<T>(
  label: string,
  operation: Promise<T>,
  warnings: string[],
  secret: string
): Promise<T | null> {
  try {
    return await operation
  } catch (error) {
    warnings.push(`ESI: ${label} unavailable (${safeMessage(error, secret)})`)
    return null
  }
}

function safeMessage(error: unknown, secret: string): string {
  const message = error instanceof Error && error.message ? error.message : 'unknown error'
  return secret && message.includes(secret) ? message.split(secret).join('[redacted]') : message
}
