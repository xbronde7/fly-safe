import {
  classifyNearbyPveActivity,
  MAX_NEARBY_PVE_STARGATES,
  MAX_NEARBY_PVE_SYSTEMS,
  rankNearbyPveSystems,
  validateNearbyPveRequest,
  type NearbyPveRequest,
  type NearbyPveSnapshot,
  type NearbyPveSystem
} from '../shared/nearby-pve'
import { isWormholeSystemId } from '../shared/system-intel'

export interface NearbyPveTopologySystem {
  id: number
  name: string
  securityStatus: number
  stargateIds: readonly number[]
}

export interface NearbyPveStargate {
  id: number
  systemId: number
  destinationSystemId: number
}

export interface NearbyPveKillsRow {
  solarSystemId: number
  npcKills: number
  shipKills: number
  podKills: number
}

export interface NearbyPveJumpsRow {
  solarSystemId: number
  jumps: number
}

export interface NearbyPveDependencies {
  getSystem(solarSystemId: number): Promise<NearbyPveTopologySystem>
  getStargate(stargateId: number): Promise<NearbyPveStargate>
  getSystemKills(): Promise<{ rows: readonly NearbyPveKillsRow[] }>
  getSystemJumps(): Promise<{ rows: readonly NearbyPveJumpsRow[] }>
}

export interface NearbyPveServiceOptions {
  now?: () => Date
  concurrency?: number
}

interface VisitedSystem {
  jumps: number
  pathSystemIds: number[]
}

interface GateTask {
  sourceSystemId: number
  sourcePath: number[]
  stargateId: number
}

/** Builds a real two-jump stargate neighbourhood and joins public hourly activity. */
export class NearbyPveService {
  private readonly now: () => Date
  private readonly concurrency: number

  constructor(
    private readonly dependencies: NearbyPveDependencies,
    options: NearbyPveServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.concurrency = boundedInteger(options.concurrency ?? 6, 1, 12)
  }

  async getNearby(request: NearbyPveRequest): Promise<NearbyPveSnapshot> {
    const validated = validateNearbyPveRequest(request)
    const warnings: string[] = []
    let topologyComplete = true
    let metadataFailures = 0
    let stargateFailures = 0
    let stargatesChecked = 0
    let truncated = false

    const activityPromise = Promise.allSettled([
      this.dependencies.getSystemKills(),
      this.dependencies.getSystemJumps()
    ])

    const visited = new Map<number, VisitedSystem>([[validated.originSystemId, {
      jumps: 0,
      pathSystemIds: [validated.originSystemId]
    }]])
    const metadata = new Map<number, NearbyPveTopologySystem>()
    let frontier = [validated.originSystemId]

    for (let depth = 0; depth <= validated.maxJumps && frontier.length > 0; depth += 1) {
      const loaded = await mapConcurrent(frontier, this.concurrency, async (systemId) => {
        try {
          return await this.dependencies.getSystem(systemId)
        } catch {
          metadataFailures += 1
          topologyComplete = false
          return null
        }
      })
      const available = loaded.flatMap((system) => system ? [system] : [])
      for (const system of available) metadata.set(system.id, system)
      if (depth >= validated.maxJumps) break

      const gateTasks: GateTask[] = []
      for (const system of available) {
        const path = visited.get(system.id)?.pathSystemIds
        if (!path) continue
        for (const stargateId of system.stargateIds) {
          if (stargatesChecked + gateTasks.length >= MAX_NEARBY_PVE_STARGATES) {
            topologyComplete = false
            truncated = true
            break
          }
          gateTasks.push({ sourceSystemId: system.id, sourcePath: path, stargateId })
        }
      }
      stargatesChecked += gateTasks.length

      const gates = await mapConcurrent(gateTasks, this.concurrency, async (task) => {
        try {
          const gate = await this.dependencies.getStargate(task.stargateId)
          return { gate, task }
        } catch {
          stargateFailures += 1
          topologyComplete = false
          return null
        }
      })

      const nextFrontier: number[] = []
      for (const loadedGate of gates) {
        if (!loadedGate) continue
        const { gate, task } = loadedGate
        if (gate.systemId !== task.sourceSystemId) {
          stargateFailures += 1
          topologyComplete = false
          continue
        }
        const destinationId = gate.destinationSystemId
        if (visited.has(destinationId)) continue
        if (visited.size >= MAX_NEARBY_PVE_SYSTEMS) {
          topologyComplete = false
          truncated = true
          break
        }
        visited.set(destinationId, {
          jumps: depth + 1,
          pathSystemIds: [...task.sourcePath, destinationId]
        })
        nextFrontier.push(destinationId)
      }
      frontier = nextFrontier
    }

    if (!metadata.has(validated.originSystemId)) {
      throw new Error('ESI did not return current-system data')
    }
    if (metadataFailures > 0) {
      warnings.push(`ESI: data unavailable for ${metadataFailures} nearby systems`)
    }
    if (stargateFailures > 0) {
      warnings.push(`ESI: data unavailable for ${stargateFailures} stargates`)
    }
    if (truncated) {
      warnings.push('Neighbor list was limited by a safety cap')
    }

    const [killsSettled, jumpsSettled] = await activityPromise
    const killsBySystem = killsSettled.status === 'fulfilled'
      ? new Map(killsSettled.value.rows.map((row) => [row.solarSystemId, row]))
      : null
    const jumpsBySystem = jumpsSettled.status === 'fulfilled'
      ? new Map(jumpsSettled.value.rows.map((row) => [row.solarSystemId, row]))
      : null
    if (killsBySystem === null) warnings.push('ESI: hourly PvE activity is temporarily unavailable')
    if (jumpsBySystem === null) warnings.push('ESI: hourly traffic is temporarily unavailable')

    const systems: NearbyPveSystem[] = []
    let includesWormholeSpace = false
    for (const [systemId, systemMetadata] of metadata) {
      const route = visited.get(systemId)
      if (!route) continue
      const kills = killsBySystem?.get(systemId)
      const wormhole = isWormholeSystemId(systemId)
      if (wormhole) includesWormholeSpace = true
      const npcKills = wormhole || killsBySystem === null ? null : kills?.npcKills ?? 0
      systems.push({
        solarSystemId: systemId,
        systemName: systemMetadata.name,
        securityStatus: systemMetadata.securityStatus,
        jumps: route.jumps,
        pathSystemIds: [...route.pathSystemIds],
        npcKills,
        shipKills: wormhole || killsBySystem === null ? null : kills?.shipKills ?? 0,
        podKills: wormhole || killsBySystem === null ? null : kills?.podKills ?? 0,
        shipJumps: wormhole || jumpsBySystem === null ? null : jumpsBySystem.get(systemId)?.jumps ?? 0,
        activity: classifyNearbyPveActivity(npcKills)
      })
    }
    if (includesWormholeSpace) {
      warnings.push('ESI does not publish hourly kills and jumps for wormhole space')
    }

    return {
      originSystemId: validated.originSystemId,
      maxJumps: validated.maxJumps,
      generatedAt: this.now().toISOString(),
      systems: rankNearbyPveSystems(systems),
      topologyComplete,
      warnings,
      sources: {
        topology: 'ESI universe systems and stargates',
        activity: 'ESI hourly system kills and jumps',
        anomalyCountsAvailable: false
      }
    }
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return []
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(values[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Value must be from ${minimum} to ${maximum}`)
  }
  return value
}
