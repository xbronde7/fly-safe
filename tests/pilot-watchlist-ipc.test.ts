import { describe, expect, it } from 'vitest'
import {
  parsePilotWatchlistRemoveRequest,
  parsePilotWatchlistUpsertRequest
} from '../src/main/pilot-watchlist-ipc'

describe('pilot watchlist IPC validation', () => {
  it('normalizes a valid upsert request', () => {
    expect(parsePilotWatchlistUpsertRequest({
      characterId: 101,
      name: '  Danger Pilot  ',
      corporationName: ' Danger Corp ',
      note: null,
      alertSoundEnabled: true
    })).toEqual({
      characterId: 101,
      name: 'Danger Pilot',
      corporationName: 'Danger Corp',
      note: null,
      alertSoundEnabled: true
    })
  })

  it('rejects unknown fields and renderer-controlled timestamps', () => {
    expect(() => parsePilotWatchlistUpsertRequest({
      characterId: 101,
      name: 'Pilot',
      addedAt: '2026-08-25T00:00:00Z'
    })).toThrow('unknown fields')
  })

  it('rejects invalid IDs, names and settings', () => {
    expect(() => parsePilotWatchlistUpsertRequest({ characterId: 0, name: 'Pilot' }))
      .toThrow('pilot ID')
    expect(() => parsePilotWatchlistUpsertRequest({ characterId: 1, name: '' }))
      .toThrow('pilot name')
    expect(() => parsePilotWatchlistUpsertRequest({
      characterId: 1,
      name: 'Pilot',
      alertSoundEnabled: 'yes'
    })).toThrow('sound alert')
  })

  it('rejects unsafe and fractional character IDs for upsert and removal', () => {
    for (const characterId of [Number.MAX_SAFE_INTEGER + 1, 1.5, -1]) {
      expect(() => parsePilotWatchlistUpsertRequest({ characterId, name: 'Pilot' }))
        .toThrow('pilot ID')
      expect(() => parsePilotWatchlistRemoveRequest({ characterId }))
        .toThrow('pilot ID')
    }
  })

  it('rejects oversized text fields', () => {
    expect(() => parsePilotWatchlistUpsertRequest({
      characterId: 1,
      name: 'N'.repeat(129)
    })).toThrow('pilot name')
    expect(() => parsePilotWatchlistUpsertRequest({
      characterId: 1,
      name: 'Pilot',
      corporationName: 'C'.repeat(257)
    })).toThrow('corporation')
    expect(() => parsePilotWatchlistUpsertRequest({
      characterId: 1,
      name: 'Pilot',
      note: 'N'.repeat(501)
    })).toThrow('note')
  })

  it('rejects null, array and extra-field request payloads', () => {
    for (const value of [null, [], ['not', 'a', 'record']]) {
      expect(() => parsePilotWatchlistUpsertRequest(value))
        .toThrow('Invalid watchlist request')
      expect(() => parsePilotWatchlistRemoveRequest(value))
        .toThrow('Invalid watchlist request')
    }

    expect(() => parsePilotWatchlistUpsertRequest({
      characterId: 1,
      name: 'Pilot',
      unexpected: true
    })).toThrow('unknown fields')
    expect(() => parsePilotWatchlistUpsertRequest({
      characterId: 1,
      name: ['Pilot']
    })).toThrow('pilot name')
  })

  it('accepts only a character ID for removal', () => {
    expect(parsePilotWatchlistRemoveRequest({ characterId: 202 }))
      .toEqual({ characterId: 202 })
    expect(() => parsePilotWatchlistRemoveRequest({ characterId: 202, name: 'Pilot' }))
      .toThrow('unknown fields')
  })

  it('normalizes a Watchlist 2.0 corporation rule with source and sound overrides', () => {
    expect(parsePilotWatchlistUpsertRequest({
      entityType: 'corporation',
      entityId: 98_765,
      name: ' Hostile Corp ',
      severity: 'critical',
      tags: [' Cyno ', 'Drop', 'cyno'],
      alertSources: ['local', 'dscan', 'r2z2'],
      soundId: 'critical',
      volume: 0.75,
      cooldownSeconds: 120,
      note: ' Red list '
    })).toEqual({
      characterId: 98_765,
      entityType: 'corporation',
      entityId: 98_765,
      name: 'Hostile Corp',
      corporationName: undefined,
      severity: 'critical',
      tags: ['Cyno', 'Drop'],
      alertSources: ['local', 'dscan', 'r2z2'],
      soundId: 'critical',
      volume: 0.75,
      cooldownSeconds: 120,
      note: 'Red list',
      alertSoundEnabled: undefined
    })
    expect(parsePilotWatchlistRemoveRequest({
      entityType: 'corporation',
      entityId: 98_765
    })).toEqual({
      characterId: 98_765,
      entityType: 'corporation',
      entityId: 98_765
    })
  })

  it('rejects invalid Watchlist 2.0 rules and mismatched compatibility IDs', () => {
    const base = { entityType: 'alliance', entityId: 77, name: 'Alliance' }
    expect(() => parsePilotWatchlistUpsertRequest({ ...base, severity: 'red' }))
      .toThrow('danger level')
    expect(() => parsePilotWatchlistUpsertRequest({ ...base, alertSources: ['local', 'local'] }))
      .toThrow('alert sources')
    expect(() => parsePilotWatchlistUpsertRequest({ ...base, soundId: 'file:///secret.wav' }))
      .toThrow('alert sound')
    expect(() => parsePilotWatchlistUpsertRequest({ ...base, volume: 1.1 }))
      .toThrow('Volume')
    expect(() => parsePilotWatchlistUpsertRequest({ ...base, cooldownSeconds: 86_401 }))
      .toThrow('cooldown')
    expect(() => parsePilotWatchlistUpsertRequest({
      ...base,
      characterId: 78
    })).toThrow('do not match')
  })
})
