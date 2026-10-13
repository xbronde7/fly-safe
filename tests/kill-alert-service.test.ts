import { describe, expect, it, vi } from 'vitest'
import { KillAlertService } from '../src/main/kill-alert-service'
import { R2z2Client } from '../src/main/r2z2-client'
import { parseR2z2Killmail } from '../src/shared/kill-alert'

const CURRENT_SYSTEM_ID = 30_000_142
const ADJACENT_SYSTEM_ID = 30_000_144
const OTHER_SYSTEM_ID = 30_002_365
const NOW = Date.parse('2026-08-21T12:00:00Z')

function envelope(options: {
  sequenceId: number
  killmailId: number
  solarSystemId: number
  occurredAt?: string
  uploadedAt?: number
}): unknown {
  return {
    sequence_id: options.sequenceId,
    killmail_id: options.killmailId,
    hash: 'a'.repeat(40),
    uploaded_at: options.uploadedAt ?? NOW / 1_000,
    esi: {
      killmail_id: options.killmailId,
      killmail_time: options.occurredAt ?? '2026-08-21T11:58:00Z',
      solar_system_id: options.solarSystemId,
      victim: {
        character_id: 90_001,
        corporation_id: 98_001,
        ship_type_id: 11_978
      },
      attackers: [
        {
          character_id: 90_002,
          corporation_id: 98_002,
          alliance_id: 99_002,
          ship_type_id: 17_918,
          final_blow: true
        },
        {
          corporation_id: 1_000_125,
          ship_type_id: 37_556,
          final_blow: false
        }
      ]
    },
    zkb: { totalValue: 123_456_789 }
  }
}

function streamFetch(records: Map<number, unknown>): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/sequence.json')) {
      return new Response(JSON.stringify({ sequence: Math.min(...records.keys()) }), { status: 200 })
    }
    const match = url.match(/\/(\d+)\.json$/)
    const sequenceId = match ? Number(match[1]) : Number.NaN
    return records.has(sequenceId)
      ? new Response(JSON.stringify(records.get(sequenceId)), { status: 200 })
      : new Response('{}', { status: 404 })
  })
}

function service(
  records: Map<number, unknown>,
  options: {
    initialSequenceId?: number
    dedupeCapacity?: number
    replayCapacity?: number
    replayTtlMs?: number
    now?: () => number
  } = {}
): KillAlertService {
  const now = options.now ?? (() => NOW)
  const client = new R2z2Client({
    baseUrl: 'https://r2z2.test/ephemeral',
    fetch: streamFetch(records),
    clock: { now, sleep: async () => undefined }
  })
  return new KillAlertService(client, {
    ...options,
    clock: { now }
  })
}

describe('R2Z2 kill alert parsing', () => {
  it('classifies victim, capsuleer attacker, and NPC attacker ships from raw ESI', () => {
    const parsed = parseR2z2Killmail(envelope({
      sequenceId: 100,
      killmailId: 1_000,
      solarSystemId: CURRENT_SYSTEM_ID
    }))

    expect(parsed).toMatchObject({
      killmailId: 1_000,
      solarSystemId: CURRENT_SYSTEM_ID,
      victim: { shipTypeId: 11_978, shipTypeName: null },
      ships: {
        victimShipTypeId: 11_978,
        capsuleerAttackerShipTypeIds: [17_918],
        npcAttackerShipTypeIds: [37_556]
      }
    })
    expect(parsed?.attackers).toEqual([
      expect.objectContaining({ shipTypeId: 17_918, shipTypeName: null, capsuleer: true }),
      expect.objectContaining({ shipTypeId: 37_556, shipTypeName: null, capsuleer: false })
    ])
  })
})

