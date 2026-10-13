import { afterEach, describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { EsiClient } from '../src/main/esi-client'

describe('EsiClient universe topology', () => {
  let cache: Cache | null = null

  afterEach(() => {
    cache?.close()
    cache = null
  })

  it('parses, deduplicates and caches system stargates', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(new URL(String(input)).pathname).toBe('/universe/systems/30000142/')
      return jsonResponse({
        system_id: 30_000_142,
        constellation_id: 20_000_020,
        name: 'Jita',
        security_status: 0.945,
        stargates: [50_000_001, 50_000_002, 50_000_001]
      })
    })
    cache = new Cache(':memory:')
    const esi = new EsiClient(cache, { baseUrl: 'https://esi.test', fetch: fetchMock })

    await expect(esi.getSolarSystem(30_000_142)).resolves.toMatchObject({
      stargateIds: [50_000_001, 50_000_002],
      cached: false
    })
    await expect(esi.getSolarSystem(30_000_142)).resolves.toMatchObject({
      stargateIds: [50_000_001, 50_000_002],
      cached: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats missing optional stargates as an empty list', async () => {
    cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: async () => jsonResponse({
        constellation_id: 21_000_001,
        name: 'J123456',
        security_status: -0.99
      })
    })
    await expect(esi.getSolarSystem(31_000_001)).resolves.toMatchObject({ stargateIds: [] })
  })

  it('parses and caches a stargate destination and rejects mismatched IDs', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const id = Number(new URL(String(input)).pathname.split('/').filter(Boolean).at(-1))
      return jsonResponse({
        stargate_id: id === 50_000_099 ? 50_000_100 : id,
        name: 'Stargate (Perimeter)',
        system_id: 30_000_142,
        destination: { stargate_id: 50_000_011, system_id: 30_000_144 }
      })
    })
    cache = new Cache(':memory:')
    const esi = new EsiClient(cache, { baseUrl: 'https://esi.test', fetch: fetchMock })

    await expect(esi.getStargate(50_000_010)).resolves.toEqual({
      id: 50_000_010,
      name: 'Stargate (Perimeter)',
      systemId: 30_000_142,
      destinationStargateId: 50_000_011,
      destinationSystemId: 30_000_144,
      cached: false
    })
    await expect(esi.getStargate(50_000_010)).resolves.toMatchObject({ cached: true })
    await expect(esi.getStargate(50_000_099)).rejects.toThrow('did not match')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}
