import {
  classifyDscanShipRoles,
  type DscanShipRole
} from './clipboard-intel'
import type { CombatHistoryAttacker, CombatHistoryEntry } from './types'

export const GANG_INTELLIGENCE_LIMITS = {
  coPilots: 100,
  stableGroups: 50,
  shipsPerPilot: 8,
  systems: 25
} as const

export type GangPilotRole = DscanShipRole | 'damage'

export interface GangIntelligenceOptions {
  /** Minimum exact repetitions before a co-pilot set is called stable. Defaults to 2. */
  minGroupOccurrences?: number
  coPilotLimit?: number
  stableGroupLimit?: number
}

export interface GangShipObservation {
  typeId: number | null
  name: string | null
  count: number
  roles: GangPilotRole[]
  lastSeen: string
}

export interface GangRoleObservation {
  role: GangPilotRole
  count: number
}

export interface GangUtcHourObservation {
  hour: number
  count: number
}

export interface GangSystemObservation {
  solarSystemId: number
  solarSystemName: string | null
  count: number
  lastSeen: string
}

export interface FrequentCoPilot {
  characterId: number
  name: string | null
  corporationId: number | null
  corporationName: string | null
  allianceId: number | null
  allianceName: string | null
  sharedKillmails: number
  shareOfSample: number
  finalBlowCount: number
  lastSeen: string
  ships: GangShipObservation[]
  roles: GangRoleObservation[]
  activeUtcHours: GangUtcHourObservation[]
  systems: GangSystemObservation[]
}

export interface StableGangGroup {
  /** Deterministic sorted capsuleer IDs; the profiled pilot is not repeated here. */
  memberCharacterIds: number[]
  members: Array<Pick<FrequentCoPilot, 'characterId' | 'name' | 'corporationName'>>
  occurrences: number
  shareOfSample: number
  firstSeen: string
  lastSeen: string
  activeUtcHours: GangUtcHourObservation[]
  systems: GangSystemObservation[]
}

export interface GangIntelligence {
  subjectCharacterId: number
  sample: {
    source: 'public-killmail-history'
    killmailsReceived: number
    qualifyingKills: number
    firstSeen: string | null
    lastSeen: string | null
    attackersMayBeIncomplete: boolean
  }
  frequentCoPilots: FrequentCoPilot[]
  frequentCoPilotsCapped: boolean
  stableGroups: StableGangGroup[]
  stableGroupsCapped: boolean
  activeUtcHours: GangUtcHourObservation[]
  systems: GangSystemObservation[]
}

interface MutableCoPilot {
  latest: CombatHistoryAttacker
  killmailIds: Set<number>
  finalBlowKillmailIds: Set<number>
  lastSeen: string
  ships: Map<string, MutableShip>
  roleKillmails: Map<GangPilotRole, Set<number>>
  hours: Map<number, number>
  systems: Map<number, MutableSystem>
}

interface MutableShip {
  typeId: number | null
  name: string | null
  count: number
  roles: GangPilotRole[]
  lastSeen: string
}

interface MutableSystem {
  solarSystemId: number
  solarSystemName: string | null
  count: number
  lastSeen: string
}

interface MutableGroup {
  memberCharacterIds: number[]
  killmailIds: Set<number>
  times: string[]
  hours: Map<number, number>
  systems: Map<number, MutableSystem>
}

/**
 * Derives a pilot's recurring public-killmail companions. Only `kind: "kill"`
 * rows where the subject is a visible attacker qualify: attackers on the
 * subject's losses are enemies, not co-pilots.
 */
