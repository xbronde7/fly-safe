import { describe, expect, it, vi } from 'vitest'
import {
  PersonalEconomyService,
  type PersonalEconomyAccountAdapter,
  type PersonalEconomyEsiAdapter
} from '../src/main/personal-economy-service'

const TOKEN = 'secret-token'
const CHARACTER_ID = 90_000_001

function makeService(scopes: string[], overrides: Partial<PersonalEconomyEsiAdapter> = {}) {
  const account: PersonalEconomyAccountAdapter = {
    getAuthorizedSession: vi.fn(async () => ({
      accessToken: TOKEN,
      session: { characterId: CHARACTER_ID, scopes }
    }))
  }
  const esi: PersonalEconomyEsiAdapter = {
    getAuthenticatedCharacterWallet: vi.fn(async () => 100),
    getAuthenticatedCharacterOrders: vi.fn(async () => []),
    getAuthenticatedCharacterOrderHistory: vi.fn(async () => []),
    getAuthenticatedCharacterWalletTransactions: vi.fn(async () => []),
    getAuthenticatedCharacterAssets: vi.fn(async () => []),
    getMarketPrices: vi.fn(async () => []),
    getUniverseNames: vi.fn(async () => []),
    getAuthenticatedUniverseStructure: vi.fn(async (_characterId, structureId) => ({
      structureId,
      name: `Structure ${structureId}`,
      solarSystemId: 30_000_142,
      typeId: 35_832,
      ownerId: 98_000_001
    })),
    ...overrides
  }
  return { service: new PersonalEconomyService(account, esi, () => new Date('2026-08-25T12:00:00Z')), esi }
}

