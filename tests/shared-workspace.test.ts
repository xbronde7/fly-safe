import { describe, expect, it } from 'vitest'
import {
  SharedWorkspaceDomainError,
  acceptSharedWorkspaceConsent,
  addSharedWorkspaceMember,
  applySharedWorkspaceMutation,
  createSharedWorkspace,
  updateSharedWorkspacePolicy,
  type SharedWorkspaceSnapshot,
  type SharedWorkspaceUpsertMutation
} from '../src/shared/shared-workspace'

const T0 = '2026-08-25T10:00:00Z'

describe('corp/fleet shared workspace', () => {
  it('requires explicit current-policy and per-collection consent', () => {
    const workspace = createWorkspace()
    const mutation = watchlistMutation()

    expect(applySharedWorkspaceMutation(workspace, 10, mutation, T0)).toMatchObject({
      ok: false,
      code: 'consent-required'
    })

    const consented = acceptSharedWorkspaceConsent(workspace, {
      characterId: 10,
      policyVersion: 1,
      scopes: ['watchlist'],
      expectedWorkspaceRevision: 1
    }, '2026-08-25T10:01:00Z')

    expect(consented.members[0].consent?.scopes).toEqual(['watchlist'])
    expect(consented.members[0].consent?.scopes).not.toContain('local-presence')
    expect(applySharedWorkspaceMutation(consented, 10, doctrineMutation(), T0)).toMatchObject({
      ok: false,
      code: 'scope-not-consented'
    })
  })

  it('merges different records from stale cursors but conflicts on stale record revisions', () => {
    let workspace = consentOwner(createWorkspace(), ['watchlist', 'doctrines', 'routes'])
    const watchlist = applySharedWorkspaceMutation(workspace, 10, watchlistMutation(), '2026-08-25T10:02:00Z')
    expect(watchlist).toMatchObject({ ok: true, applied: true, staleBase: true })
    if (!watchlist.ok) throw new Error('watchlist mutation failed')
    workspace = watchlist.workspace

    const doctrine = applySharedWorkspaceMutation(workspace, 10, doctrineMutation(), '2026-08-25T10:03:00Z')
    expect(doctrine).toMatchObject({ ok: true, applied: true, staleBase: true })
    if (!doctrine.ok) throw new Error('doctrine mutation failed')
    workspace = doctrine.workspace

    const route = applySharedWorkspaceMutation(workspace, 10, routeMutation(), '2026-08-25T10:04:00Z')
    expect(route).toMatchObject({ ok: true, applied: true, staleBase: true })
    if (!route.ok) throw new Error('route mutation failed')
    workspace = route.workspace

    expect(workspace.records.map(({ collection, revision }) => ({ collection, revision }))).toEqual([
      { collection: 'doctrines', revision: 1 },
      { collection: 'routes', revision: 1 },
      { collection: 'watchlist', revision: 1 }
    ])
    expect(workspace.records.find(({ collection }) => collection === 'routes')?.payload)
      .toMatchObject({ avoidSystemIds: [30_000_142, 30_002_187] })

    const stale = applySharedWorkspaceMutation(workspace, 10, {
      ...watchlistMutation(),
      mutationId: 'mutation-watchlist-stale',
      expectedRevision: 0
    }, '2026-08-25T10:05:00Z')
    expect(stale).toMatchObject({
      ok: false,
      code: 'conflict',
      currentRecord: { revision: 1 }
    })
  })

  it('makes retry IDs idempotent and deletion a versioned tombstone', () => {
    let workspace = consentOwner(createWorkspace(), ['watchlist'])
    const created = applySharedWorkspaceMutation(workspace, 10, watchlistMutation(), T0)
    if (!created.ok) throw new Error('create failed')
    workspace = created.workspace

    const replay = applySharedWorkspaceMutation(workspace, 10, watchlistMutation(), T0)
    expect(replay).toMatchObject({ ok: true, applied: false, change: null })
    if (!replay.ok) throw new Error('replay failed')
    expect(replay.workspace.revision).toBe(workspace.revision)

    const deleted = applySharedWorkspaceMutation(workspace, 10, {
      operation: 'delete',
      mutationId: 'mutation-watchlist-delete',
      collection: 'watchlist',
      recordId: 'hostiles',
      expectedRevision: 1,
      baseWorkspaceRevision: workspace.revision
    }, '2026-08-25T10:06:00Z')
    expect(deleted).toMatchObject({
      ok: true,
      applied: true,
      record: { revision: 2, payload: null, deletedAt: '2026-08-25T10:06:00.000Z' }
    })
  })

  it('enforces roles after each member accepts policy', () => {
    let workspace = consentOwner(createWorkspace(), ['watchlist'])
    workspace = addSharedWorkspaceMember(workspace, 10, {
      characterId: 20,
      characterName: 'Fleet Viewer',
      role: 'viewer'
    }, workspace.revision, '2026-08-25T10:02:00Z')
    workspace = acceptSharedWorkspaceConsent(workspace, {
      characterId: 20,
      policyVersion: 1,
      scopes: ['watchlist'],
      expectedWorkspaceRevision: workspace.revision
    }, '2026-08-25T10:03:00Z')

    expect(applySharedWorkspaceMutation(workspace, 20, watchlistMutation(), T0)).toMatchObject({
      ok: false,
      code: 'forbidden'
    })
  })

  it('invalidates old consent when owner publishes a newer policy', () => {
    let workspace = consentOwner(createWorkspace(), ['watchlist', 'local-presence'])
    workspace = updateSharedWorkspacePolicy(
      workspace,
      10,
      2,
      workspace.revision,
      '2026-08-25T10:05:00Z'
    )

    expect(applySharedWorkspaceMutation(workspace, 10, watchlistMutation(), T0)).toMatchObject({
      ok: false,
      code: 'consent-required'
    })
    expect(() => acceptSharedWorkspaceConsent(workspace, {
      characterId: 10,
      policyVersion: 1,
      scopes: ['watchlist'],
      expectedWorkspaceRevision: workspace.revision
    }, T0)).toThrow(SharedWorkspaceDomainError)
  })
})

