import { randomUUID } from 'node:crypto'
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
  EVE_SSO_REDIRECT_URI,
  EncryptedRefreshTokenStore,
  EveSsoClient,
  EveSsoError,
  type EncryptedBlobStore,
  type EveSsoOptions,
  type EveSsoScope,
  type EveSsoSession,
  type SecretProtector
} from './eve-sso'

const ACCOUNT_DIRECTORY_NAME = 'eve-account'
export const EVE_ACCOUNT_CONFIG_FILENAME = 'config.json'
export const EVE_ACCOUNT_REFRESH_TOKEN_FILENAME = 'refresh-token.bin'

const ACCOUNT_CONFIG_VERSION = 1
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_CONFIG_BYTES = 8 * 1_024
const MAX_ENCRYPTED_TOKEN_BYTES = 256 * 1_024
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._~-]{3,256}$/
const privateFileOperations = new Map<string, Promise<void>>()

export type EveAccountErrorCode =
  | 'invalid_config'
  | 'config_read_failed'
  | 'config_write_failed'
  | 'operation_failed'

export class EveAccountError extends Error {
  readonly code: EveAccountErrorCode

  constructor(code: EveAccountErrorCode, message: string) {
    super(message)
    this.name = 'EveAccountError'
    this.code = code
  }
}

export interface EveAccountStatus {
  configured: boolean
  connected: boolean
  clientId: string | null
  callbackUri: typeof EVE_SSO_REDIRECT_URI
  characterId: number | null
  characterName: string | null
  scopes: EveSsoScope[]
  error: string | null
  /** True when refresh tokens intentionally live only until the app closes. */
  sessionOnly?: boolean
}

/** Kept in the Electron main process. Never expose this value through preload/IPC. */
export interface EveAuthorizedSession {
  accessToken: string
  session: EveSsoSession
}

export interface EveSsoClientAdapter {
  login(options?: { industry?: boolean }): Promise<EveSsoSession>
  /** Cancels an in-flight browser login without waiting for the callback timeout. */
  cancelLogin?(): Promise<void>
  restoreSession(): Promise<EveSsoSession | null>
  getAccessToken(): Promise<string | null>
  getSession(): EveSsoSession | null
  clearLocalSession(): Promise<void>
}

export type EveSsoClientFactory = (options: EveSsoOptions) => EveSsoClientAdapter

export interface EveAccountServiceOptions {
  /** Usually `app.getPath('userData')`. A private `eve-account` child is created. */
  dataDirectory: string
  /** Fly Safe OAuth Client ID. It is application-owned and never supplied by the renderer. */
  clientId: string
  protector: SecretProtector
  /** Pass `shell.openExternal` from the Electron main process. */
  openExternal: EveSsoOptions['openExternal']
  clientFactory?: EveSsoClientFactory
}

export interface EveAccountStoragePaths {
  directory: string
  config: string
  refreshToken: string
}

interface StoredAccountConfig {
  version: typeof ACCOUNT_CONFIG_VERSION
  clientId: string
}

/** Byte-only adapter used underneath `EncryptedRefreshTokenStore`. */
export class AtomicFileBlobStore implements EncryptedBlobStore {
  constructor(private readonly filePath: string) {
    if (!isAbsolute(filePath)) {
      throw new EveAccountError('invalid_config', 'Token-store path must be absolute')
    }
  }

  async read(): Promise<Uint8Array | null> {
    try {
      const value = await readOptionalPrivateFile(this.filePath, MAX_ENCRYPTED_TOKEN_BYTES)
      return value === null ? null : new Uint8Array(value)
    } catch (error) {
      if (error instanceof EveSsoError) throw error
      throw new EveSsoError('secure_storage_failed', 'Could not read protected EVE SSO token')
    }
  }

  async write(value: Uint8Array): Promise<void> {
    if (!(value instanceof Uint8Array) || value.byteLength === 0) {
      throw new EveSsoError('secure_storage_failed', 'Encrypted EVE SSO token is empty')
    }
    if (value.byteLength > MAX_ENCRYPTED_TOKEN_BYTES) {
      throw new EveSsoError('secure_storage_failed', 'Encrypted EVE SSO token is too large')
    }

    try {
      await atomicWritePrivateFile(this.filePath, value)
    } catch (error) {
      if (error instanceof EveSsoError) throw error
      throw new EveSsoError('secure_storage_failed', 'Could not write protected EVE SSO token')
    }
  }

  async clear(): Promise<void> {
    try {
      await serializePrivateFileOperation(this.filePath, () => unlinkIfPresent(this.filePath))
    } catch {
      throw new EveSsoError('secure_storage_failed', 'Could not remove local EVE SSO token')
    }
  }
}

class AccountConfigStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoredAccountConfig | null> {
    let bytes: Uint8Array | null
    try {
      bytes = await readOptionalPrivateFile(this.filePath, MAX_CONFIG_BYTES)
    } catch {
      throw new EveAccountError('config_read_failed', 'Could not read EVE SSO configuration')
    }
    if (bytes === null) return null

