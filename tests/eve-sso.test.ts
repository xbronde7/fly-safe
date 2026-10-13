import { createHash } from 'node:crypto'
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK
} from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  EncryptedRefreshTokenStore,
  EVE_SSO_DISCOVERY_URL,
  EVE_SSO_LOGIN_TIMEOUT_MS,
  EVE_SSO_OPTIONAL_SCOPES,
  EVE_SSO_REQUIRED_SCOPES,
  EVE_SSO_REDIRECT_URI,
  EVE_SSO_SCOPES,
  EVE_SSO_INDUSTRY_SCOPES,
  EVE_SSO_SUPPORTED_SCOPES,
  EveSsoClient,
  EveSsoError,
  LoopbackCallbackReceiver,
  type EncryptedBlobStore,
  type EveSsoCallbackHandle,
  type EveSsoCallbackReceiver,
  type SecretProtector,
  type SecureRefreshTokenStore
} from '../src/main/eve-sso'

const CLIENT_ID = 'desktop-client-123'
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)
const ISSUER = 'https://login.eveonline.com'
const AUTHORIZATION_ENDPOINT = 'https://login.eveonline.com/v2/oauth/authorize'
const TOKEN_ENDPOINT = 'https://login.eveonline.com/v2/oauth/token'
const JWKS_URI = 'https://login.eveonline.com/oauth/jwks'

let privateKey: CryptoKey
let publicJwk: JWK

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: 'RS256',
    kid: 'test-key',
    use: 'sig'
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

class TestRefreshStore implements SecureRefreshTokenStore {
  value: string | null
  readonly saved: string[] = []
  clearCalls = 0

  constructor(initial: string | null = null) {
    this.value = initial
  }

  async load(): Promise<string | null> {
    return this.value
  }

  async save(token: string): Promise<void> {
    this.value = token
    this.saved.push(token)
  }

  async clear(): Promise<void> {
    this.value = null
    this.clearCalls += 1
  }
}

class TestCallbackReceiver implements EveSsoCallbackReceiver {
  beginCalls = 0
  closeCalls = 0
  lastOptions: Parameters<EveSsoCallbackReceiver['begin']>[0] | null = null
  callbackFactory: (
    options: Parameters<EveSsoCallbackReceiver['begin']>[0]
  ) => EveSsoCallbackHandle['callback'] = (options) =>
    Promise.resolve({ code: 'authorization-code', state: options.expectedState })

  async begin(
    options: Parameters<EveSsoCallbackReceiver['begin']>[0]
  ): Promise<EveSsoCallbackHandle> {
    this.beginCalls += 1
    this.lastOptions = options
    return {
      callback: this.callbackFactory(options),
      close: async () => {
        this.closeCalls += 1
      }
    }
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function discovery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZATION_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    jwks_uri: JWKS_URI,
    code_challenge_methods_supported: ['S256'],
    ...overrides
  }
}

interface JwtOverrides {
  issuer?: string
  audience?: string[]
  subject?: string
  scopes?: string[]
  authorizedParty?: string
  name?: string
  expiresAt?: number
  signingKey?: CryptoKey
  keyId?: string
}

async function signedAccessToken(overrides: JwtOverrides = {}): Promise<string> {
  const payload: Record<string, unknown> = {
    name: overrides.name ?? 'Test Capsuleer',
    scp: overrides.scopes ?? [...EVE_SSO_SCOPES]
  }
  if (overrides.authorizedParty !== undefined) payload.azp = overrides.authorizedParty

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: overrides.keyId ?? 'test-key' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? [CLIENT_ID, 'EVE Online'])
    .setSubject(overrides.subject ?? 'CHARACTER:EVE:90000001')
    .setIssuedAt(Math.floor(NOW / 1_000))
    .setExpirationTime(overrides.expiresAt ?? Math.floor(NOW / 1_000) + 1_200)
    .sign(overrides.signingKey ?? privateKey)
}

