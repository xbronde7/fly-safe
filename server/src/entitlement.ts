import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomUUID,
  sign,
  verify
} from 'node:crypto'
import { exportJWK, type JWK } from 'jose'
import {
  ENTITLEMENT_PRODUCT,
  ENTITLEMENT_TOKEN_PREFIX,
  ENTITLEMENT_VERSION,
  ServiceError,
  type EntitlementClaimsV2,
  type IssuedEntitlement
} from './domain.js'
import type { BillingStore } from './store.js'

export interface EntitlementSignerOptions {
  privateKey: string | Buffer | KeyObject
  keyId: string
}

export class EntitlementSigner {
  readonly keyId: string
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject

  constructor(options: EntitlementSignerOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(options.keyId)) {
      throw new Error('ENTITLEMENT_KEY_ID has invalid format')
    }
    this.keyId = options.keyId
    this.privateKey = options.privateKey instanceof KeyObject
      ? options.privateKey
      : createPrivateKey(options.privateKey)
    if (this.privateKey.type !== 'private' || this.privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Entitlement private key must be Ed25519 PKCS#8')
    }
    this.publicKey = createPublicKey(this.privateKey)
  }

  issue(claims: EntitlementClaimsV2): string {
    if (claims.kid !== this.keyId) throw new Error('Entitlement key ID mismatch')
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    const signingInput = Buffer.from(`${ENTITLEMENT_TOKEN_PREFIX}.${payload}`, 'utf8')
    const signature = sign(null, signingInput, this.privateKey)
    return `${ENTITLEMENT_TOKEN_PREFIX}.${payload}.${signature.toString('base64url')}`
  }

  verify(token: string): EntitlementClaimsV2 {
    const parts = token.split('.')
    if (parts.length !== 3 || parts[0] !== ENTITLEMENT_TOKEN_PREFIX) {
      throw new Error('Invalid entitlement token format')
    }
    const authentic = verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      this.publicKey,
      Buffer.from(parts[2]!, 'base64url')
    )
    if (!authentic) throw new Error('Invalid entitlement token signature')
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as EntitlementClaimsV2
  }

  async publicJwk(): Promise<JWK & { kid: string; use: 'sig'; alg: 'EdDSA' }> {
    return {
      ...(await exportJWK(this.publicKey)),
      kid: this.keyId,
      use: 'sig',
      alg: 'EdDSA'
    }
  }
}

export interface EntitlementServiceOptions {
  store: BillingStore
  signer: EntitlementSigner
  graceSeconds: number
  now?: () => number
}

export class EntitlementService {
  private readonly store: BillingStore
  private readonly signer: EntitlementSigner
  private readonly graceSeconds: number
  private readonly now: () => number

  constructor(options: EntitlementServiceOptions) {
    if (!Number.isSafeInteger(options.graceSeconds) || options.graceSeconds < 0) {
      throw new Error('graceSeconds must be a non-negative integer')
    }
    this.store = options.store
    this.signer = options.signer
    this.graceSeconds = options.graceSeconds
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  }

  get keyId(): string {
    return this.signer.keyId
  }

  publicJwk(): ReturnType<EntitlementSigner['publicJwk']> {
    return this.signer.publicJwk()
  }

  assertFeature(characterId: string, feature: string): void {
    const subscription = this.store.getSubscriptionForCharacter(characterId)
    if (!subscription || subscription.status === 'cancelled') {
      throw new ServiceError('subscription_required', 'Active subscription required', 402)
    }
    const expiresAt = subscription.paidThrough + this.graceSeconds
    if (expiresAt <= this.now()) {
      throw new ServiceError('subscription_expired', 'Subscription has expired', 402, {
        paidThrough: subscription.paidThrough,
        graceEndsAt: expiresAt
      })
    }
    const plan = this.store.getPlan(subscription.planId)
    if (!plan) throw new Error(`Subscription references missing plan ${subscription.planId}`)
    if (!plan.features.includes(feature)) {
      throw new ServiceError('feature_not_entitled', 'Subscription does not include this feature', 403, {
        feature
      })
    }
  }

  getOrIssue(characterId: string, deviceCode: string): IssuedEntitlement {
    const now = this.now()
    const device = this.store.getDeviceByCode(characterId, deviceCode)
    if (!device || device.status !== 'active') {
      throw new ServiceError('device_not_registered', 'Device is not registered', 404)
    }

    const subscription = this.store.getSubscriptionForCharacter(characterId)
    if (!subscription || subscription.status === 'cancelled') {
      throw new ServiceError('subscription_required', 'Active subscription required', 402)
    }
    const expiresAt = subscription.paidThrough + this.graceSeconds
    if (expiresAt <= now) {
      throw new ServiceError('subscription_expired', 'Subscription has expired', 402, {
        paidThrough: subscription.paidThrough,
        graceEndsAt: expiresAt
      })
    }

    const plan = this.store.getPlan(subscription.planId)
    if (!plan) throw new Error(`Subscription references missing plan ${subscription.planId}`)
    const existing = this.store.getEntitlement(subscription.id, device.id)
    if (
      existing &&
      existing.claims.v === ENTITLEMENT_VERSION &&
      existing.claims.product === ENTITLEMENT_PRODUCT &&
      existing.claims.kid === this.signer.keyId &&
      existing.claims.paidThrough === subscription.paidThrough &&
      existing.claims.planId === plan.id &&
      existing.claims.characterName === subscription.characterName &&
      existing.claims.deviceCode === device.deviceCode &&
      equalFeatures(existing.claims.features, plan.features) &&
      existing.expiresAt === expiresAt
    ) {
      return existing
    }

    const id = existing?.id ?? randomUUID()
    const revision = (existing?.revision ?? 0) + 1
    const claims: EntitlementClaimsV2 = {
      v: ENTITLEMENT_VERSION,
      product: ENTITLEMENT_PRODUCT,
      kid: this.signer.keyId,
      entitlementId: id,
      revision,
      subscriptionId: subscription.id,
      characterId: subscription.characterId,
      characterName: subscription.characterName,
      deviceId: device.id,
      deviceCode: device.deviceCode,
      planId: plan.id,
      features: [...plan.features],
      issuedAt: now,
      notBefore: now - 300,
      paidThrough: subscription.paidThrough,
      expiresAt
    }
    const entitlement: IssuedEntitlement = {
      id,
      subscriptionId: subscription.id,
      deviceId: device.id,
      revision,
      token: this.signer.issue(claims),
      claims,
      issuedAt: now,
      expiresAt
    }
    this.store.saveEntitlement(entitlement)
    return entitlement
  }

  refreshCharacter(characterId: string): IssuedEntitlement[] {
    const subscription = this.store.getSubscriptionForCharacter(characterId)
    if (!subscription) return []
    const entitlements: IssuedEntitlement[] = []
    for (const device of this.store.listDevices(characterId, true)) {
      try {
        entitlements.push(this.getOrIssue(characterId, device.deviceCode))
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error
      }
    }
    return entitlements
  }

  revokeForDevice(characterId: string, deviceId: string): void {
    const subscription = this.store.getSubscriptionForCharacter(characterId)
    if (subscription) this.store.deleteEntitlement(subscription.id, deviceId)
  }
}

function equalFeatures(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
