import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// W5: the REAL opt-in egress seam — `runNativeTask`/`runNativeProject`/
// `runNativeTeam` map `providers.webResearch` to the invoke `web` field, which
// the Rust bridge turns into the `--web` argv flag (pushed only when true). So
// asserting the `web` arg here is asserting "--web is sent iff web research is
// on" — the no-surprise-egress invariant. We mock the Tauri core `invoke`
// (pattern from nativeEngine.mcp.test.ts) and capture the args it receives.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { runNativeProject, runNativeTask, runNativeTeam } from './nativeEngine'
import type { EngineProviders } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

// A minimal valid RawVerdict so runNativeTask maps to a non-null verdict; the
// return value is irrelevant to this test — we assert on the invoke args.
const OK = JSON.stringify({ task_id: 't-web' })

function lastWebArg(): unknown {
  const args = invokeMock.mock.calls[invokeMock.mock.calls.length - 1][1] as Record<string, unknown>
  return args.web
}

describe('native run — web research opt-in flag (invoke `web` arg)', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(OK)
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('runNativeTask sends web=false when webResearch is off', async () => {
    await runNativeTask('do a thing', '/vault', { webResearch: false } as EngineProviders)
    expect(lastWebArg()).toBe(false)
  })

  it('runNativeTask sends web=true when webResearch is on', async () => {
    await runNativeTask('do a thing', '/vault', { webResearch: true } as EngineProviders)
    expect(lastWebArg()).toBe(true)
  })

  it('runNativeTask defaults undefined webResearch to false (?? false → no surprise egress)', async () => {
    await runNativeTask('do a thing', '/vault', {} as EngineProviders)
    expect(lastWebArg()).toBe(false)
  })

  it('runNativeProject threads web=true iff web research is on', async () => {
    await runNativeProject('step', '/proj', '/vault', { webResearch: false } as EngineProviders)
    expect(lastWebArg()).toBe(false)
    await runNativeProject('step', '/proj', '/vault', { webResearch: true } as EngineProviders)
    expect(lastWebArg()).toBe(true)
  })

  it('runNativeTeam threads web=true iff web research is on', async () => {
    await runNativeTeam('goal', '/vault', { webResearch: false } as EngineProviders, 'lead:local')
    expect(lastWebArg()).toBe(false)
    await runNativeTeam('goal', '/vault', { webResearch: true } as EngineProviders, 'lead:local')
    expect(lastWebArg()).toBe(true)
  })
})
