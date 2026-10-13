import { describe, expect, it, vi } from 'vitest'
import type { EncounterSnapshotInput } from '../src/shared/encounter-journal'
import {
  applyPilotRosterSource,
  buildPilotRosterEncounter,
  type PilotRosterObservationCandidate
} from '../src/shared/pilot-roster-observation'
import type { CurrentSystemSnapshot, ScanResult } from '../src/shared/types'

const CAPTURED_AT = '2026-08-26T12:34:56.000Z'

function scanResult(): ScanResult {
  return {
    scannedAt: '2026-08-26T12:35:01.000Z',
    pilots: [{
      id: 90_001,
      name: 'Known Pilot',
      corporationId: 98_001,
      corporationName: 'Known Corp',
      allianceId: null,
      allianceName: null,
      factionId: null,
      stats: null,
      threatScore: 0,
      threatLevel: 'unknown',
      reasons: [],
      zkillUrl: 'https://zkillboard.com/character/90001/',
      cached: false,
      error: null
    }],
    unresolvedNames: ['Unknown Pilot'],
    warnings: [],
    summary: {
      total: 2,
      resolved: 1,
      dangerous: 0,
      unknown: 2,
      cached: 0,
      durationMs: 5,
      corporationGroups: []
    }
  }
}

function systemSnapshot(location = true): CurrentSystemSnapshot {
  return {
    account: {
      configured: true,
      connected: true,
      clientId: 'built-in',
      callbackUri: 'http://localhost:53173/callback',
      characterId: 42,
      characterName: 'Own Pilot',
      scopes: [],
      error: null
    },
    online: true,
    location: location ? { solarSystemId: 30_000_142 } : null,
    ownShip: {
      typeId: 17_918,
      typeName: 'Rattlesnake',
      customName: 'Home Guard'
    },
    intel: location
      ? { system: { id: 30_000_142, name: 'Jita' } } as CurrentSystemSnapshot['intel']
      : null,
    fetchedAt: CAPTURED_AT,
    warnings: []
  }
}

function candidate(location = true): PilotRosterObservationCandidate {
  return {
    capturedAt: CAPTURED_AT,
    systemSnapshot: systemSnapshot(location),
    result: scanResult()
  }
}

describe('pilot roster observation confirmation', () => {
  it('keeps a normal pilot lookup out of the encounter journal', async () => {
    const recordEncounter = vi.fn<(request: EncounterSnapshotInput) => Promise<void>>()

    const decision = await applyPilotRosterSource('lookup', candidate(), recordEncounter)

    expect(decision).toEqual({ recorded: false, reason: 'lookup' })
    expect(recordEncounter).not.toHaveBeenCalled()
  })

  it('records resolved and unresolved pilots only after explicit Local confirmation', async () => {
    const recordEncounter = vi.fn(async (_request: EncounterSnapshotInput) => undefined)

    const decision = await applyPilotRosterSource(
      'confirmed-local',
      candidate(),
      recordEncounter
    )

    expect(decision.recorded).toBe(true)
    expect(recordEncounter).toHaveBeenCalledTimes(1)
    expect(recordEncounter).toHaveBeenCalledWith({
      capturedAt: CAPTURED_AT,
      currentSystem: { solarSystemId: 30_000_142, name: 'Jita' },
      ownShip: { typeId: 17_918, typeName: 'Rattlesnake', customName: 'Home Guard' },
      localPilots: [
        { characterId: 90_001, name: 'Known Pilot', corporationName: 'Known Corp' },
        { characterId: null, name: 'Unknown Pilot', corporationName: null }
      ]
    })
  })

  it('refuses to invent a Local system when location was unavailable at scan time', async () => {
    const recordEncounter = vi.fn(async (_request: EncounterSnapshotInput) => undefined)
    const observation = candidate(false)

    expect(buildPilotRosterEncounter(observation)).toBeNull()
    await expect(
      applyPilotRosterSource('confirmed-local', observation, recordEncounter)
    ).resolves.toEqual({ recorded: false, reason: 'missing-system' })
    expect(recordEncounter).not.toHaveBeenCalled()
  })

  it('excludes the connected character even when ESI leaves that name unresolved', () => {
    const observation = candidate()
    observation.result.pilots.push({
      ...observation.result.pilots[0],
      id: 42,
      name: 'Own Pilot'
    })
    observation.result.unresolvedNames.push('own pilot')

    const request = buildPilotRosterEncounter(observation)

    expect(request?.localPilots).toEqual([
      { characterId: 90_001, name: 'Known Pilot', corporationName: 'Known Corp' },
      { characterId: null, name: 'Unknown Pilot', corporationName: null }
    ])
  })
})
