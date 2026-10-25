import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Image attach: `runNativeTask`'s 6th `image` arg maps to the invoke `image`
// field (the picked file PATH), which the Rust bridge turns into `--image
// <path>`. Asserting the `image` invoke arg proves the byte-identical invariant:
// the field is present ONLY when an image is attached; omitted → undefined, so
// the Rust bridge pushes no `--image` flag and the run is a plain text-only run.
// `readImageBase64` returns the data URI on success, null on failure. Mocks the
// Tauri core `invoke` (same pattern as nativeEngine.route.test.ts).
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { readImageBase64, runNativeTask } from './nativeEngine'
import type { EngineProviders } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

const OK = JSON.stringify({ task_id: 't-img' })

function lastArgs(): Record<string, unknown> {
  return invokeMock.mock.calls[invokeMock.mock.calls.length - 1][1] as Record<string, unknown>
}

describe('native run — image attach (invoke `image` arg)', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(OK)
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('forwards the picked image PATH as the invoke `image` field', async () => {
    await runNativeTask('what is this', '/vault', {} as EngineProviders, '', 'auto', {
      path: '/Users/me/shot.png',
      name: 'shot.png',
    })
    expect(lastArgs().image).toBe('/Users/me/shot.png')
  })

  it('sends NO image when the arg is omitted (byte-identical text path)', async () => {
    await runNativeTask('hello', '/vault', {} as EngineProviders)
    expect(lastArgs().image).toBeUndefined()
  })

  it('readImageBase64 returns the data URI the bridge produced', async () => {
    invokeMock.mockResolvedValueOnce('data:image/png;base64,QUJD')
    const uri = await readImageBase64('/Users/me/shot.png')
    expect(uri).toBe('data:image/png;base64,QUJD')
    const args = invokeMock.mock.calls[0][1] as Record<string, unknown>
    expect(args.path).toBe('/Users/me/shot.png')
  })

  it('readImageBase64 returns null on an honest bridge failure', async () => {
    invokeMock.mockRejectedValueOnce(new Error('image too large'))
    expect(await readImageBase64('/Users/me/huge.png')).toBeNull()
  })
})
