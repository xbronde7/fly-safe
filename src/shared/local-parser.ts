import type { LocalPreview } from './types'

const MIN_CHARACTER_NAME_LENGTH = 3
const MAX_CHARACTER_NAME_LENGTH = 37

// EVE character names are deliberately validated conservatively here. Keeping
// this ASCII-only also prevents UI labels or pasted prose from looking like a
// roster entry.
const EVE_CHARACTER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 .'-]*[A-Za-z0-9])?$/

function normalizeClipboardLine(line: string): string {
  return line
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .trim()
    .replace(/[\t\v\f ]+/g, ' ')
}

/**
 * Lightweight validation for character names copied from EVE's Local roster.
 *
 * It intentionally does not try to decide whether a syntactically valid name
 * exists; ESI is the authority for that during name resolution.
 */
export function isValidEveCharacterName(name: string): boolean {
  if (name.length < MIN_CHARACTER_NAME_LENGTH || name.length > MAX_CHARACTER_NAME_LENGTH) {
    return false
  }

  if (!EVE_CHARACTER_NAME.test(name)) {
    return false
  }

  // Repeated separators are much more likely to be clipboard noise/prose than
  // a pilot. Single spaces, dots, apostrophes and hyphens remain accepted.
  return !/(?: {2}|\.{2}|-{2}|'{2})/.test(name)
}

/**
 * Parse the newline-separated text copied from EVE's Local member list.
 * Names retain first-seen spelling and order. Duplicate names are ignored
 * case-insensitively; `rejected` counts non-empty malformed lines only.
 */
export function parseLocalRoster(rawText: string): LocalPreview {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    return { names: [], rejected: 0 }
  }

  const names: string[] = []
  const seen = new Set<string>()
  let rejected = 0

  for (const rawLine of rawText.split(/\r\n?|\n/)) {
    const name = normalizeClipboardLine(rawLine)

    if (!name) {
      continue
    }

    if (!isValidEveCharacterName(name)) {
      rejected += 1
      continue
    }

    const identity = name.toLocaleLowerCase('en-US')
    if (seen.has(identity)) {
      continue
    }

    seen.add(identity)
    names.push(name)
  }

  return { names, rejected }
}

export const parseLocalClipboard = parseLocalRoster
