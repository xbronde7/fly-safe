import { BrowserWindow, Notification } from 'electron'
import type {
  NativeAlertRequest,
  NativeAlertResult,
  NativeAlertWorkspace
} from '../shared/native-alert'
import { NATIVE_ALERT_LIMITS } from '../shared/native-alert'

export interface NativeAlertServiceOptions {
  getWindow: () => BrowserWindow | null
  now?: () => number
  isSupported?: () => boolean
  createNotification?: (options: Electron.NotificationConstructorOptions) => Notification
  onActivate?: (workspace: NativeAlertWorkspace) => void
}

/**
 * Shows bounded, deduplicated OS notifications. The renderer supplies display
 * text only; activation is restricted to a known Fly Safe workspace.
 */
export class NativeAlertService {
  private readonly lastShownByKey = new Map<string, number>()
  private readonly activeNotifications = new Map<
    Notification,
    ReturnType<typeof setTimeout> | null
  >()
  private readonly now: () => number
  private readonly isSupported: () => boolean
  private readonly createNotification: (
    options: Electron.NotificationConstructorOptions
  ) => Notification

  constructor(private readonly options: NativeAlertServiceOptions) {
    this.now = options.now ?? Date.now
    this.isSupported = options.isSupported ?? (() => Notification.isSupported())
    this.createNotification = options.createNotification ?? ((notificationOptions) =>
      new Notification(notificationOptions))
  }

  show(request: NativeAlertRequest): NativeAlertResult {
    if (!this.isSupported()) return { shown: false, reason: 'unsupported' }

    const window = this.options.getWindow()
    const appIsFocused = Boolean(
      window && !window.isDestroyed() && window.isVisible() && window.isFocused()
    )
    if (appIsFocused && request.force !== true) {
      return { shown: false, reason: 'focused' }
    }

    const now = this.now()
    const cooldownMs = request.cooldownMs ?? NATIVE_ALERT_LIMITS.defaultCooldownMs
    const dedupeKey = request.dedupeKey ?? `${request.kind}:${request.title}:${request.body}`
    const lastShown = this.lastShownByKey.get(dedupeKey)
    if (lastShown !== undefined && now - lastShown < cooldownMs) {
      return { shown: false, reason: 'cooldown' }
    }

    const notification = this.createNotification({
      title: request.title,
      body: request.body,
      silent: request.silent ?? true,
      urgency: request.kind === 'watchlist' ? 'critical' : 'normal',
      timeoutType: request.kind === 'watchlist' ? 'never' : 'default'
    })

    const release = (): void => this.releaseNotification(notification)
    notification.once('click', () => {
      release()
      this.options.onActivate?.(request.workspace)
    })
    notification.once('close', release)
    notification.once('failed', () => {
      release()
      if (this.lastShownByKey.get(dedupeKey) === now) {
        this.lastShownByKey.delete(dedupeKey)
      }
    })

    this.activeNotifications.set(notification, null)
    const retentionTimer = setTimeout(release, NATIVE_ALERT_LIMITS.maximumCooldownMs)
    retentionTimer.unref?.()
    if (this.activeNotifications.has(notification)) {
      this.activeNotifications.set(notification, retentionTimer)
    } else {
      clearTimeout(retentionTimer)
    }

    this.lastShownByKey.set(dedupeKey, now)
    try {
      notification.show()
    } catch (error) {
      release()
      if (this.lastShownByKey.get(dedupeKey) === now) {
        this.lastShownByKey.delete(dedupeKey)
      }
      throw error
    }
    this.prune(now)
    return { shown: true, reason: 'shown' }
  }

  clearCooldowns(): void {
    this.lastShownByKey.clear()
  }

  dispose(): void {
    for (const notification of this.activeNotifications.keys()) {
      this.releaseNotification(notification)
    }
  }

  private prune(now: number): void {
    const oldestUseful = now - NATIVE_ALERT_LIMITS.maximumCooldownMs
    for (const [key, shownAt] of this.lastShownByKey) {
      if (shownAt < oldestUseful) this.lastShownByKey.delete(key)
    }
  }

  private releaseNotification(notification: Notification): void {
    const timer = this.activeNotifications.get(notification)
    if (timer !== undefined && timer !== null) clearTimeout(timer)
    this.activeNotifications.delete(notification)
  }
}
