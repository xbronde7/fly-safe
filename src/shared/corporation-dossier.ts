import { classifyDscanShipRoles } from './clipboard-intel'
import type { CombatHistoryAttacker, CombatHistoryEntry } from './types'
import type {
  GangPilotRole,
  GangRoleObservation,
  GangShipObservation,
  GangSystemObservation,
  GangUtcHourObservation
} from './gang-intelligence'

export const CORPORATION_DOSSIER_LIMITS = {
  pilots: 100,
  ships: 50,
  shipsPerPilot: 8,
  systems: 25
} as const

export interface CorporationSelector {
  corporationId?: number
  corporationName?: string
}

export interface CorporationDossierOptions {
  pilotLimit?: number
  shipLimit?: number
  systemLimit?: number
}

export interface CorporationObservedPilot {
  characterId: number
  name: string | null
  corporationName: string | null
  allianceId: number | null
  allianceName: string | null
  attackKillmails: number
  losses: number
  finalBlows: number
  lastSeen: string
  ships: GangShipObservation[]
  roles: GangRoleObservation[]
  activeUtcHours: GangUtcHourObservation[]
  systems: GangSystemObservation[]
}

export interface CorporationObservedShip {
  typeId: number
  name: string | null
  attackerObservations: number
  lossObservations: number
  totalObservations: number
  roles: GangPilotRole[]
  lastSeen: string
}

export interface CorporationDossier {
  corporationId: number | null
  corporationName: string | null
  /** Explicitly a sample of public killmails, never a member roster. */
  provenance: {
    source: 'public-killmail-sample'
    isRoster: false
    statement: string
  }
  sample: {
    killmailsReceived: number
    killmailsInvolvingCorporation: number
    firstSeen: string | null
    lastSeen: string | null
    attackersMayBeIncomplete: boolean
    /** CombatHistoryEntry has victim corporation name but no victim corporation ID. */
    lossesMayBeIncomplete: boolean
  }
  activity: {
    attackKillmails: number
    lossKillmails: number
    finalBlows: number
    iskDestroyed: number
    iskDestroyedKillmails: number
    iskLost: number
    iskLostKillmails: number
  }
  observedPilots: CorporationObservedPilot[]
  observedPilotsCapped: boolean
  observedShips: CorporationObservedShip[]
  observedShipsCapped: boolean
  activeUtcHours: GangUtcHourObservation[]
  systems: GangSystemObservation[]
}

interface MutablePilot {
  name: string | null
  corporationName: string | null
  allianceId: number | null
  allianceName: string | null
  attackKillmailIds: Set<number>
  lossKillmailIds: Set<number>
  finalBlowKillmailIds: Set<number>
  lastSeen: string
  ships: Map<string, MutablePilotShip>
  roleKillmails: Map<GangPilotRole, Set<number>>
  hours: Map<number, number>
  systems: Map<number, MutableSystem>
}

interface MutablePilotShip {
  typeId: number | null
  name: string | null
  count: number
  roles: GangPilotRole[]
  lastSeen: string
}

interface MutableShip {
  typeId: number
  name: string | null
  attackerObservations: number
  lossObservations: number
  roles: GangPilotRole[]
  lastSeen: string
}

interface MutableSystem {
  solarSystemId: number
  solarSystemName: string | null
  count: number
  lastSeen: string
}

/**
 * Aggregates only pilots and activity observed in the supplied public killmail
 * sample. It deliberately does not infer the corporation's complete roster.
 */
