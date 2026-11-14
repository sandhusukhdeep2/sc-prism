// A MESSAGE'S ID IS ITS OWN, ACROSS RESTARTS (2026-11-15).
//
// Seen in the installed app: the Manager's room showed one old answer with two
// more answers appended to it — "Yes — … ready when you are." and "Yes — … the
// hello-crew project is done" — which had been given in ANOTHER room, on
// later days.
//
// Message ids were `m1`, `m2`, … counted from zero by every app session, while
// the threads they sit in are saved and restored. So after a restart a new
// reply was handed an id an old message already had — and every id-scoped
// update (append a line to the answer, set its model, remove the thinking
// bubble) is applied to every thread that holds that id. A new answer was
// written into an old bubble; a removed bubble could take an old message
// with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider, useApp } from './AppStore'
import type { Verdict } from '../engine/types'

const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    appendChatNote: async () => {},
    appendVaultNote: async () => '/vault/conversations/x.md',
    readVaultFile: async () => null,
    writeVaultNote: async () => '/vault/note.md',
    readSpansTail: async () => [],
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    runNativeTask: h.runNativeTask,
    cancelEngineRun: async () => {},
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

async function settle(n = 40) {
  await act(async () => {
    for (let i = 0; i < n; i++) await Promise.resolve()
  })
}

const answer = (response: string): Verdict =>
  ({
    taskId: 'T-1',
    task: 'x',
    response,
    route: { target: 'cloud', model: 'm', via: '', reason: '', routeLabel: 'cloud · m' },
    tier1: { tests: 'skipped', lint: false, build: false, pass: true, skipped: true },
    tier2: { evalScore: 0, passed: true, judge: 'j', trajectory: 't' },
    tokensIn: 1,
    tokensOut: 1,
    cost: 0,
    durationMs: 1,
    modelRoute: '',
    hooks: { blocked: 0, passed: true },
    writeback: { path: '', validated: true, committed: true },
    passed: true,
  }) as unknown as Verdict

const thread = () => captured.app!.state.threads['universal'] ?? []
const texts = () => thread().map((m) => ('text' in m ? `${m.kind}: ${m.text}` : m.kind))

describe('message ids across an app restart', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({
        providers: [
          { id: 'claude-cli', name: 'Claude', baseUrl: '', apiKey: '', enabled: true, primary: true, connected: true },
        ],
      }),
    )
    h.runNativeTask.mockReset()
  })
  afterEach(() => localStorage.clear())

  it('an answer given after a restart is its own bubble — it is not written into an old one', async () => {
    // Session one: a question and its answer.
    h.runNativeTask.mockResolvedValueOnce(answer('FIRST ANSWER'))
    const first = renderApp()
    await settle()
    await act(async () => {
      void captured.app!.send('hello there')
    })
    await settle()
    expect(texts()).toContain('assistant: FIRST ANSWER')
    const before = thread().length
    first.unmount()

    // Session two: the app is opened again. The saved thread is restored, and
    // the id counter starts from zero — exactly what a restart does.
    h.runNativeTask.mockResolvedValueOnce(answer('SECOND ANSWER'))
    renderApp()
    await settle()
    expect(texts()).toContain('assistant: FIRST ANSWER')
    await act(async () => {
      void captured.app!.send('hello again')
    })
    await settle()

    // The old answer is exactly as it was…
    expect(texts()).toContain('assistant: FIRST ANSWER')
    expect(texts().some((t) => t.includes('FIRST ANSWER') && t.includes('SECOND ANSWER'))).toBe(false)
    // …the new one is a bubble of its own…
    expect(texts()).toContain('assistant: SECOND ANSWER')
    expect(thread().length).toBe(before + 2)
    // …and no two messages in the room share an id.
    const ids = thread().map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
