export type PilotContactType = 'character' | 'corporation' | 'alliance' | 'faction'

export interface PilotContactLabel {
  id: number
  name: string
}

export interface PilotContact {
  id: number
  type: PilotContactType
  name: string | null
  standing: number
  labelIds: number[]
  labelNames: string[]
  watched: boolean
  blocked: boolean
}

export interface PilotContactsContext {
  entries: PilotContact[]
  labels: PilotContactLabel[]
  cached: boolean
}

export type FriendlyFleetRole =
  | 'fleet_commander'
  | 'wing_commander'
  | 'squad_commander'
  | 'squad_member'
  | string

export interface FriendlyFleetMember {
  characterId: number
  characterName: string | null
  shipTypeId: number
  shipTypeName: string | null
  solarSystemId: number
  solarSystemName: string | null
  stationId: number | null
  role: FriendlyFleetRole
  roleName: string
  wingId: number | null
  squadId: number | null
  joinedAt: string
  takesFleetWarp: boolean
}

/** Authenticated roster of the connected character's own fleet, never Local or enemies. */
export interface FriendlyFleetContext {
  fleetId: number
  fleetBossId: number
  ownRole: FriendlyFleetRole
  ownWingId: number | null
  ownSquadId: number | null
  /** False when membership is known but ESI does not expose the roster to this character. */
  membersAvailable: boolean
  members: FriendlyFleetMember[]
  cached: boolean
}

export interface PilotContext {
  characterId: number
  contacts: PilotContactsContext | null
  /** Null means not in fleet or fleet-membership data is unavailable; warnings distinguish failure. */
  fleet: FriendlyFleetContext | null
  fetchedAt: string
  partial: boolean
  warnings: string[]
  provenance: {
    access: 'authenticated'
    fleetRoster: 'friendly-only'
    localRosterAvailable: false
  }
}

/** Renderer-safe options. Character identity and access token are supplied only by main. */
export interface PilotContextQuery {
  forceRefresh?: boolean
  excludeOwnCharacter?: boolean
}

export interface PilotIdentity {
  characterId: number
  corporationId?: number | null
  allianceId?: number | null
  factionId?: number | null
}

export type PilotStandingClass = 'positive' | 'negative' | 'neutral' | 'unknown'

export interface PilotClassification {
  fleet: boolean
  contact: boolean
  standing: number | null
  standingClass: PilotStandingClass
  matchedContactId: number | null
  matchedContactType: PilotContactType | null
  labelIds: number[]
  labelNames: string[]
}

/**
 * UI-ready relationship lookup. A direct character contact wins over corporation,
 * alliance, then faction. Fleet membership remains an independent badge.
 */
export function classifyPilot(
  identityOrCharacterId: PilotIdentity | number,
  context: PilotContext
): PilotClassification {
  const identity = typeof identityOrCharacterId === 'number'
    ? { characterId: identityOrCharacterId }
    : identityOrCharacterId

  const fleet = context.fleet?.members.some(
    (member) => member.characterId === identity.characterId
  ) ?? false
  const contacts = context.contacts?.entries ?? []
  const candidates: Array<[PilotContactType, number | null | undefined]> = [
    ['character', identity.characterId],
    ['corporation', identity.corporationId],
    ['alliance', identity.allianceId],
    ['faction', identity.factionId]
  ]

  let matched: PilotContact | null = null
  for (const [type, id] of candidates) {
    if (typeof id !== 'number') continue
    matched = contacts.find((contact) => contact.type === type && contact.id === id) ?? null
    if (matched) break
  }

  return {
    fleet,
    contact: matched !== null,
    standing: matched?.standing ?? null,
    standingClass: standingClass(matched?.standing),
    matchedContactId: matched?.id ?? null,
    matchedContactType: matched?.type ?? null,
    labelIds: matched ? [...matched.labelIds] : [],
    labelNames: matched ? [...matched.labelNames] : []
  }
}

function standingClass(standing: number | undefined): PilotStandingClass {
  if (standing === undefined) return 'unknown'
  if (standing > 0) return 'positive'
  if (standing < 0) return 'negative'
  return 'neutral'
}
