import { describe, expect, it } from 'vitest'
import { parseNativeAlertRequest } from '../src/main/native-alert-ipc'

describe('native alert IPC validation', () => {
  it('accepts a bounded known alert', () => {
    expect(parseNativeAlertRequest({
      title: 'Опасный контакт',
      body: 'Pilot One замечен в Local',
      kind: 'watchlist',
      workspace: 'watchlist',
      dedupeKey: 'local:123',
      cooldownMs: 60_000,
      silent: true
    })).toEqual({
      title: 'Опасный контакт',
      body: 'Pilot One замечен в Local',
      kind: 'watchlist',
      workspace: 'watchlist',
      dedupeKey: 'local:123',
      cooldownMs: 60_000,
      silent: true
    })
  })

  it('normalizes whitespace and rejects unknown fields', () => {
    expect(parseNativeAlertRequest({
      title: '  Проверка  звука ',
      body: ' Fly   Safe ',
      kind: 'info',
      workspace: 'intel'
    })).toMatchObject({ title: 'Проверка звука', body: 'Fly Safe' })

    expect(() => parseNativeAlertRequest({
      title: 'Test',
      body: 'Body',
      kind: 'info',
      workspace: 'intel',
      url: 'https://example.com'
    })).toThrow(/unknown fields/)
  })

  it('rejects invalid kinds, workspaces and cooldowns', () => {
    expect(() => parseNativeAlertRequest({
      title: 'Test', body: 'Body', kind: 'shell', workspace: 'intel'
    })).toThrow(/type/)
    expect(() => parseNativeAlertRequest({
      title: 'Test', body: 'Body', kind: 'info', workspace: 'external'
    })).toThrow(/workspace/)
    expect(() => parseNativeAlertRequest({
      title: 'Test', body: 'Body', kind: 'info', workspace: 'intel', cooldownMs: 100
    })).toThrow(/Alert cooldown/)
  })
})