export function buildCorporationDossier(
  history: readonly CombatHistoryEntry[],
  selector: CorporationSelector,
  options: CorporationDossierOptions = {}
): CorporationDossier {
  if (!Array.isArray(history)) throw new TypeError('Killmail history must be an array')
  const requestedId = selector?.corporationId === undefined
    ? null
    : positiveInteger(selector.corporationId, 'Corporation ID')
  const requestedName = selector?.corporationName === undefined
    ? null
    : requiredText(selector.corporationName, 256, 'corporation name')
  if (requestedId === null && requestedName === null) {
    throw new TypeError('Provide a corporation ID or name')
  }

  const pilotLimit = limitOption(
    options.pilotLimit,
    CORPORATION_DOSSIER_LIMITS.pilots,
    CORPORATION_DOSSIER_LIMITS.pilots,
    'pilot limit'
  )
  const shipLimit = limitOption(
    options.shipLimit,
    CORPORATION_DOSSIER_LIMITS.ships,
    CORPORATION_DOSSIER_LIMITS.ships,
    'ship limit'
  )
  const systemLimit = limitOption(
    options.systemLimit,
    CORPORATION_DOSSIER_LIMITS.systems,
    CORPORATION_DOSSIER_LIMITS.systems,
    'system limit'
  )
  const normalizedRequestedName = normalizeName(requestedName)

  const uniqueHistory = new Map<number, CombatHistoryEntry>()
  for (const entry of history) {
    if (isUsableEntry(entry) && !uniqueHistory.has(entry.killmailId)) {
      uniqueHistory.set(entry.killmailId, entry)
    }
  }

  const pilots = new Map<number, MutablePilot>()
  const ships = new Map<number, MutableShip>()
  const systems = new Map<number, MutableSystem>()
  const hours = new Map<number, number>()
  const involvingTimes: string[] = []
  const attackKillmailIds = new Set<number>()
  const lossKillmailIds = new Set<number>()
  const finalBlowKillmailIds = new Set<number>()
  const iskDestroyedKillmailIds = new Set<number>()
  const iskLostKillmailIds = new Set<number>()
  let iskDestroyed = 0
  let iskLost = 0
  let attackersMayBeIncomplete = false
  let resolvedName = requestedName
  let resolvedId = requestedId

  for (const entry of uniqueHistory.values()) {
    const corporationAttackers = uniqueAttackers(entry.attackers).filter((attacker) =>
      attackerMatches(attacker, requestedId, normalizedRequestedName)
    )
    const victimMatches = normalizedRequestedName !== null &&
      normalizeName(entry.victimCorporationName) === normalizedRequestedName
    const involved = corporationAttackers.length > 0 || victimMatches
    if (!involved) continue

    involvingTimes.push(entry.time)
    increment(hours, utcHour(entry.time))
    addSystem(systems, entry)
    attackersMayBeIncomplete ||= entry.attackersCapped

    if (corporationAttackers.length > 0) {
      attackKillmailIds.add(entry.killmailId)
      if (entry.totalValue !== null && !iskDestroyedKillmailIds.has(entry.killmailId)) {
        iskDestroyedKillmailIds.add(entry.killmailId)
        iskDestroyed += entry.totalValue
      }
      for (const attacker of corporationAttackers) {
        resolvedId ??= attacker.corporationId
        resolvedName ??= attacker.corporationName
        addAttackerPilot(pilots, attacker, entry)
        if (attacker.finalBlow) finalBlowKillmailIds.add(entry.killmailId)
        if (attacker.shipTypeId !== null) {
          addShip(ships, attacker.shipTypeId, attacker.shipName, 'attack', entry.time)
        }
      }
    }

    if (victimMatches) {
      lossKillmailIds.add(entry.killmailId)
      if (entry.totalValue !== null && !iskLostKillmailIds.has(entry.killmailId)) {
        iskLostKillmailIds.add(entry.killmailId)
        iskLost += entry.totalValue
      }
      if (entry.victimCharacterId !== null) addVictimPilot(pilots, entry)
      addShip(
        ships,
        entry.victimFit.shipTypeId,
        entry.victimFit.shipName ?? null,
        'loss',
        entry.time
      )
    }
  }

  const allPilots = [...pilots.entries()]
    .map(([characterId, pilot]) => finalizePilot(characterId, pilot))
    .sort((left, right) =>
      (right.attackKillmails + right.losses) - (left.attackKillmails + left.losses) ||
      Date.parse(right.lastSeen) - Date.parse(left.lastSeen) ||
      (left.name ?? String(left.characterId)).localeCompare(
        right.name ?? String(right.characterId),
        'ru'
      )
    )
  const allShips = [...ships.values()]
    .map((ship): CorporationObservedShip => ({
      ...ship,
      totalObservations: ship.attackerObservations + ship.lossObservations
    }))
    .sort((left, right) =>
      right.totalObservations - left.totalObservations ||
      Date.parse(right.lastSeen) - Date.parse(left.lastSeen) ||
      (left.name ?? '').localeCompare(right.name ?? '', 'en-US')
    )

  return {
    corporationId: resolvedId,
    corporationName: resolvedName,
    provenance: {
      source: 'public-killmail-sample',
      isRoster: false,
      statement: 'Observations are limited to the supplied sample of public killmails; this is not a complete corporation roster.'
    },
    sample: {
      killmailsReceived: uniqueHistory.size,
      killmailsInvolvingCorporation: new Set([
        ...attackKillmailIds,
        ...lossKillmailIds
      ]).size,
      firstSeen: involvingTimes.length > 0 ? oldest(involvingTimes) : null,
      lastSeen: involvingTimes.length > 0 ? newest(involvingTimes) : null,
      attackersMayBeIncomplete,
      lossesMayBeIncomplete: requestedName === null
    },
    activity: {
      attackKillmails: attackKillmailIds.size,
      lossKillmails: lossKillmailIds.size,
      finalBlows: finalBlowKillmailIds.size,
      iskDestroyed,
      iskDestroyedKillmails: iskDestroyedKillmailIds.size,
      iskLost,
      iskLostKillmails: iskLostKillmailIds.size
    },
    observedPilots: allPilots.slice(0, pilotLimit),
    observedPilotsCapped: allPilots.length > pilotLimit,
    observedShips: allShips.slice(0, shipLimit),
    observedShipsCapped: allShips.length > shipLimit,
    activeUtcHours: finalizeHours(hours),
    systems: finalizeSystems(systems, systemLimit)
  }
}

