import { describe, expect, it } from 'vitest'
import {
  isValidEveCharacterName,
  parseLocalClipboard,
  parseLocalRoster,
} from '../src/shared/local-parser'

describe('parseLocalRoster', () => {
  it('preserves order and first spelling while removing duplicates', () => {
    const result = parseLocalRoster('Alice Example\r\nBOB-Prime\nAlice Example\nbob-prime\nCarol.3')

    expect(result).toEqual({
      names: ['Alice Example', 'BOB-Prime', 'Carol.3'],
      rejected: 0,
    })
  })

  it('normalizes harmless clipboard whitespace and ignores empty lines', () => {
    const result = parseLocalClipboard('\uFEFF  Alice\tExample  \n\n  Bob Prime\r\n')

    expect(result).toEqual({ names: ['Alice Example', 'Bob Prime'], rejected: 0 })
  })

  it('counts malformed non-empty lines but not duplicates', () => {
    const result = parseLocalRoster('Valid Pilot\nA\n_bad\nValid Pilot\nName 💥\nToo--Many')

    expect(result).toEqual({ names: ['Valid Pilot'], rejected: 4 })
  })

  it('returns an empty preview for blank clipboard text', () => {
    expect(parseLocalRoster(' \n\r\n\t')).toEqual({ names: [], rejected: 0 })
  })
})

describe('isValidEveCharacterName', () => {
  it.each(['ABC', "O'Brien", 'Pilot-01', 'Dr. Pilot', '123'])('accepts %s', (name) => {
    expect(isValidEveCharacterName(name)).toBe(true)
  })

  it.each(['ab', '-Pilot', 'Pilot-', 'Pilot__Name', 'Pilot  Name', 'Пилот'])('rejects %s', (name) => {
    expect(isValidEveCharacterName(name)).toBe(false)
  })
})
