import {
  parseR2z2Killmail,
  toKillAlert,
  type KillAlert,
  type KillAlertPollResponse,
  type ParsedR2z2Killmail
} from '../shared/kill-alert'
import {
  R2Z2_RATE_POLICY,
  R2z2Client,
  R2z2Error,
  type R2z2RequestMetadata
} from './r2z2-client'

const DEFAULT_DEDUPE_CAPACITY = 10_000
const DEFAULT_MAX_EVENTS = 25
const DEFAULT_BACKFILL_THRESHOLD_MS = 30 * 60 * 1_000
const DEFAULT_REPLAY_CAPACITY = 250
const DEFAULT_REPLAY_TTL_MS = 10 * 60 * 1_000

export interface KillAlertServiceClock {
  now(): number
}

export interface KillAlertServiceOptions {
  initialSequenceId?: number
  dedupeCapacity?: number
  backfillThresholdMs?: number
  replayCapacity?: number
  replayTtlMs?: number
  clock?: KillAlertServiceClock
}

export interface KillAlertServicePollRequest {
  /** Current system first when currentSystemId is omitted by trusted main callers. */
  systemIds: readonly number[]
  currentSystemId?: number
  maxEvents?: number
}

export interface KillAlertPollResult extends KillAlertPollResponse {
  requests: R2z2RequestMetadata[]
}

interface NormalizedKillAlertPollRequest {
  targets: KillAlertTargetSet
  maxEvents: number
  key: string
}

interface KillAlertTargetSet {
  systemIds: Set<number>
  currentSystemId: number
}

/**
 * Stateful in-memory R2Z2 cursor and bounded dedupe set. `pollOnce` performs one
 * short batch; the IPC owner controls scheduling using `nextPollMs`.
 */
export class KillAlertService {
  private readonly client: R2z2Client
  private readonly dedupe: BoundedKillmailIds
  private readonly replay: BoundedKillmailReplay
  private readonly backfillThresholdMs: number
  private readonly clock: KillAlertServiceClock
  private nextSequenceId: number | null
  private enabled = true
  private pollQueueTail: Promise<void> = Promise.resolve()
  private readonly pollsByKey = new Map<string, Promise<KillAlertPollResult>>()

  constructor(client: R2z2Client, options: KillAlertServiceOptions = {}) {
    this.client = client
    this.dedupe = new BoundedKillmailIds(options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY)
    this.replay = new BoundedKillmailReplay(
      options.replayCapacity ?? DEFAULT_REPLAY_CAPACITY,
      finiteNonNegative(options.replayTtlMs, DEFAULT_REPLAY_TTL_MS)
    )
    this.backfillThresholdMs = finiteNonNegative(
      options.backfillThresholdMs,
      DEFAULT_BACKFILL_THRESHOLD_MS
    )
    this.clock = options.clock ?? { now: () => Date.now() }
    this.nextSequenceId = options.initialSequenceId ?? null
    if (this.nextSequenceId !== null) validatePositiveInteger(this.nextSequenceId, 'sequence ID')
  }

  /** Resume polling. No background timer is created. */
  start(): void {
    this.enabled = true
  }

  /** Stop future polls. Any already-running network call finishes normally. */
  stop(): void {
    this.enabled = false
  }

  get cursor(): number | null {
    return this.nextSequenceId
  }

  pollOnce(request: KillAlertServicePollRequest): Promise<KillAlertPollResult> {
    const normalized = normalizePollRequest(request)
    const existing = this.pollsByKey.get(normalized.key)
    if (existing) return existing

    const execution = this.pollQueueTail.then(() => this.performPoll(normalized))
    let poll!: Promise<KillAlertPollResult>
    poll = execution.finally(() => {
      if (this.pollsByKey.get(normalized.key) === poll) {
        this.pollsByKey.delete(normalized.key)
      }
    })
    this.pollsByKey.set(normalized.key, poll)
    this.pollQueueTail = poll.then(
      () => undefined,
      () => undefined
    )
    return poll
  }

