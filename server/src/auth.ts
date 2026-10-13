import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey
} from 'jose'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ServiceError, type Principal } from './domain.js'

export const FLY_SAFE_EVE_CLIENT_ID = '722024be688548e4b022064636ecd652'
export const EVE_SSO_DISCOVERY_URL =
  'https://login.eveonline.com/.well-known/oauth-authorization-server'
const ACCEPTED_ISSUERS = [
  'https://login.eveonline.com',
  'https://login.eveonline.com/',
  'login.eveonline.com'
] as const

export interface AccessTokenVerifier {
  verify(accessToken: string): Promise<Principal>
}

interface SsoMetadata {
  issuer: string
  jwksUri: string
  tokenEndpoint: string
}

export interface EveJwtVerifierOptions {
  clientId?: string
  fetch?: typeof fetch
  discoveryUrl?: string
  now?: () => number
  /** Test/offline injection. Production should use discovery + remote JWKS. */
  keyResolver?: JWTVerifyGetKey
}

export class EveJwtVerifier implements AccessTokenVerifier {
  private readonly clientId: string
  private readonly fetchImpl: typeof fetch
  private readonly discoveryUrl: string
  private readonly now: () => number
  private readonly injectedKeyResolver: JWTVerifyGetKey | undefined
  private metadataCache: { value: SsoMetadata; expiresAt: number } | null = null
  private remoteJwks: ReturnType<typeof createRemoteJWKSet> | null = null
  private remoteJwksUri: string | null = null

  constructor(options: EveJwtVerifierOptions = {}) {
    this.clientId = options.clientId ?? FLY_SAFE_EVE_CLIENT_ID
    if (!/^[A-Za-z0-9._~-]{3,256}$/u.test(this.clientId)) throw new Error('Invalid EVE client ID')
    this.fetchImpl = options.fetch ?? fetch
    this.discoveryUrl = options.discoveryUrl ?? EVE_SSO_DISCOVERY_URL
    this.now = options.now ?? Date.now
    this.injectedKeyResolver = options.keyResolver
  }

  async verify(accessToken: string): Promise<Principal> {
    if (!isOpaqueToken(accessToken)) throw unauthorized('Malformed EVE access token')
    const metadata = this.injectedKeyResolver
      ? { issuer: ACCEPTED_ISSUERS[0], jwksUri: '', tokenEndpoint: '' }
      : await this.getMetadata()
    const keyResolver = this.injectedKeyResolver ?? this.getRemoteJwks(metadata.jwksUri)

    let payload: JWTPayload
    try {
      const verified = await jwtVerify(accessToken, keyResolver, {
        algorithms: ['RS256', 'ES256'],
        issuer: acceptedIssuers(metadata.issuer),
        audience: 'EVE Online',
        clockTolerance: 5,
        currentDate: new Date(this.now()),
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'name', 'scp']
      })
      payload = verified.payload
    } catch {
      throw unauthorized('EVE access token verification failed')
    }
    return principalFromClaims(payload, this.clientId)
  }

  private async getMetadata(): Promise<SsoMetadata> {
    if (this.metadataCache && this.metadataCache.expiresAt > this.now()) {
      return this.metadataCache.value
    }
    const response = await fetchWithTimeout(this.fetchImpl, this.discoveryUrl, {
      headers: { Accept: 'application/json' },
      redirect: 'error'
    })
    if (!response.ok) throw unauthorized(`EVE SSO discovery failed (${response.status})`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw unauthorized('EVE SSO discovery returned invalid JSON')
    }
    const metadata = parseMetadata(body)
    this.metadataCache = { value: metadata, expiresAt: this.now() + 300_000 }
    return metadata
  }

  private getRemoteJwks(uri: string): ReturnType<typeof createRemoteJWKSet> {
    if (!this.remoteJwks || this.remoteJwksUri !== uri) {
      this.remoteJwksUri = uri
      this.remoteJwks = createRemoteJWKSet(new URL(uri), {
        timeoutDuration: 15_000,
        cooldownDuration: 30_000,
        cacheMaxAge: 300_000,
        [customFetch]: (url, options) => this.fetchImpl(url, options)
      })
    }
    return this.remoteJwks
  }
}

export function principalFromClaims(payload: JWTPayload, clientId: string): Principal {
  if (
    !Array.isArray(payload.aud) ||
    !payload.aud.includes('EVE Online') ||
    !payload.aud.includes(clientId)
  ) {
    throw unauthorized('EVE token audience does not include Fly Safe')
  }
  if (payload.azp !== undefined && payload.azp !== clientId) {
    throw unauthorized('EVE token authorized party is not Fly Safe')
  }
  const subject = /^CHARACTER:EVE:([1-9]\d*)$/u.exec(payload.sub ?? '')
  if (!subject) throw unauthorized('EVE token character subject is invalid')
  if (typeof payload.name !== 'string' || !isCleanText(payload.name, 1, 256)) {
    throw unauthorized('EVE token character name is invalid')
  }
  if (!Array.isArray(payload.scp) || !payload.scp.every((scope) => typeof scope === 'string')) {
    throw unauthorized('EVE token scopes are invalid')
  }
  return {
    characterId: subject[1]!,
    characterName: payload.name,
    scopes: [...payload.scp]
  }
}

export interface CashierAccessTokenProvider {
  getAccessToken(): Promise<string>
}

export interface RefreshTokenStore {
  load(): Promise<string>
  save(token: string): Promise<void>
}

