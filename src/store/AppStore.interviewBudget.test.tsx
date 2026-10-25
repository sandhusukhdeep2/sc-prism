// The reported failure, end to end (2026-08-16).
//
// The user created a project ("node cli") and the interview ran, against his
// real machine and his real spans:
//
//   opus  · cloud · 27.0s
//   opus  · cloud · 27.2s
//   vault · vault_read · log.md          ← the egress floor now applies
//   Qwen3.8-27B-4bit · LOCAL · 64.8s
//   Qwen3.8-27B-4bit · LOCAL · 67.5s
//   ≈ 187s total, every call ANSWERING
//
// against a flat 90s client wall. We killed it at 90s, the project stayed at
// status `new`, and he was told "no real reply — timed out or the AI could not
// be reached" and "Couldn't reach the AI just now". Both false: we cancelled a
// healthy run. The vault read is exactly why the tail was local — the egress
// floor (loop.VAULT_LOCAL_REASON, 12ba45c) pins the remainder of a vault-reading
// run to the local model, which is the privacy guarantee and stays untouched.
//
// These two tests are the regression: the SAME run now completes, and a run
// that genuinely stops progressing is still cut — with words that name our own
// cancellation instead of blaming the provider.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider, useApp } from './AppStore'
import { addProject, getProjects, removeProject } from '../lib/projects'
import type { EngineSpan } from '../lib/nativeEngine'

const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
  cancelEngineRun: vi.fn(async () => {}),
  spans: [] as EngineSpan[],
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    expandUserPath: async (p: string) => p.replace(/^~/, '/Users/test'),
    appendChatNote: async () => {},
    appendVaultNote: async () => '/vault/x.md',
    readVaultFile: async () => null,
    writeVaultNote: async () => '/vault/note.md',
    // The real bridge tails <vault>/spans.jsonl; this is that tail.
    readSpansTail: async (_v: string, maxLines = 60) => h.spans.slice(-maxLines),
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

let spanClock = 1_000
function modelCall(route: 'local' | 'cloud', model: string, ms: number): EngineSpan {
  spanClock += 1
  return {
    name: 'model_call',
    type: 'model_call',
    status: 'ok',
    duration_ms: ms,
    start: spanClock,
    attrs: { route, model, is_local: route === 'local' },
  }
}

/** His recorded history: the local model really does cost ~65s a call here. */
function seedHistory() {
  h.spans.length = 0
  h.spans.push(
    modelCall('cloud', 'opus', 27_000),
    modelCall('cloud', 'opus', 27_200),
    modelCall('local', 'Qwen3.8-27B-4bit', 64_800),
    modelCall('local', 'Qwen3.8-27B-4bit', 67_500),
  )
}

const finished = () => captured.app!.state.finishedRuns

async function startInterview() {
  const project = addProject('node cli', 'a small node cli', 'npm test')
  renderApp()
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    captured.app!.setActiveProject(project.id)
  })
  return project
}

describe('the interview budget pays for what the run really costs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    for (const p of getProjects().projects) removeProject(p.id)
    h.runNativeTask.mockReset()
    h.cancelEngineRun.mockClear()
    seedHistory()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    for (const p of getProjects().projects) removeProject(p.id)
  })

  it('the 187s run that was killed at 90s now COMPLETES — every step progressed', async () => {
    h.runNativeTask.mockImplementation(
      () =>
        new Promise((resolve) => {
          // Exactly the shape of the reported run. Each span appears when that
          // call CLOSES — which is the app's proof the engine is still alive.
          setTimeout(() => h.spans.push(modelCall('cloud', 'opus', 27_000)), 27_000)
          setTimeout(() => h.spans.push(modelCall('cloud', 'opus', 27_200)), 54_200)
          setTimeout(() => h.spans.push(modelCall('local', 'Qwen3.8-27B-4bit', 64_800)), 119_000)
          setTimeout(() => {
            h.spans.push(modelCall('local', 'Qwen3.8-27B-4bit', 67_500))
            resolve({ response: 'Who is this CLI for?' })
          }, 187_000)
        }),
    )
    await startInterview()

    let sent: Promise<void>
    await act(async () => {
      sent = captured.app!.send('hello')
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000)
      await sent!
    })

    expect(h.cancelEngineRun).not.toHaveBeenCalled()
    expect(finished()[0]).toMatchObject({ kind: 'project', outcome: 'passed' })
    // And it really became an interview, not a dead-end at status `new`.
    expect(getProjects().projects[0].status).toBe('interviewing')
  })

  it('a run that stops progressing is STILL cut — and the row blames us, not the provider', async () => {
    h.runNativeTask.mockImplementation(() => new Promise(() => {})) // nothing ever closes
    await startInterview()

    let sent: Promise<void>
    await act(async () => {
      sent = captured.app!.send('hello')
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400_000)
      await sent!
    })

    expect(h.cancelEngineRun).toHaveBeenCalledTimes(1)
    const row = finished()[0]
    expect(row.outcome).toBe('stopped')
    expect(row.detail).toMatch(/^we stopped it at \d+s/)
    expect(row.detail).toContain('our cancellation, not a provider failure')
    expect(row.detail).not.toMatch(/could not be reached/)
  })
})
