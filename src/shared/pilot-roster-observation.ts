import type { EncounterSnapshotInput } from './encounter-journal'
import type { CurrentSystemSnapshot, ScanResult } from './types'

export type PilotRosterSource = 'lookup' | 'confirmed-local'

export interface PilotRosterObservationCandidate {
  capturedAt: string
  systemSnapshot: CurrentSystemSnapshot | null
  result: ScanResult
}

export type PilotRosterObservationDecision =
  | { recorded: false; reason: 'lookup' | 'missing-system' }
  | { recorded: true; request: EncounterSnapshotInput }

export function buildPilotRosterEncounter(
  candidate: PilotRosterObservationCandidate
): EncounterSnapshotInput | null {
  const snapshot = candidate.systemSnapshot
  const solarSystemId = snapshot?.location?.solarSystemId
  if (!solarSystemId || !Number.isSafeInteger(solarSystemId)) return null
  const ownCharacterId = snapshot.account.characterId
  const ownCharacterName = snapshot.account.characterName?.trim().toLocaleLowerCase('en-US') ?? null
  const isOwnCharacter = (characterId: number | null | undefined, name: string): boolean => (
    (ownCharacterId !== null && characterId === ownCharacterId) ||
    (ownCharacterName !== null && name.trim().toLocaleLowerCase('en-US') === ownCharacterName)
  )

  return {
    capturedAt: candidate.capturedAt,
    currentSystem: {
      solarSystemId,
      name: snapshot.intel?.system.id === solarSystemId
        ? snapshot.intel.system.name
        : null
    },
    ownShip: snapshot.ownShip
      ? {
          typeId: snapshot.ownShip.typeId,
          typeName: snapshot.ownShip.typeName,
          customName: snapshot.ownShip.customName
        }
      : null,
    localPilots: [
      ...candidate.result.pilots
        .filter((pilot) => !isOwnCharacter(pilot.id, pilot.name))
        .map((pilot) => ({
          characterId: pilot.id,
          name: pilot.name,
          corporationName: pilot.corporationName
        })),
      ...candidate.result.unresolvedNames
        .filter((name) => !isOwnCharacter(null, name))
        .map((name) => ({
          characterId: null,
          name,
          corporationName: null
        }))
    ]
  }
}

/** A roster lookup is side-effect free; only an explicit Local decision records it. */
export async function applyPilotRosterSource(
  source: PilotRosterSource,
  candidate: PilotRosterObservationCandidate,
  recordEncounter: (request: EncounterSnapshotInput) => Promise<unknown>
): Promise<PilotRosterObservationDecision> {
  if (source === 'lookup') return { recorded: false, reason: 'lookup' }

  const request = buildPilotRosterEncounter(candidate)
  if (!request) return { recorded: false, reason: 'missing-system' }

  await recordEncounter(request)
  return { recorded: true, request }
}
