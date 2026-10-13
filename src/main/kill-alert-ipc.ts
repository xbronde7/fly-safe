import type { KillAlertPollResult } from './kill-alert-service'
import type {
  KillAlert,
  KillAlertPollRequest,
  KillAlertPollResponse
} from '../shared/kill-alert'

const ALLOWED_KEYS = new Set(['systemIds', 'currentSystemId', 'maxEvents'])

/** Strict untrusted-IPC validator. No implicit dedupe or current-system fallback. */
export function parseKillAlertPollRequest(value: unknown): KillAlertPollRequest {
  if (!isRecord(value)) throw new TypeError('Invalid kill-alert request')
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key !== 'string' || !ALLOWED_KEYS.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, 'systemIds') ||
    !Object.prototype.hasOwnProperty.call(value, 'currentSystemId')
  ) {
    throw new TypeError('Kill-alert request contains unknown or missing fields')
  }

  const rawSystemIds = value.systemIds
  if (!Array.isArray(rawSystemIds) || rawSystemIds.length < 1 || rawSystemIds.length > 256) {
    throw new RangeError('systemIds must contain from 1 to 256 systems')
  }

  const systemIds: number[] = []
  for (let index = 0; index < rawSystemIds.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(rawSystemIds, index)) {
      throw new TypeError('systemIds must not contain empty entries')
    }
    const systemId = rawSystemIds[index]
    if (!isPositiveSafeInteger(systemId)) {
      throw new TypeError('systemIds must contain positive safe-integer IDs')
    }
    systemIds.push(systemId)
  }
  if (new Set(systemIds).size !== systemIds.length) {
    throw new TypeError('systemIds must contain unique IDs')
  }

  const currentSystemId = value.currentSystemId
  if (!isPositiveSafeInteger(currentSystemId) || !systemIds.includes(currentSystemId)) {
    throw new TypeError('currentSystemId must be included in systemIds')
  }

  const maxEvents = Object.prototype.hasOwnProperty.call(value, 'maxEvents')
    ? value.maxEvents
    : undefined
  if (
    maxEvents !== undefined &&
    (!Number.isSafeInteger(maxEvents) || (maxEvents as number) < 1 || (maxEvents as number) > 50)
  ) {
    throw new RangeError('maxEvents must be a whole number from 1 to 50')
  }

  return maxEvents === undefined
    ? { systemIds, currentSystemId }
    : { systemIds, currentSystemId, maxEvents: maxEvents as number }
}

/** Explicit allowlist projection: request/rate-limit metadata cannot reach renderer. */
export function toPublicKillAlertPollResponse(
  result: KillAlertPollResult
): KillAlertPollResponse {
  return {
    alerts: result.alerts.map(cloneAlert),
    nextPollMs: result.nextPollMs,
    warnings: [...result.warnings],
    connected: result.connected,
    nextSequenceId: result.nextSequenceId,
    fetchedEvents: result.fetchedEvents,
    duplicateEvents: result.duplicateEvents,
    filteredEvents: result.filteredEvents,
    invalidEvents: result.invalidEvents
  }
}

function cloneAlert(alert: KillAlert): KillAlert {
  return {
    ...alert,
    victim: { ...alert.victim },
    attackers: alert.attackers.map((attacker) => ({ ...attacker })),
    ships: {
      victimShipTypeId: alert.ships.victimShipTypeId,
      capsuleerAttackerShipTypeIds: [...alert.ships.capsuleerAttackerShipTypeIds],
      npcAttackerShipTypeIds: [...alert.ships.npcAttackerShipTypeIds]
    },
    provenance: { ...alert.provenance }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
