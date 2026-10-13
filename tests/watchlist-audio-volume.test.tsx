import { describe, expect, it } from 'vitest'
import { normalizeAlertVolume } from '../src/renderer/src/watchlist-audio'

describe('watchlist alert volume', () => {
  it('normalizes percentages and clamps unsafe values', () => {
    expect(normalizeAlertVolume(0)).toBe(0)
    expect(normalizeAlertVolume(35)).toBe(.35)
    expect(normalizeAlertVolume(100)).toBe(1)
    expect(normalizeAlertVolume(-50)).toBe(0)
    expect(normalizeAlertVolume(250)).toBe(1)
    expect(normalizeAlertVolume(Number.NaN)).toBe(1)
  })
})
