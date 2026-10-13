import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CombatHistoryCard,
  CombatHistoryList,
  LastObservedPilotShipCard,
  mergeCombatHistoryPage,
  PilotWorkspacePanel
} from '../src/renderer/src/App'
import type {
  CombatHistoryAttacker,
  CombatHistoryEntry,
  CombatHistoryPageInfo,
  PilotCombatHistory,
  ShipFit
} from '../src/shared/types'

function shipFit(shipTypeId: number, shipName: string): ShipFit {
  return {
    shipTypeId,
    shipName,
    sections: {
      high: [],
      medium: [],
      low: [],
      rig: [],
      subsystem: [],
      drone: [],
      fighter: [],
      cargo: [],
      other: []
    },
    totalDestroyed: 0,
    totalDropped: 0
  }
}

function sampleAttackers(): CombatHistoryAttacker[] {
  return [
    {
      characterId: 90_001,
      name: 'Full Screen Pilot',
      corporationId: 98_001,
      corporationName: 'Test Corp',
      allianceId: 99_001,
      allianceName: 'Test Alliance',
      shipTypeId: 17_918,
      shipName: 'Rattlesnake',
      weaponTypeId: 32_050,
      weaponName: 'Cruise Missile Launcher II',
      damageDone: 900,
      finalBlow: false
    },
    {
      characterId: 90_002,
      name: 'Sabre Scout',
      corporationId: 98_002,
      corporationName: 'Black Wing',
      allianceId: 99_001,
      allianceName: 'Test Alliance',
      shipTypeId: 22_456,
      shipName: 'Sabre',
      weaponTypeId: 28_376,
      weaponName: '200mm AutoCannon II',
      damageDone: 800,
      finalBlow: false
    },
    {
      characterId: 90_003,
      name: 'Final Loki',
      corporationId: 98_003,
      corporationName: 'Wormhole Police',
      allianceId: 99_002,
      allianceName: 'Deep Space Union',
      shipTypeId: 29_984,
      shipName: 'Loki',
      weaponTypeId: 29_803,
      weaponName: 'Heavy Assault Missile Launcher II',
      damageDone: 700,
      finalBlow: true
    },
    {
      characterId: 90_004,
      name: 'Guardian Logi',
      corporationId: 98_004,
      corporationName: 'Remote Repairs',
      allianceId: 99_002,
      allianceName: 'Deep Space Union',
      shipTypeId: 11_987,
      shipName: 'Guardian',
      weaponTypeId: null,
      weaponName: null,
      damageDone: 600,
      finalBlow: false
    },
    {
      characterId: 90_005,
      name: 'Bhaalgorn Tackle',
      corporationId: 98_005,
      corporationName: 'Heavy Metal',
      allianceId: 99_003,
      allianceName: 'Night Fleet',
      shipTypeId: 17_920,
      shipName: 'Bhaalgorn',
      weaponTypeId: 12_260,
      weaponName: 'Heavy Energy Neutralizer II',
      damageDone: 500,
      finalBlow: false
    }
  ]
}

function combatEntry(
  kind: 'kill' | 'loss',
  overrides: Partial<CombatHistoryEntry> = {}
): CombatHistoryEntry {
  return {
    kind,
    killmailId: kind === 'kill' ? 700_001 : 700_002,
    time: kind === 'kill' ? '2026-08-23T18:07:00.000Z' : '2026-08-24T18:07:00.000Z',
    solarSystemId: 31_002_000,
    solarSystemName: 'J162010',
    victimCharacterId: 90_001,
    victimName: 'Full Screen Pilot',
    victimCorporationName: 'Test Corp',
    victimFit: shipFit(11_987, 'Crow'),
    attackerShipTypeId: kind === 'kill' ? 17_918 : null,
    attackerShipName: kind === 'kill' ? 'Rattlesnake' : null,
    pilotFinalBlow: false,
    attackers: [],
    attackerCount: 0,
    attackersCapped: false,
    nonCapsuleerAttackerCount: 0,
    totalValue: 100_000_000,
    solo: false,
    ...overrides
  }
}

function combatHistory({
  kills = [],
  losses = [],
  pageInfo = {},
  warnings = []
}: Partial<Pick<PilotCombatHistory, 'kills' | 'losses' | 'pageInfo' | 'warnings'>> = {}): PilotCombatHistory {
  return {
    characterId: 90_001,
    fetchedAt: '2026-08-25T00:00:00.000Z',
    cached: false,
    kills,
    losses,
    pageInfo,
    warnings
  }
}

function historyPage(
  overrides: Partial<CombatHistoryPageInfo> = {}
): CombatHistoryPageInfo {
  return {
    offset: 0,
    limit: 10,
    nextOffset: 10,
    hasMore: true,
    ...overrides
  }
}