export interface EveRefreshTokenProviderOptions {
  clientId?: string
  clientSecret?: string | undefined
  refreshToken: string
  refreshTokenStore?: RefreshTokenStore | undefined
  fetch?: typeof fetch
  discoveryUrl?: string
  now?: () => number
}

/** Refreshes the cashier token in memory; the source refresh token remains an external secret. */
export class EveRefreshTokenProvider implements CashierAccessTokenProvider {
  private readonly clientId: string
  private readonly clientSecret: string | undefined
  private refreshToken: string
  private readonly refreshTokenStore: RefreshTokenStore | undefined
  private readonly fetchImpl: typeof fetch
  private readonly discoveryUrl: string
  private readonly now: () => number
  private cached: { token: string; expiresAt: number } | null = null
  private inFlight: Promise<string> | null = null

  constructor(options: EveRefreshTokenProviderOptions) {
    this.clientId = options.clientId ?? FLY_SAFE_EVE_CLIENT_ID
    this.clientSecret = options.clientSecret || undefined
    this.refreshToken = options.refreshToken
    this.refreshTokenStore = options.refreshTokenStore
    this.fetchImpl = options.fetch ?? fetch
    this.discoveryUrl = options.discoveryUrl ?? EVE_SSO_DISCOVERY_URL
    this.now = options.now ?? Date.now
    if (!isOpaqueToken(this.refreshToken)) throw new Error('Invalid cashier refresh token')
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now() + 30_000) return this.cached.token
    if (this.inFlight) return this.inFlight
    this.inFlight = this.refresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async refresh(): Promise<string> {
    if (this.refreshTokenStore) this.refreshToken = await this.refreshTokenStore.load()
    const metadataResponse = await fetchWithTimeout(this.fetchImpl, this.discoveryUrl, {
      headers: { Accept: 'application/json' },
      redirect: 'error'
    })
    if (!metadataResponse.ok) throw new Error(`EVE SSO discovery failed (${metadataResponse.status})`)
    const metadata = parseMetadata(await metadataResponse.json())
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId
    })
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    }
    if (this.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`
    }
    const response = await fetchWithTimeout(this.fetchImpl, metadata.tokenEndpoint, {
      method: 'POST',
      headers,
      body,
      redirect: 'error'
    })
    if (!response.ok) throw new Error(`Cashier token refresh failed (${response.status})`)
    const value = await response.json() as Record<string, unknown>
    if (typeof value.access_token !== 'string' || !isOpaqueToken(value.access_token)) {
      throw new Error('Cashier token response is invalid')
    }
    if (!Number.isSafeInteger(value.expires_in) || (value.expires_in as number) <= 0) {
      throw new Error('Cashier token expiry is invalid')
    }
    if (value.refresh_token !== undefined) {
      if (typeof value.refresh_token !== 'string' || !isOpaqueToken(value.refresh_token)) {
        throw new Error('Rotated cashier refresh token is invalid')
      }
      this.refreshToken = value.refresh_token
      await this.refreshTokenStore?.save(value.refresh_token)
    }
    this.cached = {
      token: value.access_token,
      expiresAt: this.now() + (value.expires_in as number) * 1_000
    }
    return value.access_token
  }
}

/** Optional mode-0600 persistence for refresh-token rotation on a single host. */
export class FileRefreshTokenStore implements RefreshTokenStore {
  readonly path: string
  private readonly fallback: string

  constructor(path: string, fallback: string) {
    this.path = resolve(path)
    this.fallback = fallback
  }

  async load(): Promise<string> {
    try {
      const token = (await readFile(this.path, 'utf8')).trim()
      if (!isOpaqueToken(token)) throw new Error('Persisted cashier refresh token is invalid')
      return token
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return this.fallback
      throw error
    }
  }

  async save(token: string): Promise<void> {
    if (!isOpaqueToken(token)) throw new Error('Cashier refresh token is invalid')
    const directory = dirname(this.path)
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporary, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
      await chmod(this.path, 0o600)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
}

function parseMetadata(value: unknown): SsoMetadata {
  if (!isRecord(value)) throw new Error('Invalid EVE SSO discovery document')
  const issuer = requireHttpsOrKnownIssuer(value.issuer)
  if (!ACCEPTED_ISSUERS.includes(issuer as (typeof ACCEPTED_ISSUERS)[number])) {
    throw new Error('Untrusted EVE SSO issuer')
  }
  return {
    issuer,
    jwksUri: requireHttpsUrl(value.jwks_uri, 'jwks_uri'),
    tokenEndpoint: requireHttpsUrl(value.token_endpoint, 'token_endpoint')
  }
}

function requireHttpsOrKnownIssuer(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Missing EVE SSO issuer')
  return value
}

function requireHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Missing EVE SSO ${field}`)
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error(`EVE SSO ${field} must use HTTPS`)
  return url.toString()
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  timer.unref()
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function acceptedIssuers(discoveryIssuer: string): string[] {
  return [...new Set([discoveryIssuer, ...ACCEPTED_ISSUERS])]
}

function unauthorized(message: string): ServiceError {
  return new ServiceError('unauthorized', message, 401)
}

function isOpaqueToken(value: string): boolean {
  return typeof value === 'string' && value.length >= 16 && value.length <= 16_384 && !/\s/u.test(value)
}

function isCleanText(value: string, minimum: number, maximum: number): boolean {
  return value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