export function buildGangIntelligence(
  history: readonly CombatHistoryEntry[],
  subjectCharacterId: number,
  options: GangIntelligenceOptions = {}
): GangIntelligence {
  assertPositiveSafeInteger(subjectCharacterId, 'Pilot ID')
  if (!Array.isArray(history)) throw new TypeError('Killmail history must be an array')

  const minGroupOccurrences = integerOption(
    options.minGroupOccurrences,
    2,
    2,
    100,
    'minimum group repeats'
  )
  const coPilotLimit = integerOption(
    options.coPilotLimit,
    GANG_INTELLIGENCE_LIMITS.coPilots,
    1,
    GANG_INTELLIGENCE_LIMITS.coPilots,
    'attacker limit'
  )
  const stableGroupLimit = integerOption(
    options.stableGroupLimit,
    GANG_INTELLIGENCE_LIMITS.stableGroups,
    1,
    GANG_INTELLIGENCE_LIMITS.stableGroups,
    'group limit'
  )

  const uniqueHistory = new Map<number, CombatHistoryEntry>()
  for (const entry of history) {
    if (isUsableEntry(entry) && !uniqueHistory.has(entry.killmailId)) {
      uniqueHistory.set(entry.killmailId, entry)
    }
  }

  const coPilots = new Map<number, MutableCoPilot>()
  const groups = new Map<string, MutableGroup>()
  const sampleHours = new Map<number, number>()
  const sampleSystems = new Map<number, MutableSystem>()
  const sampleTimes: string[] = []
  let attackersMayBeIncomplete = false
  let qualifyingKills = 0

  for (const entry of uniqueHistory.values()) {
    if (entry.kind !== 'kill') continue
    const subject = entry.attackers.find(({ characterId }) => characterId === subjectCharacterId)
    if (!subject) continue

    qualifyingKills += 1
    attackersMayBeIncomplete ||= entry.attackersCapped
    sampleTimes.push(entry.time)
    increment(sampleHours, utcHour(entry.time))
    addSystem(sampleSystems, entry)

    const companions = uniqueAttackers(entry.attackers)
      .filter(({ characterId }) => characterId !== subjectCharacterId)

    for (const attacker of companions) {
      addCoPilot(coPilots, attacker, entry)
    }

    // An exact repeated set is strong evidence and avoids presenting a loose
    // connected graph as one gang when two unrelated fleets share one pilot.
    // A capped attacker list is partial; treating its visible subset as the
    // complete recurring group would manufacture false certainty.
    if (companions.length >= 2 && !entry.attackersCapped) {
      const memberCharacterIds = companions
        .map(({ characterId }) => characterId)
        .sort((left, right) => left - right)
      const key = memberCharacterIds.join(':')
      let group = groups.get(key)
      if (!group) {
        group = {
          memberCharacterIds,
          killmailIds: new Set(),
          times: [],
          hours: new Map(),
          systems: new Map()
        }
        groups.set(key, group)
      }
      if (!group.killmailIds.has(entry.killmailId)) {
        group.killmailIds.add(entry.killmailId)
        group.times.push(entry.time)
        increment(group.hours, utcHour(entry.time))
        addSystem(group.systems, entry)
      }
    }
  }

  const allCoPilots = [...coPilots.entries()]
    .map(([characterId, value]) => finalizeCoPilot(characterId, value, qualifyingKills))
    .sort(compareCoPilots)
  const visibleCoPilots = allCoPilots.slice(0, coPilotLimit)
  const coPilotById = new Map(allCoPilots.map((pilot) => [pilot.characterId, pilot]))

  const allStableGroups = [...groups.values()]
    .filter((group) => group.killmailIds.size >= minGroupOccurrences)
    .map((group): StableGangGroup => ({
      memberCharacterIds: [...group.memberCharacterIds],
      members: group.memberCharacterIds.map((characterId) => {
        const pilot = coPilotById.get(characterId)
        return {
          characterId,
          name: pilot?.name ?? null,
          corporationName: pilot?.corporationName ?? null
        }
      }),
      occurrences: group.killmailIds.size,
      shareOfSample: ratio(group.killmailIds.size, qualifyingKills),
      firstSeen: oldest(group.times),
      lastSeen: newest(group.times),
      activeUtcHours: finalizeHours(group.hours),
      systems: finalizeSystems(group.systems)
    }))
    .sort((left, right) =>
      right.occurrences - left.occurrences ||
      Date.parse(right.lastSeen) - Date.parse(left.lastSeen) ||
      left.memberCharacterIds.join(':').localeCompare(right.memberCharacterIds.join(':'))
    )

  return {
    subjectCharacterId,
    sample: {
      source: 'public-killmail-history',
      killmailsReceived: uniqueHistory.size,
      qualifyingKills,
      firstSeen: sampleTimes.length > 0 ? oldest(sampleTimes) : null,
      lastSeen: sampleTimes.length > 0 ? newest(sampleTimes) : null,
      attackersMayBeIncomplete
    },
    frequentCoPilots: visibleCoPilots,
    frequentCoPilotsCapped: allCoPilots.length > visibleCoPilots.length,
    stableGroups: allStableGroups.slice(0, stableGroupLimit),
    stableGroupsCapped: allStableGroups.length > stableGroupLimit,
    activeUtcHours: finalizeHours(sampleHours),
    systems: finalizeSystems(sampleSystems)
  }
}

