import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Per-message route hint (composer local/cloud/auto): `runNativeTask` maps the
// 5th `route` arg to the invoke `route` field, which the Rust bridge turns into
// the `--route` argv flag (pushed only for local/cloud). Asserting the `route`
// invoke arg here proves the no-surprise-override invariant: an override is sent
// ONLY when the user explicitly picked local/cloud; auto/omitted send nothing
// (byte-identical to a run with no hint). Mocks the Tauri core `invoke` and
// captures the args it receives (same pattern as nativeEngine.web.test.ts).
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { runNativeTask } from './nativeEngine'
import type { EngineProviders } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

const OK = JSON.stringify({ task_id: 't-route' })

function lastRouteArg(): unknown {
  const args = invokeMock.mock.calls[invokeMock.mock.calls.length - 1][1] as Record<string, unknown>
  return args.route
}

describe('native run — per-message route hint (invoke `route` arg)', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(OK)
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('sends route="local" when the user chose local', async () => {
    await runNativeTask('do a thing', '/vault', {} as EngineProviders, '', 'local')
    expect(lastRouteArg()).toBe('local')
  })

  it('sends route="cloud" when the user chose cloud', async () => {
    await runNativeTask('do a thing', '/vault', {} as EngineProviders, '', 'cloud')
    expect(lastRouteArg()).toBe('cloud')
  })

  it('sends NO route override for auto (→ undefined, byte-identical)', async () => {
    await runNativeTask('do a thing', '/vault', {} as EngineProviders, '', 'auto')
    expect(lastRouteArg()).toBeUndefined()
  })

  it('sends NO route override when the arg is omitted (back-compat)', async () => {
    await runNativeTask('do a thing', '/vault', {} as EngineProviders)
    expect(lastRouteArg()).toBeUndefined()
  })
})
