import {
  createPublicKey,
  KeyObject,
  randomUUID,
  verify
} from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  LicenseTokenFormatError,
  normalizeDeviceCode,
  parseLicenseToken,
  toLicenseInfo,
  type LicenseInfo,
  type LicenseState,
  type LicenseStatus,
  type VerifiedLicenseClaims
} from '../shared/license'

const LICENSE_DIRECTORY_NAME = 'eve-license'
export const LICENSE_TOKEN_FILENAME = 'license.bin'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_ENCRYPTED_LICENSE_BYTES = 64 * 1_024
const DEFAULT_CLOCK_SKEW_SECONDS = 5 * 60

type MaybePromise<T> = T | Promise<T>

export type LicenseErrorCode =
  | 'invalid_config'
  | 'invalid_format'
  | 'invalid_payload'
  | 'invalid_signature'
  | 'device_mismatch'
  | 'not_yet_valid'
  | 'expired'
  | 'secure_storage_unavailable'
  | 'secure_storage_failed'
  | 'storage_failed'

export class LicenseError extends Error {
  readonly code: LicenseErrorCode
  readonly license: LicenseInfo | null

  constructor(code: LicenseErrorCode, message: string, license: LicenseInfo | null = null) {
    super(message)
    this.name = 'LicenseError'
    this.code = code
    this.license = license
  }
}

/**
 * Adapter for Electron safeStorage. Production wiring can use the async Electron 43 APIs;
 * tests and older adapters may return synchronously. Plaintext fallback is never allowed.
 */
export interface LicenseSecretProtector {
  isEncryptionAvailable(): MaybePromise<boolean>
  encryptString(plaintext: string): MaybePromise<Uint8Array>
  decryptString(ciphertext: Uint8Array): MaybePromise<string | LicenseDecryptionResult>
  /** When Electron reports old encryption material, the service atomically re-encrypts it. */
  shouldReEncrypt?(ciphertext: Uint8Array): MaybePromise<boolean>
}

export interface LicenseDecryptionResult {
  result: string
  shouldReEncrypt: boolean
}

/** Minimal Electron 43 `safeStorage` surface; kept injectable for tests. */
export interface ElectronAsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plaintext: string): Promise<Uint8Array>
  decryptStringAsync(ciphertext: Buffer): Promise<LicenseDecryptionResult>
}

/** Uses Electron's non-blocking Keychain API without allowing a plaintext fallback. */
export function createAsyncSafeStorageProtector(
  safeStorage: ElectronAsyncSafeStorage
): LicenseSecretProtector {
  return {
    isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encryptString: (plaintext) => safeStorage.encryptStringAsync(plaintext),
    decryptString: (ciphertext) => safeStorage.decryptStringAsync(Buffer.from(ciphertext))
  }
}

export type LicensePublicKey = KeyObject | string | Buffer

export interface VerifyLicenseOptions {
  publicKey: LicensePublicKey
  deviceCode: string
  /** Returns Unix time in milliseconds. */
  now?: () => number
  allowedClockSkewSeconds?: number
  /** Optional allowlist used for explicit EVEI2 key rotation. */
  trustedEntitlementKeyIds?: readonly string[]
}

export interface VerifiedLicense {
  claims: VerifiedLicenseClaims
  license: LicenseInfo
}

export interface LicenseServiceOptions extends VerifyLicenseOptions {
  /** Usually `app.getPath('userData')`; a private `eve-license` child is created. */
  dataDirectory: string
  protector: LicenseSecretProtector
  /** Signed device-bound entitlements do not need Keychain secrecy on macOS. */
  storageMode?: 'encrypted' | 'signed-file'
}

export interface LicenseStoragePaths {
  directory: string
  token: string
}

export function getLicenseStoragePaths(dataDirectory: string): LicenseStoragePaths {
  if (typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory)) {
    throw new LicenseError('invalid_config', 'Путь хранилища лицензии должен быть абсолютным')
  }

  const directory = resolve(dataDirectory, LICENSE_DIRECTORY_NAME)
  return {
    directory,
    token: join(directory, LICENSE_TOKEN_FILENAME)
  }
}

