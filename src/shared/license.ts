export const LICENSE_TOKEN_PREFIX = 'EVEI1'
export const LICENSE_TOKEN_VERSION = 1 as const
export const LICENSE_PRODUCT = 'eve-local-intel' as const
export const ENTITLEMENT_TOKEN_PREFIX = 'EVEI2'
export const ENTITLEMENT_TOKEN_VERSION = 2 as const

const MAX_TOKEN_LENGTH = 16_384
const MAX_PAYLOAD_BYTES = 4_096
const ED25519_SIGNATURE_BYTES = 64
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const LICENSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const DEVICE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{7,127}$/

export interface LicenseClaims {
  v: typeof LICENSE_TOKEN_VERSION
  product: typeof LICENSE_PRODUCT
  licenseId: string
  customer: string
  deviceCode: string
  /** Unix time in whole seconds. */
  issuedAt: number
  /** Unix time in whole seconds, or null for a perpetual license. */
  expiresAt: number | null
}

/** Online subscription entitlement issued by the Fly Safe backend. */
export interface EntitlementClaims {
  v: typeof ENTITLEMENT_TOKEN_VERSION
  product: typeof LICENSE_PRODUCT
  kid: string
  entitlementId: string
  revision: number
  subscriptionId: string
  characterId: string
  characterName: string
  deviceId: string
  deviceCode: string
  planId: string
  features: string[]
  /** Unix time in whole seconds. */
  issuedAt: number
  /** Unix time in whole seconds. */
  notBefore: number
  /** Paid subscription boundary; grace may extend `expiresAt` beyond it. */
  paidThrough: number
  /** Short-lived online entitlement boundary. */
  expiresAt: number
}

export type VerifiedLicenseClaims = LicenseClaims | EntitlementClaims

export interface LicenseInfo {
  licenseId: string
  customer: string
  issuedAt: number
  expiresAt: number | null
  characterId?: string
  characterName?: string
  planId?: string
  features?: string[]
  paidThrough?: number
  entitlementRevision?: number
}

export type LicenseState =
  | 'missing'
  | 'active'
  | 'expired'
  | 'not_yet_valid'
  | 'device_mismatch'
  | 'character_mismatch'
  | 'invalid'
  | 'storage_unavailable'
  | 'storage_error'

export interface LicenseStatus {
  state: LicenseState
  active: boolean
  /** Public installation identifier shown to the user when requesting a key. */
  deviceCode: string
  license: LicenseInfo | null
  message: string | null
}

export type LicenseTokenFormatErrorCode = 'invalid_format' | 'invalid_payload'

export class LicenseTokenFormatError extends Error {
  readonly code: LicenseTokenFormatErrorCode

  constructor(code: LicenseTokenFormatErrorCode, message: string) {
    super(message)
    this.name = 'LicenseTokenFormatError'
    this.code = code
  }
}

export interface ParsedLicenseToken {
  token: string
  claims: VerifiedLicenseClaims
  payloadSegment: string
  signature: Uint8Array
  signingBytes: Uint8Array
}

export interface LicenseSigningMaterial {
  claims: LicenseClaims
  payloadSegment: string
  signingBytes: Uint8Array
}

export interface EntitlementSigningMaterial {
  claims: EntitlementClaims
  payloadSegment: string
  signingBytes: Uint8Array
}

/** Normalizes a public device/request code before display, issuing, or comparison. */
export function normalizeDeviceCode(value: string): string {
  if (typeof value !== 'string') {
    throw new LicenseTokenFormatError('invalid_payload', 'Код устройства имеет неверный формат')
  }

  const normalized = value.trim().toUpperCase()
  if (!DEVICE_CODE_PATTERN.test(normalized)) {
    throw new LicenseTokenFormatError('invalid_payload', 'Код устройства имеет неверный формат')
  }
  return normalized
}