function createFetchMock(
  accessToken: string,
  options: {
    refreshToken?: string
    expiresIn?: number
    metadata?: Record<string, unknown>
    tokenStatus?: number
    tokenBody?: unknown
  } = {}
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url === EVE_SSO_DISCOVERY_URL) {
      return jsonResponse(options.metadata ?? discovery())
    }
    if (url === JWKS_URI) return jsonResponse({ keys: [publicJwk] })
    if (url === TOKEN_ENDPOINT) {
      if (options.tokenStatus) {
        return jsonResponse(options.tokenBody ?? { error: 'invalid_grant' }, options.tokenStatus)
      }
      return jsonResponse({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: options.expiresIn ?? 600,
        refresh_token: options.refreshToken ?? 'rotated-refresh-token'
      })
    }
    return jsonResponse({ error: 'unexpected' }, 500)
  })
}

function deterministicRandom(): (size: number) => Uint8Array {
  let call = 0
  return (size) => {
    call += 1
    return new Uint8Array(size).fill(call)
  }
}

describe('EveSsoClient login', () => {
  it('requests manufacturing scopes only through an explicit feature login and preserves them in the session', async () => {
    const token = await signedAccessToken({ scopes: [...EVE_SSO_SUPPORTED_SCOPES] })
    const openExternal = vi.fn()
    const client = new EveSsoClient({ clientId: CLIENT_ID, openExternal, refreshTokenStore: new TestRefreshStore(), fetch: createFetchMock(token), callbackReceiver: new TestCallbackReceiver(), now: () => NOW })
    const session = await client.login({ industry: true })
    const scope = new URL(openExternal.mock.calls[0][0]).searchParams.get('scope')!
    for (const item of EVE_SSO_INDUSTRY_SCOPES) { expect(scope).toContain(item); expect(session.scopes).toContain(item) }
  })
  it('refuses an industry authorization missing scopes before replacing a saved token', async () => {
    const store = new TestRefreshStore('old-refresh')
    const client = new EveSsoClient({ clientId: CLIENT_ID, openExternal: vi.fn(), refreshTokenStore: store, fetch: createFetchMock(await signedAccessToken()), callbackReceiver: new TestCallbackReceiver(), now: () => NOW })
    await expect(client.login({ industry: true })).rejects.toThrow('industry scopes')
    expect(store.value).toBe('old-refresh')
  })
  it('builds a fixed-loopback PKCE URL, validates state/JWT and exchanges without a secret', async () => {
    const accessToken = await signedAccessToken()
    const fetchMock = createFetchMock(accessToken)
    const store = new TestRefreshStore()
    const callbacks = new TestCallbackReceiver()
    let openedUrl = ''
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: (url) => {
        openedUrl = url
      },
      refreshTokenStore: store,
      fetch: fetchMock,
      callbackReceiver: callbacks,
      randomBytes: deterministicRandom(),
      now: () => NOW
    })

    const session = await client.login()

    expect(session).toEqual({
      characterId: 90_000_001,
      characterName: 'Test Capsuleer',
      scopes: [...EVE_SSO_SCOPES],
      expiresAt: NOW + 600_000
    })
    expect(callbacks.lastOptions).toMatchObject({
      redirectUri: EVE_SSO_REDIRECT_URI,
      timeoutMs: EVE_SSO_LOGIN_TIMEOUT_MS
    })
    expect(callbacks.closeCalls).toBe(1)

    const url = new URL(openedUrl)
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZATION_ENDPOINT)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: EVE_SSO_REDIRECT_URI,
      scope: EVE_SSO_SCOPES.join(' '),
      code_challenge_method: 'S256'
    })
    expect(url.searchParams.get('state')).toBe(callbacks.lastOptions?.expectedState)
    expect(url.searchParams.get('state')).toHaveLength(43)

    const tokenCall = fetchMock.mock.calls.find(([input]) => String(input) === TOKEN_ENDPOINT)
    expect(tokenCall).toBeDefined()
    const tokenInit = tokenCall?.[1]
    const body = new URLSearchParams(String(tokenInit?.body))
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'authorization-code',
      client_id: CLIENT_ID,
      code_verifier: Buffer.from(new Uint8Array(32).fill(2)).toString('base64url'),
      redirect_uri: EVE_SSO_REDIRECT_URI
    })
    const expectedChallenge = createHash('sha256')
      .update(body.get('code_verifier') ?? '', 'ascii')
      .digest('base64url')
    expect(url.searchParams.get('code_challenge')).toBe(expectedChallenge)
    expect(body.has('client_secret')).toBe(false)
    expect(new Headers(tokenInit?.headers).has('Authorization')).toBe(false)
    expect(store.saved).toEqual(['rotated-refresh-token'])
    expect(await client.getAccessToken()).toBe(accessToken)
  })

  it('rejects a callback state mismatch before the token request', async () => {
    const callbacks = new TestCallbackReceiver()
    callbacks.callbackFactory = () =>
      Promise.resolve({ code: 'authorization-code', state: 'attacker-state' })
    const fetchMock = createFetchMock(await signedAccessToken())
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: vi.fn(),
      refreshTokenStore: new TestRefreshStore(),
      fetch: fetchMock,
      callbackReceiver: callbacks,
      now: () => NOW
    })

    await expect(client.login()).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(fetchMock.mock.calls.some(([input]) => String(input) === TOKEN_ENDPOINT)).toBe(false)
    expect(callbacks.closeCalls).toBe(1)
  })

  it('redacts an authorization URL from system-browser failures', async () => {
    const callbacks = new TestCallbackReceiver()
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: (url) => {
        throw new Error(`Browser rejected ${url}`)
      },
      refreshTokenStore: new TestRefreshStore(),
      fetch: createFetchMock(await signedAccessToken()),
      callbackReceiver: callbacks,
      now: () => NOW
    })

    const error = await client.login().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'browser_open_failed' })
    expect(String(error)).not.toContain('state=')
    expect(callbacks.closeCalls).toBe(1)
  })

  it('allows only one active login', async () => {
    let finishCallback!: (value: { code: string; state: string }) => void
    const callbacks = new TestCallbackReceiver()
    callbacks.callbackFactory = (options) =>
      new Promise((resolve) => {
        finishCallback = resolve
        queueMicrotask(() => finishCallback({ code: 'authorization-code', state: options.expectedState }))
      })
    let finishBrowser!: () => void
    const browser = new Promise<void>((resolve) => {
      finishBrowser = resolve
    })
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: () => browser,
      refreshTokenStore: new TestRefreshStore(),
      fetch: createFetchMock(await signedAccessToken()),
      callbackReceiver: callbacks,
      now: () => NOW
    })

    const first = client.login()
    await vi.waitFor(() => expect(callbacks.beginCalls).toBe(1))
    await expect(client.login()).rejects.toMatchObject({ code: 'login_in_progress' })
    finishBrowser()
    await expect(first).resolves.toMatchObject({ characterId: 90_000_001 })
  })

  it('cancels a stalled browser callback immediately and allows a fresh login', async () => {
    let beginCalls = 0
    let cancelFirst!: () => void
    const callbacks: EveSsoCallbackReceiver = {
      async begin(options) {
        beginCalls += 1
        if (beginCalls === 1) {
          let rejectCallback!: (reason: EveSsoError) => void
          const callback = new Promise<never>((_resolve, reject) => {
            rejectCallback = reject
          })
          cancelFirst = () => rejectCallback(
            new EveSsoError('login_cancelled', 'Вход EVE SSO отменён')
          )
          return { callback, close: async () => cancelFirst() }
        }
        return {
          callback: Promise.resolve({
            code: 'authorization-code',
            state: options.expectedState
          }),
          close: async () => undefined
        }
      }
    }
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: vi.fn(),
      refreshTokenStore: new TestRefreshStore(),
      fetch: createFetchMock(await signedAccessToken()),
      callbackReceiver: callbacks,
      now: () => NOW
    })

    const stalled = client.login()
    await vi.waitFor(() => expect(beginCalls).toBe(1))
    await client.cancelLogin()
    await expect(stalled).rejects.toMatchObject({ code: 'login_cancelled' })
    await expect(client.login()).resolves.toMatchObject({ characterId: 90_000_001 })
  })
})

