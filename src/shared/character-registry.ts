export const CHARACTER_SESSION_STATES = ['active', 'revoked'] as const
export const CHARACTER_ACCESS_STATES = [
  'ready',
  'profile-missing',
  'session-missing',
  'session-expired',
  'session-revoked',
  'scopes-missing'
] as const

export type CharacterSessionState = (typeof CHARACTER_SESSION_STATES)[number]
export type CharacterAccessState = (typeof CHARACTER_ACCESS_STATES)[number]

/** Public profile metadata. OAuth tokens must never be placed in this object. */
export interface CharacterProfile {
  characterId: number
  name: string
  corporationId: number | null
  corporationName: string | null
  allianceId: number | null
  allianceName: string | null
  createdAt: string
  updatedAt: string
  lastSelectedAt: string | null
}

/**
 * Session metadata only. `secureCredentialId` points at an OS-protected secret;
 * access and refresh tokens deliberately do not cross this shared boundary.
 */
export interface CharacterSession {
  characterId: number
  secureCredentialId: string
  grantedScopes: string[]
  authenticatedAt: string
  expiresAt: string
  state: CharacterSessionState
  updatedAt: string
}

export interface CharacterRegistrySnapshot {
  schemaVersion: 1
  revision: number
  activeCharacterId: number | null
  profiles: CharacterProfile[]
  sessions: CharacterSession[]
  updatedAt: string
}

export interface CharacterProfileInput {
  characterId: number
  name: string
  corporationId?: number | null
  corporationName?: string | null
  allianceId?: number | null
  allianceName?: string | null
}

export interface CharacterSessionInput {
  characterId: number
  secureCredentialId: string
  grantedScopes: readonly string[]
  authenticatedAt: string
  expiresAt: string
}

export interface CharacterAccessDecision {
  state: CharacterAccessState
  characterId: number
  profile: CharacterProfile | null
  session: CharacterSession | null
  missingScopes: string[]
}

export interface ActiveCharacterContext {
  profile: CharacterProfile
  session: CharacterSession | null
}

export function createCharacterRegistry(now = new Date().toISOString()): CharacterRegistrySnapshot {
  const timestamp = normalizeIsoDate(now, 'registry timestamp')
  return {
    schemaVersion: 1,
    revision: 0,
    activeCharacterId: null,
    profiles: [],
    sessions: [],
    updatedAt: timestamp
  }
}

export function upsertCharacterProfile(
  registry: CharacterRegistrySnapshot,
  rawProfile: CharacterProfileInput,
  now = new Date().toISOString()
): CharacterRegistrySnapshot {
  validateRegistry(registry)
  const timestamp = normalizeIsoDate(now, 'profile timestamp')
  const characterId = positiveId(rawProfile.characterId, 'characterId')
  const existing = registry.profiles.find((profile) => profile.characterId === characterId)
  const profile: CharacterProfile = {
    characterId,
    name: cleanRequiredText(rawProfile.name, 'character name', 100),
    corporationId: nullableId(rawProfile.corporationId, 'corporationId'),
    corporationName: cleanOptionalText(rawProfile.corporationName, 'corporation name', 200),
    allianceId: nullableId(rawProfile.allianceId, 'allianceId'),
    allianceName: cleanOptionalText(rawProfile.allianceName, 'alliance name', 200),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastSelectedAt: existing?.lastSelectedAt ?? null
  }
  const profiles = registry.profiles
    .filter((entry) => entry.characterId !== characterId)
    .concat(profile)
    .sort(compareProfiles)
  return nextRegistry(registry, {
    profiles,
    activeCharacterId: registry.activeCharacterId ?? characterId
  }, timestamp)
}

export function upsertCharacterSession(
  registry: CharacterRegistrySnapshot,
  rawSession: CharacterSessionInput,
  now = new Date().toISOString()
): CharacterRegistrySnapshot {
  validateRegistry(registry)
  const timestamp = normalizeIsoDate(now, 'session timestamp')
  const characterId = positiveId(rawSession.characterId, 'characterId')
  if (!registry.profiles.some((profile) => profile.characterId === characterId)) {
    throw new RangeError('Cannot attach a session to an unknown character profile')
  }
  const authenticatedAt = normalizeIsoDate(rawSession.authenticatedAt, 'authenticatedAt')
  const expiresAt = normalizeIsoDate(rawSession.expiresAt, 'expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(authenticatedAt)) {
    throw new RangeError('Session expiry must be later than authentication time')
  }
  const session: CharacterSession = {
    characterId,
    secureCredentialId: cleanRequiredText(
      rawSession.secureCredentialId,
      'secure credential ID',
      256
    ),
    grantedScopes: normalizeScopes(rawSession.grantedScopes),
    authenticatedAt,
    expiresAt,
    state: 'active',
    updatedAt: timestamp
  }
  const sessions = registry.sessions
    .filter((entry) => entry.characterId !== characterId)
    .concat(session)
    .sort((left, right) => left.characterId - right.characterId)
  return nextRegistry(registry, { sessions }, timestamp)
}

export function selectActiveCharacter(
  registry: CharacterRegistrySnapshot,
  characterId: number,
  now = new Date().toISOString()
): CharacterRegistrySnapshot {
  validateRegistry(registry)
  const timestamp = normalizeIsoDate(now, 'selection timestamp')
  const normalizedId = positiveId(characterId, 'characterId')
  if (!registry.profiles.some((profile) => profile.characterId === normalizedId)) {
    throw new RangeError('Cannot select an unknown character profile')
  }
  const profiles = registry.profiles.map((profile) => profile.characterId === normalizedId
    ? { ...profile, lastSelectedAt: timestamp, updatedAt: timestamp }
    : { ...profile })
  return nextRegistry(registry, { activeCharacterId: normalizedId, profiles }, timestamp)
}

