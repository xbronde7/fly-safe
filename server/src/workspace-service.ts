import { createHash } from 'node:crypto'
import type { Principal } from './domain.js'
import { ServiceError, assertCharacterId } from './domain.js'
import type { SqliteBillingStore } from './store.js'
import {
  WORKSPACE_COLLECTIONS,
  WORKSPACE_CONSENT_SCOPES,
  WORKSPACE_ROLES,
  type WorkspaceChange,
  type WorkspaceCollection,
  type WorkspaceConsent,
  type WorkspaceConsentScope,
  type WorkspaceMember,
  type WorkspaceMutation,
  type WorkspaceMutationResult,
  type WorkspaceOperationResult,
  type WorkspacePresence,
  type WorkspacePullPage,
  type WorkspaceRecord,
  type WorkspaceRole,
  type WorkspaceSnapshot,
  type WorkspaceSummary
} from './workspace-domain.js'

const MAX_PULL_LIMIT = 500
const DEFAULT_PULL_LIMIT = 100

interface WorkspaceServiceOptions {
  store: SqliteBillingStore
  now?: (() => number) | undefined
}

interface StoredOperation {
  mutationId: string
  operationKind: string
  actorCharacterId: string
  requestHash: string
  resultWorkspaceRevision: number
  recordCollection: WorkspaceCollection | null
  recordId: string | null
  recordRevision: number | null
  resultRecord: WorkspaceRecord | null
  resultChange: WorkspaceChange | null
  staleBase: boolean | null
}

interface WorkspaceRow {
  id: string
  name: string
  policyVersion: number
  revision: number
  ownerCharacterId: string
  createdAt: number
  updatedAt: number
}

export class WorkspaceService {
  readonly store: SqliteBillingStore
  private readonly now: () => number

  constructor(options: WorkspaceServiceOptions) {
    this.store = options.store
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  }

