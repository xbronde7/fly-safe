export const WORKSPACE_ROLES = ['owner', 'commander', 'editor', 'viewer'] as const
export const WORKSPACE_COLLECTIONS = ['watchlist', 'doctrines', 'routes'] as const
export const WORKSPACE_CONSENT_SCOPES = [...WORKSPACE_COLLECTIONS, 'local-presence'] as const

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]
export type WorkspaceCollection = (typeof WORKSPACE_COLLECTIONS)[number]
export type WorkspaceConsentScope = (typeof WORKSPACE_CONSENT_SCOPES)[number]

export interface WorkspaceConsent {
  policyVersion: number
  scopes: readonly WorkspaceConsentScope[]
  acceptedAt: number
}

export interface WorkspaceMember {
  characterId: string
  characterName: string
  role: WorkspaceRole
  consent: WorkspaceConsent | null
  joinedAt: number
  updatedAt: number
}

export interface WorkspaceRecord {
  collection: WorkspaceCollection
  recordId: string
  revision: number
  workspaceRevision: number
  payload: Readonly<Record<string, unknown>> | null
  updatedByCharacterId: string
  updatedAt: number
  deletedAt: number | null
  lastMutationId: string
}

export interface WorkspaceSnapshot {
  schemaVersion: 1
  workspaceId: string
  name: string
  policyVersion: number
  revision: number
  members: readonly WorkspaceMember[]
  records: readonly WorkspaceRecord[]
  createdAt: number
  updatedAt: number
}

export interface WorkspaceSummary {
  workspaceId: string
  name: string
  policyVersion: number
  revision: number
  role: WorkspaceRole
  consent: WorkspaceConsent | null
  createdAt: number
  updatedAt: number
}

export interface WorkspaceChange {
  workspaceId: string
  workspaceRevision: number
  mutationId: string
  collection: WorkspaceCollection
  recordId: string
  recordRevision: number
  operation: 'upsert' | 'delete'
  changedByCharacterId: string
  changedAt: number
}

export interface WorkspacePullPage {
  workspaceId: string
  fromWorkspaceRevision: number
  throughWorkspaceRevision: number
  changes: readonly WorkspaceChange[]
  records: readonly WorkspaceRecord[]
  hasMore: boolean
}

export type WorkspaceMutation = {
  operation: 'upsert'
  mutationId: string
  collection: WorkspaceCollection
  recordId: string
  expectedRevision: number
  baseWorkspaceRevision: number
  payload: Readonly<Record<string, unknown>>
} | {
  operation: 'delete'
  mutationId: string
  collection: WorkspaceCollection
  recordId: string
  expectedRevision: number
  baseWorkspaceRevision: number
}

export type WorkspaceMutationFailureCode =
  | 'member-missing'
  | 'consent-required'
  | 'scope-not-consented'
  | 'forbidden'
  | 'conflict'
  | 'mutation-id-reused'

export type WorkspaceMutationResult = {
  ok: true
  applied: boolean
  staleBase: boolean
  workspace: WorkspaceSnapshot
  record: WorkspaceRecord
  change: WorkspaceChange | null
} | {
  ok: false
  code: WorkspaceMutationFailureCode
  message: string
  workspaceRevision: number
  currentRecord: WorkspaceRecord | null
}

export interface WorkspacePresence {
  characterId: string
  characterName: string
  solarSystemId: string
  solarSystemName: string | null
  revision: number
  observedAt: number
  expiresAt: number
}

export interface WorkspaceOperationResult {
  applied: boolean
  workspace: WorkspaceSnapshot
}
