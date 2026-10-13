import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, win32 } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const DEVICE_NAMESPACE = 'eve-local-intel/license-device/v1:'
const FALLBACK_SECRET_BYTES = 32

export interface LicenseDeviceOptions {
  fallbackSecretPath: string
  platform?: NodeJS.Platform
  readPlatformUuid?: () => Promise<string>
  readWindowsMachineGuid?: () => Promise<string>
}

export async function resolveLicenseDeviceCode(
  options: LicenseDeviceOptions
): Promise<string> {
  const platform = options.platform ?? process.platform
  const readPlatformUuid = options.readPlatformUuid ?? readMacPlatformUuid
  const readMachineGuid = options.readWindowsMachineGuid ?? readWindowsMachineGuid

  if (platform === 'darwin') {
    try {
      const platformUuid = normalizePlatformUuid(await readPlatformUuid())
      if (platformUuid !== null) return deriveLicenseDeviceCode(`mac:${platformUuid}`)
    } catch {
      // A stable per-install secret keeps activation available when ioreg is unavailable.
    }
  }

  if (platform === 'win32') {
    try {
      const machineGuid = normalizeWindowsMachineGuid(await readMachineGuid())
      if (machineGuid !== null) {
        return deriveLicenseDeviceCode(`windows:${machineGuid}`)
      }
    } catch {
      // A stable per-install secret keeps activation available when the registry is unavailable.
    }
  }

  const fallbackSecret = await loadOrCreateFallbackSecret(options.fallbackSecretPath)
  return deriveLicenseDeviceCode(`install:${fallbackSecret}`)
}

export function deriveLicenseDeviceCode(source: string): string {
  const digest = createHash('sha256').update(DEVICE_NAMESPACE).update(source).digest()
  const encoded = encodeBase32(digest).slice(0, 20)
  return `ELI-${encoded.match(/.{1,4}/g)?.join('-') ?? encoded}`
}

export function parseMacPlatformUuid(output: string): string {
  const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
  const normalized = normalizePlatformUuid(match?.[1] ?? '')
  if (normalized === null) throw new Error('IOPlatformUUID недоступен')
  return normalized
}

export function parseWindowsMachineGuid(output: string): string {
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*MachineGuid\s+REG_SZ\s+(.+?)\s*$/iu)
    if (match === null) continue

    const normalized = normalizeWindowsMachineGuid(match[1])
    if (normalized !== null) return normalized
  }

  throw new Error('MachineGuid недоступен')
}

async function readMacPlatformUuid(): Promise<string> {
  const { stdout } = await execFile(
    '/usr/sbin/ioreg',
    ['-rd1', '-c', 'IOPlatformExpertDevice'],
    { encoding: 'utf8', timeout: 5_000, maxBuffer: 512_000 }
  )
  return parseMacPlatformUuid(stdout)
}

async function readWindowsMachineGuid(): Promise<string> {
  const windowsDirectory = resolveWindowsDirectory()
  const regExecutable = win32.join(windowsDirectory, 'System32', 'reg.exe')
  const { stdout } = await execFile(
    regExecutable,
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
    {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 512_000,
      windowsHide: true
    }
  )
  return parseWindowsMachineGuid(stdout)
}

function normalizePlatformUuid(value: string): string | null {
  const normalized = value.trim().toUpperCase()
  return /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(normalized)
    ? normalized
    : null
}

function normalizeWindowsMachineGuid(value: string): string | null {
  const trimmed = value.trim()
  const withoutBraces = trimmed.startsWith('{') && trimmed.endsWith('}')
    ? trimmed.slice(1, -1)
    : trimmed
  const normalized = withoutBraces.toUpperCase()

  return /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(normalized)
    ? normalized
    : null
}

function resolveWindowsDirectory(): string {
  for (const candidate of [process.env.SystemRoot, process.env.WINDIR]) {
    const normalized = candidate?.trim()
    if (normalized && win32.isAbsolute(normalized) && !normalized.includes('\0')) {
      return normalized
    }
  }

  return 'C:\\Windows'
}

async function loadOrCreateFallbackSecret(path: string): Promise<string> {
  try {
    const stored = (await readFile(path, 'utf8')).trim()
    if (/^[A-Za-z0-9_-]{32,128}$/.test(stored)) return stored
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }

  const generated = randomBytes(FALLBACK_SECRET_BYTES).toString('base64url')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })

  try {
    await writeFile(path, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return generated
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    const stored = (await readFile(path, 'utf8')).trim()
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(stored)) {
      throw new Error('Локальный идентификатор лицензии повреждён')
    }
    return stored
  }
}

function encodeBase32(value: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let accumulator = 0
  let bitCount = 0
  let output = ''

  for (const byte of value) {
    accumulator = (accumulator << 8) | byte
    bitCount += 8
    while (bitCount >= 5) {
      bitCount -= 5
      output += alphabet[(accumulator >>> bitCount) & 31]
      accumulator &= (1 << bitCount) - 1
    }
  }

  if (bitCount > 0) output += alphabet[(accumulator << (5 - bitCount)) & 31]
  return output
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
