import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PilotFavoriteButton } from '../src/renderer/src/PilotFavoriteButton'
import { PilotWatchlistPanel } from '../src/renderer/src/PilotWatchlistPanel'
import { PilotIntelIdentityCell } from '../src/renderer/src/App'
import type { PilotWatchlistEntry } from '../src/shared/pilot-watchlist'
import type { PilotIntel } from '../src/shared/types'

const watchedPilot: PilotWatchlistEntry = {
  characterId: 90_001,
  name: 'Danger Pilot',
  corporationName: 'Danger Corp',
  note: 'Кемпер на воротах',
  alertSoundEnabled: true,
  addedAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z'
}

const intelPilot: PilotIntel = {
  id: watchedPilot.characterId,
  name: watchedPilot.name,
  corporationId: 98_001,
  corporationName: watchedPilot.corporationName,
  allianceId: null,
  allianceName: null,
  factionId: null,
  stats: null,
  threatScore: 75,
  threatLevel: 'critical',
  reasons: ['Тестовая угроза'],
  zkillUrl: 'https://zkillboard.com/character/90001/',
  cached: true,
  error: null
}

describe('pilot watchlist UI', () => {
  it('renders an accessible one-click favorite control', () => {
    const addMarkup = renderToStaticMarkup(
      <PilotFavoriteButton
        pilot={{ characterId: 90_001, name: 'Danger Pilot' }}
        favorite={false}
        onToggle={() => undefined}
      />
    )
    const removeMarkup = renderToStaticMarkup(
      <PilotFavoriteButton
        pilot={{ characterId: 90_001, name: 'Danger Pilot' }}
        favorite
        onToggle={() => undefined}
      />
    )

    expect(addMarkup).toContain('aria-pressed="false"')
    expect(addMarkup).toContain('Add Danger Pilot to the watchlist')
    expect(addMarkup).toContain('☆')
    expect(removeMarkup).toContain('aria-pressed="true"')
    expect(removeMarkup).toContain('Remove Danger Pilot from the watchlist')
    expect(removeMarkup).toContain('★')
  })

  it('keeps a directly favorited pilot name visible and openable without a duplicate row label', () => {
    const markup = renderToStaticMarkup(
      <PilotIntelIdentityCell
        pilot={intelPilot}
        watchlisted
        watchlistMatch
        onOpen={() => undefined}
        onToggleFavorite={() => undefined}
      />
    )

    expect(markup).toContain('class="pilot-name-button"')
    expect(markup).toContain('title="Danger Pilot">Danger Pilot</button>')
    expect(markup).toContain('aria-label="Open full pilot card for Danger Pilot"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).not.toContain('class="watchlist-row-label"')
  })

  it('keeps the compact row label for an indirect corporation or alliance match', () => {
    const markup = renderToStaticMarkup(
      <PilotIntelIdentityCell
        pilot={intelPilot}
        watchlisted={false}
        watchlistMatch
        onOpen={() => undefined}
        onToggleFavorite={() => undefined}
      />
    )

    expect(markup).toContain('title="Danger Pilot">Danger Pilot</button>')
    expect(markup).toContain('class="watchlist-row-label"')
    expect(markup).toContain('Corporation / alliance on watchlist')
  })

  it('renders the contact list, note, per-contact sound and removal controls', () => {
    const markup = renderToStaticMarkup(
      <PilotWatchlistPanel
        entries={[watchedPilot]}
        loading={false}
        pendingEntityKeys={new Set()}
        soundEnabled
        onSoundEnabledChange={() => undefined}
        onTestSound={() => undefined}
        onOpenPilot={() => undefined}
        onUpdate={() => undefined}
        onRemove={() => undefined}
      />
    )

    expect(markup).toContain('Dangerous contacts')
    expect(markup).toContain('Danger Pilot')
    expect(markup).toContain('Danger Corp')
    expect(markup).toContain('Кемпер на воротах')
    expect(markup).toContain('Contact sound')
    expect(markup).toContain('aria-label="Sound for Danger Pilot"')
    expect(markup).toContain('aria-label="Save note for Danger Pilot"')
    expect(markup).toContain('aria-label="Remove Danger Pilot from watchlist"')
    expect(markup).toContain('Test sound')
    expect(markup).toContain('Remove')
    expect(markup).not.toContain('<button type="button"><button')
  })

  it('explains one-click adding when the list is empty', () => {
    const markup = renderToStaticMarkup(
      <PilotWatchlistPanel
        entries={[]}
        loading={false}
        pendingEntityKeys={new Set()}
        soundEnabled
        onSoundEnabledChange={() => undefined}
        onTestSound={() => undefined}
        onOpenPilot={() => undefined}
        onUpdate={() => undefined}
        onRemove={() => undefined}
      />
    )

    expect(markup).toContain('The list is empty')
    expect(markup).toContain('press the star')
    expect(markup).not.toContain('EVE contacts')
  })

  it.each([
    [1, 'contact'],
    [2, 'contacts'],
    [5, 'contacts'],
    [11, 'contacts'],
    [21, 'contacts'],
    [24, 'contacts']
  ])('uses the correct contact wording for %i entries', (count, word) => {
    const entries = Array.from({ length: count }, (_, index) => ({
      ...watchedPilot,
      characterId: watchedPilot.characterId + index,
      name: `${watchedPilot.name} ${index + 1}`
    }))
    const markup = renderToStaticMarkup(
      <PilotWatchlistPanel
        entries={entries}
        loading={false}
        pendingEntityKeys={new Set()}
        soundEnabled
        onSoundEnabledChange={() => undefined}
        onTestSound={() => undefined}
        onOpenPilot={() => undefined}
        onUpdate={() => undefined}
        onRemove={() => undefined}
      />
    )

    expect(markup).toContain(`<strong>${count}</strong><span>${word} on the list</span>`)
  })

  it('renders Watchlist 2.0 entity, source, severity and EVE-contact import controls', () => {
    const corporation: PilotWatchlistEntry = {
      ...watchedPilot,
      characterId: 98_765,
      entityType: 'corporation',
      entityId: 98_765,
      name: 'Hostile Corp',
      corporationName: null,
      severity: 'critical',
      tags: ['cyno', 'drop'],
      alertSources: ['local', 'dscan', 'r2z2'],
      soundId: 'critical',
      volume: 0.75,
      cooldownSeconds: 120
    }
    const markup = renderToStaticMarkup(
      <PilotWatchlistPanel
        entries={[corporation]}
        loading={false}
        pendingEntityKeys={new Set()}
        soundEnabled
        onSoundEnabledChange={() => undefined}
        onTestSound={() => undefined}
        onOpenPilot={() => undefined}
        onUpdate={() => undefined}
        onAdvancedUpdate={() => undefined}
        onCreateEntity={() => undefined}
        onRemove={() => undefined}
        eveContactImportCount={12}
        onImportEveContacts={() => undefined}
      />
    )

    expect(markup).toContain('Watchlist 2.0')
    expect(markup).toContain('Hostile Corp')
    expect(markup).toContain('Corporation · ID 98765')
    expect(markup).toContain('Critical')
    expect(markup).toContain('cyno')
    expect(markup).toContain('D-scan')
    expect(markup).toContain('System killmail')
    expect(markup).toContain('pilots only')
    expect(markup).toContain('Corporations and alliances support Local and R2Z2')
    expect(markup).toContain('R2Z2')
    expect(markup).toContain('Save rules')
    expect(markup).toContain('Add manually')
    expect(markup).toContain('EVE contacts')
    expect(markup).toContain('Import contacts')
    expect(markup).toContain('Nothing will change in EVE')
  })
})
