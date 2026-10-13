import { afterEach, describe, expect, it, vi } from 'vitest'

const notificationInstances: Array<{
  options: Electron.NotificationConstructorOptions
  once: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
}> = []

vi.mock('electron', () => ({
  BrowserWindow: class {},
  Notification: class {
    static isSupported(): boolean { return true }
  }
}))

import { NativeAlertService } from '../src/main/native-alert-service'
import { NATIVE_ALERT_LIMITS } from '../src/shared/native-alert'

function request() {
  return {
    title: 'Опасный контакт',
    body: 'Pilot One замечен',
    kind: 'watchlist' as const,
    workspace: 'watchlist' as const,
    dedupeKey: 'pilot:1',
    cooldownMs: 60_000
  }
}

afterEach(() => {
  vi.useRealTimers()
  notificationInstances.length = 0
})

function notificationHandler(
  instance: (typeof notificationInstances)[number] | undefined,
  eventName: string
): (() => void) | undefined {
  return instance?.once.mock.calls.find(([name]) => name === eventName)?.[1]
}

function retainedNotificationCount(service: NativeAlertService): number {
  return (service as unknown as {
    activeNotifications: Map<unknown, unknown>
  }).activeNotifications.size
}

describe('NativeAlertService', () => {
  it('does not interrupt a focused window unless forced', () => {
    const createNotification = vi.fn()
    const service = new NativeAlertService({
      getWindow: () => ({
        isDestroyed: () => false,
        isVisible: () => true,
        isFocused: () => true
      }) as never,
      isSupported: () => true,
      createNotification
    })

    expect(service.show(request())).toEqual({ shown: false, reason: 'focused' })
    expect(createNotification).not.toHaveBeenCalled()
  })

  it('shows in background, deduplicates and activates a safe workspace', () => {
    let now = 1_000_000
    const onActivate = vi.fn()
    const createNotification = vi.fn((options: Electron.NotificationConstructorOptions) => {
      const instance = { options, once: vi.fn(), show: vi.fn() }
      notificationInstances.push(instance)
      return instance as never
    })
    const service = new NativeAlertService({
      getWindow: () => ({
        isDestroyed: () => false,
        isVisible: () => false,
        isFocused: () => false
      }) as never,
      now: () => now,
      isSupported: () => true,
      createNotification,
      onActivate
    })

    expect(service.show(request())).toEqual({ shown: true, reason: 'shown' })
    expect(service.show(request())).toEqual({ shown: false, reason: 'cooldown' })
    expect(notificationInstances.at(-1)?.show).toHaveBeenCalledOnce()
    expect(retainedNotificationCount(service)).toBe(1)
    notificationHandler(notificationInstances.at(-1), 'click')?.()
    expect(onActivate).toHaveBeenCalledWith('watchlist')
    expect(retainedNotificationCount(service)).toBe(0)

    now += 60_000
    expect(service.show(request())).toEqual({ shown: true, reason: 'shown' })
    expect(retainedNotificationCount(service)).toBe(1)
    service.dispose()
    expect(retainedNotificationCount(service)).toBe(0)
  })

  it('releases a failed notification and permits an immediate retry', () => {
    const createNotification = vi.fn((options: Electron.NotificationConstructorOptions) => {
      const instance = { options, once: vi.fn(), show: vi.fn() }
      notificationInstances.push(instance)
      return instance as never
    })
    const service = new NativeAlertService({
      getWindow: () => null,
      now: () => 1_000_000,
      isSupported: () => true,
      createNotification
    })

    expect(service.show(request())).toEqual({ shown: true, reason: 'shown' })
    notificationHandler(notificationInstances.at(-1), 'failed')?.()
    expect(retainedNotificationCount(service)).toBe(0)
    expect(service.show(request())).toEqual({ shown: true, reason: 'shown' })
    service.dispose()
  })

  it('releases retained notifications after the bounded timeout', () => {
    vi.useFakeTimers()
    const createNotification = vi.fn((options: Electron.NotificationConstructorOptions) => ({
      options,
      once: vi.fn(),
      show: vi.fn()
    }) as never)
    const service = new NativeAlertService({
      getWindow: () => null,
      isSupported: () => true,
      createNotification
    })

    expect(service.show(request())).toEqual({ shown: true, reason: 'shown' })
    expect(retainedNotificationCount(service)).toBe(1)
    vi.advanceTimersByTime(NATIVE_ALERT_LIMITS.maximumCooldownMs)
    expect(retainedNotificationCount(service)).toBe(0)
  })

  it('reports unsupported notifications', () => {
    const service = new NativeAlertService({
      getWindow: () => null,
      isSupported: () => false
    })
    expect(service.show(request())).toEqual({ shown: false, reason: 'unsupported' })
  })
})
