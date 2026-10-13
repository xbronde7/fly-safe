import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WormholeChainStore } from '../src/main/wormhole-chain-store'
import {
  extractWormholeProbeSignatures,
  findWormholeRouteHome,
  parseWormholeStatusText,
  type WormholeChain,
  type WormholeConnection,
  type WormholeSystemNode
} from '../src/shared/wormhole-chain'
import type { ProbeRow } from '../src/shared/clipboard-intel'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('wormhole Probe and status parsing', () => {
  it('extracts only wormhole signatures and keeps the strongest duplicate', () => {
    const rows = [
      probe('ABC-123', 'Wormhole K162', 'Unstable Wormhole', 42),
      probe('abc-123', 'Wormhole K162', 'Unstable Wormhole', 100),
      probe('DEF-456', 'Relic Site', 'Ruined Site', 100),
      { ...probe('GHI-789', 'Wormhole', 'Ignored anomaly', 100), kind: 'anomaly' as const }
    ]
    expect(extractWormholeProbeSignatures(rows, {
      sourceSystemNodeId: ' home ',
      observedAt: '2026-08-25T10:00:00Z'
    })).toEqual([{
      sourceSystemNodeId: 'home',
      signatureId: 'ABC-123',
      group: 'Cosmic Signature',
      typeName: 'Wormhole K162',
      wormholeCode: 'K162',
      name: 'Unstable Wormhole',
      signalStrength: 100,
      distanceMeters: 149_597_870_700,
      observedAt: '2026-08-25T10:00:00.000Z'
    }])
  })

  it('recognizes official mass/lifetime phrases and preserves evidence', () => {
    const stable = parseWormholeStatusText(`
      This wormhole has not yet begun to decay, and probably won't for at least another day.
      This wormhole has not yet had its stability significantly disrupted by ships passing through it.
    `)
    expect(stable).toMatchObject({ massStatus: 'stable', lifeStatus: 'stable' })
    expect(stable.evidence.length).toBe(2)

    expect(parseWormholeStatusText(`
      This wormhole is beginning to decay, and probably won't last another day.
      This wormhole has had its stability critically disrupted by ships passing through it.
    `)).toMatchObject({ massStatus: 'critical', lifeStatus: 'end-of-life' })
    expect(parseWormholeStatusText('Червоточина схлопнулась.')).toMatchObject({
      massStatus: 'collapsed',
      lifeStatus: 'collapsed',
      evidence: [expect.stringContaining('червоточина')]
    })
  })
})

describe('wormhole route-home model', () => {
  it('chooses a safer two-jump route over a critical direct connection', () => {
    const chain: WormholeChain = {
      systems: [system('current'), system('safe-hop'), system('home', true)],
      signatures: [],
      connections: [
        connection('direct', 'current', 'home', 'critical', 'stable'),
        connection('safe-1', 'current', 'safe-hop', 'stable', 'stable'),
        connection('safe-2', 'safe-hop', 'home', 'stable', 'stable')
      ]
    }
    expect(findWormholeRouteHome(chain, 'current', '2026-08-25T10:00:00Z')).toEqual({
      homeSystemNodeId: 'home',
      systemNodeIds: ['current', 'safe-hop', 'home'],
      connectionIds: ['safe-1', 'safe-2'],
      jumps: 2,
      riskScore: 0,
      risk: 'safe',
      warnings: []
    })
    chain.connections[1].lifeStatus = 'collapsed'
    chain.connections[2].expiresAt = '2026-08-25T09:59:00Z'
    expect(findWormholeRouteHome(chain, 'current', '2026-08-25T10:00:00Z'))
      .toMatchObject({ connectionIds: ['direct'], risk: 'dangerous' })
  })

  it('persists systems, Probe observations, connection state, and route home', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fly-safe-wormholes-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'wormholes.sqlite')
    const now = Date.parse('2026-08-25T10:00:00Z')
    const store = new WormholeChainStore(databasePath, () => now)
    const home = store.upsertSystem({ solarSystemId: 31_000_001, name: 'J100001', isHome: true })
    const current = store.upsertSystem({ solarSystemId: 31_000_002, name: 'J100002' })
    expect(store.recordProbeScan(current.id, [probe('XYZ-999', 'Wormhole H296', null, 87)]))
      .toMatchObject([{ signatureId: 'XYZ-999', wormholeCode: 'H296' }])
    const saved = store.upsertConnection({
      id: 'connection:home',
      fromSystemNodeId: current.id,
      toSystemNodeId: home.id,
      fromSignatureId: 'xyz-999',
      wormholeCode: 'H296',
      massStatus: 'stable',
      lifeStatus: 'stable'
    })
    expect(store.findRouteHome(current.id)).toMatchObject({
      homeSystemNodeId: home.id,
      connectionIds: [saved.id]
    })
    expect(store.updateConnectionStatusFromText(
      saved.id,
      `This wormhole is beginning to decay, and probably won't last another day.`
    )).toMatchObject({ massStatus: 'stable', lifeStatus: 'end-of-life' })
    store.close()

    const reopened = new WormholeChainStore(databasePath, () => now)
    expect(reopened.getChain()).toMatchObject({
      systems: expect.arrayContaining([
        expect.objectContaining({ id: home.id, isHome: true }),
        expect.objectContaining({ id: current.id })
      ]),
      signatures: [expect.objectContaining({ signatureId: 'XYZ-999' })],
      connections: [expect.objectContaining({ id: saved.id, lifeStatus: 'end-of-life' })]
    })
    reopened.close()
  })
})

function probe(
  id: string,
  type: string,
  name: string | null,
  signal: number
): ProbeRow {
  return {
    id,
    group: 'Cosmic Signature',
    kind: 'signature',
    type,
    name,
    signal,
    signalText: `${signal}%`,
    distance: { text: '1 AU', value: 1, unit: 'au', meters: 149_597_870_700 },
    distanceText: '1 AU',
    lineNumber: 1
  }
}

function system(id: string, isHome = false): WormholeSystemNode {
  return {
    id,
    solarSystemId: null,
    name: id,
    isHome,
    firstSeenAt: '2026-08-25T09:00:00.000Z',
    lastSeenAt: '2026-08-25T10:00:00.000Z'
  }
}

function connection(
  id: string,
  fromSystemNodeId: string,
  toSystemNodeId: string,
  massStatus: WormholeConnection['massStatus'],
  lifeStatus: WormholeConnection['lifeStatus']
): WormholeConnection {
  return {
    id,
    fromSystemNodeId,
    toSystemNodeId,
    fromSignatureId: null,
    reverseSignatureId: null,
    wormholeCode: null,
    massStatus,
    lifeStatus,
    discoveredAt: '2026-08-25T09:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    expiresAt: null
  }
}
