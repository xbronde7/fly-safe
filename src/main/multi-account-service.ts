import { randomUUID } from 'node:crypto'
import { readdir, readFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FLY_SAFE_EVE_CALLBACK_URI } from '../shared/eve-application'
import type {
  EveCharacterAccountStatus,
  EveLegacyMigrationState,
  EveMultiAccountStatus,
  EveMultiAccountState
} from '../shared/multi-account'
import {
  AtomicFileBlobStore,
  EveAccountError,
  getEveAccountStoragePaths,
  type EveAccountStatus,
  type EveAuthorizedSession,
  type EveSsoClientAdapter,
  type EveSsoClientFactory
} from './account-service'
import {
  EVE_SSO_REDIRECT_URI,
  EVE_SSO_SUPPORTED_SCOPES,
  EncryptedRefreshTokenStore,
  EveSsoClient,
  EveSsoError,
  type EveSsoOptions,
  type EveSsoScope,
  type EveSsoSession,
  type SecretProtector,
  type SecureRefreshTokenStore
} from './eve-sso'

const MULTI_ACCOUNT_DIRECTORY_NAME = 'eve-accounts'
export const EVE_MULTI_ACCOUNT_REGISTRY_FILENAME = 'registry.json'
export const EVE_MULTI_ACCOUNT_TOKEN_DIRECTORY_NAME = 'tokens'

export const DEFAULT_EVE_MULTI_ACCOUNT_LIMIT = 8
export const MAX_EVE_MULTI_ACCOUNT_LIMIT = 50

const REGISTRY_VERSION = 1
const MAX_REGISTRY_BYTES = 256 * 1_024
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._~-]{3,256}$/
const TOKEN_FILENAME_PATTERN = /^([1-9]\d*)\.bin$/
const OAUTH_CLIENT_CHANGED_MESSAGE =
  'EVE SSO application changed. Sign in again with each character.'

export type EveMultiAccountErrorCode =
  | 'invalid_config'
  | 'registry_read_failed'
  | 'registry_write_failed'
  | 'character_limit_reached'
  | 'character_not_found'
  | 'character_mismatch'
  | 'operation_failed'

export class EveMultiAccountError extends Error {
  readonly code: EveMultiAccountErrorCode

  constructor(code: EveMultiAccountErrorCode, message: string) {
    super(message)
    this.name = 'EveMultiAccountError'
    this.code = code
  }
}

export interface EveMultiAccountServiceOptions {
  /** Usually `app.getPath('userData')`. */
  dataDirectory: string
  /** Application-owned Fly Safe OAuth Client ID. Never accept it from IPC. */
  clientId: string
  protector: SecretProtector
  /** macOS ad-hoc builds use memory-only tokens so Keychain cannot block login. */
  credentialPersistence?: 'encrypted' | 'memory'
  openExternal: EveSsoOptions['openExternal']
  clientFactory?: EveSsoClientFactory
  maxCharacters?: number
  now?: () => number
}

export interface EveMultiAccountStoragePaths {
  directory: string
  registry: string
  tokensDirectory: string
}

interface StoredCharacterAccount {
  characterId: number
  characterName: string
  scopes: EveSsoScope[]
  addedAt: string
  lastAuthenticatedAt: string
  lastSelectedAt: string | null
  lastDisconnectedAt: string | null
}

interface StoredMultiAccountRegistry {
  version: typeof REGISTRY_VERSION
  clientId: string
  activeCharacterId: number | null
  characters: StoredCharacterAccount[]
  legacyMigration: EveLegacyMigrationState
  updatedAt: string
}

class MultiAccountRegistryStore {
  private readonly blobs: AtomicFileBlobStore

  constructor(filePath: string) {
    this.blobs = new AtomicFileBlobStore(filePath)
  }

  async load(): Promise<StoredMultiAccountRegistry | null> {
    let bytes: Uint8Array | null
    try {
      bytes = await this.blobs.read()
    } catch {
      throw new EveMultiAccountError(
        'registry_read_failed',
        'Could not read EVE character registry'
      )
    }
    if (bytes === null) return null
    if (bytes.byteLength > MAX_REGISTRY_BYTES) {
      throw new EveMultiAccountError('registry_read_failed', 'EVE character registry is too large')
    }

    try {
      return parseRegistry(JSON.parse(Buffer.from(bytes).toString('utf8')))
    } catch (error) {
      if (error instanceof EveMultiAccountError) throw error
      throw new EveMultiAccountError('registry_read_failed', 'EVE character registry is corrupted')
    }
  }

  async save(registry: StoredMultiAccountRegistry): Promise<void> {
    const normalized = parseRegistry(registry)
    const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8')
    if (bytes.byteLength > MAX_REGISTRY_BYTES) {
      throw new EveMultiAccountError('registry_write_failed', 'EVE character registry is too large')
    }
    try {
      await this.blobs.write(bytes)
    } catch {
      throw new EveMultiAccountError(
        'registry_write_failed',
        'Could not save EVE character registry'
      )
    }
  }
}

/**
 * Main-process-only multi-character SSO service.
 *
 * Each character owns an isolated encrypted or volatile refresh-token store. Access tokens and
 * decrypted refresh tokens live only inside this class/EveSsoClient and never enter a snapshot.
 */
export class EveMultiAccountService {
  readonly storagePaths: EveMultiAccountStoragePaths
  readonly maxCharacters: number