/** Creates deterministic bytes for an issuer to sign with an Ed25519 private key. */
export function createLicenseSigningMaterial(claims: LicenseClaims): LicenseSigningMaterial {
  const normalizedClaims = validateLicenseClaims(claims)
  const payloadBytes = new TextEncoder().encode(JSON.stringify(normalizedClaims))
  if (payloadBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new LicenseTokenFormatError('invalid_payload', 'Данные лицензионного ключа слишком велики')
  }

  const payloadSegment = encodeBase64Url(payloadBytes)
  return {
    claims: normalizedClaims,
    payloadSegment,
    signingBytes: new TextEncoder().encode(`${LICENSE_TOKEN_PREFIX}.${payloadSegment}`)
  }
}

/** Creates the exact bytes a backend signs for an EVEI2 entitlement. */
export function createEntitlementSigningMaterial(
  claims: EntitlementClaims
): EntitlementSigningMaterial {
  const normalizedClaims = validateEntitlementClaims(claims)
  const payloadBytes = encodePayload(normalizedClaims)
  const payloadSegment = encodeBase64Url(payloadBytes)
  return {
    claims: normalizedClaims,
    payloadSegment,
    signingBytes: new TextEncoder().encode(`${ENTITLEMENT_TOKEN_PREFIX}.${payloadSegment}`)
  }
}

/** Combines issuer signing material with its raw 64-byte Ed25519 signature. */
export function formatLicenseToken(payloadSegment: string, signature: Uint8Array): string {
  return formatSignedToken(LICENSE_TOKEN_PREFIX, payloadSegment, signature)
}

export function formatEntitlementToken(payloadSegment: string, signature: Uint8Array): string {
  return formatSignedToken(ENTITLEMENT_TOKEN_PREFIX, payloadSegment, signature)
}

function formatSignedToken(
  prefix: typeof LICENSE_TOKEN_PREFIX | typeof ENTITLEMENT_TOKEN_PREFIX,
  payloadSegment: string,
  signature: Uint8Array
): string {
  if (!BASE64URL_PATTERN.test(payloadSegment)) {
    throw new LicenseTokenFormatError('invalid_format', 'Данные лицензионного ключа повреждены')
  }
  if (!(signature instanceof Uint8Array) || signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new LicenseTokenFormatError('invalid_format', 'Подпись лицензионного ключа повреждена')
  }

  const token = `${prefix}.${payloadSegment}.${encodeBase64Url(signature)}`
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new LicenseTokenFormatError('invalid_format', 'Лицензионный ключ слишком длинный')
  }
  return token
}

/** Parses a token without trusting it. Callers must verify `signature` before using claims. */
export function parseLicenseToken(input: string): ParsedLicenseToken {
  if (typeof input !== 'string') {
    throw new LicenseTokenFormatError('invalid_format', 'Лицензионный ключ имеет неверный формат')
  }

  const token = input.trim()
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw new LicenseTokenFormatError('invalid_format', 'Лицензионный ключ имеет неверный формат')
  }

  const parts = token.split('.')
  if (
    parts.length !== 3 ||
    (parts[0] !== LICENSE_TOKEN_PREFIX && parts[0] !== ENTITLEMENT_TOKEN_PREFIX)
  ) {
    throw new LicenseTokenFormatError('invalid_format', 'Лицензионный ключ имеет неверный формат')
  }

  const payloadBytes = decodeBase64Url(parts[1], MAX_PAYLOAD_BYTES, 'Данные лицензионного ключа повреждены')
  const signature = decodeBase64Url(
    parts[2],
    ED25519_SIGNATURE_BYTES,
    'Подпись лицензионного ключа повреждена'
  )
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new LicenseTokenFormatError('invalid_format', 'Подпись лицензионного ключа повреждена')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes))
  } catch {
    throw new LicenseTokenFormatError('invalid_payload', 'Данные лицензионного ключа повреждены')
  }

  return {
    token,
    claims: parts[0] === LICENSE_TOKEN_PREFIX
      ? validateLicenseClaims(decoded)
      : validateEntitlementClaims(decoded),
    payloadSegment: parts[1],
    signature,
    signingBytes: new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  }
}

