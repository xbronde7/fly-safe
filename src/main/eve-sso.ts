import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload
} from 'jose'

export const EVE_SSO_DISCOVERY_URL =
  'https://login.eveonline.com/.well-known/oauth-authorization-server'
export const EVE_SSO_REDIRECT_URI = 'http://localhost:53173/callback'
export const EVE_SSO_LOGIN_TIMEOUT_MS = 2 * 60 * 1_000
export const EVE_SSO_REQUIRED_SCOPES = [
  'esi-location.read_location.v1',
  'esi-location.read_ship_type.v1',
  'esi-location.read_online.v1',
  'esi-characters.read_contacts.v1',
  'esi-fleets.read_fleet.v1'
] as const

/** Optional account features. Old refresh tokens with only required scopes remain valid. */
export const EVE_SSO_OPTIONAL_SCOPES = [
  'esi-wallet.read_character_wallet.v1',
  'esi-markets.read_character_orders.v1',
  'esi-assets.read_assets.v1',
  'esi-universe.read_structures.v1',
  'esi-ui.write_waypoint.v1'
] as const

export const EVE_SSO_SCOPES = [
  ...EVE_SSO_REQUIRED_SCOPES,
  ...EVE_SSO_OPTIONAL_SCOPES
] as const

// Do not add scopes to ordinary sign-in until CCP's registered application has
// enabled them. Industry permissions are requested by an explicit feature action.
export const EVE_SSO_INDUSTRY_SCOPES = [
  'esi-skills.read_skills.v1', 'esi-characters.read_blueprints.v1', 'esi-industry.read_character_jobs.v1'
] as const
export const EVE_SSO_SUPPORTED_SCOPES = [...EVE_SSO_SCOPES, ...EVE_SSO_INDUSTRY_SCOPES] as const

const LOOPBACK_HOST = '127.0.0.1'
const LOOPBACK_PORT = 53_173
const LOOPBACK_PATH = '/callback'
const METADATA_CACHE_MS = 5 * 60 * 1_000
const NETWORK_TIMEOUT_MS = 15_000
const TOKEN_EXPIRY_MARGIN_MS = 30_000
const MAX_TOKEN_LENGTH = 16_384
const ACCEPTED_ISSUERS = [
  'https://login.eveonline.com',
  'https://login.eveonline.com/',
  'login.eveonline.com'
] as const

type FetchLike = typeof fetch
type RandomBytesLike = (size: number) => Uint8Array

export type EveSsoScope = (typeof EVE_SSO_SUPPORTED_SCOPES)[number]

export type EveSsoErrorCode =
  | 'invalid_config'
  | 'login_in_progress'
  | 'browser_open_failed'
  | 'callback_unavailable'
  | 'callback_timeout'
  | 'authorization_denied'
  | 'invalid_callback'
  | 'state_mismatch'
  | 'network_error'
  | 'invalid_metadata'
  | 'token_request_failed'
  | 'invalid_token'
  | 'secure_storage_unavailable'
  | 'secure_storage_failed'
  | 'login_cancelled'

export class EveSsoError extends Error {
  readonly code: EveSsoErrorCode
  readonly status: number | null

  constructor(code: EveSsoErrorCode, message: string, status: number | null = null) {
    super(message)
    this.name = 'EveSsoError'
    this.code = code
    this.status = status
  }
}

/**
 * Storage contract for refresh tokens. Production implementations must encrypt at rest.
 * `EncryptedRefreshTokenStore` below is intended to be paired with Electron `safeStorage`
 * and a byte-oriented file/key-value adapter in the Electron main process.
 */
export interface SecureRefreshTokenStore {
  load(): Promise<string | null>
  save(refreshToken: string): Promise<void>
  clear(): Promise<void>
}

export interface EncryptedBlobStore {
  read(): Promise<Uint8Array | null>
  write(value: Uint8Array): Promise<void>
  clear(): Promise<void>
}

type MaybePromise<T> = T | Promise<T>

/** Structurally compatible with an adapter around Electron's `safeStorage`. */
export interface SecretProtector {
  isEncryptionAvailable(): MaybePromise<boolean>
  encryptString(plaintext: string): MaybePromise<Uint8Array>
  decryptString(ciphertext: Uint8Array): MaybePromise<string>
}

