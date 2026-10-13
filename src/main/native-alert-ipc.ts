import type {
  NativeAlertKind,
  NativeAlertRequest,
  NativeAlertWorkspace
} from '../shared/native-alert'
import { NATIVE_ALERT_LIMITS } from '../shared/native-alert'

const ALERT_KINDS = new Set<NativeAlertKind>([
  'watchlist',
  'system-killmail',
  'route-corridor',
  'r2z2',
  'info'
])
const WORKSPACES = new Set<NativeAlertWorkspace>(['intel', 'route', 'watchlist', 'industry'])
const ALLOWED_KEYS = new Set([
  'title',
  'body',
  'kind',
  'workspace',
  'dedupeKey',
  'cooldownMs',
  'force',
  'silent'
])

export function parseNativeAlertRequest(value: unknown): NativeAlertRequest {
  if (!isRecord(value)) throw new TypeError('Invalid native alert')
  if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new TypeError('Native alert contains unknown fields')
  }

  const title = requiredText(value.title, 'Title', NATIVE_ALERT_LIMITS.titleLength)
  const body = requiredText(value.body, 'Text', NATIVE_ALERT_LIMITS.bodyLength)
  if (typeof value.kind !== 'string' || !ALERT_KINDS.has(value.kind as NativeAlertKind)) {
    throw new TypeError('Invalid native-alert type')
  }
  if (
    typeof value.workspace !== 'string' ||
    !WORKSPACES.has(value.workspace as NativeAlertWorkspace)
  ) {
    throw new TypeError('Invalid native-alert workspace')
  }

  const dedupeKey = optionalText(
    value.dedupeKey,
    'Alert key',
    NATIVE_ALERT_LIMITS.dedupeKeyLength
  )
  const cooldownMs = value.cooldownMs === undefined
    ? undefined
    : integerInRange(
        value.cooldownMs,
        NATIVE_ALERT_LIMITS.minimumCooldownMs,
        NATIVE_ALERT_LIMITS.maximumCooldownMs,
        'Alert cooldown'
      )
  const force = optionalBoolean(value.force, 'force')
  const silent = optionalBoolean(value.silent, 'silent')

  return {
    title,
    body,
    kind: value.kind as NativeAlertKind,
    workspace: value.workspace as NativeAlertWorkspace,
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
    ...(cooldownMs === undefined ? {} : { cooldownMs }),
    ...(force === undefined ? {} : { force }),
    ...(silent === undefined ? {} : { silent })
  }
}

function requiredText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`)
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new RangeError(`${label}: from 1 to ${maximumLength} characters are allowed`)
  }
  return normalized
}

function optionalText(
  value: unknown,
  label: string,
  maximumLength: number
): string | undefined {
  if (value === undefined) return undefined
  return requiredText(value, label, maximumLength)
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`)
  return value
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label}: allowed range is ${minimum} to ${maximum} ms`)
  }
  return value as number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