    let value: unknown
    try {
      value = JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch {
      throw new EveAccountError('config_read_failed', 'EVE SSO configuration is corrupted')
    }

    if (!isRecord(value) || value.version !== ACCOUNT_CONFIG_VERSION) {
      throw new EveAccountError('config_read_failed', 'EVE SSO configuration version is unsupported')
    }
    const clientId = validateClientId(value.clientId)
    return { version: ACCOUNT_CONFIG_VERSION, clientId }
  }

  async save(clientId: string): Promise<void> {
    const config: StoredAccountConfig = {
      version: ACCOUNT_CONFIG_VERSION,
      clientId: validateClientId(clientId)
    }
    const bytes = Buffer.from(`${JSON.stringify(config)}\n`, 'utf8')

    try {
      await atomicWritePrivateFile(this.filePath, bytes)
    } catch {
      throw new EveAccountError('config_write_failed', 'Could not save EVE SSO configuration')
    }
  }
}

export class EveAccountService {
  readonly storagePaths: EveAccountStoragePaths

  private readonly configStore: AccountConfigStore
  private readonly refreshTokenStore: EncryptedRefreshTokenStore
  private readonly openExternal: EveSsoOptions['openExternal']
  private readonly clientFactory: EveSsoClientFactory
  private readonly applicationClientId: string

  private clientId: string | null = null
  private client: EveSsoClientAdapter | null = null
  private lastError: string | null = null
  private loadPromise: Promise<void> | null = null
  private operationTail: Promise<void> = Promise.resolve()

  constructor(options: EveAccountServiceOptions) {
    validateServiceOptions(options)
    this.storagePaths = getEveAccountStoragePaths(options.dataDirectory)
    this.configStore = new AccountConfigStore(this.storagePaths.config)
    this.refreshTokenStore = new EncryptedRefreshTokenStore(
      new AtomicFileBlobStore(this.storagePaths.refreshToken),
      options.protector
    )
    this.openExternal = options.openExternal
    this.applicationClientId = validateClientId(options.clientId)
    this.clientFactory = options.clientFactory ?? ((ssoOptions) => new EveSsoClient(ssoOptions))
  }

  /** Loads only public configuration. It never decrypts a refresh token. */
  async load(): Promise<EveAccountStatus> {
    await this.ensureLoaded()
    return this.snapshotStatus()
  }

  /** Opens EVE SSO in the system browser and waits for the fixed loopback callback. */
  connect(): Promise<EveAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      const client = this.requireConfiguredClient()

