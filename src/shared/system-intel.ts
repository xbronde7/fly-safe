export const SYSTEM_INTEL_LIMITS = {
  latestKillmails: 25,
  observedShips: 100,
  observedPilots: 50,
  observedShipPilots: 100,
  observedShipOccurrences: 100,
  pilotShipTypes: 8,
  zkillPageSize: 200
} as const

export type SystemDangerLevel = 'critical' | 'high' | 'medium' | 'low' | 'unknown'

export interface SystemMetadata {
  id: number
  name: string
  securityStatus: number
  securityClass: string | null
  constellationId: number
  constellationName: string | null
  regionId: number | null
  regionName: string | null
  isWormhole: boolean
}

/** Public aggregate counters. ESI does not expose a live system roster. */
export interface SystemLastHourActivity {
  shipKills: number | null
  podKills: number | null
  npcKills: number | null
  jumps: number | null
  source: 'ESI'
  access: 'public'
  temporal: 'historical'
}

export interface SystemKillmailObservation {
  killmailId: number
  time: string
  solarSystemId: number
  victimCharacterId: number | null
  victimName: string | null
  victimShipTypeId: number
  victimShipName: string | null
  attackerCount: number
  capsuleerAttackerCount: number
  totalValue: number | null
}

export interface SystemObservedShip {
  typeId: number
  name: string | null
  victimCount: number
  attackerCount: number
  lastSeen: string
  /** Capsuleers tied to this exact hull by public killmails in the sampled window. */
  pilots: SystemObservedShipPilot[]
  pilotsCapped: boolean
  /** Exact public killmail participations for this hull in the sampled window. */
  occurrences: SystemObservedShipOccurrence[]
  occurrencesCapped: boolean
}

export interface SystemObservedShipOccurrence {
  killmailId: number
  time: string
  solarSystemId: number
  role: 'attacker' | 'victim'
  pilotCharacterId: number
  pilotName: string | null
  finalBlow: boolean
  victimCharacterId: number | null
  victimName: string | null
  victimShipTypeId: number
  victimShipName: string | null
  totalValue: number | null
}

export interface SystemObservedShipPilot {
  characterId: number
  name: string | null
  victimCount: number
  attackerCount: number
  finalBlowCount: number
  lastAttackerSeen: string | null
  lastVictimSeen: string | null
  lastSeen: string
}

export interface SystemObservedPilot {
  characterId: number
  name: string | null
  victimCount: number
  attackerCount: number
  finalBlowCount: number
  shipTypeIds: number[]
  lastSeen: string
}

export interface SystemZkillHistory {
  count: number | null
  latest: SystemKillmailObservation[]
  /** True when zKill returned a full 200-row page, so older rows may be missing. */
  sourceCapped: boolean
  /** True when `latest` is shorter than the parsed source sample. */
  latestCapped: boolean
  /** @deprecated Compatibility aggregate. Prefer `sourceCapped` and `latestCapped`. */
  capped: boolean
  observedShips: SystemObservedShip[]
  observedShipsCapped: boolean
  observedPilots: SystemObservedPilot[]
  observedPilotsCapped: boolean
  source: 'zKillboard'
  access: 'public'
  temporal: 'historical'
}

export interface SystemDangerFactor {
  code: 'zkill-24h' | 'ship-kills-1h' | 'pod-kills-1h' | 'kill-density' | 'security'
  points: number
  reason: string
}

export interface SystemDangerAssessment {
  score: number
  level: SystemDangerLevel
  reasons: string[]
  factors: SystemDangerFactor[]
}

export interface SystemIntel {
  system: SystemMetadata
  lastHour: SystemLastHourActivity
  zkill24h: SystemZkillHistory
  danger: SystemDangerAssessment
  fetchedAt: string
  cached: boolean
  warnings: string[]
  /** Explicit provenance: observations are public and historical, never a live roster. */
  provenance: {
    access: 'public'
    temporal: 'historical'
    liveRosterAvailable: false
  }
}

export interface SystemIntelRequest {
  solarSystemId: number
  forceRefresh?: boolean
}

export interface ParsedSystemAttacker {
  characterId: number | null
  shipTypeId: number | null
  finalBlow: boolean
}

export interface ParsedSystemKillmail {
  killmailId: number
  time: string
  solarSystemId: number
  victimCharacterId: number | null
  victimShipTypeId: number
  attackers: ParsedSystemAttacker[]
  totalValue: number | null
}

