// The chat send declares what it IS (2026-08-28).
//
// A Work-page message used to reach the engine with no kind information at
// all: the contract inferred "write", the judge was handed build criteria, and
// a good conversational reply scored ~0 and came back a red "failed" badge —
// 32 of them put "3% pass" on a team card. The engine's fix is a third
// contract mode; THIS is the one client line that requests it: `sendIntent`'s
// kind:'chat' path passes 'converse' as `runNativeTask`'s trailing mode arg.
// Every other caller keeps omitting it (their runs stay byte-identical), which
// nativeEngine.mode.test.ts pins from the invoke-payload side.
//
// Harness copied from AppStore.liveRuns.test.tsx (the proven native chat-path
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
    taskId: 'T-chat',
    task: 'x',
    response: 'What look do you want — minimal, bold, editorial?',
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

describe('the chat path names its turn', () => {
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

  it('sendIntent passes mode "converse" to the native run', async () => {
    let release: ((v: Verdict) => void) | null = null
    h.runNativeTask.mockImplementation(() => new Promise<Verdict>((res) => { release = res }))
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })

    let sent: Promise<void>
    await act(async () => {
      sent = captured.app!.sendIntent('Create a wordpress theme like moppers slashcreative')
      await Promise.resolve()
    })
    await act(async () => {
      release!(okVerdict())
      await sent!
    })

    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
    const args = h.runNativeTask.mock.calls[0]
    expect(args[0]).toBe('Create a wordpress theme like moppers slashcreative')
    // …intent, vault, providers, runId, route, image, tokenBudget, toolTurns,
    // then the mode — the trailing arg the engine turns into `--mode converse`.
    expect(args[8]).toBe('converse')
  })
})