  createWorkspace(
    principal: Principal,
    input: { workspaceId: string; name: string; policyVersion: number; mutationId: string }
  ): WorkspaceOperationResult {
    const workspaceId = normalizedId(input.workspaceId, 'workspaceId')
    const name = normalizedText(input.name, 'name', 120)
    const policyVersion = positiveInteger(input.policyVersion, 'policyVersion')
    const mutationId = normalizedId(input.mutationId, 'mutationId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const characterName = normalizedText(principal.characterName, 'characterName', 100)
    const requestHash = hashRequest({ workspaceId, name, policyVersion })

    return this.store.immediateTransaction(() => {
      const existing = this.findWorkspace(workspaceId)
      if (existing) {
        const operation = this.findOperation(workspaceId, mutationId)
        if (operation && operation.operationKind === 'create' &&
            operation.actorCharacterId === actorCharacterId && operation.requestHash === requestHash) {
          return { applied: false, workspace: this.snapshot(existing, actorCharacterId) }
        }
        if (operation) this.throwMutationIdReused()
        throw new ServiceError('workspace_exists', 'Workspace ID is already in use', 409)
      }

      const now = this.currentTime()
      this.store.database.prepare(`
        INSERT INTO shared_workspaces (
          id, name, policy_version, revision, owner_character_id, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(workspaceId, name, policyVersion, actorCharacterId, now, now)
      this.store.database.prepare(`
        INSERT INTO shared_workspace_members (
          workspace_id, character_id, character_name, role, joined_at, updated_at
        ) VALUES (?, ?, ?, 'owner', ?, ?)
      `).run(workspaceId, actorCharacterId, characterName, now, now)
      this.saveOperation({
        workspaceId,
        mutationId,
        operationKind: 'create',
        actorCharacterId,
        requestHash,
        resultWorkspaceRevision: 1,
        recordCollection: null,
        recordId: null,
        recordRevision: null,
        createdAt: now
      })
      return {
        applied: true,
        workspace: this.snapshot(this.requireWorkspace(workspaceId), actorCharacterId)
      }
    })
  }

  listWorkspaces(principal: Principal): WorkspaceSummary[] {
    const actorCharacterId = assertCharacterId(principal.characterId)
    return this.store.transaction(() => {
      const rows = this.store.database.prepare(`
        SELECT
          w.id, w.name, w.policy_version, w.revision, w.created_at, w.updated_at,
          m.role
        FROM shared_workspaces w
        JOIN shared_workspace_members m ON m.workspace_id = w.id
        WHERE m.character_id = ?
        ORDER BY w.updated_at DESC, w.id
      `).all(actorCharacterId)
      return rows.map((row): WorkspaceSummary => {
        const record = asRecord(row)
        const workspaceId = stringField(record, 'id')
        const policyVersion = integerField(record, 'policy_version')
        return {
          workspaceId,
          name: stringField(record, 'name'),
          policyVersion,
          revision: integerField(record, 'revision'),
          role: enumField(record, 'role', WORKSPACE_ROLES),
          consent: this.currentConsent(workspaceId, actorCharacterId, policyVersion),
          createdAt: integerField(record, 'created_at'),
          updatedAt: integerField(record, 'updated_at')
        }
      })
    })
  }

  getWorkspace(principal: Principal, workspaceIdInput: string): WorkspaceSnapshot {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    return this.store.transaction(() =>
      this.snapshot(this.requireVisibleWorkspace(workspaceId, actorCharacterId), actorCharacterId)
    )
  }

  listMembers(principal: Principal, workspaceIdInput: string): readonly WorkspaceMember[] {
    return this.getWorkspace(principal, workspaceIdInput).members
  }

  getConsentHistory(
    principal: Principal,
    workspaceIdInput: string
  ): ReadonlyArray<WorkspaceConsent & {
    event: 'accepted' | 'revoked'
    revokedAt: number | null
    occurredAt: number
  }> {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    return this.store.transaction(() => {
      this.requireVisibleWorkspace(workspaceId, actorCharacterId)
      return this.store.database.prepare(`
        SELECT event_type, policy_version, scopes_json, accepted_at, revoked_at, occurred_at
        FROM shared_workspace_consent_events
        WHERE workspace_id = ? AND character_id = ?
        ORDER BY id DESC
      `).all(workspaceId, actorCharacterId).map((row) => {
        const record = asRecord(row)
        return {
          event: enumField(record, 'event_type', ['accepted', 'revoked'] as const),
          policyVersion: integerField(record, 'policy_version'),
          scopes: parseScopes(stringField(record, 'scopes_json')),
          acceptedAt: integerField(record, 'accepted_at'),
          revokedAt: nullableInteger(record.revoked_at),
          occurredAt: integerField(record, 'occurred_at')
        }
      })
    })
  }

  acceptConsent(
    principal: Principal,
    workspaceIdInput: string,
    input: {
      policyVersion: number
      scopes: readonly unknown[]
      expectedWorkspaceRevision: number
      mutationId: string
    }
  ): WorkspaceOperationResult {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const actorCharacterName = normalizedText(principal.characterName, 'characterName', 100)
    const policyVersion = positiveInteger(input.policyVersion, 'policyVersion')
    const scopes = normalizeScopes(input.scopes)
    const expectedRevision = nonNegativeInteger(
      input.expectedWorkspaceRevision,
      'expectedWorkspaceRevision'
    )
    const mutationId = normalizedId(input.mutationId, 'mutationId')
    const requestHash = hashRequest({ policyVersion, scopes, expectedRevision })

    return this.workspaceOperation(
      workspaceId,
      actorCharacterId,
      mutationId,
      'consent.accept',
      requestHash,
      false,
      (workspace, now) => {
        const member = this.requireMember(workspace.id, actorCharacterId)
        this.requireWorkspaceRevision(workspace, expectedRevision)
        if (policyVersion !== workspace.policyVersion) {
          throw new ServiceError('invalid_consent', 'Consent policy version is not current', 409, {
            policyVersion: workspace.policyVersion
          })
        }
        const existing = this.currentConsent(workspace.id, actorCharacterId, workspace.policyVersion)
        if (existing && equalStringArrays(existing.scopes, scopes) &&
            member.characterName === actorCharacterName) {
          return workspace
        }
        this.store.database.prepare(`
          INSERT INTO shared_workspace_consent_events (
            workspace_id, character_id, policy_version, event_type, scopes_json,
            accepted_at, revoked_at, occurred_at
          ) VALUES (?, ?, ?, 'accepted', ?, ?, NULL, ?)
        `).run(workspace.id, actorCharacterId, policyVersion, JSON.stringify(scopes), now, now)
        // The invite name is only a hint. Consent proves this member is present, so refresh it
        // from the verified EVE JWT rather than trusting another member's request body.
        this.store.database.prepare(`
          UPDATE shared_workspace_members SET character_name = ?, updated_at = ?
          WHERE workspace_id = ? AND character_id = ?
        `).run(actorCharacterName, now, workspace.id, actorCharacterId)
        this.tombstonePresence(workspace.id, actorCharacterId, now, `consent:${mutationId}`)
        return this.bumpWorkspace(workspace, now)
      }
    )
  }

  revokeConsent(
    principal: Principal,
    workspaceIdInput: string,
    input: { expectedWorkspaceRevision: number; mutationId: string }
  ): WorkspaceOperationResult {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const expectedRevision = nonNegativeInteger(
      input.expectedWorkspaceRevision,
      'expectedWorkspaceRevision'
    )
    const mutationId = normalizedId(input.mutationId, 'mutationId')
    const requestHash = hashRequest({ expectedRevision })

    return this.workspaceOperation(
      workspaceId,
      actorCharacterId,
      mutationId,
      'consent.revoke',
      requestHash,
      false,
      (workspace, now) => {
        this.requireMember(workspace.id, actorCharacterId)
        this.requireWorkspaceRevision(workspace, expectedRevision)
        const consent = this.currentConsent(workspace.id, actorCharacterId, workspace.policyVersion)
        if (!consent) {
          this.tombstoneActivePresence(workspace.id, actorCharacterId, now, `consent:${mutationId}`)
          return workspace
        }
        this.store.database.prepare(`
          INSERT INTO shared_workspace_consent_events (
            workspace_id, character_id, policy_version, event_type, scopes_json,
            accepted_at, revoked_at, occurred_at
          ) VALUES (?, ?, ?, 'revoked', ?, ?, ?, ?)
        `).run(
          workspace.id,
          actorCharacterId,
          workspace.policyVersion,
          JSON.stringify(consent.scopes),
          consent.acceptedAt,
          now,
          now
        )
        this.tombstonePresence(workspace.id, actorCharacterId, now, `consent:${mutationId}`)
        return this.bumpWorkspace(workspace, now)
      }
    )
  }

  addMember(
    principal: Principal,
    workspaceIdInput: string,
    input: {
      characterId: string
      characterName: string
      role: WorkspaceRole
      expectedWorkspaceRevision: number
      mutationId: string
    }
  ): WorkspaceOperationResult {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const characterId = assertCharacterId(input.characterId)
    const characterName = normalizedText(input.characterName, 'characterName', 100)
    const role = assignableRole(input.role)
    const expectedRevision = nonNegativeInteger(
      input.expectedWorkspaceRevision,
      'expectedWorkspaceRevision'
    )
    const mutationId = normalizedId(input.mutationId, 'mutationId')
    const requestHash = hashRequest({ characterId, characterName, role, expectedRevision })

    return this.workspaceOperation(
      workspaceId,
      actorCharacterId,
      mutationId,
      'member.add',
      requestHash,
      true,
      (workspace, now) => {
        this.requireWorkspaceRevision(workspace, expectedRevision)
        if (this.findMember(workspace.id, characterId)) {
          throw new ServiceError('member_exists', 'Workspace member already exists', 409)
        }
        this.store.database.prepare(`
          INSERT INTO shared_workspace_members (
            workspace_id, character_id, character_name, role, joined_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(workspace.id, characterId, characterName, role, now, now)
        return this.bumpWorkspace(workspace, now)
      }
    )
  }

  setMemberRole(
    principal: Principal,
    workspaceIdInput: string,
    memberCharacterIdInput: string,
    input: { role: WorkspaceRole; expectedWorkspaceRevision: number; mutationId: string }
  ): WorkspaceOperationResult {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const memberCharacterId = assertCharacterId(memberCharacterIdInput)
    const role = assignableRole(input.role)
    const expectedRevision = nonNegativeInteger(
      input.expectedWorkspaceRevision,
      'expectedWorkspaceRevision'
    )
    const mutationId = normalizedId(input.mutationId, 'mutationId')
    const requestHash = hashRequest({ memberCharacterId, role, expectedRevision })

    return this.workspaceOperation(
      workspaceId,
      actorCharacterId,
      mutationId,
      'member.role',
      requestHash,
      true,
      (workspace, now) => {
        this.requireWorkspaceRevision(workspace, expectedRevision)
        const member = this.requireMember(workspace.id, memberCharacterId)
        if (member.role === 'owner') {
          throw new ServiceError('forbidden', 'Owner role cannot be changed', 403)
        }
        this.store.database.prepare(`
          UPDATE shared_workspace_members SET role = ?, updated_at = ?
          WHERE workspace_id = ? AND character_id = ?
        `).run(role, now, workspace.id, memberCharacterId)
        return this.bumpWorkspace(workspace, now)
      }
    )
  }

  removeMember(
    principal: Principal,
    workspaceIdInput: string,
    memberCharacterIdInput: string,
    input: { expectedWorkspaceRevision: number; mutationId: string }
  ): WorkspaceOperationResult {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const memberCharacterId = assertCharacterId(memberCharacterIdInput)
    const expectedRevision = nonNegativeInteger(
      input.expectedWorkspaceRevision,
      'expectedWorkspaceRevision'
    )
    const mutationId = normalizedId(input.mutationId, 'mutationId')
    const requestHash = hashRequest({ memberCharacterId, expectedRevision })

    return this.workspaceOperation(
      workspaceId,
      actorCharacterId,
      mutationId,
      'member.remove',
      requestHash,
      true,
      (workspace, now) => {
        this.requireWorkspaceRevision(workspace, expectedRevision)
        const member = this.requireMember(workspace.id, memberCharacterId)
        if (member.role === 'owner') throw new ServiceError('forbidden', 'Owner cannot be removed', 403)
        const consent = this.currentConsent(workspace.id, memberCharacterId, workspace.policyVersion)
        if (consent) {
          this.store.database.prepare(`
            INSERT INTO shared_workspace_consent_events (
              workspace_id, character_id, policy_version, event_type, scopes_json,
              accepted_at, revoked_at, occurred_at
            ) VALUES (?, ?, ?, 'revoked', ?, ?, ?, ?)
          `).run(
            workspace.id,
            memberCharacterId,
            workspace.policyVersion,
            JSON.stringify(consent.scopes),
            consent.acceptedAt,
            now,
            now
          )
        }
        this.tombstonePresence(workspace.id, memberCharacterId, now, `member:${mutationId}`)
        this.store.database.prepare(`
          DELETE FROM shared_workspace_members WHERE workspace_id = ? AND character_id = ?
        `).run(workspace.id, memberCharacterId)
        return this.bumpWorkspace(workspace, now)
      }
    )
  }

  updatePolicy(
    principal: Principal,
    workspaceIdInput: string,
    input: { policyVersion: number; expectedWorkspaceRevision: number; mutationId: string }
  ): WorkspaceOperationResult {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const policyVersion = positiveInteger(input.policyVersion, 'policyVersion')
    const expectedRevision = nonNegativeInteger(
      input.expectedWorkspaceRevision,
      'expectedWorkspaceRevision'
    )
    const mutationId = normalizedId(input.mutationId, 'mutationId')
    const requestHash = hashRequest({ policyVersion, expectedRevision })

    return this.workspaceOperation(
      workspaceId,
      actorCharacterId,
      mutationId,
      'policy.update',
      requestHash,
      true,
      (workspace, now) => {
        this.requireWorkspaceRevision(workspace, expectedRevision)
        if (policyVersion <= workspace.policyVersion) {
          throw new ServiceError('workspace_conflict', 'Policy version must increase', 409)
        }
        this.store.database.prepare(`
          UPDATE shared_workspaces
          SET policy_version = ?, revision = revision + 1, updated_at = ?
          WHERE id = ?
        `).run(policyVersion, now, workspace.id)
        // Presence is never carried across a policy boundary without fresh explicit consent.
        this.store.database.prepare(`
          UPDATE shared_workspace_presence
          SET solar_system_id = NULL, solar_system_name = NULL, active = 0,
            observed_at = NULL, expires_at = NULL, revision = revision + 1,
            last_mutation_id = ?, updated_at = ?
          WHERE workspace_id = ?
        `).run(`policy:${mutationId}`, now, workspace.id)
        return this.requireWorkspace(workspace.id)
      }
    )
  }

  listRecords(
    principal: Principal,
    workspaceIdInput: string,
    collectionInput?: string | undefined
  ): WorkspaceRecord[] {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    return this.store.transaction(() => {
      const workspace = this.requireVisibleWorkspace(workspaceId, actorCharacterId)
      const consent = this.requireCurrentConsent(workspace, actorCharacterId)
      if (collectionInput !== undefined) {
        const collection = normalizeCollection(collectionInput)
        this.requireConsentScope(consent, collection)
        return this.recordsForScopes(workspace.id, [collection])
      }
      return this.recordsForScopes(
        workspace.id,
        consent.scopes.filter(isWorkspaceCollection)
      )
    })
  }

  applyMutation(
    principal: Principal,
    workspaceIdInput: string,
    mutationInput: unknown
  ): WorkspaceMutationResult {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const mutation = normalizeMutation(mutationInput)
    const requestHash = hashRequest(mutation)

    return this.store.immediateTransaction(() => {
      const workspace = this.requireVisibleWorkspace(workspaceId, actorCharacterId)
      const member = this.requireMember(workspace.id, actorCharacterId)
      const consent = this.currentConsent(workspace.id, actorCharacterId, workspace.policyVersion)
      if (!consent) {
        return mutationFailure(
          workspace,
          'consent-required',
          'Current workspace policy is not accepted',
          null
        )
      }
      if (!consent.scopes.includes(mutation.collection)) {
        return mutationFailure(
          workspace,
          'scope-not-consented',
          `Member did not consent to share ${mutation.collection}`,
          null
        )
      }
      const current = this.findRecord(workspace.id, mutation.collection, mutation.recordId)
      if (member.role === 'viewer') {
        return mutationFailure(workspace, 'forbidden', 'Member role cannot edit shared records', current)
      }

      const previous = this.findOperation(workspace.id, mutation.mutationId)
      if (previous) {
        if (previous.operationKind !== 'record.mutate' ||
            previous.actorCharacterId !== actorCharacterId || previous.requestHash !== requestHash) {
          return mutationFailure(
            workspace,
            'mutation-id-reused',
            'Mutation ID was already used for another request',
            current
          )
        }
        const replayRecord = previous.resultRecord
        if (!replayRecord || previous.staleBase === null) {
          throw new ServiceError('internal_error', 'Applied mutation result is missing', 500)
        }
        return {
          ok: true,
          applied: false,
          staleBase: previous.staleBase,
          workspace: this.snapshot(workspace, actorCharacterId),
          record: replayRecord,
          change: null
        }
      }

      const currentRevision = current?.revision ?? 0
      if (mutation.expectedRevision !== currentRevision) {
        return mutationFailure(
          workspace,
          'conflict',
          `Expected record revision ${mutation.expectedRevision}; current revision is ${currentRevision}`,
          current
        )
      }
      if (mutation.operation === 'delete' && !current) {
        return mutationFailure(workspace, 'conflict', 'Cannot delete a missing record', null)
      }

      const now = this.currentTime()
      const recordRevision = currentRevision + 1
      const workspaceRevision = workspace.revision + 1
      const payloadJson = mutation.operation === 'upsert' ? JSON.stringify(mutation.payload) : null
      const deletedAt = mutation.operation === 'delete' ? now : null
      this.store.database.prepare(`
        INSERT INTO shared_workspace_records (
          workspace_id, collection, record_id, revision, workspace_revision,
          payload_json, updated_by_character_id, updated_at, deleted_at, last_mutation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, collection, record_id) DO UPDATE SET
          revision = excluded.revision,
          workspace_revision = excluded.workspace_revision,
          payload_json = excluded.payload_json,
          updated_by_character_id = excluded.updated_by_character_id,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          last_mutation_id = excluded.last_mutation_id
      `).run(
        workspace.id,
        mutation.collection,
        mutation.recordId,
        recordRevision,
        workspaceRevision,
        payloadJson,
        actorCharacterId,
        now,
        deletedAt,
        mutation.mutationId
      )
      this.store.database.prepare(`
        INSERT INTO shared_workspace_changes (
          workspace_id, workspace_revision, mutation_id, collection, record_id,
          record_revision, operation, changed_by_character_id, changed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        workspace.id,
        workspaceRevision,
        mutation.mutationId,
        mutation.collection,
        mutation.recordId,
        recordRevision,
        mutation.operation,
        actorCharacterId,
        now
      )
      const nextWorkspace = this.bumpWorkspace(workspace, now)
      const record = this.requireRecord(workspace.id, mutation.collection, mutation.recordId)
      const change: WorkspaceChange = {
        workspaceId: workspace.id,
        workspaceRevision,
        mutationId: mutation.mutationId,
        collection: mutation.collection,
        recordId: mutation.recordId,
        recordRevision,
        operation: mutation.operation,
        changedByCharacterId: actorCharacterId,
        changedAt: now
      }
      const staleBase = mutation.baseWorkspaceRevision < workspace.revision
      this.saveOperation({
        workspaceId: workspace.id,
        mutationId: mutation.mutationId,
        operationKind: 'record.mutate',
        actorCharacterId,
        requestHash,
        resultWorkspaceRevision: nextWorkspace.revision,
        recordCollection: mutation.collection,
        recordId: mutation.recordId,
        recordRevision,
        resultRecord: record,
        resultChange: change,
        staleBase,
        createdAt: now
      })
      return {
        ok: true,
        applied: true,
        staleBase,
        workspace: this.snapshot(nextWorkspace, actorCharacterId),
        record,
        change
      }
    })
  }

  pullChanges(
    principal: Principal,
    workspaceIdInput: string,
    afterWorkspaceRevisionInput: number,
    limitInput = DEFAULT_PULL_LIMIT
  ): WorkspacePullPage {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const afterWorkspaceRevision = nonNegativeInteger(
      afterWorkspaceRevisionInput,
      'afterWorkspaceRevision'
    )
    const limit = positiveInteger(limitInput, 'limit')
    if (limit > MAX_PULL_LIMIT) throw new ServiceError('invalid_limit', `limit cannot exceed ${MAX_PULL_LIMIT}`)
    return this.store.transaction(() => {
      const workspace = this.requireVisibleWorkspace(workspaceId, actorCharacterId)
      if (afterWorkspaceRevision > workspace.revision) {
        throw new ServiceError('workspace_conflict', 'Change cursor is ahead of workspace revision', 409, {
          workspaceRevision: workspace.revision
        })
      }
      const consent = this.requireCurrentConsent(workspace, actorCharacterId)
      const scopes = consent.scopes.filter(isWorkspaceCollection)
      if (scopes.length === 0) {
        return {
          workspaceId,
          fromWorkspaceRevision: afterWorkspaceRevision,
          throughWorkspaceRevision: workspace.revision,
          changes: [],
          records: [],
          hasMore: false
        }
      }
      const placeholders = scopes.map(() => '?').join(', ')
      const rows = this.store.database.prepare(`
        SELECT * FROM shared_workspace_changes
        WHERE workspace_id = ? AND workspace_revision > ?
          AND collection IN (${placeholders})
        ORDER BY workspace_revision
        LIMIT ?
      `).all(workspace.id, afterWorkspaceRevision, ...scopes, limit + 1)
      const hasMore = rows.length > limit
      const changes = rows.slice(0, limit).map(toChange)
      const throughWorkspaceRevision = hasMore
        ? changes.at(-1)?.workspaceRevision ?? afterWorkspaceRevision
        : workspace.revision
      const recordKeys = new Set(changes.map((change) => `${change.collection}\0${change.recordId}`))
      const records = this.recordsForScopes(workspace.id, scopes).filter((record) =>
        recordKeys.has(`${record.collection}\0${record.recordId}`)
      )
      return {
        workspaceId,
        fromWorkspaceRevision: afterWorkspaceRevision,
        throughWorkspaceRevision,
        changes,
        records,
        hasMore
      }
    })
  }

  upsertPresence(
    principal: Principal,
    workspaceIdInput: string,
    input: {
      solarSystemId: string
      solarSystemName?: string | null | undefined
      ttlSeconds: number
      expectedRevision: number
      mutationId: string
    }
  ): { applied: boolean; presence: WorkspacePresence | null } {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const solarSystemId = decimalId(input.solarSystemId, 'solarSystemId')
    const solarSystemName = input.solarSystemName === null || input.solarSystemName === undefined
      ? null
      : normalizedText(input.solarSystemName, 'solarSystemName', 100)
    const ttlSeconds = positiveInteger(input.ttlSeconds, 'ttlSeconds')
    if (ttlSeconds < 30 || ttlSeconds > 300) {
      throw new ServiceError('invalid_presence_ttl', 'ttlSeconds must be between 30 and 300')
    }
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const mutationId = normalizedId(input.mutationId, 'mutationId')
    const requestHash = hashRequest({ solarSystemId, solarSystemName, ttlSeconds, expectedRevision })

    return this.store.immediateTransaction(() => {
      const workspace = this.requireVisibleWorkspace(workspaceId, actorCharacterId)
      const consent = this.requireCurrentConsent(workspace, actorCharacterId)
      this.requireConsentScope(consent, 'local-presence')
      const now = this.currentTime()
      this.tombstoneExpiredPresence(workspace.id, actorCharacterId, now)
      this.prunePresenceOperations(workspace.id, actorCharacterId, now)
      const operation = this.findOperation(workspace.id, mutationId)
      if (operation) {
        this.requireMatchingOperation(operation, 'presence.upsert', actorCharacterId, requestHash)
        return { applied: false, presence: this.findActivePresence(workspace.id, actorCharacterId, now) }
      }
      const currentRevision = this.presenceRevision(workspace.id, actorCharacterId)
      if (expectedRevision !== currentRevision) {
        throw new ServiceError('presence_conflict', 'Presence revision conflict', 409, {
          expectedRevision,
          currentRevision
        })
      }
      const revision = currentRevision + 1
      this.store.database.prepare(`
        INSERT INTO shared_workspace_presence (
          workspace_id, character_id, solar_system_id, solar_system_name,
          revision, active, observed_at, expires_at, last_mutation_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, character_id) DO UPDATE SET
          solar_system_id = excluded.solar_system_id,
          solar_system_name = excluded.solar_system_name,
          revision = excluded.revision,
          active = 1,
          observed_at = excluded.observed_at,
          expires_at = excluded.expires_at,
          last_mutation_id = excluded.last_mutation_id,
          updated_at = excluded.updated_at
      `).run(
        workspace.id,
        actorCharacterId,
        solarSystemId,
        solarSystemName,
        revision,
        now,
        now + ttlSeconds,
        mutationId,
        now
      )
      this.saveOperation({
        workspaceId: workspace.id,
        mutationId,
        operationKind: 'presence.upsert',
        actorCharacterId,
        requestHash,
        resultWorkspaceRevision: workspace.revision,
        recordCollection: null,
        recordId: actorCharacterId,
        recordRevision: revision,
        createdAt: now
      })
      return { applied: true, presence: this.findActivePresence(workspace.id, actorCharacterId, now) }
    })
  }

  clearPresence(
    principal: Principal,
    workspaceIdInput: string,
    input: { expectedRevision: number; mutationId: string }
  ): { applied: boolean } {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    const expectedRevision = nonNegativeInteger(input.expectedRevision, 'expectedRevision')
    const mutationId = normalizedId(input.mutationId, 'mutationId')
    const requestHash = hashRequest({ expectedRevision })
    return this.store.immediateTransaction(() => {
      const workspace = this.requireVisibleWorkspace(workspaceId, actorCharacterId)
      const now = this.currentTime()
      this.tombstoneExpiredPresence(workspace.id, actorCharacterId, now)
      this.prunePresenceOperations(workspace.id, actorCharacterId, now)
      const operation = this.findOperation(workspace.id, mutationId)
      if (operation) {
        this.requireMatchingOperation(operation, 'presence.clear', actorCharacterId, requestHash)
        return { applied: false }
      }
      const currentRevision = this.presenceRevision(workspace.id, actorCharacterId)
      if (expectedRevision !== currentRevision) {
        throw new ServiceError('presence_conflict', 'Presence revision conflict', 409, {
          expectedRevision,
          currentRevision
        })
      }
      const revision = currentRevision + 1
      this.writePresenceTombstone(workspace.id, actorCharacterId, revision, now, mutationId)
      this.saveOperation({
        workspaceId: workspace.id,
        mutationId,
        operationKind: 'presence.clear',
        actorCharacterId,
        requestHash,
        resultWorkspaceRevision: workspace.revision,
        recordCollection: null,
        recordId: actorCharacterId,
        recordRevision: revision,
        createdAt: now
      })
      return { applied: true }
    })
  }

  listPresence(principal: Principal, workspaceIdInput: string): WorkspacePresence[] {
    const workspaceId = normalizedId(workspaceIdInput, 'workspaceId')
    const actorCharacterId = assertCharacterId(principal.characterId)
    return this.store.immediateTransaction(() => {
      const workspace = this.requireVisibleWorkspace(workspaceId, actorCharacterId)
      const actorConsent = this.requireCurrentConsent(workspace, actorCharacterId)
      this.requireConsentScope(actorConsent, 'local-presence')
      const now = this.currentTime()
      this.tombstoneAllExpiredPresence(workspace.id, now)
      const rows = this.store.database.prepare(`
        SELECT p.*, m.character_name
        FROM shared_workspace_presence p
        JOIN shared_workspace_members m
          ON m.workspace_id = p.workspace_id AND m.character_id = p.character_id
        WHERE p.workspace_id = ? AND p.active = 1 AND p.expires_at > ?
        ORDER BY m.character_name COLLATE NOCASE, p.character_id
      `).all(workspace.id, now)
      return rows.map(toPresence).filter((presence) => {
        const consent = this.currentConsent(workspace.id, presence.characterId, workspace.policyVersion)
        return consent?.scopes.includes('local-presence') === true
      })
    })
  }

  private workspaceOperation(
    workspaceId: string,
    actorCharacterId: string,
    mutationId: string,
    operationKind: string,
    requestHash: string,
    requireOwner: boolean,
    apply: (workspace: WorkspaceRow, now: number) => WorkspaceRow
  ): WorkspaceOperationResult {
    return this.store.immediateTransaction(() => {
      const workspace = this.requireVisibleWorkspace(workspaceId, actorCharacterId)
      const operation = this.findOperation(workspace.id, mutationId)
      if (operation) {
        this.requireMatchingOperation(operation, operationKind, actorCharacterId, requestHash)
        return { applied: false, workspace: this.snapshot(workspace, actorCharacterId) }
      }
      if (requireOwner) this.requireOwnerWithConsent(workspace, actorCharacterId)
      const now = this.currentTime()
      const nextWorkspace = apply(workspace, now)
      this.saveOperation({
        workspaceId: workspace.id,
        mutationId,
        operationKind,
        actorCharacterId,
        requestHash,
        resultWorkspaceRevision: nextWorkspace.revision,
        recordCollection: null,
        recordId: null,
        recordRevision: null,
        createdAt: now
      })
      return {
        applied: nextWorkspace.revision !== workspace.revision,
        workspace: this.snapshot(nextWorkspace, actorCharacterId)
      }
    })
  }

  private requireOwnerWithConsent(workspace: WorkspaceRow, actorCharacterId: string): void {
    const member = this.requireMember(workspace.id, actorCharacterId)
    if (member.role !== 'owner') throw new ServiceError('forbidden', 'Owner role required', 403)
    this.requireCurrentConsent(workspace, actorCharacterId)
  }

  private requireCurrentConsent(workspace: WorkspaceRow, characterId: string): WorkspaceConsent {
    const consent = this.currentConsent(workspace.id, characterId, workspace.policyVersion)
    if (!consent) {
      throw new ServiceError('consent_required', 'Current workspace policy is not accepted', 403, {
        policyVersion: workspace.policyVersion
      })
    }
    return consent
  }

  private requireConsentScope(consent: WorkspaceConsent, scope: WorkspaceConsentScope): void {
    if (!consent.scopes.includes(scope)) {
      throw new ServiceError('scope_not_consented', `Consent scope ${scope} is required`, 403, { scope })
    }
  }

  private snapshot(workspace: WorkspaceRow, actorCharacterId: string): WorkspaceSnapshot {
    this.requireMember(workspace.id, actorCharacterId)
    const members = this.store.database.prepare(`
      SELECT * FROM shared_workspace_members WHERE workspace_id = ?
      ORDER BY CASE role
        WHEN 'owner' THEN 0 WHEN 'commander' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
        character_name COLLATE NOCASE,
        character_id
    `).all(workspace.id).map((row): WorkspaceMember => {
      const record = asRecord(row)
      const characterId = stringField(record, 'character_id')
      return {
        characterId,
        characterName: stringField(record, 'character_name'),
        role: enumField(record, 'role', WORKSPACE_ROLES),
        consent: this.currentConsent(workspace.id, characterId, workspace.policyVersion),
        joinedAt: integerField(record, 'joined_at'),
        updatedAt: integerField(record, 'updated_at')
      }
    })
    const actorConsent = this.currentConsent(workspace.id, actorCharacterId, workspace.policyVersion)
    const scopes = actorConsent?.scopes.filter(isWorkspaceCollection) ?? []
    return {
      schemaVersion: 1,
      workspaceId: workspace.id,
      name: workspace.name,
      policyVersion: workspace.policyVersion,
      revision: workspace.revision,
      members,
      records: this.recordsForScopes(workspace.id, scopes),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt
    }
  }

  private recordsForScopes(
    workspaceId: string,
    scopes: readonly WorkspaceCollection[]
  ): WorkspaceRecord[] {
    if (scopes.length === 0) return []
    const placeholders = scopes.map(() => '?').join(', ')
    return this.store.database.prepare(`
      SELECT * FROM shared_workspace_records
      WHERE workspace_id = ? AND collection IN (${placeholders})
      ORDER BY collection, record_id
    `).all(workspaceId, ...scopes).map(toWorkspaceRecord)
  }

  private findWorkspace(workspaceId: string): WorkspaceRow | null {
    const row = this.store.database.prepare(
      'SELECT * FROM shared_workspaces WHERE id = ?'
    ).get(workspaceId)
    return row ? toWorkspaceRow(row) : null
  }

  private requireWorkspace(workspaceId: string): WorkspaceRow {
    const workspace = this.findWorkspace(workspaceId)
    if (!workspace) throw new ServiceError('workspace_not_found', 'Workspace not found', 404)
    return workspace
  }

  private requireVisibleWorkspace(workspaceId: string, characterId: string): WorkspaceRow {
    const workspace = this.requireWorkspace(workspaceId)
    if (!this.findMember(workspace.id, characterId)) {
      // Do not reveal whether a workspace exists to non-members.
      throw new ServiceError('workspace_not_found', 'Workspace not found', 404)
    }
    return workspace
  }

  private findMember(workspaceId: string, characterId: string): WorkspaceMember | null {
    const row = this.store.database.prepare(`
      SELECT * FROM shared_workspace_members WHERE workspace_id = ? AND character_id = ?
    `).get(workspaceId, characterId)
    if (!row) return null
    const record = asRecord(row)
    const workspace = this.requireWorkspace(workspaceId)
    return {
      characterId: stringField(record, 'character_id'),
      characterName: stringField(record, 'character_name'),
      role: enumField(record, 'role', WORKSPACE_ROLES),
      consent: this.currentConsent(workspaceId, characterId, workspace.policyVersion),
      joinedAt: integerField(record, 'joined_at'),
      updatedAt: integerField(record, 'updated_at')
    }
  }

  private requireMember(workspaceId: string, characterId: string): WorkspaceMember {
    const member = this.findMember(workspaceId, characterId)
    if (!member) throw new ServiceError('member_missing', 'Workspace member not found', 404)
    return member
  }

  private currentConsent(
    workspaceId: string,
    characterId: string,
    policyVersion: number
  ): WorkspaceConsent | null {
    const row = this.store.database.prepare(`
      SELECT * FROM shared_workspace_consent_events
      WHERE workspace_id = ? AND character_id = ? AND policy_version = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(workspaceId, characterId, policyVersion)
    if (!row) return null
    const record = asRecord(row)
    if (stringField(record, 'event_type') !== 'accepted') return null
    return {
      policyVersion: integerField(record, 'policy_version'),
      scopes: parseScopes(stringField(record, 'scopes_json')),
      acceptedAt: integerField(record, 'accepted_at')
    }
  }

  private bumpWorkspace(workspace: WorkspaceRow, now: number): WorkspaceRow {
    this.store.database.prepare(`
      UPDATE shared_workspaces SET revision = revision + 1, updated_at = ? WHERE id = ?
    `).run(now, workspace.id)
    return this.requireWorkspace(workspace.id)
  }

  private requireWorkspaceRevision(workspace: WorkspaceRow, expected: number): void {
    if (workspace.revision !== expected) {
      throw new ServiceError('workspace_conflict', 'Workspace revision conflict', 409, {
        expectedRevision: expected,
        currentRevision: workspace.revision
      })
    }
  }

  private findRecord(
    workspaceId: string,
    collection: WorkspaceCollection,
    recordId: string
  ): WorkspaceRecord | null {
    const row = this.store.database.prepare(`
      SELECT * FROM shared_workspace_records
      WHERE workspace_id = ? AND collection = ? AND record_id = ?
    `).get(workspaceId, collection, recordId)
    return row ? toWorkspaceRecord(row) : null
  }

  private requireRecord(
    workspaceId: string,
    collection: WorkspaceCollection,
    recordId: string
  ): WorkspaceRecord {
    const record = this.findRecord(workspaceId, collection, recordId)
    if (!record) throw new Error('Failed to read workspace record')
    return record
  }

  private findOperation(workspaceId: string, mutationId: string): StoredOperation | null {
    const row = this.store.database.prepare(`
      SELECT * FROM shared_workspace_operations
      WHERE workspace_id = ? AND mutation_id = ?
    `).get(workspaceId, mutationId)
    if (!row) return null
    const record = asRecord(row)
    const collection = nullableString(record.record_collection)
    return {
      mutationId: stringField(record, 'mutation_id'),
      operationKind: stringField(record, 'operation_kind'),
      actorCharacterId: stringField(record, 'actor_character_id'),
      requestHash: stringField(record, 'request_hash'),
      resultWorkspaceRevision: integerField(record, 'result_workspace_revision'),
      recordCollection: collection === null ? null : normalizeCollection(collection),
      recordId: nullableString(record.record_id),
      recordRevision: nullableInteger(record.record_revision),
      resultRecord: parseStoredRecord(nullableString(record.result_record_json)),
      resultChange: parseStoredChange(nullableString(record.result_change_json)),
      staleBase: nullableBooleanInteger(record.stale_base)
    }
  }

  private saveOperation(input: {
    workspaceId: string
    mutationId: string
    operationKind: string
    actorCharacterId: string
    requestHash: string
    resultWorkspaceRevision: number
    recordCollection: WorkspaceCollection | null
    recordId: string | null
    recordRevision: number | null
    resultRecord?: WorkspaceRecord | null
    resultChange?: WorkspaceChange | null
    staleBase?: boolean | null
    createdAt: number
  }): void {
    this.store.database.prepare(`
      INSERT INTO shared_workspace_operations (
        workspace_id, mutation_id, operation_kind, actor_character_id, request_hash,
        result_workspace_revision, record_collection, record_id, record_revision,
        result_record_json, result_change_json, stale_base, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.workspaceId,
      input.mutationId,
      input.operationKind,
      input.actorCharacterId,
      input.requestHash,
      input.resultWorkspaceRevision,
      input.recordCollection,
      input.recordId,
      input.recordRevision,
      input.resultRecord ? JSON.stringify(input.resultRecord) : null,
      input.resultChange ? JSON.stringify(input.resultChange) : null,
      input.staleBase === undefined || input.staleBase === null ? null : input.staleBase ? 1 : 0,
      input.createdAt
    )
  }

  private requireMatchingOperation(
    operation: StoredOperation,
    operationKind: string,
    actorCharacterId: string,
    requestHash: string
  ): void {
    if (operation.operationKind !== operationKind ||
        operation.actorCharacterId !== actorCharacterId || operation.requestHash !== requestHash) {
      this.throwMutationIdReused()
    }
  }

  private throwMutationIdReused(): never {
    throw new ServiceError(
      'mutation_id_reused',
      'Mutation ID was already used for another request',
      409
    )
  }

  private findActivePresence(
    workspaceId: string,
    characterId: string,
    now: number
  ): WorkspacePresence | null {
    const row = this.store.database.prepare(`
      SELECT p.*, m.character_name
      FROM shared_workspace_presence p
      JOIN shared_workspace_members m
        ON m.workspace_id = p.workspace_id AND m.character_id = p.character_id
      WHERE p.workspace_id = ? AND p.character_id = ? AND p.active = 1 AND p.expires_at > ?
    `).get(workspaceId, characterId, now)
    return row ? toPresence(row) : null
  }

  private presenceRevision(workspaceId: string, characterId: string): number {
    const row = this.store.database.prepare(`
      SELECT revision FROM shared_workspace_presence WHERE workspace_id = ? AND character_id = ?
    `).get(workspaceId, characterId)
    return row ? integerField(asRecord(row), 'revision') : 0
  }

  private tombstonePresence(
    workspaceId: string,
    characterId: string,
    now: number,
    mutationId: string
  ): void {
    const revision = this.presenceRevision(workspaceId, characterId)
    if (revision === 0) return
    this.writePresenceTombstone(workspaceId, characterId, revision + 1, now, mutationId)
  }

  private tombstoneActivePresence(
    workspaceId: string,
    characterId: string,
    now: number,
    mutationId: string
  ): void {
    const row = this.store.database.prepare(`
      SELECT revision FROM shared_workspace_presence
      WHERE workspace_id = ? AND character_id = ? AND active = 1
    `).get(workspaceId, characterId)
    if (!row) return
    this.writePresenceTombstone(
      workspaceId,
      characterId,
      integerField(asRecord(row), 'revision') + 1,
      now,
      mutationId
    )
  }

  private writePresenceTombstone(
    workspaceId: string,
    characterId: string,
    revision: number,
    now: number,
    mutationId: string
  ): void {
    this.store.database.prepare(`
      INSERT INTO shared_workspace_presence (
        workspace_id, character_id, solar_system_id, solar_system_name,
        revision, active, observed_at, expires_at, last_mutation_id, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, 0, NULL, NULL, ?, ?)
      ON CONFLICT(workspace_id, character_id) DO UPDATE SET
        solar_system_id = NULL,
        solar_system_name = NULL,
        revision = excluded.revision,
        active = 0,
        observed_at = NULL,
        expires_at = NULL,
        last_mutation_id = excluded.last_mutation_id,
        updated_at = excluded.updated_at
    `).run(workspaceId, characterId, revision, mutationId, now)
  }

  private tombstoneExpiredPresence(workspaceId: string, characterId: string, now: number): void {
    const row = this.store.database.prepare(`
      SELECT revision FROM shared_workspace_presence
      WHERE workspace_id = ? AND character_id = ? AND active = 1 AND expires_at <= ?
    `).get(workspaceId, characterId, now)
    if (!row) return
    this.writePresenceTombstone(
      workspaceId,
      characterId,
      integerField(asRecord(row), 'revision') + 1,
      now,
      `expired:${now}`
    )
  }

  private tombstoneAllExpiredPresence(workspaceId: string, now: number): void {
    const rows = this.store.database.prepare(`
      SELECT character_id, revision FROM shared_workspace_presence
      WHERE workspace_id = ? AND active = 1 AND expires_at <= ?
    `).all(workspaceId, now)
    for (const row of rows) {
      const record = asRecord(row)
      this.writePresenceTombstone(
        workspaceId,
        stringField(record, 'character_id'),
        integerField(record, 'revision') + 1,
        now,
        `expired:${now}`
      )
    }
  }

  private prunePresenceOperations(workspaceId: string, characterId: string, now: number): void {
    this.store.database.prepare(`
      DELETE FROM shared_workspace_operations
      WHERE workspace_id = ? AND actor_character_id = ?
        AND operation_kind LIKE 'presence.%' AND created_at < ?
    `).run(workspaceId, characterId, now - 86_400)
  }

  private currentTime(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Workspace clock must return Unix seconds')
    return value
  }
}

function toWorkspaceRow(row: unknown): WorkspaceRow {
  const record = asRecord(row)
  return {
    id: stringField(record, 'id'),
    name: stringField(record, 'name'),
    policyVersion: integerField(record, 'policy_version'),
    revision: integerField(record, 'revision'),
    ownerCharacterId: stringField(record, 'owner_character_id'),
    createdAt: integerField(record, 'created_at'),
    updatedAt: integerField(record, 'updated_at')
  }
}

function toWorkspaceRecord(row: unknown): WorkspaceRecord {
  const record = asRecord(row)
  const payloadJson = nullableString(record.payload_json)
  let payload: Readonly<Record<string, unknown>> | null = null
  if (payloadJson !== null) {
    const parsed: unknown = JSON.parse(payloadJson)
    if (!isRecord(parsed)) throw new TypeError('Corrupt workspace record payload')
    payload = parsed
  }
  return {
    collection: enumField(record, 'collection', WORKSPACE_COLLECTIONS),
    recordId: stringField(record, 'record_id'),
    revision: integerField(record, 'revision'),
    workspaceRevision: integerField(record, 'workspace_revision'),
    payload,
    updatedByCharacterId: stringField(record, 'updated_by_character_id'),
    updatedAt: integerField(record, 'updated_at'),
    deletedAt: nullableInteger(record.deleted_at),
    lastMutationId: stringField(record, 'last_mutation_id')
  }
}

function toChange(row: unknown): WorkspaceChange {
  const record = asRecord(row)
  return {
    workspaceId: stringField(record, 'workspace_id'),
    workspaceRevision: integerField(record, 'workspace_revision'),
    mutationId: stringField(record, 'mutation_id'),
    collection: enumField(record, 'collection', WORKSPACE_COLLECTIONS),
    recordId: stringField(record, 'record_id'),
    recordRevision: integerField(record, 'record_revision'),
    operation: enumField(record, 'operation', ['upsert', 'delete'] as const),
    changedByCharacterId: stringField(record, 'changed_by_character_id'),
    changedAt: integerField(record, 'changed_at')
  }
}

function toPresence(row: unknown): WorkspacePresence {
  const record = asRecord(row)
  return {
    characterId: stringField(record, 'character_id'),
    characterName: stringField(record, 'character_name'),
    solarSystemId: stringField(record, 'solar_system_id'),
    solarSystemName: nullableString(record.solar_system_name),
    revision: integerField(record, 'revision'),
    observedAt: integerField(record, 'observed_at'),
    expiresAt: integerField(record, 'expires_at')
  }
}

function parseStoredRecord(json: string | null): WorkspaceRecord | null {
  if (json === null) return null
  const value: unknown = JSON.parse(json)
  if (!isRecord(value)) throw new TypeError('Corrupt stored operation record')
  const payload = value.payload
  if (payload !== null && !isRecord(payload)) throw new TypeError('Corrupt stored record payload')
  return {
    collection: normalizeCollection(value.collection),
    recordId: normalizedId(value.recordId, 'recordId'),
    revision: positiveInteger(value.revision, 'revision'),
    workspaceRevision: positiveInteger(value.workspaceRevision, 'workspaceRevision'),
    payload,
    updatedByCharacterId: decimalId(value.updatedByCharacterId, 'updatedByCharacterId'),
    updatedAt: nonNegativeInteger(value.updatedAt, 'updatedAt'),
    deletedAt: value.deletedAt === null
      ? null
      : nonNegativeInteger(value.deletedAt, 'deletedAt'),
    lastMutationId: normalizedId(value.lastMutationId, 'lastMutationId')
  }
}

function parseStoredChange(json: string | null): WorkspaceChange | null {
  if (json === null) return null
  const value: unknown = JSON.parse(json)
  if (!isRecord(value)) throw new TypeError('Corrupt stored operation change')
  return {
    workspaceId: normalizedId(value.workspaceId, 'workspaceId'),
    workspaceRevision: positiveInteger(value.workspaceRevision, 'workspaceRevision'),
    mutationId: normalizedId(value.mutationId, 'mutationId'),
    collection: normalizeCollection(value.collection),
    recordId: normalizedId(value.recordId, 'recordId'),
    recordRevision: positiveInteger(value.recordRevision, 'recordRevision'),
    operation: enumValue(value.operation, ['upsert', 'delete'] as const, 'operation'),
    changedByCharacterId: decimalId(value.changedByCharacterId, 'changedByCharacterId'),
    changedAt: nonNegativeInteger(value.changedAt, 'changedAt')
  }
}

function mutationFailure(
  workspace: WorkspaceRow,
  code: Extract<WorkspaceMutationResult, { ok: false }>['code'],
  message: string,
  currentRecord: WorkspaceRecord | null
): Extract<WorkspaceMutationResult, { ok: false }> {
  return { ok: false, code, message, workspaceRevision: workspace.revision, currentRecord }
}

function normalizeMutation(value: unknown): WorkspaceMutation {
  if (!isRecord(value)) throw new ServiceError('invalid_mutation', 'Mutation must be an object')
  const operation = value.operation
  if (operation !== 'upsert' && operation !== 'delete') {
    throw new ServiceError('invalid_mutation', 'operation must be upsert or delete')
  }
  const collection = normalizeCollection(value.collection)
  const mutationId = normalizedId(value.mutationId, 'mutationId')
  const recordId = normalizedId(value.recordId, 'recordId')
  const expectedRevision = nonNegativeInteger(value.expectedRevision, 'expectedRevision')
  const baseWorkspaceRevision = nonNegativeInteger(
    value.baseWorkspaceRevision,
    'baseWorkspaceRevision'
  )
  if (operation === 'delete') {
    return {
      operation,
      mutationId,
      collection,
      recordId,
      expectedRevision,
      baseWorkspaceRevision
    }
  }
  return {
    operation,
    mutationId,
    collection,
    recordId,
    expectedRevision,
    baseWorkspaceRevision,
    payload: normalizePayload(collection, value.payload)
  }
}

function normalizePayload(
  collection: WorkspaceCollection,
  value: unknown
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new ServiceError('invalid_payload', 'payload must be an object')
  if (collection === 'watchlist') {
    const entityType = enumValue(value.entityType, ['character', 'corporation', 'alliance'] as const, 'entityType')
    const severity = enumValue(value.severity, ['watch', 'danger', 'critical'] as const, 'severity')
    return {
      entityType,
      entityId: decimalId(value.entityId, 'entityId'),
      name: normalizedText(value.name, 'name', 200),
      severity,
      tags: normalizeTags(value.tags),
      note: nullableText(value.note, 'note', 2_000)
    }
  }
  if (collection === 'doctrines') {
    if (!Array.isArray(value.ships) || value.ships.length > 500) {
      throw new ServiceError('invalid_payload', 'ships must be an array with at most 500 entries')
    }
    const ships = value.ships.map((shipValue) => {
      if (!isRecord(shipValue)) throw new ServiceError('invalid_payload', 'Invalid doctrine ship')
      const minimum = nonNegativeInteger(shipValue.minimum, 'minimum')
      const maximum = shipValue.maximum === null
        ? null
        : nonNegativeInteger(shipValue.maximum, 'maximum')
      if (maximum !== null && maximum < minimum) {
        throw new ServiceError('invalid_payload', 'maximum cannot be below minimum')
      }
      return {
        typeId: positiveInteger(shipValue.typeId, 'typeId'),
        minimum,
        maximum,
        role: nullableText(shipValue.role, 'role', 100)
      }
    })
    return {
      name: normalizedText(value.name, 'name', 120),
      description: nullableText(value.description, 'description', 5_000),
      ships,
      tags: normalizeTags(value.tags)
    }
  }
  if (!Array.isArray(value.avoidSystemIds) || value.avoidSystemIds.length > 256) {
    throw new ServiceError('invalid_payload', 'avoidSystemIds must contain at most 256 IDs')
  }
  return {
    name: normalizedText(value.name, 'name', 120),
    origin: normalizedText(value.origin, 'origin', 120),
    destination: normalizedText(value.destination, 'destination', 120),
    mode: enumValue(value.mode, ['shortest', 'secure', 'insecure'] as const, 'mode'),
    avoidSystemIds: [...new Set(value.avoidSystemIds.map((id) => positiveInteger(id, 'systemId')))]
      .sort((left, right) => left - right),
    tags: normalizeTags(value.tags)
  }
}

function normalizeScopes(values: readonly unknown[]): WorkspaceConsentScope[] {
  if (!Array.isArray(values)) throw new ServiceError('invalid_consent', 'scopes must be an array')
  const result = [...new Set(values.map((scope) => {
    if (typeof scope !== 'string' || !WORKSPACE_CONSENT_SCOPES.includes(scope as WorkspaceConsentScope)) {
      throw new ServiceError('invalid_consent', 'Unknown consent scope')
    }
    return scope as WorkspaceConsentScope
  }))]
  return result.sort((left, right) =>
    WORKSPACE_CONSENT_SCOPES.indexOf(left) - WORKSPACE_CONSENT_SCOPES.indexOf(right)
  )
}

function parseScopes(json: string): WorkspaceConsentScope[] {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value)) throw new TypeError('Corrupt workspace consent scopes')
  try {
    return normalizeScopes(value)
  } catch {
    throw new TypeError('Corrupt workspace consent scopes')
  }
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new ServiceError('invalid_payload', 'tags must contain at most 50 entries')
  }
  return [...new Set(value.map((tag) => normalizedText(tag, 'tag', 64)))]
    .sort((left, right) => left.localeCompare(right, 'en'))
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizedId(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ServiceError('invalid_body', `${field} must be a string`)
  const result = value.normalize('NFKC').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(result)) {
    throw new ServiceError('invalid_body', `Invalid ${field}`)
  }
  return result
}

function normalizedText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new ServiceError('invalid_body', `${field} must be a string`)
  const result = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!result || result.length > maximumLength || result.includes('\0')) {
    throw new ServiceError('invalid_body', `Invalid ${field}`)
  }
  return result
}

function nullableText(value: unknown, field: string, maximumLength: number): string | null {
  return value === null ? null : normalizedText(value, field, maximumLength)
}

function decimalId(value: unknown, field: string): string {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof result !== 'string' || !/^\d{1,20}$/u.test(result) || /^0+$/u.test(result)) {
    throw new ServiceError('invalid_body', `Invalid ${field}`)
  }
  return result.replace(/^0+(?=\d)/u, '')
}

function assignableRole(value: unknown): Exclude<WorkspaceRole, 'owner'> {
  if (value !== 'commander' && value !== 'editor' && value !== 'viewer') {
    throw new ServiceError('invalid_role', 'role must be commander, editor or viewer')
  }
  return value
}

function normalizeCollection(value: unknown): WorkspaceCollection {
  if (typeof value !== 'string' || !WORKSPACE_COLLECTIONS.includes(value as WorkspaceCollection)) {
    throw new ServiceError('invalid_collection', 'Unknown workspace collection')
  }
  return value as WorkspaceCollection
}

function isWorkspaceCollection(value: WorkspaceConsentScope): value is WorkspaceCollection {
  return WORKSPACE_COLLECTIONS.includes(value as WorkspaceCollection)
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ServiceError('invalid_body', `Invalid ${field}`)
  }
  return value as T[number]
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ServiceError('invalid_body', `${field} must be a positive integer`)
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ServiceError('invalid_body', `${field} must be a non-negative integer`)
  }
  return value
}

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Invalid database row')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') throw new TypeError(`Invalid ${field} column`)
  return value
}

function integerField(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`Invalid ${field} column`)
  }
  return value
}

function nullableString(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new TypeError('Invalid nullable string column')
  return value
}

function nullableInteger(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('Invalid nullable integer column')
  }
  return value
}

function nullableBooleanInteger(value: unknown): boolean | null {
  if (value === null) return null
  if (value !== 0 && value !== 1) throw new TypeError('Invalid nullable boolean column')
  return value === 1
}

function enumField<const T extends readonly string[]>(
  record: Record<string, unknown>,
  field: string,
  allowed: T
): T[number] {
  const value = stringField(record, field)
  if (!allowed.includes(value)) throw new TypeError(`Invalid ${field} column`)
  return value as T[number]
}