  private readonly registryStore: MultiAccountRegistryStore
  private readonly dataDirectory: string
  private readonly applicationClientId: string
  private readonly protector: SecretProtector
  private readonly credentialPersistence: 'encrypted' | 'memory'
  private readonly openExternal: EveSsoOptions['openExternal']
  private readonly clientFactory: EveSsoClientFactory
  private readonly now: () => number

  private registry: StoredMultiAccountRegistry | null = null
  private readonly clients = new Map<number, EveSsoClientAdapter>()
  private readonly memoryTokenStores = new Map<number, MemoryRefreshTokenStore>()
  private readonly credentialCharacterIds = new Set<number>()
  private readonly characterErrors = new Map<number, string>()
  private globalError: string | null = null
  private migrationError: string | null = null
  private loadPromise: Promise<void> | null = null
  private operationTail: Promise<void> = Promise.resolve()
  private activeConnectClient: EveSsoClientAdapter | null = null

  constructor(options: EveMultiAccountServiceOptions) {
    validateOptions(options)
    this.dataDirectory = validateDataDirectory(options.dataDirectory)
    this.storagePaths = getEveMultiAccountStoragePaths(options.dataDirectory)
    this.registryStore = new MultiAccountRegistryStore(this.storagePaths.registry)
    this.applicationClientId = validateClientId(options.clientId)
    this.protector = options.protector
    this.credentialPersistence = options.credentialPersistence ?? 'encrypted'
    this.openExternal = options.openExternal
    this.clientFactory = options.clientFactory ?? ((ssoOptions) => new EveSsoClient(ssoOptions))
    this.maxCharacters = normalizeLimit(options.maxCharacters)
    this.now = options.now ?? Date.now
  }