describe('KillAlertService', () => {
  it('filters current and adjacent systems and labels each scope', async () => {
    const records = new Map<number, unknown>([
      [100, envelope({ sequenceId: 100, killmailId: 1_000, solarSystemId: CURRENT_SYSTEM_ID })],
      [101, envelope({ sequenceId: 101, killmailId: 1_001, solarSystemId: ADJACENT_SYSTEM_ID })],
      [102, envelope({ sequenceId: 102, killmailId: 1_002, solarSystemId: OTHER_SYSTEM_ID })]
    ])
    const alerts = service(records, { initialSequenceId: 100 })

    const result = await alerts.pollOnce({
      systemIds: [CURRENT_SYSTEM_ID, ADJACENT_SYSTEM_ID],
      maxEvents: 4
    })

    expect(result).toMatchObject({
      connected: true,
      nextSequenceId: 103,
      nextPollMs: 6_000,
      fetchedEvents: 3,
      filteredEvents: 1,
      duplicateEvents: 0,
      invalidEvents: 0
    })
    expect(result.alerts.map((alert) => [alert.killmailId, alert.systemScope])).toEqual([
      [1_000, 'current'],
      [1_001, 'adjacent']
    ])
    expect(result.alerts[0].provenance).toEqual({
      source: 'zKillboard R2Z2',
      access: 'public',
      temporal: 'reported-killmail',
      liveOccupancyAvailable: false
    })
  })

  it('serializes changed targets and replays an event consumed inside the prior batch once', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const requestedSequences: number[] = []
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const match = String(input).match(/\/(\d+)\.json$/)
      const sequenceId = match ? Number(match[1]) : Number.NaN
      requestedSequences.push(sequenceId)
      if (sequenceId === 700) {
        await firstGate
        return new Response(JSON.stringify(envelope({
          sequenceId,
          killmailId: 7_000,
          solarSystemId: CURRENT_SYSTEM_ID
        })), { status: 200 })
      }
      if (sequenceId === 701) {
        return new Response(JSON.stringify(envelope({
          sequenceId,
          killmailId: 7_001,
          solarSystemId: ADJACENT_SYSTEM_ID
        })), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    const client = new R2z2Client({
      baseUrl: 'https://r2z2.test/ephemeral',
      fetch: fetchMock,
      clock: { now: () => NOW, sleep: async () => undefined }
    })
    const alerts = new KillAlertService(client, {
      initialSequenceId: 700,
      clock: { now: () => NOW }
    })

    const first = alerts.pollOnce({
      systemIds: [CURRENT_SYSTEM_ID],
      currentSystemId: CURRENT_SYSTEM_ID,
      maxEvents: 3
    })
    const second = alerts.pollOnce({
      systemIds: [ADJACENT_SYSTEM_ID],
      currentSystemId: ADJACENT_SYSTEM_ID,
      maxEvents: 2
    })
    const sameSecond = alerts.pollOnce({
      systemIds: [ADJACENT_SYSTEM_ID],
      currentSystemId: ADJACENT_SYSTEM_ID,
      maxEvents: 2
    })
    expect(sameSecond).toBe(second)

    releaseFirst()
    await expect(first).resolves.toMatchObject({
      alerts: [expect.objectContaining({ killmailId: 7_000, systemScope: 'current' })],
      nextSequenceId: 702,
      filteredEvents: 1
    })
    await expect(second).resolves.toMatchObject({
      alerts: [expect.objectContaining({ killmailId: 7_001, systemScope: 'current' })],
      nextSequenceId: 702
    })

    const replayConsumed = await alerts.pollOnce({
      systemIds: [ADJACENT_SYSTEM_ID],
      currentSystemId: ADJACENT_SYSTEM_ID,
      maxEvents: 2
    })
    expect(replayConsumed.alerts).toEqual([])
    expect(requestedSequences).toEqual([700, 701, 702, 702, 702])
  })

  it('expires unmatched replay records after a strict TTL', async () => {
    let nowMs = NOW
    const records = new Map<number, unknown>([
      [800, envelope({
        sequenceId: 800,
        killmailId: 8_000,
        solarSystemId: ADJACENT_SYSTEM_ID
      })]
    ])
    const alerts = service(records, {
      initialSequenceId: 800,
      replayTtlMs: 50,
      now: () => nowMs
    })

    const buffered = await alerts.pollOnce({
      systemIds: [CURRENT_SYSTEM_ID],
      maxEvents: 2
    })
    expect(buffered).toMatchObject({
      alerts: [],
      nextSequenceId: 801,
      filteredEvents: 1
    })

    nowMs += 50
    const expired = await alerts.pollOnce({
      systemIds: [ADJACENT_SYSTEM_ID],
      maxEvents: 2
    })
    expect(expired.alerts).toEqual([])
  })

  it('evicts the oldest unmatched record when replay capacity is reached', async () => {
    const records = new Map<number, unknown>([
      [900, envelope({
        sequenceId: 900,
        killmailId: 9_000,
        solarSystemId: ADJACENT_SYSTEM_ID
      })],
      [901, envelope({
        sequenceId: 901,
        killmailId: 9_001,
        solarSystemId: OTHER_SYSTEM_ID
      })]
    ])
    const alerts = service(records, {
      initialSequenceId: 900,
      replayCapacity: 1
    })

    await expect(alerts.pollOnce({
      systemIds: [CURRENT_SYSTEM_ID],
      maxEvents: 3
    })).resolves.toMatchObject({ filteredEvents: 2, nextSequenceId: 902 })

    const evicted = await alerts.pollOnce({
      systemIds: [ADJACENT_SYSTEM_ID],
      maxEvents: 1
    })
    expect(evicted.alerts).toEqual([])

    const retained = await alerts.pollOnce({
      systemIds: [OTHER_SYSTEM_ID],
      maxEvents: 1
    })
    expect(retained.alerts).toEqual([
      expect.objectContaining({ killmailId: 9_001, systemScope: 'current' })
    ])
  })

  it('deduplicates repeated killmail IDs across sequences with a bounded set', async () => {
    const firstRecords = new Map<number, unknown>([
      [200, envelope({ sequenceId: 200, killmailId: 2_000, solarSystemId: CURRENT_SYSTEM_ID })],
      [201, envelope({ sequenceId: 201, killmailId: 2_000, solarSystemId: CURRENT_SYSTEM_ID })]
    ])
    const alerts = service(firstRecords, { initialSequenceId: 200, dedupeCapacity: 2 })

    const first = await alerts.pollOnce({ systemIds: [CURRENT_SYSTEM_ID], maxEvents: 3 })
    expect(first.alerts.map((alert) => alert.killmailId)).toEqual([2_000])
    expect(first.duplicateEvents).toBe(1)

    // A separate stream exercises eviction: 2000, 2001, 2002 fills a capacity-2
    // set, so a later replay of 2000 is accepted again rather than growing memory.
    const evictionRecords = new Map<number, unknown>([
      [300, envelope({ sequenceId: 300, killmailId: 2_000, solarSystemId: CURRENT_SYSTEM_ID })],
      [301, envelope({ sequenceId: 301, killmailId: 2_001, solarSystemId: CURRENT_SYSTEM_ID })],
      [302, envelope({ sequenceId: 302, killmailId: 2_002, solarSystemId: CURRENT_SYSTEM_ID })],
      [303, envelope({ sequenceId: 303, killmailId: 2_000, solarSystemId: CURRENT_SYSTEM_ID })]
    ])
    const bounded = service(evictionRecords, { initialSequenceId: 300, dedupeCapacity: 2 })
    const evicted = await bounded.pollOnce({ systemIds: [CURRENT_SYSTEM_ID], maxEvents: 5 })
    expect(evicted.alerts.map((alert) => alert.killmailId)).toEqual([2_000, 2_001, 2_002, 2_000])
  })

  it('uses occurrence time, not fresh upload time, for historical-backfill status', async () => {
    const records = new Map<number, unknown>([
      [400, envelope({
        sequenceId: 400,
        killmailId: 4_000,
        solarSystemId: CURRENT_SYSTEM_ID,
        occurredAt: '2024-01-01T00:00:00Z',
        uploadedAt: NOW / 1_000
      })]
    ])
    const alerts = service(records, { initialSequenceId: 400 })

    const result = await alerts.pollOnce({ systemIds: [CURRENT_SYSTEM_ID], maxEvents: 2 })

    expect(result.alerts[0]).toMatchObject({
      occurredAt: '2024-01-01T00:00:00.000Z',
      uploadedAt: new Date(NOW).toISOString(),
      historicalBackfill: true
    })
    expect(result.alerts[0].reportDelayMs).toBe(NOW - Date.parse('2024-01-01T00:00:00Z'))
    expect(result.warnings).toEqual([
      expect.stringContaining('not live occupancy')
    ])
  })

  it('supports caller-driven start, stop, and connected retry metadata', async () => {
    const alerts = service(new Map(), { initialSequenceId: 500 })
    alerts.stop()

    const stopped = await alerts.pollOnce({ systemIds: [CURRENT_SYSTEM_ID] })
    expect(stopped).toMatchObject({ connected: false, nextPollMs: 0, alerts: [] })

    alerts.start()
    const caughtUp = await alerts.pollOnce({ systemIds: [CURRENT_SYSTEM_ID] })
    expect(caughtUp).toMatchObject({ connected: true, nextPollMs: 6_000, alerts: [] })
    expect(caughtUp.requests[0]).toMatchObject({ status: 404, retryAfterMs: null })
  })
})