describe('EveSsoClient refresh and logout', () => {
  it('rotates a persisted refresh token and keeps the access token only in memory', async () => {
    const accessToken = await signedAccessToken()
    const fetchMock = createFetchMock(accessToken, { refreshToken: 'new-refresh', expiresIn: 300 })
    const store = new TestRefreshStore('old-refresh')
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: vi.fn(),
      refreshTokenStore: store,
      fetch: fetchMock,
      callbackReceiver: new TestCallbackReceiver(),
      now: () => NOW
    })

    await expect(client.restoreSession()).resolves.toMatchObject({ expiresAt: NOW + 300_000 })
    const tokenCall = fetchMock.mock.calls.find(([input]) => String(input) === TOKEN_ENDPOINT)
    const body = new URLSearchParams(String(tokenCall?.[1]?.body))
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: CLIENT_ID
    })
    expect(body.has('client_secret')).toBe(false)
    expect(store.saved).toEqual(['new-refresh'])
    expect(await client.getAccessToken()).toBe(accessToken)

    await client.logout()
    expect(client.getSession()).toBeNull()
    expect(store.value).toBeNull()
    expect(store.clearCalls).toBe(1)
  })

  it('clears a rejected refresh token without exposing the response body', async () => {
    const secretInBody = 'do-not-leak-this-refresh-token'
    const store = new TestRefreshStore('expired-refresh')
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: vi.fn(),
      refreshTokenStore: store,
      fetch: createFetchMock('unused', {
        tokenStatus: 400,
        tokenBody: { error: 'invalid_grant', error_description: secretInBody }
      }),
      callbackReceiver: new TestCallbackReceiver(),
      now: () => NOW
    })

    const error = await client.restoreSession().catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'token_request_failed', status: 400 })
    expect(String(error)).not.toContain(secretInBody)
    expect(store.value).toBeNull()
  })
})