  /** Compatibility surface: public status of the active character only. */
  load(): Promise<EveAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      return this.snapshotLegacyStatus()
    })
  }

  /** Compatibility surface used by existing single-character callers. */
  getStatus(): Promise<EveAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      return this.snapshotLegacyStatus()
    })
  }

  /** Explicit SSO always adds/reconnects the character returned by CCP. */
  connect(): Promise<EveAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      await this.performConnectCharacter()
      return this.snapshotLegacyStatus()
    })
  }

  /** Out-of-band by design: a queued cancellation would sit behind the pending login. */
  async cancelConnect(): Promise<void> {
    await this.activeConnectClient?.cancelLogin?.()
  }

  /** Restores only the active character. Other character tokens stay encrypted until used. */
  restore(): Promise<EveAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      await this.attemptLegacyMigration()
      await this.performRestoreCharacter(this.requireRegistry().activeCharacterId)
      return this.snapshotLegacyStatus()
    })
  }

  /** Compatibility surface: disconnects only the active character. */
  disconnect(): Promise<EveAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      const characterId = this.requireRegistry().activeCharacterId
      if (characterId !== null) await this.performDisconnectCharacter(characterId)
      return this.snapshotLegacyStatus()
    })
  }

  /** Main-process capability. With no ID it follows the active character. */
  getAuthorizedSession(characterId?: number): Promise<EveAuthorizedSession | null> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      const expectedCharacterId = characterId === undefined
        ? this.requireRegistry().activeCharacterId
        : validateCharacterId(characterId)
      if (expectedCharacterId === null) return null
      return this.performGetAuthorizedSession(expectedCharacterId)
    })
  }

  /** Full token-free snapshot intended for future multi-character IPC. */
  getAccountsStatus(): Promise<EveMultiAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      return this.snapshotAccountsStatus()
    })
  }

  listCharacters(): Promise<EveCharacterAccountStatus[]> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      return this.snapshotAccountsStatus().characters
    })
  }

  connectCharacter(options: { industry?: boolean } = {}): Promise<EveMultiAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      await this.performConnectCharacter(options.industry === true)
      return this.snapshotAccountsStatus()
    })
  }

  restoreCharacter(characterId?: number): Promise<EveMultiAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      await this.attemptLegacyMigration()
      const expectedCharacterId = characterId === undefined
        ? this.requireRegistry().activeCharacterId
        : validateCharacterId(characterId)
      await this.performRestoreCharacter(expectedCharacterId)
      return this.snapshotAccountsStatus()
    })
  }

  selectActiveCharacter(characterId: number): Promise<EveMultiAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      const normalizedId = validateCharacterId(characterId)
      const registry = this.requireRegistry()
      if (!registry.characters.some((entry) => entry.characterId === normalizedId)) {
        throw new EveMultiAccountError('character_not_found', 'EVE character is not connected')
      }
      const timestamp = this.timestamp()
      await this.installRegistry({
        ...registry,
        activeCharacterId: normalizedId,
        characters: registry.characters.map((entry) => entry.characterId === normalizedId
          ? { ...entry, lastSelectedAt: timestamp }
          : cloneStoredCharacter(entry)),
        updatedAt: timestamp
      })
      return this.snapshotAccountsStatus()
    })
  }

  disconnectCharacter(characterId: number): Promise<EveMultiAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      await this.performDisconnectCharacter(validateCharacterId(characterId))
      return this.snapshotAccountsStatus()
    })
  }

  removeCharacter(characterId: number): Promise<EveMultiAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      const normalizedId = validateCharacterId(characterId)
      const registry = this.requireRegistry()
      if (!registry.characters.some((entry) => entry.characterId === normalizedId)) {
        throw new EveMultiAccountError('character_not_found', 'EVE character is not connected')
      }

      await this.clearCharacterCredential(normalizedId)
      const timestamp = this.timestamp()
      await this.installRegistry({
        ...registry,
        activeCharacterId: registry.activeCharacterId === normalizedId
          ? null
          : registry.activeCharacterId,
        characters: registry.characters.filter((entry) => entry.characterId !== normalizedId),
        updatedAt: timestamp
      })
      this.clients.delete(normalizedId)
      this.credentialCharacterIds.delete(normalizedId)
      this.characterErrors.delete(normalizedId)
      return this.snapshotAccountsStatus()
    })
  }

  /** Manual retry after a transient legacy refresh/migration failure. */
  retryLegacyMigration(): Promise<EveMultiAccountStatus> {
    return this.serialize(async () => {
      await this.ensureLoaded()
      const registry = this.requireRegistry()
      if (registry.legacyMigration === 'blocked') {
        await this.installRegistry({
          ...registry,
          legacyMigration: 'pending',
          updatedAt: this.timestamp()
        })
      }
      this.migrationError = null
      await this.attemptLegacyMigration()
      return this.snapshotAccountsStatus()
    })
  }

  private async performConnectCharacter(industry = false): Promise<void> {
    const stagedStore = new StagedRefreshTokenStore()
    const client = this.createClient(stagedStore)

    let session: EveSsoSession
    try {
      this.activeConnectClient = client
      session = industry ? await client.login({ industry: true }) : await client.login()
      assertSessionIdentity(session, session.characterId)
    } catch (error) {
      await client.clearLocalSession().catch(() => undefined)
      this.globalError = publicErrorMessage(error, 'Could not connect EVE character')
      throw normalizeOperationError(error, 'Could not connect EVE character')
    } finally {
      if (this.activeConnectClient === client) this.activeConnectClient = null
    }

    const registry = this.requireRegistry()
    const existing = registry.characters.find(
      (entry) => entry.characterId === session.characterId
    ) ?? null
    if (!existing && registry.characters.length >= this.maxCharacters) {
      await client.clearLocalSession().catch(() => undefined)
      const error = new EveMultiAccountError(
        'character_limit_reached',
        `Connected-character limit reached (${this.maxCharacters})`
      )
      this.globalError = error.message
      throw error
    }

    const tokenStore = this.tokenStore(session.characterId)
    try {
      // Persist the credential first. If the public registry write fails, startup recovery finds
      // the numeric token file; no freshly rotated refresh token is lost.
      await stagedStore.bind(tokenStore)
      if (this.credentialPersistence === 'encrypted') {
        this.credentialCharacterIds.add(session.characterId)
      }
      const timestamp = this.timestamp()
      const nextCharacter = fromSession(session, existing, timestamp, true)
      const nextRegistry: StoredMultiAccountRegistry = {
        ...registry,
        activeCharacterId: session.characterId,
        characters: registry.characters
          .filter((entry) => entry.characterId !== session.characterId)
          .concat(nextCharacter)
          .sort(compareStoredCharacters),
        updatedAt: timestamp
      }
      await this.installRegistry(nextRegistry)
      this.clients.set(session.characterId, client)
      this.characterErrors.delete(session.characterId)
      this.globalError = null
    } catch (error) {
      this.globalError = publicErrorMessage(error, 'Could not save EVE character')
      throw normalizeOperationError(error, 'Could not save EVE character')
    } finally {
      stagedStore.dispose()
    }
  }

  private async performRestoreCharacter(characterId: number | null): Promise<void> {
    if (characterId === null) return
    const normalizedId = validateCharacterId(characterId)
    const registry = this.requireRegistry()
    if (!registry.characters.some((entry) => entry.characterId === normalizedId)) {
      throw new EveMultiAccountError('character_not_found', 'EVE character is not connected')
    }

    const client = this.requireCharacterClient(normalizedId)
    try {
      const session = client.getSession() ?? await client.restoreSession()
      if (!session) {
        this.credentialCharacterIds.delete(normalizedId)
        this.characterErrors.delete(normalizedId)
        return
      }
      assertSessionIdentity(session, normalizedId)
      if (this.credentialPersistence === 'encrypted') {
        this.credentialCharacterIds.add(normalizedId)
      }
      await this.updateCharacterFromSession(session)
      this.characterErrors.delete(normalizedId)
      this.globalError = null
    } catch (error) {
      const normalized = normalizeOperationError(error, 'Could not restore EVE character')
      if (mustDiscardCharacterCredential(normalized)) {
        await client.clearLocalSession().catch(() => undefined)
        this.credentialCharacterIds.delete(normalizedId)
      }
      this.characterErrors.set(normalizedId, normalized.message)
      throw normalized
    }
  }

  private async performGetAuthorizedSession(
    characterId: number
  ): Promise<EveAuthorizedSession | null> {
    const registry = this.requireRegistry()
    if (!registry.characters.some((entry) => entry.characterId === characterId)) {
      throw new EveMultiAccountError('character_not_found', 'EVE character is not connected')
    }
    const client = this.requireCharacterClient(characterId)
    const hadSession = client.getSession() !== null

    try {
      const accessToken = await client.getAccessToken()
      const session = client.getSession()
      if (!accessToken || !session) {
        this.credentialCharacterIds.delete(characterId)
        this.characterErrors.delete(characterId)
        return null
      }
      assertSessionIdentity(session, characterId)
      if (this.credentialPersistence === 'encrypted') {
        this.credentialCharacterIds.add(characterId)
      }
      if (!hadSession || characterMetadataChanged(registry, session)) {
        await this.updateCharacterFromSession(session)
      }
      this.characterErrors.delete(characterId)
      this.globalError = null
      return { accessToken, session: cloneSession(session) }
    } catch (error) {
      const normalized = normalizeOperationError(error, 'Could not get EVE character session')
      if (mustDiscardCharacterCredential(normalized)) {
        await client.clearLocalSession().catch(() => undefined)
        this.credentialCharacterIds.delete(characterId)
      }
      this.characterErrors.set(characterId, normalized.message)
      throw normalized
    }
  }

  private async performDisconnectCharacter(characterId: number): Promise<void> {
    const registry = this.requireRegistry()
    if (!registry.characters.some((entry) => entry.characterId === characterId)) {
      throw new EveMultiAccountError('character_not_found', 'EVE character is not connected')
    }
    try {
      await this.clearCharacterCredential(characterId)
      const timestamp = this.timestamp()
      await this.installRegistry({
        ...registry,
        characters: registry.characters.map((entry) => entry.characterId === characterId
          ? { ...cloneStoredCharacter(entry), lastDisconnectedAt: timestamp }
          : cloneStoredCharacter(entry)),
        updatedAt: timestamp
      })
      this.credentialCharacterIds.delete(characterId)
      this.characterErrors.delete(characterId)
      this.globalError = null
    } catch (error) {
      const normalized = normalizeOperationError(error, 'Could not disconnect EVE character')
      this.characterErrors.set(characterId, normalized.message)
      throw normalized
    }
  }

  private async clearCharacterCredential(characterId: number): Promise<void> {
    const client = this.clients.get(characterId)
    if (client) await client.clearLocalSession()
    else await this.tokenStore(characterId).clear()
  }

  private async updateCharacterFromSession(session: EveSsoSession): Promise<void> {
    const registry = this.requireRegistry()
    const existing = registry.characters.find(
      (entry) => entry.characterId === session.characterId
    )
    if (!existing) {
      throw new EveMultiAccountError('character_not_found', 'EVE character is not connected')
    }
    const timestamp = this.timestamp()
    const updated = fromSession(session, existing, timestamp, false)
    await this.installRegistry({
      ...registry,
      characters: registry.characters.map((entry) => entry.characterId === session.characterId
        ? updated
        : cloneStoredCharacter(entry)),
      updatedAt: timestamp
    })
  }

  private async attemptLegacyMigration(): Promise<void> {
    const registry = this.requireRegistry()
    if (registry.legacyMigration !== 'pending') return
    if (this.credentialPersistence === 'memory') return

    const legacyPaths = getEveAccountStoragePaths(this.dataDirectory)
    const legacyBlobStore = new AtomicFileBlobStore(legacyPaths.refreshToken)
    let encryptedLegacyToken: Uint8Array | null
    try {
      encryptedLegacyToken = await legacyBlobStore.read()
    } catch (error) {
      this.migrationError = publicErrorMessage(error, 'Could not check legacy EVE account')
      return
    }
    if (encryptedLegacyToken === null) {
      await this.markLegacyMigration('complete')
      this.migrationError = null
      return
    }

    const legacyClientId = await readLegacyClientId(legacyPaths.config)
    if (legacyClientId !== this.applicationClientId) {
      this.migrationError = legacyClientId === null
        ? 'Legacy EVE configuration is corrupted; encrypted token was preserved unchanged'
        : 'Legacy token belongs to another OAuth client ID and was preserved unchanged'
      await this.markLegacyMigration('blocked')
      return
    }

    const legacyEncryptedStore = new EncryptedRefreshTokenStore(legacyBlobStore, this.protector)
    const stagedStore = new StagedRefreshTokenStore(legacyEncryptedStore)
    const client = this.createClient(stagedStore)

    try {
      const session = await client.restoreSession()
      if (!session) {
        this.migrationError = 'Legacy EVE account has no refresh token'
        return
      }
      assertSessionIdentity(session, session.characterId)

      const currentRegistry = this.requireRegistry()
      const existing = currentRegistry.characters.find(
        (entry) => entry.characterId === session.characterId
      ) ?? null
      if (!existing && currentRegistry.characters.length >= this.maxCharacters) {
        throw new EveMultiAccountError(
          'character_limit_reached',
          `Legacy account preserved, but character limit (${this.maxCharacters}) is reached`
        )
      }

      const tokenStore = this.tokenStore(session.characterId)
      await stagedStore.bind(tokenStore)
      this.credentialCharacterIds.add(session.characterId)

      const timestamp = this.timestamp()
      const nextRegistry: StoredMultiAccountRegistry = {
        ...currentRegistry,
        activeCharacterId: currentRegistry.activeCharacterId ?? session.characterId,
        characters: currentRegistry.characters
          .filter((entry) => entry.characterId !== session.characterId)
          .concat(fromSession(
            session,
            existing,
            timestamp,
            currentRegistry.activeCharacterId === null
          ))
          .sort(compareStoredCharacters),
        legacyMigration: 'complete',
        updatedAt: timestamp
      }
      await this.installRegistry(nextRegistry)
      this.clients.set(session.characterId, client)
      this.characterErrors.delete(session.characterId)

      // New encrypted credential and public registry are durable before old storage is removed.
      await legacyEncryptedStore.clear()
      this.migrationError = null
    } catch (error) {
      const normalized = normalizeOperationError(error, 'Could not migrate legacy EVE account')
      this.migrationError = normalized.message
      // A stale singleton must never block already-migrated multi-character accounts.
      // The encrypted source remains untouched and can be retried explicitly.
    } finally {
      stagedStore.dispose()
    }
  }

  private async markLegacyMigration(state: EveLegacyMigrationState): Promise<void> {
    const registry = this.requireRegistry()
    await this.installRegistry({
      ...registry,
      legacyMigration: state,
      updatedAt: this.timestamp()
    })
  }

  private ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.performLoad()
    return this.loadPromise
  }

  private async performLoad(): Promise<void> {
    const loaded = await this.registryStore.load()
    const oauthClientChanged = loaded !== null && loaded.clientId !== this.applicationClientId
    let registry = oauthClientChanged
      ? await this.migrateOAuthClientRegistry(loaded)
      : loaded ?? emptyRegistry(this.applicationClientId, this.timestamp())
    const recovered = await this.recoverTokenFiles(registry)
    registry = recovered.registry
    if (!loaded || recovered.changed) await this.registryStore.save(registry)
    this.registry = registry

    for (const entry of registry.characters) {
      if (!this.clients.has(entry.characterId)) {
        this.clients.set(entry.characterId, this.createPersistentClient(entry.characterId))
      }
    }
    this.globalError = oauthClientChanged ? OAUTH_CLIENT_CHANGED_MESSAGE : null
  }

  /**
   * Refresh tokens are bound to the OAuth client that issued them. Keep the old registry and
   * encrypted credentials together in a private backup, then carry only public character
   * metadata into a clean registry for the embedded client. This lets startup continue while
   * making every preserved character explicitly reconnect through SSO.
   */
  private async migrateOAuthClientRegistry(
    loaded: StoredMultiAccountRegistry
  ): Promise<StoredMultiAccountRegistry> {
    const timestamp = this.timestamp()
    const suffix = `${Date.parse(timestamp)}-${randomUUID()}`
    const backupDirectory = `${this.storagePaths.directory}.oauth-backup-${suffix}`
    const stagedDirectory = `${this.storagePaths.directory}.oauth-staged-${suffix}`
    const migrated: StoredMultiAccountRegistry = {
      ...loaded,
      clientId: this.applicationClientId,
      characters: loaded.characters.map((entry) => ({
        ...cloneStoredCharacter(entry),
        lastDisconnectedAt: timestamp
      })),
      updatedAt: timestamp
    }

    const stagedStore = new MultiAccountRegistryStore(
      join(stagedDirectory, EVE_MULTI_ACCOUNT_REGISTRY_FILENAME)
    )
    await stagedStore.save(migrated)

    try {
      await rename(this.storagePaths.directory, backupDirectory)
    } catch {
      throw new EveMultiAccountError(
        'registry_write_failed',
        'Could not save protected backup of legacy EVE accounts'
      )
    }

    try {
      await rename(stagedDirectory, this.storagePaths.directory)
    } catch {
      try {
        await rename(backupDirectory, this.storagePaths.directory)
      } catch {
        throw new EveMultiAccountError(
          'registry_write_failed',
          'Could not finish EVE SSO change; protected account backup was saved'
        )
      }
      throw new EveMultiAccountError(
        'registry_write_failed',
        'Could not apply new EVE SSO configuration'
      )
    }

    return migrated
  }

  private async recoverTokenFiles(registry: StoredMultiAccountRegistry): Promise<{
    registry: StoredMultiAccountRegistry
    changed: boolean
  }> {
    if (this.credentialPersistence === 'memory') {
      return { registry, changed: false }
    }
    let filenames: string[]
    try {
      filenames = await readdir(this.storagePaths.tokensDirectory)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') filenames = []
      else throw new EveMultiAccountError('registry_read_failed', 'Could not verify EVE tokens')
    }

    const knownIds = new Set(registry.characters.map((entry) => entry.characterId))
    const characters = registry.characters.map(cloneStoredCharacter)
    let changed = false
    for (const filename of filenames.sort()) {
      const match = TOKEN_FILENAME_PATTERN.exec(filename)
      if (!match) continue
      const characterId = Number(match[1])
      if (!Number.isSafeInteger(characterId) || characterId <= 0) continue

      try {
        const encrypted = await new AtomicFileBlobStore(
          join(this.storagePaths.tokensDirectory, filename)
        ).read()
        if (encrypted === null) continue
        this.credentialCharacterIds.add(characterId)
      } catch (error) {
        this.characterErrors.set(
          characterId,
          publicErrorMessage(error, 'Could not read EVE character token')
        )
        continue
      }

      if (knownIds.has(characterId)) continue
      if (characters.length >= MAX_EVE_MULTI_ACCOUNT_LIMIT) continue
      const timestamp = this.timestamp()
      characters.push({
        characterId,
        characterName: `Character ${characterId}`,
        scopes: [],
        addedAt: timestamp,
        lastAuthenticatedAt: timestamp,
        lastSelectedAt: null,
        lastDisconnectedAt: null
      })
      knownIds.add(characterId)
      changed = true
    }

    if (!changed) return { registry, changed: false }
    const timestamp = this.timestamp()
    return {
      changed: true,
      registry: {
        ...registry,
        activeCharacterId: registry.activeCharacterId ?? characters[0]?.characterId ?? null,
        characters: characters.sort(compareStoredCharacters),
        updatedAt: timestamp
      }
    }
  }

  private async installRegistry(registry: StoredMultiAccountRegistry): Promise<void> {
    await this.registryStore.save(registry)
    this.registry = parseRegistry(registry)
  }

  private createPersistentClient(characterId: number): EveSsoClientAdapter {
    return this.createClient(this.tokenStore(characterId))
  }

  private createClient(refreshTokenStore: SecureRefreshTokenStore): EveSsoClientAdapter {
    return this.clientFactory({
      clientId: this.applicationClientId,
      openExternal: this.openExternal,
      refreshTokenStore
    })
  }

  private requireCharacterClient(characterId: number): EveSsoClientAdapter {
    const existing = this.clients.get(characterId)
    if (existing) return existing
    const client = this.createPersistentClient(characterId)
    this.clients.set(characterId, client)
    return client
  }

  private tokenStore(characterId: number): SecureRefreshTokenStore {
    if (this.credentialPersistence === 'memory') {
      const existing = this.memoryTokenStores.get(characterId)
      if (existing) return existing
      const created = new MemoryRefreshTokenStore()
      this.memoryTokenStores.set(characterId, created)
      return created
    }
    return new EncryptedRefreshTokenStore(
      new AtomicFileBlobStore(getEveMultiAccountRefreshTokenPath(
        this.dataDirectory,
        characterId
      )),
      this.protector
    )
  }

  private requireRegistry(): StoredMultiAccountRegistry {
    if (!this.registry) {
      throw new EveMultiAccountError('operation_failed', 'EVE character registry is not loaded')
    }
    return this.registry
  }

  private snapshotLegacyStatus(): EveAccountStatus {
    const registry = this.requireRegistry()
    const characterId = registry.activeCharacterId
    const client = characterId === null ? null : this.clients.get(characterId) ?? null
    const session = client?.getSession() ?? null
    return {
      configured: true,
      connected: session !== null,
      clientId: this.applicationClientId,
      callbackUri: EVE_SSO_REDIRECT_URI,
      characterId: session?.characterId ?? null,
      characterName: session?.characterName ?? null,
      scopes: session ? [...session.scopes] : [],
      error: characterId === null
        ? this.globalError ?? this.migrationError
        : this.characterErrors.get(characterId) ?? this.globalError ?? this.migrationError,
      sessionOnly: this.credentialPersistence === 'memory'
    }
  }

  private snapshotAccountsStatus(): EveMultiAccountStatus {
    const registry = this.requireRegistry()
    return {
      configured: true,
      clientId: this.applicationClientId,
      callbackUri: FLY_SAFE_EVE_CALLBACK_URI,
      activeCharacterId: registry.activeCharacterId,
      maxCharacters: this.maxCharacters,
      characters: registry.characters.map((entry) => {
        const session = this.clients.get(entry.characterId)?.getSession() ?? null
        const credentialStored = this.credentialCharacterIds.has(entry.characterId)
        const error = this.characterErrors.get(entry.characterId) ?? null
        const state: EveMultiAccountState = accountState(session, credentialStored, error)
        return {
          characterId: entry.characterId,
          characterName: session?.characterName ?? entry.characterName,
          scopes: session ? [...session.scopes] : [...entry.scopes],
          state,
          connected: session !== null,
          credentialStored,
          sessionExpiresAt: session?.expiresAt ?? null,
          addedAt: entry.addedAt,
          lastAuthenticatedAt: entry.lastAuthenticatedAt,
          lastSelectedAt: entry.lastSelectedAt,
          lastDisconnectedAt: entry.lastDisconnectedAt,
          error
        }
      }),
      legacyMigration: registry.legacyMigration,
      error: this.globalError ?? this.migrationError,
      sessionOnly: this.credentialPersistence === 'memory'
    }
  }

  private timestamp(): string {
    const value = this.now()
    if (!Number.isFinite(value)) {
      throw new EveMultiAccountError('invalid_config', 'Invalid EVE service clock')
    }
    return new Date(value).toISOString()
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

/** Volatile token storage for builds that must never invoke the OS credential prompt. */
class MemoryRefreshTokenStore implements SecureRefreshTokenStore {
  private value: string | null = null

  async load(): Promise<string | null> {
    return this.value
  }

  async save(refreshToken: string): Promise<void> {
    assertStagedRefreshToken(refreshToken)
    this.value = refreshToken
  }

  async clear(): Promise<void> {
    this.value = null
  }
}

/** Holds a refresh token only in main-process memory until the verified character ID is known. */
class StagedRefreshTokenStore implements SecureRefreshTokenStore {
  private staged: string | null = null
  private destination: SecureRefreshTokenStore | null = null

  constructor(private readonly source: SecureRefreshTokenStore | null = null) {}

  async load(): Promise<string | null> {
    if (this.destination) return this.destination.load()
    if (this.staged !== null) return this.staged
    if (!this.source) return null
    this.staged = await this.source.load()
    return this.staged
  }

  async save(refreshToken: string): Promise<void> {
    assertStagedRefreshToken(refreshToken)
    if (this.destination) {
      await this.destination.save(refreshToken)
      return
    }
    this.staged = refreshToken
  }

  async clear(): Promise<void> {
    if (this.destination) await this.destination.clear()
    this.staged = null
    // Source is intentionally preserved until migration is fully durable.
  }

  async bind(destination: SecureRefreshTokenStore): Promise<void> {
    if (this.destination) throw new EveMultiAccountError('operation_failed', 'Token is already attached')
    const token = this.staged ?? await this.source?.load() ?? null
    if (token === null) {
      throw new EveMultiAccountError('operation_failed', 'EVE SSO did not return a refresh token')
    }
    await destination.save(token)
    this.destination = destination
    this.staged = null
  }

  dispose(): void {
    this.staged = null
  }
}

export function getEveMultiAccountStoragePaths(dataDirectory: string): EveMultiAccountStoragePaths {
  const baseDirectory = validateDataDirectory(dataDirectory)
  const directory = join(baseDirectory, MULTI_ACCOUNT_DIRECTORY_NAME)
  return {
    directory,
    registry: join(directory, EVE_MULTI_ACCOUNT_REGISTRY_FILENAME),
    tokensDirectory: join(directory, EVE_MULTI_ACCOUNT_TOKEN_DIRECTORY_NAME)
  }
}

export function getEveMultiAccountRefreshTokenPath(
  dataDirectory: string,
  characterId: number
): string {
  const paths = getEveMultiAccountStoragePaths(dataDirectory)
  return join(paths.tokensDirectory, `${validateCharacterId(characterId)}.bin`)
}

function validateOptions(options: EveMultiAccountServiceOptions): void {
  if (!options || typeof options !== 'object') {
    throw new EveMultiAccountError('invalid_config', 'Multi-account settings are required')
  }
  validateDataDirectory(options.dataDirectory)
  validateClientId(options.clientId)
  normalizeLimit(options.maxCharacters)
  if (
    options.credentialPersistence !== undefined &&
    options.credentialPersistence !== 'encrypted' &&
    options.credentialPersistence !== 'memory'
  ) {
    throw new EveMultiAccountError('invalid_config', 'Invalid EVE SSO storage mode')
  }
  if (typeof options.openExternal !== 'function') {
    throw new EveMultiAccountError('invalid_config', 'EVE SSO system browser is not set')
  }
  if (
    !options.protector ||
    typeof options.protector.isEncryptionAvailable !== 'function' ||
    typeof options.protector.encryptString !== 'function' ||
    typeof options.protector.decryptString !== 'function'
  ) {
    throw new EveMultiAccountError('invalid_config', 'EVE SSO system encryption is not set')
  }
  if (options.clientFactory !== undefined && typeof options.clientFactory !== 'function') {
    throw new EveMultiAccountError('invalid_config', 'Invalid EVE SSO factory')
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new EveMultiAccountError('invalid_config', 'Invalid EVE service clock')
  }
}

function validateDataDirectory(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EveMultiAccountError('invalid_config', 'Multi-account directory is not set')
  }
  return resolve(value)
}

