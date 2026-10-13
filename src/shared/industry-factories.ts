export interface IndustryTopology {
  systems: Record<string, { name: string; security: number; neighbors: number[] }>
  factories: Record<string, { name: string; systemId: number }>
}
export function industryDistances(topology: IndustryTopology, origin: number, maxJumps: number, highSecOnly: boolean): Map<number, number> {
  const distances = new Map<number, number>()
  const allowed = (id: number): boolean => !!topology.systems[id] && (!highSecOnly || Math.round(topology.systems[id].security * 10) >= 5)
  if (!allowed(origin)) return distances
  distances.set(origin, 0)
  const queue = [origin]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i], distance = distances.get(id)!
    if (distance === maxJumps) continue
    for (const next of topology.systems[id].neighbors) if (!distances.has(next) && allowed(next)) {
      distances.set(next, distance + 1); queue.push(next)
    }
  }
  return distances
}
