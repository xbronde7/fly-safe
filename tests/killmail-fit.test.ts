import { describe, expect, it } from 'vitest'
import {
  collectKillmailTypeIds,
  parseVictimFit,
  sectionForFlag,
} from '../src/shared/killmail-fit'

describe('sectionForFlag', () => {
  it.each([
    [11, 'low'],
    [18, 'low'],
    [19, 'medium'],
    [26, 'medium'],
    [27, 'high'],
    [34, 'high'],
    [92, 'rig'],
    [99, 'rig'],
    [125, 'subsystem'],
    [132, 'subsystem'],
    [87, 'drone'],
    [158, 'fighter'],
    [159, 'fighter'],
    [5, 'cargo'],
    [35, 'other'],
    [Number.NaN, 'other'],
  ] as const)('maps flag %s to %s', (flag, expected) => {
    expect(sectionForFlag(flag)).toBe(expected)
  })
})

describe('parseVictimFit', () => {
  it('parses all fit sections, resolves names and aggregates duplicate type/section rows', () => {
    const raw = {
      victim: {
        ship_type_id: 11_995,
        items: [
          { item_type_id: 1, flag: 27, quantity_destroyed: 1 },
          { item_type_id: 1, flag: 27, quantity_dropped: 2 },
          { item_type_id: 1, flag: 19, quantity_destroyed: 3 },
          { item_type_id: 2, flag: 11, quantity_dropped: 1 },
          { item_type_id: 3, flag: 92, quantity_destroyed: 1 },
          { item_type_id: 4, flag: 125, quantity_destroyed: 1 },
          { item_type_id: 5, flag: 87, quantity_destroyed: 5, quantity_dropped: 2 },
          { item_type_id: 6, flag: 158, quantity_destroyed: 3 },
          { item_type_id: 7, flag: 5, quantity_dropped: 400 },
          { item_type_id: 8, flag: 88, quantity_destroyed: 1 },
        ],
      },
    }
    const names = new Map([
      [11_995, 'Scimitar'],
      [1, 'Module One'],
      [7, 'Cargo Stack'],
    ])

    const fit = parseVictimFit(raw, names)

    expect(fit).not.toBeNull()
    expect(fit?.shipTypeId).toBe(11_995)
    expect(fit?.shipName).toBe('Scimitar')
    expect(fit?.sections.high).toEqual([
      {
        typeId: 1,
        name: 'Module One',
        quantityDestroyed: 1,
        quantityDropped: 2,
        section: 'high',
      },
    ])
    expect(fit?.sections.medium[0]).toMatchObject({ typeId: 1, quantityDestroyed: 3 })
    expect(fit?.sections.low[0]).toMatchObject({ typeId: 2, quantityDropped: 1 })
    expect(fit?.sections.rig[0]).toMatchObject({ typeId: 3 })
    expect(fit?.sections.subsystem[0]).toMatchObject({ typeId: 4 })
    expect(fit?.sections.drone[0]).toMatchObject({ typeId: 5, quantityDestroyed: 5 })
    expect(fit?.sections.fighter[0]).toMatchObject({ typeId: 6 })
    expect(fit?.sections.cargo[0]).toMatchObject({ typeId: 7, name: 'Cargo Stack' })
    expect(fit?.sections.other[0]).toMatchObject({ typeId: 8 })
    expect(fit?.totalDestroyed).toBe(15)
    expect(fit?.totalDropped).toBe(405)
  })

  it('supports record names, nested container contents and string ESI values', () => {
    const raw = {
      victim: {
        ship_type_id: '42',
        items: [
          {
            item_type_id: '100',
            flag: '5',
            quantity_destroyed: '2',
            items: [{ item_type_id: '101', flag: '5', quantity_dropped: '7' }],
          },
        ],
      },
    }

    const fit = parseVictimFit(raw, { 42: 'Ship', 100: 'Container', 101: 'Ammo' })

    expect(fit?.shipName).toBe('Ship')
    expect(fit?.sections.cargo).toEqual([
      {
        typeId: 100,
        name: 'Container',
        quantityDestroyed: 2,
        quantityDropped: 0,
        section: 'cargo',
      },
      {
        typeId: 101,
        name: 'Ammo',
        quantityDestroyed: 0,
        quantityDropped: 7,
        section: 'cargo',
      },
    ])
  })

  it('returns null for malformed victim or ship and ignores malformed items safely', () => {
    expect(parseVictimFit(null)).toBeNull()
    expect(parseVictimFit({})).toBeNull()
    expect(parseVictimFit({ victim: [] })).toBeNull()
    expect(parseVictimFit({ victim: { ship_type_id: -1 } })).toBeNull()

    const cyclicItem: Record<string, unknown> = {
      item_type_id: 10,
      flag: 27,
      quantity_destroyed: 1,
    }
    cyclicItem.items = [cyclicItem]
    const fit = parseVictimFit({
      victim: {
        ship_type_id: 20,
        items: [
          cyclicItem,
          null,
          [],
          { item_type_id: 0, flag: 11, quantity_destroyed: 50 },
          { item_type_id: 11, flag: {}, quantity_destroyed: -1, quantity_dropped: Infinity },
        ],
      },
    })

    expect(fit?.sections.high).toHaveLength(1)
    expect(fit?.sections.other).toEqual([
      {
        typeId: 11,
        quantityDestroyed: 0,
        quantityDropped: 0,
        section: 'other',
      },
    ])
    expect(fit?.totalDestroyed).toBe(1)
    expect(fit?.totalDropped).toBe(0)
  })

  it('does not read inherited names from an untrusted record', () => {
    const names = Object.create({ 42: 'Inherited Ship' }) as Record<string, string>
    const fit = parseVictimFit({ victim: { ship_type_id: 42 } }, names)

    expect(fit?.shipName).toBeUndefined()
  })
})

describe('collectKillmailTypeIds', () => {
  it('returns unique ship and recursive item IDs in encounter order', () => {
    const raw = {
      victim: {
        ship_type_id: 100,
        items: [
          { item_type_id: 200, items: [{ item_type_id: 300 }] },
          { item_type_id: 200 },
          { item_type_id: -1 },
          { item_type_id: '400' },
        ],
      },
    }

    expect(collectKillmailTypeIds(raw)).toEqual([100, 200, 300, 400])
    expect(collectKillmailTypeIds({ victim: null })).toEqual([])
  })
})