describe('PersonalEconomyService', () => {
  it('calls only routes granted by the token', async () => {
    const { service, esi } = makeService(['esi-assets.read_assets.v1'], {
      getAuthenticatedCharacterAssets: vi.fn(async () => [{
        itemId: 1,
        typeId: 34,
        quantity: 100,
        locationId: 60003760,
        locationType: 'station',
        locationFlag: 'Hangar',
        singleton: false
      }]),
      getMarketPrices: vi.fn(async () => [{ typeId: 34, averagePrice: 5, adjustedPrice: 4 }]),
      getUniverseNames: vi.fn(async () => [
        { id: 34, name: 'Tritanium', category: 'inventory_type' },
        { id: 60003760, name: 'Jita IV - Moon 4', category: 'station' }
      ])
    })

    const snapshot = await service.getSnapshot()

    expect(esi.getAuthenticatedCharacterAssets).toHaveBeenCalledOnce()
    expect(esi.getAuthenticatedCharacterWallet).not.toHaveBeenCalled()
    expect(esi.getAuthenticatedCharacterOrders).not.toHaveBeenCalled()
    expect(snapshot.assets.estimatedValue).toBe(500)
    expect(snapshot.assets.top[0].locationDetails).toEqual([{
      locationId: 60003760,
      locationType: 'station',
      locationName: 'Jita IV - Moon 4',
      quantity: 100,
      stacks: 1,
      estimatedValue: 500,
      unresolved: false
    }])
    expect(snapshot.missingScopes).toContain('esi-wallet.read_character_wallet.v1')
  })

  it('returns other sections when one authorized route fails and redacts the token', async () => {
    const { service } = makeService([
      'esi-wallet.read_character_wallet.v1',
      'esi-markets.read_character_orders.v1'
    ], {
      getAuthenticatedCharacterWallet: vi.fn(async () => {
        throw new Error(`ESI rejected ${TOKEN}`)
      }),
      getAuthenticatedCharacterOrders: vi.fn(async () => [{
        orderId: 1,
        typeId: 34,
        locationId: 60003760,
        regionId: 10000002,
        buyOrder: true,
        price: 4,
        volumeRemain: 10,
        volumeTotal: 20,
        minVolume: 1,
        issued: '2026-08-25T00:00:00Z',
        durationDays: 30,
        escrow: 40,
        state: 'open' as const
      }]),
      getUniverseNames: vi.fn(async () => [{ id: 34, name: 'Tritanium' }])
    })

    const snapshot = await service.getSnapshot()
    expect(snapshot.balance).toBeNull()
    expect(snapshot.orders.buyCount).toBe(1)
    expect(snapshot.warnings.join(' ')).toContain('[redacted]')
    expect(snapshot.warnings.join(' ')).not.toContain(TOKEN)
  })

  it('requires an authorized character', async () => {
    const account: PersonalEconomyAccountAdapter = { getAuthorizedSession: vi.fn(async () => null) }
    const { esi } = makeService([])
    const service = new PersonalEconomyService(account, esi)
    await expect(service.getSnapshot()).rejects.toThrow('Sign in')
  })

  it('resolves a private structure only when its optional scope is granted', async () => {
    const structureId = 1_041_132_165_591
    const getter = vi.fn(async () => ({
      structureId,
      name: 'Home Keepstar',
      solarSystemId: 30_001_059,
      typeId: 35_834,
      ownerId: 98_000_001
    }))
    const { service } = makeService([
      'esi-assets.read_assets.v1',
      'esi-universe.read_structures.v1'
    ], {
      getAuthenticatedCharacterAssets: vi.fn(async () => [{
        itemId: 55,
        typeId: 34,
        quantity: 10,
        locationId: structureId,
        locationType: 'item',
        locationFlag: 'Hangar',
        singleton: false
      }]),
      getUniverseNames: vi.fn(async () => [{ id: 34, name: 'Tritanium' }]),
      getAuthenticatedUniverseStructure: getter
    })

    const snapshot = await service.getSnapshot()

    expect(getter).toHaveBeenCalledWith(CHARACTER_ID, structureId, TOKEN, false)
    expect(snapshot.assets.top[0].locationDetails[0]).toMatchObject({
      locationId: structureId,
      locationType: 'structure',
      locationName: 'Home Keepstar',
      unresolved: false
    })
  })

  it('keeps private structures as unresolved locations without the optional scope', async () => {
    const structureId = 1_041_132_165_591
    const getter = vi.fn()
    const { service } = makeService(['esi-assets.read_assets.v1'], {
      getAuthenticatedCharacterAssets: vi.fn(async () => [{
        itemId: 55,
        typeId: 34,
        quantity: 10,
        locationId: structureId,
        locationType: 'item',
        locationFlag: 'Hangar',
        singleton: false
      }]),
      getAuthenticatedUniverseStructure: getter
    })

    const snapshot = await service.getSnapshot()

    expect(getter).not.toHaveBeenCalled()
    expect(snapshot.missingScopes).toContain('esi-universe.read_structures.v1')
    expect(snapshot.assets.top[0].locationDetails[0]).toMatchObject({
      locationId: structureId,
      locationType: 'structure',
      locationName: null,
      unresolved: true
    })
  })

  it('degrades multiple inaccessible structures to one warning', async () => {
    const structureIds = [1_041_132_165_591, 1_043_714_735_037]
    const getter = vi.fn(async () => {
      throw new Error(`ESI rejected ${TOKEN}`)
    })
    const { service } = makeService([
      'esi-assets.read_assets.v1',
      'esi-universe.read_structures.v1'
    ], {
      getAuthenticatedCharacterAssets: vi.fn(async () => structureIds.map((locationId, index) => ({
        itemId: index + 1,
        typeId: 34,
        quantity: index + 1,
        locationId,
        locationType: 'item',
        locationFlag: 'Hangar',
        singleton: false
      }))),
      getAuthenticatedUniverseStructure: getter
    })

    const snapshot = await service.getSnapshot()

    expect(getter).toHaveBeenCalledTimes(2)
    expect(snapshot.assets.top[0].locations).toBe(2)
    expect(snapshot.assets.top[0].locationDetails.every((entry) => entry.unresolved)).toBe(true)
    expect(snapshot.warnings).toEqual([
      'ESI: private structure names unavailable (2 of 2)'
    ])
    expect(snapshot.warnings.join(' ')).not.toContain(TOKEN)
  })
})
