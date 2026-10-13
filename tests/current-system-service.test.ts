import { describe, expect, it, vi } from 'vitest'
import type { EveAuthorizedSession } from '../src/main/account-service'
import {
  CurrentSystemService,
  type CurrentSystemAccountAdapter,
  type CurrentSystemEsiAdapter,
  type CurrentSystemIntelAdapter
} from '../src/main/current-system-service'
import { EVE_SSO_SCOPES } from '../src/main/eve-sso'
import type { EveAccountStatus, SystemIntel } from '../src/shared/types'

const CHARACTER_ID = 90_000_001
const SYSTEM_ID = 30_000_142
const SHIP_TYPE_ID = 11_978
const ACCESS_TOKEN = 'secret-access-token-never-expose'
const NOW = new Date('2026-08-21T16:00:00Z')

function accountStatus(connected: boolean): EveAccountStatus {
  return {
    configured: true,
    connected,
    clientId: 'public-client-id',
    callbackUri: 'http://localhost:53173/callback',
    characterId: connected ? CHARACTER_ID : null,
    characterName: connected ? 'Own Pilot' : null,
    scopes: connected ? [...EVE_SSO_SCOPES] : [],
    error: null
  }
}

function authorizedSession(): EveAuthorizedSession {
  return {
    accessToken: ACCESS_TOKEN,
    session: {
      characterId: CHARACTER_ID,
      characterName: 'Own Pilot',
      scopes: [...EVE_SSO_SCOPES],
      expiresAt: NOW.getTime() + 3_600_000
    }
  }
}

function makeIntel(): SystemIntel {
  return {
    system: {
      id: SYSTEM_ID,
      name: 'Jita',
      securityStatus: 0.945,
      securityClass: 'B',
      constellationId: 20_000_020,
      constellationName: 'Kimotoro',
      regionId: 10_000_002,
      regionName: 'The Forge',
      isWormhole: false
    },
    lastHour: {
      shipKills: 3,
      podKills: 1,
      npcKills: 42,
      jumps: 100,
      source: 'ESI',
      access: 'public',
      temporal: 'historical'
    },
    zkill24h: {
      count: 2,
      latest: [{
        killmailId: 700_001,
        time: '2026-08-21T15:00:00.000Z',
        solarSystemId: SYSTEM_ID,
        victimCharacterId: CHARACTER_ID,
        victimName: 'Own Pilot',
        victimShipTypeId: SHIP_TYPE_ID,
        victimShipName: 'Astero',
        attackerCount: 1,
        capsuleerAttackerCount: 1,
        totalValue: 80_000_000
      }],
      sourceCapped: false,
      latestCapped: false,
      capped: false,
      observedShips: [{
        typeId: SHIP_TYPE_ID,
        name: 'Astero',
        victimCount: 1,
        attackerCount: 0,
        lastSeen: '2026-08-21T15:00:00.000Z',
        pilotsCapped: false,
        pilots: [{
          characterId: CHARACTER_ID,
          name: 'Own Pilot',
          victimCount: 1,
          attackerCount: 0,
          finalBlowCount: 0,
          lastAttackerSeen: null,
          lastVictimSeen: '2026-08-21T15:00:00.000Z',
          lastSeen: '2026-08-21T15:00:00.000Z'
        }],
        occurrencesCapped: false,
        occurrences: [
          {
            killmailId: 700_001,
            time: '2026-08-21T15:00:00.000Z',
            solarSystemId: SYSTEM_ID,
            role: 'victim',
            pilotCharacterId: CHARACTER_ID,
            pilotName: 'Own Pilot',
            finalBlow: false,
            victimCharacterId: CHARACTER_ID,
            victimName: 'Own Pilot',
            victimShipTypeId: SHIP_TYPE_ID,
            victimShipName: 'Astero',
            totalValue: 80_000_000
          },
          {
            killmailId: 700_001,
            time: '2026-08-21T15:00:00.000Z',
            solarSystemId: SYSTEM_ID,
            role: 'attacker',
            pilotCharacterId: 90_000_002,
            pilotName: 'Other Pilot',
            finalBlow: true,
            victimCharacterId: CHARACTER_ID,
            victimName: 'Own Pilot',
            victimShipTypeId: SHIP_TYPE_ID,
            victimShipName: 'Astero',
            totalValue: 80_000_000
          }
        ]
      }],
      observedShipsCapped: false,
      observedPilots: [
        {
          characterId: CHARACTER_ID,
          name: 'Own Pilot',
          victimCount: 1,
          attackerCount: 0,
          finalBlowCount: 0,
          shipTypeIds: [SHIP_TYPE_ID],
          lastSeen: '2026-08-21T15:00:00.000Z'
        },
        {
          characterId: 90_000_002,
          name: 'Other Pilot',
          victimCount: 0,
          attackerCount: 1,
          finalBlowCount: 1,
          shipTypeIds: [17_918],
          lastSeen: '2026-08-21T15:00:00.000Z'
        }
      ],
      observedPilotsCapped: false,
      source: 'zKillboard',
      access: 'public',
      temporal: 'historical'
    },
    danger: {
      score: 35,
      level: 'medium',
      reasons: ['История убийств'],
      factors: [{ code: 'zkill-24h', points: 35, reason: '2 убийства' }]
    },
    fetchedAt: '2026-08-21T15:59:00.000Z',
    cached: false,
    warnings: [],
    provenance: {
      access: 'public',
      temporal: 'historical',
      liveRosterAvailable: false
    }
  }
}

