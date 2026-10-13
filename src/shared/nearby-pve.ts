export const MAX_NEARBY_PVE_JUMPS = 2
export const MAX_NEARBY_PVE_SYSTEMS = 96
export const MAX_NEARBY_PVE_STARGATES = 256

export type NearbyPveActivity = 'very-high' | 'high' | 'medium' | 'low' | 'quiet' | 'unknown'

export interface NearbyPveRequest {
  originSystemId: number
  maxJumps?: number
}

export interface NearbyPveSystem {
  solarSystemId: number
  systemName: string
  securityStatus: number
  jumps: number
  pathSystemIds: number[]
  npcKills: number | null
  shipKills: number | null
  podKills: number | null
  shipJumps: number | null
  activity: NearbyPveActivity
}

export interface NearbyPveSnapshot {
  originSystemId: number
  maxJumps: number
  generatedAt: string
  systems: NearbyPveSystem[]
  topologyComplete: boolean
  warnings: string[]
  sources: {
    topology: 'ESI universe systems and stargates'
    activity: 'ESI hourly system kills and jumps'
    anomalyCountsAvailable: false
  }
}

export function validateNearbyPveRequest(value: unknown): Required<NearbyPveRequest> {
  if (!isRecord(value)) throw new TypeError('Invalid nearby-PvE-system request')
  const allowed = new Set(['originSystemId', 'maxJumps'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError('Nearby-PvE-system request contains unknown fields')
  }
  if (!Number.isSafeInteger(value.originSystemId) || (value.originSystemId as number) <= 0) {
    throw new TypeError('Invalid current-system ID')
  }
  const maxJumps = value.maxJumps === undefined ? MAX_NEARBY_PVE_JUMPS : value.maxJumps
  if (!Number.isSafeInteger(maxJumps) || (maxJumps as number) < 1 ||
      (maxJumps as number) > MAX_NEARBY_PVE_JUMPS) {
    throw new RangeError(`Radius must be from 1 to ${MAX_NEARBY_PVE_JUMPS} jumps`)
  }
  return {
    originSystemId: value.originSystemId as number,
    maxJumps: maxJumps as number
  }
}

export function classifyNearbyPveActivity(npcKills: number | null): NearbyPveActivity {
  if (npcKills === null) return 'unknown'
  if (!Number.isSafeInteger(npcKills) || npcKills < 0) {
    throw new TypeError('Invalid NPC-kill count')
  }
  if (npcKills >= 500) return 'very-high'
  if (npcKills >= 150) return 'high'
  if (npcKills >= 30) return 'medium'
  if (npcKills > 0) return 'low'
  return 'quiet'
}

export function rankNearbyPveSystems(systems: readonly NearbyPveSystem[]): NearbyPveSystem[] {
  return [...systems].sort((left, right) => {
    if (left.jumps === 0 || right.jumps === 0) return left.jumps === 0 ? -1 : 1
    const leftKnown = left.npcKills !== null
    const rightKnown = right.npcKills !== null
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
    return (right.npcKills ?? -1) - (left.npcKills ?? -1) ||
      left.jumps - right.jumps ||
      left.securityStatus - right.securityStatus ||
      left.systemName.localeCompare(right.systemName, 'en-US')
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
