export const ZKILL_RELAY_PATH = '/v1/relay/zkill'
export const R2Z2_RELAY_PATH = '/v1/relay/r2z2'
export const DEFAULT_ZKILL_DIRECT_TIMEOUT_MS = 2_000

export interface ZkillRelayDirectMappings {
  readonly zkill: string
  readonly r2z2: string
}

export const DEFAULT_ZKILL_RELAY_DIRECT_MAPPINGS: Readonly<ZkillRelayDirectMappings> =
  Object.freeze({
    zkill: 'https://zkillboard.com',
    r2z2: 'https://r2z2.zkillboard.com/ephemeral'
  })

export interface ZkillRelayFetchOptions {
  fetch: typeof fetch
  relayBaseUrl: string
  getAccessToken: () => Promise<string | null>
  directTimeoutMs?: number
  directMappings?: ZkillRelayDirectMappings
}

interface ResolvedMapping {
  relayPath: string
  directBaseUrl: URL
}

interface DirectAbortControl {
  signal: AbortSignal
  cleanup(): void
}

interface StreamingRequestInit extends RequestInit {
  duplex?: 'half'
}

/**
 * Tries the fixed public upstream for the two zKill relay routes, then uses the
 * authenticated relay when direct access is blocked. Every other URL passes through.
 */
export function createZkillRelayFetch(options: ZkillRelayFetchOptions): typeof fetch {
  if (typeof options.fetch !== 'function') {
    throw new TypeError('zKill relay fetch requires a base fetch function')
  }
  if (typeof options.getAccessToken !== 'function') {
    throw new TypeError('zKill relay fetch requires an access-token supplier')
  }

  const timeoutMs = options.directTimeoutMs ?? DEFAULT_ZKILL_DIRECT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('zKill direct timeout must be a positive finite number')
  }

  const relayBaseUrl = parseBaseUrl(options.relayBaseUrl, 'relay')
  const directMappings = options.directMappings ?? DEFAULT_ZKILL_RELAY_DIRECT_MAPPINGS
  const mappings: readonly ResolvedMapping[] = [
    {
      relayPath: joinUrlPaths(relayBaseUrl.pathname, ZKILL_RELAY_PATH),
      directBaseUrl: parseBaseUrl(directMappings.zkill, 'zKill direct')
    },
    {
      relayPath: joinUrlPaths(relayBaseUrl.pathname, R2Z2_RELAY_PATH),
      directBaseUrl: parseBaseUrl(directMappings.r2z2, 'R2Z2 direct')
    }
  ]

  const relayFetch: typeof fetch = async (input, init) => {
    const inputUrl = absoluteInputUrl(input)
    if (inputUrl === null || inputUrl.origin !== relayBaseUrl.origin) {
      return options.fetch(input, init)
    }

    const mapping = mappings.find((candidate) => (
      pathMatchesPrefix(inputUrl.pathname, candidate.relayPath)
    ))
    if (!mapping) return options.fetch(input, init)

    const callerRequest = new Request(input, init)
    const callerSignal = callerRequest.signal
    throwIfAborted(callerSignal)
    if (callerRequest.method.toUpperCase() !== 'GET') {
      return options.fetch(input, init)
    }

    const directUrl = mapDirectUrl(inputUrl, mapping)
    const directHeaders = new Headers(callerRequest.headers)
    directHeaders.delete('Authorization')

    let directResponse: Response | null = null
    let directError: unknown
    const directAbortControl = createDirectAbortControl(callerSignal, timeoutMs)
    try {
      const directRequest = copyRequest(
        callerRequest.clone(),
        directUrl,
        directHeaders,
        directAbortControl.signal
      )
      const response = await awaitWithSignal(
        Promise.resolve().then(() => options.fetch(directRequest)),
        directAbortControl.signal
      )
      if (isDirectFallbackStatus(response.status)) {
        directResponse = response
      } else {
        return await bufferResponse(response, directAbortControl.signal)
      }
    } catch (error) {
      if (callerSignal.aborted) throw abortReason(callerSignal)
      directError = error
    } finally {
      directAbortControl.cleanup()
    }

    const originalDirectOutcome = (): Response => {
      if (directResponse !== null) return directResponse
      throw directError
    }

    let accessToken: string | null
    try {
      accessToken = await awaitWithSignal(
        Promise.resolve().then(options.getAccessToken),
        callerSignal
      )
    } catch (error) {
      if (callerSignal.aborted) throw abortReason(callerSignal)
      return originalDirectOutcome()
    }

    const token = typeof accessToken === 'string' ? accessToken.trim() : ''
    if (token === '') return originalDirectOutcome()

    const relayHeaders = new Headers(callerRequest.headers)
    try {
      relayHeaders.set('Authorization', `Bearer ${token}`)
    } catch {
      return originalDirectOutcome()
    }

    throwIfAborted(callerSignal)
    const authenticatedRequest = copyRequest(
      callerRequest.clone(),
      inputUrl,
      relayHeaders,
      callerSignal
    )
    return awaitWithSignal(
      Promise.resolve().then(() => options.fetch(authenticatedRequest)),
      callerSignal
    )
  }

  return relayFetch
}

