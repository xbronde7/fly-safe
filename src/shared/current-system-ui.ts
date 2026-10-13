import type { CurrentSystemSnapshot } from './types'

export const CURRENT_SYSTEM_POLL_INTERVAL_MS = 20_000
export const PILOT_CONTEXT_POLL_INTERVAL_MS = 60_000

export const ESI_RATE_LIMIT_MESSAGE =
  'ESI temporarily rate-limited requests. Refresh will retry automatically.'

const ESI_RATE_LIMIT_PATTERN = /\b429\b|rate[\s-]*limit|too many requests|огранич\S*\s+частот|лимит\S*\s+запрос/i

export function isEsiRateLimitMessage(message: string): boolean {
  return ESI_RATE_LIMIT_PATTERN.test(message)
}

/** Keeps implementation details and raw ESI response bodies out of the renderer. */
export function sanitizeEsiMessage(message: string): string {
  return isEsiRateLimitMessage(message) ? ESI_RATE_LIMIT_MESSAGE : message
}

export interface ReconciledCurrentSystemSnapshot {
  snapshot: CurrentSystemSnapshot
  retainedPrevious: boolean
}

/**
 * A rate-limited endpoint can make CurrentSystemService return a valid but
 * incomplete snapshot. Keep the last coherent view until ESI recovers.
 */
export function reconcileCurrentSystemSnapshot(
  previous: CurrentSystemSnapshot | null,
  incoming: CurrentSystemSnapshot
): ReconciledCurrentSystemSnapshot {
  const rateLimited = incoming.warnings.some(isEsiRateLimitMessage)
  const warnings = unique(incoming.warnings.map(sanitizeEsiMessage))
  const sanitizedIncoming: CurrentSystemSnapshot = {
    ...incoming,
    account: {
      ...incoming.account,
      error: incoming.account.error === null
        ? null
        : sanitizeEsiMessage(incoming.account.error)
    },
    warnings
  }

  const sameCharacter = previous?.account.characterId !== null &&
    previous?.account.characterId === incoming.account.characterId
  const degraded = incoming.online === null ||
    incoming.location === null ||
    incoming.ownShip === null ||
    incoming.intel === null

  if (
    previous &&
    previous.online === true &&
    previous.location !== null &&
    previous.intel !== null &&
    incoming.account.connected &&
    incoming.online !== false &&
    sameCharacter &&
    rateLimited &&
    degraded
  ) {
    return {
      snapshot: {
        ...previous,
        account: sanitizedIncoming.account,
        warnings
      },
      retainedPrevious: true
    }
  }

  return { snapshot: sanitizedIncoming, retainedPrevious: false }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

export interface PollingClock<TimerHandle> {
  setTimeout(callback: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export interface PollingVisibility {
  isVisible(): boolean
  subscribe(listener: () => void): () => void
}

export interface CurrentSystemPollingOptions<TimerHandle> {
  poll(): Promise<void>
  onError?(error: unknown): void
  clock: PollingClock<TimerHandle>
  visibility: PollingVisibility
  intervalMs?: number
  pollImmediately?: boolean
}

/**
 * Runs at most one automatic cycle at a time and schedules the next cycle
 * only after the current one settles. Hidden windows do not consume ESI calls.
 */
export function startCurrentSystemPolling<TimerHandle>({
  poll,
  onError,
  clock,
  visibility,
  intervalMs = CURRENT_SYSTEM_POLL_INTERVAL_MS,
  pollImmediately = true
}: CurrentSystemPollingOptions<TimerHandle>): () => void {
  let stopped = false
  let inFlight = false
  let timer: TimerHandle | null = null

  const clearScheduled = (): void => {
    if (timer === null) return
    clock.clearTimeout(timer)
    timer = null
  }

  const schedule = (): void => {
    clearScheduled()
    if (stopped || !visibility.isVisible()) return
    timer = clock.setTimeout(() => {
      timer = null
      void run()
    }, intervalMs)
  }

  const run = async (): Promise<void> => {
    if (stopped || inFlight || !visibility.isVisible()) return
    inFlight = true
    try {
      await poll()
    } catch (error) {
      onError?.(error)
    } finally {
      inFlight = false
      if (!stopped && visibility.isVisible()) schedule()
    }
  }

  const unsubscribe = visibility.subscribe(() => {
    if (stopped) return
    if (!visibility.isVisible()) {
      clearScheduled()
      return
    }
    if (!inFlight) {
      clearScheduled()
      void run()
    }
  })

  if (visibility.isVisible()) {
    if (pollImmediately) void run()
    else schedule()
  }

  return () => {
    stopped = true
    clearScheduled()
    unsubscribe()
  }
}
