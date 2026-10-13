import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { FLY_SAFE_EVE_CLIENT_ID, type AccessTokenVerifier } from '../src/auth.js'
import { ServiceError } from '../src/domain.js'
import {
  closeRelayHttpServer,
  createRelayHttpServer
} from '../src/relay-http.js'
import { loadRelayDaemonConfig } from '../src/relay-main.js'
import { ZkillRelayService, type ZkillRelayResponse } from '../src/zkill-relay.js'

const STATS_ROUTE = '/v1/relay/zkill/api/stats/characterID/90000001/kills/'

describe('standalone relay HTTP server', () => {
  it('loads without any billing, cashier, entitlement, or admin secrets', () => {
    assert.deepEqual(loadRelayDaemonConfig({
      ZKILL_RELAY_USER_AGENT: 'Fly-Safe-Relay/0.12.6 ops@example.invalid'
    }), {
      host: '127.0.0.1',
      port: 8787,
      eveClientId: FLY_SAFE_EVE_CLIENT_ID,
      userAgent: 'Fly-Safe-Relay/0.12.6 ops@example.invalid',
      zkillBaseUrl: 'https://zkillboard.com',
      r2z2BaseUrl: 'https://r2z2.zkillboard.com'
    })
    assert.throws(
      () => loadRelayDaemonConfig({}),
      /ZKILL_RELAY_USER_AGENT is required/u
    )
    assert.throws(
      () => loadRelayDaemonConfig({
        EVE_CLIENT_ID: 'another-client',
        ZKILL_RELAY_USER_AGENT: 'Fly-Safe-Relay/Test'
      }),
      /must be the unified Fly Safe client ID/u
    )
    assert.throws(
      () => loadRelayDaemonConfig({
        ZKILL_RELAY_USER_AGENT: 'Fly-Safe-Relay/Test',
        ZKILL_BASE_URL: 'http://zkillboard.com'
      }),
      /must use HTTPS/u
    )
    assert.throws(
      () => loadRelayDaemonConfig({
        ZKILL_RELAY_USER_AGENT: 'Fly-Safe-Relay/Test',
        ZKILL_BASE_URL: 'http://127.attacker.invalid'
      }),
      /must use HTTPS/u
    )
    assert.throws(
      () => loadRelayDaemonConfig({
        ZKILL_RELAY_USER_AGENT: 'Fly-Safe-Relay/Test',
        R2Z2_BASE_URL: 'https://r2z2.zkillboard.com/ephemeral'
      }),
      /must be an origin/u
    )
    assert.throws(
      () => loadRelayDaemonConfig({
        ZKILL_RELAY_USER_AGENT: 'Fly-Safe-Relay/Тест'
      }),
      /printable ASCII/u
    )
  })

  it('exposes only an exact public healthcheck and authenticated relay routes', async () => {
    const verifiedTokens: string[] = []
    const auth: AccessTokenVerifier = {
      verify: async (token) => {
        verifiedTokens.push(token)
        if (token !== 'valid-eve-token') {
          throw new ServiceError('unauthorized', 'EVE access token verification failed', 401)
        }
        return { characterId: '90000001', characterName: 'Test Pilot', scopes: [] }
      }
    }
    const upstreamCalls: Array<{ url: string; headers: Headers }> = []
    const relay = new ZkillRelayService({
      zkillBaseUrl: 'https://zkill-upstream.test',
      r2z2BaseUrl: 'https://r2z2-upstream.test',
      userAgent: 'Fly-Safe-Relay/Test ops@example.invalid',
      requestIntervalMs: 0,
      fetch: (async (input, init) => {
        upstreamCalls.push({
          url: String(input),
          headers: new Headers(init?.headers)
        })
        return new Response(JSON.stringify({ shipsDestroyed: 9 }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }) as typeof fetch
    })
    const server = createRelayHttpServer({
      auth,
      relay,
      logger: { warn() {}, error() {} }
    })
    const baseUrl = await listen(server)

    try {
      const health = await fetch(`${baseUrl}/healthz`)
      assert.equal(health.status, 200)
      assert.deepEqual(await health.json(), { status: 'ok' })
      assert.match(health.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/u)
      assert.equal(health.headers.get('cache-control'), 'private, no-store')
      assert.equal(health.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(health.headers.get('referrer-policy'), 'no-referrer')
      assert.equal(health.headers.get('x-frame-options'), 'DENY')
      assert.equal(
        health.headers.get('content-security-policy'),
        "default-src 'none'; frame-ancestors 'none'"
      )
      assert.equal(verifiedTokens.length, 0)

      assert.equal((await fetch(`${baseUrl}/healthz?not=exact`)).status, 404)
      assert.equal((await fetch(`${baseUrl}/v1/plans`)).status, 404)
      assert.equal(verifiedTokens.length, 0)

      const missing = await fetch(`${baseUrl}${STATS_ROUTE}`)
      assert.equal(missing.status, 401)
      assert.equal(missing.headers.get('www-authenticate'), 'Bearer realm="fly-safe-relay"')
      assert.equal(missing.headers.get('vary'), 'Authorization')
      assert.equal(upstreamCalls.length, 0)

      const rejected = await fetch(`${baseUrl}${STATS_ROUTE}`, {
        headers: { Authorization: 'Bearer invalid-eve-token' }
      })
      assert.equal(rejected.status, 401)
      assert.equal(upstreamCalls.length, 0)

      const accepted = await fetch(`${baseUrl}${STATS_ROUTE}`, {
        headers: { Authorization: 'Bearer valid-eve-token' }
      })
      assert.equal(accepted.status, 200)
      assert.deepEqual(await accepted.json(), { shipsDestroyed: 9 })
      assert.equal(accepted.headers.get('x-fly-safe-relay-cache'), 'miss')
      assert.equal(upstreamCalls.length, 1)
      assert.equal(
        upstreamCalls[0]?.url,
        'https://zkill-upstream.test/api/stats/characterID/90000001/kills/'
      )
      assert.equal(upstreamCalls[0]?.headers.get('authorization'), null)

      const query = await fetch(`${baseUrl}${STATS_ROUTE}?url=https://attacker.invalid`, {
        headers: { Authorization: 'Bearer valid-eve-token' }
      })
      assert.equal(query.status, 404)
      assert.equal(upstreamCalls.length, 1)
    } finally {
      await closeRelayHttpServer(server)
    }
  })

  it('is GET-only and graceful close waits for an active relay response', async () => {
    let relayStarted!: () => void
    const started = new Promise<void>((resolve) => {
      relayStarted = resolve
    })
    let releaseRelay!: () => void
    const release = new Promise<void>((resolve) => {
      releaseRelay = resolve
    })
    let relayCalls = 0
    const relay = {
      relay: async (): Promise<ZkillRelayResponse> => {
        relayCalls += 1
        relayStarted()
        await release
        return {
          source: 'zkill',
          routeKind: 'zkill-stats',
          status: 200,
          body: { ok: true },
          contentType: 'application/json; charset=utf-8',
          retryAfter: null,
          cacheStatus: 'miss'
        }
      }
    }
    let authCalls = 0
    const auth: AccessTokenVerifier = {
      verify: async () => {
        authCalls += 1
        return { characterId: '90000001', characterName: 'Test Pilot', scopes: [] }
      }
    }
    const server = createRelayHttpServer({
      auth,
      relay,
      logger: { warn() {}, error() {} }
    })
    const baseUrl = await listen(server)
    const authorization = { Authorization: 'Bearer valid-eve-token' }

    try {
      const port = (server.address() as AddressInfo).port
      const bodyAttempt = await rawHttpRequest(port, [
        `GET ${STATS_ROUTE} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Authorization: Bearer valid-eve-token',
        'Content-Length: 100',
        '',
        ''
      ].join('\r\n'))
      assert.match(bodyAttempt, /^HTTP\/1\.1 400 Bad Request/u)
      assert.match(bodyAttempt, /Connection: close\r\n/iu)
      assert.match(bodyAttempt, /X-Content-Type-Options: nosniff\r\n/iu)
      assert.equal(relayCalls, 0)
      assert.equal(authCalls, 0)

      const expectation = await rawHttpRequest(port, [
        `GET ${STATS_ROUTE} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Authorization: Bearer valid-eve-token',
        'Content-Length: 1',
        'Expect: 100-continue',
        '',
        ''
      ].join('\r\n'))
      assert.match(expectation, /^HTTP\/1\.1 417 Expectation Failed/u)
      assert.doesNotMatch(expectation, /100 Continue/u)
      assert.equal(relayCalls, 0)
      assert.equal(authCalls, 0)

      const post = await fetch(`${baseUrl}${STATS_ROUTE}`, {
        method: 'POST',
        headers: authorization
      })
      assert.equal(post.status, 405)
      assert.equal(post.headers.get('allow'), 'GET')
      assert.equal(relayCalls, 0)
      assert.equal(authCalls, 0)

      const healthPost = await fetch(`${baseUrl}/healthz`, { method: 'POST' })
      assert.equal(healthPost.status, 405)
      assert.equal(healthPost.headers.get('allow'), 'GET')

      const request = fetch(`${baseUrl}${STATS_ROUTE}`, {
        headers: { ...authorization, Connection: 'close' }
      })
      await started
      let closed = false
      const closing = closeRelayHttpServer(server).then(() => {
        closed = true
      })
      await Promise.resolve()
      assert.equal(closed, false)

      releaseRelay()
      const response = await request
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
      assert.equal(authCalls, 1)
      await closing
      assert.equal(closed, true)
    } finally {
      releaseRelay()
      await closeIfListening(server)
    }
  })

  it('bounds active work while keeping the healthcheck available', async () => {
    let releaseRelay!: () => void
    const release = new Promise<void>((resolve) => {
      releaseRelay = resolve
    })
    let relayStarted!: () => void
    const started = new Promise<void>((resolve) => {
      relayStarted = resolve
    })
    const relay = {
      relay: async (): Promise<ZkillRelayResponse> => {
        relayStarted()
        await release
        return {
          source: 'zkill',
          routeKind: 'zkill-stats',
          status: 200,
          body: { ok: true },
          contentType: 'application/json; charset=utf-8',
          retryAfter: null,
          cacheStatus: 'miss'
        }
      }
    }
    const server = createRelayHttpServer({
      auth: {
        verify: async () => ({ characterId: '90000001', characterName: 'Pilot', scopes: [] })
      },
      relay,
      maxActiveRequests: 1,
      logger: { warn() {}, error() {} }
    })
    const baseUrl = await listen(server)
    const headers = { Authorization: 'Bearer valid-eve-token', Connection: 'close' }

    try {
      const first = fetch(`${baseUrl}${STATS_ROUTE}`, { headers })
      await started

      const overloaded = await fetch(`${baseUrl}${STATS_ROUTE}`, { headers })
      assert.equal(overloaded.status, 503)
      assert.equal(overloaded.headers.get('retry-after'), '1')
      assert.equal(overloaded.headers.get('connection'), 'close')
      assert.equal((await fetch(`${baseUrl}/healthz`, {
        headers: { Connection: 'close' }
      })).status, 200)

      releaseRelay()
      assert.equal((await first).status, 200)
    } finally {
      releaseRelay()
      await closeIfListening(server)
    }
  })
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function closeIfListening(server: Server): Promise<void> {
  if (server.listening) await closeRelayHttpServer(server)
}

async function rawHttpRequest(port: number, request: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.setTimeout(2_000, () => {
      socket.destroy(new Error('Raw HTTP request timed out'))
    })
    socket.once('error', reject)
    socket.on('data', (chunk: string) => {
      response += chunk
    })
    socket.once('end', () => resolve(response))
    socket.once('connect', () => socket.write(request))
  })
}
