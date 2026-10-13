#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify
} from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const PREFIX = 'EVEI1'
const PRODUCT = 'eve-local-intel'
const VERSION = 1
const DEVICE_NAMESPACE = 'eve-local-intel/license-device/v1:'
const AUTHORITY_DIRECTORY = process.platform === 'win32'
  ? join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'EVE Local Intel License Authority'
    )
  : join(
      homedir(),
      'Library',
      'Application Support',
      'EVE Local Intel License Authority'
    )
const DEFAULT_PRIVATE_KEY = join(AUTHORITY_DIRECTORY, 'ed25519-private.pem')
const DEFAULT_PUBLIC_KEY = join(AUTHORITY_DIRECTORY, 'ed25519-public.pem')
const DEFAULT_ISSUED_DIRECTORY = join(AUTHORITY_DIRECTORY, 'issued')

const [command = 'help', ...rawArguments] = process.argv.slice(2)
const argumentsMap = parseArguments(rawArguments)

try {
  if (command === 'init') await initializeAuthority(argumentsMap)
  else if (command === 'device-code') await printDeviceCode()
  else if (command === 'issue') await issueLicense(argumentsMap)
  else if (command === 'inspect') await inspectLicense(argumentsMap)
  else if (command === 'help' || command === '--help' || command === '-h') printHelp()
  else throw new Error(`Неизвестная команда: ${command}`)
} catch (error) {
  process.stderr.write(`Ошибка: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

async function initializeAuthority(options) {
  const privateKeyPath = absoluteOption(options, 'private-key', DEFAULT_PRIVATE_KEY)
  const publicKeyPath = absoluteOption(options, 'public-key', DEFAULT_PUBLIC_KEY)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })

  await mkdir(dirname(privateKeyPath), { recursive: true, mode: 0o700 })
  await mkdir(dirname(publicKeyPath), { recursive: true, mode: 0o700 })
  await writeFile(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    await writeFile(publicKeyPath, publicKey, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
  } catch (error) {
    await chmod(privateKeyPath, 0o600)
    throw error
  }
  await chmod(privateKeyPath, 0o600)

  process.stdout.write(`Центр лицензий создан.\nПриватный ключ: ${privateKeyPath}\nПубличный ключ: ${publicKeyPath}\n`)
  process.stdout.write('Сделайте отдельную резервную копию приватного ключа. Не отправляйте его клиентам.\n')
}

async function printDeviceCode() {
  if (process.platform === 'darwin') {
    const platformUuid = await readMacPlatformUuid()
    process.stdout.write(`${deriveDeviceCode(`mac:${platformUuid}`)}\n`)
    return
  }
  if (process.platform === 'win32') {
    const machineGuid = await readWindowsMachineGuid()
    process.stdout.write(`${deriveDeviceCode(`windows:${machineGuid}`)}\n`)
    return
  }
  throw new Error('Команда device-code поддерживает Windows и macOS')
}

async function issueLicense(options) {
  const deviceCode = normalizeDeviceCode(requiredOption(options, 'device-code'))
  const customer = requiredOption(options, 'customer').trim()
  if (customer.length < 1 || customer.length > 160 || /[\u0000-\u001f\u007f]/u.test(customer)) {
    throw new Error('Имя клиента должно содержать от 1 до 160 обычных символов')
  }

  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = parseExpiry(options, issuedAt)
  const licenseId = options.get('license-id') ?? createLicenseId()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(licenseId)) {
    throw new Error('Некорректный --license-id')
  }

  const claims = {
    v: VERSION,
    product: PRODUCT,
    licenseId,
    customer,
    deviceCode,
    issuedAt,
    expiresAt
  }
  const payloadSegment = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signingBytes = Buffer.from(`${PREFIX}.${payloadSegment}`)
  const privateKeyPath = absoluteOption(options, 'private-key', DEFAULT_PRIVATE_KEY)
  const privateKey = createPrivateKey(await readFile(privateKeyPath, 'utf8'))
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Приватный ключ не Ed25519')
  const signature = sign(null, signingBytes, privateKey)
  const token = `${PREFIX}.${payloadSegment}.${signature.toString('base64url')}`

  const outputPath = absoluteOption(
    options,
    'output',
    join(DEFAULT_ISSUED_DIRECTORY, `${licenseId}.license`)
  )
  const metadataPath = `${outputPath}.json`
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
  await writeFile(outputPath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await writeFile(metadataPath, `${JSON.stringify(claims, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })

  process.stdout.write(`Лицензия создана: ${outputPath}\n`)
  process.stdout.write(`Клиент: ${customer}\nУстройство: ${deviceCode}\n`)
  process.stdout.write(expiresAt === null
    ? 'Срок: бессрочно\n'
    : `Срок: ${new Date(expiresAt * 1000).toISOString()}\n`)
}

async function inspectLicense(options) {
  const tokenPath = resolve(requiredOption(options, 'file'))
  const token = (await readFile(tokenPath, 'utf8')).trim()
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error('Неверный формат лицензии')
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  const publicKeyPath = absoluteOption(options, 'public-key', DEFAULT_PUBLIC_KEY)
  const publicKey = createPublicKey(await readFile(publicKeyPath, 'utf8'))
  const valid = verify(
    null,
    Buffer.from(`${PREFIX}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], 'base64url')
  )
  process.stdout.write(`${JSON.stringify({ validSignature: valid, claims }, null, 2)}\n`)
  if (!valid) process.exitCode = 2
}

function parseExpiry(options, issuedAt) {
  const variants = ['days', 'expires', 'lifetime'].filter((name) => options.has(name))
  if (variants.length > 1) throw new Error('Укажите только один срок: --days, --expires или --lifetime')
  if (options.has('lifetime') || variants.length === 0) return null

  if (options.has('days')) {
    const days = Number(options.get('days'))
    if (!Number.isSafeInteger(days) || days < 1 || days > 36_500) {
      throw new Error('--days должен быть целым числом от 1 до 36500')
    }
    return issuedAt + days * 86_400
  }

  const rawExpiry = requiredOption(options, 'expires')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawExpiry)) throw new Error('--expires: ожидается YYYY-MM-DD')
  const timestamp = Date.parse(`${rawExpiry}T23:59:59Z`)
  if (!Number.isFinite(timestamp) || timestamp <= issuedAt * 1000) {
    throw new Error('Дата окончания должна быть в будущем')
  }
  return Math.floor(timestamp / 1000)
}

function parseArguments(values) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]
    if (!argument.startsWith('--')) throw new Error(`Ожидался параметр, получено: ${argument}`)
    const name = argument.slice(2)
    if (!name || result.has(name)) throw new Error(`Некорректный или повторный параметр: ${argument}`)
    if (name === 'lifetime') {
      result.set(name, 'true')
      continue
    }
    const value = values[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Нет значения для ${argument}`)
    result.set(name, value)
    index += 1
  }
  return result
}

function requiredOption(options, name) {
  const value = options.get(name)
  if (!value) throw new Error(`Обязательный параметр: --${name}`)
  return value
}

function absoluteOption(options, name, fallback) {
  return resolve(options.get(name) ?? fallback)
}

function normalizeDeviceCode(value) {
  const normalized = value.trim().toUpperCase()
  const matches = normalized.match(
    /(?<![A-Z0-9])ELI-(?:[A-Z2-7]{4}-){4}[A-Z2-7]{4}(?![A-Z0-9])/g
  ) ?? []
  const uniqueMatches = [...new Set(matches)]
  if (uniqueMatches.length === 0) {
    throw new Error('Некорректный --device-code; скопируйте код из окна программы')
  }
  if (uniqueMatches.length > 1) {
    throw new Error('Найдено несколько разных кодов устройства; оставьте один код ELI-…')
  }
  return uniqueMatches[0]
}

async function readMacPlatformUuid() {
  const { stdout } = await execFile(
    '/usr/sbin/ioreg',
    ['-rd1', '-c', 'IOPlatformExpertDevice'],
    { encoding: 'utf8', timeout: 5_000, maxBuffer: 512_000 }
  )
  const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([0-9A-F-]+)"/i)
  if (!match) throw new Error('IOPlatformUUID недоступен')
  return match[1].toUpperCase()
}

async function readWindowsMachineGuid() {
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const regExecutable = join(windowsDirectory, 'System32', 'reg.exe')
  const { stdout } = await execFile(
    regExecutable,
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
    { encoding: 'utf8', timeout: 5_000, maxBuffer: 512_000, windowsHide: true }
  )
  const match = stdout.match(/^\s*MachineGuid\s+REG_SZ\s+\{?([0-9A-F-]+)\}?\s*$/imu)
  if (!match || !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(match[1])) {
    throw new Error('MachineGuid недоступен')
  }
  return match[1].toUpperCase()
}

function deriveDeviceCode(source) {
  const digest = createHash('sha256').update(DEVICE_NAMESPACE).update(source).digest()
  const encoded = encodeBase32(digest).slice(0, 20)
  return `ELI-${encoded.match(/.{1,4}/g).join('-')}`
}

function encodeBase32(value) {
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

function createLicenseId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  return `LIC-${date}-${randomBytes(6).toString('hex').toUpperCase()}`
}

function printHelp() {
  const script = basename(process.argv[1])
  process.stdout.write(`Fly Safe — управление офлайн-лицензиями\n\n`)
  process.stdout.write(`  node scripts/${script} init\n`)
  process.stdout.write(`  node scripts/${script} device-code\n`)
  process.stdout.write(`  node scripts/${script} issue --device-code ELI-... --customer "Имя" [--days 365|--expires YYYY-MM-DD|--lifetime]\n`)
  process.stdout.write(`  node scripts/${script} inspect --file /path/license.license\n\n`)
  process.stdout.write(`Приватный ключ по умолчанию: ${DEFAULT_PRIVATE_KEY}\n`)
}
