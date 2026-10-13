import { expectPrivatePathMode } from './file-permissions'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LicenseError,
  LicenseService,
  createAsyncSafeStorageProtector,
  getLicenseStoragePaths,
  verifyLicenseToken,
  type LicenseSecretProtector
} from '../src/main/license-service'
import {
  LICENSE_PRODUCT,
  LICENSE_TOKEN_VERSION,
  ENTITLEMENT_TOKEN_VERSION,
  createEntitlementSigningMaterial,
  createLicenseSigningMaterial,
  formatEntitlementToken,
  formatLicenseToken,
  normalizeDeviceCode,
  parseLicenseToken,
  type EntitlementClaims,
  type LicenseClaims
} from '../src/shared/license'

const NOW_MS = 2_000_000_000_000
const NOW_SECONDS = Math.floor(NOW_MS / 1_000)
const DEVICE_CODE = 'ELI-0123-4567-89AB-CDEF'
const OTHER_DEVICE_CODE = 'ELI-FEDC-BA98-7654-3210'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

class AsyncTestProtector implements LicenseSecretProtector {
  encryptCalls = 0
  decryptCalls = 0
  reencrypt = false

  constructor(private readonly available = true) {}

  async isEncryptionAvailable(): Promise<boolean> {
    return this.available
  }

  async encryptString(plaintext: string): Promise<Uint8Array> {
    this.encryptCalls += 1
    const bytes = Buffer.from(plaintext, 'utf8')
    return Uint8Array.from([0xe1, 0x1c, ...bytes.map((byte) => byte ^ 0xa7)])
  }

  async decryptString(
    ciphertext: Uint8Array
  ): Promise<string | { result: string; shouldReEncrypt: boolean }> {
    this.decryptCalls += 1
    if (ciphertext[0] !== 0xe1 || ciphertext[1] !== 0x1c) throw new Error('invalid data')
    const result = Buffer.from(
      Uint8Array.from(ciphertext.slice(2), (byte) => byte ^ 0xa7)
    ).toString('utf8')
    const shouldReEncrypt = this.reencrypt
    this.reencrypt = false
    return { result, shouldReEncrypt }
  }
}

function testKeys(): ReturnType<typeof generateKeyPairSync> {
  return generateKeyPairSync('ed25519')
}

function claims(overrides: Partial<LicenseClaims> = {}): LicenseClaims {
  return {
    v: LICENSE_TOKEN_VERSION,
    product: LICENSE_PRODUCT,
    licenseId: 'lic-test-001',
    customer: 'Тестовый пилот',
    deviceCode: DEVICE_CODE,
    issuedAt: NOW_SECONDS - 60,
    expiresAt: NOW_SECONDS + 3_600,
    ...overrides
  }
}

function issueToken(
  privateKey: ReturnType<typeof testKeys>['privateKey'],
  value: LicenseClaims = claims()
): string {
  const material = createLicenseSigningMaterial(value)
  return formatLicenseToken(material.payloadSegment, sign(null, material.signingBytes, privateKey))
}

function entitlementClaims(
  overrides: Partial<EntitlementClaims> = {}
): EntitlementClaims {
  return {
    v: ENTITLEMENT_TOKEN_VERSION,
    product: LICENSE_PRODUCT,
    kid: 'fly-safe-2026-01',
    entitlementId: 'ent-test-001',
    revision: 3,
    subscriptionId: 'sub-test-001',
    characterId: '21122560144',
    characterName: 'Serg Xbronde',
    deviceId: 'dev-test-001',
    deviceCode: DEVICE_CODE,
    planId: 'pro-monthly',
    features: ['wormhole-chain', 'hunter-planner'],
    issuedAt: NOW_SECONDS - 60,
    notBefore: NOW_SECONDS - 90,
    paidThrough: NOW_SECONDS + 30 * 86_400,
    expiresAt: NOW_SECONDS + 86_400,
    ...overrides
  }
}

