import type { AppUpdater } from 'electron-updater'

const FIRST_CHECK_DELAY_MS = 15_000
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000

export type AutoUpdateState =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'current'
  | 'error'

export interface AutoUpdateStatus {
  state: AutoUpdateState
  version: string | null
  progressPercent: number | null
  message: string | null
}

export interface AutoUpdateServiceOptions {
  updater: AppUpdater
  packaged: boolean
  onStatus?: (status: AutoUpdateStatus) => void
}

/** Downloads signed releases in the background and installs them on normal app quit. */
export class AutoUpdateService {
  private readonly updater: AppUpdater
  private readonly packaged: boolean
  private readonly onStatus: (status: AutoUpdateStatus) => void
  private firstCheckTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private currentStatus: AutoUpdateStatus = {
    state: 'disabled',
    version: null,
    progressPercent: null,
    message: null
  }

  constructor(options: AutoUpdateServiceOptions) {
    this.updater = options.updater
    this.packaged = options.packaged
    this.onStatus = options.onStatus ?? (() => undefined)
  }

  start(): AutoUpdateStatus {
    if (this.started) return this.status()
    this.started = true
    if (!this.packaged) return this.publish({ state: 'disabled', message: 'development build' })

    this.updater.autoDownload = true
    this.updater.autoInstallOnAppQuit = true
    this.updater.autoRunAppAfterInstall = true
    this.updater.allowDowngrade = false
    this.updater.allowPrerelease = false
    this.updater.disableWebInstaller = true

    this.updater.on('checking-for-update', this.handleChecking)
    this.updater.on('update-available', this.handleAvailable)
    this.updater.on('download-progress', this.handleProgress)
    this.updater.on('update-downloaded', this.handleDownloaded)
    this.updater.on('update-not-available', this.handleCurrent)
    this.updater.on('error', this.handleError)

    this.publish({ state: 'idle', message: null })
    this.firstCheckTimer = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    this.intervalTimer = setInterval(() => void this.check(), UPDATE_CHECK_INTERVAL_MS)
    return this.status()
  }

  async check(): Promise<AutoUpdateStatus> {
    if (!this.started || !this.packaged) return this.status()
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.handleError(normalizeError(error))
    }
    return this.status()
  }

  status(): AutoUpdateStatus {
    return { ...this.currentStatus }
  }

  dispose(): void {
    if (this.firstCheckTimer) clearTimeout(this.firstCheckTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.firstCheckTimer = null
    this.intervalTimer = null
    if (!this.packaged) return
    this.updater.removeListener('checking-for-update', this.handleChecking)
    this.updater.removeListener('update-available', this.handleAvailable)
    this.updater.removeListener('download-progress', this.handleProgress)
    this.updater.removeListener('update-downloaded', this.handleDownloaded)
    this.updater.removeListener('update-not-available', this.handleCurrent)
    this.updater.removeListener('error', this.handleError)
  }

  private readonly handleChecking = (): void => {
    this.publish({ state: 'checking', progressPercent: null, message: null })
  }

  private readonly handleAvailable = (info: { version: string }): void => {
    this.publish({ state: 'available', version: info.version, progressPercent: 0, message: null })
  }

  private readonly handleProgress = (info: { percent: number }): void => {
    this.publish({
      state: 'downloading',
      progressPercent: Math.max(0, Math.min(100, info.percent)),
      message: null
    })
  }

  private readonly handleDownloaded = (info: { version: string }): void => {
    this.publish({ state: 'downloaded', version: info.version, progressPercent: 100, message: null })
  }

  private readonly handleCurrent = (info: { version: string }): void => {
    this.publish({ state: 'current', version: info.version, progressPercent: null, message: null })
  }

  private readonly handleError = (error: Error): void => {
    this.publish({ state: 'error', progressPercent: null, message: publicError(error) })
  }

  private publish(patch: Partial<AutoUpdateStatus>): AutoUpdateStatus {
    this.currentStatus = { ...this.currentStatus, ...patch }
    this.onStatus(this.status())
    return this.status()
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown update error')
}

function publicError(error: Error): string {
  const message = error.message.trim()
  return message ? message.slice(0, 500) : 'Could not check for updates'
}