/** Never falls back to plaintext when OS encryption is unavailable. */
export class EncryptedRefreshTokenStore implements SecureRefreshTokenStore {
  constructor(
    private readonly blobs: EncryptedBlobStore,
    private readonly protector: SecretProtector
  ) {}

  async load(): Promise<string | null> {
    const encrypted = await this.blobs.read()
    if (encrypted === null) return null
    await this.assertEncryptionAvailable()

    try {
      const token = await this.protector.decryptString(encrypted)
      assertRefreshToken(token)
      return token
    } catch (error) {
      if (error instanceof EveSsoError) throw error
      throw new EveSsoError('secure_storage_failed', 'Could not decrypt EVE SSO token')
    }
  }

  async save(refreshToken: string): Promise<void> {
    assertRefreshToken(refreshToken)
    await this.assertEncryptionAvailable()

    try {
      const encrypted = await this.protector.encryptString(refreshToken)
      if (!(encrypted instanceof Uint8Array) || encrypted.byteLength === 0) {
        throw new TypeError('Empty encrypted value')
      }
      await this.blobs.write(encrypted)
    } catch {
      throw new EveSsoError('secure_storage_failed', 'Could not securely store EVE SSO token')
    }
  }

  async clear(): Promise<void> {
    try {
      await this.blobs.clear()
    } catch {
      throw new EveSsoError('secure_storage_failed', 'Could not remove local EVE SSO token')
    }
  }

  private async assertEncryptionAvailable(): Promise<void> {
    if (!(await this.protector.isEncryptionAvailable())) {
      throw new EveSsoError(
        'secure_storage_unavailable',
        'System encryption unavailable; token will not be saved'
      )
    }
  }
}

export interface EveSsoCallback {
  code: string
  state: string
}

export interface EveSsoCallbackHandle {
  callback: Promise<EveSsoCallback>
  close(): Promise<void>
}

export interface EveSsoCallbackReceiver {
  begin(options: {
    redirectUri: typeof EVE_SSO_REDIRECT_URI
    expectedState: string
    timeoutMs: typeof EVE_SSO_LOGIN_TIMEOUT_MS
  }): Promise<EveSsoCallbackHandle>
}

/** Fixed-port loopback receiver. Public redirect uses localhost; listener stays IPv4 loopback-only. */
export class LoopbackCallbackReceiver implements EveSsoCallbackReceiver {
  async begin(options: {
    redirectUri: typeof EVE_SSO_REDIRECT_URI
    expectedState: string
    timeoutMs: typeof EVE_SSO_LOGIN_TIMEOUT_MS
  }): Promise<EveSsoCallbackHandle> {
    if (
      options.redirectUri !== EVE_SSO_REDIRECT_URI ||
      options.timeoutMs !== EVE_SSO_LOGIN_TIMEOUT_MS ||
      !isSafeOpaqueValue(options.expectedState, 16, 256)
    ) {
      throw new EveSsoError('invalid_config', 'Invalid EVE SSO callback configuration')
    }

    let settled = false
    let resolveCallback!: (value: EveSsoCallback) => void
    let rejectCallback!: (reason: EveSsoError) => void
    const callback = new Promise<EveSsoCallback>((resolve, reject) => {
      resolveCallback = resolve
      rejectCallback = reject
    })
    // A browser-opening failure can close the server before the caller awaits this promise.
    void callback.catch(() => undefined)

    const settle = (value: EveSsoCallback | EveSsoError): void => {
      if (settled) return
      settled = true
      if (value instanceof EveSsoError) rejectCallback(value)
      else resolveCallback(value)
    }

    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('X-Content-Type-Options', 'nosniff')

      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' })
        response.end(browserPage('Method not supported', false))
        return
      }

      let callbackUrl: URL
      try {
        callbackUrl = new URL(request.url ?? '', EVE_SSO_REDIRECT_URI)
      } catch {
        response.writeHead(400)
        response.end(browserPage('Invalid authorization response', false))
        return
      }

      if (callbackUrl.pathname !== LOOPBACK_PATH) {
        response.writeHead(404)
        response.end(browserPage('Page not found', false))
        return
      }

