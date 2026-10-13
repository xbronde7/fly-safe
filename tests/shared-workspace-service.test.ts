import { describe, expect, it, vi } from 'vitest'
import type { EveAuthorizedSession } from '../src/main/account-service'
import {
  SharedWorkspaceService,
  SharedWorkspaceServiceError,
  type SharedWorkspaceAccount
} from '../src/main/shared-workspace-service'

const ACCESS_TOKEN = 'eve.access.token.secret'
const OWNER_ACCESS_TOKEN = 'eve.owner.access.token.secret'
const WORKSPACE_ID = 'workspace-001'
const NOW = 1_787_662_800

const consent = {
  policyVersion: 1,
  scopes: ['watchlist', 'local-presence'],
  acceptedAt: NOW
}

const member = {
  characterId: '90000001',
  characterName: 'Fleet Owner',
  role: 'owner',
  consent,
  joinedAt: NOW,
  updatedAt: NOW
}

const record = {
  collection: 'watchlist',
  recordId: 'watch-001',
  revision: 1,
  workspaceRevision: 2,
  payload: {
    entityType: 'character',
    entityId: '90009999',
    name: 'Known Scout',
    severity: 'danger',
    tags: ['scout'],
    note: null
  },
  updatedByCharacterId: '90000001',
  updatedAt: NOW,
  deletedAt: null,
  lastMutationId: 'mutation-record-001'
}

const snapshot = {
  schemaVersion: 1,
  workspaceId: WORKSPACE_ID,
  name: 'Test Fleet',
  policyVersion: 1,
  revision: 2,
  members: [member],
  records: [record],
  createdAt: NOW,
  updatedAt: NOW
}

const change = {
  workspaceId: WORKSPACE_ID,
  workspaceRevision: 2,
  mutationId: 'mutation-record-001',
  collection: 'watchlist',
  recordId: 'watch-001',
  recordRevision: 1,
  operation: 'upsert',
  changedByCharacterId: '90000001',
  changedAt: NOW
}

const presence = {
  characterId: '90000001',
  characterName: 'Fleet Owner',
  solarSystemId: '30000142',
  solarSystemName: 'Jita',
  revision: 1,
  observedAt: NOW,
  expiresAt: NOW + 120
}

function account(mode: 'connected' | 'disconnected' | 'failure' = 'connected'): SharedWorkspaceAccount {
  return {
    getAuthorizedSession: vi.fn(async (): Promise<EveAuthorizedSession | null> => {
      if (mode === 'failure') throw new Error('refresh failed')
      if (mode === 'disconnected') return null
      return {
        accessToken: ACCESS_TOKEN,
        session: {
          characterId: 90_000_001,
          characterName: 'Fleet Owner',
          scopes: [],
          expiresAt: Date.now() + 60_000
        }
      }
    })
  }
}

function authorizedSession(characterId: number, accessToken: string): EveAuthorizedSession {
  return {
    accessToken,
    session: {
      characterId,
      characterName: `Pilot ${characterId}`,
      scopes: [],
      expiresAt: Date.now() + 60_000
    }
  }
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  })
}