function addCoPilot(
  map: Map<number, MutableCoPilot>,
  attacker: CombatHistoryAttacker,
  entry: CombatHistoryEntry
): void {
  let pilot = map.get(attacker.characterId)
  if (!pilot) {
    pilot = {
      latest: attacker,
      killmailIds: new Set(),
      finalBlowKillmailIds: new Set(),
      lastSeen: entry.time,
      ships: new Map(),
      roleKillmails: new Map(),
      hours: new Map(),
      systems: new Map()
    }
    map.set(attacker.characterId, pilot)
  }

  if (pilot.killmailIds.has(entry.killmailId)) return
  pilot.killmailIds.add(entry.killmailId)
  if (attacker.finalBlow) pilot.finalBlowKillmailIds.add(entry.killmailId)
  if (Date.parse(entry.time) >= Date.parse(pilot.lastSeen)) {
    pilot.lastSeen = entry.time
    pilot.latest = attacker
  }
  increment(pilot.hours, utcHour(entry.time))
  addSystem(pilot.systems, entry)

  const roles = classifyAttackerRoles(attacker)
  for (const role of roles) {
    let killmails = pilot.roleKillmails.get(role)
    if (!killmails) {
      killmails = new Set()
      pilot.roleKillmails.set(role, killmails)
    }
    killmails.add(entry.killmailId)
  }

  const shipKey = attacker.shipTypeId !== null
    ? `id:${attacker.shipTypeId}`
    : `name:${normalizeName(attacker.shipName) ?? 'unknown'}`
  const ship = pilot.ships.get(shipKey)
  if (ship) {
    ship.count += 1
    if (Date.parse(entry.time) >= Date.parse(ship.lastSeen)) {
      ship.lastSeen = entry.time
      ship.name = attacker.shipName ?? ship.name
    }
  } else {
    pilot.ships.set(shipKey, {
      typeId: attacker.shipTypeId,
      name: attacker.shipName,
      count: 1,
      roles,
      lastSeen: entry.time
    })
  }
}

function finalizeCoPilot(
  characterId: number,
  pilot: MutableCoPilot,
  qualifyingKills: number
): FrequentCoPilot {
  return {
    characterId,
    name: pilot.latest.name,
    corporationId: pilot.latest.corporationId,
    corporationName: pilot.latest.corporationName,
    allianceId: pilot.latest.allianceId,
    allianceName: pilot.latest.allianceName,
    sharedKillmails: pilot.killmailIds.size,
    shareOfSample: ratio(pilot.killmailIds.size, qualifyingKills),
    finalBlowCount: pilot.finalBlowKillmailIds.size,
    lastSeen: pilot.lastSeen,
    ships: [...pilot.ships.values()]
      .sort((left, right) =>
        right.count - left.count ||
        Date.parse(right.lastSeen) - Date.parse(left.lastSeen) ||
        (left.name ?? '').localeCompare(right.name ?? '', 'en-US')
      )
      .slice(0, GANG_INTELLIGENCE_LIMITS.shipsPerPilot),
    roles: [...pilot.roleKillmails.entries()]
      .map(([role, killmails]) => ({ role, count: killmails.size }))
      .sort((left, right) => right.count - left.count || left.role.localeCompare(right.role)),
    activeUtcHours: finalizeHours(pilot.hours),
    systems: finalizeSystems(pilot.systems)
  }
}