function validateClientId(value: unknown): string {
  if (typeof value !== 'string' || !CLIENT_ID_PATTERN.test(value)) {
    throw new EveMultiAccountError('invalid_config', 'Invalid EVE SSO client ID')
  }
  return value
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_EVE_MULTI_ACCOUNT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVE_MULTI_ACCOUNT_LIMIT) {
    throw new EveMultiAccountError(
      'invalid_config',
      `Character limit must be from 1 to ${MAX_EVE_MULTI_ACCOUNT_LIMIT}`
    )
  }
  return limit
}

function validateCharacterId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new EveMultiAccountError('invalid_config', 'Invalid EVE character ID')
  }
  return value as number
}

function emptyRegistry(clientId: string, timestamp: string): StoredMultiAccountRegistry {
  return {
    version: REGISTRY_VERSION,
    clientId,
    activeCharacterId: null,
    characters: [],
    legacyMigration: 'pending',
    updatedAt: timestamp
  }
}

function parseRegistry(value: unknown): StoredMultiAccountRegistry {
  if (!isRecord(value) || value.version !== REGISTRY_VERSION) {
    throw new EveMultiAccountError('registry_read_failed', 'EVE registry version is unsupported')
  }
  const clientId = validateClientId(value.clientId)
  const activeCharacterId = value.activeCharacterId === null
    ? null
    : validateCharacterId(value.activeCharacterId)
  if (!Array.isArray(value.characters) || value.characters.length > MAX_EVE_MULTI_ACCOUNT_LIMIT) {
    throw new EveMultiAccountError('registry_read_failed', 'Invalid EVE character list')
  }
  const characters = value.characters.map(parseStoredCharacter).sort(compareStoredCharacters)
  if (new Set(characters.map((entry) => entry.characterId)).size !== characters.length) {
    throw new EveMultiAccountError('registry_read_failed', 'EVE registry contains duplicates')
  }
  if (
    activeCharacterId !== null &&
    !characters.some((entry) => entry.characterId === activeCharacterId)
  ) {
    throw new EveMultiAccountError('registry_read_failed', 'Active character is missing from registry')
  }
  if (!['pending', 'complete', 'blocked'].includes(String(value.legacyMigration))) {
    throw new EveMultiAccountError('registry_read_failed', 'Invalid EVE migration status')
  }
  return {
    version: REGISTRY_VERSION,
    clientId,
    activeCharacterId,
    characters,
    legacyMigration: value.legacyMigration as EveLegacyMigrationState,
    updatedAt: normalizeTimestamp(value.updatedAt)
  }
}

