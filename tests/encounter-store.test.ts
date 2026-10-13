import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EncounterJournalStore } from '../src/main/encounter-store'
import {
  validateEncounterPilotSearchQuery,
  validateEncounterSnapshotInput
} from '../src/shared/encounter-journal'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('EncounterJournalStore', () => {
  it('persists token-free Local/D-scan snapshots and restores them after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fly-safe-encounters-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'encounters.sqlite')
    const now = Date.parse('2026-08-25T10:00:00.000Z')

    const first = new EncounterJournalStore(databasePath, {}, () => now)
    const saved = first.record({
      capturedAt: '2026-08-25T09:59:00Z',
      currentSystem: { solarSystemId: 30_000_142, name: ' Jita ' },
      ownShip: { typeId: 11_987, typeName: 'Crow', customName: 'Scout' },
      localPilots: [
        { characterId: 101, name: 'Danger Pilot', corporationName: 'Danger Corp' },
        { name: 'Unresolved Pilot' }
      ],
      dscanHulls: [
        { typeId: 22_428, typeName: 'Redeemer' },
        { typeId: 22_428, typeName: 'Redeemer', count: 2 },
        { typeName: 'Scimitar', count: 1 }
      ]
    })
    expect(saved).toEqual({
      id: 1,
      capturedAt: '2026-08-25T09:59:00.000Z',
      recordedAt: '2026-08-25T10:00:00.000Z',
      currentSystem: { solarSystemId: 30_000_142, name: 'Jita' },
      ownShip: { typeId: 11_987, typeName: 'Crow', customName: 'Scout' },
      localPilots: [
        { characterId: 101, name: 'Danger Pilot', corporationName: 'Danger Corp' },
        { characterId: null, name: 'Unresolved Pilot', corporationName: null }
      ],
      dscanHulls: [
        { typeId: 22_428, typeName: 'Redeemer', count: 3 },
        { typeId: null, typeName: 'Scimitar', count: 1 }
      ]
    })
    first.close()

    const reopened = new EncounterJournalStore(databasePath, {}, () => now)
    expect(reopened.listRecent()).toEqual({ snapshots: [saved], hasMore: false })
    expect(reopened.searchPilot({ characterId: 101 })).toEqual({
      matches: [{
        snapshot: saved,
        matchedPilot: {
          characterId: 101,
          name: 'Danger Pilot',
          corporationName: 'Danger Corp'
        }
      }],
      hasMore: false
    })
    expect(reopened.searchPilot({ name: '  danger   PILOT ' }).matches).toHaveLength(1)
    expect(reopened.searchPilot({ name: 'Unresolved Pilot' }).matches[0].matchedPilot)
      .toMatchObject({ characterId: null, name: 'Unresolved Pilot' })
    reopened.close()
  })

  it('lists newest snapshots, supports filters, and enforces the hard retention cap', () => {
    const now = Date.parse('2026-08-25T10:00:00.000Z')
    const store = new EncounterJournalStore(
      ':memory:',
      { maxSnapshots: 2, retentionDays: 2 },
      () => now
    )
    store.record(snapshot('2026-08-25T09:00:00Z', 30_000_001, 'One', 'Alpha'))
    store.record(snapshot('2026-08-25T09:10:00Z', 30_000_002, 'Two', 'Beta'))
    store.record(snapshot('2026-08-25T09:20:00Z', 30_000_001, 'One', 'Gamma'))

    expect(store.count()).toBe(2)
    expect(store.listRecent({ limit: 1 })).toMatchObject({
      snapshots: [expect.objectContaining({ capturedAt: '2026-08-25T09:20:00.000Z' })],
      hasMore: true
    })
    expect(store.listRecent({ solarSystemId: 30_000_001 }).snapshots).toHaveLength(1)
    expect(store.searchPilot({ name: 'Alpha' }).matches).toEqual([])
    expect(store.searchPilot({ name: 'Beta', since: '2026-08-25T09:00:00Z' }).matches)
      .toHaveLength(1)
    expect(() => store.record(snapshot('2026-08-20T00:00:00Z', 30_000_003, 'Old', 'Old Pilot')))
      .toThrow('older than')
    store.close()
  })

  it('strictly validates IPC-ready payloads and rejects secret or oversized fields', () => {
    expect(() => validateEncounterSnapshotInput({
      currentSystem: { solarSystemId: 30_000_001 },
      accessToken: 'must-not-be-stored'
    })).toThrow('Unknown encounter snapshot field')
    expect(() => validateEncounterSnapshotInput({
      currentSystem: { solarSystemId: 0 }
    })).toThrow('System ID')
    expect(() => validateEncounterSnapshotInput({
      currentSystem: { solarSystemId: 30_000_001 },
      localPilots: [
        { characterId: 101, name: 'Pilot' },
        { characterId: 101, name: 'Same Pilot' }
      ]
    })).toThrow('Duplicate Local pilot')
    expect(() => validateEncounterSnapshotInput({
      currentSystem: { solarSystemId: 30_000_001 },
      dscanHulls: [{ count: 1 }]
    })).toThrow('needs an ID or type')
    expect(() => validateEncounterPilotSearchQuery({})).toThrow('pilot ID or name')
    expect(() => validateEncounterPilotSearchQuery({
      name: 'Pilot',
      since: '2026-08-25T10:00:00Z',
      before: '2026-08-25T09:00:00Z'
    })).toThrow('precede search end')

    const store = new EncounterJournalStore(':memory:')
    expect(() => store.listRecent({ limit: 500 })).toThrow('result limit')
    store.close()
    expect(() => store.listRecent()).toThrow('already closed')
  })
})

function snapshot(
  capturedAt: string,
  solarSystemId: number,
  systemName: string,
  pilotName: string
): Record<string, unknown> {
  return {
    capturedAt,
    currentSystem: { solarSystemId, name: systemName },
    localPilots: [{ name: pilotName }],
    dscanHulls: []
  }
}