      const state = callbackUrl.searchParams.get('state') ?? ''
      if (!constantTimeEqual(state, options.expectedState)) {
        response.writeHead(400)
        response.end(browserPage('Security check failed', false))
        settle(new EveSsoError('state_mismatch', 'EVE SSO returned an invalid state'))
        return
      }

      const oauthError = callbackUrl.searchParams.get('error')
      if (oauthError) {
        response.writeHead(400)
        response.end(browserPage('Authorization canceled', false))
        settle(new EveSsoError('authorization_denied', 'EVE SSO authorization canceled'))
        return
      }

      const code = callbackUrl.searchParams.get('code') ?? ''
      if (!isSafeOpaqueValue(code, 1, 4_096)) {
        response.writeHead(400)
        response.end(browserPage('Authorization code missing', false))
        settle(new EveSsoError('invalid_callback', 'EVE SSO did not return an authorization code'))
        return
      }

      response.writeHead(200)
      response.end(browserPage('Sign-in complete. You can close this tab.', true))
      settle({ code, state })
    })

    try {
      await listenOnFixedLoopback(server)
    } catch {
      throw new EveSsoError(
        'callback_unavailable',
        `Could not open local callback ${EVE_SSO_REDIRECT_URI}`
      )
    }

    server.on('error', () => {
      settle(new EveSsoError('callback_unavailable', 'Local EVE SSO callback stopped'))
    })

    const timer = setTimeout(() => {
      settle(new EveSsoError('callback_timeout', 'EVE SSO sign-in timed out'))
      void closeServer(server)
    }, EVE_SSO_LOGIN_TIMEOUT_MS)
    timer.unref()

    let closed = false
    return {
      callback,
      close: async () => {
        if (closed) return
        closed = true
        clearTimeout(timer)
        if (!settled) {
          settle(new EveSsoError('login_cancelled', 'EVE SSO sign-in canceled'))
        }
        await closeServer(server)
      }
    }
  }
}

export interface EveSsoSession {
  characterId: number
  characterName: string
  scopes: EveSsoScope[]
  expiresAt: number
}

export interface EveSsoOptions {
  clientId: string
  openExternal: (authorizationUrl: string) => Promise<void> | void
  refreshTokenStore: SecureRefreshTokenStore
  fetch?: FetchLike
  callbackReceiver?: EveSsoCallbackReceiver
  now?: () => number
  randomBytes?: RandomBytesLike
}

interface SsoMetadata {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
}

interface TokenResponse {
  accessToken: string
  refreshToken: string | null
  expiresIn: number
}

interface ValidatedToken {
  characterId: number
  characterName: string
  scopes: EveSsoScope[]
  jwtExpiresAt: number
}

interface MemoryAccessToken {
  value: string
  session: EveSsoSession
}

export class EveSsoClient {
  private readonly clientId: string
  private readonly openExternalImpl: EveSsoOptions['openExternal']
  private readonly refreshTokenStore: SecureRefreshTokenStore
  private readonly fetchImpl: FetchLike
  private readonly callbackReceiver: EveSsoCallbackReceiver
  private readonly now: () => number
  private readonly randomBytesImpl: RandomBytesLike

  private metadataCache: { value: SsoMetadata; expiresAt: number } | null = null
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null
  private jwksUri: string | null = null
  private accessToken: MemoryAccessToken | null = null
  private activeLogin: Promise<EveSsoSession> | null = null
  private activeLoginCallback: EveSsoCallbackHandle | null = null
  private activeRefresh: Promise<EveSsoSession | null> | null = null
  private sessionEpoch = 0

  constructor(options: EveSsoOptions) {
    validateOptions(options)
    this.clientId = options.clientId
    this.openExternalImpl = options.openExternal
    this.refreshTokenStore = options.refreshTokenStore
    this.fetchImpl = options.fetch ?? fetch
    this.callbackReceiver = options.callbackReceiver ?? new LoopbackCallbackReceiver()
    this.now = options.now ?? Date.now
    this.randomBytesImpl = options.randomBytes ?? randomBytes
  }

  login(options: { industry?: boolean } = {}): Promise<EveSsoSession> {
    if (this.activeLogin) {
      return Promise.reject(
        new EveSsoError('login_in_progress', 'EVE SSO sign-in is already in progress')
      )
    }

    const epoch = this.sessionEpoch
    const operation = this.performLogin(epoch, options.industry === true)
    this.activeLogin = operation
    void operation.finally(() => {
      if (this.activeLogin === operation) this.activeLogin = null
    }).catch(() => undefined)
    return operation
  }

