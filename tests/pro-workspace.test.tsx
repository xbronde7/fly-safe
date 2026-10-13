import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  createCharacterRegistry,
  selectActiveCharacter,
  upsertCharacterProfile,
  upsertCharacterSession
} from '../src/shared/character-registry'
import {
  acceptSharedWorkspaceConsent,
  applySharedWorkspaceMutation,
  createSharedWorkspace
} from '../src/shared/shared-workspace'
import {
  DEFAULT_MARKET_RADAR_DRAFT,
  PRO_WORKSPACE_STORAGE_KEY,
  SHARED_WORKSPACE_REFRESH_INTERVAL_MS,
  ProWorkspace,
  loadProWorkspaceLocalState,
  preferNewestSharedWorkspaceSnapshot,
  serializeProWorkspaceLocalState,
  type ProWorkspaceStorage
} from '../src/renderer/src/ProWorkspace'
import type { EveLocalIntelApi } from '../src/shared/types'

const NOW = '2026-08-25T12:00:00.000Z'
const LATER = '2026-08-25T13:00:00.000Z'

describe('ProWorkspace', () => {
  it('persists public profile metadata but never sessions or credential references', () => {
    let registry = createCharacterRegistry(NOW)
    registry = upsertCharacterProfile(registry, {
      characterId: 21_122_560_144,
      name: 'Safe Pilot',
      corporationName: 'Safe Corp'
    }, NOW)
    registry = upsertCharacterSession(registry, {
      characterId: 21_122_560_144,
      secureCredentialId: 'never-store-this-reference',
      grantedScopes: ['esi-location.read_location.v1'],
      authenticatedAt: NOW,
      expiresAt: LATER
    }, NOW)

    const serialized = serializeProWorkspaceLocalState(registry, DEFAULT_MARKET_RADAR_DRAFT)

    expect(serialized).toContain('Safe Pilot')
    expect(serialized).not.toContain('never-store-this-reference')
    expect(serialized).not.toContain('secureCredentialId')
    expect(serialized).not.toContain('grantedScopes')
    expect(serialized).not.toContain('sessions')
  })

  it('hydrates safe profiles and keeps sessions empty', () => {
    const memory = new Map<string, string>()
    const storage: ProWorkspaceStorage = {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, value)
    }
    memory.set(PRO_WORKSPACE_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      activeCharacterId: 2,
      profiles: [
        { characterId: 1, name: 'Alpha', corporationId: null, corporationName: null, allianceId: null, allianceName: null },
        { characterId: 2, name: 'Bravo', corporationId: null, corporationName: 'Fleet', allianceId: null, allianceName: null }
      ],
      marketDraft: DEFAULT_MARKET_RADAR_DRAFT,
      sessions: [{ secureCredentialId: 'injected' }]
    }))

    const loaded = loadProWorkspaceLocalState(storage, NOW)

    expect(loaded.registry.profiles.map((profile) => profile.name)).toEqual(['Alpha', 'Bravo'])
    expect(loaded.registry.activeCharacterId).toBe(2)
    expect(loaded.registry.sessions).toEqual([])
  })

  it('renders multi-character selection without exposing session metadata', () => {
    let registry = createCharacterRegistry(NOW)
    registry = upsertCharacterProfile(registry, { characterId: 1, name: 'Alpha' }, NOW)
    registry = upsertCharacterProfile(registry, { characterId: 2, name: 'Bravo', corporationName: 'Fleet Corp' }, NOW)
    registry = selectActiveCharacter(registry, 2, NOW)

    const markup = renderToStaticMarkup(
      <ProWorkspace initialRegistry={registry} storage={null} clock={() => NOW} />
    )

    expect(markup).toContain('Pilot profiles')
    expect(markup).toContain('Active: Bravo')
    expect(markup).toContain('Fleet Corp')
    expect(markup).toContain('OAuth tokens')
    expect(markup).not.toContain('secureCredentialId')
  })

  it('renders a positive risk-adjusted market demo', () => {
    const markup = renderToStaticMarkup(
      <ProWorkspace initialTab="radar" storage={null} clock={() => NOW} />
    )

    expect(markup).toContain('Market Opportunity Radar')
    expect(markup).toContain('Tritanium')
    expect(markup).toContain('Jita')
    expect(markup).toContain('Amarr')
    expect(markup).toContain('after risk')
    expect(markup).toContain('Net profit')
    expect(markup).toContain('Historical heuristic')
  })

  it('renders the safer two-jump wormhole route home', () => {
    const markup = renderToStaticMarkup(
      <ProWorkspace initialTab="wormholes" storage={null} clock={() => NOW} />
    )

    expect(markup).toContain('Wormhole Chain Mapper')
    expect(markup).toContain('J-current → J-safe → HOME')
    expect(markup).toContain('2 jumps · safe')
    expect(markup).toContain('critical · stable')
    expect(markup).toContain('stored locally in the SQLite main process')
  })

  it('renders hunter patterns and a 7 by 24 heatmap', () => {
    const markup = renderToStaticMarkup(
      <ProWorkspace initialTab="hunter" storage={null} clock={() => NOW} />
    )

    expect(markup).toContain('Target activity windows')
    expect(markup).toContain('Target One')
    expect(markup).toContain('medium')
    expect(markup).toContain('Heatmap · 7 × 24')
    expect(markup.match(/aria-label="[^"]+: \d+ encounters"/g)).toHaveLength(168)
    expect(markup).toContain('Encounter rows are never sent over the network')
  })

  it('shows only modules granted by entitlement features', () => {
    const markup = renderToStaticMarkup(
      <ProWorkspace
        initialTab="characters"
        storage={null}
        clock={() => NOW}
        features={['wormhole_chain_mapper']}
      />
    )

    expect(markup).toContain('Wormhole Chain Mapper')
    expect(markup).not.toContain('Multi-character')
    expect(markup).not.toContain('Hunter Planner')
    expect(markup).not.toContain('Market Radar')
  })

  it('renders doctrine shortages, excess and the aggregate match score', () => {
    const markup = renderToStaticMarkup(
      <ProWorkspace initialTab="doctrine" storage={null} clock={() => NOW} />
    )

    expect(markup).toContain('D-scan Doctrine Matcher')
    expect(markup).toContain('50% · partial')
    expect(markup).toContain('logistics')
    expect(markup).toContain('Guardian')
    expect(markup).toContain('missing')
    expect(markup).toContain('Outside template: tackle ×2')
  })

  it('renders members, consent and shared watchlist records', () => {
    let workspace = createSharedWorkspace({
      workspaceId: 'fleet-one',
      name: 'Home Defense',
      policyVersion: 1,
      owner: { characterId: 2, characterName: 'Bravo' }
    }, NOW)
    workspace = acceptSharedWorkspaceConsent(workspace, {
      characterId: 2,
      policyVersion: 1,
      scopes: ['watchlist', 'doctrines', 'routes'],
      expectedWorkspaceRevision: workspace.revision
    }, NOW)
    const applied = applySharedWorkspaceMutation(workspace, 2, {
      operation: 'upsert',
      mutationId: 'mutation-one',
      collection: 'watchlist',
      recordId: 'character-9001',
      expectedRevision: 0,
      baseWorkspaceRevision: workspace.revision,
      payload: {
        entityType: 'character',
        entityId: 9001,
        name: 'Danger Pilot',
        severity: 'critical',
        tags: ['test'],
        note: null
      }
    }, NOW)
    if (!applied.ok) throw new Error(applied.message)

    let registry = createCharacterRegistry(NOW)
    registry = upsertCharacterProfile(registry, { characterId: 2, name: 'Bravo' }, NOW)

    const markup = renderToStaticMarkup(
      <ProWorkspace
        initialTab="fleet"
        initialRegistry={registry}
        initialWorkspace={applied.workspace}
        storage={null}
        clock={() => NOW}
      />
    )

    expect(markup).toContain('Shared operations workspace')
    expect(markup).toContain('Home Defense')
    expect(markup).toContain('Sharing allowed')
    expect(markup).toContain('Danger Pilot')
    expect(markup).toContain('critical')
    expect(markup).toContain('not written to renderer localStorage')
  })

  it('keeps cloud refresh monotonic and exposes manual refresh', () => {
    const revisionOne = createSharedWorkspace({
      workspaceId: 'fleet-refresh',
      name: 'Refresh Fleet',
      policyVersion: 1,
      owner: { characterId: 2, characterName: 'Bravo' }
    }, NOW)
    const revisionTwo = acceptSharedWorkspaceConsent(revisionOne, {
      characterId: 2,
      policyVersion: 1,
      scopes: ['watchlist'],
      expectedWorkspaceRevision: revisionOne.revision
    }, LATER)

    expect(SHARED_WORKSPACE_REFRESH_INTERVAL_MS).toBe(15_000)
    expect(preferNewestSharedWorkspaceSnapshot(revisionTwo, revisionOne)).toBe(revisionTwo)

    let registry = createCharacterRegistry(NOW)
    registry = upsertCharacterProfile(registry, { characterId: 2, name: 'Bravo' }, NOW)
    const markup = renderToStaticMarkup(
      <ProWorkspace
        initialTab="fleet"
        initialRegistry={registry}
        initialWorkspace={revisionTwo}
        storage={null}
        clock={() => NOW}
        api={{} as EveLocalIntelApi}
        features={['corp_fleet_intel']}
      />
    )

    expect(markup).toContain('Refresh room')
    expect(markup).toContain('rev 2')
  })
})
