import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NearbyAnomalyResults } from '../src/renderer/src/NearbyAnomalyPanel'
import type { NearbyAnomalySnapshot } from '../src/shared/nearby-anomalies'

describe('nearby anomaly results UI', () => {
  it('shows visible count, age, route action and the scanner-data boundary', () => {
    const snapshot: NearbyAnomalySnapshot = {
      originSystemId: 10,
      maxJumps: 2,
      generatedAt: '2026-08-26T12:00:00.000Z',
      systems: [
        {
          solarSystemId: 10,
          systemName: 'Current',
          securityStatus: -0.1,
          jumps: 0,
          pathSystemIds: [10],
          anomalyCount: null,
          signatureCount: null,
          sites: [],
          observedAt: null,
          ageMinutes: null,
          freshness: 'unseen'
        },
        {
          solarSystemId: 30,
          systemName: 'Rich System',
          securityStatus: -0.7,
          jumps: 2,
          pathSystemIds: [10, 20, 30],
          anomalyCount: 10,
          signatureCount: 2,
          sites: [{ name: 'Forsaken Hub', count: 6 }],
          observedAt: '2026-08-26T11:52:00.000Z',
          ageMinutes: 8,
          freshness: 'fresh'
        }
      ],
      coverage: { checkedReports: 3, nearbyReports: 1 },
      warnings: []
    }

    const markup = renderToStaticMarkup(
      <NearbyAnomalyResults snapshot={snapshot} routingSystemId={null} onSetRoute={() => undefined} />
    )

    expect(markup).toContain('Rich System')
    expect(markup).toContain('10')
    expect(markup).toContain('visible in scan')
    expect(markup).toContain('2 jumps')
    expect(markup).toContain('fresh · 8 min ago')
    expect(markup).toContain('Forsaken Hub ×6')
    expect(markup).toContain('Route in EVE')
    expect(markup).toContain('no scan yet')
  })

  it('does not render a zero for systems without a saved report', () => {
    const snapshot: NearbyAnomalySnapshot = {
      originSystemId: 10,
      maxJumps: 2,
      generatedAt: '2026-08-26T12:00:00.000Z',
      systems: [{
        solarSystemId: 10,
        systemName: 'Unknown Current',
        securityStatus: null,
        jumps: 0,
        pathSystemIds: [10],
        anomalyCount: null,
        signatureCount: null,
        sites: [],
        observedAt: null,
        ageMinutes: null,
        freshness: 'unseen'
      }],
      coverage: { checkedReports: 0, nearbyReports: 0 },
      warnings: []
    }
    const markup = renderToStaticMarkup(
      <NearbyAnomalyResults snapshot={snapshot} routingSystemId={null} onSetRoute={() => undefined} />
    )
    expect(markup).toContain('no scan yet')
    expect(markup).not.toContain('in scan: 0')
  })
})
