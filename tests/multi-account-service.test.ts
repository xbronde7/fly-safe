import { expectPrivatePathMode } from './file-permissions'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AtomicFileBlobStore,
  EveAccountService,
  getEveAccountStoragePaths,
  type EveSsoClientAdapter,
  type EveSsoClientFactory
} from '../src/main/account-service'
import {
  EveMultiAccountService,
  getEveMultiAccountRefreshTokenPath,
  getEveMultiAccountStoragePaths
} from '../src/main/multi-account-service'
import {
  EVE_SSO_SCOPES,
  EncryptedRefreshTokenStore,
  EveSsoError,
  type EveSsoOptions,
  type EveSsoSession,
  type SecretProtector
} from '../src/main/eve-sso'

const NOW = Date.parse('2026-08-25T10:00:00.000Z')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

class TestProtector implements SecretProtector {
  constructor(private readonly available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available
  }

  encryptString(plaintext: string): Uint8Array {
    if (!this.available) throw new Error('unavailable')
    return Uint8Array.from([
      0x9a,
      0xc4,
      ...Buffer.from(plaintext, 'utf8').map((byte) => byte ^ 0x6d)
    ])
  }

  decryptString(ciphertext: Uint8Array): string {
    if (!this.available) throw new Error('unavailable')
    if (ciphertext[0] !== 0x9a || ciphertext[1] !== 0xc4) throw new Error('invalid ciphertext')
    return Buffer.from(Uint8Array.from(ciphertext.slice(2), (byte) => byte ^ 0x6d)).toString('utf8')
  }
}

interface FakeIdentity {
  characterId: number
  characterName: string
}

class CharacterAwareFakeClient implements EveSsoClientAdapter {
  private session: EveSsoSession | null = null

  constructor(
    readonly options: EveSsoOptions,
    private readonly nextLoginIdentity: () => Promise<FakeIdentity>
  ) {}

  async login(): Promise<EveSsoSession> {
    const identity = await this.nextLoginIdentity()
    await this.options.openExternal('https://login.eveonline.com/v2/oauth/authorize')
    await this.options.refreshTokenStore.save(refreshToken(this.options.clientId, identity))
    this.session = makeSession(identity)
    return cloneSession(this.session)
  }

  async restoreSession(): Promise<EveSsoSession | null> {
    const stored = await this.options.refreshTokenStore.load()
    if (stored === null) {
      this.session = null
      return null
    }
    const identity = parseRefreshToken(stored, this.options.clientId)
    // Simulates CCP refresh-token rotation. Migration must durably keep this newer credential.
    await this.options.refreshTokenStore.save(`${refreshToken(this.options.clientId, identity)}|rotated`)
    this.session = makeSession(identity)
    return cloneSession(this.session)
  }

  async getAccessToken(): Promise<string | null> {
    if (!this.session) await this.restoreSession()
    return this.session ? `access|${this.session.characterId}` : null
  }

  getSession(): EveSsoSession | null {
    return this.session ? cloneSession(this.session) : null
  }

  async clearLocalSession(): Promise<void> {
    this.session = null
    await this.options.refreshTokenStore.clear()
  }
}

function fakeHarness(initialIdentities: FakeIdentity[] = []): {
  factory: EveSsoClientFactory
  enqueue(identity: FakeIdentity): void
  loginEvents: string[]
} {
  const identities = [...initialIdentities]
  const loginEvents: string[] = []
  return {
    loginEvents,
    enqueue(identity) {
      identities.push(identity)
    },
    factory(options) {
      return new CharacterAwareFakeClient(options, async () => {
        const identity = identities.shift()
        if (!identity) throw new Error('No fake SSO identity queued')
        loginEvents.push(`login:${identity.characterId}`)
        return identity
      })
    }
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'eve-multi-account-'))
  temporaryDirectories.push(directory)
  return directory
}

function createService(options: {
  dataDirectory: string
  clientId?: string
  protector?: SecretProtector
  factory: EveSsoClientFactory
  maxCharacters?: number
  openExternal?: EveSsoOptions['openExternal']
  credentialPersistence?: 'encrypted' | 'memory'
}): EveMultiAccountService {
  return new EveMultiAccountService({
    dataDirectory: options.dataDirectory,
    clientId: options.clientId ?? 'fly-safe-client',
    protector: options.protector ?? new TestProtector(),
    credentialPersistence: options.credentialPersistence,
    openExternal: options.openExternal ?? (async () => undefined),
    clientFactory: options.factory,
    maxCharacters: options.maxCharacters,
    now: () => NOW
  })
}