describe('EveSsoClient JWT validation', () => {
  it.each([
    'https://login.eveonline.com',
    'https://login.eveonline.com/',
    'login.eveonline.com'
  ])('accepts documented issuer form %s', async (issuer) => {
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: vi.fn(),
      refreshTokenStore: new TestRefreshStore('refresh'),
      fetch: createFetchMock(await signedAccessToken({ issuer })),
      callbackReceiver: new TestCallbackReceiver(),
      now: () => NOW
    })

    await expect(client.restoreSession()).resolves.toMatchObject({ characterId: 90_000_001 })
  })

  it.each([
    {
      name: 'missing client audience',
      overrides: { audience: ['EVE Online'] },
      expected: 'invalid_token'
    },
    {
      name: 'wrong issuer',
      overrides: { issuer: 'https://attacker.invalid' },
      expected: 'invalid_token'
    },
    {
      name: 'wrong subject',
      overrides: { subject: 'USER:EVE:90000001' },
      expected: 'invalid_token'
    },
    {
      name: 'missing scope',
      overrides: { scopes: EVE_SSO_SCOPES.slice(0, 2) },
      expected: 'invalid_token'
    },
    {
      name: 'wrong authorized party',
      overrides: { authorizedParty: 'another-client' },
      expected: 'invalid_token'
    }
  ])('rejects $name', async ({ overrides, expected }) => {
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: vi.fn(),
      refreshTokenStore: new TestRefreshStore('refresh'),
      fetch: createFetchMock(await signedAccessToken(overrides)),
      callbackReceiver: new TestCallbackReceiver(),
      now: () => NOW
    })

    await expect(client.restoreSession()).rejects.toMatchObject({ code: expected })
    expect(client.getSession()).toBeNull()
  })

  it('accepts an existing token with only required scopes and reports optional scopes as missing', async () => {
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: vi.fn(),
      refreshTokenStore: new TestRefreshStore('refresh'),
      fetch: createFetchMock(await signedAccessToken({ scopes: [...EVE_SSO_REQUIRED_SCOPES] })),
      callbackReceiver: new TestCallbackReceiver(),
      now: () => NOW
    })

    await expect(client.restoreSession()).resolves.toMatchObject({
      scopes: [...EVE_SSO_REQUIRED_SCOPES]
    })
  })

  it('requests every optional scope enabled on the embedded OAuth application', () => {
    expect(EVE_SSO_OPTIONAL_SCOPES).toEqual([
      'esi-wallet.read_character_wallet.v1',
      'esi-markets.read_character_orders.v1',
      'esi-assets.read_assets.v1',
      'esi-universe.read_structures.v1',
      'esi-ui.write_waypoint.v1'
    ])
    expect(EVE_SSO_SCOPES).toContain('esi-universe.read_structures.v1')
    expect(EVE_SSO_SCOPES).toContain('esi-markets.read_character_orders.v1')
    expect(EVE_SSO_SCOPES).toEqual([
      'esi-location.read_location.v1',
      'esi-location.read_ship_type.v1',
      'esi-location.read_online.v1',
      'esi-characters.read_contacts.v1',
      'esi-fleets.read_fleet.v1',
      'esi-wallet.read_character_wallet.v1',
      'esi-markets.read_character_orders.v1',
      'esi-assets.read_assets.v1',
      'esi-universe.read_structures.v1',
      'esi-ui.write_waypoint.v1'
    ])
  })

  it('rejects a token signed by an unknown key', async () => {
    const untrustedPair = await generateKeyPair('RS256')
    const token = await signedAccessToken({
      signingKey: untrustedPair.privateKey,
      keyId: 'untrusted-key'
    })
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: vi.fn(),
      refreshTokenStore: new TestRefreshStore('refresh'),
      fetch: createFetchMock(token),
      callbackReceiver: new TestCallbackReceiver(),
      now: () => NOW
    })

    await expect(client.restoreSession()).rejects.toMatchObject({ code: 'invalid_token' })
  })

  it('rejects unsafe discovery metadata', async () => {
    const client = new EveSsoClient({
      clientId: CLIENT_ID,
      openExternal: vi.fn(),
      refreshTokenStore: new TestRefreshStore('refresh'),
      fetch: createFetchMock('unused', {
        metadata: discovery({ token_endpoint: 'http://login.eveonline.com/token' })
      }),
      callbackReceiver: new TestCallbackReceiver(),
      now: () => NOW
    })

    await expect(client.restoreSession()).rejects.toMatchObject({ code: 'invalid_metadata' })
  })
})

