import type { CombatHistoryEntry, PilotCombatHistory } from './types'

export type LastObservedPilotShipRole = 'attacker' | 'victim'

export interface LastObservedPilotShip {
  typeId: number
  shipName: string | null
  time: string
  solarSystemId: number
  solarSystemName: string | null
  killmailId: number
  role: LastObservedPilotShipRole
  totalValue: number | null
}

interface DatedPilotShip {
  ship: LastObservedPilotShip
  timestamp: number
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function normalizedName(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function candidateFromEntry(
  entry: CombatHistoryEntry,
  role: LastObservedPilotShipRole
): DatedPilotShip | null {
  const typeId = role === 'attacker' ? entry.attackerShipTypeId : entry.victimFit.shipTypeId
  const timestamp = Date.parse(entry.time)

  if (
    typeId === null ||
    !positiveSafeInteger(typeId) ||
    !positiveSafeInteger(entry.killmailId) ||
    !positiveSafeInteger(entry.solarSystemId) ||
    !Number.isFinite(timestamp)
  ) {
    return null
  }

  return {
    timestamp,
    ship: {
      typeId,
      shipName: normalizedName(
        role === 'attacker' ? entry.attackerShipName : entry.victimFit.shipName
      ),
      time: entry.time,
      solarSystemId: entry.solarSystemId,
      solarSystemName: normalizedName(entry.solarSystemName),
      killmailId: entry.killmailId,
      role,
      totalValue: entry.totalValue
    }
  }
}

function newerCandidate(
  current: DatedPilotShip | null,
  candidate: DatedPilotShip | null
): DatedPilotShip | null {
  if (!candidate) return current
  if (!current) return candidate

  if (candidate.timestamp !== current.timestamp) {
    return candidate.timestamp > current.timestamp ? candidate : current
  }

  return candidate.ship.killmailId > current.ship.killmailId ? candidate : current
}

/**
 * Returns the pilot's most recently observed hull from the available public
 * killmail history. This is a historical observation, not the pilot's current
 * in-game ship.
 */
export function selectLastObservedPilotShip(
  history: PilotCombatHistory | null | undefined
): LastObservedPilotShip | null {
  if (!history) return null

  let latest: DatedPilotShip | null = null

  for (const entry of history.kills) {
    if (entry.kind !== 'kill') continue
    latest = newerCandidate(latest, candidateFromEntry(entry, 'attacker'))
  }

  for (const entry of history.losses) {
    if (entry.kind !== 'loss') continue
    latest = newerCandidate(latest, candidateFromEntry(entry, 'victim'))
  }

  return latest?.ship ?? null
}