function classifyAttackerRoles(attacker: CombatHistoryAttacker): GangPilotRole[] {
  if (!attacker.shipName) return ['damage']
  const specialized = classifyDscanShipRoles(attacker.shipName)
  return specialized.length > 0 ? specialized : ['damage']
}

function uniqueAttackers(attackers: readonly CombatHistoryAttacker[]): CombatHistoryAttacker[] {
  const byId = new Map<number, CombatHistoryAttacker>()
  for (const attacker of attackers) {
    const current = byId.get(attacker.characterId)
    if (!current || attacker.damageDone > current.damageDone) byId.set(attacker.characterId, attacker)
  }
  return [...byId.values()]
}

function addSystem(systems: Map<number, MutableSystem>, entry: CombatHistoryEntry): void {
  const system = systems.get(entry.solarSystemId)
  if (system) {
    system.count += 1
    if (Date.parse(entry.time) >= Date.parse(system.lastSeen)) {
      system.lastSeen = entry.time
      system.solarSystemName = entry.solarSystemName ?? system.solarSystemName
    }
  } else {
    systems.set(entry.solarSystemId, {
      solarSystemId: entry.solarSystemId,
      solarSystemName: entry.solarSystemName,
      count: 1,
      lastSeen: entry.time
    })
  }
}

function finalizeSystems(systems: Map<number, MutableSystem>): GangSystemObservation[] {
  return [...systems.values()]
    .sort((left, right) =>
      right.count - left.count ||
      Date.parse(right.lastSeen) - Date.parse(left.lastSeen) ||
      left.solarSystemId - right.solarSystemId
    )
    .slice(0, GANG_INTELLIGENCE_LIMITS.systems)
}

function finalizeHours(hours: Map<number, number>): GangUtcHourObservation[] {
  return [...hours.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((left, right) => right.count - left.count || left.hour - right.hour)
}

function compareCoPilots(left: FrequentCoPilot, right: FrequentCoPilot): number {
  return right.sharedKillmails - left.sharedKillmails ||
    Date.parse(right.lastSeen) - Date.parse(left.lastSeen) ||
    (left.name ?? String(left.characterId)).localeCompare(
      right.name ?? String(right.characterId),
      'ru'
    )
}

function increment(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function utcHour(time: string): number {
  return new Date(time).getUTCHours()
}

function oldest(times: readonly string[]): string {
  return times.reduce((result, time) => Date.parse(time) < Date.parse(result) ? time : result)
}

function newest(times: readonly string[]): string {
  return times.reduce((result, time) => Date.parse(time) > Date.parse(result) ? time : result)
}

function ratio(part: number, total: number): number {
  return total <= 0 ? 0 : Math.round((part / total) * 10_000) / 10_000
}

function normalizeName(value: string | null): string | null {
  const normalized = value?.normalize('NFKC').trim().toLocaleLowerCase('en-US')
  return normalized || null
}

function isUsableEntry(entry: CombatHistoryEntry): boolean {
  return Number.isSafeInteger(entry.killmailId) &&
    entry.killmailId > 0 &&
    Number.isSafeInteger(entry.solarSystemId) &&
    entry.solarSystemId > 0 &&
    Number.isFinite(Date.parse(entry.time)) &&
    Array.isArray(entry.attackers)
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid field: ${label}`)
  }
}

function integerOption(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return value
}