/** Authenticates a signed key, then enforces its exact device binding and lifetime. */
export function verifyLicenseToken(token: string, options: VerifyLicenseOptions): VerifiedLicense {
  const publicKey = normalizePublicKey(options.publicKey)
  const deviceCode = normalizeVerifierDeviceCode(options.deviceCode)
  const allowedClockSkewSeconds = normalizeClockSkew(options.allowedClockSkewSeconds)
  const trustedEntitlementKeyIds = normalizeTrustedKeyIds(options.trustedEntitlementKeyIds)

  let parsed: ReturnType<typeof parseLicenseToken>
  try {
    parsed = parseLicenseToken(token)
  } catch (error) {
    if (error instanceof LicenseTokenFormatError) {
      throw new LicenseError(error.code, error.message)
    }
    throw new LicenseError('invalid_format', 'Лицензионный ключ имеет неверный формат')
  }

  let authentic = false
  try {
    authentic = verify(null, parsed.signingBytes, publicKey, parsed.signature)
  } catch {
    authentic = false
  }
  if (!authentic) {
    throw new LicenseError('invalid_signature', 'Подпись лицензионного ключа недействительна')
  }
  if (
    parsed.claims.v === 2 &&
    trustedEntitlementKeyIds !== null &&
    !trustedEntitlementKeyIds.has(parsed.claims.kid)
  ) {
    throw new LicenseError('invalid_signature', 'Ключ подписи entitlement не поддерживается')
  }

  const license = toLicenseInfo(parsed.claims)
  if (parsed.claims.deviceCode !== deviceCode) {
    throw new LicenseError(
      'device_mismatch',
      'Этот лицензионный ключ выпущен для другого устройства',
      license
    )
  }

  const nowSeconds = currentUnixSeconds(options.now)
  const notBefore = parsed.claims.v === 2 ? parsed.claims.notBefore : parsed.claims.issuedAt
  if (notBefore > nowSeconds + allowedClockSkewSeconds) {
    throw new LicenseError('not_yet_valid', 'Лицензионный ключ ещё не начал действовать', license)
  }
  if (parsed.claims.expiresAt !== null && nowSeconds >= parsed.claims.expiresAt) {
    throw new LicenseError('expired', 'Срок действия лицензионного ключа истёк', license)
  }

  return { claims: parsed.claims, license }
}

export class LicenseService {
  readonly storagePaths: LicenseStoragePaths
  readonly deviceCode: string

  private readonly protector: LicenseSecretProtector
  private readonly storageMode: 'encrypted' | 'signed-file'
  private readonly publicKey: KeyObject
  private readonly now: () => number
  private readonly allowedClockSkewSeconds: number
  private readonly trustedEntitlementKeyIds: readonly string[] | undefined
  private operationTail: Promise<void> = Promise.resolve()

  constructor(options: LicenseServiceOptions) {
    if (!options || typeof options !== 'object') {
      throw new LicenseError('invalid_config', 'Конфигурация лицензирования отсутствует')
    }
    if (!isProtector(options.protector)) {
      throw new LicenseError('invalid_config', 'Защищённое хранилище лицензии не настроено')
    }
    if (
      options.storageMode !== undefined &&
      options.storageMode !== 'encrypted' &&
      options.storageMode !== 'signed-file'
    ) {
      throw new LicenseError('invalid_config', 'Некорректный режим хранения лицензии')
    }

    this.storagePaths = getLicenseStoragePaths(options.dataDirectory)
    this.deviceCode = normalizeVerifierDeviceCode(options.deviceCode)
    this.publicKey = normalizePublicKey(options.publicKey)
    this.protector = options.protector
    this.storageMode = options.storageMode ?? 'encrypted'
    this.now = options.now ?? Date.now
    this.allowedClockSkewSeconds = normalizeClockSkew(options.allowedClockSkewSeconds)
    this.trustedEntitlementKeyIds = options.trustedEntitlementKeyIds
      ? [...options.trustedEntitlementKeyIds]
      : undefined
  }

  async load(): Promise<LicenseStatus> {
    return this.serialize(() => this.readStatus())
  }

  async getStatus(): Promise<LicenseStatus> {
    return this.load()
  }

