import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import type { AccessTokenVerifier } from '../src/auth.js'
import { ServiceError } from '../src/domain.js'
import { createApiServer } from '../src/http-api.js'
import { ZkillRelayService } from '../src/zkill-relay.js'
import { PRINCIPAL, createFixture } from './fixture.js'

describe('zKill relay HTTP routes', () => {
  it('authenticates callers, keeps bearer off upstream, caches, and rejects non-allowlisted input', async () => {
    const fixture = createFixture()
    const auth: AccessTokenVerifier = {
      verify: async (token) => {
        if (token !== 'eve-relay-token') {
          throw new ServiceError('unauthorized', 'bad token', 401)
        }
        return PRINCIPAL
      }
    }
    const upstreamCalls: Array<{ url: string; headers: Headers }> = []
    const relay = new ZkillRelayService({
      zkillBaseUrl: 'https://zkill-upstream.test',
      r2z2BaseUrl: 'https://r2z2-upstream.test',
      userAgent: 'Fly-Safe-Relay/Test admin@example.invalid',
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
    const server = createApiServer({
      auth,
      billing: fixture.billing,
      entitlements: fixture.entitlements,
      workspaces: fixture.workspaces,
      zkillRelay: relay,
      adminToken: '0123456789abcdef0123456789abcdef',
      logger: { info() {}, warn() {}, error() {} }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const relayPath = '/v1/relay/zkill/api/stats/characterID/90000001/kills/'
    const authorization = { Authorization: 'Bearer eve-relay-token' }

    try {
      assert.equal((await fetch(`${baseUrl}${relayPath}`)).status, 401)
      assert.equal(upstreamCalls.length, 0)

      const first = await fetch(`${baseUrl}${relayPath}`, { headers: authorization })
      assert.equal(first.status, 200)
      assert.deepEqual(await first.json(), { shipsDestroyed: 9 })
      assert.equal(first.headers.get('x-fly-safe-relay-cache'), 'miss')
      assert.equal(first.headers.get('cache-control'), 'private, no-store')
      assert.equal(first.headers.get('vary'), 'Authorization')

      const cached = await fetch(`${baseUrl}${relayPath}`, { headers: authorization })
      assert.equal(cached.status, 200)
      assert.equal(cached.headers.get('x-fly-safe-relay-cache'), 'hit')
      assert.equal(upstreamCalls.length, 1)
      assert.equal(
        upstreamCalls[0]?.url,
        'https://zkill-upstream.test/api/stats/characterID/90000001/kills/'
      )
      assert.equal(upstreamCalls[0]?.headers.get('authorization'), null)

      const query = await fetch(`${baseUrl}${relayPath}?target=https://attacker.invalid`, {
        headers: authorization
      })
      assert.equal(query.status, 404)
      assert.equal(upstreamCalls.length, 1)

      const post = await fetch(`${baseUrl}${relayPath}`, {
        method: 'POST',
        headers: authorization
      })
      assert.equal(post.status, 405)
      assert.equal(post.headers.get('allow'), 'GET')
      assert.equal(upstreamCalls.length, 1)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      fixture.store.close()
    }
  })
})
