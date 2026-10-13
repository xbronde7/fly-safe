export type NativeAlertKind =
  | 'watchlist'
  | 'system-killmail'
  | 'route-corridor'
  | 'r2z2'
  | 'info'

export type NativeAlertWorkspace = 'intel' | 'route' | 'watchlist' | 'industry'

export interface NativeAlertRequest {
  title: string
  body: string
  kind: NativeAlertKind
  workspace: NativeAlertWorkspace
  /** Stable key used by main to suppress repeats during the cooldown. */
  dedupeKey?: string
  cooldownMs?: number
  /** Show even while Fly Safe is focused (settings test and opt-in industry deals). */
  force?: boolean
  /** Keep the OS notification quiet when Fly Safe already plays its own sound. */
  silent?: boolean
}

export interface NativeAlertResult {
  shown: boolean
  reason: 'shown' | 'focused' | 'cooldown' | 'unsupported' | 'disabled'
}

export interface TrayStatus {
  available: boolean
  backgroundMode: boolean
}

export const NATIVE_ALERT_LIMITS = {
  titleLength: 96,
  bodyLength: 480,
  dedupeKeyLength: 180,
  minimumCooldownMs: 1_000,
  maximumCooldownMs: 24 * 60 * 60_000,
  defaultCooldownMs: 60_000
} as const
