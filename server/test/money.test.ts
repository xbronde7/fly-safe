import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatIsk, moneyFromStorage, moneyToStorage, parseIsk } from '../src/money.js'

describe('fixed-point ISK', () => {
  it('round-trips values larger than Number.MAX_SAFE_INTEGER', () => {
    const value = parseIsk('90071992547409930.47')
    assert.equal(value, 9_007_199_254_740_993_047n)
    assert.equal(formatIsk(value), '90071992547409930.47')
    assert.equal(moneyFromStorage(moneyToStorage(value)), value)
  })

  it('rejects fractional precision loss', () => {
    assert.throws(() => parseIsk('1.001'), /two decimal places/u)
    assert.equal(formatIsk(parseIsk('-0.01')), '-0.01')
  })
})
