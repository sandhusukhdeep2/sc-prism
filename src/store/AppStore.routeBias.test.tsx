// The dependency dial actually steers sends (2026-08-29).
//
// Sukhdeep's ask, verbatim intent: "is there any drag button where we can
// increase the dependency on a online AI? Or local AI?" The dial is Settings'
// `routeBias`; the ONLY honest mechanism is the per-send route hint the
// engine already enforces (`--route local|cloud`). These tests pin the two
// halves of the contract at the send boundary:
//   - a send with no per-message choice carries the dial's position;
//   - a per-message choice outranks the dial (the person always wins).
// A dial at 'auto' is pinned byte-identical by the existing chatMode test
// (route arg stays undefined there).
//
// Harness copied from AppStore.chatMode.test.tsx (the proven native chat-path
// rig: mocked engine module, pending storeGet, real providers around a null
// child).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider, useApp } from './AppStore'
import type { Verdict } from '../engine/types'

const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
  cancelEngineRun: vi.fn(async () => {}),
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    appendChatNote: async () => {},
    readVaultFile: async () => null,
    writeVaultNote: async () => '/vault/note.md',
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    runNativeTask: h.runNativeTask,
    cancelEngineRun: h.cancelEngineRun,
  }
})

const captured: { app?: ReturnType<typeof useApp> } = {}
function Capture() {
  captured.app = useApp()
  return null
}

function renderApp() {
  return render(
    <SettingsProvider>
      <ConnectivityProvider>
        <AppProvider>
          <Capture />
        </AppProvider>
      </ConnectivityProvider>
    </SettingsProvider>,
  )
}

const okVerdict = (): Verdict =>
  ({
    taskId: 'T-dial',
    task: 'x',
    response: 'done',
    route: { target: 'local', model: 'qwen', via: '', reason: '', routeLabel: 'local · qwen' },
    tier1: { tests: '0/0', lint: true, build: true, pass: true },
    tier2: { evalScore: 0.82, passed: true, judge: 'j', trajectory: 't' },
    tokensIn: 10,
    tokensOut: 5,
    cost: 0,
    durationMs: 10,
    modelRoute: '',
    hooks: { blocked: 0, passed: true },
    writeback: { path: '', validated: true, committed: true },
    passed: true,
  }) as unknown as Verdict

async function sendAndSettle(text: string, route?: 'local' | 'cloud' | 'auto') {
  let release: ((v: Verdict) => void) | null = null
  h.runNativeTask.mockImplementation(() => new Promise<Verdict>((res) => { release = res }))
  renderApp()
  await act(async () => {
    await Promise.resolve()
  })
  let sent: Promise<void>
  await act(async () => {
    sent = captured.app!.sendIntent(text, undefined, route)
    await Promise.resolve()
  })
  await act(async () => {
    release!(okVerdict())
    await sent!
  })
}

describe('the dependency dial steers the default lane', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.cancelEngineRun.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('a send with no per-message choice carries the dial position', async () => {
    localStorage.setItem('scprism.settings', JSON.stringify({ routeBias: 'local' }))
    await sendAndSettle('summarize my week')
    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
    // …intent, vault, providers, runId, THEN the route hint.
    expect(h.runNativeTask.mock.calls[0][4]).toBe('local')
  })

  it('a per-message choice outranks the dial', async () => {
    localStorage.setItem('scprism.settings', JSON.stringify({ routeBias: 'local' }))
    await sendAndSettle('research the market', 'cloud')
    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
    expect(h.runNativeTask.mock.calls[0][4]).toBe('cloud')
  })
})