describe('encrypted refresh token storage', () => {
  it('writes only ciphertext and decrypts through the injected OS protector', async () => {
    let blob: Uint8Array | null = null
    const blobs: EncryptedBlobStore = {
      read: async () => blob,
      write: async (value) => {
        blob = value.slice()
      },
      clear: async () => {
        blob = null
      }
    }
    const protector: SecretProtector = {
      isEncryptionAvailable: () => true,
      encryptString: (plaintext) => Buffer.from(`encrypted:${plaintext}`, 'utf8'),
      decryptString: (ciphertext) => Buffer.from(ciphertext).toString('utf8').slice('encrypted:'.length)
    }
    const store = new EncryptedRefreshTokenStore(blobs, protector)

    await store.save('refresh-secret')
    expect(Buffer.from(blob ?? []).toString('utf8')).toBe('encrypted:refresh-secret')
    expect(Buffer.from(blob ?? []).toString('utf8')).not.toBe('refresh-secret')
    await expect(store.load()).resolves.toBe('refresh-secret')
    await store.clear()
    await expect(store.load()).resolves.toBeNull()
  })

  it('supports non-blocking async OS protectors', async () => {
    let blob: Uint8Array | null = null
    const store = new EncryptedRefreshTokenStore(
      {
        read: async () => blob,
        write: async (value) => {
          blob = value.slice()
        },
        clear: async () => {
          blob = null
        }
      },
      {
        isEncryptionAvailable: async () => true,
        encryptString: async (plaintext) => Buffer.from(`async:${plaintext}`, 'utf8'),
        decryptString: async (ciphertext) => (
          Buffer.from(ciphertext).toString('utf8').slice('async:'.length)
        )
      }
    )

    await store.save('refresh-secret')
    await expect(store.load()).resolves.toBe('refresh-secret')
  })

  it('never falls back to plaintext when encryption is unavailable', async () => {
    const write = vi.fn()
    const store = new EncryptedRefreshTokenStore(
      { read: async () => null, write, clear: async () => undefined },
      {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from('must-not-run'),
        decryptString: () => 'must-not-run'
      }
    )

    await expect(store.save('refresh-secret')).rejects.toMatchObject({
      code: 'secure_storage_unavailable'
    })
    expect(write).not.toHaveBeenCalled()
  })
})