  /** Immediately releases the loopback port and rejects the current browser login. */
  async cancelLogin(): Promise<void> {
    const operation = this.activeLogin
    if (!operation) return
    this.sessionEpoch += 1
    const callback = this.activeLoginCallback
    if (callback) {
      await callback.close()
      await operation.catch(() => undefined)
    }
  }

  /** Returns only a valid in-memory token, refreshing from encrypted storage when needed. */
  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && this.accessToken.session.expiresAt > this.now() + TOKEN_EXPIRY_MARGIN_MS) {
      return this.accessToken.value
    }

    const session = await this.refreshAccessToken()
    return session ? this.accessToken?.value ?? null : null
  }

  getSession(): EveSsoSession | null {
    return this.accessToken ? cloneSession(this.accessToken.session) : null
  }

  /** Restores a session by exchanging an encrypted refresh token for a new access token. */
  restoreSession(): Promise<EveSsoSession | null> {
    return this.refreshAccessToken()
  }

  refreshAccessToken(): Promise<EveSsoSession | null> {
    if (this.activeRefresh) return this.activeRefresh

    const epoch = this.sessionEpoch
    const operation = this.performRefresh(epoch)
    this.activeRefresh = operation
    void operation.finally(() => {
      if (this.activeRefresh === operation) this.activeRefresh = null
    }).catch(() => undefined)
    return operation
  }

  /** Local logout only. Public PKCE clients cannot safely authenticate token revocation. */
  async logout(): Promise<void> {
    await this.cancelLogin()
    this.sessionEpoch += 1
    this.accessToken = null
    await this.refreshTokenStore.clear()
  }

  clearLocalSession(): Promise<void> {
    return this.logout()
  }

  private async performLogin(epoch: number, industry = false): Promise<EveSsoSession> {
    const metadata = await this.getMetadata()
    this.assertEpoch(epoch)
    const state = this.randomOpaqueValue(32)
    const verifier = this.randomOpaqueValue(32)
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
    const authorizationUrl = buildAuthorizationUrl(metadata.authorizationEndpoint, {
      clientId: this.clientId,
      state,
      challenge,
      scopes: industry ? EVE_SSO_SUPPORTED_SCOPES : EVE_SSO_SCOPES
    })

    const callbackHandle = await this.callbackReceiver.begin({
      redirectUri: EVE_SSO_REDIRECT_URI,
      expectedState: state,
      timeoutMs: EVE_SSO_LOGIN_TIMEOUT_MS
    })
    this.activeLoginCallback = callbackHandle

    try {
      this.assertEpoch(epoch)
      try {
        await this.openExternalImpl(authorizationUrl)
      } catch {
        throw new EveSsoError('browser_open_failed', 'Could not open EVE SSO system browser')
      }

      let callback: EveSsoCallback
      try {
        callback = await callbackHandle.callback
      } catch (error) {
        if (error instanceof EveSsoError) throw error
        throw new EveSsoError('invalid_callback', 'Could not receive EVE SSO callback')
      }
      if (!constantTimeEqual(callback.state, state)) {
        throw new EveSsoError('state_mismatch', 'EVE SSO returned an invalid state')
      }
      if (!isSafeOpaqueValue(callback.code, 1, 4_096)) {
        throw new EveSsoError('invalid_callback', 'EVE SSO did not return an authorization code')
      }

      const response = await this.requestToken(metadata.tokenEndpoint, {
        grant_type: 'authorization_code',
        code: callback.code,
        client_id: this.clientId,
        code_verifier: verifier,
        redirect_uri: EVE_SSO_REDIRECT_URI
      })
      if (!response.refreshToken) {
        throw new EveSsoError('invalid_token', 'EVE SSO did not return a refresh token')
      }

      const validated = await this.validateAccessToken(response.accessToken, metadata)
      if (industry && !EVE_SSO_INDUSTRY_SCOPES.every(scope => validated.scopes.includes(scope))) {
        throw new EveSsoError('invalid_token', 'EVE SSO did not grant industry scopes; enable them in the registered Fly Safe OAuth application')
      }
      this.assertEpoch(epoch)
      await this.refreshTokenStore.save(response.refreshToken)
      this.assertEpoch(epoch)
      return this.rememberAccessToken(response, validated)
    } finally {
      await callbackHandle.close()
      if (this.activeLoginCallback === callbackHandle) this.activeLoginCallback = null
    }
  }

  private async performRefresh(epoch: number): Promise<EveSsoSession | null> {
    const refreshToken = await this.refreshTokenStore.load()
    if (refreshToken === null) {
      this.accessToken = null
      return null
    }
    assertRefreshToken(refreshToken)

    const metadata = await this.getMetadata()
    let response: TokenResponse
    try {
      response = await this.requestToken(metadata.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId
      })
    } catch (error) {
      if (error instanceof EveSsoError && [400, 401].includes(error.status ?? 0)) {
        this.accessToken = null
        await this.refreshTokenStore.clear()
      }
      throw error
    }

    const validated = await this.validateAccessToken(response.accessToken, metadata)
    this.assertEpoch(epoch)
    await this.refreshTokenStore.save(response.refreshToken ?? refreshToken)
    this.assertEpoch(epoch)
    return this.rememberAccessToken(response, validated)
  }

  private async getMetadata(): Promise<SsoMetadata> {
    if (this.metadataCache && this.metadataCache.expiresAt > this.now()) {
      return this.metadataCache.value
    }

    const response = await this.fetchJson(EVE_SSO_DISCOVERY_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error'
    })
    const metadata = parseMetadata(response)
    this.metadataCache = { value: metadata, expiresAt: this.now() + METADATA_CACHE_MS }
    return metadata
  }

  private async requestToken(
    tokenEndpoint: string,
    fields: Record<string, string>
  ): Promise<TokenResponse> {
    const body = new URLSearchParams(fields)
    const response = await this.fetchJson(
      tokenEndpoint,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body,
        redirect: 'error'
      },
      'token'
    )
    return parseTokenResponse(response)
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
    kind: 'metadata' | 'token' = 'metadata'
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
    timer.unref()

    let response: Response
    try {
      response = await this.fetchImpl(url, { ...init, signal: controller.signal })
    } catch {
      throw new EveSsoError('network_error', 'EVE SSO network unavailable')
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const code = kind === 'token' ? 'token_request_failed' : 'invalid_metadata'
      const label = kind === 'token' ? 'EVE SSO token request rejected' : 'EVE SSO discovery unavailable'
      throw new EveSsoError(code, `${label} (HTTP ${response.status})`, response.status)
    }

    try {
      return await response.json()
    } catch {
      const code = kind === 'token' ? 'invalid_token' : 'invalid_metadata'
      throw new EveSsoError(code, 'EVE SSO returned invalid JSON')
    }
  }

  private async validateAccessToken(
    accessToken: string,
    metadata: SsoMetadata
  ): Promise<ValidatedToken> {
    assertAccessToken(accessToken)

    if (!this.jwks || this.jwksUri !== metadata.jwksUri) {
      this.jwksUri = metadata.jwksUri
      this.jwks = createRemoteJWKSet(new URL(metadata.jwksUri), {
        timeoutDuration: NETWORK_TIMEOUT_MS,
        cooldownDuration: 30_000,
        cacheMaxAge: METADATA_CACHE_MS,
        [customFetch]: (url, options) => this.fetchImpl(url, options)
      })
    }

    let payload: JWTPayload
    try {
      const verified = await jwtVerify(accessToken, this.jwks, {
        algorithms: ['RS256', 'ES256'],
        issuer: acceptedIssuers(metadata.issuer),
        audience: 'EVE Online',
        clockTolerance: 5,
        currentDate: new Date(this.now()),
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'name', 'scp']
      })
      payload = verified.payload
    } catch {
      throw new EveSsoError('invalid_token', 'EVE SSO token signature or claims verification failed')
    }

    if (
      !Array.isArray(payload.aud) ||
      !payload.aud.includes('EVE Online') ||
      !payload.aud.includes(this.clientId)
    ) {
      throw new EveSsoError('invalid_token', 'EVE SSO token is for a different application')
    }
    if (payload.azp !== undefined && payload.azp !== this.clientId) {
      throw new EveSsoError('invalid_token', 'Invalid EVE SSO token authorized party')
    }

    const characterMatch = /^CHARACTER:EVE:([1-9]\d*)$/.exec(payload.sub ?? '')
    const characterId = characterMatch ? Number(characterMatch[1]) : Number.NaN
    if (!Number.isSafeInteger(characterId) || characterId <= 0) {
      throw new EveSsoError('invalid_token', 'Invalid character in EVE SSO token')
    }
    if (typeof payload.name !== 'string' || !isCleanText(payload.name, 1, 256)) {
      throw new EveSsoError('invalid_token', 'Invalid character name in EVE SSO token')
    }
    if (!Array.isArray(payload.scp) || !payload.scp.every((scope) => typeof scope === 'string')) {
      throw new EveSsoError('invalid_token', 'Invalid scopes in EVE SSO token')
    }

    const grantedScopes = new Set(payload.scp)
    if (!EVE_SSO_REQUIRED_SCOPES.every((scope) => grantedScopes.has(scope))) {
      throw new EveSsoError('invalid_token', 'EVE SSO token lacks required scopes')
    }
    if (!Number.isSafeInteger(payload.exp) || (payload.exp ?? 0) <= 0) {
      throw new EveSsoError('invalid_token', 'Invalid EVE SSO token expiry')
    }

    return {
      characterId,
      characterName: payload.name,
      scopes: EVE_SSO_SUPPORTED_SCOPES.filter((scope) => grantedScopes.has(scope)),
      jwtExpiresAt: (payload.exp as number) * 1_000
    }
  }

  private rememberAccessToken(response: TokenResponse, validated: ValidatedToken): EveSsoSession {
    const expiresAt = Math.min(
      validated.jwtExpiresAt,
      this.now() + response.expiresIn * 1_000
    )
    if (expiresAt <= this.now()) {
      throw new EveSsoError('invalid_token', 'EVE SSO returned an already expired token')
    }

    const session: EveSsoSession = {
      characterId: validated.characterId,
      characterName: validated.characterName,
      scopes: [...validated.scopes],
      expiresAt
    }
    this.accessToken = { value: response.accessToken, session }
    return cloneSession(session)
  }

  private randomOpaqueValue(size: number): string {
    const bytes = this.randomBytesImpl(size)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
      throw new EveSsoError('invalid_config', 'Random-data generator returned an invalid length')
    }
    return Buffer.from(bytes).toString('base64url')
  }

  private assertEpoch(epoch: number): void {
    if (epoch !== this.sessionEpoch) {
      throw new EveSsoError('login_cancelled', 'EVE SSO session was cleared')
    }
  }
}