export interface SystemHistoryFacts {
  count: number
  latest: SystemKillmailObservation[]
  /** True when the upstream zKill page reached its 200-row boundary. */
  sourceCapped: boolean
  /** True when the local `latest` presentation limit removed rows. */
  latestCapped: boolean
  /** @deprecated Compatibility aggregate. Prefer `sourceCapped` and `latestCapped`. */
  capped: boolean
  observedShips: SystemObservedShip[]
  observedShipsCapped: boolean
  observedPilots: SystemObservedPilot[]
  observedPilotsCapped: boolean
  invalidCount: number
}

export interface SystemHistoryLimits {
  latestKillmails?: number
  observedShips?: number
  observedPilots?: number
  observedShipPilots?: number
  observedShipOccurrences?: number
  pilotShipTypes?: number
}

export interface SystemDangerInput {
  securityStatus: number
  isWormhole: boolean
  shipKills: number | null
  podKills: number | null
  jumps: number | null
  zkill24hCount: number | null
}

type UnknownRecord = Record<string, unknown>

/** Parses only full killmails; compact zKill references must be hydrated first. */
export function parseSystemKillmail(
  raw: unknown,
  expectedSolarSystemId?: number
): ParsedSystemKillmail | null {
  const killmail = asRecord(raw)
  if (!killmail) return null

  const killmailId = positiveInteger(killmail.killmail_id)
  const solarSystemId = positiveInteger(killmail.solar_system_id)
  const victim = asRecord(killmail.victim)
  const victimShipTypeId = victim ? positiveInteger(victim.ship_type_id) : null
  const rawTime = typeof killmail.killmail_time === 'string'
    ? Date.parse(killmail.killmail_time)
    : Number.NaN

  if (
    killmailId === null ||
    solarSystemId === null ||
    victimShipTypeId === null ||
    !Number.isFinite(rawTime) ||
    (expectedSolarSystemId !== undefined && solarSystemId !== expectedSolarSystemId)
  ) {
    return null
  }

  const attackers = Array.isArray(killmail.attackers)
    ? killmail.attackers.flatMap((rawAttacker): ParsedSystemAttacker[] => {
        const attacker = asRecord(rawAttacker)
        if (!attacker) return []
        return [{
          characterId: positiveInteger(attacker.character_id),
          shipTypeId: positiveInteger(attacker.ship_type_id),
          finalBlow: attacker.final_blow === true
        }]
      })
    : []
  const zkb = asRecord(killmail.zkb)

  return {
    killmailId,
    time: new Date(rawTime).toISOString(),
    solarSystemId,
    victimCharacterId: victim ? positiveInteger(victim.character_id) : null,
    victimShipTypeId,
    attackers,
    totalValue: zkb ? finiteNonNegative(zkb.totalValue) : null
  }
}

export function collectSystemKillmailNameIds(
  killmails: readonly ParsedSystemKillmail[]
): number[] {
  const ids = new Set<number>()
  for (const killmail of killmails) {
    ids.add(killmail.victimShipTypeId)
    if (killmail.victimCharacterId !== null) ids.add(killmail.victimCharacterId)
    for (const attacker of killmail.attackers) {
      if (attacker.characterId !== null) ids.add(attacker.characterId)
      // NPC attackers can have ship_type_id but no character_id. They are not
      // capsuleer sightings and therefore do not belong in the observed fleet.
      if (attacker.characterId !== null && attacker.shipTypeId !== null) {
        ids.add(attacker.shipTypeId)
      }
    }
  }
  return [...ids]
}

export function buildSystemHistoryFacts(
  rawKillmails: readonly unknown[],
  names: ReadonlyMap<number, string> = new Map(),
  expectedSolarSystemId?: number,
  limits: SystemHistoryLimits = {}
): SystemHistoryFacts {
  const parsed = rawKillmails.flatMap((raw) => {
    const killmail = parseSystemKillmail(raw, expectedSolarSystemId)
    return killmail ? [killmail] : []
  })
  return buildParsedSystemHistoryFacts(parsed, names, rawKillmails.length - parsed.length, limits)
}

