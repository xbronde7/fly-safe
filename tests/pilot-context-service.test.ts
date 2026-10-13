import { afterEach, describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import {
  EsiClient,
  EsiError,
  type AuthenticatedCharacterContactLabelsResult,
  type AuthenticatedCharacterContactsResult,
  type AuthenticatedCharacterFleet,
  type AuthenticatedFleetMembersResult,
  type UniverseName
} from '../src/main/esi-client'
import {
  PilotContextService,
  type PilotContextEsiAdapter
} from '../src/main/pilot-context-service'
import { classifyPilot } from '../src/shared/pilot-context'

const OWN_CHARACTER_ID = 90_000_001
const FRIEND_CHARACTER_ID = 90_000_002
const OTHER_CHARACTER_ID = 90_000_003
const CORPORATION_ID = 98_000_001
const FLEET_ID = 1_234_567_890
const SHIP_TYPE_ID = 11_978
const SYSTEM_ID = 30_000_142
const TOKEN = 'secret-token-never-expose'
const NOW = new Date('2026-08-21T18:00:00Z')

function contactsResult(): AuthenticatedCharacterContactsResult {
  return {
    cached: false,
    contacts: [
      {
        contactId: FRIEND_CHARACTER_ID,
        contactType: 'character',
        standing: -5,
        labelIds: [1],
        watched: true,
        blocked: false
      },
      {
        contactId: CORPORATION_ID,
        contactType: 'corporation',
        standing: 10,
        labelIds: [2],
        watched: false,
        blocked: false
      }
    ]
  }
}

function labelsResult(): AuthenticatedCharacterContactLabelsResult {
  return {
    cached: false,
    labels: [
      { labelId: 1, name: 'Hostile' },
      { labelId: 2, name: 'Blue corp' }
    ]
  }
}

function fleetResult(): AuthenticatedCharacterFleet {
  return {
    fleetId: FLEET_ID,
    fleetBossId: OWN_CHARACTER_ID,
    role: 'fleet_commander',
    wingId: null,
    squadId: null,
    cached: false
  }
}

function membersResult(): AuthenticatedFleetMembersResult {
  return {
    cached: false,
    members: [
      {
        characterId: OWN_CHARACTER_ID,
        joinedAt: '2026-08-21T17:00:00Z',
        role: 'fleet_commander',
        roleName: 'Fleet Commander',
        shipTypeId: SHIP_TYPE_ID,
        solarSystemId: SYSTEM_ID,
        squadId: null,
        stationId: null,
        takesFleetWarp: false,
        wingId: null
      },
      {
        characterId: FRIEND_CHARACTER_ID,
        joinedAt: '2026-08-21T17:05:00Z',
        role: 'squad_member',
        roleName: 'Squad Member',
        shipTypeId: SHIP_TYPE_ID,
        solarSystemId: SYSTEM_ID,
        squadId: 44,
        stationId: null,
        takesFleetWarp: true,
        wingId: 33
      }
    ]
  }
}

function universeNames(ids: readonly number[]): UniverseName[] {
  const values = new Map<number, { name: string; category: string }>([
    [OWN_CHARACTER_ID, { name: 'Own Pilot', category: 'character' }],
    [FRIEND_CHARACTER_ID, { name: 'Friendly Pilot', category: 'character' }],
    [CORPORATION_ID, { name: 'Friendly Corp', category: 'corporation' }],
    [SHIP_TYPE_ID, { name: 'Astero', category: 'inventory_type' }],
    [SYSTEM_ID, { name: 'Jita', category: 'solar_system' }]
  ])
  return ids.flatMap((id) => {
    const value = values.get(id)
    return value ? [{ id, ...value, cached: false }] : []
  })
}

function makeAdapter(overrides: Partial<PilotContextEsiAdapter> = {}): PilotContextEsiAdapter {
  return {
    getAuthenticatedCharacterContacts: vi.fn(async () => contactsResult()),
    getAuthenticatedCharacterContactLabels: vi.fn(async () => labelsResult()),
    getAuthenticatedCharacterFleet: vi.fn(async () => fleetResult()),
    getAuthenticatedFleetMembers: vi.fn(async () => membersResult()),
    getUniverseNames: vi.fn(async (ids) => universeNames(ids)),
    ...overrides
  }
}

describe('PilotContextService', () => {
  it('joins contacts, labels, friendly fleet, and public names without exposing the token', async () => {
    const esi = makeAdapter()
    const service = new PilotContextService(esi, { now: () => NOW })

    const context = await service.getContext({
      characterId: OWN_CHARACTER_ID,
      accessToken: TOKEN
    })

    expect(context).toMatchObject({
      characterId: OWN_CHARACTER_ID,
      fetchedAt: NOW.toISOString(),
      partial: false,
      warnings: [],
      provenance: {
        access: 'authenticated',
        fleetRoster: 'friendly-only',
        localRosterAvailable: false
      },
      contacts: {
        entries: [
          {
            id: FRIEND_CHARACTER_ID,
            type: 'character',
            name: 'Friendly Pilot',
            standing: -5,
            labelNames: ['Hostile']
          },
          {
            id: CORPORATION_ID,
            type: 'corporation',
            name: 'Friendly Corp',
            standing: 10,
            labelNames: ['Blue corp']
          }
        ]
      },
      fleet: {
        fleetId: FLEET_ID,
        ownRole: 'fleet_commander',
        membersAvailable: true,
        members: [{
          characterId: FRIEND_CHARACTER_ID,
          characterName: 'Friendly Pilot',
          shipTypeName: 'Astero',
          solarSystemName: 'Jita'
        }]
      }
    })
    expect(context.fleet?.members.map((member) => member.characterId)).toEqual([
      FRIEND_CHARACTER_ID
    ])
    expect(JSON.stringify(context)).not.toContain(TOKEN)
    expect(esi.getAuthenticatedFleetMembers).toHaveBeenCalledWith(FLEET_ID, TOKEN, false)

    expect(classifyPilot({
      characterId: FRIEND_CHARACTER_ID,
      corporationId: CORPORATION_ID
    }, context)).toMatchObject({
      fleet: true,
      contact: true,
      standing: -5,
      standingClass: 'negative',
      matchedContactType: 'character',
      labelNames: ['Hostile']
    })
    expect(classifyPilot({
      characterId: OTHER_CHARACTER_ID,
      corporationId: CORPORATION_ID
    }, context)).toMatchObject({
      fleet: false,
      contact: true,
      standing: 10,
      standingClass: 'positive',
      matchedContactType: 'corporation',
      labelNames: ['Blue corp']
    })
  })

  it('can retain the connected character in the friendly fleet roster', async () => {
    const service = new PilotContextService(makeAdapter(), { now: () => NOW })

    const context = await service.getContext({
      characterId: OWN_CHARACTER_ID,
      accessToken: TOKEN,
      excludeOwnCharacter: false
    })

    expect(context.fleet?.members.map((member) => member.characterId)).toEqual([
      OWN_CHARACTER_ID,
      FRIEND_CHARACTER_ID
    ])
    expect(classifyPilot(OWN_CHARACTER_ID, context).fleet).toBe(true)
  })

  it('keeps successful sources when labels, member roster, and name enrichment fail', async () => {
    const esi = makeAdapter({
      getAuthenticatedCharacterContactLabels: vi.fn(async () => {
        throw new Error(`labels denied ${TOKEN}`)
      }),
      getAuthenticatedFleetMembers: vi.fn(async () => {
        throw new Error(`fleet changed ${TOKEN}`)
      }),
      getUniverseNames: vi.fn(async () => {
        throw new Error('names unavailable')
      })
    })
    const service = new PilotContextService(esi, { now: () => NOW })

    const context = await service.getContext({
      characterId: OWN_CHARACTER_ID,
      accessToken: TOKEN
    })

    expect(context.partial).toBe(true)
    expect(context.contacts?.entries).toHaveLength(2)
    expect(context.contacts?.entries[0]).toMatchObject({ name: null, labelNames: [] })
    expect(context.fleet).toMatchObject({
      fleetId: FLEET_ID,
      membersAvailable: false,
      members: []
    })
    expect(context.warnings.join(' ')).toContain('contact labels')
    expect(context.warnings.join(' ')).toContain('friendly-fleet roster')
    expect(context.warnings.join(' ')).toContain('pilot, ship, or system names')
    expect(JSON.stringify(context)).not.toContain(TOKEN)
  })

  it('treats ESI 404 as not in fleet without claiming an error', async () => {
    const esi = makeAdapter({
      getAuthenticatedCharacterFleet: vi.fn(async () => {
        throw new EsiError('ESI 404: fleet not found', 404)
      })
    })
    const service = new PilotContextService(esi, { now: () => NOW })

    const context = await service.getContext({
      characterId: OWN_CHARACTER_ID,
      accessToken: TOKEN
    })

    expect(context.fleet).toBeNull()
    expect(context.partial).toBe(false)
    expect(context.warnings).toEqual([])
    expect(esi.getAuthenticatedFleetMembers).not.toHaveBeenCalled()
  })

  it('treats a members 404 as a stale fleet snapshot after leaving fleet', async () => {
    const esi = makeAdapter({
      getAuthenticatedCharacterFleet: vi.fn()
        .mockResolvedValueOnce(fleetResult())
        .mockRejectedValueOnce(new EsiError('ESI 404: fleet not found', 404)),
      getAuthenticatedFleetMembers: vi.fn(async () => {
        throw new EsiError(
          "ESI 404: The fleet does not exist or you don't have access to it!",
          404
        )
      })
    })
    const service = new PilotContextService(esi, { now: () => NOW })

    const context = await service.getContext({
      characterId: OWN_CHARACTER_ID,
      accessToken: TOKEN
    })

    expect(context.fleet).toBeNull()
    expect(context.partial).toBe(false)
    expect(context.warnings).toEqual([])
    expect(esi.getAuthenticatedFleetMembers).toHaveBeenCalledWith(FLEET_ID, TOKEN, false)
    expect(esi.getAuthenticatedCharacterFleet).toHaveBeenNthCalledWith(
      2,
      OWN_CHARACTER_ID,
      TOKEN,
      true
    )
  })

  it('does not request the roster for a fleet member who is not fleet boss', async () => {
    const esi = makeAdapter({
      getAuthenticatedCharacterFleet: vi.fn(async () => ({
        ...fleetResult(),
        fleetBossId: OTHER_CHARACTER_ID,
        role: 'squad_member'
      }))
    })
    const service = new PilotContextService(esi, { now: () => NOW })

    const context = await service.getContext({
      characterId: OWN_CHARACTER_ID,
      accessToken: TOKEN
    })

    expect(context.fleet).toMatchObject({
      fleetId: FLEET_ID,
      fleetBossId: OTHER_CHARACTER_ID,
      membersAvailable: false,
      members: []
    })
    expect(context.partial).toBe(false)
    expect(context.warnings).toEqual([])
    expect(esi.getAuthenticatedFleetMembers).not.toHaveBeenCalled()
  })

  it('treats a persistent members 404 as neutral roster unavailability', async () => {
    const esi = makeAdapter({
      getAuthenticatedFleetMembers: vi.fn(async () => {
        throw new EsiError('ESI 404: members access denied', 404)
      })
    })
    const service = new PilotContextService(esi, { now: () => NOW })

    const context = await service.getContext({
      characterId: OWN_CHARACTER_ID,
      accessToken: TOKEN
    })

    expect(context.fleet).toMatchObject({
      fleetId: FLEET_ID,
      membersAvailable: false,
      members: []
    })
    expect(context.partial).toBe(false)
    expect(context.warnings).toEqual([])
    expect(esi.getAuthenticatedFleetMembers).toHaveBeenCalledTimes(1)
    expect(esi.getAuthenticatedFleetMembers).toHaveBeenCalledWith(
      FLEET_ID,
      TOKEN,
      false
    )
    expect(esi.getAuthenticatedCharacterFleet).toHaveBeenNthCalledWith(
      2,
      OWN_CHARACTER_ID,
      TOKEN,
      true
    )
  })

  it('keeps a real members failure visible after a forced fleet recheck', async () => {
    const nextFleetId = FLEET_ID + 1
    const esi = makeAdapter({
      getAuthenticatedCharacterFleet: vi.fn()
        .mockResolvedValueOnce(fleetResult())
        .mockResolvedValueOnce({ ...fleetResult(), fleetId: nextFleetId }),
      getAuthenticatedFleetMembers: vi.fn()
        .mockRejectedValueOnce(new EsiError('ESI 404: members access denied', 404))
        .mockRejectedValueOnce(new EsiError('ESI 503: fleet service unavailable', 503))
    })
    const service = new PilotContextService(esi, { now: () => NOW })

    const context = await service.getContext({
      characterId: OWN_CHARACTER_ID,
      accessToken: TOKEN
    })

    expect(context.fleet).toMatchObject({
      fleetId: nextFleetId,
      membersAvailable: false,
      members: []
    })
    expect(context.partial).toBe(true)
    expect(context.warnings.join(' ')).toContain('friendly-fleet roster unavailable')
    expect(context.warnings.join(' ')).toContain('ESI 503')
    expect(esi.getAuthenticatedFleetMembers).toHaveBeenNthCalledWith(
      2,
      nextFleetId,
      TOKEN,
      true
    )
  })
})

describe('EsiClient authenticated conditional cache', () => {
  let cache: Cache | null = null

  afterEach(() => {
    cache?.close()
    cache = null
  })

  it('uses server max-age, then revalidates contacts with ETag and 304', async () => {
    let now = 1_000_000
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)

      if (url.searchParams.get('page') === '1') {
        if (headers.get('if-none-match') === '"contacts-v1"') {
          return new Response(null, {
            status: 304,
            headers: { 'Cache-Control': 'private, max-age=1', ETag: '"contacts-v1"' }
          })
        }
        return new Response(JSON.stringify([{
          contact_id: FRIEND_CHARACTER_ID,
          contact_type: 'character',
          standing: -5,
          label_ids: [1],
          is_watched: true
        }]), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'private, max-age=1',
            ETag: '"contacts-v1"',
            'Last-Modified': 'Fri, 21 Aug 2026 18:00:00 GMT',
            'X-Pages': '2'
          }
        })
      }

      return new Response(JSON.stringify([{
        contact_id: CORPORATION_ID,
        contact_type: 'corporation',
        standing: 10
      }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'private, max-age=1',
          'Last-Modified': 'Fri, 21 Aug 2026 18:00:00 GMT'
        }
      })
    })
    cache = new Cache(':memory:')
    const client = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1,
      now: () => now
    })

    const first = await client.getAuthenticatedCharacterContacts(OWN_CHARACTER_ID, TOKEN)
    expect(first.cached).toBe(false)
    expect(first.contacts.map((contact) => contact.contactId)).toEqual([
      FRIEND_CHARACTER_ID,
      CORPORATION_ID
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const fresh = await client.getAuthenticatedCharacterContacts(OWN_CHARACTER_ID, TOKEN)
    expect(fresh.cached).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    now += 1_001
    const revalidated = await client.getAuthenticatedCharacterContacts(OWN_CHARACTER_ID, TOKEN)
    expect(revalidated).toEqual({ ...first, cached: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const forceRefreshed = await client.getAuthenticatedCharacterContacts(
      OWN_CHARACTER_ID,
      TOKEN,
      true
    )
    expect(forceRefreshed.cached).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    const forcedHeaders = new Headers(fetchMock.mock.calls[3]?.[1]?.headers)
    expect(forcedHeaders.has('if-none-match')).toBe(false)
  })
})
