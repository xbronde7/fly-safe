import { expectPrivatePathMode } from './file-permissions'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AtomicFileBlobStore,
  EveAccountError,
  EveAccountService,
  getEveAccountStoragePaths,
  type EveSsoClientAdapter,
  type EveSsoClientFactory
} from '../src/main/account-service'
import {
  EVE_SSO_REDIRECT_URI,
  EVE_SSO_SCOPES,
  EveSsoError,
  type EveSsoOptions,
  type EveSsoSession,
  type SecretProtector
} from '../src/main/eve-sso'

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
    const bytes = Buffer.from(plaintext, 'utf8')
    return Uint8Array.from([0xe1, 0x7e, ...bytes.map((byte) => byte ^ 0xa5)])
  }

  decryptString(ciphertext: Uint8Array): string {
    if (!this.available) throw new Error('unavailable')
    if (ciphertext[0] !== 0xe1 || ciphertext[1] !== 0x7e) throw new Error('invalid ciphertext')
    const plaintext = Uint8Array.from(ciphertext.slice(2), (byte) => byte ^ 0xa5)
    return Buffer.from(plaintext).toString('utf8')
  }
}

class FakeSsoClient implements EveSsoClientAdapter {
  session: EveSsoSession | null = null
  clearCalls = 0
  loginCalls = 0
  restoreCalls = 0

  constructor(
    readonly options: EveSsoOptions,
    private readonly characterId = 90_000_001,
    private readonly characterName = 'Test Capsuleer'
  ) {}

  async login(): Promise<EveSsoSession> {
    this.loginCalls += 1
    await this.options.openExternal('https://login.eveonline.com/v2/oauth/authorize')
    await this.options.refreshTokenStore.save(`refresh-${this.options.clientId}`)
    this.session = this.makeSession()
    return cloneTestSession(this.session)
  }

  async restoreSession(): Promise<EveSsoSession | null> {
    this.restoreCalls += 1
    const refreshToken = await this.options.refreshTokenStore.load()
    if (refreshToken !== `refresh-${this.options.clientId}`) {
      this.session = null
      return null
    }
    this.session = this.makeSession()
    return cloneTestSession(this.session)
  }

  async getAccessToken(): Promise<string | null> {
    if (!this.session) await this.restoreSession()
    return this.session ? `access-${this.options.clientId}` : null
  }

  getSession(): EveSsoSession | null {
    return this.session ? cloneTestSession(this.session) : null
  }

  async clearLocalSession(): Promise<void> {
    this.clearCalls += 1
    this.session = null
    await this.options.refreshTokenStore.clear()
  }

  private makeSession(): EveSsoSession {
    return {
      characterId: this.characterId,
      characterName: this.characterName,
      scopes: [...EVE_SSO_SCOPES],
      expiresAt: Date.now() + 3_600_000
    }
  }
}

