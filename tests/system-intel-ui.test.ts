import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CurrentSystemSnapshot, SystemIntel } from '../src/shared/types'
import {
  CURRENT_SYSTEM_POLL_INTERVAL_MS,
  ESI_RATE_LIMIT_MESSAGE,
  PILOT_CONTEXT_POLL_INTERVAL_MS,
  reconcileCurrentSystemSnapshot,
  sanitizeEsiMessage,
  startCurrentSystemPolling,
  type PollingVisibility
} from '../src/shared/current-system-ui'

const CHARACTER_ID = 90_000_001
const SYSTEM_ID = 31_000_001

function snapshot(
  overrides: Partial<CurrentSystemSnapshot> = {}
): CurrentSystemSnapshot {
  return {
    account: {
      configured: true,
      connected: true,
      clientId: 'client-id',
      callbackUri: 'http://localhost:53173/callback',
      characterId: CHARACTER_ID,
      characterName: 'Pilot',
      scopes: [],
      error: null
    },
    online: true,
    location: { solarSystemId: SYSTEM_ID },
    ownShip: {
      typeId: 11_978,
      typeName: 'Astero',
      customName: 'Scout'
    },
    intel: {
      system: { id: SYSTEM_ID, name: 'J000001' }
    } as SystemIntel,
    fetchedAt: '2026-08-21T16:00:00.000Z',
    warnings: [],
    ...overrides
  }
}

