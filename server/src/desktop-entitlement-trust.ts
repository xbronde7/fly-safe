import { createHash, timingSafeEqual, type KeyObject } from 'node:crypto'

/**
 * Public trust compiled into the current Fly Safe desktop release.
 *
 * This is intentionally duplicated at the server boundary: the server must refuse to issue
 * entitlements that an installed desktop cannot verify. The matching private key is never stored
 * here. `desktop-entitlement-trust.test.ts` detects drift from the desktop source during CI.
 */
export const DESKTOP_ENTITLEMENT_KEY_ID = 'fly-safe-2026-01'
export const DESKTOP_ENTITLEMENT_PUBLIC_KEY_SPKI_SHA256 =
  '5925643c4a5c4c61288737898ddfaacc7558422cd35d2f78d73f563c05cd7314'

export interface EntitlementSignerPublicIdentity {
  keyId: string
  publicKey: KeyObject
}

export interface EntitlementPublicTrust {
  keyId: string
  publicKeySpkiSha256: string
}

export const DESKTOP_ENTITLEMENT_TRUST: Readonly<EntitlementPublicTrust> = Object.freeze({
  keyId: DESKTOP_ENTITLEMENT_KEY_ID,
  publicKeySpkiSha256: DESKTOP_ENTITLEMENT_PUBLIC_KEY_SPKI_SHA256
})

/** Returns the lowercase SHA-256 hex digest of canonical DER SubjectPublicKeyInfo bytes. */
export function entitlementPublicKeySpkiSha256(publicKey: KeyObject): string {
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Entitlement public key must be Ed25519')
  }
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spki).digest('hex')
}

/**
 * Fail-closed guard used before any database initialization or network listener is created.
 * Error text contains public fingerprints only and never serializes private key material.
 */
export function assertEntitlementSignerMatchesDesktopTrust(
  signer: EntitlementSignerPublicIdentity,
  trust: Readonly<EntitlementPublicTrust> = DESKTOP_ENTITLEMENT_TRUST
): void {
  if (signer.keyId !== trust.keyId) {
    throw new Error(
      `ENTITLEMENT_KEY_ID ${JSON.stringify(signer.keyId)} does not match desktop trusted key ID ` +
      `${JSON.stringify(trust.keyId)}; entitlement server will not start`
    )
  }

  const expected = parseSha256(trust.publicKeySpkiSha256, 'desktop trusted fingerprint')
  const actualHex = entitlementPublicKeySpkiSha256(signer.publicKey)
  const actual = Buffer.from(actualHex, 'hex')
  if (!timingSafeEqual(actual, expected)) {
    throw new Error(
      `Entitlement signing key public fingerprint sha256:${actualHex} does not match desktop ` +
      `trusted fingerprint sha256:${trust.publicKeySpkiSha256}; entitlement server will not start`
    )
  }
}

function parseSha256(value: string, label: string): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest`)
  }
  return Buffer.from(value, 'hex')
}