describe('LoopbackCallbackReceiver', () => {
  it('accepts the exact registered localhost callback through the loopback listener', async () => {
    const receiver = new LoopbackCallbackReceiver()
    const state = 'state-value-with-enough-entropy'
    const handle = await receiver.begin({
      redirectUri: EVE_SSO_REDIRECT_URI,
      expectedState: state,
      timeoutMs: EVE_SSO_LOGIN_TIMEOUT_MS
    })

    try {
      const response = await fetch(
        `${EVE_SSO_REDIRECT_URI}?code=loopback-code&state=${encodeURIComponent(state)}`
      )
      expect(response.status).toBe(200)
      await expect(handle.callback).resolves.toEqual({ code: 'loopback-code', state })
    } finally {
      await handle.close()
    }
  })

  it('releases the callback port after cancellation so login can restart immediately', async () => {
    const receiver = new LoopbackCallbackReceiver()
    const first = await receiver.begin({
      redirectUri: EVE_SSO_REDIRECT_URI,
      expectedState: 'first-state-with-enough-entropy',
      timeoutMs: EVE_SSO_LOGIN_TIMEOUT_MS
    })
    await first.close()
    await expect(first.callback).rejects.toMatchObject({ code: 'login_cancelled' })

    const state = 'second-state-with-enough-entropy'
    const second = await receiver.begin({
      redirectUri: EVE_SSO_REDIRECT_URI,
      expectedState: state,
      timeoutMs: EVE_SSO_LOGIN_TIMEOUT_MS
    })
    try {
      const response = await fetch(
        `${EVE_SSO_REDIRECT_URI}?code=second-code&state=${encodeURIComponent(state)}`
      )
      expect(response.status).toBe(200)
      await expect(second.callback).resolves.toEqual({ code: 'second-code', state })
    } finally {
      await second.close()
    }
  })
})

describe('EveSsoClient configuration', () => {
  it('rejects malformed client IDs and missing secure stores', () => {
    expect(
      () =>
        new EveSsoClient({
          clientId: 'bad client id',
          openExternal: vi.fn(),
          refreshTokenStore: new TestRefreshStore()
        })
    ).toThrowError(EveSsoError)

    expect(
      () =>
        new EveSsoClient({
          clientId: CLIENT_ID,
          openExternal: vi.fn(),
          refreshTokenStore: null as unknown as SecureRefreshTokenStore
        })
    ).toThrowError(EveSsoError)
  })
})
