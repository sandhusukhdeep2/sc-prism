import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Contract mode (`--mode`): `runNativeTask` maps the trailing `mode` arg to the
// invoke `mode` field, which the Rust bridge turns into the `--mode` argv flag.
// The chat path sends 'converse' — the one bit of kind information that stops a
// Work-page message from reaching the contract as an inferred WRITE task and
// being judged as a build that produced no files. Every other caller omits the
// arg, and the payload field must then be undefined — byte-identical to a run
// recorded before the parameter existed. Mocks the Tauri core `invoke` and
// captures the args it receives (same pattern as nativeEngine.route.test.ts).
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { runNativeTask } from './nativeEngine'
import type { EngineProviders } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

const OK = JSON.stringify({ task_id: 't-mode' })

function lastModeArg(): unknown {
  const args = invokeMock.mock.calls[invokeMock.mock.calls.length - 1][1] as Record<string, unknown>
  return args.mode
}

describe('native run — contract mode (invoke `mode` arg)', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(OK)
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('sends mode="converse" when the chat path declares the turn', async () => {
    await runNativeTask(
      'Create a wordpress theme like moppers slashcreative',
      '/vault',
      {} as EngineProviders,
      '',
      undefined,
      undefined,
      0,
      0,
      'converse',
    )
    expect(lastModeArg()).toBe('converse')
  })

  it('sends NO mode when the arg is omitted (back-compat, byte-identical)', async () => {
    await runNativeTask('do a thing', '/vault', {} as EngineProviders)
    expect(lastModeArg()).toBeUndefined()
  })

  it('sends NO mode for an empty string — absent, never an empty flag', async () => {
    await runNativeTask(
      'do a thing',
      '/vault',
      {} as EngineProviders,
      '',
      undefined,
      undefined,
      0,
      0,
      '' as never,
    )
    expect(lastModeArg()).toBeUndefined()
  })
})