  private async performPoll(
    request: NormalizedKillAlertPollRequest
  ): Promise<KillAlertPollResult> {
    const { targets, maxEvents } = request

    if (!this.enabled) {
      return emptyPollResult({
        nextSequenceId: this.nextSequenceId,
        connected: false,
        nextPollMs: 0,
        warnings: ['Killmail polling is stopped']
      })
    }

    const alerts: KillAlert[] = []
    let duplicateEvents = 0
    let filteredEvents = 0
    let invalidEvents = 0
    const replayed = this.replay.takeMatching(targets, maxEvents, this.clock.now())
    for (const { killmail, scope } of replayed) {
      if (!this.dedupe.add(killmail.killmailId)) {
        duplicateEvents += 1
        continue
      }
      alerts.push(toKillAlert(killmail, scope, this.clock.now(), this.backfillThresholdMs))
    }

    const discoveryRequests: R2z2RequestMetadata[] = []
    try {
      if (this.nextSequenceId === null) {
        const discovery = await this.client.discoverSequence()
        this.nextSequenceId = discovery.sequenceId
        discoveryRequests.push(discovery.request)
      }

      const fromSequenceId = this.nextSequenceId
      const batch = await this.client.getBatch(fromSequenceId, maxEvents)
      this.nextSequenceId = batch.nextSequenceId

      for (const item of batch.records) {
        const parsed = parseR2z2Killmail(item.record)
        if (!parsed || parsed.sequenceId !== item.sequenceId) {
          invalidEvents += 1
          continue
        }

        if (this.dedupe.has(parsed.killmailId)) {
          duplicateEvents += 1
          continue
        }

        const scope = scopeForTargets(parsed.solarSystemId, targets)
        if (scope === null) {
          filteredEvents += 1
          this.replay.add(parsed, this.clock.now())
          continue
        }
        if (alerts.length >= maxEvents) {
          this.replay.add(parsed, this.clock.now())
          continue
        }

        this.dedupe.add(parsed.killmailId)
        alerts.push(
          toKillAlert(parsed, scope, this.clock.now(), this.backfillThresholdMs)
        )
      }

      const warnings: string[] = []
      if (invalidEvents > 0) warnings.push(`${invalidEvents} invalid R2Z2 event(s) skipped`)
      if (alerts.some((alert) => alert.historicalBackfill)) {
        warnings.push('Historical killmail backfill detected; occurrence time is not live occupancy')
      }

      return {
        alerts,
        nextPollMs: batch.recommendedPollAfterMs,
        warnings,
        connected: true,
        nextSequenceId: this.nextSequenceId,
        fetchedEvents: batch.records.length,
        duplicateEvents,
        filteredEvents,
        invalidEvents,
        requests: [...discoveryRequests, ...batch.requests]
      }
    } catch (error) {
      const retryMs = error instanceof R2z2Error
        ? Math.max(
            R2Z2_RATE_POLICY.minimumNotFoundPollMs,
            error.recommendedRetryAfterMs
          )
        : R2Z2_RATE_POLICY.minimumNotFoundPollMs
      return emptyPollResult({
        alerts,
        nextSequenceId: this.nextSequenceId,
        connected: false,
        nextPollMs: retryMs,
        warnings: [errorMessage(error)],
        duplicateEvents,
        filteredEvents,
        invalidEvents,
        requests: [
          ...discoveryRequests,
          ...(error instanceof R2z2Error && error.request ? [error.request] : [])
        ]
      })
    }
  }
}