function validateOptions(options: EveSsoOptions): void {
  if (!options || typeof options !== 'object') {
    throw new EveSsoError('invalid_config', 'EVE SSO configuration is required')
  }
  if (!/^[A-Za-z0-9._~-]{3,256}$/.test(options.clientId)) {
    throw new EveSsoError('invalid_config', 'Invalid EVE SSO client ID')
  }
  if (typeof options.openExternal !== 'function') {
    throw new EveSsoError('invalid_config', 'EVE SSO system browser is not set')
  }
  const store = options.refreshTokenStore
  if (
    !store ||
    typeof store.load !== 'function' ||
    typeof store.save !== 'function' ||
    typeof store.clear !== 'function'
  ) {
    throw new EveSsoError('invalid_config', 'EVE SSO secure storage is not set')
  }
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new EveSsoError('invalid_config', 'Invalid EVE SSO HTTP client')
  }
  if (options.callbackReceiver !== undefined && typeof options.callbackReceiver.begin !== 'function') {
    throw new EveSsoError('invalid_config', 'Invalid EVE SSO callback receiver')
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new EveSsoError('invalid_config', 'Invalid EVE SSO clock')
  }
  if (options.randomBytes !== undefined && typeof options.randomBytes !== 'function') {
    throw new EveSsoError('invalid_config', 'Invalid EVE SSO generator')
  }
}

