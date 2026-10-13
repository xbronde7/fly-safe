import { describe, expect, it } from 'vitest'
import {
  decideAutomaticClipboard,
  getClipboardNavigation,
  getClipboardScrollBehavior,
  getClipboardViewVisibility,
  routeEveClipboard,
  shouldApplyDeferredLocalNavigation,
  shouldDeferAutomaticLocalNavigation,
  shouldProcessAutomaticClipboard
} from '../src/shared/clipboard-view'

describe('clipboard result presentation', () => {
  it('shows only the currently recognized clipboard mode', () => {
    expect(getClipboardViewVisibility('local', true, false)).toEqual({
      showLocalResult: true,
      showTacticalResult: false,
      showEmptyState: false
    })
    expect(getClipboardViewVisibility('dscan', true, false)).toEqual({
      showLocalResult: false,
      showTacticalResult: true,
      showEmptyState: false
    })
    expect(getClipboardViewVisibility('probe', true, false)).toEqual({
      showLocalResult: false,
      showTacticalResult: true,
      showEmptyState: false
    })
  })

  it('shows the starter state only before a clipboard mode is active', () => {
    expect(getClipboardViewVisibility(null, false, false).showEmptyState).toBe(true)
    expect(getClipboardViewVisibility(null, false, true).showEmptyState).toBe(false)
    expect(getClipboardViewVisibility('local', false, false).showEmptyState).toBe(false)
  })

  it('turns off smooth scrolling for reduced motion', () => {
    expect(getClipboardScrollBehavior(false)).toBe('smooth')
    expect(getClipboardScrollBehavior(true)).toBe('auto')
  })

  it('routes one copied pilot directly to Local analysis', () => {
    expect(routeEveClipboard('Lio Yuh')).toBe('local')
    expect(routeEveClipboard('17715\tCustom Gila\t12 km')).toBe('dscan')
    expect(routeEveClipboard('ABC-123\tCosmic Signature\tWormhole\tUnstable\t100%\t2 AU'))
      .toBe('probe')
  })

  it('opens every recognized EVE copy at the Intel result and ignores unknown text', () => {
    for (const route of ['local', 'dscan', 'probe'] as const) {
      expect(getClipboardNavigation(route)).toEqual({
        workspace: 'intel',
        scrollTarget: 'result'
      })
    }
    expect(getClipboardNavigation('unknown')).toBeNull()
  })

  it('reserves automatic clipboard handling outside Market and Route', () => {
    expect(shouldProcessAutomaticClipboard('market')).toBe(false)
    expect(shouldProcessAutomaticClipboard('route')).toBe(false)
    expect(shouldProcessAutomaticClipboard('intel')).toBe(true)
    expect(shouldProcessAutomaticClipboard('settings')).toBe(true)
    expect(shouldProcessAutomaticClipboard('pilot')).toBe(true)
  })

  it('absorbs Market and Route clipboard text so it cannot trigger after leaving', () => {
    const market = decideAutomaticClipboard('  Tritanium  ', '', 'market')
    expect(market).toEqual({
      normalizedText: 'Tritanium',
      route: 'local',
      changed: true,
      shouldProcess: false
    })
    expect(decideAutomaticClipboard('Tritanium', market.normalizedText, 'settings')).toEqual({
      normalizedText: 'Tritanium',
      route: 'unknown',
      changed: false,
      shouldProcess: false
    })
    expect(decideAutomaticClipboard('Jita', market.normalizedText, 'route')).toEqual({
      normalizedText: 'Jita',
      route: 'local',
      changed: true,
      shouldProcess: false
    })
    expect(decideAutomaticClipboard('Pilot Name', 'Jita', 'settings')).toEqual({
      normalizedText: 'Pilot Name',
      route: 'local',
      changed: true,
      shouldProcess: true
    })
    expect(decideAutomaticClipboard('17715\tCustom Gila\t12 km', 'Jita', 'route'))
      .toMatchObject({ route: 'dscan', changed: true, shouldProcess: true })
    expect(decideAutomaticClipboard('ordinary text!', 'Jita', 'settings'))
      .toMatchObject({ route: 'unknown', changed: true, shouldProcess: false })
  })

  it('waits for ESI before auto-opening a single plausible pilot name', () => {
    expect(shouldDeferAutomaticLocalNavigation('auto', 'local', 'unknown')).toBe(true)
    expect(shouldDeferAutomaticLocalNavigation('auto', 'local', 'local')).toBe(false)
    expect(shouldDeferAutomaticLocalNavigation('manual', 'local', 'unknown')).toBe(false)
    expect(shouldDeferAutomaticLocalNavigation('auto', 'dscan', 'dscan')).toBe(false)
  })

  it('does not apply a late single-name redirect after the user navigates elsewhere', () => {
    const unchanged = {
      resolvedPilots: 1,
      capturedNavigationSequence: 4,
      currentNavigationSequence: 4,
      capturedClipboardOperationSequence: 8,
      currentClipboardOperationSequence: 8,
      automaticClipboardEnabled: true,
      clipboardStillCurrent: true,
      activeWorkspace: 'settings' as const
    }

    expect(shouldApplyDeferredLocalNavigation(unchanged)).toBe(true)
    expect(shouldApplyDeferredLocalNavigation({
      ...unchanged,
      currentNavigationSequence: 5
    })).toBe(false)
    expect(shouldApplyDeferredLocalNavigation({
      ...unchanged,
      currentNavigationSequence: 5,
      activeWorkspace: 'intel'
    })).toBe(true)
    expect(shouldApplyDeferredLocalNavigation({
      ...unchanged,
      currentClipboardOperationSequence: 9
    })).toBe(false)
    expect(shouldApplyDeferredLocalNavigation({
      ...unchanged,
      automaticClipboardEnabled: false
    })).toBe(false)
    expect(shouldApplyDeferredLocalNavigation({
      ...unchanged,
      clipboardStillCurrent: false
    })).toBe(false)
    expect(shouldApplyDeferredLocalNavigation({
      ...unchanged,
      activeWorkspace: 'market'
    })).toBe(false)
    expect(shouldApplyDeferredLocalNavigation({
      ...unchanged,
      activeWorkspace: 'route'
    })).toBe(false)
    expect(shouldApplyDeferredLocalNavigation({
      ...unchanged,
      resolvedPilots: 0
    })).toBe(false)
  })
})
