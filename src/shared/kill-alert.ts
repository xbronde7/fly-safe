/**
 * Public killmail observation delivered by zKillboard's R2Z2 stream.
 * It is historical evidence of a reported kill, never evidence of live occupancy.
 */
export interface KillAlert {
  killmailId: number
  sequenceId: number
  solarSystemId: number
  systemScope: 'current' | 'adjacent'
  occurredAt: string
  uploadedAt: string
  observedAt: string
  reportDelayMs: number
  historicalBackfill: boolean
  victim: KillAlertVictim
  attackers: KillAlertAttacker[]
  ships: KillAlertShipClassification
  totalValue: number | null
  provenance: {
    source: 'zKillboard R2Z2'
    access: 'public'
    temporal: 'reported-killmail'
    liveOccupancyAvailable: false
  }
}

/** Renderer-safe bounded poll. The first item need not be the current system. */
export interface KillAlertPollRequest {
  systemIds: number[]
  currentSystemId: number
  /** Defaults to 25. IPC accepts only 1..50. */
  maxEvents?: number
}

/** Public poll result. Network request/rate-limit metadata remains in main. */
export interface KillAlertPollResponse {
  alerts: KillAlert[]
  nextPollMs: number
  warnings: string[]
  connected: boolean
  nextSequenceId: number | null
  fetchedEvents: number
  duplicateEvents: number
  filteredEvents: number
  invalidEvents: number
}

export const KILL_ALERT_POLL_DELAY = {
  minimumMs: 6_000,
  maximumMs: 6 * 60 * 60_000,
  fallbackMs: 6_000
} as const

/** Preserve upstream Retry-After while keeping renderer timers finite and bounded. */
export function normalizeKillAlertPollDelay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return KILL_ALERT_POLL_DELAY.fallbackMs
  }
  return Math.min(
    KILL_ALERT_POLL_DELAY.maximumMs,
    Math.max(KILL_ALERT_POLL_DELAY.minimumMs, Math.round(value))
  )
}

export interface KillAlertParticipant {
  characterId: number | null
  corporationId: number | null
  allianceId: number | null
  shipTypeId: number | null
  /** R2Z2 contains IDs only. Main-process enrichment may fill this later. */
  shipTypeName: string | null
}

export interface KillAlertVictim extends KillAlertParticipant {
  shipTypeId: number
}

export interface KillAlertAttacker extends KillAlertParticipant {
  finalBlow: boolean
  capsuleer: boolean
}

/** Ship IDs are split by killmail side; NPC hulls stay explicitly marked. */
export interface KillAlertShipClassification {
  victimShipTypeId: number
  capsuleerAttackerShipTypeIds: number[]
  npcAttackerShipTypeIds: number[]
}

export interface ParsedR2z2Killmail {
  killmailId: number
  sequenceId: number
  solarSystemId: number
  occurredAt: string
  uploadedAt: string
  victim: KillAlertVictim
  attackers: KillAlertAttacker[]
  ships: KillAlertShipClassification
  totalValue: number | null
}

type UnknownRecord = Record<string, unknown>

/** Parse the documented R2Z2 envelope and its raw `esi` killmail. */
export function parseR2z2Killmail(raw: unknown): ParsedR2z2Killmail | null {
  const envelope = asRecord(raw)
  const esi = envelope ? asRecord(envelope.esi) : null
  if (!envelope || !esi) return null

  const envelopeKillmailId = positiveInteger(envelope.killmail_id)
  const killmailId = positiveInteger(esi.killmail_id)
  const sequenceId = positiveInteger(envelope.sequence_id)
  const solarSystemId = positiveInteger(esi.solar_system_id)
  const victim = asRecord(esi.victim)
  const victimShipTypeId = victim ? positiveInteger(victim.ship_type_id) : null
  const occurrenceTimestamp = isoTimestamp(esi.killmail_time)
  const uploadTimestamp = unixOrIsoTimestamp(envelope.uploaded_at)

  if (
    killmailId === null ||
    (envelopeKillmailId !== null && envelopeKillmailId !== killmailId) ||
    sequenceId === null ||
    solarSystemId === null ||
    victim === null ||
    victimShipTypeId === null ||
    occurrenceTimestamp === null ||
    uploadTimestamp === null
  ) {
    return null
  }

  const attackers = Array.isArray(esi.attackers)
    ? esi.attackers.flatMap((value): KillAlertAttacker[] => {
        const attacker = asRecord(value)
        if (!attacker) return []

        const characterId = positiveInteger(attacker.character_id)
        return [{
          characterId,
          corporationId: positiveInteger(attacker.corporation_id),
          allianceId: positiveInteger(attacker.alliance_id),
          shipTypeId: positiveInteger(attacker.ship_type_id),
          shipTypeName: null,
          finalBlow: attacker.final_blow === true,
          capsuleer: characterId !== null
        }]
      })
    : []
  const zkb = asRecord(envelope.zkb)

  return {
    killmailId,
    sequenceId,
    solarSystemId,
    occurredAt: occurrenceTimestamp,
    uploadedAt: uploadTimestamp,
    victim: {
      characterId: positiveInteger(victim.character_id),
      corporationId: positiveInteger(victim.corporation_id),
      allianceId: positiveInteger(victim.alliance_id),
      shipTypeId: victimShipTypeId,
      shipTypeName: null
    },
    attackers,
    ships: {
      victimShipTypeId,
      capsuleerAttackerShipTypeIds: uniquePositiveIntegers(
        attackers.flatMap((attacker) =>
          attacker.capsuleer && attacker.shipTypeId !== null ? [attacker.shipTypeId] : []
        )
      ),
      npcAttackerShipTypeIds: uniquePositiveIntegers(
        attackers.flatMap((attacker) =>
          !attacker.capsuleer && attacker.shipTypeId !== null ? [attacker.shipTypeId] : []
        )
      )
    },
    totalValue: zkb ? nonNegativeFinite(zkb.totalValue) : null
  }
}

export function toKillAlert(
  killmail: ParsedR2z2Killmail,
  systemScope: KillAlert['systemScope'],
  observedAtMs: number,
  backfillThresholdMs: number
): KillAlert {
  const occurredAtMs = Date.parse(killmail.occurredAt)
  const uploadedAtMs = Date.parse(killmail.uploadedAt)
  const reportDelayMs = Math.max(0, uploadedAtMs - occurredAtMs)

  return {
    ...killmail,
    systemScope,
    observedAt: new Date(observedAtMs).toISOString(),
    reportDelayMs,
    // Fresh upload time must not make an old kill look like a current event.
    historicalBackfill: observedAtMs - occurredAtMs > Math.max(0, backfillThresholdMs),
    provenance: {
      source: 'zKillboard R2Z2',
      access: 'public',
      temporal: 'reported-killmail',
      liveOccupancyAvailable: false
    }
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function nonNegativeFinite(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  return Number.isFinite(number) && number >= 0 ? number : null
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function unixOrIsoTimestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '' && !/^\d+(?:\.\d+)?$/.test(value)) {
    return isoTimestamp(value)
  }

  const raw = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(raw) || raw < 0) return null
  // R2Z2 documents Unix seconds. Milliseconds are accepted defensively.
  const milliseconds = raw >= 100_000_000_000 ? raw : raw * 1_000
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}

function uniquePositiveIntegers(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))]
}