function addAttackerPilot(
  pilots: Map<number, MutablePilot>,
  attacker: CombatHistoryAttacker,
  entry: CombatHistoryEntry
): void {
  const pilot = getOrCreatePilot(pilots, attacker.characterId, entry.time, {
    name: attacker.name,
    corporationName: attacker.corporationName,
    allianceId: attacker.allianceId,
    allianceName: attacker.allianceName
  })
  if (pilot.attackKillmailIds.has(entry.killmailId)) return

  pilot.attackKillmailIds.add(entry.killmailId)
  if (attacker.finalBlow) pilot.finalBlowKillmailIds.add(entry.killmailId)
  updatePilotIdentity(pilot, entry.time, attacker)
  increment(pilot.hours, utcHour(entry.time))
  addSystem(pilot.systems, entry)
  const roles = classifyRoles(attacker.shipName)
  for (const role of roles) {
    let roleKillmails = pilot.roleKillmails.get(role)
    if (!roleKillmails) {
      roleKillmails = new Set()
      pilot.roleKillmails.set(role, roleKillmails)
    }
    roleKillmails.add(entry.killmailId)
  }
  addPilotShip(pilot.ships, attacker.shipTypeId, attacker.shipName, roles, entry.time)
}

function addVictimPilot(pilots: Map<number, MutablePilot>, entry: CombatHistoryEntry): void {
  const characterId = entry.victimCharacterId!
  const pilot = getOrCreatePilot(pilots, characterId, entry.time, {
    name: entry.victimName,
    corporationName: entry.victimCorporationName,
    allianceId: null,
    allianceName: null
  })
  if (pilot.lossKillmailIds.has(entry.killmailId)) return
  pilot.lossKillmailIds.add(entry.killmailId)
  if (Date.parse(entry.time) >= Date.parse(pilot.lastSeen)) {
    pilot.lastSeen = entry.time
    pilot.name = entry.victimName ?? pilot.name
    pilot.corporationName = entry.victimCorporationName ?? pilot.corporationName
  }
  increment(pilot.hours, utcHour(entry.time))
  addSystem(pilot.systems, entry)
  const roles = classifyRoles(entry.victimFit.shipName ?? null)
  for (const role of roles) {
    let roleKillmails = pilot.roleKillmails.get(role)
    if (!roleKillmails) {
      roleKillmails = new Set()
      pilot.roleKillmails.set(role, roleKillmails)
    }
    roleKillmails.add(entry.killmailId)
  }
  addPilotShip(
    pilot.ships,
    entry.victimFit.shipTypeId,
    entry.victimFit.shipName ?? null,
    roles,
    entry.time
  )
}

function getOrCreatePilot(
  pilots: Map<number, MutablePilot>,
  characterId: number,
  time: string,
  identity: Pick<MutablePilot, 'name' | 'corporationName' | 'allianceId' | 'allianceName'>
): MutablePilot {
  let pilot = pilots.get(characterId)
  if (!pilot) {
    pilot = {
      ...identity,
      attackKillmailIds: new Set(),
      lossKillmailIds: new Set(),
      finalBlowKillmailIds: new Set(),
      lastSeen: time,
      ships: new Map(),
      roleKillmails: new Map(),
      hours: new Map(),
      systems: new Map()
    }
    pilots.set(characterId, pilot)
  }
  return pilot
}

function updatePilotIdentity(
  pilot: MutablePilot,
  time: string,
  attacker: CombatHistoryAttacker
): void {
  if (Date.parse(time) < Date.parse(pilot.lastSeen)) return
  pilot.lastSeen = time
  pilot.name = attacker.name ?? pilot.name
  pilot.corporationName = attacker.corporationName ?? pilot.corporationName
  pilot.allianceId = attacker.allianceId ?? pilot.allianceId
  pilot.allianceName = attacker.allianceName ?? pilot.allianceName
}