function parseStoredCharacter(value: unknown): StoredCharacterAccount {
  if (!isRecord(value)) {
    throw new EveMultiAccountError('registry_read_failed', 'Invalid character in registry')
  }
  if (!Array.isArray(value.scopes)) {
    throw new EveMultiAccountError('registry_read_failed', 'Invalid EVE character scopes')
  }
  const scopes = normalizeScopes(value.scopes)
  return {
    characterId: validateCharacterId(value.characterId),
    characterName: normalizeCharacterName(value.characterName),
    scopes,
    addedAt: normalizeTimestamp(value.addedAt),
    lastAuthenticatedAt: normalizeTimestamp(value.lastAuthenticatedAt),
    lastSelectedAt: value.lastSelectedAt === null ? null : normalizeTimestamp(value.lastSelectedAt),
    lastDisconnectedAt: value.lastDisconnectedAt === null
      ? null
      : normalizeTimestamp(value.lastDisconnectedAt)
  }
}

function normalizeScopes(value: readonly unknown[]): EveSsoScope[] {
  if (!value.every((scope) => typeof scope === 'string')) {
    throw new EveMultiAccountError('registry_read_failed', 'Invalid EVE character scopes')
  }
  const requested = new Set(value as string[])
  if ([...requested].some((scope) => !EVE_SSO_SUPPORTED_SCOPES.includes(scope as EveSsoScope))) {
    throw new EveMultiAccountError('registry_read_failed', 'Registry contains an unknown EVE scope')
  }
  return EVE_SSO_SUPPORTED_SCOPES.filter((scope) => requested.has(scope))
}

