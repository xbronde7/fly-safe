import {
  EsiError,
  type AuthenticatedCharacterContactLabelsResult,
  type AuthenticatedCharacterContactsResult,
  type AuthenticatedCharacterFleet,
  type AuthenticatedFleetMembersResult,
  type UniverseName
} from './esi-client'
import type {
  FriendlyFleetContext,
  FriendlyFleetMember,
  PilotContact,
  PilotContactLabel,
  PilotContactsContext,
  PilotContext
} from '../shared/pilot-context'

export interface PilotContextRequest {
  characterId: number
  /** Main-process access token. Never retained or returned. */
  accessToken: string
  forceRefresh?: boolean
  /** Defaults to true, matching Local-intel self-filtering. */
  excludeOwnCharacter?: boolean
}

export interface PilotContextEsiAdapter {
  getAuthenticatedCharacterContacts(
    characterId: number,
    accessToken: string,
    forceRefresh?: boolean
  ): Promise<AuthenticatedCharacterContactsResult>
  getAuthenticatedCharacterContactLabels(
    characterId: number,
    accessToken: string,
    forceRefresh?: boolean
  ): Promise<AuthenticatedCharacterContactLabelsResult>
  getAuthenticatedCharacterFleet(
    characterId: number,
    accessToken: string,
    forceRefresh?: boolean
  ): Promise<AuthenticatedCharacterFleet>
  getAuthenticatedFleetMembers(
    fleetId: number,
    accessToken: string,
    forceRefresh?: boolean
  ): Promise<AuthenticatedFleetMembersResult>
  getUniverseNames(ids: readonly number[], forceRefresh?: boolean): Promise<UniverseName[]>
}

export interface PilotContextServiceOptions {
  now?: () => Date
}

/** Joins private read-only contacts/fleet data with public character/type/system names. */
export class PilotContextService {
  private readonly now: () => Date