function createWorkspace(): SharedWorkspaceSnapshot {
  return createSharedWorkspace({
    workspaceId: 'corp-42',
    name: 'Corp Operations',
    policyVersion: 1,
    owner: { characterId: 10, characterName: 'Fleet Boss' }
  }, T0)
}

function consentOwner(
  workspace: SharedWorkspaceSnapshot,
  scopes: Array<'watchlist' | 'doctrines' | 'routes' | 'local-presence'>
): SharedWorkspaceSnapshot {
  return acceptSharedWorkspaceConsent(workspace, {
    characterId: 10,
    policyVersion: 1,
    scopes,
    expectedWorkspaceRevision: workspace.revision
  }, '2026-08-25T10:01:00Z')
}

function watchlistMutation(): Extract<SharedWorkspaceUpsertMutation, { collection: 'watchlist' }> {
  return {
    operation: 'upsert',
    mutationId: 'mutation-watchlist-1',
    collection: 'watchlist',
    recordId: 'hostiles',
    expectedRevision: 0,
    baseWorkspaceRevision: 1,
    payload: {
      entityType: 'corporation',
      entityId: 98_000_001,
      name: 'Hostile Corp',
      severity: 'critical',
      tags: ['war-target'],
      note: 'Report in intel'
    }
  }
}

function doctrineMutation(): Extract<SharedWorkspaceUpsertMutation, { collection: 'doctrines' }> {
  return {
    operation: 'upsert',
    mutationId: 'mutation-doctrine-1',
    collection: 'doctrines',
    recordId: 'shield-roam',
    expectedRevision: 0,
    baseWorkspaceRevision: 1,
    payload: {
      name: 'Shield Roam',
      description: null,
      ships: [{ typeId: 11_987, minimum: 5, maximum: 20, role: 'damage' }],
      tags: ['roam']
    }
  }
}

function routeMutation(): Extract<SharedWorkspaceUpsertMutation, { collection: 'routes' }> {
  return {
    operation: 'upsert',
    mutationId: 'mutation-route-1',
    collection: 'routes',
    recordId: 'jita-amarr',
    expectedRevision: 0,
    baseWorkspaceRevision: 1,
    payload: {
      name: 'Jita to Amarr',
      origin: 'Jita',
      destination: 'Amarr',
      mode: 'secure',
      avoidSystemIds: [30_002_187, 30_000_142, 30_002_187],
      tags: ['logistics']
    }
  }
}