  /** Invalid keys never replace a previously stored valid key. */
  async activate(token: string): Promise<LicenseStatus> {
    return this.serialize(async () => {
      const verified = this.verify(token)
      const normalizedToken = token.trim()

      if (this.storageMode === 'signed-file') {
        try {
          await atomicWritePrivateFile(
            this.storagePaths.token,
            Buffer.from(normalizedToken, 'utf8')
          )
        } catch {
          throw new LicenseError('storage_failed', 'Не удалось сохранить лицензионный ключ')
        }
        return activeStatus(this.deviceCode, verified.license)
      }

      await this.assertSecureStorageAvailable()

      let encrypted: Uint8Array
      try {
        encrypted = await this.protector.encryptString(normalizedToken)
      } catch {
        throw new LicenseError(
          'secure_storage_failed',
          'Не удалось зашифровать лицензионный ключ в системном хранилище'
        )
      }
      assertEncryptedBytes(encrypted)

      try {
        await atomicWritePrivateFile(this.storagePaths.token, encrypted)
      } catch {
        throw new LicenseError('storage_failed', 'Не удалось сохранить лицензионный ключ')
      }

      return activeStatus(this.deviceCode, verified.license)
    })
  }

  async deactivate(): Promise<LicenseStatus> {
    return this.serialize(async () => {
      try {
        await unlinkIfPresent(this.storagePaths.token)
      } catch {
        throw new LicenseError('storage_failed', 'Не удалось удалить лицензионный ключ')
      }
      return missingStatus(this.deviceCode)
    })
  }

  private verify(token: string): VerifiedLicense {
    return verifyLicenseToken(token, {
      publicKey: this.publicKey,
      deviceCode: this.deviceCode,
      now: this.now,
      allowedClockSkewSeconds: this.allowedClockSkewSeconds,
      trustedEntitlementKeyIds: this.trustedEntitlementKeyIds
    })
  }

  private async readStatus(): Promise<LicenseStatus> {
    if (this.storageMode === 'encrypted') {
      try {
        await this.assertSecureStorageAvailable()
      } catch (error) {
        return errorStatus(this.deviceCode, normalizeLicenseError(error))
      }
    }

    let encrypted: Uint8Array | null
    try {
      encrypted = await readOptionalPrivateFile(this.storagePaths.token)
    } catch {
      return status('storage_error', this.deviceCode, null, 'Не удалось прочитать лицензионный ключ')
    }
    if (encrypted === null) return missingStatus(this.deviceCode)

    let token: string
    let shouldReEncrypt = false
    if (this.storageMode === 'signed-file') {
      token = Buffer.from(encrypted).toString('utf8').trim()
      if (!/^EVEI[12]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
        return status(
          'storage_error',
          this.deviceCode,
          null,
          'Лицензия сохранена старой версией. Войдите снова для перевыдачи entitlement или вставьте ключ повторно.'
        )
      }
    } else {
      try {
        const decrypted = await this.protector.decryptString(encrypted)
        if (typeof decrypted === 'string') {
          token = decrypted
        } else if (isDecryptionResult(decrypted)) {
          token = decrypted.result
          shouldReEncrypt = decrypted.shouldReEncrypt
        } else {
          throw new Error('Invalid decryption result')
        }
        if (typeof token !== 'string' || token.length === 0) throw new Error('Empty decrypted token')
      } catch {
        return status(
          'storage_error',
          this.deviceCode,
          null,
          'Не удалось расшифровать лицензионный ключ в системном хранилище'
        )
      }
    }

    let verified: VerifiedLicense
    try {
      verified = this.verify(token)
    } catch (error) {
      return errorStatus(this.deviceCode, normalizeLicenseError(error))
    }

    if (this.storageMode === 'encrypted' && (this.protector.shouldReEncrypt || shouldReEncrypt)) {
      try {
        if (shouldReEncrypt || (await this.protector.shouldReEncrypt?.(encrypted))) {
          const refreshed = await this.protector.encryptString(token)
          assertEncryptedBytes(refreshed)
          await atomicWritePrivateFile(this.storagePaths.token, refreshed)
        }
      } catch {
        // A still-authentic stored key remains usable. Re-encryption can retry on next load.
      }
    }

    return activeStatus(this.deviceCode, verified.license)
  }