  constructor(
    private readonly esi: PilotContextEsiAdapter,
    options: PilotContextServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  async getContext(request: PilotContextRequest): Promise<PilotContext> {
    assertRequest(request)
    const { characterId, forceRefresh = false } = request
    const accessToken = request.accessToken.trim()
    const excludeOwnCharacter = request.excludeOwnCharacter ?? true
    const warnings: string[] = []

    const [contactsResult, labelsResult, fleetResult] = await Promise.allSettled([
      this.esi.getAuthenticatedCharacterContacts(characterId, accessToken, forceRefresh),
      this.esi.getAuthenticatedCharacterContactLabels(characterId, accessToken, forceRefresh),
      this.esi.getAuthenticatedCharacterFleet(characterId, accessToken, forceRefresh)
    ])

    if (contactsResult.status === 'rejected') {
      warnings.push(`ESI: personal contacts unavailable (${messageOf(contactsResult.reason, accessToken)})`)
    }
    if (labelsResult.status === 'rejected') {
      warnings.push(`ESI: contact labels unavailable (${messageOf(labelsResult.reason, accessToken)})`)
    }

    let fleetInfo: AuthenticatedCharacterFleet | null = null
    if (fleetResult.status === 'fulfilled') {
      fleetInfo = fleetResult.value
    } else if (!isNotInFleet(fleetResult.reason)) {
      warnings.push(`ESI: friendly-fleet data unavailable (${messageOf(fleetResult.reason, accessToken)})`)
    }

    let fleetMembersResult: AuthenticatedFleetMembersResult | null = null
    if (fleetInfo?.fleetBossId === characterId) {
      const requestedFleetId = fleetInfo.fleetId
      try {
        fleetMembersResult = await this.esi.getAuthenticatedFleetMembers(
          requestedFleetId,
          accessToken,
          forceRefresh
        )
      } catch (error) {
        if (isNotInFleet(error)) {
          // Character-fleet data can remain cached briefly after leaving a fleet.
          // Recheck that endpoint before deciding whether this 404 is expected
          // or an actual members-access failure.
          try {
            const refreshedFleet = await this.esi.getAuthenticatedCharacterFleet(
              characterId,
              accessToken,
              true
            )
            fleetInfo = refreshedFleet
            if (
              refreshedFleet.fleetId !== requestedFleetId &&
              refreshedFleet.fleetBossId === characterId
            ) {
              try {
                fleetMembersResult = await this.esi.getAuthenticatedFleetMembers(
                  refreshedFleet.fleetId,
                  accessToken,
                  true
                )
              } catch (retryError) {
                if (!isNotInFleet(retryError)) {
                  warnings.push(
                    `ESI: friendly-fleet roster unavailable (${messageOf(retryError, accessToken)})`
                  )
                }
              }
            }
          } catch (fleetRefreshError) {
            if (isNotInFleet(fleetRefreshError)) {
              fleetInfo = null
            } else {
              warnings.push(
                `ESI: friendly-fleet data unavailable (${messageOf(fleetRefreshError, accessToken)})`
              )
            }
          }
        } else {
          warnings.push(`ESI: friendly-fleet roster unavailable (${messageOf(error, accessToken)})`)
        }
      }
    }

    const rawContacts = contactsResult.status === 'fulfilled'
      ? contactsResult.value.contacts
      : []
    const rawLabels = labelsResult.status === 'fulfilled'
      ? labelsResult.value.labels
      : []
    const rawMembers = fleetMembersResult?.members.filter(
      (member) => !excludeOwnCharacter || member.characterId !== characterId
    ) ?? []

    const nameIds = uniquePositiveIds([
      ...rawContacts.map((contact) => contact.contactId),
      ...rawMembers.flatMap((member) => [
        member.characterId,
        member.shipTypeId,
        member.solarSystemId
      ])
    ])

    let names: UniverseName[] = []
    if (nameIds.length > 0) {
      try {
        names = await this.esi.getUniverseNames(nameIds, forceRefresh)
      } catch (error) {
        warnings.push(`ESI: pilot, ship, or system names unavailable (${messageOf(error)})`)
      }
    }
    const namesById = new Map(names.map((name) => [name.id, name.name]))
    const nameRecordsById = new Map(names.map((name) => [name.id, name]))
    const labels = rawLabels.map((label): PilotContactLabel => ({
      id: label.labelId,
      name: label.name
    }))
    const labelsById = new Map(labels.map((label) => [label.id, label.name]))

    const contacts = contactsResult.status === 'fulfilled'
      ? buildContactsContext(
          contactsResult.value,
          labelsResult.status === 'fulfilled' ? labelsResult.value : null,
          namesById,
          labels,
          labelsById,
          nameRecordsById
        )
      : null
    const fleet = fleetInfo
      ? buildFleetContext(fleetInfo, fleetMembersResult, rawMembers, namesById, nameRecordsById)
      : null

    if (names.length > 0 || nameIds.length > 0) {
      const missingContactNames = contacts?.entries.filter((contact) => contact.name === null).length ?? 0
      const missingFleetNames = fleet?.members.filter(
        (member) =>
          member.characterName === null ||
          member.shipTypeName === null ||
          member.solarSystemName === null
      ).length ?? 0
      if (missingContactNames > 0) {
        warnings.push(`ESI: names not found for contacts: ${missingContactNames}`)
      }
      if (missingFleetNames > 0) {
        warnings.push(`ESI: some friendly-fleet roster names could not be resolved: ${missingFleetNames}`)
      }
    }

    return {
      characterId,
      contacts,
      fleet,
      fetchedAt: this.now().toISOString(),
      partial: warnings.length > 0,
      warnings,
      provenance: {
        access: 'authenticated',
        fleetRoster: 'friendly-only',
        localRosterAvailable: false
      }
    }
  }
}

function buildContactsContext(
  contactsResult: AuthenticatedCharacterContactsResult,
  labelsResult: AuthenticatedCharacterContactLabelsResult | null,
  namesById: ReadonlyMap<number, string>,
  labels: PilotContactLabel[],
  labelsById: ReadonlyMap<number, string>,
  nameRecordsById: ReadonlyMap<number, UniverseName>
): PilotContactsContext {
  const entries = contactsResult.contacts.map((contact): PilotContact => ({
    id: contact.contactId,
    type: contact.contactType,
    name: namesById.get(contact.contactId) ?? null,
    standing: contact.standing,
    labelIds: [...contact.labelIds],
    labelNames: contact.labelIds.flatMap((labelId) => {
      const name = labelsById.get(labelId)
      return name ? [name] : []
    }),
    watched: contact.watched,
    blocked: contact.blocked
  }))

  return {
    entries,
    labels,
    cached:
      contactsResult.cached &&
      (labelsResult?.cached ?? false) &&
      contactsResult.contacts.every(
        (contact) => nameRecordsById.get(contact.contactId)?.cached === true
      )
  }
}

function buildFleetContext(
  fleet: AuthenticatedCharacterFleet,
  membersResult: AuthenticatedFleetMembersResult | null,
  members: AuthenticatedFleetMembersResult['members'],
  namesById: ReadonlyMap<number, string>,
  nameRecordsById: ReadonlyMap<number, UniverseName>
): FriendlyFleetContext {
  const enriched = members.map((member): FriendlyFleetMember => ({
    characterId: member.characterId,
    characterName: namesById.get(member.characterId) ?? null,
    shipTypeId: member.shipTypeId,
    shipTypeName: namesById.get(member.shipTypeId) ?? null,
    solarSystemId: member.solarSystemId,
    solarSystemName: namesById.get(member.solarSystemId) ?? null,
    stationId: member.stationId,
    role: member.role,
    roleName: member.roleName,
    wingId: member.wingId,
    squadId: member.squadId,
    joinedAt: member.joinedAt,
    takesFleetWarp: member.takesFleetWarp
  }))

  return {
    fleetId: fleet.fleetId,
    fleetBossId: fleet.fleetBossId,
    ownRole: fleet.role,
    ownWingId: fleet.wingId,
    ownSquadId: fleet.squadId,
    membersAvailable: membersResult !== null,
    members: enriched,
    cached:
      fleet.cached &&
      (membersResult?.cached ?? false) &&
      members.every((member) =>
        [member.characterId, member.shipTypeId, member.solarSystemId].every(
          (id) => nameRecordsById.get(id)?.cached === true
        )
      )
  }
}

function uniquePositiveIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))]
}

function isNotInFleet(error: unknown): boolean {
  return error instanceof EsiError && error.status === 404
}

function assertRequest(request: PilotContextRequest): void {
  if (!request || !Number.isSafeInteger(request.characterId) || request.characterId <= 0) {
    throw new TypeError('Invalid character ID')
  }
  if (typeof request.accessToken !== 'string' || request.accessToken.trim() === '') {
    throw new TypeError('Access token is required')
  }
}

function messageOf(error: unknown, secret?: string): string {
  const message = error instanceof Error && error.message ? error.message : 'unknown error'
  return secret && message.includes(secret) ? message.split(secret).join('[redacted]') : message
}