function makeService(options: {
  authorized?: EveAuthorizedSession | null
  status?: EveAccountStatus
  online?: boolean | Error
  location?: number | Error
  ship?: Error
  names?: Error | string
  intel?: Error | SystemIntel
} = {}): {
  service: CurrentSystemService
  account: CurrentSystemAccountAdapter
  esi: CurrentSystemEsiAdapter
  system: CurrentSystemIntelAdapter
} {
  const authorized = options.authorized === undefined ? authorizedSession() : options.authorized
  const account: CurrentSystemAccountAdapter = {
    getAuthorizedSession: vi.fn(async () => authorized),
    getStatus: vi.fn(async () => options.status ?? accountStatus(authorized !== null))
  }
  const esi: CurrentSystemEsiAdapter = {
    getAuthenticatedCharacterOnline: vi.fn(async () => {
      if (options.online instanceof Error) throw options.online
      return {
        online: options.online ?? true,
        lastLogin: null,
        lastLogout: null,
        logins: null
      }
    }),
    getAuthenticatedCharacterLocation: vi.fn(async () => {
      if (options.location instanceof Error) throw options.location
      return {
        solarSystemId: options.location ?? SYSTEM_ID,
        stationId: null,
        structureId: null
      }
    }),
    getAuthenticatedCharacterShip: vi.fn(async () => {
      if (options.ship instanceof Error) throw options.ship
      return {
        shipItemId: 123_456_789,
        shipName: 'My Astero',
        shipTypeId: SHIP_TYPE_ID
      }
    }),
    getUniverseNames: vi.fn(async () => {
      if (options.names instanceof Error) throw options.names
      return [{
        id: SHIP_TYPE_ID,
        name: options.names ?? 'Astero',
        category: 'inventory_type',
        cached: false
      }]
    })
  }
  const system: CurrentSystemIntelAdapter = {
    getSystemIntel: vi.fn(async () => {
      if (options.intel instanceof Error) throw options.intel
      return options.intel ?? makeIntel()
    })
  }

  return {
    service: new CurrentSystemService(account, esi, system, { now: () => NOW }),
    account,
    esi,
    system
  }
}

