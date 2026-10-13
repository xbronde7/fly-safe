import { describe, expect, it } from 'vitest'
import {
  parseAcceptSharedWorkspaceConsentRequest,
  parseAddSharedWorkspaceMemberRequest,
  parseApplySharedWorkspaceMutationRequest,
  parseCreateSharedWorkspaceRequest,
  parseGetSharedWorkspaceRequest,
  parseRevokeSharedWorkspaceConsentRequest,
  toPublicSharedWorkspaceMutationResult,
  toPublicSharedWorkspaceSnapshot,
  toPublicSharedWorkspaceSummary
} from '../src/main/shared-workspace-ipc'
import type {
  SharedWorkspaceMutationResult as WireMutationResult,
  SharedWorkspaceSnapshot as WireSnapshot,
  SharedWorkspaceSummary as WireSummary
} from '../src/main/shared-workspace-service'

const NOW = 1_787_662_800
const NOW_ISO = '2026-08-25T13:00:00.000Z'

const consent = {
  policyVersion: 1,
  scopes: ['watchlist', 'doctrines', 'routes', 'local-presence'] as const,
  acceptedAt: NOW
}

const wireSummary: WireSummary = {
  workspaceId: 'workspace-001',
  name: 'Fleet Intel',
  policyVersion: 1,
  revision: 4,
  role: 'owner',
  consent,
  createdAt: NOW,
  updatedAt: NOW
}

const records = [
  {
    collection: 'watchlist' as const,
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
    lastMutationId: 'mutation-watch-001'
  },
  {
    collection: 'doctrines' as const,
    recordId: 'doctrine-001',
    revision: 1,
    workspaceRevision: 3,
    payload: {
      name: 'Shield Fleet',
      description: null,
      ships: [{ typeId: 12_005, minimum: 2, maximum: 5, role: 'DPS' }],
      tags: ['shield']
    },
    updatedByCharacterId: '90000001',
    updatedAt: NOW,
    deletedAt: null,
    lastMutationId: 'mutation-doctrine-001'
  },
  {
    collection: 'routes' as const,
    recordId: 'route-001',
    revision: 1,
    workspaceRevision: 4,
    payload: {
      name: 'Extraction',
      origin: 'Jita',
      destination: 'Amarr',
      mode: 'secure',
      avoidSystemIds: [30_000_142],
      tags: ['logistics']
    },
    updatedByCharacterId: '90000001',
    updatedAt: NOW,
    deletedAt: null,
    lastMutationId: 'mutation-route-001'
  }
]

const wireSnapshot: WireSnapshot = {
  schemaVersion: 1,
  workspaceId: 'workspace-001',
  name: 'Fleet Intel',
  policyVersion: 1,
  revision: 4,
  members: [{
    characterId: '90000001',
    characterName: 'Fleet Owner',
    role: 'owner',
    consent,
    joinedAt: NOW,
    updatedAt: NOW
  }],
  records,
  createdAt: NOW,
  updatedAt: NOW
}

