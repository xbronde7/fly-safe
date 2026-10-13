import type { KillAlertPollResponse } from '../shared/kill-alert'
import type { UniverseName } from './esi-client'

export function collectKillAlertTypeIds(response: KillAlertPollResponse): number[] {
  const ids = new Set<number>()
  for (const alert of response.alerts) {
    ids.add(alert.victim.shipTypeId)
    for (const attacker of alert.attackers) {
      if (attacker.shipTypeId !== null) ids.add(attacker.shipTypeId)
    }
  }
  return [...ids]
}

/** Adds display names without mutating the allowlisted IPC response. */
export function enrichKillAlertShipNames(
  response: KillAlertPollResponse,
  names: readonly UniverseName[]
): KillAlertPollResponse {
  const byId = new Map(names.map((entry) => [entry.id, entry.name]))
  return {
    ...response,
    alerts: response.alerts.map((alert) => ({
      ...alert,
      victim: {
        ...alert.victim,
        shipTypeName: byId.get(alert.victim.shipTypeId) ?? alert.victim.shipTypeName
      },
      attackers: alert.attackers.map((attacker) => ({
        ...attacker,
        shipTypeName: attacker.shipTypeId === null
          ? attacker.shipTypeName
          : byId.get(attacker.shipTypeId) ?? attacker.shipTypeName
      })),
      ships: {
        ...alert.ships,
        capsuleerAttackerShipTypeIds: [...alert.ships.capsuleerAttackerShipTypeIds],
        npcAttackerShipTypeIds: [...alert.ships.npcAttackerShipTypeIds]
      },
      provenance: { ...alert.provenance }
    }))
  }
}