function fakeClientHarness(): {
  factory: EveSsoClientFactory
  clients: FakeSsoClient[]
} {
  const clients: FakeSsoClient[] = []
  return {
    clients,
    factory: (options) => {
      const client = new FakeSsoClient(options)
      clients.push(client)
      return client
    }
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'eve-account-service-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('AtomicFileBlobStore', () => {
  it('atomically writes private bytes with unique temporary paths and mode 0600', async () => {
    const dataDirectory = await temporaryDirectory()
    const paths = getEveAccountStoragePaths(dataDirectory)
    const store = new AtomicFileBlobStore(paths.refreshToken)
    const candidates = Array.from({ length: 8 }, (_, index) =>
      Uint8Array.from({ length: 32 }, () => index + 1)
    )

    await Promise.all(candidates.map((candidate) => store.write(candidate)))

    const stored = await store.read()
    expect(candidates.some((candidate) => Buffer.from(candidate).equals(Buffer.from(stored!)))).toBe(true)
    await expectPrivatePathMode(paths.refreshToken, 0o600)
    await expectPrivatePathMode(paths.directory, 0o700)
    expect((await readdir(paths.directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('supports idempotent clear without creating storage', async () => {
    const dataDirectory = await temporaryDirectory()
    const paths = getEveAccountStoragePaths(dataDirectory)
    const store = new AtomicFileBlobStore(paths.refreshToken)

    await store.clear()
    await store.write(Uint8Array.of(1, 2, 3))
    await store.clear()
    await store.clear()

    await expect(stat(paths.refreshToken)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('orders writes, reads, and logout clears across adapters sharing one file', async () => {
    const dataDirectory = await temporaryDirectory()
    const paths = getEveAccountStoragePaths(dataDirectory)
    const first = new AtomicFileBlobStore(paths.refreshToken)
    const second = new AtomicFileBlobStore(paths.refreshToken)
    const value = Uint8Array.of(1, 2, 3)

    const write = first.write(value)
    const read = second.read()
    const clear = second.clear()
    await expect(read).resolves.toEqual(value)
    await Promise.all([write, clear])
    expect(await first.read()).toBeNull()
    expect((await readdir(paths.directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('allows later operations to recover after a failed atomic write', async () => {
    const dataDirectory = await temporaryDirectory()
    const paths = getEveAccountStoragePaths(dataDirectory)
    const store = new AtomicFileBlobStore(paths.refreshToken)
    await mkdir(paths.refreshToken, { recursive: true })
    await expect(store.write(Uint8Array.of(1))).rejects.toMatchObject({
      code: 'secure_storage_failed'
    })
    await rm(paths.refreshToken, { recursive: true })

    await store.write(Uint8Array.of(2))
    expect(await store.read()).toEqual(Uint8Array.of(2))
    expect((await readdir(paths.directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('EveAccountService', () => {
  it('persists public configuration separately and keeps refresh tokens encrypted', async () => {
    const dataDirectory = await temporaryDirectory()
    const paths = getEveAccountStoragePaths(dataDirectory)
    const openExternal = vi.fn(async () => undefined)
    const harness = fakeClientHarness()
    const service = new EveAccountService({
      dataDirectory,
      clientId: 'public-client-id',
      protector: new TestProtector(),
      openExternal,
      clientFactory: harness.factory
    })

    expect(await service.load()).toEqual({
      configured: true,
      connected: false,
      clientId: 'public-client-id',
      callbackUri: EVE_SSO_REDIRECT_URI,
      characterId: null,
      characterName: null,
      scopes: [],
      error: null
    })

    const configText = await readFile(paths.config, 'utf8')
    expect(JSON.parse(configText)).toEqual({ version: 1, clientId: 'public-client-id' })
    expect(configText).not.toContain('refresh-public-client-id')
    await expectPrivatePathMode(paths.config, 0o600)

    const connected = await service.connect()
    expect(connected).toMatchObject({
      configured: true,
      connected: true,
      clientId: 'public-client-id',
      characterId: 90_000_001,
      characterName: 'Test Capsuleer',
      scopes: [...EVE_SSO_SCOPES],
      error: null
    })
    expect(openExternal).toHaveBeenCalledOnce()

    const encryptedToken = await readFile(paths.refreshToken)
    expect(encryptedToken.toString('utf8')).not.toContain('refresh-public-client-id')
    await expectPrivatePathMode(paths.refreshToken, 0o600)

    const authorized = await service.getAuthorizedSession()
    expect(authorized).toMatchObject({
      accessToken: 'access-public-client-id',
      session: {
        characterId: 90_000_001,
        characterName: 'Test Capsuleer',
        scopes: [...EVE_SSO_SCOPES]
      }
    })
    authorized!.session.scopes.length = 0
    expect((await service.getStatus()).scopes).toEqual([...EVE_SSO_SCOPES])
  })

  it('loads configuration, restores via encrypted token, then disconnects locally', async () => {
    const dataDirectory = await temporaryDirectory()
    const protector = new TestProtector()
    const firstHarness = fakeClientHarness()
    const first = new EveAccountService({
      dataDirectory,
      clientId: 'persistent-client',
      protector,
      openExternal: async () => undefined,
      clientFactory: firstHarness.factory
    })
    await first.connect()

    const secondHarness = fakeClientHarness()
    const restoredService = new EveAccountService({
      dataDirectory,
      clientId: 'persistent-client',
      protector,
      openExternal: async () => undefined,
      clientFactory: secondHarness.factory
    })

    expect(await restoredService.load()).toMatchObject({
      configured: true,
      connected: false,
      clientId: 'persistent-client'
    })
    expect(await restoredService.restore()).toMatchObject({
      configured: true,
      connected: true,
      characterId: 90_000_001
    })
    expect(secondHarness.clients[0].restoreCalls).toBe(1)

    const disconnected = await restoredService.disconnect()
    expect(disconnected).toMatchObject({
      configured: true,
      connected: false,
      clientId: 'persistent-client',
      characterId: null,
      characterName: null
    })
    const paths = getEveAccountStoragePaths(dataDirectory)
    await expect(stat(paths.refreshToken)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(paths.config, 'utf8'))).toEqual({
      version: 1,
      clientId: 'persistent-client'
    })
  })

  it('migrates legacy Client ID and clears its incompatible refresh token', async () => {
    const dataDirectory = await temporaryDirectory()
    const harness = fakeClientHarness()
    const service = new EveAccountService({
      dataDirectory,
      clientId: 'client-one',
      protector: new TestProtector(),
      openExternal: async () => undefined,
      clientFactory: harness.factory
    })

    await service.connect()
    expect(harness.clients[0].getSession()).not.toBeNull()

    const replacementHarness = fakeClientHarness()
    const replacement = new EveAccountService({
      dataDirectory,
      clientId: 'client-two',
      protector: new TestProtector(),
      openExternal: async () => undefined,
      clientFactory: replacementHarness.factory
    })
    const changed = await replacement.load()
    expect(changed).toMatchObject({
      configured: true,
      connected: false,
      clientId: 'client-two',
      characterId: null
    })
    expect(replacementHarness.clients).toHaveLength(1)
    await expect(stat(getEveAccountStoragePaths(dataDirectory).refreshToken)).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(JSON.parse(await readFile(getEveAccountStoragePaths(dataDirectory).config, 'utf8')))
      .toEqual({ version: 1, clientId: 'client-two' })
  })

  it('never falls back to plaintext when system encryption is unavailable', async () => {
    const dataDirectory = await temporaryDirectory()
    const service = new EveAccountService({
      dataDirectory,
      clientId: 'secure-client',
      protector: new TestProtector(false),
      openExternal: async () => undefined,
      clientFactory: fakeClientHarness().factory
    })
    await expect(service.connect()).rejects.toMatchObject({
      code: 'secure_storage_unavailable'
    } satisfies Partial<EveSsoError>)
    expect(await service.getStatus()).toMatchObject({
      configured: true,
      connected: false,
      error: 'System encryption unavailable; token will not be saved'
    })

    const paths = getEveAccountStoragePaths(dataDirectory)
    await expect(stat(paths.refreshToken)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(paths.config, 'utf8')).not.toContain('refresh-secure-client')
  })

  it('serializes connect and restore operations', async () => {
    const dataDirectory = await temporaryDirectory()
    const events: string[] = []
    let releaseLogin!: () => void
    const loginGate = new Promise<void>((resolve) => {
      releaseLogin = resolve
    })

    class ControlledClient extends FakeSsoClient {
      override async login(): Promise<EveSsoSession> {
        events.push('login:start')
        await loginGate
        const session = await super.login()
        events.push('login:end')
        return session
      }

      override async restoreSession(): Promise<EveSsoSession | null> {
        events.push('restore:start')
        const session = await super.restoreSession()
        events.push('restore:end')
        return session
      }
    }

    const service = new EveAccountService({
      dataDirectory,
      clientId: 'serialized-client',
      protector: new TestProtector(),
      openExternal: async () => undefined,
      clientFactory: (options) => new ControlledClient(options)
    })
    const connect = service.connect()
    await vi.waitFor(() => expect(events).toEqual(['login:start']))
    const restore = service.restore()
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toEqual(['login:start'])

    releaseLogin()
    await Promise.all([connect, restore])
    expect(events).toEqual(['login:start', 'login:end', 'restore:start', 'restore:end'])
  })

  it('reports corrupt configuration and can safely replace it', async () => {
    const dataDirectory = await temporaryDirectory()
    const paths = getEveAccountStoragePaths(dataDirectory)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.config, '{broken', { mode: 0o600 })
    const service = new EveAccountService({
      dataDirectory,
      clientId: 'replacement-client',
      protector: new TestProtector(),
      openExternal: async () => undefined,
      clientFactory: fakeClientHarness().factory
    })

    expect(await service.load()).toMatchObject({
      configured: true,
      connected: false,
      clientId: 'replacement-client',
      error: null
    })
    expect(JSON.parse(await readFile(paths.config, 'utf8'))).toEqual({
      version: 1,
      clientId: 'replacement-client'
    })
  })

  it('rejects an invalid embedded Client ID without writing files', async () => {
    const dataDirectory = await temporaryDirectory()
    expect(() => new EveAccountService({
      dataDirectory,
      clientId: ' invalid client id ',
      protector: new TestProtector(),
      openExternal: async () => undefined,
      clientFactory: fakeClientHarness().factory
    })).toThrow(EveAccountError)
    await expect(stat(getEveAccountStoragePaths(dataDirectory).config)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

function cloneTestSession(session: EveSsoSession): EveSsoSession {
  return {
    ...session,
    scopes: [...session.scopes]
  }
}