      try {
        await client.login()
        this.lastError = null
        return this.snapshotStatus()
      } catch (error) {
        throw this.captureError(error, 'Could not connect EVE account')
      }
    })
  }

  /** Exchanges the encrypted refresh token for a new in-memory access token. */
  restore(): Promise<EveAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      if (!this.client) {
        return this.snapshotStatus()
      }

      try {
        await this.client.restoreSession()
        this.lastError = null
        return this.snapshotStatus()
      } catch (error) {
        throw this.captureError(error, 'Could not restore EVE account')
      }
    })
  }

  async getStatus(): Promise<EveAccountStatus> {
    await this.ensureLoaded()
    return this.snapshotStatus()
  }

  /** Main-process capability. Access tokens must not cross the IPC/preload boundary. */
  getAuthorizedSession(): Promise<EveAuthorizedSession | null> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      if (!this.client) return null

      try {
        const accessToken = await this.client.getAccessToken()
        const session = this.client.getSession()
        if (!accessToken || !session) {
          this.lastError = null
          return null
        }

        this.lastError = null
        return {
          accessToken,
          session: cloneSession(session)
        }
      } catch (error) {
        throw this.captureError(error, 'Could not get authorized EVE session')
      }
    })
  }

  /** Local disconnect. Keeps the public Client ID, deletes the encrypted refresh token. */
  disconnect(): Promise<EveAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()

      try {
        if (this.client) await this.client.clearLocalSession()
        else await this.refreshTokenStore.clear()
        this.lastError = null
        return this.snapshotStatus()
      } catch (error) {
        throw this.captureError(error, 'Could not disconnect EVE account')
      }
    })
  }

  private ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise

    this.loadPromise = (async () => {
      let storedClientId: string | null = null
      try {
        storedClientId = (await this.configStore.load())?.clientId ?? null
      } catch {
        // A corrupt legacy public config must not block the embedded application identity.
      }

      try {
        if (storedClientId !== this.applicationClientId) {
          // A refresh token is issued to one OAuth client and cannot be migrated.
          await this.refreshTokenStore.clear()
          await this.configStore.save(this.applicationClientId)
        }
        this.clientId = this.applicationClientId
        this.client = this.createClient(this.applicationClientId)
        this.lastError = null
      } catch (error) {
        this.clientId = this.applicationClientId
        this.client = this.createClient(this.applicationClientId)
        this.lastError = publicErrorMessage(error, 'Could not prepare EVE SSO configuration')
      }
    })()
    return this.loadPromise
  }

  private createClient(clientId: string): EveSsoClientAdapter {
    return this.clientFactory({
      clientId,
      openExternal: this.openExternal,
      refreshTokenStore: this.refreshTokenStore
    })
  }

  private requireConfiguredClient(): EveSsoClientAdapter {
    if (this.client) return this.client
    const error = new EveAccountError(
      'invalid_config',
      'Built-in Fly Safe EVE SSO configuration is unavailable'
    )
    this.lastError = error.message
    throw error
  }

  private captureError(error: unknown, fallback: string): Error {
    const normalized = normalizeOperationError(error, fallback)
    this.lastError = normalized.message
    return normalized
  }

  private snapshotStatus(): EveAccountStatus {
    const session = this.client?.getSession() ?? null
    return {
      configured: this.clientId !== null,
      connected: session !== null,
      clientId: this.clientId,
      callbackUri: EVE_SSO_REDIRECT_URI,
      characterId: session?.characterId ?? null,
      characterName: session?.characterName ?? null,
      scopes: session ? [...session.scopes] : [],
      error: this.lastError
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

export function getEveAccountStoragePaths(dataDirectory: string): EveAccountStoragePaths {
  if (typeof dataDirectory !== 'string' || dataDirectory.trim() === '') {
    throw new EveAccountError('invalid_config', 'EVE account data directory is not set')
  }
  const baseDirectory = resolve(dataDirectory)
  const directory = join(baseDirectory, ACCOUNT_DIRECTORY_NAME)
  return {
    directory,
    config: join(directory, EVE_ACCOUNT_CONFIG_FILENAME),
    refreshToken: join(directory, EVE_ACCOUNT_REFRESH_TOKEN_FILENAME)
  }
}

function validateServiceOptions(options: EveAccountServiceOptions): void {
  if (!options || typeof options !== 'object') {
    throw new EveAccountError('invalid_config', 'EVE account-service settings are required')
  }
  getEveAccountStoragePaths(options.dataDirectory)
  validateClientId(options.clientId)
  if (typeof options.openExternal !== 'function') {
    throw new EveAccountError('invalid_config', 'EVE SSO system browser is not set')
  }
  if (
    !options.protector ||
    typeof options.protector.isEncryptionAvailable !== 'function' ||
    typeof options.protector.encryptString !== 'function' ||
    typeof options.protector.decryptString !== 'function'
  ) {
    throw new EveAccountError('invalid_config', 'EVE SSO system encryption is not set')
  }
  if (options.clientFactory !== undefined && typeof options.clientFactory !== 'function') {
    throw new EveAccountError('invalid_config', 'Invalid EVE SSO factory')
  }
}

function validateClientId(value: unknown): string {
  if (typeof value !== 'string' || !CLIENT_ID_PATTERN.test(value)) {
    throw new EveAccountError('invalid_config', 'Invalid EVE SSO client ID')
  }
  return value
}

async function readOptionalPrivateFile(filePath: string, maxBytes: number): Promise<Uint8Array | null> {
  return serializePrivateFileOperation(filePath, () => readPrivateFile(filePath, maxBytes))
}

async function readPrivateFile(filePath: string, maxBytes: number): Promise<Uint8Array | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }

  if (bytes.byteLength > maxBytes) throw new RangeError('Private file exceeds size limit')
  await chmod(filePath, PRIVATE_FILE_MODE)
  return bytes
}

async function atomicWritePrivateFile(filePath: string, value: Uint8Array): Promise<void> {
  return serializePrivateFileOperation(filePath, () => writePrivateFileAtomically(filePath, value))
}

async function writePrivateFileAtomically(filePath: string, value: Uint8Array): Promise<void> {
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

function serializePrivateFileOperation<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const absolutePath = resolve(filePath)
  const key = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath
  const previous = privateFileOperations.get(key) ?? Promise.resolve()
  const result = previous.then(operation)
  const settled = result.then(() => undefined, () => undefined)
  privateFileOperations.set(key, settled)
  return result.finally(() => {
    if (privateFileOperations.get(key) === settled) privateFileOperations.delete(key)
  })
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
}

function cloneSession(session: EveSsoSession): EveSsoSession {
  return {
    characterId: session.characterId,
    characterName: session.characterName,
    scopes: [...session.scopes],
    expiresAt: session.expiresAt
  }
}

function normalizeOperationError(error: unknown, fallback: string): Error {
  if (error instanceof EveSsoError || error instanceof EveAccountError) return error
  return new EveAccountError('operation_failed', fallback)
}

function publicErrorMessage(error: unknown, fallback: string): string {
  return normalizeOperationError(error, fallback).message
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