function issueEntitlement(
  privateKey: ReturnType<typeof testKeys>['privateKey'],
  value: EntitlementClaims = entitlementClaims()
): string {
  const material = createEntitlementSigningMaterial(value)
  return formatEntitlementToken(
    material.payloadSegment,
    sign(null, material.signingBytes, privateKey)
  )
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'eve-license-service-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('license token format', () => {
  it('creates deterministic signing bytes and round-trips Unicode claims', () => {
    const { privateKey } = testKeys()
    const token = issueToken(privateKey)
    const parsed = parseLicenseToken(`  ${token}\n`)

    expect(parsed.token).toBe(token)
    expect(parsed.claims).toEqual(claims())
    expect(Buffer.from(parsed.signingBytes).toString('utf8')).toBe(
      `EVEI1.${parsed.payloadSegment}`
    )
    expect(parsed.signature).toHaveLength(64)
    expect(normalizeDeviceCode('  eli-0123-4567-89ab-cdef ')).toBe(DEVICE_CODE)
  })

  it('rejects unknown claims and non-canonical device codes before verification', () => {
    expect(() =>
      createLicenseSigningMaterial({ ...claims(), extra: true } as LicenseClaims)
    ).toThrow('Набор полей')
    expect(() =>
      createLicenseSigningMaterial({ ...claims(), deviceCode: DEVICE_CODE.toLowerCase() })
    ).toThrow('не нормализован')
  })
})

describe('verifyLicenseToken', () => {
  it('accepts an EVEI2 subscription entitlement and exposes plan metadata', () => {
    const { publicKey, privateKey } = testKeys()
    const result = verifyLicenseToken(issueEntitlement(privateKey), {
      publicKey,
      deviceCode: DEVICE_CODE,
      now: () => NOW_MS,
      trustedEntitlementKeyIds: ['fly-safe-2026-01']
    })

    expect(result.claims).toMatchObject({ v: 2, characterId: '21122560144' })
    expect(result.license).toMatchObject({
      licenseId: 'ent-test-001',
      customer: 'Serg Xbronde',
      characterId: '21122560144',
      planId: 'pro-monthly',
      features: ['wormhole-chain', 'hunter-planner'],
      paidThrough: NOW_SECONDS + 30 * 86_400,
      entitlementRevision: 3
    })
  })

  it('rejects a signed EVEI2 entitlement from an untrusted key id', () => {
    const { publicKey, privateKey } = testKeys()

    expect(() =>
      verifyLicenseToken(
        issueEntitlement(privateKey, entitlementClaims({ kid: 'unknown-key-2026' })),
        {
          publicKey,
          deviceCode: DEVICE_CODE,
          now: () => NOW_MS,
          trustedEntitlementKeyIds: ['fly-safe-2026-01']
        }
      )
    ).toThrowError(expect.objectContaining<Partial<LicenseError>>({ code: 'invalid_signature' }))
  })

  it('accepts an authentic unexpired Ed25519 key for exactly this device', () => {
    const { publicKey, privateKey } = testKeys()
    const result = verifyLicenseToken(issueToken(privateKey), {
      publicKey,
      deviceCode: DEVICE_CODE.toLowerCase(),
      now: () => NOW_MS
    })

    expect(result.license).toEqual({
      licenseId: 'lic-test-001',
      customer: 'Тестовый пилот',
      issuedAt: NOW_SECONDS - 60,
      expiresAt: NOW_SECONDS + 3_600
    })
  })

  it('rejects a valid signature issued for another device', () => {
    const { publicKey, privateKey } = testKeys()
    expect(() =>
      verifyLicenseToken(issueToken(privateKey, claims({ deviceCode: OTHER_DEVICE_CODE })), {
        publicKey,
        deviceCode: DEVICE_CODE,
        now: () => NOW_MS
      })
    ).toThrowError(expect.objectContaining<Partial<LicenseError>>({ code: 'device_mismatch' }))
  })

  it('rejects tampering, expired keys, and keys issued too far in the future', () => {
    const { publicKey, privateKey } = testKeys()
    const authentic = issueToken(privateKey)
    const parsed = parseLicenseToken(authentic)
    const tamperedSignature = Uint8Array.from(parsed.signature)
    tamperedSignature[0] ^= 1
    const tampered = formatLicenseToken(parsed.payloadSegment, tamperedSignature)

    expect(() =>
      verifyLicenseToken(tampered, { publicKey, deviceCode: DEVICE_CODE, now: () => NOW_MS })
    ).toThrowError(expect.objectContaining<Partial<LicenseError>>({ code: 'invalid_signature' }))
    expect(() =>
      verifyLicenseToken(
        issueToken(privateKey, claims({ expiresAt: NOW_SECONDS })),
        { publicKey, deviceCode: DEVICE_CODE, now: () => NOW_MS }
      )
    ).toThrowError(expect.objectContaining<Partial<LicenseError>>({ code: 'expired' }))
    expect(() =>
      verifyLicenseToken(
        issueToken(
          privateKey,
          claims({ issuedAt: NOW_SECONDS + 301, expiresAt: NOW_SECONDS + 3_600 })
        ),
        { publicKey, deviceCode: DEVICE_CODE, now: () => NOW_MS }
      )
    ).toThrowError(expect.objectContaining<Partial<LicenseError>>({ code: 'not_yet_valid' }))
  })
})