export function toLicenseInfo(claims: VerifiedLicenseClaims): LicenseInfo {
  if (claims.v === ENTITLEMENT_TOKEN_VERSION) {
    return {
      licenseId: claims.entitlementId,
      customer: claims.characterName,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      characterId: claims.characterId,
      characterName: claims.characterName,
      planId: claims.planId,
      features: [...claims.features],
      paidThrough: claims.paidThrough,
      entitlementRevision: claims.revision
    }
  }
  return {
    licenseId: claims.licenseId,
    customer: claims.customer,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt
  }
}

export function validateEntitlementClaims(value: unknown): EntitlementClaims {
  if (!isRecord(value)) {
    throw new LicenseTokenFormatError('invalid_payload', 'Данные entitlement повреждены')
  }
  const expectedKeys = [
    'characterId',
    'characterName',
    'deviceCode',
    'deviceId',
    'entitlementId',
    'expiresAt',
    'features',
    'issuedAt',
    'kid',
    'notBefore',
    'paidThrough',
    'planId',
    'product',
    'revision',
    'subscriptionId',
    'v'
  ]
  if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')) {
    throw new LicenseTokenFormatError('invalid_payload', 'Набор полей entitlement неверен')
  }
  if (value.v !== ENTITLEMENT_TOKEN_VERSION || value.product !== LICENSE_PRODUCT) {
    throw new LicenseTokenFormatError('invalid_payload', 'Entitlement выпущен для другого продукта')
  }

  const identifierFields = ['kid', 'entitlementId', 'subscriptionId', 'deviceId', 'planId'] as const
  for (const field of identifierFields) {
    if (typeof value[field] !== 'string' || !LICENSE_ID_PATTERN.test(value[field])) {
      throw new LicenseTokenFormatError('invalid_payload', `Поле ${field} имеет неверный формат`)
    }
  }
  if (typeof value.characterId !== 'string' || !/^\d{6,20}$/u.test(value.characterId)) {
    throw new LicenseTokenFormatError('invalid_payload', 'ID персонажа имеет неверный формат')
  }
  if (!validDisplayName(value.characterName)) {
    throw new LicenseTokenFormatError('invalid_payload', 'Имя персонажа имеет неверный формат')
  }
  const deviceCode = normalizeDeviceCode(value.deviceCode as string)
  if (deviceCode !== value.deviceCode) {
    throw new LicenseTokenFormatError('invalid_payload', 'Код устройства в entitlement не нормализован')
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw new LicenseTokenFormatError('invalid_payload', 'Ревизия entitlement имеет неверный формат')
  }
  if (
    !Array.isArray(value.features) ||
    value.features.length > 64 ||
    value.features.some((feature) => (
      typeof feature !== 'string' ||
      !/^[a-z0-9][a-z0-9._:-]{1,63}$/u.test(feature)
    )) ||
    new Set(value.features).size !== value.features.length
  ) {
    throw new LicenseTokenFormatError('invalid_payload', 'Функции entitlement имеют неверный формат')
  }
  for (const field of ['issuedAt', 'notBefore', 'paidThrough', 'expiresAt'] as const) {
    if (!isUnixTime(value[field])) {
      throw new LicenseTokenFormatError('invalid_payload', `Дата ${field} имеет неверный формат`)
    }
  }
  if (
    (value.expiresAt as number) <= (value.notBefore as number) ||
    (value.expiresAt as number) <= (value.issuedAt as number)
  ) {
    throw new LicenseTokenFormatError('invalid_payload', 'Период entitlement имеет неверный формат')
  }

  return {
    v: ENTITLEMENT_TOKEN_VERSION,
    product: LICENSE_PRODUCT,
    kid: value.kid as string,
    entitlementId: value.entitlementId as string,
    revision: value.revision as number,
    subscriptionId: value.subscriptionId as string,
    characterId: value.characterId,
    characterName: value.characterName as string,
    deviceId: value.deviceId as string,
    deviceCode,
    planId: value.planId as string,
    features: [...value.features] as string[],
    issuedAt: value.issuedAt as number,
    notBefore: value.notBefore as number,
    paidThrough: value.paidThrough as number,
    expiresAt: value.expiresAt as number
  }
}

