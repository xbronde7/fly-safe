import { describe, expect, it } from 'vitest'
import {
  createCharacterRegistry,
  getActiveCharacterContext,
  removeCharacterProfile,
  resolveCharacterAccess,
  revokeCharacterSession,
  selectActiveCharacter,
  upsertCharacterProfile,
  upsertCharacterSession
} from '../src/shared/character-registry'

const T0 = '2026-08-25T10:00:00.000Z'

describe('multi-character registry', () => {
  it('keeps independent profiles and switches active character without credentials in profiles', () => {
    const empty = createCharacterRegistry(T0)
    const first = upsertCharacterProfile(empty, {
      characterId: 22,
      name: 'Beta Pilot',
      corporationId: 200,
      corporationName: 'Beta Corp'
    }, '2026-08-25T10:01:00Z')
    const both = upsertCharacterProfile(first, {
      characterId: 11,
      name: 'Alpha Pilot',
      allianceId: 300,
      allianceName: 'Alpha Alliance'
    }, '2026-08-25T10:02:00Z')
    const selected = selectActiveCharacter(both, 11, '2026-08-25T10:03:00Z')

    expect(selected.revision).toBe(3)
    expect(selected.activeCharacterId).toBe(11)
    expect(selected.profiles.map((profile) => profile.characterId)).toEqual([11, 22])
    expect(selected.profiles[0]).not.toHaveProperty('accessToken')
    expect(selected.profiles[0]).not.toHaveProperty('refreshToken')
    expect(getActiveCharacterContext(selected)?.profile).toMatchObject({
      characterId: 11,
      lastSelectedAt: '2026-08-25T10:03:00.000Z'
    })
    expect(both.activeCharacterId).toBe(22)
    expect(both.profiles.find((profile) => profile.characterId === 11)?.lastSelectedAt).toBeNull()
  })

  it('resolves expiry, missing scopes and revocation per character session', () => {
    let registry = upsertCharacterProfile(createCharacterRegistry(T0), {
      characterId: 11,
      name: 'Alpha Pilot'
    }, T0)
    registry = upsertCharacterSession(registry, {
      characterId: 11,
      secureCredentialId: 'keychain:eve:11',
      grantedScopes: ['esi-location.read_location.v1', 'esi-location.read_location.v1'],
      authenticatedAt: '2026-08-25T10:00:00Z',
      expiresAt: '2026-08-25T11:00:00Z'
    }, '2026-08-25T10:00:01Z')

    expect(resolveCharacterAccess(
      registry,
      11,
      ['esi-location.read_location.v1'],
      '2026-08-25T10:30:00Z'
    ).state).toBe('ready')
    expect(resolveCharacterAccess(
      registry,
      11,
      ['esi-wallet.read_character_wallet.v1'],
      '2026-08-25T10:30:00Z'
    )).toMatchObject({
      state: 'scopes-missing',
      missingScopes: ['esi-wallet.read_character_wallet.v1']
    })
    expect(resolveCharacterAccess(registry, 11, [], '2026-08-25T11:00:00Z').state)
      .toBe('session-expired')

    const revoked = revokeCharacterSession(registry, 11, '2026-08-25T10:45:00Z')
    expect(resolveCharacterAccess(revoked, 11, [], '2026-08-25T10:46:00Z').state)
      .toBe('session-revoked')
    expect(registry.sessions[0].state).toBe('active')
  })

  it('removes only the selected profile and its session, then requires explicit reselection', () => {
    let registry = createCharacterRegistry(T0)
    registry = upsertCharacterProfile(registry, { characterId: 1, name: 'One' }, T0)
    registry = upsertCharacterProfile(registry, { characterId: 2, name: 'Two' }, T0)
    registry = upsertCharacterSession(registry, {
      characterId: 1,
      secureCredentialId: 'secure:1',
      grantedScopes: [],
      authenticatedAt: T0,
      expiresAt: '2026-08-25T12:00:00Z'
    }, T0)

    const removed = removeCharacterProfile(registry, 1, '2026-08-25T10:10:00Z')

    expect(removed.activeCharacterId).toBeNull()
    expect(removed.profiles.map(({ characterId }) => characterId)).toEqual([2])
    expect(removed.sessions).toEqual([])
    expect(resolveCharacterAccess(removed, 1, [], T0).state).toBe('profile-missing')
    expect(selectActiveCharacter(removed, 2, T0).activeCharacterId).toBe(2)
  })

  it('rejects attaching one character credentials to an unknown profile', () => {
    expect(() => upsertCharacterSession(createCharacterRegistry(T0), {
      characterId: 99,
      secureCredentialId: 'secure:99',
      grantedScopes: [],
      authenticatedAt: T0,
      expiresAt: '2026-08-25T12:00:00Z'
    }, T0)).toThrow(/unknown character profile/i)
  })
})
