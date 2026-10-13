import { describe, expect, it } from 'vitest'
import {
  parseKillAlertPollRequest,
  toPublicKillAlertPollResponse
} from '../src/main/kill-alert-ipc'
import type { KillAlertPollResult } from '../src/main/kill-alert-service'

const CURRENT = 30_000_142
const ADJACENT = 30_000_144

describe('parseKillAlertPollRequest', () => {
  it('accepts only a bounded, unique system set containing the current system', () => {
    expect(parseKillAlertPollRequest({
      systemIds: [ADJACENT, CURRENT],
      currentSystemId: CURRENT,
      maxEvents: 50
    })).toEqual({
      systemIds: [ADJACENT, CURRENT],
      currentSystemId: CURRENT,
      maxEvents: 50
    })
    expect(parseKillAlertPollRequest({
      systemIds: [CURRENT],
      currentSystemId: CURRENT
    })).toEqual({ systemIds: [CURRENT], currentSystemId: CURRENT })
  })

  it.each([
    null,
    [],
    {},
    { systemIds: [CURRENT] },
    { systemIds: [CURRENT], currentSystemId: CURRENT, extra: true },
    { systemIds: [], currentSystemId: CURRENT },
    { systemIds: Array.from({ length: 257 }, (_, index) => CURRENT + index), currentSystemId: CURRENT },
    { systemIds: [CURRENT, CURRENT], currentSystemId: CURRENT },
    { systemIds: [CURRENT, 0], currentSystemId: CURRENT },
    { systemIds: [CURRENT, 1.5], currentSystemId: CURRENT },
    { systemIds: [CURRENT, Number.MAX_SAFE_INTEGER + 1], currentSystemId: CURRENT },
    { systemIds: [CURRENT], currentSystemId: ADJACENT },
    { systemIds: [CURRENT], currentSystemId: CURRENT, maxEvents: 0 },
    { systemIds: [CURRENT], currentSystemId: CURRENT, maxEvents: 51 },
    { systemIds: [CURRENT], currentSystemId: CURRENT, maxEvents: 1.5 }
  ])('rejects invalid input %#', (input) => {
    expect(() => parseKillAlertPollRequest(input)).toThrow()
  })

  it('rejects sparse system arrays', () => {
    const systems = new Array<number>(2)
    systems[0] = CURRENT
    expect(() => parseKillAlertPollRequest({
      systemIds: systems,
      currentSystemId: CURRENT
    })).toThrow('empty entries')
  })
})

describe('toPublicKillAlertPollResponse', () => {
  it('projects an explicit renderer allowlist and strips all request metadata', () => {
    const internal: KillAlertPollResult = {
      alerts: [{
        killmailId: 700_001,
        sequenceId: 900_001,
        solarSystemId: CURRENT,
        systemScope: 'current',
        occurredAt: '2026-08-21T17:55:00.000Z',
        uploadedAt: '2026-08-21T17:56:00.000Z',
        observedAt: '2026-08-21T18:00:00.000Z',
        reportDelayMs: 60_000,
        historicalBackfill: false,
        victim: {
          characterId: 90_001,
          corporationId: 98_001,
          allianceId: null,
          shipTypeId: 11_978,
          shipTypeName: null
        },
        attackers: [],
        ships: {
          victimShipTypeId: 11_978,
          capsuleerAttackerShipTypeIds: [],
          npcAttackerShipTypeIds: []
        },
        totalValue: 80_000_000,
        provenance: {
          source: 'zKillboard R2Z2',
          access: 'public',
          temporal: 'reported-killmail',
          liveOccupancyAvailable: false
        }
      }],
      nextPollMs: 6_000,
      warnings: [],
      connected: true,
      nextSequenceId: 900_002,
      fetchedEvents: 1,
      duplicateEvents: 0,
      filteredEvents: 0,
      invalidEvents: 0,
      requests: [{
        status: 200,
        requestedAt: '2026-08-21T17:59:59.000Z',
        completedAt: '2026-08-21T18:00:00.000Z',
        retryAfterMs: null,
        rateLimit: {
          documentedLimitPerSecond: 15,
          responseLimit: 15,
          responseRemaining: 14,
          responseResetAt: null
        }
      }]
    }

    const response = toPublicKillAlertPollResponse(internal)
    const serialized = JSON.stringify(response)

    expect(response).toMatchObject({
      connected: true,
      nextSequenceId: 900_002,
      alerts: [{ killmailId: 700_001, systemScope: 'current' }]
    })
    expect(response).not.toHaveProperty('requests')
    expect(serialized).not.toContain('requestedAt')
    expect(serialized).not.toContain('rateLimit')
    expect(response.alerts).not.toBe(internal.alerts)
  })
})
