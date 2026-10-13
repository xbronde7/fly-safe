import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PilotRosterObservationCard } from '../src/renderer/src/App'

describe('pilot roster observation UI', () => {
  it('shows a safe lookup by default with an explicit Local action', () => {
    const markup = renderToStaticMarkup(
      <PilotRosterObservationCard
        source="lookup"
        systemId={30_000_142}
        systemName="Jita"
        confirming={false}
        onConfirm={() => undefined}
      />
    )

    expect(markup).toContain('Regular check — Hunter unchanged')
    expect(markup).toContain('If this is real Local for Jita')
    expect(markup).toContain('Add as Local')
    expect(markup).not.toContain('disabled=""')
  })

  it('disables Local recording when the system was unknown during the scan', () => {
    const markup = renderToStaticMarkup(
      <PilotRosterObservationCard
        source="lookup"
        systemId={null}
        systemName={null}
        confirming={false}
        onConfirm={() => undefined}
      />
    )

    expect(markup).toContain('this result cannot be recorded as Local')
    expect(markup).toContain('disabled=""')
  })

  it('replaces the action with a durable confirmation after recording', () => {
    const markup = renderToStaticMarkup(
      <PilotRosterObservationCard
        source="confirmed-local"
        systemId={30_000_142}
        systemName="Jita"
        confirming={false}
        onConfirm={() => undefined}
      />
    )

    expect(markup).toContain('Local confirmed and added to Hunter')
    expect(markup).toContain('Jita · encounter saved once')
    expect(markup).not.toContain('Add as Local')
  })
})
