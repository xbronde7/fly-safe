import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DoctrineTemplateStore } from '../src/main/doctrine-store'
import {
  matchDscanDoctrine,
  validateDoctrineTemplateInput
} from '../src/shared/doctrine-matcher'

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('D-scan doctrine matcher', () => {
  it('reports missing/excess role and hull counts with observed-hull evidence', () => {
    const template = validateDoctrineTemplateInput({
      name: 'Small armor fleet',
      roles: [
        { role: 'logistics', minimum: 2, target: 2, maximum: 3 },
        { role: 'tackle', minimum: 1, target: 1, maximum: 1 }
      ],
      hulls: [{ typeName: 'Guardian', minimum: 2, target: 2, maximum: 2 }]
    }, {
      id: 'armor-small',
      now: '2026-08-25T10:00:00Z'
    })
    const result = matchDscanDoctrine([
      { type: 'Guardian' },
      { type: 'Sabre' },
      { type: 'Sabre' },
      { type: 'Drake' }
    ], template)

    expect(result).toMatchObject({
      templateId: 'armor-small',
      observedTotal: 4,
      unclassifiedCount: 1,
      status: 'partial'
    })
    expect(result.roleComparisons).toEqual([
      expect.objectContaining({
        role: 'logistics',
        actual: 1,
        deltaToTarget: -1,
        status: 'missing',
        observedHulls: [{ typeName: 'Guardian', count: 1 }]
      }),
      expect.objectContaining({
        role: 'tackle',
        actual: 2,
        deltaToTarget: 1,
        status: 'excess',
        observedHulls: [{ typeName: 'Sabre', count: 2 }]
      })
    ])
    expect(result.hullComparisons[0]).toMatchObject({
      typeName: 'Guardian',
      actual: 1,
      status: 'missing'
    })
    expect(result.explanations).toEqual(expect.arrayContaining([
      expect.stringContaining('Guardian ×1'),
      expect.stringContaining('excess')
    ]))
  })

  it('returns a full match for normalized exact hull names and role counts', () => {
    const template = validateDoctrineTemplateInput({
      name: 'Scout wing',
      roles: [{ role: 'tackle', target: 1 }],
      hulls: [{ typeName: ' Sabre ', target: 1 }]
    }, { id: 'scout', now: '2026-08-25T10:00:00Z' })
    expect(matchDscanDoctrine([{ type: 'sABRE' }], template)).toMatchObject({
      score: 100,
      status: 'match',
      roleComparisons: [{ status: 'matched', actual: 1 }],
      hullComparisons: [{ status: 'matched', actual: 1, normalizedTypeName: 'sabre' }]
    })
  })

  it('rejects duplicate requirements, unknown fields, and impossible ranges', () => {
    const defaults = { id: 'bad', now: '2026-08-25T10:00:00Z' }
    expect(() => validateDoctrineTemplateInput({
      name: 'No rules',
      roles: [],
      hulls: []
    }, defaults)).toThrow('at least one')
    expect(() => validateDoctrineTemplateInput({
      name: 'Duplicate',
      roles: [{ role: 'tackle', target: 1 }, { role: 'tackle', target: 2 }]
    }, defaults)).toThrow('Duplicate doctrine role')
    expect(() => validateDoctrineTemplateInput({
      name: 'Impossible',
      hulls: [{ typeName: 'Sabre', minimum: 2, target: 1 }]
    }, defaults)).toThrow('Minimum exceeds target')
    expect(() => validateDoctrineTemplateInput({
      name: 'Secret',
      roles: [{ role: 'tackle', target: 1 }],
      accessToken: 'must-not-be-stored'
    }, defaults)).toThrow('Unknown doctrine field')
  })
})

describe('DoctrineTemplateStore', () => {
  it('persists ordered templates and preserves creation time on replacement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fly-safe-doctrines-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'doctrines.sqlite')
    let now = Date.parse('2026-08-25T10:00:00Z')
    const first = new DoctrineTemplateStore(databasePath, () => now)
    const saved = first.save({
      id: 'armor',
      name: 'Armor fleet',
      description: 'Initial',
      roles: [{ role: 'logistics', minimum: 2, target: 3, maximum: 4 }],
      hulls: [{ typeName: 'Guardian', target: 3 }]
    })
    now += 60_000
    const updated = first.save({
      id: 'armor',
      name: 'Armor fleet v2',
      roles: [{ role: 'logistics', target: 4 }]
    })
    expect(updated).toMatchObject({
      id: 'armor',
      name: 'Armor fleet v2',
      createdAt: saved.createdAt,
      updatedAt: '2026-08-25T10:01:00.000Z',
      hulls: []
    })
    first.close()

    const reopened = new DoctrineTemplateStore(databasePath, () => now)
    expect(reopened.list()).toEqual([updated])
    expect(reopened.delete('armor')).toBe(true)
    expect(reopened.delete('armor')).toBe(false)
    reopened.close()
    expect(() => reopened.list()).toThrow('already closed')
  })
})
