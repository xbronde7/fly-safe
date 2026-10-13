import type { ProbeRow } from './clipboard-intel'

export type WormholeMassStatus = 'stable' | 'reduced' | 'critical' | 'collapsed' | 'unknown'
export type WormholeLifeStatus = 'stable' | 'end-of-life' | 'collapsed' | 'unknown'

export interface WormholeSystemNode {
  id: string
  solarSystemId: number | null
  name: string
  isHome: boolean
  firstSeenAt: string
  lastSeenAt: string
}

export interface WormholeSignatureObservation {
  sourceSystemNodeId: string
  signatureId: string
  group: string
  typeName: string | null
  wormholeCode: string | null
  name: string | null
  signalStrength: number | null
  distanceMeters: number | null
  observedAt: string
}

export interface WormholeConnection {
  id: string
  fromSystemNodeId: string
  toSystemNodeId: string
  fromSignatureId: string | null
  reverseSignatureId: string | null
  wormholeCode: string | null
  massStatus: WormholeMassStatus
  lifeStatus: WormholeLifeStatus
  discoveredAt: string
  updatedAt: string
  expiresAt: string | null
}

export interface WormholeChain {
  systems: WormholeSystemNode[]
  signatures: WormholeSignatureObservation[]
  connections: WormholeConnection[]
}

/** Token-free IPC input for creating or refreshing a system node. */
export interface WormholeSystemUpsertInput {
  id?: string
  solarSystemId?: number | null
  name: string
  isHome?: boolean
  seenAt?: string
}

/** Token-free IPC input for creating or refreshing a chain connection. */
export interface WormholeConnectionUpsertInput {
  id?: string
  fromSystemNodeId: string
  toSystemNodeId: string
  fromSignatureId?: string | null
  reverseSignatureId?: string | null
  wormholeCode?: string | null
  massStatus?: WormholeMassStatus
  lifeStatus?: WormholeLifeStatus
  discoveredAt?: string
  updatedAt?: string
  expiresAt?: string | null
}

export interface WormholeProbeScanRecordRequest {
  solarSystemId: number
  systemName: string
  rawProbeText: string
  observedAt: string
}

export interface WormholeStatusReading {
  massStatus: WormholeMassStatus
  lifeStatus: WormholeLifeStatus
  /** Short matched fragments. Intended for UI explanations, not authorization. */
  evidence: string[]
}

export interface WormholeHomeRoute {
  homeSystemNodeId: string
  systemNodeIds: string[]
  connectionIds: string[]
  jumps: number
  riskScore: number
  risk: 'safe' | 'caution' | 'dangerous'
  warnings: string[]
}

export interface WormholeProbeContext {
  sourceSystemNodeId: string
  observedAt?: string
}

const WORMHOLE_WORD = /(?:wormhole|червоточ|нестабил\S*\s+пространствен\S*\s+разрыв)/iu
const WORMHOLE_CODE = /\b(?:K162|[A-Z]\d{3})\b/iu
const SIGNATURE_ID = /^[A-Z]{3}-\d{3}$/iu

/** Convert Probe Scanner rows into durable wormhole signature observations. */
export function extractWormholeProbeSignatures(
  rows: readonly ProbeRow[],
  context: WormholeProbeContext
): WormholeSignatureObservation[] {
  const sourceSystemNodeId = cleanIdentifier(context.sourceSystemNodeId, 'Source-system ID')
  const observedAt = normalizeTimestamp(context.observedAt ?? new Date().toISOString(), 'scan time')
  const observations = new Map<string, WormholeSignatureObservation>()

  for (const row of rows) {
    if (row.kind !== 'signature') continue
    const signatureId = row.id.trim().toUpperCase()
    if (!SIGNATURE_ID.test(signatureId)) continue
    const searchable = [row.group, row.type ?? '', row.name ?? ''].join(' ')
    if (!WORMHOLE_WORD.test(searchable)) continue

    const codeMatch = WORMHOLE_CODE.exec([row.type ?? '', row.name ?? ''].join(' '))
    const candidate: WormholeSignatureObservation = {
      sourceSystemNodeId,
      signatureId,
      group: cleanText(row.group) || 'Cosmic Signature',
      typeName: nullableText(row.type),
      wormholeCode: codeMatch?.[0].toUpperCase() ?? null,
      name: nullableText(row.name),
      signalStrength: validSignal(row.signal),
      distanceMeters: validDistance(row.distance?.meters),
      observedAt
    }
    const previous = observations.get(signatureId)
    if (!previous || (candidate.signalStrength ?? -1) > (previous.signalStrength ?? -1)) {
      observations.set(signatureId, candidate)
    }
  }

  return [...observations.values()].sort((left, right) => (
    left.signatureId.localeCompare(right.signatureId, 'en-US')
  ))
}

