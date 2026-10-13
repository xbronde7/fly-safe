import { classifyPilot } from '../shared/pilot-context'
import type { PilotContext } from '../shared/pilot-context'
import type { ScanResult } from '../shared/types'

/** Adds renderer-ready badges without mutating the public-intel result or context cache. */
export function enrichScanWithPilotContext(
  result: ScanResult,
  context: PilotContext
): ScanResult {
  const pilots = result.pilots.map((pilot) => ({
    ...pilot,
    relationship: classifyPilot({
      characterId: pilot.id,
      corporationId: pilot.corporationId,
      allianceId: pilot.allianceId,
      factionId: pilot.factionId
    }, context)
  }))
  const warnings = [...new Set([
    ...result.warnings,
    ...context.warnings.map((warning) => `Pilot Context: ${warning}`)
  ])]

  return { ...result, pilots, warnings }
}