describe('EveMultiAccountService', () => {
  it('keeps macOS session-only credentials in memory without touching secure storage', async () => {
    const dataDirectory = await temporaryDirectory()
    const service = createService({
      dataDirectory,
      protector: new TestProtector(false),
      credentialPersistence: 'memory',
      factory: fakeHarness([{ characterId: 88, characterName: 'Volatile Pilot' }]).factory
    })

    const connected = await service.connectCharacter()
    expect(connected).toMatchObject({
      activeCharacterId: 88,
      sessionOnly: true,
      characters: [{
        characterId: 88,
        connected: true,
        credentialStored: false,
        state: 'connected'
      }]
    })
    expect(await service.getAuthorizedSession()).toMatchObject({
      accessToken: 'access|88',
      session: { characterId: 88 }
    })
    await expect(stat(getEveMultiAccountRefreshTokenPath(dataDirectory, 88)))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const restarted = createService({
      dataDirectory,
      protector: new TestProtector(false),
      credentialPersistence: 'memory',
      factory: fakeHarness().factory
    })
    await expect(restarted.restore()).resolves.toMatchObject({
      connected: false,
      characterId: null,
      sessionOnly: true
    })
    expect(await restarted.getAccountsStatus()).toMatchObject({
      sessionOnly: true,
      characters: [{ characterId: 88, connected: false, credentialStored: false }]
    })
  })

  it('keeps one encrypted refresh token per character and switches the active capability', async () => {
    const dataDirectory = await temporaryDirectory()
    const harness = fakeHarness([
      { characterId: 101, characterName: 'Alpha Pilot' },
      { characterId: 202, characterName: 'Beta Pilot' }
    ])
    const openExternal = vi.fn(async () => undefined)
    const service = createService({ dataDirectory, factory: harness.factory, openExternal })

    await service.connectCharacter()
    const connected = await service.connectCharacter()

    expect(openExternal).toHaveBeenCalledTimes(2)
    expect(connected.activeCharacterId).toBe(202)
    expect(connected.characters).toMatchObject([
      {
        characterId: 101,
        characterName: 'Alpha Pilot',
        connected: true,
        credentialStored: true,
        state: 'connected'
      },
      {
        characterId: 202,
        characterName: 'Beta Pilot',
        connected: true,
        credentialStored: true,
        state: 'connected'
      }
    ])

    const firstPath = getEveMultiAccountRefreshTokenPath(dataDirectory, 101)
    const secondPath = getEveMultiAccountRefreshTokenPath(dataDirectory, 202)
    const [firstEncrypted, secondEncrypted] = await Promise.all([
      readFile(firstPath),
      readFile(secondPath)
    ])
    expect(firstEncrypted.equals(secondEncrypted)).toBe(false)
    expect(firstEncrypted.toString('utf8')).not.toContain('refresh|')
    expect(secondEncrypted.toString('utf8')).not.toContain('refresh|')
    await expectPrivatePathMode(firstPath, 0o600)
    await expectPrivatePathMode(getEveMultiAccountStoragePaths(dataDirectory).tokensDirectory, 0o700)

    const registryText = await readFile(
      getEveMultiAccountStoragePaths(dataDirectory).registry,
      'utf8'
    )
    expect(registryText).not.toContain('refresh|')
    expect(registryText).not.toContain('access|')
    expect(JSON.stringify(connected)).not.toMatch(/refreshToken|accessToken|secureCredential/i)

    expect(await service.getAuthorizedSession()).toMatchObject({
      accessToken: 'access|202',
      session: { characterId: 202 }
    })
    await service.selectActiveCharacter(101)
    expect(await service.getAuthorizedSession()).toMatchObject({
      accessToken: 'access|101',
      session: { characterId: 101 }
    })
    // Explicit character capability does not silently follow the active selection.
    expect(await service.getAuthorizedSession(202)).toMatchObject({
      accessToken: 'access|202',
      session: { characterId: 202 }
    })

    const restarted = createService({
      dataDirectory,
      factory: fakeHarness().factory
    })
    expect(await restarted.getAccountsStatus()).toMatchObject({
      activeCharacterId: 101,
      characters: [
        { characterId: 101, connected: false, credentialStored: true, state: 'stored' },
        { characterId: 202, connected: false, credentialStored: true, state: 'stored' }
      ]
    })
    await restarted.restoreCharacter(101)
    expect((await restarted.getAccountsStatus()).characters).toMatchObject([
      { characterId: 101, connected: true },
      { characterId: 202, connected: false }
    ])
  })

  it('backs up old-client credentials and requires every preserved character to sign in again', async () => {
    const dataDirectory = await temporaryDirectory()
    const protector = new TestProtector()
    const oldService = createService({
      dataDirectory,
      clientId: 'old-fly-safe-client',
      protector,
      factory: fakeHarness([
        { characterId: 101, characterName: 'Alpha Pilot' },
        { characterId: 202, characterName: 'Beta Pilot' }
      ]).factory
    })
    await oldService.connectCharacter()
    await oldService.connectCharacter()

    const oldPaths = getEveMultiAccountStoragePaths(dataDirectory)
    const oldFirstToken = await readFile(getEveMultiAccountRefreshTokenPath(dataDirectory, 101))
    const oldSecondToken = await readFile(getEveMultiAccountRefreshTokenPath(dataDirectory, 202))
    const reconnectHarness = fakeHarness([{ characterId: 202, characterName: 'Beta Pilot' }])
    const replacement = createService({
      dataDirectory,
      clientId: 'new-fly-safe-client',
      protector,
      factory: reconnectHarness.factory
    })

    await expect(replacement.restore()).resolves.toMatchObject({
      configured: true,
      connected: false,
      clientId: 'new-fly-safe-client',
      characterId: null,
      error: 'EVE SSO application changed. Sign in again with each character.'
    })
    expect(await replacement.getAccountsStatus()).toMatchObject({
      activeCharacterId: 202,
      clientId: 'new-fly-safe-client',
      legacyMigration: 'complete',
      characters: [
        {
          characterId: 101,
          characterName: 'Alpha Pilot',
          state: 'disconnected',
          connected: false,
          credentialStored: false,
          lastDisconnectedAt: new Date(NOW).toISOString()
        },
        {
          characterId: 202,
          characterName: 'Beta Pilot',
          state: 'disconnected',
          connected: false,
          credentialStored: false,
          lastDisconnectedAt: new Date(NOW).toISOString()
        }
      ],
      error: 'EVE SSO application changed. Sign in again with each character.'
    })

    const currentRegistry = JSON.parse(await readFile(oldPaths.registry, 'utf8'))
    expect(currentRegistry).toMatchObject({
      clientId: 'new-fly-safe-client',
      activeCharacterId: 202,
      legacyMigration: 'complete'
    })
    await expect(stat(getEveMultiAccountRefreshTokenPath(dataDirectory, 101)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(getEveMultiAccountRefreshTokenPath(dataDirectory, 202)))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const backupName = (await readdir(dataDirectory)).find((name) =>
      name.startsWith('eve-accounts.oauth-backup-')
    )
    expect(backupName).toBeDefined()
    const backupDirectory = join(dataDirectory, backupName!)
    await expectPrivatePathMode(backupDirectory, 0o700)
    expect(JSON.parse(await readFile(join(backupDirectory, 'registry.json'), 'utf8')))
      .toMatchObject({ clientId: 'old-fly-safe-client', activeCharacterId: 202 })
    await expectPrivatePathMode(join(backupDirectory, 'registry.json'), 0o600)
    await expectPrivatePathMode(join(backupDirectory, 'tokens', '101.bin'), 0o600)
    expect((await readFile(join(backupDirectory, 'tokens', '101.bin'))).equals(oldFirstToken))
      .toBe(true)
    expect((await readFile(join(backupDirectory, 'tokens', '202.bin'))).equals(oldSecondToken))
      .toBe(true)

    const reconnected = await replacement.connectCharacter()
    expect(reconnected).toMatchObject({
      activeCharacterId: 202,
      characters: [
        { characterId: 101, connected: false, credentialStored: false },
        { characterId: 202, connected: true, credentialStored: true }
      ],
      error: null
    })
    expect((await stat(getEveMultiAccountRefreshTokenPath(dataDirectory, 202))).isFile()).toBe(true)
    expect((await readFile(join(backupDirectory, 'tokens', '202.bin'))).equals(oldSecondToken))
      .toBe(true)
  })

  it('disconnects and removes exactly one character without touching other credentials', async () => {
    const dataDirectory = await temporaryDirectory()
    const harness = fakeHarness([
      { characterId: 11, characterName: 'One' },
      { characterId: 22, characterName: 'Two' }
    ])
    const service = createService({ dataDirectory, factory: harness.factory })
    await service.connectCharacter()
    await service.connectCharacter()
    await service.selectActiveCharacter(11)

    const disconnected = await service.disconnectCharacter(11)
    expect(disconnected.activeCharacterId).toBe(11)
    expect(disconnected.characters).toMatchObject([
      { characterId: 11, state: 'disconnected', credentialStored: false },
      { characterId: 22, state: 'connected', credentialStored: true }
    ])
    await expect(stat(getEveMultiAccountRefreshTokenPath(dataDirectory, 11)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(getEveMultiAccountRefreshTokenPath(dataDirectory, 22))).isFile()).toBe(true)
    expect(await service.getAuthorizedSession(22)).toMatchObject({
      session: { characterId: 22 }
    })

    const removed = await service.removeCharacter(11)
    expect(removed.activeCharacterId).toBeNull()
    expect(removed.characters.map(({ characterId }) => characterId)).toEqual([22])
    expect((await stat(getEveMultiAccountRefreshTokenPath(dataDirectory, 22))).isFile()).toBe(true)
  })

  it('migrates the singleton token after refresh rotation without exposing or losing it', async () => {
    const dataDirectory = await temporaryDirectory()
    const protector = new TestProtector()
    const oldHarness = fakeHarness([{ characterId: 303, characterName: 'Legacy Pilot' }])
    const oldService = new EveAccountService({
      dataDirectory,
      clientId: 'fly-safe-client',
      protector,
      openExternal: async () => undefined,
      clientFactory: oldHarness.factory
    })
    await oldService.connect()
    const legacyPath = getEveAccountStoragePaths(dataDirectory).refreshToken
    expect((await stat(legacyPath)).isFile()).toBe(true)

    const service = createService({
      dataDirectory,
      protector,
      factory: fakeHarness().factory
    })
    const restored = await service.restore()

    expect(restored).toMatchObject({
      connected: true,
      characterId: 303,
      characterName: 'Legacy Pilot'
    })
    expect(await service.getAccountsStatus()).toMatchObject({
      activeCharacterId: 303,
      legacyMigration: 'complete',
      characters: [{ characterId: 303, credentialStored: true }]
    })
    await expect(stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const newEncrypted = await readFile(getEveMultiAccountRefreshTokenPath(dataDirectory, 303))
    expect(newEncrypted.toString('utf8')).not.toContain('refresh|')
    expect(protector.decryptString(newEncrypted)).toContain('|rotated')

    const restarted = createService({
      dataDirectory,
      protector,
      factory: fakeHarness().factory
    })
    expect(await restarted.restore()).toMatchObject({ connected: true, characterId: 303 })
  })

  it('preserves the singleton encrypted token when migration cannot reach SSO', async () => {
    const dataDirectory = await temporaryDirectory()
    const protector = new TestProtector()
    const oldService = new EveAccountService({
      dataDirectory,
      clientId: 'fly-safe-client',
      protector,
      openExternal: async () => undefined,
      clientFactory: fakeHarness([{ characterId: 404, characterName: 'Offline Pilot' }]).factory
    })
    await oldService.connect()
    const legacyPath = getEveAccountStoragePaths(dataDirectory).refreshToken
    const before = await readFile(legacyPath)

    class OfflineClient extends CharacterAwareFakeClient {
      override async restoreSession(): Promise<EveSsoSession | null> {
        throw new EveSsoError('network_error', 'Сеть EVE SSO недоступна')
      }
    }
    const service = createService({
      dataDirectory,
      protector,
      factory: (options) => new OfflineClient(options, async () => {
        throw new Error('not used')
      })
    })

    expect(await service.restore()).toMatchObject({
      connected: false,
      error: 'Сеть EVE SSO недоступна'
    })
    expect((await readFile(legacyPath)).equals(before)).toBe(true)
    expect(await service.getAccountsStatus()).toMatchObject({
      legacyMigration: 'pending',
      characters: [],
      error: 'Сеть EVE SSO недоступна'
    })
  })

  it('preserves a legacy token issued to another OAuth client instead of deleting it', async () => {
    const dataDirectory = await temporaryDirectory()
    const protector = new TestProtector()
    const oldService = new EveAccountService({
      dataDirectory,
      clientId: 'other-eve-client',
      protector,
      openExternal: async () => undefined,
      clientFactory: fakeHarness([{ characterId: 405, characterName: 'Other Client' }]).factory
    })
    await oldService.connect()
    const legacyPath = getEveAccountStoragePaths(dataDirectory).refreshToken
    const before = await readFile(legacyPath)

    const service = createService({ dataDirectory, protector, factory: fakeHarness().factory })
    expect(await service.restore()).toMatchObject({ connected: false, characterId: null })
    expect((await readFile(legacyPath)).equals(before)).toBe(true)
    expect(await service.getAccountsStatus()).toMatchObject({
      legacyMigration: 'blocked',
      characters: []
    })
    expect((await service.getAccountsStatus()).error).toMatch(/another OAuth client ID/)
  })

  it('rejects and clears a credential filed under a different character ID', async () => {
    const dataDirectory = await temporaryDirectory()
    const protector = new TestProtector()
    const harness = fakeHarness([{ characterId: 901, characterName: 'Expected' }])
    const service = createService({ dataDirectory, protector, factory: harness.factory })
    await service.connectCharacter()

    const tokenPath = getEveMultiAccountRefreshTokenPath(dataDirectory, 901)
    const tokenStore = new EncryptedRefreshTokenStore(
      new AtomicFileBlobStore(tokenPath),
      protector
    )
    await tokenStore.save(refreshToken('fly-safe-client', {
      characterId: 902,
      characterName: 'Wrong Character'
    }))

    const restarted = createService({ dataDirectory, protector, factory: fakeHarness().factory })
    await expect(restarted.restoreCharacter(901)).rejects.toMatchObject({
      code: 'character_mismatch'
    })
    await expect(stat(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await restarted.getAccountsStatus()).toMatchObject({
      characters: [{
        characterId: 901,
        connected: false,
        credentialStored: false,
        state: 'error'
      }]
    })
  })

  it('enforces the character limit after identity verification and does not persist overflow', async () => {
    const dataDirectory = await temporaryDirectory()
    const harness = fakeHarness([
      { characterId: 1, characterName: 'Allowed' },
      { characterId: 2, characterName: 'Overflow' }
    ])
    const service = createService({
      dataDirectory,
      factory: harness.factory,
      maxCharacters: 1
    })

    await service.connectCharacter()
    await expect(service.connectCharacter()).rejects.toMatchObject({
      code: 'character_limit_reached'
    })
    expect((await service.listCharacters()).map(({ characterId }) => characterId)).toEqual([1])
    await expect(stat(getEveMultiAccountRefreshTokenPath(dataDirectory, 2)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never writes plaintext when OS encryption is unavailable', async () => {
    const dataDirectory = await temporaryDirectory()
    const service = createService({
      dataDirectory,
      protector: new TestProtector(false),
      factory: fakeHarness([{ characterId: 77, characterName: 'Secure Pilot' }]).factory
    })

    await expect(service.connectCharacter()).rejects.toMatchObject({
      code: 'secure_storage_unavailable'
    })
    await expect(stat(getEveMultiAccountRefreshTokenPath(dataDirectory, 77)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await service.listCharacters()).toEqual([])
  })

  it('serializes overlapping SSO operations', async () => {
    const dataDirectory = await temporaryDirectory()
    const identities: FakeIdentity[] = [
      { characterId: 51, characterName: 'First' },
      { characterId: 52, characterName: 'Second' }
    ]
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let loginCount = 0
    const factory: EveSsoClientFactory = (options) => new CharacterAwareFakeClient(
      options,
      async () => {
        const identity = identities.shift()!
        loginCount += 1
        events.push(`start:${identity.characterId}`)
        if (loginCount === 1) await firstGate
        events.push(`end:${identity.characterId}`)
        return identity
      }
    )
    const service = createService({ dataDirectory, factory })

    const first = service.connectCharacter()
    await vi.waitFor(() => expect(events).toEqual(['start:51']))
    const second = service.connectCharacter()
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toEqual(['start:51'])

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['start:51', 'end:51', 'start:52', 'end:52'])
  })
})

function refreshToken(clientId: string, identity: FakeIdentity): string {
  return `refresh|${clientId}|${identity.characterId}|${encodeURIComponent(identity.characterName)}`
}

function parseRefreshToken(value: string, clientId: string): FakeIdentity {
  const [prefix, storedClientId, rawCharacterId, rawName] = value.split('|')
  const characterId = Number(rawCharacterId)
  if (
    prefix !== 'refresh' ||
    storedClientId !== clientId ||
    !Number.isSafeInteger(characterId) ||
    characterId <= 0 ||
    typeof rawName !== 'string'
  ) {
    throw new EveSsoError('invalid_token', 'Invalid fake refresh token')
  }
  return { characterId, characterName: decodeURIComponent(rawName) }
}

function makeSession(identity: FakeIdentity): EveSsoSession {
  return {
    characterId: identity.characterId,
    characterName: identity.characterName,
    scopes: [...EVE_SSO_SCOPES],
    expiresAt: NOW + 3_600_000
  }
}

function cloneSession(session: EveSsoSession): EveSsoSession {
  return { ...session, scopes: [...session.scopes] }
}
