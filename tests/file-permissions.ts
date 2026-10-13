import { stat } from 'node:fs/promises'
import { expect } from 'vitest'

export async function expectPrivatePathMode(path: string, mode: 0o600 | 0o700): Promise<void> {
  const metadata = await stat(path)
  expect(mode === 0o700 ? metadata.isDirectory() : metadata.isFile()).toBe(true)
  // Windows uses NTFS ACLs; Node's mode only models the writable attribute there.
  // The surrounding tests still verify encryption, contents, and atomic storage.
  if (process.platform !== 'win32') expect(metadata.mode & 0o777).toBe(mode)
}
