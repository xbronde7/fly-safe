import type { PilotIntel } from './types'

/** Keeps completion order while replacing a repeated pilot update in place. */
export function upsertReadyPilot(
  pilots: readonly PilotIntel[],
  readyPilot: PilotIntel
): PilotIntel[] {
  const index = pilots.findIndex((pilot) => pilot.id === readyPilot.id)
  if (index === -1) return [...pilots, readyPilot]

  const next = [...pilots]
  next[index] = readyPilot
  return next
}