function visibilityHarness(initiallyVisible = true): {
  visibility: PollingVisibility
  setVisible(value: boolean): void
} {
  let visible = initiallyVisible
  let listener: (() => void) | null = null
  return {
    visibility: {
      isVisible: () => visible,
      subscribe: (nextListener) => {
        listener = nextListener
        return () => {
          if (listener === nextListener) listener = null
        }
      }
    },
    setVisible: (value) => {
      visible = value
      listener?.()
    }
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('current-system UI state', () => {
  it('uses a 20-second automatic polling interval', () => {
    expect(CURRENT_SYSTEM_POLL_INTERVAL_MS).toBe(20_000)
  })

  it('polls contacts and fleet less often than the current position', () => {
    expect(PILOT_CONTEXT_POLL_INTERVAL_MS).toBe(60_000)
    expect(PILOT_CONTEXT_POLL_INTERVAL_MS).toBeGreaterThan(CURRENT_SYSTEM_POLL_INTERVAL_MS)
  })

  it('hides raw ESI 429 response bodies behind a stable Russian message', () => {
    const rendered = sanitizeEsiMessage(
      'ESI 429: {"error":"Rate limit exceeded","retry_after":71}'
    )

    expect(rendered).toBe(ESI_RATE_LIMIT_MESSAGE)
    expect(rendered).not.toContain('429')
    expect(rendered).not.toContain('Rate limit exceeded')
    expect(sanitizeEsiMessage('ESI character-location request paused by rate limit'))
      .toBe(ESI_RATE_LIMIT_MESSAGE)
  })

  it('keeps the last coherent snapshot when a rate-limited refresh is incomplete', () => {
    const previous = snapshot()
    const incoming = snapshot({
      online: null,
      location: null,
      ownShip: null,
      intel: null,
      fetchedAt: '2026-08-21T16:00:20.000Z',
      warnings: [
        'ESI: статус пилота недоступен (ESI 429: {"error":"Rate limit exceeded"})'
      ]
    })

    const result = reconcileCurrentSystemSnapshot(previous, incoming)

    expect(result.retainedPrevious).toBe(true)
    expect(result.snapshot.online).toBe(true)
    expect(result.snapshot.location).toEqual(previous.location)
    expect(result.snapshot.ownShip).toEqual(previous.ownShip)
    expect(result.snapshot.intel).toBe(previous.intel)
    expect(result.snapshot.fetchedAt).toBe(previous.fetchedAt)
    expect(result.snapshot.warnings).toEqual([ESI_RATE_LIMIT_MESSAGE])
  })

  it('replaces stale data when ESI explicitly reports the pilot offline', () => {
    const incoming = snapshot({
      online: false,
      location: null,
      ownShip: null,
      intel: null,
      warnings: ['ESI character-location request paused by rate limit']
    })

    const result = reconcileCurrentSystemSnapshot(snapshot(), incoming)

    expect(result.retainedPrevious).toBe(false)
    expect(result.snapshot.online).toBe(false)
    expect(result.snapshot.intel).toBeNull()
  })

  it('replaces the previous snapshot after a complete successful refresh', () => {
    const incoming = snapshot({
      location: { solarSystemId: SYSTEM_ID + 1 },
      intel: {
        system: { id: SYSTEM_ID + 1, name: 'J000002' }
      } as SystemIntel,
      fetchedAt: '2026-08-21T16:00:20.000Z'
    })

    const result = reconcileCurrentSystemSnapshot(snapshot(), incoming)

    expect(result.retainedPrevious).toBe(false)
    expect(result.snapshot).toEqual(incoming)
  })
})

describe('current-system polling', () => {
  const clock = {
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle)
  }

  it('can schedule the first automatic cycle after the full interval', async () => {
    vi.useFakeTimers()
    const harness = visibilityHarness()
    const poll = vi.fn(async () => undefined)
    const stop = startCurrentSystemPolling({
      poll,
      clock,
      visibility: harness.visibility,
      pollImmediately: false
    })

    await vi.advanceTimersByTimeAsync(CURRENT_SYSTEM_POLL_INTERVAL_MS - 1)
    expect(poll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(1)
    stop()
  })

  it('waits for one cycle to settle before scheduling the next one', async () => {
    vi.useFakeTimers()
    const harness = visibilityHarness()
    let finish!: () => void
    const poll = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const stop = startCurrentSystemPolling({ poll, clock, visibility: harness.visibility })

    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(poll).toHaveBeenCalledTimes(1)

    finish()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(CURRENT_SYSTEM_POLL_INTERVAL_MS - 1)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(2)
    stop()
  })

  it('pauses while hidden and runs exactly one immediate cycle when visible again', async () => {
    vi.useFakeTimers()
    const harness = visibilityHarness()
    const poll = vi.fn(async () => undefined)
    const stop = startCurrentSystemPolling({ poll, clock, visibility: harness.visibility })
    await flushPromises()

    expect(poll).toHaveBeenCalledTimes(1)
    harness.setVisible(false)
    await vi.advanceTimersByTimeAsync(3 * CURRENT_SYSTEM_POLL_INTERVAL_MS)
    expect(poll).toHaveBeenCalledTimes(1)

    harness.setVisible(true)
    expect(poll).toHaveBeenCalledTimes(2)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(CURRENT_SYSTEM_POLL_INTERVAL_MS - 1)
    expect(poll).toHaveBeenCalledTimes(2)
    stop()
  })

  it('does not duplicate a cycle when visibility changes during an in-flight poll', async () => {
    vi.useFakeTimers()
    const harness = visibilityHarness()
    let finish!: () => void
    const poll = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const stop = startCurrentSystemPolling({ poll, clock, visibility: harness.visibility })

    harness.setVisible(false)
    harness.setVisible(true)
    expect(poll).toHaveBeenCalledTimes(1)

    finish()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(CURRENT_SYSTEM_POLL_INTERVAL_MS)
    expect(poll).toHaveBeenCalledTimes(2)
    stop()
  })

  it('does not reschedule after cleanup, even when an in-flight poll finishes late', async () => {
    vi.useFakeTimers()
    const harness = visibilityHarness()
    let finish!: () => void
    const poll = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const stop = startCurrentSystemPolling({ poll, clock, visibility: harness.visibility })

    stop()
    finish()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3 * CURRENT_SYSTEM_POLL_INTERVAL_MS)

    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected cycle and continues polling without an unhandled rejection', async () => {
    vi.useFakeTimers()
    const harness = visibilityHarness()
    const failure = new Error('temporary failure')
    const poll = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined)
    const onError = vi.fn()
    const stop = startCurrentSystemPolling({
      poll,
      onError,
      clock,
      visibility: harness.visibility
    })
    await flushPromises()

    expect(onError).toHaveBeenCalledWith(failure)
    await vi.advanceTimersByTimeAsync(CURRENT_SYSTEM_POLL_INTERVAL_MS)
    expect(poll).toHaveBeenCalledTimes(2)
    stop()
  })
})
