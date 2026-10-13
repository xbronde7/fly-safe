import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

declare const __FLY_SAFE_COMBAT_RELAY_URL__: string | undefined

export const COMBAT_RELAY_CONFIG_FILENAME = 'combat-relay.json'

const MAX_CONFIG_BYTES = 4_096
const MAX_URL_LENGTH = 2_048

export interface CombatRelayConfigOptions {
  userDataDirectory: string
  resourcesDirectory?: string | null
  environment?: NodeJS.ProcessEnv
  compiledUrl?: string
  /** Used only when no dedicated combat-relay endpoint is configured. */
  fallbackUrl?: string | null
}

/**
 * Resolves the endpoint used only for public combat-data relay requests.
 * Dedicated release and per-install settings take precedence over the
 * subscription-backend fallback so billing never has to point at a relay-only
 * service.
 */
export function resolveCombatRelayUrl(options: CombatRelayConfigOptions): string {
  const compiledUrl = options.compiledUrl ?? getCompiledCombatRelayUrl()
  if (compiledUrl.trim()) return validateCombatRelayUrl(compiledUrl)

  const environment = options.environment ?? process.env
  const runtimeUrl = environment['FLY_SAFE_COMBAT_RELAY_URL']
  if (runtimeUrl?.trim()) return validateCombatRelayUrl(runtimeUrl)

  const userConfigPath = join(options.userDataDirectory, COMBAT_RELAY_CONFIG_FILENAME)
  const userConfiguredUrl = readConfigFile(userConfigPath)
  if (userConfiguredUrl !== null) return validateCombatRelayUrl(userConfiguredUrl)

  if (options.resourcesDirectory) {
    const packagedConfigPath = join(
      options.resourcesDirectory,
      COMBAT_RELAY_CONFIG_FILENAME
    )
    const packagedUrl = readConfigFile(packagedConfigPath)
    if (packagedUrl !== null) return validateCombatRelayUrl(packagedUrl)
  }

  if (options.fallbackUrl?.trim()) return validateCombatRelayUrl(options.fallbackUrl)
  return ''
}

export function validateCombatRelayUrl(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !value.trim()) {
    throw new Error('Invalid combat-relay URL')
  }

  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Invalid combat-relay URL')
  }

  const loopback = isLoopbackHostname(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Combat relay must use HTTPS (HTTP is allowed only locally)')
  }
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || url.href.includes('?')
    || url.href.includes('#')
  ) {
    throw new Error('Combat-relay URL must not contain credentials, query, or fragment')
  }

  return url.toString().replace(/\/+$/u, '')
}

/** Safe when the build-time define is absent, including in tests and development. */
export function getCompiledCombatRelayUrl(): string {
  return typeof __FLY_SAFE_COMBAT_RELAY_URL__ === 'string'
    ? __FLY_SAFE_COMBAT_RELAY_URL__
    : ''
}

function readConfigFile(path: string): string | null {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw new Error('Could not inspect combat-relay configuration file')
  }

  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.size < 2
    || stat.size > MAX_CONFIG_BYTES
  ) {
    throw new Error(
      'Combat-relay configuration must be a regular file no larger than 4096 bytes'
    )
  }

  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    throw new Error('Could not read combat-relay configuration file')
  }

  if (Buffer.byteLength(source, 'utf8') > MAX_CONFIG_BYTES) {
    throw new Error('Combat-relay configuration file exceeds 4096 bytes')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error('Combat-relay configuration file contains invalid JSON')
  }

  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.baseUrl !== 'string') {
    throw new Error('Combat-relay configuration file has an invalid schema')
  }
  const keys = Object.keys(parsed)
  if (keys.some((key) => key !== 'version' && key !== 'baseUrl')) {
    throw new Error('Combat-relay configuration file contains unknown fields')
  }
  return parsed.baseUrl
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]') return true

  const octets = normalized.split('.')
  return octets.length === 4 && octets[0] === '127' && octets.every((part) => (
    /^\d{1,3}$/u.test(part) && Number(part) <= 255
  ))
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