export function removeCharacterProfile(
  registry: CharacterRegistrySnapshot,
  characterId: number,
  now = new Date().toISOString()
): CharacterRegistrySnapshot {
  validateRegistry(registry)
  const timestamp = normalizeIsoDate(now, 'removal timestamp')
  const normalizedId = positiveId(characterId, 'characterId')
  if (!registry.profiles.some((profile) => profile.characterId === normalizedId)) return registry
  return nextRegistry(registry, {
    profiles: registry.profiles.filter((profile) => profile.characterId !== normalizedId),
    sessions: registry.sessions.filter((session) => session.characterId !== normalizedId),
    activeCharacterId: registry.activeCharacterId === normalizedId
      ? null
      : registry.activeCharacterId
  }, timestamp)
}

export function revokeCharacterSession(
  registry: CharacterRegistrySnapshot,
  characterId: number,
  now = new Date().toISOString()
): CharacterRegistrySnapshot {
  validateRegistry(registry)
  const timestamp = normalizeIsoDate(now, 'revocation timestamp')
  const normalizedId = positiveId(characterId, 'characterId')
  const existing = registry.sessions.find((session) => session.characterId === normalizedId)
  if (!existing || existing.state === 'revoked') return registry
  const sessions = registry.sessions.map((session) => session.characterId === normalizedId
    ? { ...session, state: 'revoked' as const, updatedAt: timestamp }
    : { ...session, grantedScopes: [...session.grantedScopes] })
  return nextRegistry(registry, { sessions }, timestamp)
}

/** Computes freshness and scope availability without persisting time-dependent state. */
export function resolveCharacterAccess(
  registry: CharacterRegistrySnapshot,
  characterId: number,
  requiredScopes: readonly string[] = [],
  now = new Date().toISOString()
): CharacterAccessDecision {
  validateRegistry(registry)
  const normalizedId = positiveId(characterId, 'characterId')
  const nowMs = Date.parse(normalizeIsoDate(now, 'access timestamp'))
  const requestedScopes = normalizeScopes(requiredScopes)
  const profile = registry.profiles.find((entry) => entry.characterId === normalizedId) ?? null
  const session = registry.sessions.find((entry) => entry.characterId === normalizedId) ?? null
  const base = { characterId: normalizedId, profile, session, missingScopes: [] as string[] }
  if (!profile) return { ...base, state: 'profile-missing' }
  if (!session) return { ...base, state: 'session-missing' }
  if (session.state === 'revoked') return { ...base, state: 'session-revoked' }
  if (Date.parse(session.expiresAt) <= nowMs) return { ...base, state: 'session-expired' }
  const granted = new Set(session.grantedScopes)
  const missingScopes = requestedScopes.filter((scope) => !granted.has(scope))
  if (missingScopes.length > 0) return { ...base, state: 'scopes-missing', missingScopes }
  return { ...base, state: 'ready' }
}

export function getActiveCharacterContext(
  registry: CharacterRegistrySnapshot
): ActiveCharacterContext | null {
  validateRegistry(registry)
  if (registry.activeCharacterId === null) return null
  const profile = registry.profiles.find(
    (entry) => entry.characterId === registry.activeCharacterId
  )
  if (!profile) return null
  return {
    profile: { ...profile },
    session: registry.sessions.find((entry) => entry.characterId === profile.characterId) ?? null
  }
}

function nextRegistry(
  registry: CharacterRegistrySnapshot,
  patch: Partial<Pick<CharacterRegistrySnapshot, 'activeCharacterId' | 'profiles' | 'sessions'>>,
  updatedAt: string
): CharacterRegistrySnapshot {
  return {
    schemaVersion: 1,
    revision: registry.revision + 1,
    activeCharacterId: patch.activeCharacterId === undefined
      ? registry.activeCharacterId
      : patch.activeCharacterId,
    profiles: (patch.profiles ?? registry.profiles).map((profile) => ({ ...profile })),
    sessions: (patch.sessions ?? registry.sessions).map((session) => ({
      ...session,
      grantedScopes: [...session.grantedScopes]
    })),
    updatedAt
  }
}

function validateRegistry(registry: CharacterRegistrySnapshot): void {
  if (!registry || registry.schemaVersion !== 1 || !Number.isSafeInteger(registry.revision) ||
      registry.revision < 0 || !Array.isArray(registry.profiles) || !Array.isArray(registry.sessions)) {
    throw new TypeError('Invalid character registry snapshot')
  }
}

function normalizeScopes(scopes: readonly string[]): string[] {
  if (!Array.isArray(scopes)) throw new TypeError('Scopes must be an array')
  return [...new Set(scopes.map((scope) => cleanRequiredText(scope, 'scope', 200)))].sort()
}

function compareProfiles(left: CharacterProfile, right: CharacterProfile): number {
  return left.name.localeCompare(right.name, 'en') || left.characterId - right.characterId
}

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function nullableId(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null
  return positiveId(value, label)
}

function cleanRequiredText(value: string, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`)
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maximumLength || normalized.includes('\0')) {
    throw new TypeError(`Invalid ${label}`)
  }
  return normalized
}

function cleanOptionalText(
  value: string | null | undefined,
  label: string,
  maximumLength: number
): string | null {
  if (value === null || value === undefined) return null
  return cleanRequiredText(value, label, maximumLength)
}

function normalizeIsoDate(value: string, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date`)
  }
  return new Date(value).toISOString()
}