function normalizeCharacterName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new EveMultiAccountError('registry_read_failed', 'Invalid EVE character name')
  }
  return value
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string') {
    throw new EveMultiAccountError('registry_read_failed', 'Invalid date in EVE registry')
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw new EveMultiAccountError('registry_read_failed', 'Invalid date in EVE registry')
  }
  return new Date(timestamp).toISOString()
}

function fromSession(
  session: EveSsoSession,
  existing: StoredCharacterAccount | null,
  timestamp: string,
  selected: boolean
): StoredCharacterAccount {
  return {
    characterId: validateCharacterId(session.characterId),
    characterName: normalizeCharacterName(session.characterName),
    scopes: normalizeScopes(session.scopes),
    addedAt: existing?.addedAt ?? timestamp,
    lastAuthenticatedAt: timestamp,
    lastSelectedAt: selected ? timestamp : existing?.lastSelectedAt ?? null,
    lastDisconnectedAt: existing?.lastDisconnectedAt ?? null
  }
}

function assertSessionIdentity(session: EveSsoSession, expectedCharacterId: number): void {
  if (session.characterId !== expectedCharacterId) {
    throw new EveMultiAccountError(
      'character_mismatch',
      'EVE token belongs to a different character'
    )
  }
}

function characterMetadataChanged(
  registry: StoredMultiAccountRegistry,
  session: EveSsoSession
): boolean {
  const stored = registry.characters.find((entry) => entry.characterId === session.characterId)
  return !stored ||
    stored.characterName !== session.characterName ||
    stored.scopes.join('\n') !== session.scopes.join('\n')
}