/** Parse EVE's English or Russian wormhole description into explicit states. */
export function parseWormholeStatusText(rawText: string): WormholeStatusReading {
  const text = cleanText(rawText).toLocaleLowerCase('en-US')
  const evidence: string[] = []
  let massStatus: WormholeMassStatus = 'unknown'
  let lifeStatus: WormholeLifeStatus = 'unknown'

  const collapsed = matchEvidence(text, [
    /(?:has\s+collapsed|wormhole\s+collapsed|collapsed\s+wormhole)/iu,
    /(?:червоточин\S*\s+схлопнул|червоточин\S*\s+закрыл|пространствен\S*\s+разрыв\S*\s+закрыл)/iu
  ])
  if (collapsed) {
    evidence.push(collapsed)
    return { massStatus: 'collapsed', lifeStatus: 'collapsed', evidence }
  }

  const criticalMass = matchEvidence(text, [
    /(?:stability\s+(?:has\s+been\s+)?critically\s+disrupted|critically\s+disrupted\s+by\s+ships)/iu,
    /(?:стабильност\S*\s+критическ\S*\s+наруш|критическ\S*\s+наруш\S*\s+стабильност)/iu
  ])
  const reducedMass = matchEvidence(text, [
    /(?:stability\s+(?:has\s+been\s+)?reduced|stability\s+significantly\s+disrupted)/iu,
    /(?:стабильност\S*\s+(?:значительн\S*\s+)?снижен|стабильност\S*\s+нарушен)/iu
  ])
  const stableMass = matchEvidence(text, [
    /(?:(?:stability\s+(?:has\s+)?not\s+yet\s+(?:been\s+)?significantly\s+disrupted)|(?:not\s+yet\s+had\s+its\s+stability\s+significantly\s+disrupted))/iu,
    /(?:стабильност\S*\s+(?:еще\s+|ещё\s+)?не\s+(?:была\s+)?значительн\S*\s+наруш)/iu
  ])
  if (criticalMass) {
    massStatus = 'critical'
    evidence.push(criticalMass)
  } else if (stableMass) {
    massStatus = 'stable'
    evidence.push(stableMass)
  } else if (reducedMass) {
    massStatus = 'reduced'
    evidence.push(reducedMass)
  }

  const endOfLife = matchEvidence(text, [
    /(?:beginning\s+to\s+decay|reaching\s+the\s+end\s+of\s+its\s+natural\s+lifetime|won't\s+last\s+another\s+day|will\s+not\s+last\s+another\s+day)/iu,
    /(?:начинает\s+распад|заканчивает\S*\s+естественн\S*\s+цикл|не\s+просуществует\S*\s+и\s+дня|менее\s+суток)/iu
  ])
  const stableLife = matchEvidence(text, [
    /(?:not\s+yet\s+begun\s+to\s+decay|probably\s+won't\s+for\s+at\s+least\s+another\s+day|probably\s+will\s+not\s+for\s+at\s+least\s+another\s+day)/iu,
    /(?:еще\s+не\s+начал\S*\s+распад|ещё\s+не\s+начал\S*\s+распад|просуществует\S*\s+более\s+суток)/iu
  ])
  if (endOfLife) {
    lifeStatus = 'end-of-life'
    evidence.push(endOfLife)
  } else if (stableLife) {
    lifeStatus = 'stable'
    evidence.push(stableLife)
  }

  return { massStatus, lifeStatus, evidence }
}

/** Safest available route wins; number of jumps breaks equal-risk ties. */
export function findWormholeRouteHome(
  chain: WormholeChain,
  startSystemNodeId: string,
  at: string = new Date().toISOString()
): WormholeHomeRoute | null {
  const start = cleanIdentifier(startSystemNodeId, 'Current-system ID')
  const timestamp = Date.parse(normalizeTimestamp(at, 'route time'))
  const systems = new Map(chain.systems.map((system) => [system.id, system]))
  if (!systems.has(start)) return null
  const homes = new Set(chain.systems.filter((system) => system.isHome).map((system) => system.id))
  if (homes.size === 0) return null
  if (homes.has(start)) {
    return {
      homeSystemNodeId: start,
      systemNodeIds: [start],
      connectionIds: [],
      jumps: 0,
      riskScore: 0,
      risk: 'safe',
      warnings: []
    }
  }

  const adjacency = new Map<string, Array<{ next: string; connection: WormholeConnection }>>()
  for (const connection of chain.connections) {
    if (!systems.has(connection.fromSystemNodeId) || !systems.has(connection.toSystemNodeId)) continue
    if (!isWormholeConnectionUsable(connection, timestamp)) continue
    pushEdge(adjacency, connection.fromSystemNodeId, connection.toSystemNodeId, connection)
    pushEdge(adjacency, connection.toSystemNodeId, connection.fromSystemNodeId, connection)
  }

  interface SearchState {
    systemNodeId: string
    systemNodeIds: string[]
    connectionIds: string[]
    riskScore: number
    warnings: string[]
  }
  const queue: SearchState[] = [{
    systemNodeId: start,
    systemNodeIds: [start],
    connectionIds: [],
    riskScore: 0,
    warnings: []
  }]
  const best = new Map<string, { riskScore: number; jumps: number }>()
  best.set(start, { riskScore: 0, jumps: 0 })

  while (queue.length > 0) {
    queue.sort(compareSearchState)
    const current = queue.shift()!
    if (homes.has(current.systemNodeId)) {
      return {
        homeSystemNodeId: current.systemNodeId,
        systemNodeIds: current.systemNodeIds,
        connectionIds: current.connectionIds,
        jumps: current.connectionIds.length,
        riskScore: current.riskScore,
        risk: routeRisk(current.riskScore),
        warnings: current.warnings
      }
    }

    for (const edge of adjacency.get(current.systemNodeId) ?? []) {
      const edgeRisk = connectionRisk(edge.connection)
      const nextRisk = current.riskScore + edgeRisk.score
      const nextJumps = current.connectionIds.length + 1
      const previous = best.get(edge.next)
      if (previous && compareCost(previous, { riskScore: nextRisk, jumps: nextJumps }) <= 0) continue
      best.set(edge.next, { riskScore: nextRisk, jumps: nextJumps })
      queue.push({
        systemNodeId: edge.next,
        systemNodeIds: [...current.systemNodeIds, edge.next],
        connectionIds: [...current.connectionIds, edge.connection.id],
        riskScore: nextRisk,
        warnings: [...current.warnings, ...edgeRisk.warnings]
      })
    }
  }

  return null
}

export function isWormholeConnectionUsable(
  connection: WormholeConnection,
  at: number | string = Date.now()
): boolean {
  if (connection.massStatus === 'collapsed' || connection.lifeStatus === 'collapsed') return false
  const timestamp = typeof at === 'number' ? at : Date.parse(at)
  if (!Number.isFinite(timestamp)) throw new TypeError('Invalid connection-check time')
  return connection.expiresAt === null || Date.parse(connection.expiresAt) > timestamp
}

function connectionRisk(connection: WormholeConnection): { score: number; warnings: string[] } {
  let score = 0
  const warnings: string[] = []
  if (connection.massStatus === 'critical') {
    score += 8
    warnings.push(`${connection.id}: critical mass`)
  } else if (connection.massStatus === 'reduced') {
    score += 2
    warnings.push(`${connection.id}: reduced mass`)
  } else if (connection.massStatus === 'unknown') {
    score += 1
    warnings.push(`${connection.id}: mass unknown`)
  }
  if (connection.lifeStatus === 'end-of-life') {
    score += 8
    warnings.push(`${connection.id}: end of life`)
  } else if (connection.lifeStatus === 'unknown') {
    score += 1
    warnings.push(`${connection.id}: lifetime unknown`)
  }
  return { score, warnings }
}

function compareSearchState(
  left: { riskScore: number; connectionIds: string[] },
  right: { riskScore: number; connectionIds: string[] }
): number {
  return compareCost(
    { riskScore: left.riskScore, jumps: left.connectionIds.length },
    { riskScore: right.riskScore, jumps: right.connectionIds.length }
  )
}

function compareCost(
  left: { riskScore: number; jumps: number },
  right: { riskScore: number; jumps: number }
): number {
  return left.riskScore - right.riskScore || left.jumps - right.jumps
}

function routeRisk(score: number): WormholeHomeRoute['risk'] {
  if (score === 0) return 'safe'
  return score <= 4 ? 'caution' : 'dangerous'
}

function pushEdge(
  adjacency: Map<string, Array<{ next: string; connection: WormholeConnection }>>,
  source: string,
  next: string,
  connection: WormholeConnection
): void {
  const edges = adjacency.get(source) ?? []
  edges.push({ next, connection })
  adjacency.set(source, edges)
}

function matchEvidence(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return match[0]
  }
  return null
}

function validSignal(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null
}

function validDistance(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function cleanIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid field: ${label}`)
  const result = cleanText(value)
  if (!result || result.length > 128) throw new TypeError(`Invalid field: ${label}`)
  return result
}

function nullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const result = cleanText(value)
  return result || null
}

function cleanText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Invalid field: ${label}`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid field: ${label}`)
  return new Date(parsed).toISOString()
}
