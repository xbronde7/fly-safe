import {
  anomalyObservationFreshness,
  MAX_NEARBY_ANOMALY_SYSTEMS,
  rankNearbyAnomalySystems,
  validateNearbyAnomalyRequest,
  type NearbyAnomalyRequest,
  type NearbyAnomalySnapshot,
  type NearbyAnomalySystem,
  type ProbeSystemObservation
} from '../shared/nearby-anomalies'
import type { RoutePathSnapshot } from '../shared/route-intel'
import type { ProbeScanStore } from './probe-scan-store'

const ROUTE_CONCURRENCY = 4
const RECENT_REPORT_LIMIT = 48
const MAX_REPORT_AGE_MS = 6 * 60 * 60_000

export interface NearbyAnomalySystemMetadata {
  id: number
  name: string
  securityStatus: number
}

export interface NearbyAnomalyDependencies {
  getRouteSystems(originId: number, destinationId: number): Promise<RoutePathSnapshot>
  getSystemMetadata(solarSystemId: number): Promise<NearbyAnomalySystemMetadata>
}

export interface NearbyAnomalyServiceOptions {
  now?: () => Date
  reportLimit?: number
  routeConcurrency?: number
}

interface RoutedObservation {
  observation: ProbeSystemObservation | null
  pathSystemIds: number[]
}

/**
 * Finds saved Probe Scanner reports within a bounded public ESI route distance.
 * ESI does not publish anomaly contents, so an absent report is never treated as zero.
 */
export class NearbyAnomalyService {
  private readonly now: () => Date
  private readonly reportLimit: number
  private readonly routeConcurrency: number

  constructor(
    private readonly store: ProbeScanStore,
    private readonly dependencies: NearbyAnomalyDependencies,
    options: NearbyAnomalyServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.reportLimit = boundedInteger(options.reportLimit ?? RECENT_REPORT_LIMIT, 1, 128)
    this.routeConcurrency = boundedInteger(options.routeConcurrency ?? ROUTE_CONCURRENCY, 1, 8)
  }

  async getNearby(request: NearbyAnomalyRequest): Promise<NearbyAnomalySnapshot> {
    const validated = validateNearbyAnomalyRequest(request)
    const generatedAt = this.now().toISOString()
    const recent = this.store.listRecent(this.reportLimit)
    const originObservation = this.store.get(validated.originSystemId)
    const generatedAtMs = Date.parse(generatedAt)
    const candidates = deduplicateObservations([
      ...(originObservation ? [originObservation] : []),
      ...recent
    ]).filter((observation) => (
      Math.max(0, generatedAtMs - Date.parse(observation.observedAt)) <= MAX_REPORT_AGE_MS
    )).slice(0, MAX_NEARBY_ANOMALY_SYSTEMS)
    const warnings: string[] = []
    let routeFailures = 0

    const routed = await mapConcurrent(candidates, this.routeConcurrency, async (
      observation
    ): Promise<RoutedObservation | null> => {
      if (observation.solarSystemId === validated.originSystemId) {
        return { observation, pathSystemIds: [validated.originSystemId] }
      }
      try {
        const route = await this.dependencies.getRouteSystems(
          validated.originSystemId,
          observation.solarSystemId
        )
        const pathSystemIds = [...route.systemIds]
        const jumps = pathSystemIds.length - 1
        return jumps <= validated.maxJumps ? { observation, pathSystemIds } : null
      } catch {
        routeFailures += 1
        return null
      }
    })

    if (routeFailures > 0) {
      warnings.push(`Could not check distance for ${routeFailures} saved systems`)
    }

    const nearby = routed.flatMap((value) => value ? [value] : [])
    const originIncluded = nearby.some(({ observation }) => (
      observation?.solarSystemId === validated.originSystemId
    ))
    if (!originIncluded) {
      nearby.unshift({
        observation: null,
        pathSystemIds: [validated.originSystemId]
      })
    }

    let metadataFailures = 0
    const systems = await mapConcurrent(nearby, this.routeConcurrency, async ({
      observation,
      pathSystemIds
    }): Promise<NearbyAnomalySystem> => {
      const solarSystemId = pathSystemIds.at(-1)!
      let systemName = observation?.systemName ?? `System ${solarSystemId}`
      let securityStatus: number | null = null
      try {
        const metadata = await this.dependencies.getSystemMetadata(solarSystemId)
        systemName = metadata.name
        securityStatus = metadata.securityStatus
      } catch {
        metadataFailures += 1
      }
      const ageMinutes = observation
        ? Math.max(0, (generatedAtMs - Date.parse(observation.observedAt)) / 60_000)
        : null
      return {
        solarSystemId,
        systemName,
        securityStatus,
        jumps: pathSystemIds.length - 1,
        pathSystemIds,
        anomalyCount: observation?.anomalyCount ?? null,
        signatureCount: observation?.signatureCount ?? null,
        sites: observation?.sites ?? [],
        observedAt: observation?.observedAt ?? null,
        ageMinutes,
        freshness: anomalyObservationFreshness(ageMinutes)
      }
    })

    if (metadataFailures > 0) {
      warnings.push(`ESI: names or security unavailable for ${metadataFailures} systems`)
    }

    const ranked = rankNearbyAnomalySystems(systems)
    return {
      originSystemId: validated.originSystemId,
      maxJumps: validated.maxJumps,
      generatedAt,
      systems: ranked,
      coverage: {
        checkedReports: candidates.length,
        nearbyReports: ranked.filter((system) => system.jumps > 0 && system.observedAt !== null).length
      },
      warnings
    }
  }
}

function deduplicateObservations(values: readonly ProbeSystemObservation[]): ProbeSystemObservation[] {
  const bySystem = new Map<number, ProbeSystemObservation>()
  for (const value of values) {
    const previous = bySystem.get(value.solarSystemId)
    if (!previous || Date.parse(value.observedAt) > Date.parse(previous.observedAt)) {
      bySystem.set(value.solarSystemId, value)
    }
  }
  return [...bySystem.values()].sort((left, right) => (
    Date.parse(right.observedAt) - Date.parse(left.observedAt)
  ))
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
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
