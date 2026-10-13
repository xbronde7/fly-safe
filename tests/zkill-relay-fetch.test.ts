import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createZkillRelayFetch,
  DEFAULT_ZKILL_DIRECT_TIMEOUT_MS,
  DEFAULT_ZKILL_RELAY_DIRECT_MAPPINGS,
  R2Z2_RELAY_PATH,
  ZKILL_RELAY_PATH
} from '../src/main/zkill-relay-fetch'

const RELAY_BASE_URL = 'https://relay.test/backend'
const DIRECT_MAPPINGS = {
  zkill: 'https://zkill-direct.test',
  r2z2: 'https://r2z2-direct.test/ephemeral'
} as const

afterEach(() => {
  vi.useRealTimers()
})

describe('createZkillRelayFetch', () => {
  it('exports fixed production routes, upstreams, and direct timeout', () => {
    expect(ZKILL_RELAY_PATH).toBe('/v1/relay/zkill')
    expect(R2Z2_RELAY_PATH).toBe('/v1/relay/r2z2')
    expect(DEFAULT_ZKILL_DIRECT_TIMEOUT_MS).toBe(2_000)
    expect(DEFAULT_ZKILL_RELAY_DIRECT_MAPPINGS).toEqual({
      zkill: 'https://zkillboard.com',
      r2z2: 'https://r2z2.zkillboard.com/ephemeral'
    })
  })

  it('uses direct zKill first, strips Authorization, and skips token lookup on success', async () => {
    const baseFetch = vi.fn<typeof fetch>(async (input) => {
      const request = requestFrom(input)
      expect(request.url).toBe(
        'https://zkill-direct.test/api/stats/characterID/42/kills/?compact=1'
      )
      expect(request.headers.get('Authorization')).toBeNull()
      expect(request.headers.get('Accept')).toBe('application/json')
      return new Response(JSON.stringify({ shipsDestroyed: 4 }), {
        status: 202,
        statusText: 'Accepted by direct',
        headers: {
          'Content-Type': 'application/json',
          'X-Direct-Response': 'preserved'
        }
      })
    })
    const getAccessToken = vi.fn(async () => 'eve-access-token')
    const relayFetch = createTestFetch(baseFetch, getAccessToken)

    const response = await relayFetch(
      `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/42/kills/?compact=1`,
      { headers: { Accept: 'application/json', Authorization: 'caller-value' } }
    )

    expect(response.status).toBe(202)
    expect(response.statusText).toBe('Accepted by direct')
    expect(response.headers.get('X-Direct-Response')).toBe('preserved')
    await expect(response.json()).resolves.toEqual({ shipsDestroyed: 4 })
    expect(getAccessToken).not.toHaveBeenCalled()
    expect(baseFetch).toHaveBeenCalledOnce()
  })

  it.each([401, 403, 408, 425, 429, 500, 503, 599])(
    'falls back from direct zKill status %s to authenticated relay',
    async (status) => {
      const requests: Request[] = []
      const baseFetch = vi.fn<typeof fetch>(async (input) => {
        const request = requestFrom(input)
        requests.push(request)
        return requests.length === 1
          ? jsonResponse({ error: 'direct failed' }, status)
          : jsonResponse({ relayed: true })
      })
      const relayFetch = createTestFetch(baseFetch)

      const response = await relayFetch(
        `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/kills/characterID/77/page/2/?pageSize=200`,
        { headers: { Authorization: 'caller-secret', Accept: 'application/json' } }
      )

      expect(response.status).toBe(200)
      expect(requests.map((request) => request.url)).toEqual([
        'https://zkill-direct.test/api/kills/characterID/77/page/2/?pageSize=200',
        'https://relay.test/backend/v1/relay/zkill/api/kills/characterID/77/page/2/?pageSize=200'
      ])
      expect(requests[0]?.headers.get('Authorization')).toBeNull()
      expect(requests[1]?.headers.get('Authorization')).toBe('Bearer eve-access-token')
      expect(requests[1]?.headers.get('Accept')).toBe('application/json')
    }
  )

  it('falls back from an R2Z2 direct network error to its relay route', async () => {
    const requests: Request[] = []
    const baseFetch = vi.fn<typeof fetch>(async (input) => {
      const request = requestFrom(input)
      requests.push(request)
      if (requests.length === 1) throw new TypeError('network unavailable')
      return jsonResponse({ sequence: 123 })
    })
    const relayFetch = createTestFetch(baseFetch)

    const response = await relayFetch(
      `${RELAY_BASE_URL}${R2Z2_RELAY_PATH}/sequence.json?fresh=1`
    )

    expect(response.status).toBe(200)
    expect(requests.map((request) => request.url)).toEqual([
      'https://r2z2-direct.test/ephemeral/sequence.json?fresh=1',
      'https://relay.test/backend/v1/relay/r2z2/sequence.json?fresh=1'
    ])
    expect(requests[0]?.headers.get('Authorization')).toBeNull()
    expect(requests[1]?.headers.get('Authorization')).toBe('Bearer eve-access-token')
  })

  it.each([200, 400, 404])('returns direct status %s without relay fallback', async (status) => {
    const baseFetch = vi.fn<typeof fetch>(async () => jsonResponse({}, status))
    const getAccessToken = vi.fn(async () => 'eve-access-token')
    const relayFetch = createTestFetch(baseFetch, getAccessToken)

    const response = await relayFetch(`${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/test/`)

    expect(response.status).toBe(status)
    expect(baseFetch).toHaveBeenCalledOnce()
    expect(getAccessToken).not.toHaveBeenCalled()
  })

  it('never redirects non-GET relay URLs to a public upstream', async () => {
    const url = `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/42/kills/`
    const init: RequestInit = { method: 'POST', body: '{}' }
    const baseFetch = vi.fn<typeof fetch>(async () => jsonResponse({}, 405))
    const getAccessToken = vi.fn(async () => 'eve-access-token')
    const relayFetch = createTestFetch(baseFetch, getAccessToken)

    const response = await relayFetch(url, init)

    expect(response.status).toBe(405)
    expect(baseFetch).toHaveBeenCalledWith(url, init)
    expect(getAccessToken).not.toHaveBeenCalled()
  })

  it('enforces direct timeout even when base fetch ignores abort, then tries relay', async () => {
    vi.useFakeTimers()
    const requests: Request[] = []
    const baseFetch = vi.fn<typeof fetch>(async (input) => {
      const request = requestFrom(input)
      requests.push(request)
      if (requests.length === 1) return new Promise<Response>(() => undefined)
      return jsonResponse({ relayed: true })
    })
    const relayFetch = createTestFetch(baseFetch, undefined, 25)

    const responsePromise = relayFetch(
      `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/88/kills/`
    )
    await vi.advanceTimersByTimeAsync(25)

    await expect(responsePromise).resolves.toMatchObject({ status: 200 })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe('https://zkill-direct.test/api/stats/characterID/88/kills/')
    expect(requests[0]?.signal.aborted).toBe(true)
    expect(requests[1]?.url).toBe(
      'https://relay.test/backend/v1/relay/zkill/api/stats/characterID/88/kills/'
    )
    expect(requests[1]?.signal.aborted).toBe(false)
  })

  it('falls back when direct headers arrive but its response body exceeds the timeout', async () => {
    vi.useFakeTimers()
    const requests: Request[] = []
    const baseFetch = vi.fn<typeof fetch>(async (input) => {
      const request = requestFrom(input)
      requests.push(request)
      if (requests.length === 1) {
        return new Response(stalledBody(), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return jsonResponse({ relayed: true })
    })
    const relayFetch = createTestFetch(baseFetch, undefined, 25)

    const responsePromise = relayFetch(
      `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/90/kills/`
    )
    await vi.advanceTimersByTimeAsync(25)

    const response = await responsePromise
    await expect(response.json()).resolves.toEqual({ relayed: true })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.signal.aborted).toBe(true)
    expect(requests[1]?.url).toBe(
      'https://relay.test/backend/v1/relay/zkill/api/stats/characterID/90/kills/'
    )
    expect(requests[1]?.headers.get('Authorization')).toBe('Bearer eve-access-token')
  })

  it('throws original direct timeout when no relay token exists', async () => {
    vi.useFakeTimers()
    const baseFetch = vi.fn<typeof fetch>(async () => new Promise<Response>(() => undefined))
    const getAccessToken = vi.fn(async () => null)
    const relayFetch = createTestFetch(baseFetch, getAccessToken, 25)

    const responsePromise = relayFetch(
      `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/89/kills/`
    )
    const rejection = expect(responsePromise).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(25)

    await rejection
    expect(baseFetch).toHaveBeenCalledOnce()
    expect(getAccessToken).toHaveBeenCalledOnce()
  })

  it('preserves caller abort during direct attempt and never starts relay', async () => {
    const controller = new AbortController()
    const callerReason = new DOMException('caller stopped request', 'AbortError')
    const baseFetch = vi.fn<typeof fetch>(async (input) => pendingUntilAbort(requestFrom(input)))
    const getAccessToken = vi.fn(async () => 'eve-access-token')
    const relayFetch = createTestFetch(baseFetch, getAccessToken)

    const responsePromise = relayFetch(
      `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/99/kills/`,
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(baseFetch).toHaveBeenCalledOnce())
    controller.abort(callerReason)

    await expect(responsePromise).rejects.toBe(callerReason)
    expect(baseFetch).toHaveBeenCalledOnce()
    expect(getAccessToken).not.toHaveBeenCalled()
  })

  it('keeps relay inside caller budget after direct failure', async () => {
    const controller = new AbortController()
    const callerReason = new DOMException('client budget exhausted', 'AbortError')
    let call = 0
    const baseFetch = vi.fn<typeof fetch>(async (input) => {
      call += 1
      if (call === 1) throw new TypeError('direct network error')
      return pendingUntilAbort(requestFrom(input))
    })
    const relayFetch = createTestFetch(baseFetch)

    const responsePromise = relayFetch(
      `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/100/kills/`,
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(baseFetch).toHaveBeenCalledTimes(2))
    controller.abort(callerReason)

    await expect(responsePromise).rejects.toBe(callerReason)
    expect(baseFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps a relayed response body attached to the caller budget', async () => {
    const controller = new AbortController()
    const callerReason = new DOMException('client budget exhausted', 'AbortError')
    let call = 0
    const baseFetch = vi.fn<typeof fetch>(async (input) => {
      call += 1
      const request = requestFrom(input)
      if (call === 1) throw new TypeError('direct network error')
      return responseBodyUntilAbort(request)
    })
    const relayFetch = createTestFetch(baseFetch)

    const response = await relayFetch(
      `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/104/kills/`,
      { signal: controller.signal }
    )
    const bodyPromise = response.text()
    controller.abort(callerReason)

    await expect(bodyPromise).rejects.toBe(callerReason)
    expect(baseFetch).toHaveBeenCalledTimes(2)
  })

  it('returns failed direct response when token is unavailable', async () => {
    const directResponse = jsonResponse({ blocked: true }, 503)
    const baseFetch = vi.fn<typeof fetch>(async () => directResponse)
    const relayFetch = createTestFetch(baseFetch, async () => null)

    const response = await relayFetch(
      `${RELAY_BASE_URL}${R2Z2_RELAY_PATH}/800.json`,
      { headers: { Authorization: 'must-not-leak' } }
    )

    expect(response).toBe(directResponse)
    expect(baseFetch).toHaveBeenCalledOnce()
    expect(requestFrom(baseFetch.mock.calls[0]![0]).headers.get('Authorization')).toBeNull()
  })

  it('throws original direct error when token is unavailable', async () => {
    const directError = new TypeError('direct connection failed')
    const baseFetch = vi.fn<typeof fetch>(async () => { throw directError })
    const relayFetch = createTestFetch(baseFetch, async () => null)

    await expect(relayFetch(
      `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/101/kills/`
    )).rejects.toBe(directError)
    expect(baseFetch).toHaveBeenCalledOnce()
  })

  it('returns original direct outcome when token supplier fails', async () => {
    const directResponse = jsonResponse({ blocked: true }, 403)
    const baseFetch = vi.fn<typeof fetch>(async () => directResponse)
    const relayFetch = createTestFetch(baseFetch, async () => {
      throw new Error('account unavailable')
    })

    const response = await relayFetch(
      `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/102/kills/`
    )

    expect(response).toBe(directResponse)
    expect(baseFetch).toHaveBeenCalledOnce()
  })

  it('throws original direct error instead of token-supplier error', async () => {
    const directError = new TypeError('direct DNS failed')
    const baseFetch = vi.fn<typeof fetch>(async () => { throw directError })
    const relayFetch = createTestFetch(baseFetch, async () => {
      throw new Error('account unavailable')
    })

    await expect(relayFetch(
      `${RELAY_BASE_URL}${ZKILL_RELAY_PATH}/api/stats/characterID/103/kills/`
    )).rejects.toBe(directError)
  })

  it.each([
    'https://relay.test/backend/v1/relay/zkillboard/api/test/',
    'https://relay.test/backend/v1/relay/r2z2-extra/sequence.json',
    'https://relay.test.evil/backend/v1/relay/zkill/api/test/',
    'https://unrelated.test/v1/relay/zkill/api/test/'
  ])('passes non-whitelisted URL through unchanged: %s', async (url) => {
    const init: RequestInit = { headers: { Authorization: 'caller-owned' } }
    const baseFetch = vi.fn<typeof fetch>(async () => jsonResponse({ untouched: true }))
    const getAccessToken = vi.fn(async () => 'eve-access-token')
    const relayFetch = createTestFetch(baseFetch, getAccessToken)

    await relayFetch(url, init)

    expect(baseFetch).toHaveBeenCalledWith(url, init)
    expect(getAccessToken).not.toHaveBeenCalled()
  })

  it('rejects invalid timeout and base URL configuration', () => {
    const baseFetch = vi.fn<typeof fetch>(async () => jsonResponse({}))
    expect(() => createTestFetch(baseFetch, undefined, 0)).toThrow(/timeout/i)
    expect(() => createZkillRelayFetch({
      fetch: baseFetch,
      relayBaseUrl: 'not a URL',
      getAccessToken: async () => 'token'
    })).toThrow(/base URL/i)
  })
})

function createTestFetch(
  baseFetch: typeof fetch,
  getAccessToken: (() => Promise<string | null>) | undefined = async () => 'eve-access-token',
  directTimeoutMs = 100
): typeof fetch {
  return createZkillRelayFetch({
    fetch: baseFetch,
    relayBaseUrl: RELAY_BASE_URL,
    getAccessToken,
    directTimeoutMs,
    directMappings: DIRECT_MAPPINGS
  })
}

function pendingUntilAbort(request: Request): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), {
      once: true
    })
  })
}

function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'))
    }
  })
}

function responseBodyUntilAbort(request: Request): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      request.signal.addEventListener('abort', () => {
        controller.error(request.signal.reason)
      }, { once: true })
    }
  }))
}

function requestFrom(input: Parameters<typeof fetch>[0]): Request {
  return input instanceof Request ? input : new Request(input)
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