function normalizePollRequest(
  request: KillAlertServicePollRequest
): NormalizedKillAlertPollRequest {
  const targets = normalizeTargets(request.systemIds, request.currentSystemId)
  const maxEvents = request.maxEvents ?? DEFAULT_MAX_EVENTS
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 250) {
    throw new RangeError('maxEvents must be an integer from 1 to 250')
  }
  const sortedSystemIds = [...targets.systemIds].sort((left, right) => left - right)
  return {
    targets,
    maxEvents,
    key: `${targets.currentSystemId}|${maxEvents}|${sortedSystemIds.join(',')}`
  }
}

class BoundedKillmailIds {
  private readonly ids = new Set<number>()
  private readonly capacity: number

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
      throw new RangeError('dedupeCapacity must be an integer from 1 to 1000000')
    }
    this.capacity = capacity
  }

  add(killmailId: number): boolean {
    if (this.ids.has(killmailId)) return false
    this.ids.add(killmailId)
    while (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value as number | undefined
      if (oldest === undefined) break
      this.ids.delete(oldest)
    }
    return true
  }

  has(killmailId: number): boolean {
    return this.ids.has(killmailId)
  }
}

class BoundedKillmailReplay {
  private readonly entries = new Map<number, {
    killmail: ParsedR2z2Killmail
    bufferedAtMs: number
  }>()

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
      throw new RangeError('replayCapacity must be an integer from 1 to 10000')
    }
  }

  add(killmail: ParsedR2z2Killmail, nowMs: number): void {
    this.prune(nowMs)
    this.entries.delete(killmail.killmailId)
    this.entries.set(killmail.killmailId, { killmail, bufferedAtMs: nowMs })
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as number | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  takeMatching(
    targets: KillAlertTargetSet,
    limit: number,
    nowMs: number
  ): Array<{ killmail: ParsedR2z2Killmail; scope: KillAlert['systemScope'] }> {
    this.prune(nowMs)
    const matches: Array<{
      killmail: ParsedR2z2Killmail
      scope: KillAlert['systemScope']
    }> = []
    for (const [killmailId, entry] of this.entries) {
      const scope = scopeForTargets(entry.killmail.solarSystemId, targets)
      if (scope === null) continue
      this.entries.delete(killmailId)
      matches.push({ killmail: entry.killmail, scope })
      if (matches.length >= limit) break
    }
    return matches
  }

  private prune(nowMs: number): void {
    for (const [killmailId, entry] of this.entries) {
      const ageMs = Math.max(0, nowMs - entry.bufferedAtMs)
      if (ageMs >= this.ttlMs) this.entries.delete(killmailId)
    }
  }
}

function normalizeTargets(
  rawSystemIds: readonly number[],
  explicitCurrentSystemId?: number
): KillAlertTargetSet {
  const systemIds = new Set<number>()
  for (const systemId of rawSystemIds) {
    validatePositiveInteger(systemId, 'solar system ID')
    systemIds.add(systemId)
  }
  if (systemIds.size === 0) throw new TypeError('At least one solar system ID is required')

  const currentSystemId = explicitCurrentSystemId ?? rawSystemIds[0]
  validatePositiveInteger(currentSystemId, 'current solar system ID')
  if (!systemIds.has(currentSystemId)) {
    throw new TypeError('currentSystemId must be included in systemIds')
  }
  return { systemIds, currentSystemId }
}

function scopeForTargets(
  solarSystemId: number,
  targets: KillAlertTargetSet
): KillAlert['systemScope'] | null {
  if (targets.currentSystemId === solarSystemId) return 'current'
  return targets.systemIds.has(solarSystemId) ? 'adjacent' : null
}

function emptyPollResult(
  overrides: Partial<KillAlertPollResult> = {}
): KillAlertPollResult {
  return {
    alerts: [],
    nextPollMs: R2Z2_RATE_POLICY.minimumNotFoundPollMs,
    warnings: [],
    connected: false,
    nextSequenceId: null,
    fetchedEvents: 0,
    duplicateEvents: 0,
    filteredEvents: 0,
    invalidEvents: 0,
    requests: [],
    ...overrides
  }
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${label}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
