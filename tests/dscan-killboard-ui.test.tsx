import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { analyzeDscanIntelligence } from '../src/shared/dscan-intelligence'
import type { CurrentSystemSnapshot, SystemIntel } from '../src/shared/types'
import type { PilotWatchlistEntry } from '../src/shared/pilot-watchlist'
import type { TacticalClipboardSnapshot } from '../src/renderer/src/ClipboardIntelPanel'
import { DscanKillboardCorrelationPanel } from '../src/renderer/src/App'

const SYSTEM_ID = 30_000_142

describe('D-scan killboard candidate panel', () => {
  it('renders historical candidates as expandable pilot buttons with an explicit disclaimer', () => {
    const capturedAt = '2026-08-25T12:00:00.000Z'
    const snapshot: Extract<TacticalClipboardSnapshot, { kind: 'dscan' }> = {
      kind: 'dscan',
      capturedAt,
      solarSystemId: SYSTEM_ID,
      rows: [],
      rejected: 0,
      intelligence: analyzeDscanIntelligence([
        { typeId: 17_918, type: 'Rattlesnake' }
      ])
    }
    const intel = {
      system: { id: SYSTEM_ID, name: 'Jita' },
      zkill24h: {
        count: 1,
        latest: [],
        sourceCapped: false,
        latestCapped: false,
        capped: false,
        observedShips: [{
          typeId: 17_918,
          name: 'Rattlesnake',
          victimCount: 0,
          attackerCount: 1,
          lastSeen: '2026-08-25T11:55:00.000Z',
          pilots: [{
            characterId: 90_001,
            name: 'Observed Hunter',
            victimCount: 0,
            attackerCount: 1,
            finalBlowCount: 1,
            lastAttackerSeen: '2026-08-25T11:55:00.000Z',
            lastVictimSeen: null,
            lastSeen: '2026-08-25T11:55:00.000Z'
          }],
          pilotsCapped: false,
          occurrences: [{
            killmailId: 700_001,
            time: '2026-08-25T11:55:00.000Z',
            solarSystemId: SYSTEM_ID,
            role: 'attacker',
            pilotCharacterId: 90_001,
            pilotName: 'Observed Hunter',
            finalBlow: true,
            victimCharacterId: 90_002,
            victimName: 'Target Pilot',
            victimShipTypeId: 587,
            victimShipName: 'Rifter',
            totalValue: 12_000_000
          }],
          occurrencesCapped: false
        }],
        observedShipsCapped: false,
        observedPilots: [],
        observedPilotsCapped: false,
        source: 'zKillboard',
        access: 'public',
        temporal: 'historical'
      }
    } as SystemIntel
    const currentSystem = {
      intel,
      online: true,
      location: { solarSystemId: SYSTEM_ID }
    } as CurrentSystemSnapshot
    const watchedEntry: PilotWatchlistEntry = {
      characterId: 90_001,
      name: 'Observed Hunter',
      corporationName: null,
      note: null,
      alertSoundEnabled: true,
      addedAt: capturedAt,
      updatedAt: capturedAt
    }

    const markup = renderToStaticMarkup(
      <DscanKillboardCorrelationPanel
        snapshot={snapshot}
        currentSystem={currentSystem}
        onOpenPilot={() => undefined}
        watchlistById={new Map([[watchedEntry.characterId, watchedEntry]])}
        watchlistPendingEntityKeys={new Set()}
        onToggleWatchlist={() => undefined}
      />
    )

    expect(markup).toContain('D-scan ↔ killboard')
    expect(markup).toContain('Observed Hunter')
    expect(markup).toContain('≤ 15 min · one pilot')
    expect(markup).toContain('Killmail #700001')
    expect(markup).toContain('Open full pilot card for Observed Hunter')
    expect(markup).toContain('Remove Observed Hunter from the watchlist')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).not.toContain('aria-expanded')
    expect(markup).not.toContain('Killboard profile')
    expect(markup).toContain('does not confirm a pilot’s identity')
  })
})
