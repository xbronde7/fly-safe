import { BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import type { NativeAlertWorkspace, TrayStatus } from '../shared/native-alert'

// NativeImage supports PNG/JPEG across all platforms. Keeping a valid PNG in
// the main bundle also avoids a filesystem dependency for portable builds.
const TRAY_ICON_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAACTSURBVHgBpZKBCYAgEEV/TeAIjuIIbdQIuUGt0CS1gW1iZ2jIVaTnhw+Cvs8/OYDJA4Y8kR3ZR2/kmazxJbpUEfQ/Dm/UG7wVwHkjlQdMFfDdJMFaACebnjJGyDWgcnZu1/lrCrl6NCoEHJBrDwEr5NrT6ko/UV8xdLAC2N49mlc5CylpYh8wCwqrvbBGLoKGvz8Bfq0QPWEUo/EAAAAASUVORK5CYII='

export interface TrayControllerOptions {
  getWindow: () => BrowserWindow | null
  ensureWindow?: () => void
  quit: () => void
  onNavigate?: (workspace: NativeAlertWorkspace) => void
}

export class TrayController {
  private tray: Tray | null = null

  constructor(private readonly options: TrayControllerOptions) {}

  start(): TrayStatus {
    if (this.tray) return this.status()

    try {
      const sourceIcon = nativeImage.createFromDataURL(TRAY_ICON_PNG_DATA_URL)
      if (sourceIcon.isEmpty()) return this.status()
      const icon = sourceIcon.resize({ width: 18, height: 18, quality: 'best' })
      if (icon.isEmpty()) return this.status()
      if (process.platform === 'darwin') icon.setTemplateImage(true)
      this.tray = new Tray(icon)
      this.tray.setToolTip('Fly Safe — background intel')
      this.tray.setContextMenu(Menu.buildFromTemplate([
        {
          label: 'Open Fly Safe',
          click: () => this.showWindow()
        },
        {
          label: 'Watched contacts',
          click: () => this.navigate('watchlist')
        },
        {
          label: 'Route',
          click: () => this.navigate('route')
        },
        { type: 'separator' },
        {
          label: 'Hide window',
          click: () => this.options.getWindow()?.hide()
        },
        { type: 'separator' },
        {
          label: 'Quit Fly Safe',
          click: () => this.options.quit()
        }
      ]))
      this.tray.on('click', () => this.toggleWindow())
      return this.status()
    } catch {
      this.tray = null
      return this.status()
    }
  }

  status(): TrayStatus {
    return {
      available: this.tray !== null,
      backgroundMode: this.tray !== null
    }
  }

  showWindow(): void {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) {
      this.options.ensureWindow?.()
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  navigate(workspace: NativeAlertWorkspace): void {
    this.showWindow()
    this.options.onNavigate?.(workspace)
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private toggleWindow(): void {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isVisible() && window.isFocused()) window.hide()
    else this.showWindow()
  }
}
