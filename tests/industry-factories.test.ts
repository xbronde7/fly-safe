import { describe, expect, it } from 'vitest'
import { industryDistances, type IndustryTopology } from '../src/shared/industry-factories'
import data from '../src/main/data/industry-locations.json'
const graph: IndustryTopology = { factories: {}, systems: {
  1: { name: 'Origin', security: 0.9, neighbors: [2, 4] },
  2: { name: 'Safe', security: 0.45, neighbors: [1, 3] },
  3: { name: 'Far', security: 0.6, neighbors: [2] },
  4: { name: 'Low', security: 0.44, neighbors: [1, 5] },
  5: { name: 'Behind lowsec', security: 0.8, neighbors: [4] }
} }
describe('nearby factory gate distances', () => {
  it('includes origin, uses gate counts, and restricts the full path to high-sec', () => {
    expect([...industryDistances(graph, 1, 2, true)]).toEqual([[1, 0], [2, 1], [3, 2]])
    expect(industryDistances(graph, 1, 2, false).get(5)).toBe(2)
    expect(industryDistances(graph, 1, 1, false).has(3)).toBe(false)
    expect(industryDistances(graph, 1, 0, true).size).toBe(1)
    expect(industryDistances(graph, 4, 10, true).size).toBe(0)
  })
  it('bundles official static gates and confirmed factory services, not all stations', () => {
    expect(data.build).toBe(3561556)
    const topology: IndustryTopology = data
    const distances = industryDistances(topology, 30000142, 10, true)
    expect(distances.get(30000144)).toBe(1) // Jita -> Perimeter.
    expect(Object.keys(topology.factories).length).toBeGreaterThan(2000)
    expect(Object.values(topology.factories).filter(f => distances.has(f.systemId)).length).toBeGreaterThan(0)
    expect(Math.max(...distances.values())).toBe(10)
  })
})