describe('CurrentSystemService', () => {
  it('returns public account state without authenticated calls when disconnected', async () => {
    const { service, esi, system } = makeService({
      authorized: null,
      status: accountStatus(false)
    })

    const snapshot = await service.getCurrentSystem()

    expect(snapshot).toEqual({
      account: accountStatus(false),
      online: null,
      location: null,
      ownShip: null,
      intel: null,
      fetchedAt: NOW.toISOString(),
      warnings: []
    })
    expect(esi.getAuthenticatedCharacterOnline).not.toHaveBeenCalled()
    expect(system.getSystemIntel).not.toHaveBeenCalled()
  })

  it('checks online first and makes no location or ship claim while offline', async () => {
    const { service, esi, system } = makeService({ online: false })

    const snapshot = await service.getCurrentSystem()

    expect(snapshot).toMatchObject({ online: false, ownShip: null, intel: null })
    expect(esi.getAuthenticatedCharacterOnline).toHaveBeenCalledWith(CHARACTER_ID, ACCESS_TOKEN)
    expect(esi.getAuthenticatedCharacterLocation).not.toHaveBeenCalled()
    expect(esi.getAuthenticatedCharacterShip).not.toHaveBeenCalled()
    expect(system.getSystemIntel).not.toHaveBeenCalled()
  })

  it('returns the current hull and system intel, filtering self without mutating cached intel', async () => {
    const source = makeIntel()
    const { service, esi, system } = makeService({ intel: source })

    const [first, concurrent] = await Promise.all([
      service.getCurrentSystem(),
      service.getCurrentSystem()
    ])

    expect(concurrent).toEqual(first)
    expect(first).toMatchObject({
      online: true,
      location: {
        solarSystemId: SYSTEM_ID
      },
      ownShip: {
        typeId: SHIP_TYPE_ID,
        typeName: 'Astero',
        customName: 'My Astero'
      },
      intel: { system: { id: SYSTEM_ID, name: 'Jita' } }
    })
    expect(first.intel?.zkill24h.observedPilots.map((pilot) => pilot.characterId)).toEqual([
      90_000_002
    ])
    expect(first.intel?.zkill24h.observedShips[0].pilots).toEqual([])
    expect(first.intel?.zkill24h.observedShips[0].occurrences).toEqual([
      expect.objectContaining({ pilotCharacterId: 90_000_002 })
    ])
    expect(source.zkill24h.observedShips[0].pilots).toHaveLength(1)
    expect(source.zkill24h.observedShips[0].occurrences).toHaveLength(2)
    expect(first.intel?.zkill24h.observedShips[0].occurrences)
      .not.toBe(source.zkill24h.observedShips[0].occurrences)
    expect(source.zkill24h.observedPilots).toHaveLength(2)
    expect(first.intel).not.toBe(source)
    expect(esi.getUniverseNames).toHaveBeenCalledWith([SHIP_TYPE_ID])
    expect(system.getSystemIntel).toHaveBeenCalledTimes(1)

    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain(ACCESS_TOKEN)
    expect(serialized).not.toContain('shipItemId')
    expect(serialized).not.toContain('123456789')
  })

  it('keeps the hull when location fails and reports partial warnings', async () => {
    const { service, system } = makeService({
      location: new Error('location denied')
    })

    const snapshot = await service.getCurrentSystem()

    expect(snapshot.online).toBe(true)
    expect(snapshot.ownShip).toMatchObject({ typeId: SHIP_TYPE_ID, typeName: 'Astero' })
    expect(snapshot.intel).toBeNull()
    expect(snapshot.warnings.join(' ')).toContain('current system')
    expect(system.getSystemIntel).not.toHaveBeenCalled()
  })

  it('keeps system intel when ship and system-name sources fail independently', async () => {
    const shipFailure = makeService({ ship: new Error('ship denied') })
    const shipSnapshot = await shipFailure.service.getCurrentSystem()
    expect(shipSnapshot.online).toBe(true)
    expect(shipSnapshot.ownShip).toBeNull()
    expect(shipSnapshot.intel?.system.id).toBe(SYSTEM_ID)
    expect(shipSnapshot.warnings.join(' ')).toContain('current ship')

    const sourceFailures = makeService({
      names: new Error('names unavailable'),
      intel: new Error('history unavailable')
    })
    const failedSnapshot = await sourceFailures.service.getCurrentSystem()
    expect(failedSnapshot.ownShip).toMatchObject({ typeId: SHIP_TYPE_ID, typeName: null })
    expect(failedSnapshot.location?.solarSystemId).toBe(SYSTEM_ID)
    expect(failedSnapshot.intel).toBeNull()
    expect(failedSnapshot.warnings.join(' ')).toContain('ship name')
    expect(failedSnapshot.warnings.join(' ')).toContain('System data')
  })

  it('does not fetch location when online status itself fails', async () => {
    const { service, esi } = makeService({
      online: new Error(`ESI unavailable: ${ACCESS_TOKEN}`)
    })

    const snapshot = await service.getCurrentSystem()

    expect(snapshot).toMatchObject({ online: null, ownShip: null, intel: null })
    expect(snapshot.warnings.join(' ')).toContain('pilot status')
    expect(JSON.stringify(snapshot)).not.toContain(ACCESS_TOKEN)
    expect(esi.getAuthenticatedCharacterLocation).not.toHaveBeenCalled()
  })
})
