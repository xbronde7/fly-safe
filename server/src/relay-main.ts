import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Server } from 'node:http'
import { isIP } from 'node:net'
import {
  EveJwtVerifier,
  FLY_SAFE_EVE_CLIENT_ID,
  type AccessTokenVerifier
} from './auth.js'
import {
  closeRelayHttpServer,
  createRelayHttpServer
} from './relay-http.js'
import { ZkillRelayService } from './zkill-relay.js'

const DEFAULT_ZKILL_BASE_URL = 'https://zkillboard.com'
const DEFAULT_R2Z2_BASE_URL = 'https://r2z2.zkillboard.com'

export interface RelayDaemonConfig {
  host: string
  port: number
  eveClientId: typeof FLY_SAFE_EVE_CLIENT_ID
  userAgent: string
  zkillBaseUrl: string
  r2z2BaseUrl: string
}

export interface RelayDaemonDependencies {
  auth?: AccessTokenVerifier | undefined
  relay?: Pick<ZkillRelayService, 'relay'> | undefined
  logger?: Pick<Console, 'info' | 'warn' | 'error'> | undefined
}

export function loadRelayDaemonConfig(
  environment: NodeJS.ProcessEnv = process.env
): RelayDaemonConfig {
  const configuredClientId = environment.EVE_CLIENT_ID ?? FLY_SAFE_EVE_CLIENT_ID
  if (configuredClientId !== FLY_SAFE_EVE_CLIENT_ID) {
    throw new Error(`EVE_CLIENT_ID must be the unified Fly Safe client ID ${FLY_SAFE_EVE_CLIENT_ID}`)
  }

  return {
    host: environment.HOST?.trim() || '127.0.0.1',
    port: integerEnvironment(environment.PORT, 8787, 1, 65_535, 'PORT'),
    eveClientId: FLY_SAFE_EVE_CLIENT_ID,
    userAgent: descriptiveUserAgent(environment.ZKILL_RELAY_USER_AGENT),
    zkillBaseUrl: upstreamBaseUrl(
      environment.ZKILL_BASE_URL ?? DEFAULT_ZKILL_BASE_URL,
      'ZKILL_BASE_URL'
    ),
    r2z2BaseUrl: upstreamBaseUrl(
      environment.R2Z2_BASE_URL ?? DEFAULT_R2Z2_BASE_URL,
      'R2Z2_BASE_URL'
    )
  }
}

export async function startRelayDaemon(
  config: RelayDaemonConfig,
  dependencies: RelayDaemonDependencies = {}
): Promise<Server> {
  const logger = dependencies.logger ?? console
  const auth = dependencies.auth ?? new EveJwtVerifier({ clientId: config.eveClientId })
  const relay = dependencies.relay ?? new ZkillRelayService({
    zkillBaseUrl: config.zkillBaseUrl,
    r2z2BaseUrl: config.r2z2BaseUrl,
    userAgent: config.userAgent
  })
  const server = createRelayHttpServer({ auth, relay, logger })

  await listen(server, config.port, config.host)
  logger.info({ event: 'relay_started', host: config.host, port: config.port })
  return server
}

async function main(): Promise<void> {
  const config = loadRelayDaemonConfig()
  const server = await startRelayDaemon(config)
  let shutdown: Promise<void> | null = null

  const stop = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shutdown !== null) return
    console.info({ event: 'relay_stopping', signal })
    shutdown = closeRelayHttpServer(server).then(() => {
      console.info({ event: 'relay_stopped', signal })
      process.exitCode = 0
    }).catch((error: unknown) => {
      console.error({ event: 'relay_shutdown_failed', signal, error })
      process.exitCode = 1
    })
  }

  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function descriptiveUserAgent(raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  if (value.length < 8 || value.length > 256 || !/^[\x20-\x7e]+$/u.test(value)) {
    throw new Error(
      'ZKILL_RELAY_USER_AGENT is required and must contain 8-256 printable ASCII characters'
    )
  }
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

function upstreamBaseUrl(value: string, name: string): string {
  const url = new URL(value)
  const loopback = isLoopbackHostname(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed only for loopback development)`)
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment`)
  }
  return url.toString().replace(/\/+$/u, '')
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIP(hostname) === 4 && hostname.split('.', 1)[0] === '127'
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && sameFile(fileURLToPath(import.meta.url), resolve(entrypoint))) {
  void main().catch((error: unknown) => {
    console.error({ event: 'relay_startup_failed', error })
    process.exitCode = 1
  })
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return left === right
  }
}
