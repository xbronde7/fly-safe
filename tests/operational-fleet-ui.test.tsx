import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FriendlyFleetPanel } from '../src/renderer/src/OperationalIntelPanels'
import type { PilotContext } from '../src/shared/pilot-context'

function contextWithUnavailableRoster(): PilotContext {
  return {
    characterId: 90_000_001,
    contacts: null,
    fleet: {
      fleetId: 1_234_567_890,
      fleetBossId: 90_000_002,
      ownRole: 'squad_member',
      ownWingId: 33,
      ownSquadId: 44,
      membersAvailable: false,
      members: [],
      cached: false
    },
    fetchedAt: '2026-08-26T12:00:00Z',
    partial: false,
    warnings: [],
    provenance: {
      access: 'authenticated',
      fleetRoster: 'friendly-only',
      localRosterAvailable: false
    }
  }
}

describe('FriendlyFleetPanel', () => {
  it('shows an inaccessible fleet roster as a neutral limitation', () => {
    const markup = renderToStaticMarkup(
      <FriendlyFleetPanel
        context={contextWithUnavailableRoster()}
        status={{ state: 'ready', connected: true }}
      />
    )

    expect(markup).toContain('Fleet boss only')
    expect(markup).toContain('Roster available to fleet boss')
    expect(markup).toContain('ESI provides the full roster only to the fleet boss')
    expect(markup).toContain('Other intelligence continues to work')
    expect(markup).not.toContain('operational-warning-list')
    expect(markup).not.toContain('The fleet does not exist')
    expect(markup).not.toContain('aria-label="Friendly fleet summary"')
  })
})
