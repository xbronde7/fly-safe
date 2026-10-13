import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NearbyPvePanel, NearbyPveResults } from '../src/renderer/src/NearbyPvePanel'
import type { NearbyPveSnapshot } from '../src/shared/nearby-pve'

describe('nearby PvE UI', () => {
  it('shows every nearby system with public hourly evidence and a route action', () => {
    const snapshot: NearbyPveSnapshot = {
      originSystemId: 10,
      maxJumps: 2,
      generatedAt: '2026-08-26T12:00:00.000Z',
      topologyComplete: true,
      warnings: [],
      sources: {
        topology: 'ESI universe systems and stargates',
        activity: 'ESI hourly system kills and jumps',
        anomalyCountsAvailable: false
      },
      systems: [
        row(10, 'Current', 0, 5, [10]),
        row(20, 'Busy One', 1, 650, [10, 20]),
        row(30, 'Quiet Two', 2, 0, [10, 20, 30])
      ]
    }
    const markup = renderToStaticMarkup(
      <NearbyPveResults snapshot={snapshot} routingSystemId={null} onSetRoute={() => undefined} />
    )
    expect(markup).toContain('Systems found')
    expect(markup).toContain('Busy One')
    expect(markup).toContain('Quiet Two')
    expect(markup).toContain('650')
    expect(markup).toContain('NPCs in 1 h')
    expect(markup).toContain('Jumps')
    expect(markup).toContain('2 jumps')
    expect(markup.match(/Route in EVE/g)).toHaveLength(2)
  })

  it('states that ESI activity is not a live anomaly count', () => {
    const markup = renderToStaticMarkup(<NearbyPvePanel api={null} currentSystemId={null} />)
    expect(markup).toContain('ESI does not show the number or types of anomalies')
    expect(markup).toContain('not the number of free sites')
    expect(markup).not.toContain('Probe Scanner')
  })
})

function row(
  solarSystemId: number,
  systemName: string,
  jumps: number,
  npcKills: number,
  pathSystemIds: number[]
): NearbyPveSnapshot['systems'][number] {
  return {
    solarSystemId,
    systemName,
    securityStatus: -0.65,
    jumps,
    pathSystemIds,
    npcKills,
    shipKills: 1,
    podKills: 0,
    shipJumps: 20,
    activity: npcKills >= 500 ? 'very-high' : npcKills === 0 ? 'quiet' : 'low'
  }
}
