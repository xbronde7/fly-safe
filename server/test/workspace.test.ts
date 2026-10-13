import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Principal } from '../src/domain.js'
import { ServiceError } from '../src/domain.js'
import type { WorkspaceMutation } from '../src/workspace-domain.js'
import { createFixture, PRINCIPAL } from './fixture.js'

const COMMANDER: Principal = {
  characterId: '90000002',
  characterName: 'Fleet Commander',
  scopes: []
}

const VIEWER: Principal = {
  characterId: '90000003',
  characterName: 'Fleet Viewer',
  scopes: []
}

const OUTSIDER: Principal = {
  characterId: '90000004',
  characterName: 'Outsider',
  scopes: []
}

const WORKSPACE_ID = 'workspace-test-01'

describe('character-authenticated shared workspaces', () => {
  it('enforces consent, optimistic record revisions, and mutation idempotency', () => {
    const fixture = createFixture()
    try {
      const created = fixture.workspaces.createWorkspace(PRINCIPAL, {
        workspaceId: WORKSPACE_ID,
        name: 'Test Fleet',
        policyVersion: 1,
        mutationId: 'mutation-create-01'
      })
      assert.equal(created.applied, true)
      assert.equal(created.workspace.revision, 1)
      assert.equal(created.workspace.members[0]?.consent, null)

      assertServiceError(() => fixture.workspaces.addMember(PRINCIPAL, WORKSPACE_ID, {
        characterId: COMMANDER.characterId,
        characterName: COMMANDER.characterName,
        role: 'commander',
        expectedWorkspaceRevision: 1,
        mutationId: 'mutation-member-01'
      }), 'consent_required', 403)

      const consent = fixture.workspaces.acceptConsent(PRINCIPAL, WORKSPACE_ID, {
        policyVersion: 1,
        scopes: ['watchlist', 'routes'],
        expectedWorkspaceRevision: 1,
        mutationId: 'mutation-consent-01'
      })
      assert.equal(consent.workspace.revision, 2)
      const replayedConsent = fixture.workspaces.acceptConsent(PRINCIPAL, WORKSPACE_ID, {
        policyVersion: 1,
        scopes: ['watchlist', 'routes'],
        expectedWorkspaceRevision: 1,
        mutationId: 'mutation-consent-01'
      })
      assert.equal(replayedConsent.applied, false)
      assert.equal(replayedConsent.workspace.revision, 2)
      assertServiceError(() => fixture.workspaces.acceptConsent(PRINCIPAL, WORKSPACE_ID, {
        policyVersion: 1,
        scopes: ['watchlist'],
        expectedWorkspaceRevision: 1,
        mutationId: 'mutation-consent-01'
      }), 'mutation_id_reused', 409)

      const withCommander = fixture.workspaces.addMember(PRINCIPAL, WORKSPACE_ID, {
        characterId: COMMANDER.characterId,
        characterName: 'Unverified invite name',
        role: 'commander',
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-member-01'
      })
      assert.equal(withCommander.workspace.revision, 3)
      assert.equal(fixture.workspaces.getWorkspace(COMMANDER, WORKSPACE_ID).records.length, 0)

      fixture.workspaces.acceptConsent(COMMANDER, WORKSPACE_ID, {
        policyVersion: 1,
        scopes: ['watchlist'],
        expectedWorkspaceRevision: 3,
        mutationId: 'mutation-consent-02'
      })
      assert.equal(
        fixture.workspaces.getWorkspace(COMMANDER, WORKSPACE_ID).members
          .find((member) => member.characterId === COMMANDER.characterId)?.characterName,
        COMMANDER.characterName
      )

      const mutation: WorkspaceMutation = {
        operation: 'upsert',
        mutationId: 'mutation-record-01',
        collection: 'watchlist',
        recordId: 'watchlist-record-01',
        expectedRevision: 0,
        baseWorkspaceRevision: 4,
        payload: {
          entityType: 'character',
          entityId: '90009999',
          name: 'Known Scout',
          severity: 'danger',
          tags: ['scout'],
          note: null
        }
      }
      const applied = fixture.workspaces.applyMutation(COMMANDER, WORKSPACE_ID, mutation)
      assert.equal(applied.ok, true)
      if (!applied.ok) assert.fail('Mutation should apply')
      assert.equal(applied.applied, true)
      assert.equal(applied.record.revision, 1)
      assert.equal(applied.workspace.revision, 5)

      const independent = fixture.workspaces.applyMutation(COMMANDER, WORKSPACE_ID, {
        ...mutation,
        mutationId: 'mutation-record-independent',
        recordId: 'watchlist-record-02'
      })
      assert.equal(independent.ok, true)
      if (!independent.ok) assert.fail('Independent stale-base mutation should merge')
      assert.equal(independent.staleBase, true)
      assert.equal(independent.workspace.revision, 6)

      const updated = fixture.workspaces.applyMutation(COMMANDER, WORKSPACE_ID, {
        ...mutation,
        mutationId: 'mutation-record-update',
        expectedRevision: 1,
        baseWorkspaceRevision: 6,
        payload: { ...mutation.payload, severity: 'critical' }
      })
      assert.equal(updated.ok, true)
      if (!updated.ok) assert.fail('Record update should apply')
      assert.equal(updated.record.revision, 2)

      const replayed = fixture.workspaces.applyMutation(COMMANDER, WORKSPACE_ID, mutation)
      assert.equal(replayed.ok, true)
      if (!replayed.ok) assert.fail('Mutation replay should succeed')
      assert.equal(replayed.applied, false)
      assert.equal(replayed.record.revision, 1)
      assert.equal(replayed.record.payload?.severity, 'danger')
      assert.equal(replayed.staleBase, false)

      const reused = fixture.workspaces.applyMutation(COMMANDER, WORKSPACE_ID, {
        ...mutation,
        recordId: 'watchlist-record-02'
      })
      assert.deepEqual(reused.ok ? null : reused.code, 'mutation-id-reused')

      const conflict = fixture.workspaces.applyMutation(COMMANDER, WORKSPACE_ID, {
        ...mutation,
        mutationId: 'mutation-record-02',
        expectedRevision: 0
      })
      assert.equal(conflict.ok, false)
      if (conflict.ok) assert.fail('Stale record revision must conflict')
      assert.equal(conflict.code, 'conflict')
      assert.equal(conflict.currentRecord?.revision, 2)

      const page = fixture.workspaces.pullChanges(COMMANDER, WORKSPACE_ID, 0)
      assert.equal(page.throughWorkspaceRevision, 7)
      assert.equal(page.changes.length, 3)
      assert.equal(page.records[0]?.recordId, 'watchlist-record-01')

      fixture.workspaces.revokeConsent(COMMANDER, WORKSPACE_ID, {
        expectedWorkspaceRevision: 7,
        mutationId: 'mutation-commander-revoke'
      })
      const privacyDenied = fixture.workspaces.applyMutation(COMMANDER, WORKSPACE_ID, {
        ...mutation,
        mutationId: 'mutation-record-guessed',
        expectedRevision: 2,
        baseWorkspaceRevision: 8
      })
      assert.equal(privacyDenied.ok, false)
      if (privacyDenied.ok) assert.fail('Revoked member must not read guessed current record')
      assert.equal(privacyDenied.code, 'consent-required')
      assert.equal(privacyDenied.currentRecord, null)
    } finally {
      fixture.store.close()
    }
  })

  it('enforces owner/member roles and invalidates consent when policy advances', () => {
    const fixture = createFixture()
    try {
      bootstrapOwner(fixture)
      fixture.workspaces.addMember(PRINCIPAL, WORKSPACE_ID, {
        characterId: VIEWER.characterId,
        characterName: VIEWER.characterName,
        role: 'viewer',
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-member-viewer'
      })
      fixture.workspaces.acceptConsent(VIEWER, WORKSPACE_ID, {
        policyVersion: 1,
        scopes: ['routes'],
        expectedWorkspaceRevision: 3,
        mutationId: 'mutation-consent-viewer'
      })

      const viewerWrite = fixture.workspaces.applyMutation(VIEWER, WORKSPACE_ID, routeMutation({
        mutationId: 'mutation-viewer-write',
        baseWorkspaceRevision: 4
      }))
      assert.equal(viewerWrite.ok, false)
      if (!viewerWrite.ok) assert.equal(viewerWrite.code, 'forbidden')

      assertServiceError(() => fixture.workspaces.addMember(VIEWER, WORKSPACE_ID, {
        characterId: COMMANDER.characterId,
        characterName: COMMANDER.characterName,
        role: 'editor',
        expectedWorkspaceRevision: 4,
        mutationId: 'mutation-viewer-member'
      }), 'forbidden', 403)

      fixture.workspaces.setMemberRole(PRINCIPAL, WORKSPACE_ID, VIEWER.characterId, {
        role: 'editor',
        expectedWorkspaceRevision: 4,
        mutationId: 'mutation-promote-viewer'
      })
      const editorWrite = fixture.workspaces.applyMutation(VIEWER, WORKSPACE_ID, routeMutation({
        mutationId: 'mutation-editor-write',
        baseWorkspaceRevision: 5
      }))
      assert.equal(editorWrite.ok, true)

      const policy = fixture.workspaces.updatePolicy(PRINCIPAL, WORKSPACE_ID, {
        policyVersion: 2,
        expectedWorkspaceRevision: 6,
        mutationId: 'mutation-policy-02'
      })
      assert.equal(policy.workspace.policyVersion, 2)
      assert.equal(policy.workspace.members.every((member) => member.consent === null), true)
      assert.equal(fixture.workspaces.getWorkspace(VIEWER, WORKSPACE_ID).records.length, 0)
      const denied = fixture.workspaces.applyMutation(VIEWER, WORKSPACE_ID, routeMutation({
        mutationId: 'mutation-policy-denied',
        expectedRevision: 1,
        baseWorkspaceRevision: 7
      }))
      assert.equal(denied.ok, false)
      if (!denied.ok) assert.equal(denied.code, 'consent-required')
    } finally {
      fixture.store.close()
    }
  })

  it('never stores or discloses Local presence without current explicit consent', () => {
    const fixture = createFixture()
    try {
      fixture.workspaces.createWorkspace(PRINCIPAL, {
        workspaceId: WORKSPACE_ID,
        name: 'Presence Fleet',
        policyVersion: 1,
        mutationId: 'mutation-create-presence'
      })
      fixture.workspaces.acceptConsent(PRINCIPAL, WORKSPACE_ID, {
        policyVersion: 1,
        scopes: ['watchlist'],
        expectedWorkspaceRevision: 1,
        mutationId: 'mutation-owner-no-local'
      })
      assertServiceError(() => fixture.workspaces.upsertPresence(PRINCIPAL, WORKSPACE_ID, {
        solarSystemId: '30000142',
        solarSystemName: 'Jita',
        ttlSeconds: 120,
        expectedRevision: 0,
        mutationId: 'mutation-presence-denied'
      }), 'scope_not_consented', 403)
      assert.equal(presenceRowCount(fixture, WORKSPACE_ID), 0)

      fixture.workspaces.acceptConsent(PRINCIPAL, WORKSPACE_ID, {
        policyVersion: 1,
        scopes: ['watchlist', 'local-presence'],
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-owner-local'
      })
      const presence = fixture.workspaces.upsertPresence(PRINCIPAL, WORKSPACE_ID, {
        solarSystemId: '30000142',
        solarSystemName: 'Jita',
        ttlSeconds: 120,
        expectedRevision: 0,
        mutationId: 'mutation-presence-owner'
      })
      assert.equal(presence.presence?.characterId, PRINCIPAL.characterId)
      assert.equal(fixture.workspaces.listPresence(PRINCIPAL, WORKSPACE_ID).length, 1)
      assertServiceError(
        () => fixture.workspaces.listPresence(OUTSIDER, WORKSPACE_ID),
        'workspace_not_found',
        404
      )

      fixture.workspaces.addMember(PRINCIPAL, WORKSPACE_ID, {
        characterId: COMMANDER.characterId,
        characterName: COMMANDER.characterName,
        role: 'commander',
        expectedWorkspaceRevision: 3,
        mutationId: 'mutation-member-local'
      })
      fixture.workspaces.acceptConsent(COMMANDER, WORKSPACE_ID, {
        policyVersion: 1,
        scopes: ['local-presence'],
        expectedWorkspaceRevision: 4,
        mutationId: 'mutation-commander-local'
      })
      fixture.workspaces.upsertPresence(COMMANDER, WORKSPACE_ID, {
        solarSystemId: '30002187',
        solarSystemName: 'Amarr',
        ttlSeconds: 120,
        expectedRevision: 0,
        mutationId: 'mutation-presence-commander'
      })
      assert.deepEqual(
        fixture.workspaces.listPresence(COMMANDER, WORKSPACE_ID).map((entry) => entry.characterId).sort(),
        [PRINCIPAL.characterId, COMMANDER.characterId].sort()
      )

      fixture.workspaces.revokeConsent(PRINCIPAL, WORKSPACE_ID, {
        expectedWorkspaceRevision: 5,
        mutationId: 'mutation-owner-revoke'
      })
      assert.equal(presenceRowCountFor(fixture, WORKSPACE_ID, PRINCIPAL.characterId), 0)
      const tombstone = fixture.store.database.prepare(`
        SELECT active, solar_system_id, solar_system_name, observed_at, expires_at
        FROM shared_workspace_presence WHERE workspace_id = ? AND character_id = ?
      `).get(WORKSPACE_ID, PRINCIPAL.characterId) as Record<string, unknown>
      assert.deepEqual(tombstone, {
        active: 0,
        solar_system_id: null,
        solar_system_name: null,
        observed_at: null,
        expires_at: null
      })
      assert.deepEqual(
        fixture.workspaces.listPresence(COMMANDER, WORKSPACE_ID).map((entry) => entry.characterId),
        [COMMANDER.characterId]
      )
      assertServiceError(
        () => fixture.workspaces.listPresence(PRINCIPAL, WORKSPACE_ID),
        'consent_required',
        403
      )

      const repeatRevoke = fixture.workspaces.revokeConsent(PRINCIPAL, WORKSPACE_ID, {
        expectedWorkspaceRevision: 6,
        mutationId: 'mutation-owner-revoke-again'
      })
      assert.equal(repeatRevoke.applied, false)
      assert.equal(repeatRevoke.workspace.revision, 6)

      const history = fixture.workspaces.getConsentHistory(PRINCIPAL, WORKSPACE_ID)
      assert.equal(history.length, 3)
      assert.equal(history[0]?.event, 'revoked')
      assert.equal(history[0]?.revokedAt, 1_700_000_000)
      assert.equal(history[1]?.event, 'accepted')
      assert.deepEqual(history[2]?.scopes, ['watchlist'])
    } finally {
      fixture.store.close()
    }
  })

  it('expires presence and deletes every presence row at a policy boundary', () => {
    const fixture = createFixture()
    try {
      fixture.workspaces.createWorkspace(PRINCIPAL, {
        workspaceId: WORKSPACE_ID,
        name: 'Expiry Fleet',
        policyVersion: 1,
        mutationId: 'mutation-create-expiry'
      })
      fixture.workspaces.acceptConsent(PRINCIPAL, WORKSPACE_ID, {
        policyVersion: 1,
        scopes: ['local-presence'],
        expectedWorkspaceRevision: 1,
        mutationId: 'mutation-consent-expiry'
      })
      fixture.workspaces.upsertPresence(PRINCIPAL, WORKSPACE_ID, {
        solarSystemId: '30000142',
        ttlSeconds: 30,
        expectedRevision: 0,
        mutationId: 'mutation-presence-expiry'
      })
      fixture.setNow(1_700_000_031)
      assert.deepEqual(fixture.workspaces.listPresence(PRINCIPAL, WORKSPACE_ID), [])
      assert.equal(presenceRowCount(fixture, WORKSPACE_ID), 0)

      assertServiceError(() => fixture.workspaces.upsertPresence(PRINCIPAL, WORKSPACE_ID, {
        solarSystemId: '30000142',
        ttlSeconds: 30,
        expectedRevision: 0,
        mutationId: 'mutation-presence-again'
      }), 'presence_conflict', 409)
      fixture.workspaces.upsertPresence(PRINCIPAL, WORKSPACE_ID, {
        solarSystemId: '30000142',
        ttlSeconds: 30,
        expectedRevision: 2,
        mutationId: 'mutation-presence-again-retry'
      })
      fixture.workspaces.updatePolicy(PRINCIPAL, WORKSPACE_ID, {
        policyVersion: 2,
        expectedWorkspaceRevision: 2,
        mutationId: 'mutation-policy-expiry'
      })
      assert.equal(presenceRowCount(fixture, WORKSPACE_ID), 0)
    } finally {
      fixture.store.close()
    }
  })
})