describe('SharedWorkspaceService', () => {
  it('covers workspace, consent, members, policy, sync, records and presence', async () => {
    const requests: Array<{
      method: string
      url: URL
      headers: Headers
      body: unknown
      init: RequestInit | undefined
    }> = []
    const operation = { applied: true, workspace: snapshot }
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      requests.push({ method, url, headers: new Headers(init?.headers), body, init })

      if (url.pathname === '/api/v1/workspaces' && method === 'GET') {
        return json({ workspaces: [{
          workspaceId: WORKSPACE_ID,
          name: 'Test Fleet',
          policyVersion: 1,
          revision: 2,
          role: 'owner',
          consent,
          createdAt: NOW,
          updatedAt: NOW
        }] })
      }
      if (url.pathname === '/api/v1/workspaces' && method === 'POST') return json(operation, 201)
      if (url.pathname === `/api/v1/workspaces/${WORKSPACE_ID}`) {
        return json({ workspace: snapshot })
      }
      if (url.pathname.endsWith('/consent') && method === 'GET') {
        return json({ consents: [{
          ...consent,
          event: 'accepted',
          revokedAt: null,
          occurredAt: NOW
        }] })
      }
      if (url.pathname.endsWith('/consent')) return json(operation)
      if (url.pathname.endsWith('/members') && method === 'GET') return json({ members: [member] })
      if (url.pathname.endsWith('/members') || url.pathname.includes('/members/')) {
        return json(operation, method === 'POST' ? 201 : 200)
      }
      if (url.pathname.endsWith('/policy')) return json(operation)
      if (url.pathname.endsWith('/mutations')) {
        return json({ result: {
          ok: true,
          applied: true,
          staleBase: false,
          workspace: snapshot,
          record,
          change
        } })
      }
      if (url.pathname.endsWith('/changes')) {
        return json({ page: {
          workspaceId: WORKSPACE_ID,
          fromWorkspaceRevision: 0,
          throughWorkspaceRevision: 2,
          changes: [change],
          records: [record],
          hasMore: false
        } })
      }
      if (url.pathname.endsWith('/records')) return json({ records: [record] })
      if (url.pathname.endsWith('/presence') && method === 'GET') {
        return json({ presence: [presence] })
      }
      if (url.pathname.endsWith('/presence') && method === 'PUT') {
        return json({ applied: true, presence })
      }
      if (url.pathname.endsWith('/presence') && method === 'DELETE') {
        return json({ applied: true })
      }
      return json({ error: { code: 'not_found', message: 'not found' } }, 404)
    })
    const service = new SharedWorkspaceService({
      baseUrl: 'https://workspace.example.test/api/',
      account: account(),
      fetch: fetchMock as typeof fetch
    })

    const results = [
      await service.listWorkspaces(),
      await service.createWorkspace({
        workspaceId: WORKSPACE_ID,
        name: ' Test   Fleet ',
        policyVersion: 1,
        mutationId: 'mutation-create-001'
      }),
      await service.getWorkspace(WORKSPACE_ID),
      await service.getSnapshot(WORKSPACE_ID),
      await service.getConsentHistory(WORKSPACE_ID),
      await service.acceptConsent(WORKSPACE_ID, {
        policyVersion: 1,
        scopes: ['local-presence', 'watchlist', 'watchlist'],
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-consent-001'
      }),
      await service.revokeConsent(WORKSPACE_ID, {
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-consent-002'
      }),
      await service.listMembers(WORKSPACE_ID),
      await service.addMember(WORKSPACE_ID, {
        characterId: '90000002',
        characterName: 'Fleet Editor',
        role: 'editor',
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-member-001'
      }),
      await service.setMemberRole(WORKSPACE_ID, '90000002', {
        role: 'viewer',
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-member-002'
      }),
      await service.removeMember(WORKSPACE_ID, '90000002', {
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-member-003'
      }),
      await service.updatePolicy(WORKSPACE_ID, {
        policyVersion: 2,
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-policy-001'
      }),
      await service.applyMutation(WORKSPACE_ID, {
        operation: 'upsert',
        mutationId: 'mutation-record-001',
        collection: 'watchlist',
        recordId: 'watch-001',
        expectedRevision: 0,
        baseWorkspaceRevision: 2,
        payload: record.payload
      }),
      await service.pullChanges(WORKSPACE_ID, 0, 50),
      await service.listRecords(WORKSPACE_ID, 'watchlist'),
      await service.listPresence(WORKSPACE_ID),
      await service.upsertPresence(WORKSPACE_ID, {
        solarSystemId: '30000142',
        solarSystemName: 'Jita',
        ttlSeconds: 120,
        expectedRevision: 0,
        mutationId: 'mutation-presence-001'
      }),
      await service.clearPresence(WORKSPACE_ID, {
        expectedRevision: 1,
        mutationId: 'mutation-presence-002'
      })
    ]

    expect(requests).toHaveLength(18)
    expect(requests.every(({ headers }) => headers.get('authorization') === `Bearer ${ACCESS_TOKEN}`))
      .toBe(true)
    expect(requests.every(({ init }) => init?.credentials === 'omit' && init.redirect === 'error'))
      .toBe(true)
    expect(requests.find(({ method, url }) => method === 'PUT' && url.pathname.endsWith('/consent'))?.body)
      .toMatchObject({ scopes: ['watchlist', 'local-presence'] })
    expect(requests.find(({ url }) => url.pathname.endsWith('/changes'))?.url.searchParams.get('limit'))
      .toBe('50')
    expect(requests.find(({ url }) => url.pathname.endsWith('/records'))?.url.searchParams.get('collection'))
      .toBe('watchlist')
    expect(JSON.stringify(results)).not.toContain(ACCESS_TOKEN)
    expect(results[0]).toMatchObject([{ workspaceId: WORKSPACE_ID, role: 'owner' }])
    expect(results[12]).toMatchObject({ ok: true, record: { recordId: 'watch-001' } })
    expect(results[16]).toMatchObject({ applied: true, presence: { solarSystemId: '30000142' } })
  })

  it('requires HTTPS except loopback and requires an authenticated EVE session', async () => {
    const fetchMock = vi.fn(async () => json({ workspaces: [] }))
    expect(() => new SharedWorkspaceService({
      baseUrl: 'http://workspace.example.test',
      account: account(),
      fetch: fetchMock as typeof fetch
    })).toThrowError(expect.objectContaining({ code: 'invalid_configuration' }))

    const localhost = new SharedWorkspaceService({
      baseUrl: 'http://localhost:3030',
      account: account(),
      fetch: fetchMock as typeof fetch
    })
    await expect(localhost.listWorkspaces()).resolves.toEqual([])

    const disconnected = new SharedWorkspaceService({
      baseUrl: 'https://workspace.example.test',
      account: account('disconnected'),
      fetch: fetchMock as typeof fetch
    })
    await expect(disconnected.listWorkspaces()).rejects.toMatchObject({
      code: 'authentication_required',
      httpStatus: null
    })

    const failed = new SharedWorkspaceService({
      baseUrl: 'https://workspace.example.test',
      account: account('failure'),
      fetch: fetchMock as typeof fetch
    })
    await expect(failed.listWorkspaces()).rejects.toMatchObject({ code: 'authentication_failed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('adds a paid-owner bearer only for a different active character', async () => {
    const observedHeaders: Headers[] = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedHeaders.push(new Headers(init?.headers))
      return json({ workspaces: [] })
    })
    const differentOwner = new SharedWorkspaceService({
      baseUrl: 'https://workspace.example.test',
      account: {
        getAuthorizedSession: async () => authorizedSession(90_000_002, ACCESS_TOKEN),
        getOwnerAuthorizedSession: async () => authorizedSession(90_000_001, OWNER_ACCESS_TOKEN)
      },
      fetch: fetchMock as typeof fetch
    })
    await expect(differentOwner.listWorkspaces()).resolves.toEqual([])
    expect(observedHeaders[0]?.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(observedHeaders[0]?.get('x-fly-safe-owner-authorization'))
      .toBe(`Bearer ${OWNER_ACCESS_TOKEN}`)

    const sameCharacter = new SharedWorkspaceService({
      baseUrl: 'https://workspace.example.test',
      account: {
        getAuthorizedSession: async () => authorizedSession(90_000_001, ACCESS_TOKEN),
        getOwnerAuthorizedSession: async () => authorizedSession(90_000_001, OWNER_ACCESS_TOKEN)
      },
      fetch: fetchMock as typeof fetch
    })
    await expect(sameCharacter.listWorkspaces()).resolves.toEqual([])
    expect(observedHeaders[1]?.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(observedHeaders[1]?.has('x-fly-safe-owner-authorization')).toBe(false)
  })

  it('preserves backend error metadata and redacts both bearers from messages', async () => {
    const fetchMock = vi.fn(async () => json({
      error: {
        code: 'mutation_id_reused',
        message: `Mutation conflict for ${ACCESS_TOKEN} and ${OWNER_ACCESS_TOKEN}`,
        details: { token: ACCESS_TOKEN }
      },
      requestId: 'request-001'
    }, 409))
    const service = new SharedWorkspaceService({
      baseUrl: 'https://workspace.example.test',
      account: {
        getAuthorizedSession: async () => authorizedSession(90_000_002, ACCESS_TOKEN),
        getOwnerAuthorizedSession: async () => authorizedSession(90_000_001, OWNER_ACCESS_TOKEN)
      },
      fetch: fetchMock as typeof fetch
    })

    const error = await service.listWorkspaces().catch((value: unknown) => value)
    expect(error).toBeInstanceOf(SharedWorkspaceServiceError)
    expect(error).toMatchObject({
      code: 'mutation_id_reused',
      httpStatus: 409,
      requestId: 'request-001'
    })
    expect(String((error as Error).message)).toContain('[redacted]')
    expect(JSON.stringify(error)).not.toContain(ACCESS_TOKEN)
    expect(JSON.stringify(error)).not.toContain(OWNER_ACCESS_TOKEN)
  })

  it('rejects malformed or oversized JSON responses with stable local codes', async () => {
    const responses = [
      new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } }),
      new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(2 * 1_024 * 1_024 + 1)
        }
      }),
      json({ workspaces: [{ role: 'admin' }] })
    ]
    const fetchMock = vi.fn(async () => responses.shift()!)
    const service = new SharedWorkspaceService({
      baseUrl: 'https://workspace.example.test',
      account: account(),
      fetch: fetchMock as typeof fetch
    })

    await expect(service.listWorkspaces()).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(service.listWorkspaces()).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(service.listWorkspaces()).rejects.toMatchObject({ code: 'response_too_large' })
    await expect(service.listWorkspaces()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('rejects unsafe requests before fetch', async () => {
    const fetchMock = vi.fn(async () => json({ result: {} }))
    const service = new SharedWorkspaceService({
      baseUrl: 'https://workspace.example.test',
      account: account(),
      fetch: fetchMock as typeof fetch
    })

    await expect(service.pullChanges(WORKSPACE_ID, 0, 501)).rejects.toMatchObject({
      code: 'invalid_request'
    })
    await expect(service.applyMutation(WORKSPACE_ID, {
      operation: 'upsert',
      mutationId: 'mutation-record-001',
      collection: 'watchlist',
      recordId: 'watch-001',
      expectedRevision: 0,
      baseWorkspaceRevision: 0,
      payload: { bad: BigInt(1) }
    })).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(service.applyMutation(WORKSPACE_ID, {
      operation: 'upsert',
      mutationId: 'mutation-record-002',
      collection: 'watchlist',
      recordId: 'watch-002',
      expectedRevision: 0,
      baseWorkspaceRevision: 0,
      payload: { note: 'x'.repeat(40 * 1_024) }
    })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
