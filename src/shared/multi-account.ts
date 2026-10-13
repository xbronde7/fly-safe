import { FLY_SAFE_EVE_CALLBACK_URI } from './eve-application'

export const EVE_MULTI_ACCOUNT_STATES = [
  'connected',
  'stored',
  'disconnected',
  'error'
] as const

export const EVE_LEGACY_MIGRATION_STATES = [
  'pending',
  'complete',
  'blocked'
] as const

export type EveMultiAccountState = (typeof EVE_MULTI_ACCOUNT_STATES)[number]
export type EveLegacyMigrationState = (typeof EVE_LEGACY_MIGRATION_STATES)[number]

/** Public character/session metadata. OAuth credentials are deliberately absent. */
export interface EveCharacterAccountStatus {
  characterId: number
  characterName: string
  scopes: string[]
  state: EveMultiAccountState
  connected: boolean
  credentialStored: boolean
  sessionExpiresAt: number | null
  addedAt: string
  lastAuthenticatedAt: string
  lastSelectedAt: string | null
  lastDisconnectedAt: string | null
  error: string | null
}

/** Safe to expose through a narrow preload bridge. */
export interface EveMultiAccountStatus {
  configured: boolean
  clientId: string
  callbackUri: typeof FLY_SAFE_EVE_CALLBACK_URI
  activeCharacterId: number | null
  maxCharacters: number
  characters: EveCharacterAccountStatus[]
  legacyMigration: EveLegacyMigrationState
  error: string | null
  sessionOnly?: boolean
}

export interface EveCharacterSelectionRequest {
  characterId: number
}

export function validateCharacterSelectionRequest(
  value: unknown
): EveCharacterSelectionRequest {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new TypeError('Invalid character-selection request')
  }
  return { characterId: positiveCharacterId(value.characterId) }
}

function positiveCharacterId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError('Invalid EVE character ID')
  }
  return value as number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