  private async assertSecureStorageAvailable(): Promise<void> {
    let available = false
    try {
      available = await this.protector.isEncryptionAvailable()
    } catch {
      available = false
    }
    if (!available) {
      throw new LicenseError(
        'secure_storage_unavailable',
        'Защищённое хранилище операционной системы недоступно'
      )
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function normalizeTrustedKeyIds(value: readonly string[] | undefined): Set<string> | null {
  if (value === undefined) return null
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    value.some((keyId) => typeof keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(keyId))
  ) {
    throw new LicenseError('invalid_config', 'Некорректный список ключей entitlement')
  }
  return new Set(value)
}

function activeStatus(deviceCode: string, license: LicenseInfo): LicenseStatus {
  return status('active', deviceCode, license, null)
}

function missingStatus(deviceCode: string): LicenseStatus {
  return status('missing', deviceCode, null, null)
}

function errorStatus(deviceCode: string, error: LicenseError): LicenseStatus {
  return status(stateForError(error.code), deviceCode, error.license, error.message)
}

function status(
  state: LicenseState,
  deviceCode: string,
  license: LicenseInfo | null,
  message: string | null
): LicenseStatus {
  return {
    state,
    active: state === 'active',
    deviceCode,
    license: license ? { ...license } : null,
    message
  }
}

function stateForError(code: LicenseErrorCode): LicenseState {
  switch (code) {
    case 'expired':
      return 'expired'
    case 'not_yet_valid':
      return 'not_yet_valid'
    case 'device_mismatch':
      return 'device_mismatch'
    case 'secure_storage_unavailable':
      return 'storage_unavailable'
    case 'secure_storage_failed':
    case 'storage_failed':
      return 'storage_error'
    default:
      return 'invalid'
  }
}

function normalizeLicenseError(error: unknown): LicenseError {
  if (error instanceof LicenseError) return error
  return new LicenseError('storage_failed', 'Не удалось проверить лицензионный ключ')
}

function normalizePublicKey(value: LicensePublicKey): KeyObject {
  let key: KeyObject
  try {
    if (value instanceof KeyObject) {
      if (value.type !== 'public') throw new Error('Expected public key')
      key = value
    } else {
      key = createPublicKey(value)
    }
  } catch {
    throw new LicenseError('invalid_config', 'Публичный ключ лицензирования имеет неверный формат')
  }

  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new LicenseError('invalid_config', 'Для лицензий требуется публичный ключ Ed25519')
  }
  return key
}

function normalizeVerifierDeviceCode(value: string): string {
  try {
    return normalizeDeviceCode(value)
  } catch {
    throw new LicenseError('invalid_config', 'Код этого устройства имеет неверный формат')
  }
}

function normalizeClockSkew(value: number | undefined): number {
  const normalized = value ?? DEFAULT_CLOCK_SKEW_SECONDS
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 24 * 60 * 60) {
    throw new LicenseError('invalid_config', 'Допуск системных часов имеет неверное значение')
  }
  return normalized
}

function currentUnixSeconds(now: (() => number) | undefined): number {
  const milliseconds = (now ?? Date.now)()
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new LicenseError('invalid_config', 'Системное время имеет неверное значение')
  }
  return Math.floor(milliseconds / 1_000)
}

function assertEncryptedBytes(value: Uint8Array): void {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > MAX_ENCRYPTED_LICENSE_BYTES
  ) {
    throw new LicenseError('secure_storage_failed', 'Зашифрованный лицензионный ключ повреждён')
  }
}

async function readOptionalPrivateFile(filePath: string): Promise<Uint8Array | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENCRYPTED_LICENSE_BYTES) {
    throw new RangeError('Encrypted license file exceeds size limit')
  }
  await chmod(filePath, PRIVATE_FILE_MODE)
  return new Uint8Array(bytes)
}

async function atomicWritePrivateFile(filePath: string, value: Uint8Array): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(directory, PRIVATE_DIRECTORY_MODE)

  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  )
  let handle: FileHandle | null = null

  try {
    handle = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE)
    await handle.writeFile(value)
    await handle.sync()
    await handle.chmod(PRIVATE_FILE_MODE)
    await handle.close()
    handle = null
    await rename(temporaryPath, filePath)
    await chmod(filePath, PRIVATE_FILE_MODE)
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await unlinkIfPresent(temporaryPath).catch(() => undefined)
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
}

function isProtector(value: unknown): value is LicenseSecretProtector {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LicenseSecretProtector>
  return (
    typeof candidate.isEncryptionAvailable === 'function' &&
    typeof candidate.encryptString === 'function' &&
    typeof candidate.decryptString === 'function'
  )
}

function isDecryptionResult(value: unknown): value is LicenseDecryptionResult {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LicenseDecryptionResult>
  return typeof candidate.result === 'string' && typeof candidate.shouldReEncrypt === 'boolean'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
}