export function validateLicenseClaims(value: unknown): LicenseClaims {
  if (!isRecord(value)) {
    throw new LicenseTokenFormatError('invalid_payload', 'Данные лицензионного ключа повреждены')
  }

  const expectedKeys = [
    'customer',
    'deviceCode',
    'expiresAt',
    'issuedAt',
    'licenseId',
    'product',
    'v'
  ]
  if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')) {
    throw new LicenseTokenFormatError('invalid_payload', 'Набор полей лицензионного ключа неверен')
  }
  if (value.v !== LICENSE_TOKEN_VERSION || value.product !== LICENSE_PRODUCT) {
    throw new LicenseTokenFormatError('invalid_payload', 'Лицензионный ключ выпущен для другой версии продукта')
  }
  if (typeof value.licenseId !== 'string' || !LICENSE_ID_PATTERN.test(value.licenseId)) {
    throw new LicenseTokenFormatError('invalid_payload', 'Идентификатор лицензии имеет неверный формат')
  }
  if (
    typeof value.customer !== 'string' ||
    value.customer !== value.customer.trim() ||
    value.customer.length < 1 ||
    value.customer.length > 160 ||
    containsControlCharacter(value.customer)
  ) {
    throw new LicenseTokenFormatError('invalid_payload', 'Имя владельца лицензии имеет неверный формат')
  }

  const deviceCode = normalizeDeviceCode(value.deviceCode as string)
  if (deviceCode !== value.deviceCode) {
    throw new LicenseTokenFormatError('invalid_payload', 'Код устройства в лицензии не нормализован')
  }
  if (!isUnixTime(value.issuedAt)) {
    throw new LicenseTokenFormatError('invalid_payload', 'Дата выпуска лицензии имеет неверный формат')
  }
  if (value.expiresAt !== null && !isUnixTime(value.expiresAt)) {
    throw new LicenseTokenFormatError('invalid_payload', 'Срок лицензии имеет неверный формат')
  }
  if (value.expiresAt !== null && value.expiresAt <= value.issuedAt) {
    throw new LicenseTokenFormatError('invalid_payload', 'Срок лицензии должен быть позже даты выпуска')
  }

  return {
    v: LICENSE_TOKEN_VERSION,
    product: LICENSE_PRODUCT,
    licenseId: value.licenseId,
    customer: value.customer,
    deviceCode,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

function decodeBase64Url(segment: string, maxBytes: number, errorMessage: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(segment)) {
    throw new LicenseTokenFormatError('invalid_format', errorMessage)
  }

  const paddingLength = (4 - (segment.length % 4)) % 4
  if (paddingLength === 3) {
    throw new LicenseTokenFormatError('invalid_format', errorMessage)
  }

  let binary: string
  try {
    binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(paddingLength))
  } catch {
    throw new LicenseTokenFormatError('invalid_format', errorMessage)
  }
  if (binary.length === 0 || binary.length > maxBytes) {
    throw new LicenseTokenFormatError('invalid_format', errorMessage)
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64Url(bytes) !== segment) {
    throw new LicenseTokenFormatError('invalid_format', errorMessage)
  }
  return bytes
}

function isUnixTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint < 0x20 || codePoint === 0x7f) return true
  }
  return false
}

function validDisplayName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 160 &&
    !containsControlCharacter(value)
  )
}

function encodePayload(value: unknown): Uint8Array {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(value))
  if (payloadBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new LicenseTokenFormatError('invalid_payload', 'Данные entitlement слишком велики')
  }
  return payloadBytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
