import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ZkillRelayError,
  ZkillRelayService,
  resolveZkillRelayRoute
} from '../src/zkill-relay.js'

const STATS_PATH = '/api/stats/characterID/90000001/kills/'
const KILLS_PATH = '/api/kills/characterID/90000001/page/1/'
const LOSSES_PATH = '/api/losses/characterID/90000001/page/2/'
const SYSTEM_PATH = '/api/systemID/30000142/pastSeconds/86400/page/1/'

describe('zKill/R2Z2 relay', () => {
  it('allows only canonical Fly Safe paths', () => {
    assert.equal(resolveZkillRelayRoute('zkill', STATS_PATH)?.kind, 'zkill-stats')
    assert.equal(resolveZkillRelayRoute('zkill', KILLS_PATH)?.kind, 'zkill-kills')
    assert.equal(resolveZkillRelayRoute('zkill', LOSSES_PATH)?.kind, 'zkill-losses')
    assert.equal(resolveZkillRelayRoute('zkill', SYSTEM_PATH)?.kind, 'zkill-system-24h')
    assert.equal(resolveZkillRelayRoute('r2z2', '/sequence.json')?.upstreamPath, '/ephemeral/sequence.json')
    assert.equal(resolveZkillRelayRoute('r2z2', '/123456.json')?.upstreamPath, '/ephemeral/123456.json')

    for (const path of [
      'https://attacker.invalid/api/stats/characterID/90000001/',
      '/api/stats/characterID/90000001/kills/?url=https://attacker.invalid',
      '/api/stats/characterID/090000001/kills/',
      '/api/kills/characterID/90000001/page/0/',
      '/api/systemID/30000142/pastSeconds/3600/page/1/',
      '/api/systemID/30000142/pastSeconds/86400/page/2/',
      '/api/%73tats/characterID/90000001/kills/',
      '//attacker.invalid/api/stats/characterID/90000001/kills/'
    ]) {
      assert.equal(resolveZkillRelayRoute('zkill', path), null, path)
    }
    for (const path of [
      '/ephemeral/sequence.json',
      '/sequence.json?next=https://attacker.invalid',
      '/0.json',
      '/01.json',
      '/../sequence.json',
      '//attacker.invalid/1.json'
    ]) {
      assert.equal(resolveZkillRelayRoute('r2z2', path), null, path)
    }
  })

  it('rejects non-GET and non-allowlisted requests before fetch', async () => {
    let calls = 0
    const service = new ZkillRelayService({
      fetch: (async () => {
        calls += 1
        return jsonResponse({})
      }) as typeof fetch,
      requestIntervalMs: 0
    })

    await assert.rejects(
      service.relay({ method: 'POST', source: 'zkill', path: STATS_PATH }),
      (error: unknown) => relayError(error, 'method_not_allowed', 405)
    )
    await assert.rejects(
      service.relay({ method: 'GET', source: 'zkill', path: '/api/stats/corporationID/1/' }),
      (error: unknown) => relayError(error, 'path_not_allowed', 404)
    )
    assert.equal(calls, 0)
  })

  it('uses fixed bases, safe headers, and service-owned R2Z2 prefix', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return String(input).includes('r2z2')
        ? jsonResponse({ sequence: 123 })
        : jsonResponse({ shipsDestroyed: 7 })
    }) as typeof fetch
    const service = new ZkillRelayService({
      zkillBaseUrl: 'https://zkill.test/root/',
      r2z2BaseUrl: 'https://r2z2.test/root/',
      userAgent: 'Fly-Safe-Relay/Test (ops@example.invalid)',
      fetch: fetchMock,
      requestIntervalMs: 0
    })

    await service.relay({ method: 'GET', source: 'zkill', path: STATS_PATH })
    await service.relay({ method: 'GET', source: 'r2z2', path: '/sequence.json' })

    assert.deepEqual(calls.map((call) => call.url), [
      `https://zkill.test/root${STATS_PATH}`,
      'https://r2z2.test/root/ephemeral/sequence.json'
    ])
    for (const call of calls) {
      const headers = new Headers(call.init?.headers)
      assert.equal(call.init?.method, 'GET')
      assert.equal(call.init?.redirect, 'error')
      assert.equal(headers.get('accept'), 'application/json')
      assert.equal(headers.get('accept-encoding'), 'gzip')
      assert.equal(headers.get('user-agent'), 'Fly-Safe-Relay/Test (ops@example.invalid)')
      assert.equal(headers.get('authorization'), null)
    }
  })

  it('preserves upstream status and Retry-After without relaying unsafe text', async () => {
    const service = new ZkillRelayService({
      fetch: (async () => new Response('<html>busy</html>', {
        status: 429,
        headers: { 'Retry-After': '17' }
      })) as typeof fetch,
      requestIntervalMs: 0
    })

    const result = await service.relay({ method: 'GET', source: 'zkill', path: STATS_PATH })
    assert.equal(result.status, 429)
    assert.equal(result.retryAfter, '17')
    assert.deepEqual(result.body, {
      error: { code: 'upstream_http_error', status: 429 }
    })
  })

  it('globally paces distinct starts and deduplicates identical in-flight work', async () => {
    let now = 10_000
    const sleeps: number[] = []
    const starts: Array<{ url: string; at: number }> = []
    let finishStats!: (response: Response) => void
    const pendingStats = new Promise<Response>((resolve) => {
      finishStats = resolve
    })
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input)
      starts.push({ url, at: now })
      return url.includes('/api/stats/')
        ? pendingStats
        : jsonResponse({ sequence: 77 })
    }) as typeof fetch
    const service = new ZkillRelayService({
      fetch: fetchMock,
      requestIntervalMs: 250,
      clock: {
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
          now += milliseconds
        }
      }
    })

    const first = service.relay({ method: 'GET', source: 'zkill', path: STATS_PATH })
    const duplicate = service.relay({ method: 'GET', source: 'zkill', path: STATS_PATH })
    const r2z2 = service.relay({ method: 'GET', source: 'r2z2', path: '/sequence.json' })

    const r2z2Result = await r2z2
    finishStats(jsonResponse({ shipsDestroyed: 1 }))
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate])

    assert.equal(starts.length, 2)
    assert.deepEqual(starts.map((start) => start.at), [10_000, 10_250])
    assert.deepEqual(sleeps, [250])
    assert.equal(firstResult.cacheStatus, 'miss')
    assert.equal(duplicateResult.cacheStatus, 'shared')
    assert.equal(r2z2Result.cacheStatus, 'miss')
  })

  it('uses TTL cache and evicts least-recently-used entries at its bound', async () => {
    let now = 1_000
    let calls = 0
    const service = new ZkillRelayService({
      fetch: (async () => {
        calls += 1
        return jsonResponse({ call: calls })
      }) as typeof fetch,
      requestIntervalMs: 0,
      cacheTtlMs: 50,
      cacheMaxEntries: 1,
      cacheMaxBytes: 1_024,
      clock: { now: () => now }
    })

    const first = await service.relay({ method: 'GET', source: 'zkill', path: STATS_PATH })
    const hit = await service.relay({ method: 'GET', source: 'zkill', path: STATS_PATH })
    assert.equal(first.cacheStatus, 'miss')
    assert.equal(hit.cacheStatus, 'hit')
    assert.equal(calls, 1)

    now += 50
    await service.relay({ method: 'GET', source: 'zkill', path: STATS_PATH })
    await service.relay({
      method: 'GET',
      source: 'zkill',
      path: '/api/stats/characterID/90000002/kills/'
    })
    await service.relay({ method: 'GET', source: 'zkill', path: STATS_PATH })
    assert.equal(calls, 4)
  })

  it('rejects oversized, invalid, and wrong-shape success bodies', async () => {
    const oversized = new ZkillRelayService({
      fetch: (async () => new Response('[1,2]')) as typeof fetch,
      maxResponseBytes: 4,
      requestIntervalMs: 0
    })
    await assert.rejects(
      oversized.relay({ method: 'GET', source: 'zkill', path: KILLS_PATH }),
      (error: unknown) => relayError(error, 'upstream_response_too_large', 502)
    )

    const invalid = new ZkillRelayService({
      fetch: (async () => new Response('not json')) as typeof fetch,
      requestIntervalMs: 0
    })
    await assert.rejects(
      invalid.relay({ method: 'GET', source: 'zkill', path: STATS_PATH }),
      (error: unknown) => relayError(error, 'upstream_invalid_json', 502)
    )

    const wrongShape = new ZkillRelayService({
      fetch: (async () => jsonResponse({ not: 'an array' })) as typeof fetch,
      requestIntervalMs: 0
    })
    await assert.rejects(
      wrongShape.relay({ method: 'GET', source: 'zkill', path: KILLS_PATH }),
      (error: unknown) => relayError(error, 'upstream_invalid_json', 502)
    )
  })

  it('times out even when a fetch mock waits for abort', async () => {
    const fetchMock = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })) as typeof fetch
    const service = new ZkillRelayService({
      fetch: fetchMock,
      timeoutMs: 5,
      requestIntervalMs: 0
    })

    await assert.rejects(
      service.relay({ method: 'GET', source: 'r2z2', path: '/123.json' }),
      (error: unknown) => relayError(error, 'upstream_timeout', 504)
    )
  })
})

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...Object.fromEntries(new Headers(init.headers))
    }
  })
}

function relayError(error: unknown, code: string, status: number): boolean {
  assert.ok(error instanceof ZkillRelayError)
  assert.equal(error.code, code)
  assert.equal(error.httpStatus, status)
  return true
}