function accountState(
  session: EveSsoSession | null,
  credentialStored: boolean,
  error: string | null
): EveMultiAccountState {
  if (session) return 'connected'
  if (error) return 'error'
  if (credentialStored) return 'stored'
  return 'disconnected'
}

function compareStoredCharacters(
  left: StoredCharacterAccount,
  right: StoredCharacterAccount
): number {
  return left.characterId - right.characterId
}

function cloneStoredCharacter(entry: StoredCharacterAccount): StoredCharacterAccount {
  return { ...entry, scopes: [...entry.scopes] }
}

function cloneSession(session: EveSsoSession): EveSsoSession {
  return { ...session, scopes: [...session.scopes] }
}

async function readLegacyClientId(configPath: string): Promise<string | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(configPath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    return null
  }
  if (bytes.byteLength > 8 * 1_024) return null
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.clientId !== 'string' ||
      !CLIENT_ID_PATTERN.test(parsed.clientId)
    ) {
      return null
    }
    return parsed.clientId
  } catch {
    return null
  }
}

function normalizeOperationError(error: unknown, fallback: string): Error {
  if (
    error instanceof EveSsoError ||
    error instanceof EveAccountError ||
    error instanceof EveMultiAccountError
  ) {
    return error
  }
  return new EveMultiAccountError('operation_failed', fallback)
}

function publicErrorMessage(error: unknown, fallback: string): string {
  return normalizeOperationError(error, fallback).message
}

function mustDiscardCharacterCredential(error: Error): boolean {
  return (
    error instanceof EveMultiAccountError && error.code === 'character_mismatch'
  ) || (
    error instanceof EveSsoError && [400, 401].includes(error.status ?? 0)
  )
}

function assertStagedRefreshToken(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 16_384 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new EveSsoError('invalid_token', 'Invalid EVE SSO refresh token')
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Compile-time guard: the shared callback constant must stay identical to EveSsoClient's listener.
const _callbackCompatibility: typeof EVE_SSO_REDIRECT_URI = FLY_SAFE_EVE_CALLBACK_URI
void _callbackCompatibility
