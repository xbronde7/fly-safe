import type { PilotIntel } from './types'

export type WorkspaceId =
  | 'intel'
  | 'market'
  | 'industry'
  | 'production'
  | 'route'
  | 'watchlist'
  | 'journal'
  | 'finance'
  | 'pro'
  | 'settings'
  | 'pilot'
export type BaseWorkspaceId = Exclude<WorkspaceId, 'pilot'>

export interface PilotWorkspaceTarget {
  characterId: number
  name: string | null
  sourceLabel: string
  initialPilot?: PilotIntel
}

export interface PilotWorkspaceState {
  activeWorkspace: WorkspaceId
  lastNonPilotWorkspace: BaseWorkspaceId
  target: PilotWorkspaceTarget | null
}

export function createPilotWorkspaceState(): PilotWorkspaceState {
  return {
    activeWorkspace: 'intel',
    lastNonPilotWorkspace: 'intel',
    target: null
  }
}

export function openPilotWorkspace(
  state: PilotWorkspaceState,
  target: PilotWorkspaceTarget
): PilotWorkspaceState {
  return {
    activeWorkspace: 'pilot',
    lastNonPilotWorkspace:
      state.activeWorkspace === 'pilot'
        ? state.lastNonPilotWorkspace
        : state.activeWorkspace,
    target: { ...target }
  }
}

export function selectWorkspace(
  state: PilotWorkspaceState,
  workspace: WorkspaceId
): PilotWorkspaceState {
  if (workspace === 'pilot' && state.target === null) return state
  return {
    ...state,
    activeWorkspace: workspace,
    lastNonPilotWorkspace:
      workspace === 'pilot' ? state.lastNonPilotWorkspace : workspace
  }
}

export function returnFromPilotWorkspace(state: PilotWorkspaceState): PilotWorkspaceState {
  return selectWorkspace(state, state.lastNonPilotWorkspace)
}

export function closePilotWorkspace(state: PilotWorkspaceState): PilotWorkspaceState {
  return {
    activeWorkspace:
      state.activeWorkspace === 'pilot'
        ? state.lastNonPilotWorkspace
        : state.activeWorkspace,
    lastNonPilotWorkspace: state.lastNonPilotWorkspace,
    target: null
  }
}
