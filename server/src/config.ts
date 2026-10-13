import { resolve } from 'node:path'
import { FLY_SAFE_EVE_CLIENT_ID } from './auth.js'
import { assertCharacterId } from './domain.js'

export interface ServerConfig {
  host: string
  port: number
  databasePath: string
  eveClientId: typeof FLY_SAFE_EVE_CLIENT_ID
  cashierCharacterId: string
  cashierRefreshToken: string
  cashierRefreshTokenPath: string | undefined
  eveClientSecret: string | undefined
  entitlementPrivateKeyPath: string
  entitlementKeyId: string
  adminToken: string
  publicBaseUrl: string | undefined
  esiUserAgent: string
  esiCompatibilityDate: string
  zkillBaseUrl: string
  r2z2BaseUrl: string
  zkillRelayUserAgent: string
  walletPollIntervalSeconds: number
  renewalLeadSeconds: number
  entitlementGraceSeconds: number
  maxDevicesPerCharacter: number
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const configuredClientId = environment.EVE_CLIENT_ID ?? FLY_SAFE_EVE_CLIENT_ID
  if (configuredClientId !== FLY_SAFE_EVE_CLIENT_ID) {
    throw new Error(`EVE_CLIENT_ID must be the unified Fly Safe client ID ${FLY_SAFE_EVE_CLIENT_ID}`)
  }
  const publicBaseUrl = environment.PUBLIC_BASE_URL
    ? requireUrl(environment.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL')
    : undefined
  const esiUserAgent = minimumLength(required(environment, 'ESI_USER_AGENT'), 8, 'ESI_USER_AGENT')
  return {
    host: environment.HOST?.trim() || '127.0.0.1',
    port: integerEnvironment(environment.PORT, 8787, 1, 65_535, 'PORT'),
    databasePath: resolve(environment.DATABASE_PATH ?? './data/fly-safe.sqlite'),
    eveClientId: FLY_SAFE_EVE_CLIENT_ID,
    cashierCharacterId: assertCharacterId(required(environment, 'CASHIER_CHARACTER_ID')),
    cashierRefreshToken: required(environment, 'CASHIER_REFRESH_TOKEN'),
    cashierRefreshTokenPath: environment.CASHIER_REFRESH_TOKEN_PATH
      ? resolve(environment.CASHIER_REFRESH_TOKEN_PATH)
      : undefined,
    eveClientSecret: environment.EVE_CLIENT_SECRET?.trim() || undefined,
    entitlementPrivateKeyPath: resolve(required(environment, 'ENTITLEMENT_PRIVATE_KEY_PATH')),
    entitlementKeyId: required(environment, 'ENTITLEMENT_KEY_ID'),
    adminToken: minimumLength(required(environment, 'ADMIN_TOKEN'), 32, 'ADMIN_TOKEN'),
    publicBaseUrl,
    esiUserAgent,
    esiCompatibilityDate: environment.ESI_COMPATIBILITY_DATE ?? '2020-01-01',
    zkillBaseUrl: requireUpstreamUrl(
      environment.ZKILL_BASE_URL ?? 'https://zkillboard.com',
      'ZKILL_BASE_URL'
    ),
    r2z2BaseUrl: requireUpstreamUrl(
      environment.R2Z2_BASE_URL ?? 'https://r2z2.zkillboard.com',
      'R2Z2_BASE_URL'
    ),
    zkillRelayUserAgent: minimumLength(
      environment.ZKILL_RELAY_USER_AGENT?.trim() || `${esiUserAgent} zKill relay`,
      8,
      'ZKILL_RELAY_USER_AGENT'
    ),
    walletPollIntervalSeconds: integerEnvironment(
      environment.WALLET_POLL_INTERVAL_SECONDS,
      60,
      15,
      3_600,
      'WALLET_POLL_INTERVAL_SECONDS'
    ),
    renewalLeadSeconds: integerEnvironment(
      environment.RENEWAL_LEAD_SECONDS,
      86_400,
      0,
      2_592_000,
      'RENEWAL_LEAD_SECONDS'
    ),
    entitlementGraceSeconds: integerEnvironment(
      environment.ENTITLEMENT_GRACE_SECONDS,
      172_800,
      0,
      604_800,
      'ENTITLEMENT_GRACE_SECONDS'
    ),
    maxDevicesPerCharacter: integerEnvironment(
      environment.MAX_DEVICES_PER_CHARACTER,
      3,
      1,
      20,
      'MAX_DEVICES_PER_CHARACTER'
    )
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integerEnvironment(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function minimumLength(value: string, length: number, name: string): string {
  if (value.length < length) throw new Error(`${name} must contain at least ${length} characters`)
  return value
}

function requireUrl(value: string, name: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an HTTP(S) URL`)
  }
  return url.toString()
}

function requireUpstreamUrl(value: string, name: string): string {
  const url = new URL(value)
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' ||
    url.hostname.startsWith('127.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed only for loopback development)`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, query, or fragment`)
  }
  return url.toString().replace(/\/+$/u, '')
}