function addPilotShip(
  ships: Map<string, MutablePilotShip>,
  typeId: number | null,
  name: string | null,
  roles: GangPilotRole[],
  time: string
): void {
  const key = typeId !== null ? `id:${typeId}` : `name:${normalizeName(name) ?? 'unknown'}`
  const ship = ships.get(key)
  if (ship) {
    ship.count += 1
    if (Date.parse(time) >= Date.parse(ship.lastSeen)) {
      ship.lastSeen = time
      ship.name = name ?? ship.name
    }
  } else {
    ships.set(key, { typeId, name, count: 1, roles, lastSeen: time })
  }
}

function addShip(
  ships: Map<number, MutableShip>,
  typeId: number,
  name: string | null,
  role: 'attack' | 'loss',
  time: string
): void {
  const ship = ships.get(typeId)
  if (ship) {
    ship[role === 'attack' ? 'attackerObservations' : 'lossObservations'] += 1
    if (Date.parse(time) >= Date.parse(ship.lastSeen)) {
      ship.lastSeen = time
      ship.name = name ?? ship.name
    }
  } else {
    ships.set(typeId, {
      typeId,
      name,
      attackerObservations: role === 'attack' ? 1 : 0,
      lossObservations: role === 'loss' ? 1 : 0,
      roles: classifyRoles(name),
      lastSeen: time
    })
  }
}

function finalizePilot(characterId: number, pilot: MutablePilot): CorporationObservedPilot {
  return {
    characterId,
    name: pilot.name,
    corporationName: pilot.corporationName,
    allianceId: pilot.allianceId,
    allianceName: pilot.allianceName,
    attackKillmails: pilot.attackKillmailIds.size,
    losses: pilot.lossKillmailIds.size,
    finalBlows: pilot.finalBlowKillmailIds.size,
    lastSeen: pilot.lastSeen,
    ships: [...pilot.ships.values()]
      .sort((left, right) =>
        right.count - left.count ||
        Date.parse(right.lastSeen) - Date.parse(left.lastSeen) ||
        (left.name ?? '').localeCompare(right.name ?? '', 'en-US')
      )
      .slice(0, CORPORATION_DOSSIER_LIMITS.shipsPerPilot),
    roles: [...pilot.roleKillmails.entries()]
      .map(([role, killmails]) => ({ role, count: killmails.size }))
      .sort((left, right) => right.count - left.count || left.role.localeCompare(right.role)),
    activeUtcHours: finalizeHours(pilot.hours),
    systems: finalizeSystems(pilot.systems, CORPORATION_DOSSIER_LIMITS.systems)
  }
}

function attackerMatches(
  attacker: CombatHistoryAttacker,
  corporationId: number | null,
  normalizedName: string | null
): boolean {
  if (corporationId !== null && attacker.corporationId === corporationId) return true
  if (corporationId !== null && attacker.corporationId !== null) return false
  return normalizedName !== null && normalizeName(attacker.corporationName) === normalizedName
}

function uniqueAttackers(attackers: readonly CombatHistoryAttacker[]): CombatHistoryAttacker[] {
  const byId = new Map<number, CombatHistoryAttacker>()
  for (const attacker of attackers) {
    const current = byId.get(attacker.characterId)
    if (!current || attacker.damageDone > current.damageDone) byId.set(attacker.characterId, attacker)
  }
  return [...byId.values()]
}

function classifyRoles(shipName: string | null): GangPilotRole[] {
  if (!shipName) return ['damage']
  const specialized = classifyDscanShipRoles(shipName)
  return specialized.length > 0 ? specialized : ['damage']
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

function finalizeHours(hours: Map<number, number>): GangUtcHourObservation[] {
  return [...hours.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((left, right) => right.count - left.count || left.hour - right.hour)
}

function finalizeSystems(
  systems: Map<number, MutableSystem>,
  limit: number
): GangSystemObservation[] {
  return [...systems.values()]
    .sort((left, right) =>
      right.count - left.count ||
      Date.parse(right.lastSeen) - Date.parse(left.lastSeen) ||
      left.solarSystemId - right.solarSystemId
    )
    .slice(0, limit)
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

function normalizeName(value: string | null | undefined): string | null {
  const normalized = value?.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
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

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return value
}

function requiredText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid field: ${label}`)
  const trimmed = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!trimmed || trimmed.length > maxLength) throw new TypeError(`Invalid field: ${label}`)
  return trimmed
}

function limitOption(
  value: unknown,
  fallback: number,
  maximum: number,
  label: string
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return value
}
