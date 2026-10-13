import { describe, expect, it } from 'vitest'
import {
  closePilotWorkspace,
  createPilotWorkspaceState,
  openPilotWorkspace,
  returnFromPilotWorkspace,
  selectWorkspace
} from '../src/shared/pilot-workspace-state'

const pilotA = { characterId: 101, name: 'Pilot A', sourceLabel: 'Local' }
const pilotB = { characterId: 202, name: 'Pilot B', sourceLabel: 'D-scan' }

describe('full pilot workspace navigation', () => {
  it('starts in Intel without an open pilot tab', () => {
    expect(createPilotWorkspaceState()).toEqual({
      activeWorkspace: 'intel',
      lastNonPilotWorkspace: 'intel',
      target: null
    })
  })

  it('opens one full pilot tab and returns to its source workspace', () => {
    const fromIntel = selectWorkspace(createPilotWorkspaceState(), 'intel')
    const opened = openPilotWorkspace(fromIntel, pilotA)

    expect(opened).toMatchObject({
      activeWorkspace: 'pilot',
      lastNonPilotWorkspace: 'intel',
      target: pilotA
    })
    expect(returnFromPilotWorkspace(opened)).toMatchObject({
      activeWorkspace: 'intel',
      target: pilotA
    })
  })

  it('returns from a pilot opened in the watchlist to the watchlist workspace', () => {
    const fromWatchlist = selectWorkspace(createPilotWorkspaceState(), 'watchlist')
    const opened = openPilotWorkspace(fromWatchlist, pilotA)

    expect(opened.lastNonPilotWorkspace).toBe('watchlist')
    expect(returnFromPilotWorkspace(opened).activeWorkspace).toBe('watchlist')
  })

  it.each(['market', 'route', 'journal', 'finance'] as const)(
    'returns from a pilot opened in %s to that workspace',
    (workspace) => {
      const source = selectWorkspace(createPilotWorkspaceState(), workspace)
      const opened = openPilotWorkspace(source, pilotA)

      expect(opened.lastNonPilotWorkspace).toBe(workspace)
      expect(returnFromPilotWorkspace(opened).activeWorkspace).toBe(workspace)
    }
  )

  it('replaces pilot A with pilot B instead of creating a stack', () => {
    const first = openPilotWorkspace(createPilotWorkspaceState(), pilotA)
    const second = openPilotWorkspace(first, pilotB)

    expect(second.target).toEqual(pilotB)
    expect(second.lastNonPilotWorkspace).toBe('intel')
    expect(first.target).toEqual(pilotA)
  })

  it('keeps the dynamic tab when switching away and clears it only on close', () => {
    const opened = openPilotWorkspace(createPilotWorkspaceState(), pilotA)
    const intel = selectWorkspace(opened, 'intel')
    const reopened = selectWorkspace(intel, 'pilot')
    const closed = closePilotWorkspace(reopened)

    expect(intel.target).toEqual(pilotA)
    expect(reopened.activeWorkspace).toBe('pilot')
    expect(closed).toEqual({
      activeWorkspace: 'intel',
      lastNonPilotWorkspace: 'intel',
      target: null
    })
  })

  it('does not enter an empty pilot workspace', () => {
    const initial = createPilotWorkspaceState()
    expect(selectWorkspace(initial, 'pilot')).toBe(initial)
  })
})