export function buildParsedSystemHistoryFacts(
  killmails: readonly ParsedSystemKillmail[],
  names: ReadonlyMap<number, string> = new Map(),
  invalidCount = 0,
  limits: SystemHistoryLimits = {}
): SystemHistoryFacts {
  const latestLimit = clampLimit(limits.latestKillmails, SYSTEM_INTEL_LIMITS.latestKillmails)
  const shipsLimit = clampLimit(limits.observedShips, SYSTEM_INTEL_LIMITS.observedShips)
  const pilotsLimit = clampLimit(limits.observedPilots, SYSTEM_INTEL_LIMITS.observedPilots)
  const shipPilotsLimit = clampLimit(
    limits.observedShipPilots,
    SYSTEM_INTEL_LIMITS.observedShipPilots
  )
  const shipOccurrencesLimit = clampLimit(
    limits.observedShipOccurrences,
    SYSTEM_INTEL_LIMITS.observedShipOccurrences
  )
  const pilotShipsLimit = clampLimit(limits.pilotShipTypes, SYSTEM_INTEL_LIMITS.pilotShipTypes)
  const uniqueKillmails = new Map<number, ParsedSystemKillmail>()
  for (const killmail of killmails) {
    if (!uniqueKillmails.has(killmail.killmailId)) {
      uniqueKillmails.set(killmail.killmailId, killmail)
    }
  }
  const sorted = [...uniqueKillmails.values()].sort(
    (left, right) => Date.parse(right.time) - Date.parse(left.time) || right.killmailId - left.killmailId
  )
  const ships = new Map<number, MutableSystemObservedShip>()
  const pilots = new Map<number, SystemObservedPilot & { allShipTypeIds: Set<number> }>()

  for (const killmail of sorted) {
    addShipObservation(
      ships,
      killmail.victimShipTypeId,
      names,
      'victimCount',
      killmail.time,
      killmail.victimCharacterId,
      false
    )
    if (killmail.victimCharacterId !== null) {
      addShipOccurrence(
        ships,
        killmail.victimShipTypeId,
        names,
        killmail,
        'victim',
        killmail.victimCharacterId,
        false
      )
      addPilotObservation(
        pilots,
        killmail.victimCharacterId,
        names,
        'victimCount',
        killmail.victimShipTypeId,
        false,
        killmail.time
      )
    }

    for (const attacker of killmail.attackers) {
      if (attacker.characterId !== null && attacker.shipTypeId !== null) {
        addShipObservation(
          ships,
          attacker.shipTypeId,
          names,
          'attackerCount',
          killmail.time,
          attacker.characterId,
          attacker.finalBlow
        )
        addShipOccurrence(
          ships,
          attacker.shipTypeId,
          names,
          killmail,
          'attacker',
          attacker.characterId,
          attacker.finalBlow
        )
      }
      if (attacker.characterId !== null) {
        addPilotObservation(
          pilots,
          attacker.characterId,
          names,
          'attackerCount',
          attacker.shipTypeId,
          attacker.finalBlow,
          killmail.time
        )
      }
    }
  }

  const allShips = [...ships.values()]
    .map(({ pilotByCharacterId, allOccurrences, ...ship }): SystemObservedShip => {
      const pilots = [...pilotByCharacterId.values()].sort(compareShipPilotObservations)
      const occurrences = [...allOccurrences].sort(compareShipOccurrences)
      return {
        ...ship,
        pilots: pilots.slice(0, shipPilotsLimit),
        pilotsCapped: pilots.length > shipPilotsLimit,
        occurrences: occurrences.slice(0, shipOccurrencesLimit),
        occurrencesCapped: occurrences.length > shipOccurrencesLimit
      }
    })
    .sort(compareObservations)
  const allPilots = [...pilots.values()]
    .map(({ allShipTypeIds, ...pilot }) => ({
      ...pilot,
      shipTypeIds: [...allShipTypeIds].slice(0, pilotShipsLimit)
    }))
    .sort(compareObservations)
  const sourceCapped = killmails.length + Math.max(0, invalidCount) >= SYSTEM_INTEL_LIMITS.zkillPageSize
  const latestCapped = sorted.length > latestLimit

  return {
    count: sorted.length,
    latest: sorted.slice(0, latestLimit).map((killmail) => ({
      killmailId: killmail.killmailId,
      time: killmail.time,
      solarSystemId: killmail.solarSystemId,
      victimCharacterId: killmail.victimCharacterId,
      victimName:
        killmail.victimCharacterId === null
          ? null
          : names.get(killmail.victimCharacterId) ?? null,
      victimShipTypeId: killmail.victimShipTypeId,
      victimShipName: names.get(killmail.victimShipTypeId) ?? null,
      attackerCount: killmail.attackers.length,
      capsuleerAttackerCount: killmail.attackers.filter(
        (attacker) => attacker.characterId !== null
      ).length,
      totalValue: killmail.totalValue
    })),
    sourceCapped,
    latestCapped,
    capped: sourceCapped || latestCapped,
    observedShips: allShips.slice(0, shipsLimit),
    observedShipsCapped: allShips.length > shipsLimit,
    observedPilots: allPilots.slice(0, pilotsLimit),
    observedPilotsCapped: allPilots.length > pilotsLimit,
    invalidCount: Math.max(0, invalidCount)
  }
}