function absoluteInputUrl(input: Parameters<typeof fetch>[0]): URL | null {
  try {
    if (input instanceof Request) return new URL(input.url)
    return new URL(input instanceof URL ? input.href : input)
  } catch {
    return null
  }
}

function parseBaseUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`Invalid ${label} base URL`)
  }

  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(`Invalid ${label} base URL`)
  }
  url.pathname = normalizedBasePath(url.pathname)
  return url
}

function normalizedBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, '')
  return trimmed === '' ? '/' : trimmed
}

function joinUrlPaths(basePath: string, childPath: string): string {
  const base = basePath === '/' ? '' : basePath.replace(/\/+$/u, '')
  return `${base}/${childPath.replace(/^\/+|\/+$/gu, '')}`
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function mapDirectUrl(inputUrl: URL, mapping: ResolvedMapping): URL {
  const suffix = inputUrl.pathname.slice(mapping.relayPath.length)
  const directUrl = new URL(mapping.directBaseUrl.toString())
  const basePath = directUrl.pathname === '/'
    ? ''
    : directUrl.pathname.replace(/\/+$/u, '')
  directUrl.pathname = `${basePath}${suffix}` || '/'
  directUrl.search = inputUrl.search
  directUrl.hash = ''
  return directUrl
}

function copyRequest(
  source: Request,
  url: URL,
  headers: Headers,
  signal: AbortSignal
): Request {
  const method = source.method.toUpperCase()
  const body = method === 'GET' || method === 'HEAD' ? undefined : source.body
  const init: StreamingRequestInit = {
    method: source.method,
    headers,
    body,
    cache: source.cache,
    credentials: source.credentials,
    integrity: source.integrity,
    keepalive: source.keepalive,
    mode: source.mode,
    redirect: source.redirect,
    referrer: source.referrer,
    referrerPolicy: source.referrerPolicy,
    signal
  }
  if (body !== undefined && body !== null) init.duplex = 'half'
  return new Request(url, init)
}

async function bufferResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const body = response.body === null
    ? null
    : await awaitWithSignal(response.arrayBuffer(), signal)
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  })
}

function isDirectFallbackStatus(status: number): boolean {
  return status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
}

function createDirectAbortControl(
  callerSignal: AbortSignal,
  timeoutMs: number
): DirectAbortControl {
  const controller = new AbortController()
  const forwardCallerAbort = (): void => controller.abort(abortReason(callerSignal))
  callerSignal.addEventListener('abort', forwardCallerAbort, { once: true })
  if (callerSignal.aborted) forwardCallerAbort()

  const timeout = setTimeout(() => {
    controller.abort(new DOMException('zKill direct request timed out', 'TimeoutError'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      callerSignal.removeEventListener('abort', forwardCallerAbort)
    }
  }
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))

  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = (): void => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}