function parseMetadata(value: unknown): SsoMetadata {
  if (!isRecord(value)) {
    throw new EveSsoError('invalid_metadata', 'Invalid EVE SSO discovery')
  }

  const issuer = requireHttpsUrl(value.issuer, 'issuer')
  if (!ACCEPTED_ISSUERS.includes(issuer as (typeof ACCEPTED_ISSUERS)[number])) {
    throw new EveSsoError('invalid_metadata', 'Unknown EVE SSO issuer')
  }
  const methods = value.code_challenge_methods_supported
  if (!Array.isArray(methods) || !methods.includes('S256')) {
    throw new EveSsoError('invalid_metadata', 'EVE SSO discovery does not support PKCE S256')
  }

  return {
    issuer,
    authorizationEndpoint: requireHttpsUrl(value.authorization_endpoint, 'authorization endpoint'),
    tokenEndpoint: requireHttpsUrl(value.token_endpoint, 'token endpoint'),
    jwksUri: requireHttpsUrl(value.jwks_uri, 'JWKS endpoint')
  }
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!isRecord(value)) {
    throw new EveSsoError('invalid_token', 'Invalid EVE SSO token response')
  }
  if (typeof value.access_token !== 'string') {
    throw new EveSsoError('invalid_token', 'EVE SSO access token is missing')
  }
  assertAccessToken(value.access_token)
  if (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer') {
    throw new EveSsoError('invalid_token', 'EVE SSO returned an unsupported token type')
  }
  if (!Number.isSafeInteger(value.expires_in) || (value.expires_in as number) <= 0) {
    throw new EveSsoError('invalid_token', 'EVE SSO returned an invalid token expiry')
  }

  let refreshToken: string | null = null
  if (value.refresh_token !== undefined) {
    if (typeof value.refresh_token !== 'string') {
      throw new EveSsoError('invalid_token', 'Invalid EVE SSO refresh token')
    }
    assertRefreshToken(value.refresh_token)
    refreshToken = value.refresh_token
  }

  return {
    accessToken: value.access_token,
    refreshToken,
    expiresIn: value.expires_in as number
  }
}

function requireHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new EveSsoError('invalid_metadata', `EVE SSO ${label} is missing`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new EveSsoError('invalid_metadata', `Invalid EVE SSO ${label}`)
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.origin === 'null'
  ) {
    throw new EveSsoError('invalid_metadata', `Insecure EVE SSO ${label}`)
  }
  return url.toString().replace(/\/$/, value.endsWith('/') ? '/' : '')
}

function acceptedIssuers(discoveryIssuer: string): string[] {
  return [...new Set([discoveryIssuer, ...ACCEPTED_ISSUERS])]
}

function buildAuthorizationUrl(
  endpoint: string,
  values: { clientId: string; state: string; challenge: string; scopes?: readonly EveSsoScope[] }
): string {
  const url = new URL(endpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: values.clientId,
    redirect_uri: EVE_SSO_REDIRECT_URI,
    scope: (values.scopes ?? EVE_SSO_SCOPES).join(' '),
    state: values.state,
    code_challenge: values.challenge,
    code_challenge_method: 'S256'
  }).toString()
  return url.toString()
}

function assertAccessToken(token: string): void {
  if (!isSafeOpaqueValue(token, 1, MAX_TOKEN_LENGTH)) {
    throw new EveSsoError('invalid_token', 'Invalid EVE SSO access token')
  }
}

function assertRefreshToken(token: string): void {
  if (!isSafeOpaqueValue(token, 1, MAX_TOKEN_LENGTH)) {
    throw new EveSsoError('invalid_token', 'Invalid EVE SSO refresh token')
  }
}

function isSafeOpaqueValue(value: string, minLength: number, maxLength: number): boolean {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isCleanText(value: string, minLength: number, maxLength: number): boolean {
  return (
    value.length >= minLength &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8')
  const rightBuffer = Buffer.from(right, 'utf8')
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function cloneSession(session: EveSsoSession): EveSsoSession {
  return { ...session, scopes: [...session.scopes] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function browserPage(message: string, success: boolean): string {
  const color = success ? '#75e6b1' : '#ff8a80'
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Fly Safe</title><style>body{margin:0;background:#080b12;color:#eef4ff;font:20px system-ui;display:grid;place-items:center;min-height:100vh}main{padding:32px;text-align:center}b{color:${color}}</style><main><b>${message}</b><p>Return to Fly Safe.</p></main></html>`
}

function listenOnFixedLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(LOOPBACK_PORT, LOOPBACK_HOST, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}