/** Deterministic 0-100 risk score. Raw counters remain separate in SystemIntel. */
export function calculateSystemDanger(input: SystemDangerInput): SystemDangerAssessment {
  const hasCombatActivity = [input.shipKills, input.podKills, input.zkill24hCount]
    .some((value) => value !== null)
  if (!hasCombatActivity) {
    return {
      score: 0,
      level: 'unknown',
      reasons: ['ESI and zKillboard combat sources are unavailable or returned incomplete data'],
      factors: []
    }
  }

  const factors: SystemDangerFactor[] = []
  const add = (factor: SystemDangerFactor): void => {
    if (factor.points > 0) factors.push(factor)
  }
  const zkillCount = nonNegative(input.zkill24hCount)
  const shipKills = nonNegative(input.shipKills)
  const podKills = nonNegative(input.podKills)
  const jumps = nonNegative(input.jumps)

  if (zkillCount > 0) {
    const points = Math.min(35, zkillCount * 3)
    add({
      code: 'zkill-24h',
      points,
      reason: `${zkillCount} public killmails in 24 hours (+${points})`
    })
  }
  if (shipKills > 0) {
    const points = Math.min(25, shipKills * 8)
    add({
      code: 'ship-kills-1h',
      points,
      reason: `${shipKills} ships destroyed in the last hour (+${points})`
    })
  }
  if (podKills > 0) {
    const points = Math.min(15, podKills * 5)
    add({
      code: 'pod-kills-1h',
      points,
      reason: `${podKills} pods destroyed in the last hour (+${points})`
    })
  }
  if (jumps > 0 && shipKills + podKills > 0) {
    const points = Math.min(15, Math.max(1, Math.round(((shipKills + podKills) / jumps) * 50)))
    add({
      code: 'kill-density',
      points,
      reason: `High loss rate relative to ${jumps} jumps (+${points})`
    })
  }

  const securityPoints = input.isWormhole ? 10 : input.securityStatus <= 0 ? 8 : input.securityStatus < 0.5 ? 5 : 0
  if (securityPoints > 0) {
    add({
      code: 'security',
      points: securityPoints,
      reason: input.isWormhole
        ? `Wormhole-space system (+${securityPoints})`
        : `Low security status ${input.securityStatus.toFixed(2)} (+${securityPoints})`
    })
  }

  const score = Math.min(100, factors.reduce((sum, factor) => sum + factor.points, 0))
  const level: SystemDangerLevel =
    score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low'

  return {
    score,
    level,
    reasons: factors.length > 0 ? factors.map((factor) => factor.reason) : ['No public PvP losses found'],
    factors
  }
}

export function isWormholeSystemId(solarSystemId: number): boolean {
  return solarSystemId >= 31_000_001 && solarSystemId < 32_000_000
}

interface MutableSystemObservedShip extends Omit<
  SystemObservedShip,
  'pilots' | 'pilotsCapped' | 'occurrences' | 'occurrencesCapped'
> {
  pilotByCharacterId: Map<number, SystemObservedShipPilot>
  allOccurrences: SystemObservedShipOccurrence[]
}