describe('full pilot workspace', () => {
  it('offers another 50 records while keeping the rendered combat cards visible', () => {
    const markup = renderToStaticMarkup(
      <CombatHistoryList
        entries={[combatEntry('kill')]}
        kind="kill"
        pageInfo={historyPage()}
        loadMoreState={{ status: 'loading' }}
        expandedKillmailId={700_001}
        focusedCharacterId={90_001}
        onToggleKillmail={() => undefined}
        onLoadMore={() => undefined}
      />
    )

    expect(markup).toContain('Rattlesnake')
    expect(markup).toContain('killmail-fit-700001')
    expect(markup).toContain('Loading 50 more…')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('aria-busy="true"')
  })

  it('shows an inline retry and an honest end-of-history state', () => {
    const errorMarkup = renderToStaticMarkup(
      <CombatHistoryList
        entries={[combatEntry('loss')]}
        kind="loss"
        pageInfo={historyPage({ offset: 10, nextOffset: 60 })}
        loadMoreState={{ status: 'error', error: 'zKillboard временно недоступен' }}
        expandedKillmailId={null}
        focusedCharacterId={90_001}
        onToggleKillmail={() => undefined}
        onLoadMore={() => undefined}
      />
    )
    const completeMarkup = renderToStaticMarkup(
      <CombatHistoryList
        entries={[combatEntry('loss')]}
        kind="loss"
        pageInfo={historyPage({ offset: 10, nextOffset: 11, hasMore: false })}
        loadMoreState={{ status: 'idle' }}
        expandedKillmailId={null}
        focusedCharacterId={90_001}
        onToggleKillmail={() => undefined}
        onLoadMore={() => undefined}
      />
    )

    expect(errorMarkup).toContain('role="alert"')
    expect(errorMarkup).toContain('zKillboard временно недоступен')
    expect(errorMarkup).toContain('Retry · 50 more')
    expect(completeMarkup).toContain('No more entries in available history')
    expect(completeMarkup).not.toContain('Load 50 more')
  })

  it('merges a selected history page by killmail ID without touching the other tab cursor', () => {
    const originalKill = combatEntry('kill', { victimName: 'old data' })
    const refreshedDuplicate = combatEntry('kill', { victimName: 'fresh data' })
    const appendedKill = combatEntry('kill', { killmailId: 700_003 })
    const loss = combatEntry('loss')
    const current = combatHistory({
      kills: [originalKill],
      losses: [loss],
      pageInfo: {
        kill: historyPage(),
        loss: historyPage({ nextOffset: 7 })
      },
      warnings: ['old warning']
    })
    const incoming = combatHistory({
      kills: [refreshedDuplicate, appendedKill],
      pageInfo: {
        kill: historyPage({ offset: 10, limit: 50, nextOffset: 60, hasMore: false })
      },
      warnings: ['old warning', 'new warning']
    })

    const merged = mergeCombatHistoryPage(current, incoming, 'kill')

    expect(merged.kills.map((entry) => entry.killmailId)).toEqual([700_001, 700_003])
    expect(merged.kills[0].victimName).toBe('fresh data')
    expect(merged.losses).toEqual([loss])
    expect(merged.pageInfo.loss).toEqual(current.pageInfo.loss)
    expect(merged.pageInfo.kill).toEqual(incoming.pageInfo.kill)
    expect(merged.warnings).toEqual(['old warning', 'new warning'])
  })

  it('renders one standalone pilot card with combat tabs and navigation controls', () => {
    const markup = renderToStaticMarkup(
      <PilotWorkspacePanel
        api={null}
        selection={{
          characterId: 90_001,
          name: 'Full Screen Pilot',
          sourceLabel: 'D-scan · Rattlesnake · Killmail #700001'
        }}
        onBack={() => undefined}
        onClose={() => undefined}
        watchlisted
        onToggleWatchlist={() => undefined}
      />
    )

    expect(markup).toContain('Full pilot card')
    expect(markup).toContain('Full Screen Pilot')
    expect(markup).toContain('D-scan · Rattlesnake · Killmail #700001')
    expect(markup).toContain('Back to intel')
    expect(markup).toContain('Close tab')
    expect(markup).toContain('Target profile')
    expect(markup).toContain('Recent kills')
    expect(markup).toContain('Losses and fits')
    expect(markup).toContain('Latest observed ship')
    expect(markup).toContain('Finding latest hull in killmails')
    expect(markup).toContain('Remove Full Screen Pilot from the watchlist')
    expect(markup.match(/historical-pilot-details/g)).toHaveLength(1)
  })

  it('shows every capsuleer participating in an expanded gang killmail', () => {
    const attackers = sampleAttackers()
    const markup = renderToStaticMarkup(
      <CombatHistoryCard
        entry={combatEntry('kill', {
          attackers,
          attackerCount: 5,
          nonCapsuleerAttackerCount: 2
        })}
        expanded
        focusedCharacterId={90_001}
        onToggle={() => undefined}
        onOpenPilot={() => undefined}
      />
    )

    expect(markup).toContain('5 pilots')
    expect(markup).toContain('NPC/structures: 2')
    expect(markup).toContain('FINAL')
    expect(markup).toContain('THIS PILOT')

    for (const attacker of attackers) {
      expect(markup).toContain(attacker.name)
      expect(markup).toContain(attacker.corporationName)
      expect(markup).toContain(attacker.shipName)
      expect(markup).toContain(`<strong>${attacker.damageDone}</strong><small>damage</small>`)
      expect(markup).toContain(
        `aria-label="Open full card for participant ${attacker.name}"`
      )
    }

    const toggleContent = markup.match(
      /<button\b[^>]*class="combat-card-toggle"[^>]*>([\s\S]*?)<\/button>/
    )?.[1]
    expect(toggleContent).toBeDefined()
    expect(toggleContent).toContain('5 pilots + 2 NPC/structures')
    expect(toggleContent).not.toContain('<button')
    expect(markup).toContain('</button><div id="killmail-fit-700001">')
  })

  it.each([
    [1, '1 pilot'],
    [2, '2 pilots'],
    [5, '5 pilots'],
    [11, '11 pilots'],
    [21, '21 pilots']
  ])('shows %s capsuleer attackers immediately in a collapsed row', (attackerCount, label) => {
    const markup = renderToStaticMarkup(
      <CombatHistoryCard
        entry={combatEntry('kill', { attackerCount })}
        expanded={false}
        focusedCharacterId={90_001}
        onToggle={() => undefined}
      />
    )
    const toggleContent = markup.match(
      /<button\b[^>]*class="combat-card-toggle"[^>]*>([\s\S]*?)<\/button>/
    )?.[1]

    expect(toggleContent).toContain(label)
    expect(toggleContent).toContain('Attacked in Rattlesnake')
    expect(markup).not.toContain('Attack participants')
  })

  it('keeps NPC/structures separate from the capsuleer count in a collapsed row', () => {
    const markup = renderToStaticMarkup(
      <CombatHistoryCard
        entry={combatEntry('kill', {
          attackerCount: 0,
          nonCapsuleerAttackerCount: 3
        })}
        expanded={false}
        focusedCharacterId={90_001}
        onToggle={() => undefined}
      />
    )
    const toggleContent = markup.match(
      /<button\b[^>]*class="combat-card-toggle"[^>]*>([\s\S]*?)<\/button>/
    )?.[1]

    expect(toggleContent).toContain('0 pilots + 3 NPC/structures')
  })

  it('discloses when a large attacker list is capped', () => {
    const markup = renderToStaticMarkup(
      <CombatHistoryCard
        entry={combatEntry('kill', {
          attackers: sampleAttackers(),
          attackerCount: 12,
          attackersCapped: true
        })}
        expanded
        focusedCharacterId={90_001}
        onToggle={() => undefined}
      />
    )

    expect(markup).toContain(
      'Showing first 5 of 12 attackers by FINAL and damage.'
    )
  })

  it('shows the exact attacker hull and killmail context', () => {
    const markup = renderToStaticMarkup(
      <LastObservedPilotShipCard
        historyState={{
          status: 'ready',
          data: combatHistory({ kills: [combatEntry('kill')] })
        }}
      />
    )

    expect(markup).toContain('Rattlesnake')
    expect(markup).toContain('Pilot attacked in it')
    expect(markup).toContain('J162010')
    expect(markup).toContain('Killmail #700001')
    expect(markup).toContain('role="status"')
  })

  it('shows the destroyed victim hull when the loss is newest', () => {
    const markup = renderToStaticMarkup(
      <LastObservedPilotShipCard
        historyState={{
          status: 'ready',
          data: combatHistory({
            kills: [combatEntry('kill')],
            losses: [combatEntry('loss')]
          })
        }}
      />
    )

    expect(markup).toContain('Crow')
    expect(markup).toContain('Pilot lost this ship')
    expect(markup).not.toContain('Pilot attacked in it')
  })

  it('separates an empty public history from killmails without a known hull', () => {
    const emptyMarkup = renderToStaticMarkup(
      <LastObservedPilotShipCard
        historyState={{ status: 'ready', data: combatHistory() }}
      />
    )
    const unknownHullMarkup = renderToStaticMarkup(
      <LastObservedPilotShipCard
        historyState={{
          status: 'ready',
          data: combatHistory({
            kills: [combatEntry('kill', {
              attackerShipTypeId: null,
              attackerShipName: null
            })]
          })
        }}
      />
    )

    expect(emptyMarkup).toContain('No public killmails found')
    expect(unknownHullMarkup).toContain('Pilot hull not listed')
  })

  it('marks a result from partial killboard history', () => {
    const markup = renderToStaticMarkup(
      <LastObservedPilotShipCard
        historyState={{
          status: 'ready',
          data: combatHistory({
            kills: [combatEntry('kill')],
            warnings: ['loss history unavailable']
          })
        }}
      />
    )

    expect(markup).toContain('Incomplete history')
    expect(markup).toContain('Latest hull among loaded killmails')
  })

  it('announces a history error accessibly', () => {
    const markup = renderToStaticMarkup(
      <LastObservedPilotShipCard
        historyState={{ status: 'error', error: 'zKillboard недоступен' }}
      />
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('zKillboard недоступен')
  })
})
