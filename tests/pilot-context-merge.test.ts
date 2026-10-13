import { describe, expect, it } from 'vitest'
import { enrichScanWithPilotContext } from '../src/main/pilot-context-merge'
import type { PilotContext } from '../src/shared/pilot-context'
import type { PilotIntel, ScanResult } from '../src/shared/types'

function pilot(overrides: Partial<PilotIntel> & Pick<PilotIntel, 'id' | 'name'>): PilotIntel {
  return {
    corporationId: null,
    corporationName: null,
    allianceId: null,
    allianceName: null,
    factionId: null,
    stats: null,
    threatScore: 0,
    threatLevel: 'unknown',
    reasons: [],
    zkillUrl: `https://zkillboard.com/character/${overrides.id}/`,
    cached: false,
    error: null,
    ...overrides
  }
}

describe('enrichScanWithPilotContext', () => {
  it('adds fleet/contact badges and warnings without mutating the scan', () => {
    const source: ScanResult = {
      scannedAt: '2026-08-21T18:00:00Z',
      pilots: [
        pilot({ id: 90_001, name: 'Direct Red', corporationId: 98_001 }),
        pilot({ id: 90_002, name: 'Corp Blue', corporationId: 98_001 })
      ],
      unresolvedNames: [],
      warnings: ['public warning'],
      summary: {
        total: 2,
        resolved: 2,
        dangerous: 0,
        unknown: 2,
        cached: 0,
        durationMs: 10,
        corporationGroups: []
      }
    }
    const context: PilotContext = {
      characterId: 90_999,
      contacts: {
        entries: [
          {
            id: 90_001,
            type: 'character',
            name: 'Direct Red',
            standing: -10,
            labelIds: [1],
            labelNames: ['Red'],
            watched: true,
            blocked: false
          },
          {
            id: 98_001,
            type: 'corporation',
            name: 'Blue Corp',
            standing: 5,
            labelIds: [2],
            labelNames: ['Blue'],
            watched: false,
            blocked: false
          }
        ],
        labels: [{ id: 1, name: 'Red' }, { id: 2, name: 'Blue' }],
        cached: false
      },
      fleet: {
        fleetId: 777,
        fleetBossId: 90_999,
        ownRole: 'squad_member',
        ownWingId: null,
        ownSquadId: null,
        membersAvailable: true,
        cached: false,
        members: [{
          characterId: 90_002,
          characterName: 'Corp Blue',
          shipTypeId: 11_978,
          shipTypeName: 'Astero',
          solarSystemId: 30_000_142,
          solarSystemName: 'Jita',
          stationId: null,
          role: 'squad_member',
          roleName: 'Squad Member',
          wingId: null,
          squadId: null,
          joinedAt: '2026-08-21T17:00:00Z',
          takesFleetWarp: true
        }]
      },
      fetchedAt: '2026-08-21T18:00:01Z',
      partial: true,
      warnings: ['labels partially unavailable'],
      provenance: {
        access: 'authenticated',
        fleetRoster: 'friendly-only',
        localRosterAvailable: false
      }
    }

    const result = enrichScanWithPilotContext(source, context)

    expect(result.pilots[0].relationship).toMatchObject({
      fleet: false,
      standingClass: 'negative',
      matchedContactType: 'character',
      labelNames: ['Red']
    })
    expect(result.pilots[1].relationship).toMatchObject({
      fleet: true,
      standingClass: 'positive',
      matchedContactType: 'corporation',
      labelNames: ['Blue']
    })
    expect(result.warnings).toEqual([
      'public warning',
      'Pilot Context: labels partially unavailable'
    ])
    expect(source.pilots.every((item) => item.relationship === undefined)).toBe(true)
    expect(source.warnings).toEqual(['public warning'])
  })
})
