import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const resizedIcon = {
    isEmpty: vi.fn(),
    setTemplateImage: vi.fn()
  }
  const sourceIcon = {
    isEmpty: vi.fn(),
    resize: vi.fn(() => resizedIcon)
  }
  const createFromDataURL = vi.fn((_dataUrl: string) => sourceIcon)
  return {
    resizedIcon,
    sourceIcon,
    createFromDataURL,
    buildFromTemplate: vi.fn(() => ({})),
    trayIcons: [] as unknown[],
    trayOn: vi.fn(),
    trayDestroy: vi.fn()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class {},
  Menu: {
    buildFromTemplate: electronMocks.buildFromTemplate
  },
  nativeImage: {
    createFromDataURL: electronMocks.createFromDataURL
  },
  Tray: class {
    constructor(icon: unknown) {
      electronMocks.trayIcons.push(icon)
    }

    setToolTip(): void {}
    setContextMenu(): void {}
    on = electronMocks.trayOn
    destroy = electronMocks.trayDestroy
  }
}))

import { TrayController } from '../src/main/tray-controller'

beforeEach(() => {
  vi.clearAllMocks()
  electronMocks.trayIcons.length = 0
  electronMocks.sourceIcon.isEmpty.mockReturnValue(false)
  electronMocks.resizedIcon.isEmpty.mockReturnValue(false)
  electronMocks.sourceIcon.resize.mockReturnValue(electronMocks.resizedIcon)
  electronMocks.createFromDataURL.mockReturnValue(electronMocks.sourceIcon)
})

function createController(): TrayController {
  return new TrayController({
    getWindow: () => null,
    quit: vi.fn()
  })
}

describe('TrayController', () => {
  it('uses a valid embedded PNG and creates a visible tray image', () => {
    const controller = createController()

    expect(controller.start()).toEqual({ available: true, backgroundMode: true })
    const dataUrl = electronMocks.createFromDataURL.mock.calls[0]?.[0]
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    const signature = Buffer.from(dataUrl!.split(',')[1], 'base64').subarray(0, 8)
    expect([...signature]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(electronMocks.trayIcons).toEqual([electronMocks.resizedIcon])
  })

  it('does not advertise background mode when image decoding fails', () => {
    electronMocks.sourceIcon.isEmpty.mockReturnValue(true)
    const controller = createController()

    expect(controller.start()).toEqual({ available: false, backgroundMode: false })
    expect(electronMocks.trayIcons).toHaveLength(0)
  })
})
