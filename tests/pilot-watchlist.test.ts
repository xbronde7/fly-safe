import { describe, expect, it } from 'vitest'
import {
  findPilotWatchlistMatches,
  findPilotWatchlistMatchedPilotIds,
  filterOperationalPilotWatchlistAlerts,
  getPilotWatchlistAlertSources,
  getPilotWatchlistEntityKey,
  resolvePilotWatchlistAlertConfig,
  normalizePilotWatchlistName,
  reconcilePilotWatchlistDscanCandidates,
  reconcilePilotWatchlistPresence,
  shouldEmitPilotWatchlistAlert,
  shouldPlayPilotWatchlistAlert,
  type PilotWatchlistEntry
} from '../src/shared/pilot-watchlist'

function entry(characterId: number, name: string): PilotWatchlistEntry {
  return {
    characterId,
    name,
    corporationName: null,
    note: null,
    alertSoundEnabled: true,
    addedAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z'
  }
}

describe('pilot watchlist scan matching', () => {
  it('matches a resolved pilot by stable character ID even after a rename', () => {
    const matches = findPilotWatchlistMatches([entry(101, 'Old Name')], {
      pilots: [{ id: 101, name: 'New Name' }],
      unresolvedNames: []
    })

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ matchedBy: 'character-id', pilot: { name: 'New Name' } })
  })

  it('falls back to normalized exact names for unresolved scan entries', () => {
    expect(normalizePilotWatchlistName('  Pílót   One ')).toBe('pílót one')
    const matches = findPilotWatchlistMatches([entry(202, 'Pilot One')], {
      pilots: [],
      unresolvedNames: ['  PILOT   ONE  ']
    })

    expect(matches).toMatchObject([{ matchedBy: 'name', pilot: null }])
  })

  it('deduplicates an unresolved exact-name presence and rearms after it disappears', () => {
    const watched = [entry(203, 'Unresolved Pilot')]
    const first = reconcilePilotWatchlistPresence([], watched, {
      pilots: [],
      unresolvedNames: ['  UNRESOLVED   PILOT  ']
    })
    const repeated = reconcilePilotWatchlistPresence(first.presentEntityKeys, watched, {
      pilots: [],
      unresolvedNames: ['Unresolved Pilot']
    })
    const absent = reconcilePilotWatchlistPresence(repeated.presentEntityKeys, watched, {
      pilots: [],
      unresolvedNames: []
    })
    const returned = reconcilePilotWatchlistPresence(absent.presentEntityKeys, watched, {
      pilots: [],
      unresolvedNames: ['unresolved pilot']
    })

    expect(first.matches).toMatchObject([{
      entry: { characterId: 203 },
      pilot: null,
      matchedBy: 'name'
    }])
    expect(first.entered).toHaveLength(1)
    expect(first.presentEntityKeys).toEqual(['character:203'])
    expect(repeated.entered).toEqual([])
    expect(absent.presentEntityKeys).toEqual([])
    expect(returned.entered).toHaveLength(1)
  })

  it('does not match a resolved pilot with a different character ID by name', () => {
    const matches = findPilotWatchlistMatches([entry(101, 'Same Name')], {
      pilots: [{ id: 202, name: 'Same Name' }],
      unresolvedNames: []
    })

    expect(matches).toEqual([])
  })

  it('alerts once while a contact remains in repeated scans', () => {
    const watched = [entry(303, 'Danger Pilot')]
    const scan = { pilots: [{ id: 303, name: 'Danger Pilot' }], unresolvedNames: [] }
    const first = reconcilePilotWatchlistPresence([], watched, scan)
    const repeated = reconcilePilotWatchlistPresence(first.presentEntityKeys, watched, scan)

    expect(first.entered.map(({ entry }) => entry.characterId)).toEqual([303])
    expect(repeated.entered).toEqual([])
    expect(repeated.matches).toHaveLength(1)
  })

  it('arms the alert again after the contact leaves Local', () => {
    const watched = [entry(404, 'Return Pilot')]
    const presentScan = { pilots: [{ id: 404, name: 'Return Pilot' }], unresolvedNames: [] }
    const first = reconcilePilotWatchlistPresence([], watched, presentScan)
    const absent = reconcilePilotWatchlistPresence(first.presentEntityKeys, watched, {
      pilots: [],
      unresolvedNames: []
    })
    const returned = reconcilePilotWatchlistPresence(absent.presentEntityKeys, watched, presentScan)

    expect(absent.presentEntityKeys).toEqual([])
    expect(returned.entered).toHaveLength(1)
  })

  it('keeps muted contacts in matches while allowing sound candidates to be filtered', () => {
    const muted = { ...entry(405, 'Muted Pilot'), alertSoundEnabled: false }
    const audible = entry(406, 'Audible Pilot')
    const presence = reconcilePilotWatchlistPresence([], [muted, audible], {
      pilots: [
        { id: 405, name: 'Muted Pilot' },
        { id: 406, name: 'Audible Pilot' }
      ],
      unresolvedNames: []
    })

    expect(presence.matches.map(({ entry: watched }) => watched.characterId)).toEqual([405, 406])
    expect(presence.entered.map(({ entry: watched }) => watched.characterId)).toEqual([405, 406])
    expect(presence.entered
      .filter(({ entry: watched }) => watched.alertSoundEnabled)
      .map(({ entry: watched }) => watched.characterId))
      .toEqual([406])
  })

  it('does not mutate entries, scans, or previous presence', () => {
    const entries = [entry(505, 'Immutable Pilot')]
    const scan = { pilots: [{ id: 505, name: 'Immutable Pilot' }], unresolvedNames: [] }
    const previous = ['character:999'] as const
    const before = structuredClone({ entries, scan, previous })

    reconcilePilotWatchlistPresence(previous, entries, scan)

    expect({ entries, scan, previous }).toEqual(before)
  })

  it('matches corporation and alliance entities through resolved pilot affiliations', () => {
    const corporation = {
      ...entry(500, 'Hostile Corp'),
      entityType: 'corporation' as const,
      entityId: 500
    }
    const alliance = {
      ...entry(600, 'Hostile Alliance'),
      entityType: 'alliance' as const,
      entityId: 600
    }
    const matches = findPilotWatchlistMatches([corporation, alliance], {
      pilots: [{
        id: 700,
        name: 'Member Pilot',
        corporationId: 500,
        allianceId: 600
      }],
      unresolvedNames: []
    })

    expect(matches.map((match) => match.matchedBy)).toEqual([
      'corporation-id',
      'alliance-id'
    ])
    expect(matches.every((match) => match.pilot?.id === 700)).toBe(true)
  })

  it('keeps corporation and alliance presence separate when their numeric IDs collide', () => {
    const corporation = {
      ...entry(88, 'Hostile Corp'),
      entityType: 'corporation' as const,
      entityId: 88
    }
    const alliance = {
      ...entry(88, 'Hostile Alliance'),
      entityType: 'alliance' as const,
      entityId: 88
    }
    const both = reconcilePilotWatchlistPresence([], [corporation, alliance], {
      pilots: [{ id: 700, name: 'Member', corporationId: 88, allianceId: 88 }],
      unresolvedNames: []
    })
    const allianceOnly = reconcilePilotWatchlistPresence(both.presentEntityKeys, [corporation, alliance], {
      pilots: [{ id: 701, name: 'Alliance member', corporationId: 99, allianceId: 88 }],
      unresolvedNames: []
    })
    const corporationReturns = reconcilePilotWatchlistPresence(
      allianceOnly.presentEntityKeys,
      [corporation, alliance],
      {
        pilots: [{ id: 702, name: 'Both again', corporationId: 88, allianceId: 88 }],
        unresolvedNames: []
      }
    )

    expect(both.presentEntityKeys).toEqual(['alliance:88', 'corporation:88'])
    expect(allianceOnly.presentEntityKeys).toEqual(['alliance:88'])
    expect(corporationReturns.entered.map(({ entry: watched }) => (
      getPilotWatchlistEntityKey(watched)
    ))).toEqual(['corporation:88'])
  })

  it('returns every Local pilot covered by character, corporation, or alliance rules', () => {
    const corporation = {
      ...entry(500, 'Hostile Corp'),
      entityType: 'corporation' as const,
      entityId: 500
    }
    const alliance = {
      ...entry(600, 'Hostile Alliance'),
      entityType: 'alliance' as const,
      entityId: 600
    }

    expect(findPilotWatchlistMatchedPilotIds([corporation, alliance], {
      pilots: [
        { id: 701, name: 'Corp one', corporationId: 500 },
        { id: 702, name: 'Corp two', corporationId: 500 },
        { id: 703, name: 'Alliance member', corporationId: 700, allianceId: 600 },
        { id: 704, name: 'Neutral', corporationId: 700, allianceId: 800 }
      ]
    })).toEqual([701, 702, 703])
  })

  it('does not advertise unsupported affiliation sources without reliable IDs', () => {
    const corporation = {
      ...entry(500, 'Hostile Corp'),
      entityType: 'corporation' as const,
      entityId: 500,
      alertSources: ['local', 'dscan', 'system-killmail', 'r2z2'] as PilotWatchlistEntry['alertSources']
    }
    expect(getPilotWatchlistAlertSources(corporation)).toEqual(['local', 'r2z2'])
  })

  it('announces a correlated pilot once per D-scan capture and rearms on a new capture', () => {
    const first = reconcilePilotWatchlistDscanCandidates(
      { capturedAt: null, characterIds: [] },
      '2026-08-25T10:00:00.000Z',
      [303, 303, 202]
    )
    const refreshedHistory = reconcilePilotWatchlistDscanCandidates(
      first.state,
      '2026-08-25T10:00:00.000Z',
      [202, 303, 404]
    )
    const nextCapture = reconcilePilotWatchlistDscanCandidates(
      refreshedHistory.state,
      '2026-08-25T10:01:00.000Z',
      [303]
    )

    expect(first.newCharacterIds).toEqual([202, 303])
    expect(refreshedHistory.newCharacterIds).toEqual([404])
    expect(nextCapture.newCharacterIds).toEqual([303])
  })

  it('skips historical R2Z2 backfill without truncating the bounded live batch', () => {
    const alerts = Array.from({ length: 25 }, (_, index) => ({
      killmailId: index + 1,
      historicalBackfill: index === 7
    }))
    const operational = filterOperationalPilotWatchlistAlerts(alerts)

    expect(operational).toHaveLength(24)
    expect(operational.map((alert) => alert.killmailId)).not.toContain(8)
    expect(operational.at(-1)?.killmailId).toBe(25)
  })

  it('keeps legacy alert defaults and applies source-specific cooldowns', () => {
    const legacy = entry(808, 'Legacy Pilot')
    expect(resolvePilotWatchlistAlertConfig(legacy)).toMatchObject({
      entityType: 'character',
      entityId: 808,
      severity: 'danger',
      alertSources: ['local', 'system-killmail'],
      soundId: null,
      volume: null,
      cooldownSeconds: 60
    })
    expect(shouldPlayPilotWatchlistAlert(legacy, 'dscan', null, 100_000)).toBe(false)
    expect(shouldPlayPilotWatchlistAlert(legacy, 'local', null, 100_000)).toBe(true)
    expect(shouldPlayPilotWatchlistAlert(legacy, 'local', 80_000, 100_000)).toBe(false)
    expect(shouldPlayPilotWatchlistAlert(legacy, 'local', 40_000, 100_000)).toBe(true)

    const advanced = {
      ...legacy,
      alertSources: ['dscan', 'r2z2'] as PilotWatchlistEntry['alertSources'],
      cooldownSeconds: 10
    }
    expect(shouldPlayPilotWatchlistAlert(advanced, 'local', null, 100_000)).toBe(false)
    expect(shouldPlayPilotWatchlistAlert(advanced, 'r2z2', 95_000, 100_000)).toBe(false)
    expect(shouldPlayPilotWatchlistAlert(advanced, 'r2z2', 90_000, 100_000)).toBe(true)
  })

  it('keeps visual/native cooldown independent from the per-contact sound toggle', () => {
    const muted = {
      ...entry(909, 'Muted Pilot'),
      alertSoundEnabled: false,
      cooldownSeconds: 30
    }
    expect(shouldPlayPilotWatchlistAlert(muted, 'local', null, 100_000)).toBe(false)
    expect(shouldEmitPilotWatchlistAlert(muted, 'local', null, 100_000)).toBe(true)
    expect(shouldEmitPilotWatchlistAlert(muted, 'local', 80_000, 100_000)).toBe(false)
    expect(shouldEmitPilotWatchlistAlert(muted, 'local', 70_000, 100_000)).toBe(true)
  })
})
