import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

declare const __FLY_SAFE_ENTITLEMENT_API_URL__: string | undefined

export const SUBSCRIPTION_BACKEND_CONFIG_FILENAME = 'subscription-backend.json'

const MAX_CONFIG_BYTES = 4_096
const MAX_URL_LENGTH = 2_048

export interface SubscriptionBackendConfigOptions {
  userDataDirectory: string
  resourcesDirectory?: string | null
  environment?: NodeJS.ProcessEnv
  compiledUrl?: string
}

/**
 * Resolves the one backend used by billing, entitlements, and shared workspaces.
 * A URL embedded into a release wins; otherwise operators can configure an
 * already-installed build without rebuilding it.
 */
export function resolveSubscriptionBackendUrl(
  options: SubscriptionBackendConfigOptions
): string {
  const compiledUrl = options.compiledUrl ?? getCompiledSubscriptionBackendUrl()
  if (compiledUrl.trim()) return validateSubscriptionBackendUrl(compiledUrl)

  const environment = options.environment ?? process.env
  const runtimeUrl = environment['FLY_SAFE_ENTITLEMENT_API_URL']
  if (runtimeUrl?.trim()) return validateSubscriptionBackendUrl(runtimeUrl)

  const userConfigPath = join(
    options.userDataDirectory,
    SUBSCRIPTION_BACKEND_CONFIG_FILENAME
  )
  const userConfiguredUrl = readConfigFile(userConfigPath)
  if (userConfiguredUrl !== null) return validateSubscriptionBackendUrl(userConfiguredUrl)

  if (options.resourcesDirectory) {
    const packagedConfigPath = join(
      options.resourcesDirectory,
      SUBSCRIPTION_BACKEND_CONFIG_FILENAME
    )
    const packagedUrl = readConfigFile(packagedConfigPath)
    if (packagedUrl !== null) return validateSubscriptionBackendUrl(packagedUrl)
  }

  return ''
}

export function validateSubscriptionBackendUrl(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !value.trim()) {
    throw new Error('Invalid subscription-backend URL')
  }

  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Invalid subscription-backend URL')
  }

  const loopback = isLoopbackHostname(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Subscription backend must use HTTPS (HTTP is allowed only locally)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Subscription-backend URL must not contain credentials, query, or fragment')
  }

  return url.toString().replace(/\/$/u, '')
}

function getCompiledSubscriptionBackendUrl(): string {
  return typeof __FLY_SAFE_ENTITLEMENT_API_URL__ === 'string'
    ? __FLY_SAFE_ENTITLEMENT_API_URL__
    : ''
}

function readConfigFile(path: string): string | null {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw new Error('Could not inspect subscription-backend configuration')
  }

  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_CONFIG_BYTES) {
    throw new Error('Subscription-backend configuration file has an invalid format')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('Subscription-backend configuration file contains invalid JSON')
  }

  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.baseUrl !== 'string') {
    throw new Error('Subscription-backend configuration file has an invalid schema')
  }
  const keys = Object.keys(parsed)
  if (keys.some((key) => key !== 'version' && key !== 'baseUrl')) {
    throw new Error('Subscription-backend configuration file contains unknown fields')
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
