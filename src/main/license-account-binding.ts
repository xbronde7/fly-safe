import type { LicenseStatus } from '../shared/license'
import type { EveMultiAccountStatus } from '../shared/multi-account'
import { hasProFeature, PRO_FEATURES } from '../shared/pro-features'
import type { EveAccountStatus } from '../shared/types'

/**
 * Keeps subscription ownership pinned to its payer while allowing a licensed
 * multi-character user to operate through another locally authenticated alt.
 */
export function isLicenseAccountContextAllowed(
  status: LicenseStatus | null,
  activeAccount: EveAccountStatus | null,
  accounts: EveMultiAccountStatus | null
): boolean {
  const ownerCharacterId = status?.license?.characterId
  if (!ownerCharacterId || !activeAccount?.connected) return true
  if (String(activeAccount.characterId) === ownerCharacterId) return true
  if (!hasProFeature(status?.license?.features, PRO_FEATURES.characters)) return false
  if (accounts?.activeCharacterId !== activeAccount.characterId) return false

  const ownerId = parseLicensedCharacterId(ownerCharacterId)
  if (ownerId === null) return false
  return accounts.characters.some((character) => (
    character.characterId === ownerId && character.credentialStored
  ))
}

export function getLicensedOwnerCharacterId(status: LicenseStatus | null): number | null {
  const value = status?.license?.characterId
  return value ? parseLicensedCharacterId(value) : null
}

/** Expired or mismatched entitlements must not pin a new purchase to their former payer. */
export function getActiveLicensedOwnerCharacterId(
  status: LicenseStatus | null,
  now: () => number = Date.now
): number | null {
  if (!status?.active || status.state !== 'active') return null
  const expiresAt = status.license?.expiresAt
  if (expiresAt !== null && expiresAt !== undefined && expiresAt <= Math.floor(now() / 1_000)) {
    return null
  }
  return getLicensedOwnerCharacterId(status)
}

function parseLicensedCharacterId(value: string): number | null {
  if (!/^[1-9]\d{5,19}$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
