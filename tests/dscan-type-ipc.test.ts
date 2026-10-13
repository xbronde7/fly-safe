import { describe, expect, it } from 'vitest'
import {
  parseDscanTypeNameRequest,
  toPublicDscanTypeNames
} from '../src/main/dscan-type-ipc'

describe('parseDscanTypeNameRequest', () => {
  it('accepts a bounded list of unique positive safe integer IDs', () => {
    expect(parseDscanTypeNameRequest({ typeIds: [17_715, 11_987] })).toEqual({
      typeIds: [17_715, 11_987]
    })
  })

  it.each([
    null,
    [],
    {},
    { typeIds: [17_715], extra: true },
    { typeIds: [] },
    { typeIds: Array.from({ length: 1_001 }, (_, index) => index + 1) },
    { typeIds: [17_715, 17_715] },
    { typeIds: [0] },
    { typeIds: [-1] },
    { typeIds: [1.5] },
    { typeIds: [Number.MAX_SAFE_INTEGER + 1] },
    { typeIds: ['17715'] }
  ])('rejects invalid renderer input %#', (input) => {
    expect(() => parseDscanTypeNameRequest(input)).toThrow()
  })

  it('rejects sparse type ID arrays', () => {
    const typeIds = new Array<number>(2)
    typeIds[0] = 17_715
    expect(() => parseDscanTypeNameRequest({ typeIds })).toThrow('empty entries')
  })
})

describe('toPublicDscanTypeNames', () => {
  it('returns requested inventory type names in request order and strips ESI metadata', () => {
    const response = toPublicDscanTypeNames(
      { typeIds: [17_715, 11_987, 99_999] },
      [
        { id: 11_987, name: 'Guardian', category: 'inventory_type' },
        { id: 17_715, name: ' Gila ', category: 'inventory_type' },
        { id: 99_999, name: 'Not a hull', category: 'character' },
        { id: 123_456, name: 'Unrequested', category: 'inventory_type' }
      ]
    )

    expect(response).toEqual([
      { typeId: 17_715, name: 'Gila' },
      { typeId: 11_987, name: 'Guardian' }
    ])
    expect(JSON.stringify(response)).not.toContain('category')
    expect(JSON.stringify(response)).not.toContain('cached')
    expect(JSON.stringify(response)).not.toContain('Unrequested')
  })
})
