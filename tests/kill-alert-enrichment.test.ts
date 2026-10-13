import { describe, expect, it } from 'vitest'
import {
  collectKillAlertTypeIds,
  enrichKillAlertShipNames
} from '../src/main/kill-alert-enrichment'
import type { KillAlertPollResponse } from '../src/shared/kill-alert'

function response(): KillAlertPollResponse {
  return {
    alerts: [{
      killmailId: 1,
      sequenceId: 2,
      solarSystemId: 30_000_142,
      systemScope: 'current',
      occurredAt: '2026-08-21T12:00:00.000Z',
      uploadedAt: '2026-08-21T12:01:00.000Z',
      observedAt: '2026-08-21T12:01:01.000Z',
      reportDelayMs: 60_000,
      historicalBackfill: false,
      victim: {
        characterId: 10,
        corporationId: 20,
        allianceId: null,
        shipTypeId: 587,
        shipTypeName: null
      },
      attackers: [{
        characterId: 11,
        corporationId: 21,
        allianceId: null,
        shipTypeId: 11_978,
        shipTypeName: null,
        finalBlow: true,
        capsuleer: true
      }, {
        characterId: null,
        corporationId: null,
        allianceId: null,
        shipTypeId: null,
        shipTypeName: null,
        finalBlow: false,
        capsuleer: false
      }],
      ships: {
        victimShipTypeId: 587,
        capsuleerAttackerShipTypeIds: [11_978],
        npcAttackerShipTypeIds: []
      },
      totalValue: 5_000_000,
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
    nextSequenceId: 3,
    fetchedEvents: 1,
    duplicateEvents: 0,
    filteredEvents: 0,
    invalidEvents: 0
  }
}

describe('kill alert display enrichment', () => {
  it('collects unique non-null type IDs and returns a cloned named response', () => {
    const source = response()
    expect(collectKillAlertTypeIds(source)).toEqual([587, 11_978])

    const enriched = enrichKillAlertShipNames(source, [
      { id: 587, name: 'Rifter', category: 'inventory_type', cached: false },
      { id: 11_978, name: 'Scimitar', category: 'inventory_type', cached: true }
    ])

    expect(enriched.alerts[0].victim.shipTypeName).toBe('Rifter')
    expect(enriched.alerts[0].attackers[0].shipTypeName).toBe('Scimitar')
    expect(source.alerts[0].victim.shipTypeName).toBeNull()
    expect(enriched.alerts[0]).not.toBe(source.alerts[0])
  })
})