describe('LicenseService', () => {
  it('adapts Electron 43 asynchronous safeStorage without synchronous crypto', async () => {
    const calls: string[] = []
    const protector = createAsyncSafeStorageProtector({
      async isAsyncEncryptionAvailable() {
        calls.push('available')
        return true
      },
      async encryptStringAsync(plaintext) {
        calls.push(`encrypt:${plaintext}`)
        return Buffer.from('encrypted')
      },
      async decryptStringAsync(ciphertext) {
        calls.push(`decrypt:${ciphertext.toString('utf8')}`)
        return { result: 'decrypted', shouldReEncrypt: true }
      }
    })

    expect(await protector.isEncryptionAvailable()).toBe(true)
    expect(await protector.encryptString('key')).toEqual(Buffer.from('encrypted'))
    expect(await protector.decryptString(Buffer.from('blob'))).toEqual({
      result: 'decrypted',
      shouldReEncrypt: true
    })
    expect(calls).toEqual(['available', 'encrypt:key', 'decrypt:blob'])
  })

  it('stores only encrypted key bytes with private permissions and restores status', async () => {
    const dataDirectory = await temporaryDirectory()
    const { publicKey, privateKey } = testKeys()
    const protector = new AsyncTestProtector()
    const token = issueToken(privateKey)
    const service = new LicenseService({
      dataDirectory,
      protector,
      publicKey,
      deviceCode: DEVICE_CODE,
      now: () => NOW_MS
    })

    expect(await service.load()).toEqual({
      state: 'missing',
      active: false,
      deviceCode: DEVICE_CODE,
      license: null,
      message: null
    })
    await expect(service.activate(token)).resolves.toMatchObject({ state: 'active', active: true })

    const paths = getLicenseStoragePaths(dataDirectory)
    const encrypted = await readFile(paths.token)
    expect(encrypted.toString('utf8')).not.toContain(token)
    expect(encrypted.toString('utf8')).not.toContain('Тестовый пилот')
    await expectPrivatePathMode(paths.token, 0o600)
    await expectPrivatePathMode(paths.directory, 0o700)

    const restored = new LicenseService({
      dataDirectory,
      protector,
      publicKey,
      deviceCode: DEVICE_CODE,
      now: () => NOW_MS
    })
    expect(await restored.load()).toMatchObject({
      state: 'active',
      active: true,
      deviceCode: DEVICE_CODE,
      license: { licenseId: 'lic-test-001', customer: 'Тестовый пилот' }
    })
  })

  it('stores a signed device-bound entitlement on macOS without invoking secret storage', async () => {
    const dataDirectory = await temporaryDirectory()
    const { publicKey, privateKey } = testKeys()
    const token = issueToken(privateKey)
    const protector: LicenseSecretProtector = {
      isEncryptionAvailable: () => { throw new Error('must not run') },
      encryptString: () => { throw new Error('must not run') },
      decryptString: () => { throw new Error('must not run') }
    }
    const service = new LicenseService({
      dataDirectory,
      protector,
      storageMode: 'signed-file',
      publicKey,
      deviceCode: DEVICE_CODE,
      now: () => NOW_MS
    })

    await expect(service.load()).resolves.toMatchObject({ state: 'missing' })
    await expect(service.activate(token)).resolves.toMatchObject({ state: 'active' })
    expect(await readFile(service.storagePaths.token, 'utf8')).toBe(token)
    await expectPrivatePathMode(service.storagePaths.token, 0o600)

    const restored = new LicenseService({
      dataDirectory,
      protector,
      storageMode: 'signed-file',
      publicKey,
      deviceCode: DEVICE_CODE,
      now: () => NOW_MS
    })
    await expect(restored.load()).resolves.toMatchObject({
      state: 'active',
      license: { licenseId: 'lic-test-001' }
    })
  })

  it('does not open Keychain for a legacy encrypted license in signed-file mode', async () => {
    const dataDirectory = await temporaryDirectory()
    const { publicKey, privateKey } = testKeys()
    const encryptedService = new LicenseService({
      dataDirectory,
      protector: new AsyncTestProtector(),
      publicKey,
      deviceCode: DEVICE_CODE,
      now: () => NOW_MS
    })
    await encryptedService.activate(issueToken(privateKey))

    const noKeychain: LicenseSecretProtector = {
      isEncryptionAvailable: () => { throw new Error('must not run') },
      encryptString: () => { throw new Error('must not run') },
      decryptString: () => { throw new Error('must not run') }
    }
    const upgraded = new LicenseService({
      dataDirectory,
      protector: noKeychain,
      storageMode: 'signed-file',
      publicKey,
      deviceCode: DEVICE_CODE,
      now: () => NOW_MS
    })

    await expect(upgraded.load()).resolves.toMatchObject({
      state: 'storage_error',
      message: expect.stringContaining('старой версией')
    })
  })

  it('does not overwrite an active key when new activation is invalid', async () => {
    const dataDirectory = await temporaryDirectory()
    const goodKeys = testKeys()
    const unrelatedKeys = testKeys()
    const protector = new AsyncTestProtector()
    const service = new LicenseService({
      dataDirectory,
      protector,
      publicKey: goodKeys.publicKey,
      deviceCode: DEVICE_CODE,
      now: () => NOW_MS
    })

    await service.activate(issueToken(goodKeys.privateKey))
    const before = await readFile(service.storagePaths.token)
    await expect(service.activate(issueToken(unrelatedKeys.privateKey))).rejects.toMatchObject({
      code: 'invalid_signature'
    })
    expect(await readFile(service.storagePaths.token)).toEqual(before)
    expect(await service.load()).toMatchObject({ state: 'active', active: true })
  })

  it('supports async storage rotation, deactivation, and unavailable safe storage', async () => {
    const dataDirectory = await temporaryDirectory()
    const { publicKey, privateKey } = testKeys()
    const protector = new AsyncTestProtector()
    const service = new LicenseService({
      dataDirectory,
      protector,
      publicKey,
      deviceCode: DEVICE_CODE,
      now: () => NOW_MS
    })

    await service.activate(issueToken(privateKey))
    protector.reencrypt = true
    expect(await service.load()).toMatchObject({ state: 'active' })
    expect(protector.encryptCalls).toBe(2)
    expect(await service.deactivate()).toMatchObject({ state: 'missing', active: false })

    const unavailable = new LicenseService({
      dataDirectory: await temporaryDirectory(),
      protector: new AsyncTestProtector(false),
      publicKey,
      deviceCode: DEVICE_CODE,
      now: () => NOW_MS
    })
    expect(await unavailable.load()).toMatchObject({ state: 'storage_unavailable', active: false })
    await expect(unavailable.activate(issueToken(privateKey))).rejects.toMatchObject({
      code: 'secure_storage_unavailable'
    })
  })
})
