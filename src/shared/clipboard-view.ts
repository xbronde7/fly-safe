import { classifyEveClipboard } from './clipboard-intel'
import { parseLocalRoster } from './local-parser'
import type { WorkspaceId } from './pilot-workspace-state'

export type ActiveClipboardMode = 'local' | 'dscan' | 'probe' | null
export type EveClipboardRoute = Exclude<ActiveClipboardMode, null> | 'unknown'
export type ClipboardScrollTarget = 'input' | 'result'

export interface ClipboardNavigation {
  workspace: 'intel'
  scrollTarget: ClipboardScrollTarget
}

export interface ClipboardViewVisibility {
  showLocalResult: boolean
  showTacticalResult: boolean
  showEmptyState: boolean
}

export function getClipboardViewVisibility(
  mode: ActiveClipboardMode,
  hasLocalResult: boolean,
  isScanning: boolean
): ClipboardViewVisibility {
  return {
    showLocalResult: mode === 'local' && hasLocalResult,
    showTacticalResult: mode === 'dscan' || mode === 'probe',
    showEmptyState: mode === null && !isScanning
  }
}

export function getClipboardScrollBehavior(prefersReducedMotion: boolean): 'auto' | 'smooth' {
  return prefersReducedMotion ? 'auto' : 'smooth'
}

/** Recognized EVE clipboard data always opens at its current result/progress block. */
export function getClipboardNavigation(route: EveClipboardRoute): ClipboardNavigation | null {
  return route === 'unknown'
    ? null
    : { workspace: 'intel', scrollTarget: 'result' }
}

/** Market and Route own their clipboard while open; their text must not trigger Intel. */
export function shouldProcessAutomaticClipboard(activeWorkspace: WorkspaceId): boolean {
  return activeWorkspace !== 'market' && activeWorkspace !== 'route' && activeWorkspace !== 'industry' && activeWorkspace !== 'production'
}

export interface AutomaticClipboardDecision {
  normalizedText: string
  route: EveClipboardRoute
  changed: boolean
  shouldProcess: boolean
}

/** Absorb new Market/Route clipboard text so it cannot fire later after leaving the workspace. */
export function decideAutomaticClipboard(
  rawText: string,
  previousText: string,
  activeWorkspace: WorkspaceId
): AutomaticClipboardDecision {
  const normalizedText = rawText.trim()
  const changed = normalizedText.length > 0 && normalizedText !== previousText
  const route = changed ? routeEveClipboard(normalizedText) : 'unknown'
  const tacticalRoute = route === 'dscan' || route === 'probe'
  return {
    normalizedText,
    route,
    changed,
    shouldProcess:
      changed &&
      route !== 'unknown' &&
      (shouldProcessAutomaticClipboard(activeWorkspace) || tacticalRoute)
  }
}

/** A single plausible name needs ESI confirmation before automatic navigation. */
export function shouldDeferAutomaticLocalNavigation(
  source: 'manual' | 'auto',
  route: EveClipboardRoute,
  detectedKind: ReturnType<typeof classifyEveClipboard>['kind']
): boolean {
  return source === 'auto' && route === 'local' && detectedKind === 'unknown'
}

export interface DeferredLocalNavigationState {
  resolvedPilots: number
  capturedNavigationSequence: number
  currentNavigationSequence: number
  capturedClipboardOperationSequence: number
  currentClipboardOperationSequence: number
  automaticClipboardEnabled: boolean
  clipboardStillCurrent: boolean
  activeWorkspace: WorkspaceId
}

/** Do not let a late single-name lookup override navigation performed while it was pending. */
export function shouldApplyDeferredLocalNavigation(
  state: DeferredLocalNavigationState
): boolean {
  const navigationStillApplicable =
    state.capturedNavigationSequence === state.currentNavigationSequence ||
    state.activeWorkspace === 'intel'
  return state.resolvedPilots > 0 &&
    navigationStillApplicable &&
    state.capturedClipboardOperationSequence === state.currentClipboardOperationSequence &&
    state.automaticClipboardEnabled &&
    state.clipboardStillCurrent &&
    shouldProcessAutomaticClipboard(state.activeWorkspace)
}

/** Route every supported copy, including one syntactically valid pilot name. */
export function routeEveClipboard(rawText: string): EveClipboardRoute {
  const detection = classifyEveClipboard(rawText)
  if (detection.kind !== 'unknown') return detection.kind
  const local = parseLocalRoster(rawText)
  return local.names.length > 0 && local.rejected === 0 ? 'local' : 'unknown'
}
