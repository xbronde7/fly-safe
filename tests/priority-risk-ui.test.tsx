import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PriorityRiskControl } from '../src/renderer/src/PriorityRiskControl'
import {
  assessPriorityRisk,
  formatPriorityRiskEvidence
} from '../src/shared/priority-risk'
import { buildRecentTargetProfile, buildTargetProfile } from '../src/shared/target-profile'

describe('priority risk UI', () => {
  it('renders the general mode and every target priority in an accessible select', () => {
    const html = renderToStaticMarkup(
      <PriorityRiskControl
        value="general"
        onChange={vi.fn()}
        loaded={0}
        total={7}
        loading={false}
      />
    )

    expect(html).toContain('aria-label="Risk priority by destroyed target type"')
    for (const label of [
      'Overall PvP', 'Scanners', 'Logistics', 'Mining', 'Haulers', 'PvE',
      'Combat', 'Capitals', 'Structures'
    ]) {
      expect(html).toContain(label)
    }
    expect(html).not.toContain('Other')
  })

  it('shows bounded background progress for the selected target type', () => {
    const html = renderToStaticMarkup(
      <PriorityRiskControl
        value="scanner"
        onChange={vi.fn()}
        loaded={3}
        total={7}
        loading
      />
    )

    expect(html).toContain('last 10 kills: 3/7')
    expect(html).toContain('<option value="scanner" selected="">Scanners</option>')
  })

  it('formats recent and lifetime evidence without implying the attacker flew that hull', () => {
    const recentProfile = buildRecentTargetProfile([
      ...Array.from({ length: 7 }, () => ({ shipName: 'Astero' })),
      ...Array.from({ length: 3 }, () => ({ shipName: 'Rifter' }))
    ])
    const assessment = assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: buildTargetProfile({
        scanner: { groupID: 1022, shipsDestroyed: 24 },
        other: { groupID: 29, shipsDestroyed: 76 }
      }, 100),
      baseThreatScore: 60,
      recent: {
        characterId: 90_000_001,
        fetchedAt: '2026-08-27T00:00:00.000Z',
        cached: true,
        requestedSampleSize: 10,
        sampleSize: 10,
        complete: true,
        profile: recentProfile,
        warnings: []
      },
      evidenceStatus: 'ready'
    })

    expect(formatPriorityRiskEvidence(assessment, 'ready')).toBe('7/10 recent · 24% lifetime')
    expect(assessment.reasons.join(' ')).toContain('kills')
    expect(assessment.reasons.join(' ')).not.toContain('flew')
  })

  it('keeps small non-zero lifetime shares visible', () => {
    const assessment = assessPriorityRisk({
      category: 'scanner',
      lifetimeProfile: buildTargetProfile({
        scanner: { groupID: 1022, shipsDestroyed: 9 },
        other: { groupID: 29, shipsDestroyed: 1_837 }
      }, 1_846),
      baseThreatScore: 70,
      recent: {
        characterId: 90_000_001,
        fetchedAt: '2026-08-27T00:00:00.000Z',
        cached: true,
        requestedSampleSize: 10,
        sampleSize: 10,
        complete: true,
        profile: buildRecentTargetProfile(
          Array.from({ length: 10 }, () => ({ shipName: 'Rifter' }))
        ),
        warnings: []
      },
      evidenceStatus: 'ready'
    })

    expect(formatPriorityRiskEvidence(assessment, 'ready')).toBe('0/10 recent · 0.5% lifetime')
  })
})
