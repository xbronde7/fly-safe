import { describe, expect, it, vi } from 'vitest'
import {
  NearbyPveService,
  type NearbyPveDependencies,
  type NearbyPveStargate,
  type NearbyPveTopologySystem
} from '../src/main/nearby-pve-service'

describe('NearbyPveService', () => {
  it('walks the stargate graph exactly two jumps with cycles, shortest paths and no duplicates', async () => {
    const topology = makeTopology()
    const getSystem = vi.fn(async (id: number) => topology.systems.get(id)!)
    const getStargate = vi.fn(async (id: number) => topology.gates.get(id)!)
    const service = new NearbyPveService({
      getSystem,
      getStargate,
      getSystemKills: async () => ({ rows: [
        { solarSystemId: 20, npcKills: 200, shipKills: 1, podKills: 0 },
        { solarSystemId: 30, npcKills: 300, shipKills: 2, podKills: 1 },
        { solarSystemId: 40, npcKills: 400, shipKills: 0, podKills: 0 }
      ] }),
      getSystemJumps: async () => ({ rows: [
        { solarSystemId: 20, jumps: 50 },
        { solarSystemId: 30, jumps: 60 },
        { solarSystemId: 40, jumps: 20 }
      ] })
    }, { now: () => new Date('2026-08-26T12:00:00Z') })

    const result = await service.getNearby({ originSystemId: 10, maxJumps: 2 })

    expect(result.systems.map(({ solarSystemId }) => solarSystemId)).toEqual([10, 40, 30, 20])
    expect(result.systems.find(({ solarSystemId }) => solarSystemId === 40)).toMatchObject({
      jumps: 2,
      pathSystemIds: [10, 20, 40],
      npcKills: 400,
      activity: 'high'
    })
    expect(result.systems.some(({ solarSystemId }) => solarSystemId === 50)).toBe(false)
    expect(getStargate).not.toHaveBeenCalledWith(400)
    expect(getStargate).not.toHaveBeenCalledWith(401)
    expect(result.topologyComplete).toBe(true)
  })

  it('keeps topology when hourly feeds fail and distinguishes unavailable values from zero', async () => {
    const system10 = system(10, [100])
    const system20 = system(20, [])
    const service = new NearbyPveService({
      getSystem: async (id) => id === 10 ? system10 : system20,
      getStargate: async () => gate(100, 10, 20),
      getSystemKills: async () => { throw new Error('kills offline') },
      getSystemJumps: async () => ({ rows: [] })
    })

    const result = await service.getNearby({ originSystemId: 10 })
    expect(result.systems.find(({ solarSystemId }) => solarSystemId === 20)).toMatchObject({
      npcKills: null,
      shipKills: null,
      podKills: null,
      shipJumps: 0,
      activity: 'unknown'
    })
    expect(result.warnings.join(' ')).toContain('PvE activity')
  })

  it('continues through a working branch when another stargate fails', async () => {
    const systems = new Map([
      [10, system(10, [100, 101])],
      [20, system(20, [200])],
      [40, system(40, [])]
    ])
    const service = new NearbyPveService({
      getSystem: async (id) => systems.get(id)!,
      getStargate: async (id) => {
        if (id === 101) throw new Error('gate offline')
        return id === 100 ? gate(100, 10, 20) : gate(200, 20, 40)
      },
      getSystemKills: async () => ({ rows: [] }),
      getSystemJumps: async () => ({ rows: [] })
    })

    const result = await service.getNearby({ originSystemId: 10 })
    expect(result.systems.map(({ solarSystemId }) => solarSystemId).sort()).toEqual([10, 20, 40])
    expect(result.topologyComplete).toBe(false)
    expect(result.warnings.join(' ')).toContain('stargate')
  })

  it('does not invent zero activity for wormhole space', async () => {
    const wormholeId = 31_000_001
    const service = new NearbyPveService({
      getSystem: async () => ({
        id: wormholeId,
        name: 'J123456',
        securityStatus: -0.99,
        stargateIds: []
      }),
      getStargate: async () => { throw new Error('unexpected') },
      getSystemKills: async () => ({ rows: [] }),
      getSystemJumps: async () => ({ rows: [] })
    })
    const result = await service.getNearby({ originSystemId: wormholeId })
    expect(result.systems[0]).toMatchObject({
      npcKills: null,
      shipKills: null,
      podKills: null,
      shipJumps: null,
      activity: 'unknown'
    })
    expect(result.warnings.join(' ')).toContain('wormhole space')
  })
})

function makeTopology(): {
  systems: Map<number, NearbyPveTopologySystem>
  gates: Map<number, NearbyPveStargate>
} {
  return {
    systems: new Map([
      [10, system(10, [100, 101])],
      [20, system(20, [200, 201])],
      [30, system(30, [300, 301])],
      [40, system(40, [400, 401])],
      [50, system(50, [])]
    ]),
    gates: new Map([
      [100, gate(100, 10, 20)],
      [101, gate(101, 10, 30)],
      [200, gate(200, 20, 10)],
      [201, gate(201, 20, 40)],
      [300, gate(300, 30, 10)],
      [301, gate(301, 30, 40)],
      [400, gate(400, 40, 20)],
      [401, gate(401, 40, 50)]
    ])
  }
}

function system(id: number, stargateIds: number[]): NearbyPveTopologySystem {
  return { id, name: `System ${id}`, securityStatus: -0.5, stargateIds }
}

function gate(id: number, systemId: number, destinationSystemId: number): NearbyPveStargate {
  return { id, systemId, destinationSystemId }
}
