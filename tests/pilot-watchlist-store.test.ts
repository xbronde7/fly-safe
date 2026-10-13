import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { PilotWatchlistStore } from '../src/main/pilot-watchlist-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('PilotWatchlistStore', () => {
  it('adds, updates, lists and removes a pilot without duplicates', () => {
    let now = Date.parse('2026-08-25T00:00:00.000Z')
    const store = new PilotWatchlistStore(':memory:', () => now)

    const added = store.upsert({ characterId: 101, name: 'Danger Pilot' })
    expect(added.entries).toMatchObject([{
      characterId: 101,
      entityType: 'character',
      entityId: 101,
      name: 'Danger Pilot',
      severity: 'danger',
      alertSources: ['local', 'system-killmail'],
      cooldownSeconds: 60,
      alertSoundEnabled: true,
      note: null
    }])

    now += 1_000
    const updated = store.upsert({
      characterId: 101,
      name: 'Danger Pilot',
      corporationName: 'Danger Corp',
      note: 'Любит кемпить',
      alertSoundEnabled: false
    })
    expect(updated.entries).toHaveLength(1)
    expect(updated.entries[0]).toMatchObject({
      corporationName: 'Danger Corp',
      note: 'Любит кемпить',
      alertSoundEnabled: false,
      addedAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:01.000Z'
    })

    expect(store.remove(101).entries).toEqual([])
    expect(store.remove(101).entries).toEqual([])
    store.close()
    store.close()
  })

  it('preserves note and sound preference when refreshing pilot identity', () => {
    const store = new PilotWatchlistStore(':memory:')
    store.upsert({
      characterId: 202,
      name: 'Old Name',
      note: 'Scout',
      alertSoundEnabled: false
    })

    const result = store.upsert({ characterId: 202, name: 'New Name' })
    expect(result.entries[0]).toMatchObject({
      name: 'New Name',
      note: 'Scout',
      alertSoundEnabled: false
    })
    store.close()
  })

  it('persists entries in a dedicated database across restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eve-watchlist-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'pilot-watchlist.sqlite')

    const addedAt = '2026-08-25T04:05:06.000Z'
    const now = Date.parse(addedAt)

    const first = new PilotWatchlistStore(databasePath, () => now)
    first.upsert({
      characterId: 303,
      name: 'Persistent Pilot',
      corporationName: 'Persistent Corp',
      note: 'Следить за дропом',
      alertSoundEnabled: false
    })
    first.close()

    const reopened = new PilotWatchlistStore(databasePath)
    expect(reopened.list().entries).toEqual([{
      characterId: 303,
      entityType: 'character',
      entityId: 303,
      name: 'Persistent Pilot',
      corporationName: 'Persistent Corp',
      severity: 'danger',
      tags: [],
      alertSources: ['local', 'system-killmail'],
      soundId: null,
      volume: null,
      cooldownSeconds: 60,
      note: 'Следить за дропом',
      alertSoundEnabled: false,
      addedAt,
      updatedAt: addedAt
    }])
    reopened.close()
  })

  it('validates unsafe input even when called without IPC', () => {
    const store = new PilotWatchlistStore(':memory:')
    expect(() => store.upsert({ characterId: 0, name: 'Pilot' })).toThrow('pilot ID')
    expect(() => store.upsert({ characterId: 1, name: '   ' })).toThrow('pilot name')
    expect(() => store.upsert({
      characterId: 1,
      name: 'Pilot',
      note: ''
    })).toThrow('note')
    store.close()
  })

  it('applies bulk imports atomically', () => {
    const store = new PilotWatchlistStore(':memory:')
    expect(() => store.bulkUpsert([
      { characterId: 501, name: 'Valid Pilot' },
      { characterId: 502, name: '   ' }
    ])).toThrow('pilot name')
    expect(store.list().entries).toEqual([])

    const imported = store.bulkUpsert([
      { characterId: 501, name: 'Valid Pilot' },
      {
        characterId: 601,
        entityType: 'corporation',
        entityId: 601,
        name: 'Watched Corp',
        severity: 'watch',
        alertSoundEnabled: false
      }
    ])
    expect(imported.entries).toHaveLength(2)
    store.close()
  })

  it('stores corporations and alliances with advanced per-source alert settings', () => {
    const store = new PilotWatchlistStore(':memory:')
    store.upsert({
      characterId: 88,
      entityType: 'corporation',
      entityId: 88,
      name: 'Hostile Corp',
      severity: 'critical',
      tags: ['Cyno', 'drop', 'cyno'],
      alertSources: ['dscan', 'r2z2'],
      soundId: 'critical',
      volume: 0.75,
      cooldownSeconds: 120,
      note: 'Тяжёлый дроп'
    })
    store.upsert({
      characterId: 88,
      entityType: 'alliance',
      entityId: 88,
      name: 'Hostile Alliance',
      severity: 'watch',
      alertSources: []
    })

    expect(store.list().entries).toMatchObject([
      {
        entityType: 'corporation',
        entityId: 88,
        severity: 'critical',
        tags: ['Cyno', 'drop'],
        alertSources: ['r2z2'],
        soundId: 'critical',
        volume: 0.75,
        cooldownSeconds: 120
      },
      {
        entityType: 'alliance',
        entityId: 88,
        severity: 'watch',
        alertSources: []
      }
    ])
    expect(store.removeEntity('corporation', 88).entries).toMatchObject([
      { entityType: 'alliance', entityId: 88 }
    ])
    store.close()
  })

  it('migrates the legacy character-only table without losing notes or sound settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eve-watchlist-migration-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'pilot-watchlist.sqlite')
    const database = new Database(databasePath)
    database.exec(`
      CREATE TABLE pilot_watchlist (
        character_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        corporation_name TEXT,
        note TEXT,
        alert_sound_enabled INTEGER NOT NULL DEFAULT 1,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO pilot_watchlist VALUES (
        404, 'Legacy Pilot', 'Legacy Corp', 'Старая заметка', 0,
        '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
      );
    `)
    database.close()

    const store = new PilotWatchlistStore(databasePath)
    expect(store.list().entries).toMatchObject([{
      characterId: 404,
      entityType: 'character',
      entityId: 404,
      name: 'Legacy Pilot',
      corporationName: 'Legacy Corp',
      note: 'Старая заметка',
      alertSoundEnabled: false,
      severity: 'danger',
      tags: [],
      alertSources: ['local', 'system-killmail'],
      soundId: null,
      volume: null,
      cooldownSeconds: 60
    }])
    store.close()
  })
})