function addShipObservation(
  observations: Map<number, MutableSystemObservedShip>,
  typeId: number,
  names: ReadonlyMap<number, string>,
  role: 'victimCount' | 'attackerCount',
  time: string,
  characterId: number | null,
  finalBlow: boolean
): void {
  const current = observations.get(typeId) ?? {
    typeId,
    name: names.get(typeId) ?? null,
    victimCount: 0,
    attackerCount: 0,
    lastSeen: time,
    pilotByCharacterId: new Map<number, SystemObservedShipPilot>(),
    allOccurrences: []
  }
  current[role] += 1
  if (Date.parse(time) > Date.parse(current.lastSeen)) current.lastSeen = time
  if (characterId !== null) {
    const pilot = current.pilotByCharacterId.get(characterId) ?? {
      characterId,
      name: names.get(characterId) ?? null,
      victimCount: 0,
      attackerCount: 0,
      finalBlowCount: 0,
      lastAttackerSeen: null,
      lastVictimSeen: null,
      lastSeen: time
    }
    pilot[role] += 1
    if (finalBlow) pilot.finalBlowCount += 1
    if (role === 'attackerCount') {
      if (pilot.lastAttackerSeen === null || Date.parse(time) > Date.parse(pilot.lastAttackerSeen)) {
        pilot.lastAttackerSeen = time
      }
    } else if (pilot.lastVictimSeen === null || Date.parse(time) > Date.parse(pilot.lastVictimSeen)) {
      pilot.lastVictimSeen = time
    }
    if (Date.parse(time) > Date.parse(pilot.lastSeen)) pilot.lastSeen = time
    current.pilotByCharacterId.set(characterId, pilot)
  }
  observations.set(typeId, current)
}

function addShipOccurrence(
  observations: Map<number, MutableSystemObservedShip>,
  typeId: number,
  names: ReadonlyMap<number, string>,
  killmail: ParsedSystemKillmail,
  role: SystemObservedShipOccurrence['role'],
  pilotCharacterId: number,
  finalBlow: boolean
): void {
  const current = observations.get(typeId)
  if (!current) return

  current.allOccurrences.push({
    killmailId: killmail.killmailId,
    time: killmail.time,
    solarSystemId: killmail.solarSystemId,
    role,
    pilotCharacterId,
    pilotName: names.get(pilotCharacterId) ?? null,
    finalBlow,
    victimCharacterId: killmail.victimCharacterId,
    victimName:
      killmail.victimCharacterId === null
        ? null
        : names.get(killmail.victimCharacterId) ?? null,
    victimShipTypeId: killmail.victimShipTypeId,
    victimShipName: names.get(killmail.victimShipTypeId) ?? null,
    totalValue: killmail.totalValue
  })
}

function addPilotObservation(
  observations: Map<number, SystemObservedPilot & { allShipTypeIds: Set<number> }>,
  characterId: number,
  names: ReadonlyMap<number, string>,
  role: 'victimCount' | 'attackerCount',
  shipTypeId: number | null,
  finalBlow: boolean,
  time: string
): void {
  const current = observations.get(characterId) ?? {
    characterId,
    name: names.get(characterId) ?? null,
    victimCount: 0,
    attackerCount: 0,
    finalBlowCount: 0,
    shipTypeIds: [],
    allShipTypeIds: new Set<number>(),
    lastSeen: time
  }
  current[role] += 1
  if (finalBlow) current.finalBlowCount += 1
  if (shipTypeId !== null) current.allShipTypeIds.add(shipTypeId)
  if (Date.parse(time) > Date.parse(current.lastSeen)) current.lastSeen = time
  observations.set(characterId, current)
}

function compareObservations(
  left: Pick<SystemObservedShip, 'victimCount' | 'attackerCount' | 'lastSeen'>,
  right: Pick<SystemObservedShip, 'victimCount' | 'attackerCount' | 'lastSeen'>
): number {
  return (
    right.victimCount + right.attackerCount - left.victimCount - left.attackerCount ||
    Date.parse(right.lastSeen) - Date.parse(left.lastSeen)
  )
}

function compareShipPilotObservations(
  left: SystemObservedShipPilot,
  right: SystemObservedShipPilot
): number {
  return (
    Number(right.attackerCount > 0) - Number(left.attackerCount > 0) ||
    Date.parse(right.lastSeen) - Date.parse(left.lastSeen) ||
    right.attackerCount + right.victimCount - left.attackerCount - left.victimCount ||
    right.finalBlowCount - left.finalBlowCount ||
    (left.name ?? '').localeCompare(right.name ?? '', 'en-US') ||
    left.characterId - right.characterId
  )
}

function compareShipOccurrences(
  left: SystemObservedShipOccurrence,
  right: SystemObservedShipOccurrence
): number {
  return (
    Date.parse(right.time) - Date.parse(left.time) ||
    right.killmailId - left.killmailId ||
    left.role.localeCompare(right.role, 'en-US') ||
    left.pilotCharacterId - right.pilotCharacterId
  )
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function finiteNonNegative(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function nonNegative(value: number | null): number {
  return value !== null && Number.isFinite(value) && value > 0 ? value : 0
}

function clampLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.max(1, Math.floor(value as number)) : fallback
}