function bootstrapOwner(fixture: ReturnType<typeof createFixture>): void {
  fixture.workspaces.createWorkspace(PRINCIPAL, {
    workspaceId: WORKSPACE_ID,
    name: 'Role Fleet',
    policyVersion: 1,
    mutationId: 'mutation-create-role'
  })
  fixture.workspaces.acceptConsent(PRINCIPAL, WORKSPACE_ID, {
    policyVersion: 1,
    scopes: ['watchlist', 'doctrines', 'routes', 'local-presence'],
    expectedWorkspaceRevision: 1,
    mutationId: 'mutation-owner-consent'
  })
}

function routeMutation(overrides: Partial<WorkspaceMutation> = {}): WorkspaceMutation {
  return {
    operation: 'upsert',
    mutationId: 'mutation-route-01',
    collection: 'routes',
    recordId: 'route-record-01',
    expectedRevision: 0,
    baseWorkspaceRevision: 0,
    payload: {
      name: 'Trade route',
      origin: 'Jita',
      destination: 'Amarr',
      mode: 'secure',
      avoidSystemIds: [],
      tags: ['trade']
    },
    ...overrides
  } as WorkspaceMutation
}

function assertServiceError(work: () => unknown, code: string, httpStatus: number): void {
  assert.throws(work, (error: unknown) =>
    error instanceof ServiceError && error.code === code && error.httpStatus === httpStatus
  )
}

function presenceRowCount(fixture: ReturnType<typeof createFixture>, workspaceId: string): number {
  const row = fixture.store.database.prepare(`
    SELECT COUNT(*) AS count FROM shared_workspace_presence WHERE workspace_id = ? AND active = 1
  `).get(workspaceId) as { count: number }
  return row.count
}

function presenceRowCountFor(
  fixture: ReturnType<typeof createFixture>,
  workspaceId: string,
  characterId: string
): number {
  const row = fixture.store.database.prepare(`
    SELECT COUNT(*) AS count FROM shared_workspace_presence
    WHERE workspace_id = ? AND character_id = ? AND active = 1
  `).get(workspaceId, characterId) as { count: number }
  return row.count
}
