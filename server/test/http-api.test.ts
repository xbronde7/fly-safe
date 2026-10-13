import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import type { AccessTokenVerifier } from '../src/auth.js'
import { ServiceError } from '../src/domain.js'
import { createApiServer } from '../src/http-api.js'
import { DEVICE_CODE, PLAN, PRINCIPAL, createFixture } from './fixture.js'

const COMMANDER = {
  characterId: '90000002',
  characterName: 'HTTP Commander',
  scopes: []
}

describe('REST API', () => {
  it('exposes public plans and character-scoped invoice/device endpoints', async () => {
    const fixture = createFixture()
    const auth: AccessTokenVerifier = {
      verify: async (token) => {
        if (token !== 'eve-test-access-token') throw new ServiceError('unauthorized', 'bad token', 401)
        return PRINCIPAL
      }
    }
    const server = createApiServer({
      auth,
      billing: fixture.billing,
      entitlements: fixture.entitlements,
      workspaces: fixture.workspaces,
      adminToken: '0123456789abcdef0123456789abcdef',
      logger: { info() {}, warn() {}, error() {} }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    try {
      const plansResponse = await fetch(`${baseUrl}/v1/plans`)
      assert.equal(plansResponse.status, 200)
      const plans = await plansResponse.json() as { plans: Array<Record<string, unknown>> }
      assert.equal(plans.plans[0]?.priceIsk, '100000000.00')

      const unauthorized = await fetch(`${baseUrl}/v1/account`)
      assert.equal(unauthorized.status, 401)

      const headers = {
        Authorization: 'Bearer eve-test-access-token',
        'Content-Type': 'application/json'
      }
      const deviceResponse = await fetch(`${baseUrl}/v1/devices`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ deviceCode: DEVICE_CODE, label: 'Main PC' })
      })
      assert.equal(deviceResponse.status, 201)

      const invoiceResponse = await fetch(`${baseUrl}/v1/invoices`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ planId: 'pro-30d' })
      })
      assert.equal(invoiceResponse.status, 201)
      const result = await invoiceResponse.json() as { invoice: Record<string, unknown> }
      assert.equal(result.invoice.amountIsk, '100000000.00')
      assert.equal(result.invoice.reason, 'FS-ABCDEFGH')
      assert.equal(result.invoice.receiverCharacterId, '90000099')

      const keysResponse = await fetch(`${baseUrl}/v1/keys`)
      const keys = await keysResponse.json() as { keys: Array<Record<string, unknown>> }
      assert.equal(keys.keys[0]?.kid, 'test-key-01')
      assert.equal(keys.keys[0]?.alg, 'EdDSA')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      fixture.store.close()
    }
  })

  it('serves authenticated workspace sync and derives presence identity from the bearer', async () => {
    const fixture = createFixture()
    const auth: AccessTokenVerifier = {
      verify: async (token) => {
        if (token === 'owner-token') return PRINCIPAL
        if (token === 'commander-token') return COMMANDER
        if (token === 'outsider-token') {
          return { characterId: '90000004', characterName: 'Outsider', scopes: [] }
        }
        throw new ServiceError('unauthorized', 'bad token', 401)
      }
    }
    const server = createApiServer({
      auth,
      billing: fixture.billing,
      entitlements: fixture.entitlements,
      workspaces: fixture.workspaces,
      adminToken: '0123456789abcdef0123456789abcdef',
      logger: { info() {}, warn() {}, error() {} }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const workspaceUrl = `${baseUrl}/v1/workspaces/workspace-http-01`
    try {
      assert.equal((await fetch(`${baseUrl}/v1/workspaces`)).status, 401)

      const createBody = {
        workspaceId: 'workspace-http-01',
        name: 'HTTP Fleet',
        policyVersion: 1,
        mutationId: 'mutation-http-create'
      }
      const unlicensed = await jsonRequest(`${baseUrl}/v1/workspaces`, 'owner-token', 'POST', createBody)
      assert.equal(unlicensed.response.status, 402)
      assert.equal((unlicensed.body as { error: { code: string } }).error.code, 'subscription_required')

      grantCorpFleet(fixture, PRINCIPAL.characterId, PRINCIPAL.characterName)
      const created = await jsonRequest(`${baseUrl}/v1/workspaces`, 'owner-token', 'POST', createBody)
      assert.equal(created.response.status, 201)

      const ownerConsent = await jsonRequest(`${workspaceUrl}/consent`, 'owner-token', 'PUT', {
        policyVersion: 1,
        scopes: ['watchlist', 'local-presence'],
        expectedWorkspaceRevision: 1,
        mutationId: 'mutation-http-owner-consent'
      })
      assert.equal(ownerConsent.response.status, 200)

      const member = await jsonRequest(`${workspaceUrl}/members`, 'owner-token', 'POST', {
        characterId: COMMANDER.characterId,
        characterName: COMMANDER.characterName,
        role: 'commander',
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-http-member'
      })
      assert.equal(member.response.status, 201)

      grantCorpFleet(fixture, COMMANDER.characterId, COMMANDER.characterName)

      const beforeConsent = await fetch(workspaceUrl, {
        headers: { Authorization: 'Bearer commander-token' }
      })
      assert.equal(beforeConsent.status, 200)
      assert.equal(beforeConsent.headers.get('cache-control'), 'private, no-store')
      assert.equal(
        beforeConsent.headers.get('vary'),
        'Authorization, X-Fly-Safe-Owner-Authorization'
      )
      const beforeConsentBody = await beforeConsent.json() as {
        workspace: { records: unknown[] }
      }
      assert.deepEqual(beforeConsentBody.workspace.records, [])

      await jsonRequest(`${workspaceUrl}/consent`, 'commander-token', 'PUT', {
        policyVersion: 1,
        scopes: ['watchlist'],
        expectedWorkspaceRevision: 3,
        mutationId: 'mutation-http-commander-consent'
      })
      const mutation = await jsonRequest(`${workspaceUrl}/mutations`, 'commander-token', 'POST', {
        operation: 'upsert',
        mutationId: 'mutation-http-record',
        collection: 'watchlist',
        recordId: 'record-http-01',
        expectedRevision: 0,
        baseWorkspaceRevision: 4,
        payload: {
          entityType: 'corporation',
          entityId: '98000001',
          name: 'Hostile Corp',
          severity: 'critical',
          tags: ['hostile'],
          note: null
        }
      })
      assert.equal(mutation.response.status, 200)
      assert.equal((mutation.body as { result: { ok: boolean } }).result.ok, true)

      const recordsResponse = await fetch(`${workspaceUrl}/records?collection=watchlist`, {
        headers: { Authorization: 'Bearer commander-token' }
      })
      const recordsBody = await recordsResponse.json() as { records: Array<{ recordId: string }> }
      assert.equal(recordsBody.records[0]?.recordId, 'record-http-01')

      const deniedPresence = await jsonRequest(`${workspaceUrl}/presence`, 'commander-token', 'PUT', {
        solarSystemId: '30002187',
        ttlSeconds: 60,
        expectedRevision: 0,
        mutationId: 'mutation-http-presence-denied'
      })
      assert.equal(deniedPresence.response.status, 403)
      assert.equal((deniedPresence.body as { error: { code: string } }).error.code, 'scope_not_consented')

      await jsonRequest(`${workspaceUrl}/consent`, 'commander-token', 'PUT', {
        policyVersion: 1,
        scopes: ['watchlist', 'local-presence'],
        expectedWorkspaceRevision: 5,
        mutationId: 'mutation-http-commander-local'
      })
      const presence = await jsonRequest(`${workspaceUrl}/presence`, 'commander-token', 'PUT', {
        characterId: PRINCIPAL.characterId,
        solarSystemId: '30002187',
        solarSystemName: 'Amarr',
        ttlSeconds: 60,
        expectedRevision: 0,
        mutationId: 'mutation-http-presence'
      })
      assert.equal((presence.body as { presence: { characterId: string } }).presence.characterId, COMMANDER.characterId)

      const visiblePresence = await fetch(`${workspaceUrl}/presence`, {
        headers: { Authorization: 'Bearer owner-token' }
      })
      const visiblePresenceBody = await visiblePresence.json() as {
        presence: Array<{ characterId: string }>
      }
      assert.deepEqual(visiblePresenceBody.presence.map((entry) => entry.characterId), [COMMANDER.characterId])

      grantCorpFleet(fixture, '90000004', 'Outsider')
      const outsider = await fetch(workspaceUrl, {
        headers: { Authorization: 'Bearer outsider-token' }
      })
      assert.equal(outsider.status, 404)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      fixture.store.close()
    }
  })

  it('uses a separately authenticated paid owner only as an alt entitlement fallback', async () => {
    const fixture = createFixture()
    const verifiedTokens: string[] = []
    const warnings: unknown[] = []
    const unlicensedActor = {
      characterId: '90000003',
      characterName: 'Unlicensed Alt',
      scopes: []
    }
    const auth: AccessTokenVerifier = {
      verify: async (token) => {
        verifiedTokens.push(token)
        if (token === 'actor-token') return COMMANDER
        if (token === 'unlicensed-actor-token') return unlicensedActor
        if (token === 'owner-token') return PRINCIPAL
        throw new ServiceError('unauthorized', 'bad token', 401)
      }
    }
    const server = createApiServer({
      auth,
      billing: fixture.billing,
      entitlements: fixture.entitlements,
      workspaces: fixture.workspaces,
      adminToken: '0123456789abcdef0123456789abcdef',
      logger: { info() {}, warn(value) { warnings.push(value) }, error() {} }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${address.port}`
    const createBody = {
      workspaceId: 'workspace-dual-auth-01',
      name: 'Dual Auth Fleet',
      policyVersion: 1,
      mutationId: 'mutation-dual-auth-create'
    }
    try {
      // corp_fleet_intel alone is insufficient for an owner sponsoring another character.
      grantCorpFleet(fixture, PRINCIPAL.characterId, PRINCIPAL.characterName)
      const missingMulti = await workspaceRequest(
        `${baseUrl}/v1/workspaces`,
        'actor-token',
        'owner-token',
        'POST',
        createBody
      )
      assert.equal(missingMulti.response.status, 403)
      assert.equal(
        (missingMulti.body as { error: { code: string } }).error.code,
        'feature_not_entitled'
      )

      fixture.store.upsertPlan({
        ...PLAN,
        id: 'multi-only-30d',
        name: 'Multi only 30 days',
        features: ['multi_character']
      })
      grantCorpFleet(fixture, PRINCIPAL.characterId, PRINCIPAL.characterName, 'multi-only-30d')
      const missingFleet = await workspaceRequest(
        `${baseUrl}/v1/workspaces`,
        'actor-token',
        'owner-token',
        'POST',
        createBody
      )
      assert.equal(missingFleet.response.status, 403)
      assert.equal(
        (missingFleet.body as { error: { code: string } }).error.code,
        'feature_not_entitled'
      )

      fixture.store.upsertPlan({
        ...PLAN,
        id: 'team-30d',
        name: 'Team 30 days',
        features: ['multi_character', 'corp_fleet_intel']
      })
      grantCorpFleet(fixture, PRINCIPAL.characterId, PRINCIPAL.characterName, 'team-30d')
      const created = await workspaceRequest(
        `${baseUrl}/v1/workspaces`,
        'actor-token',
        'owner-token',
        'POST',
        createBody
      )
      assert.equal(created.response.status, 201)
      assert.equal(
        (created.body as { workspace: { members: Array<{ characterId: string }> } })
          .workspace.members[0]?.characterId,
        COMMANDER.characterId
      )

      // Once the actor is directly entitled, an optional owner credential is not authenticated.
      grantCorpFleet(fixture, COMMANDER.characterId, COMMANDER.characterName)
      verifiedTokens.length = 0
      const direct = await fetch(`${baseUrl}/v1/workspaces`, {
        headers: {
          Authorization: 'Bearer actor-token',
          'X-Fly-Safe-Owner-Authorization': 'Bearer ignored-invalid-owner-token'
        }
      })
      assert.equal(direct.status, 200)
      assert.deepEqual(verifiedTokens, ['actor-token'])

      // Authentication failures log only the stable error code, never either bearer value.
      const invalidOwner = await fetch(`${baseUrl}/v1/workspaces`, {
        headers: {
          Authorization: 'Bearer unlicensed-actor-token',
          'X-Fly-Safe-Owner-Authorization': 'Bearer secret-invalid-owner-token'
        }
      })
      assert.equal(invalidOwner.status, 401)
      const logged = JSON.stringify(warnings)
      assert.equal(logged.includes('unlicensed-actor-token'), false)
      assert.equal(logged.includes('secret-invalid-owner-token'), false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      fixture.store.close()
    }
  })
})

async function jsonRequest(
  url: string,
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  return { response, body: await response.json() }
}

function grantCorpFleet(
  fixture: ReturnType<typeof createFixture>,
  characterId: string,
  characterName: string,
  planId = 'pro-30d'
): void {
  fixture.store.saveSubscription({
    id: `subscription-${characterId}`,
    characterId,
    characterName,
    planId,
    status: 'active',
    autoRenew: true,
    paidThrough: 1_800_000_000,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000
  })
}

async function workspaceRequest(
  url: string,
  actorToken: string,
  ownerToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${actorToken}`,
      'X-Fly-Safe-Owner-Authorization': `Bearer ${ownerToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  return { response, body: await response.json() }
}
