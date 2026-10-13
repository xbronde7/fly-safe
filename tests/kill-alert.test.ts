import { describe, expect, it } from 'vitest'
import {
  KILL_ALERT_POLL_DELAY,
  normalizeKillAlertPollDelay
} from '../src/shared/kill-alert'

describe('kill alert renderer polling delay', () => {
  it('preserves a one-hour Retry-After instead of collapsing it to one minute', () => {
    expect(normalizeKillAlertPollDelay(60 * 60_000)).toBe(60 * 60_000)
  })

  it('bounds invalid, too-fast and excessive values', () => {
    expect(normalizeKillAlertPollDelay(Number.NaN)).toBe(KILL_ALERT_POLL_DELAY.fallbackMs)
    expect(normalizeKillAlertPollDelay(100)).toBe(KILL_ALERT_POLL_DELAY.minimumMs)
    expect(normalizeKillAlertPollDelay(24 * 60 * 60_000)).toBe(KILL_ALERT_POLL_DELAY.maximumMs)
  })
})
