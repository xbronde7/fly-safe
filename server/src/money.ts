const ISK_DECIMALS = 2
const ISK_SCALE = 10n ** BigInt(ISK_DECIMALS)
const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/u

/**
 * Parses an ISK decimal without passing through IEEE-754 arithmetic.
 * All persisted and API-facing monetary values use this representation.
 */
export function parseIsk(value: string): bigint {
  if (typeof value !== 'string') throw new TypeError('ISK amount must be a decimal string')
  const match = DECIMAL_PATTERN.exec(value.trim())
  if (!match) throw new RangeError('ISK amount must have at most two decimal places')

  const sign = match[1] === '-' ? -1n : 1n
  const whole = BigInt(match[2]!)
  const fraction = BigInt((match[3] ?? '').padEnd(ISK_DECIMALS, '0'))
  return sign * (whole * ISK_SCALE + fraction)
}

/** Converts a JSON/ESI numeric source into fixed-point minor units. */
export function parseIskSource(value: unknown): bigint {
  if (typeof value === 'string') return parseIsk(value)
  if (typeof value === 'number' && Number.isFinite(value)) return parseIsk(String(value))
  if (isStringifiableNumber(value)) return parseIsk(value.toString())
  throw new TypeError('ESI amount is not a finite decimal number')
}

export function formatIsk(minorUnits: bigint): string {
  const negative = minorUnits < 0n
  const absolute = negative ? -minorUnits : minorUnits
  const whole = absolute / ISK_SCALE
  const fraction = (absolute % ISK_SCALE).toString().padStart(ISK_DECIMALS, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

/** Canonical SQLite representation. Monetary columns are TEXT, never REAL. */
export function moneyToStorage(minorUnits: bigint): string {
  return minorUnits.toString(10)
}

export function moneyFromStorage(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) {
    throw new TypeError('Corrupt monetary value in storage')
  }
  return BigInt(value)
}

export function addStoredMoney(left: unknown, right: bigint): string {
  return moneyToStorage(moneyFromStorage(left) + right)
}

function isStringifiableNumber(value: unknown): value is { toString(): string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toString?: unknown }).toString === 'function'
  )
}
