import { describe, expect, it } from 'vitest'
import type { LicenseStatus } from '../src/shared/license'
import type { EveMultiAccountStatus } from '../src/shared/multi-account'
import type { EveAccountStatus } from '../src/shared/types'
import {
  getActiveLicensedOwnerCharacterId,
  isLicenseAccountContextAllowed
} from '../src/main/license-account-binding'

const ownerId = 21122560144
const altId = 21122560145

function license(features: string[]): LicenseStatus {
  return {
    state: 'active',
    active: true,
    deviceCode: 'FLYSAFE-DEVICE-1',
    license: {
      licenseId: 'entitlement-1',
      customer: 'Owner',
      issuedAt: 1,
      expiresAt: 4_000_000_000,
      characterId: String(ownerId),
      features
    },
    message: null
  }
}

function account(characterId: number): EveAccountStatus {
  return {
    configured: true,
    connected: true,
    clientId: 'client',
    callbackUri: 'http://localhost:53173/callback',
    characterId,
    characterName: characterId === ownerId ? 'Owner' : 'Alt',
    scopes: [],
    error: null
  }
}

function accounts(ownerCredentialStored = true): EveMultiAccountStatus {
  return {
    configured: true,
    clientId: 'client',
    callbackUri: 'http://localhost:53173/callback',
    activeCharacterId: altId,
    maxCharacters: 8,
    legacyMigration: 'complete',
    error: null,
    characters: [
      {
        characterId: ownerId,
        characterName: 'Owner',
        scopes: [],
        state: ownerCredentialStored ? 'stored' : 'disconnected',
        connected: false,
        credentialStored: ownerCredentialStored,
        sessionExpiresAt: null,
        addedAt: '2026-01-01T00:00:00.000Z',
        lastAuthenticatedAt: '2026-01-01T00:00:00.000Z',
        lastSelectedAt: null,
        lastDisconnectedAt: null,
        error: null
      },
      {
        characterId: altId,
        characterName: 'Alt',
        scopes: [],
        state: 'connected',
        connected: true,
        credentialStored: true,
        sessionExpiresAt: null,
        addedAt: '2026-01-01T00:00:00.000Z',
        lastAuthenticatedAt: '2026-01-01T00:00:00.000Z',
        lastSelectedAt: null,
        lastDisconnectedAt: null,
        error: null
      }
    ]
  }
}

describe('license account binding', () => {
  it('accepts the paying character directly', () => {
    expect(isLicenseAccountContextAllowed(license([]), account(ownerId), null)).toBe(true)
  })

  it('rejects an alt without the multi-character entitlement', () => {
    expect(isLicenseAccountContextAllowed(license([]), account(altId), accounts())).toBe(false)
  })

  it('accepts an alt only while the payer credential remains stored', () => {
    expect(isLicenseAccountContextAllowed(
      license(['multi_character']),
      account(altId),
      accounts(true)
    )).toBe(true)
    expect(isLicenseAccountContextAllowed(
      license(['multi_character']),
      account(altId),
      accounts(false)
    )).toBe(false)
  })

  it('rejects a spoofed active-character mismatch', () => {
    const snapshot = accounts()
    snapshot.activeCharacterId = ownerId
    expect(isLicenseAccountContextAllowed(
      license(['multi_character']),
      account(altId),
      snapshot
    )).toBe(false)
  })

  it('pins billing only while the owner entitlement remains active and unexpired', () => {
    const active = license(['multi_character'])
    expect(getActiveLicensedOwnerCharacterId(active, () => 2_000_000_000_000)).toBe(ownerId)

    active.active = false
    active.state = 'expired'
    expect(getActiveLicensedOwnerCharacterId(active, () => 2_000_000_000_000)).toBeNull()

    active.active = true
    active.state = 'active'
    active.license!.expiresAt = 1_999_999_999
    expect(getActiveLicensedOwnerCharacterId(active, () => 2_000_000_000_000)).toBeNull()
  })
})