describe('shared workspace IPC adapter', () => {
  it('strictly parses metadata, consent and member requests', () => {
    expect(parseGetSharedWorkspaceRequest({ workspaceId: ' workspace-001 ' }))
      .toEqual({ workspaceId: 'workspace-001' })
    expect(parseCreateSharedWorkspaceRequest({ name: '  Fleet   Intel  ' }))
      .toEqual({ name: 'Fleet Intel' })
    expect(parseAcceptSharedWorkspaceConsentRequest({
      workspaceId: 'workspace-001',
      policyVersion: 1,
      scopes: ['local-presence', 'watchlist'],
      expectedWorkspaceRevision: 4
    })).toEqual({
      workspaceId: 'workspace-001',
      policyVersion: 1,
      scopes: ['watchlist', 'local-presence'],
      expectedWorkspaceRevision: 4
    })
    expect(parseRevokeSharedWorkspaceConsentRequest({
      workspaceId: 'workspace-001',
      expectedWorkspaceRevision: 5
    })).toEqual({ workspaceId: 'workspace-001', expectedWorkspaceRevision: 5 })
    expect(parseAddSharedWorkspaceMemberRequest({
      workspaceId: 'workspace-001',
      characterId: 90_000_002,
      characterName: ' Fleet   Editor ',
      role: 'editor',
      expectedWorkspaceRevision: 5
    })).toEqual({
      workspaceId: 'workspace-001',
      characterId: 90_000_002,
      characterName: 'Fleet Editor',
      role: 'editor',
      expectedWorkspaceRevision: 5
    })

    expect(() => parseGetSharedWorkspaceRequest({
      workspaceId: 'workspace-001',
      accessToken: 'must-not-cross-ipc'
    })).toThrow(TypeError)
    expect(() => parseCreateSharedWorkspaceRequest({ name: 'x'.repeat(121) })).toThrow(TypeError)
    expect(() => parseAcceptSharedWorkspaceConsentRequest({
      workspaceId: 'workspace-001',
      policyVersion: 1,
      scopes: ['wallet'],
      expectedWorkspaceRevision: 4
    })).toThrow(TypeError)
    expect(() => parseAddSharedWorkspaceMemberRequest({
      workspaceId: 'workspace-001',
      characterId: Number.MAX_SAFE_INTEGER + 1,
      characterName: 'Bad',
      role: 'owner',
      expectedWorkspaceRevision: 1
    })).toThrow(TypeError)
  })

  it('converts every public mutation payload to the strict backend wire shape', () => {
    expect(parseApplySharedWorkspaceMutationRequest({
      workspaceId: 'workspace-001',
      mutation: {
        operation: 'upsert',
        mutationId: 'mutation-watch-001',
        collection: 'watchlist',
        recordId: 'watch-001',
        expectedRevision: 0,
        baseWorkspaceRevision: 1,
        payload: {
          entityType: 'character',
          entityId: 90_009_999,
          name: ' Known   Scout ',
          severity: 'danger',
          tags: ['scout', 'scout'],
          note: null
        }
      }
    })).toEqual({
      workspaceId: 'workspace-001',
      mutation: {
        operation: 'upsert',
        mutationId: 'mutation-watch-001',
        collection: 'watchlist',
        recordId: 'watch-001',
        expectedRevision: 0,
        baseWorkspaceRevision: 1,
        payload: {
          entityType: 'character',
          entityId: '90009999',
          name: 'Known Scout',
          severity: 'danger',
          tags: ['scout'],
          note: null
        }
      }
    })

    expect(parseApplySharedWorkspaceMutationRequest({
      workspaceId: 'workspace-001',
      mutation: {
        operation: 'upsert',
        mutationId: 'mutation-doctrine-001',
        collection: 'doctrines',
        recordId: 'doctrine-001',
        expectedRevision: 1,
        baseWorkspaceRevision: 2,
        payload: records[1]!.payload
      }
    }).mutation).toMatchObject({
      collection: 'doctrines',
      payload: { ships: [{ typeId: 12_005, minimum: 2, maximum: 5 }] }
    })

    expect(parseApplySharedWorkspaceMutationRequest({
      workspaceId: 'workspace-001',
      mutation: {
        operation: 'upsert',
        mutationId: 'mutation-route-001',
        collection: 'routes',
        recordId: 'route-001',
        expectedRevision: 1,
        baseWorkspaceRevision: 3,
        payload: {
          ...records[2]!.payload,
          avoidSystemIds: [30_000_142, 30_000_142]
        }
      }
    }).mutation).toMatchObject({
      collection: 'routes',
      payload: { avoidSystemIds: [30_000_142] }
    })

    expect(parseApplySharedWorkspaceMutationRequest({
      workspaceId: 'workspace-001',
      mutation: {
        operation: 'delete',
        mutationId: 'mutation-delete-001',
        collection: 'watchlist',
        recordId: 'watch-001',
        expectedRevision: 1,
        baseWorkspaceRevision: 4
      }
    }).mutation).toEqual({
      operation: 'delete',
      mutationId: 'mutation-delete-001',
      collection: 'watchlist',
      recordId: 'watch-001',
      expectedRevision: 1,
      baseWorkspaceRevision: 4
    })
  })

  it('rejects extra nested fields, invalid counts and invalid mutation values', () => {
    const base = {
      workspaceId: 'workspace-001',
      mutation: {
        operation: 'upsert',
        mutationId: 'mutation-watch-001',
        collection: 'watchlist',
        recordId: 'watch-001',
        expectedRevision: 0,
        baseWorkspaceRevision: 1,
        payload: {
          entityType: 'character',
          entityId: 90_009_999,
          name: 'Scout',
          severity: 'danger',
          tags: [],
          note: null
        }
      }
    }
    expect(() => parseApplySharedWorkspaceMutationRequest({
      ...base,
      mutation: { ...base.mutation, actorCharacterId: 90_000_001 }
    })).toThrow(TypeError)
    expect(() => parseApplySharedWorkspaceMutationRequest({
      ...base,
      mutation: {
        ...base.mutation,
        payload: { ...base.mutation.payload, accessToken: 'secret' }
      }
    })).toThrow(TypeError)
    expect(() => parseApplySharedWorkspaceMutationRequest({
      ...base,
      mutation: { ...base.mutation, expectedRevision: -1 }
    })).toThrow(TypeError)
    expect(() => parseApplySharedWorkspaceMutationRequest({
      ...base,
      mutation: {
        ...base.mutation,
        payload: { ...base.mutation.payload, tags: Array.from({ length: 51 }, (_, i) => `tag-${i}`) }
      }
    })).toThrow(TypeError)
  })

  it('converts wire summaries and all snapshot record collections into public domain types', () => {
    expect(toPublicSharedWorkspaceSummary(wireSummary)).toEqual({
      workspaceId: 'workspace-001',
      name: 'Fleet Intel',
      policyVersion: 1,
      revision: 4,
      role: 'owner',
      consent: {
        policyVersion: 1,
        scopes: ['watchlist', 'doctrines', 'routes', 'local-presence'],
        acceptedAt: NOW_ISO
      },
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO
    })

    const result = toPublicSharedWorkspaceSnapshot(wireSnapshot)
    expect(result.members[0]).toMatchObject({
      characterId: 90_000_001,
      joinedAt: NOW_ISO,
      consent: { acceptedAt: NOW_ISO }
    })
    expect(result.records).toMatchObject([
      {
        collection: 'watchlist',
        payload: { entityId: 90_009_999 },
        updatedByCharacterId: 90_000_001,
        updatedAt: NOW_ISO
      },
      {
        collection: 'doctrines',
        payload: { ships: [{ typeId: 12_005 }] }
      },
      {
        collection: 'routes',
        payload: { avoidSystemIds: [30_000_142] }
      }
    ])
    expect(JSON.stringify(result)).not.toContain('1787662800')
  })

  it('converts mutation success/failure and rejects unsafe wire IDs or timestamps', () => {
    const success: WireMutationResult = {
      ok: true,
      applied: true,
      staleBase: false,
      workspace: wireSnapshot,
      record: records[0]!,
      change: {
        workspaceId: 'workspace-001',
        workspaceRevision: 4,
        mutationId: 'mutation-watch-001',
        collection: 'watchlist',
        recordId: 'watch-001',
        recordRevision: 1,
        operation: 'upsert',
        changedByCharacterId: '90000001',
        changedAt: NOW
      }
    }
    expect(toPublicSharedWorkspaceMutationResult(success)).toMatchObject({
      ok: true,
      record: { payload: { entityId: 90_009_999 } },
      change: { changedByCharacterId: 90_000_001, changedAt: NOW_ISO }
    })

    const failure: WireMutationResult = {
      ok: false,
      code: 'conflict',
      message: 'Revision conflict',
      workspaceRevision: 4,
      currentRecord: records[0]!
    }
    expect(toPublicSharedWorkspaceMutationResult(failure)).toMatchObject({
      ok: false,
      code: 'conflict',
      currentRecord: { payload: { entityId: 90_009_999 } }
    })

    expect(() => toPublicSharedWorkspaceSnapshot({
      ...wireSnapshot,
      members: [{ ...wireSnapshot.members[0]!, characterId: '9007199254740992' }]
    })).toThrow(/characterId/u)
    expect(() => toPublicSharedWorkspaceSnapshot({
      ...wireSnapshot,
      updatedAt: 253_402_300_800
    })).toThrow(/updatedAt/u)
    expect(() => toPublicSharedWorkspaceSnapshot({
      ...wireSnapshot,
      records: [{
        ...records[0]!,
        payload: { ...records[0]!.payload, entityId: 90_009_999 }
      }]
    } as unknown as WireSnapshot)).toThrow(/entityId/u)
    expect(() => toPublicSharedWorkspaceSnapshot({
      ...wireSnapshot,
      records: [{
        ...records[0]!,
        payload: { ...records[0]!.payload, extra: true }
      }]
    } as unknown as WireSnapshot)).toThrow(/watchlist payload/u)
  })
})
