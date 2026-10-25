// Mission-control adversarial audit (2026-08-06) — every REAL engine run the
// app starts must be visible as a live run, and no live run may claim to be
// executing when it isn't.
//
//   H1  a project build parked on "one more refine?" keeps its card, but the
//       card is PARKED: the subprocess has exited and nothing is running.
//   H6  an interview turn that timed out (or was stubbed) must not report the
//       green "passed" row it used to — the row came from "was it ALLOWED to
//       run", not from whether a real reply came back.
//   M1  four real engine runners registered nothing at all, so the Work page
//       said "last run" while a run was genuinely live: the loop driver's
//       per-step run, a standing 'task' schedule, a standing 'test' schedule
//       and the auto-compaction summariser. Each gets an HONEST kind — a
//       scheduled task or check is not a 'chat'.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider, UNIVERSAL, useApp } from './AppStore'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'
import { addSchedule, getSchedules, removeSchedule } from '../lib/schedules'
import type { Verdict } from '../engine/types'

const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
  runNativeProject: vi.fn(),
  runNativeVerify: vi.fn(),
  cancelEngineRun: vi.fn(async () => {}),
  appendVaultNote: vi.fn(async () => '/vault/conversations/x.md'),
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    expandUserPath: async (p: string) => p.replace(/^~/, '/Users/test'),
    appendChatNote: async () => {},
    appendVaultNote: h.appendVaultNote,
    readVaultFile: async () => null,
    writeVaultNote: async () => '/vault/note.md',
    readSpansTail: async () => [],
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    runNativeTask: h.runNativeTask,
    runNativeProject: h.runNativeProject,
    runNativeVerify: h.runNativeVerify,
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

const live = () => captured.app!.state.liveRuns
const finished = () => captured.app!.state.finishedRuns

const verdict = (passed: boolean): Verdict =>
  ({
    taskId: 'T-1',
    task: 'x',
    response: passed ? 'a real answer' : '',
    route: { target: 'local', model: 'qwen', via: '', reason: '', routeLabel: 'local · qwen' },
    tier1: { tests: '1/1', lint: true, build: true, pass: passed },
    tier2: { evalScore: 0.9, passed, judge: 'j', trajectory: 't' },
    tokensIn: 1,
    tokensOut: 1,
    cost: 0,
    durationMs: 1,
    modelRoute: '',
    hooks: { blocked: 0, passed: true },
    writeback: { path: '', validated: true, committed: true },
    passed,
  }) as unknown as Verdict

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function cleanStores() {
  for (const p of getProjects().projects) removeProject(p.id)
  for (const s of getSchedules()) removeSchedule(s.id)
  localStorage.clear()
}

describe('H1 — a build PARKED on the human answer stops claiming to run', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    cleanStores()
    h.runNativeProject.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanStores()
  })

  it('marks the live run paused while it waits, and unpauses on the answer', async () => {
    // A project resumed straight into the parked ask (status 'awaiting'), with
    // its refines already exhausted — the exact state the driver parks in.
    const project = addProject('Dashboard', 'ship it', 'npm test')
    updateProject(project.id, { status: 'awaiting', plan: ['step one'], refinePass: 2 })
    renderApp()
    await settle()

    let run: Promise<void>
    await act(async () => {
      run = captured.app!.runProject(project.id)
      await Promise.resolve()
    })
    await settle()

    // Registered — and PARKED: no engine is executing behind this card.
    expect(live()).toHaveLength(1)
    expect(live()[0].kind).toBe('project')
    expect(live()[0].paused).toBe(true)
    // The engine was never called for the park itself.
    expect(h.runNativeProject).not.toHaveBeenCalled()

    // Declining ends the build; the card clears through the same `finally`.
    await act(async () => {
      captured.app!.answerProjectRequest(false)
      await vi.advanceTimersByTimeAsync(500)
      await run!
    })
    expect(live()).toHaveLength(0)
    expect(finished()[0]).toMatchObject({ kind: 'project', outcome: 'failed' })
  })
})

describe('H6 — an interview turn reports what really came back', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    cleanStores()
    h.runNativeTask.mockReset()
    h.cancelEngineRun.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanStores()
  })

  /** Bind a plan-less project so `send()` routes to the interview pipeline. */
  async function interviewing() {
    const project = addProject('Dashboard', 'ship it', 'npm test')
    renderApp()
    await settle()
    await act(async () => {
      captured.app!.setActiveProject(project.id)
    })
    return project
  }

  it('a CANCELLED interview turn is not a pass, and names OUR cancellation', async () => {
    h.runNativeTask.mockImplementation(() => new Promise(() => {})) // never settles
    await interviewing()

    let sent: Promise<void>
    await act(async () => {
      sent = captured.app!.send('hello')
      await Promise.resolve()
    })
    expect(live()).toHaveLength(1)
    expect(live()[0].kind).toBe('project')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
      await sent!
    })

    expect(live()).toHaveLength(0)
    expect(finished()[0].outcome).not.toBe('passed')
    expect(finished()[0].outcome).toBe('stopped')
    // FIX 2 (2026-08-16). This row used to read "no real reply — timed out or
    // the AI could not be reached" for a run in which the AI answered every
    // call and WE pulled the plug. It must now say so, and must never claim
    // the provider was unreachable.
    expect(finished()[0].detail).toMatch(/^we stopped it at 90s/)
    expect(finished()[0].detail).toContain('our cancellation, not a provider failure')
    expect(finished()[0].detail).not.toMatch(/could not be reached/)
    // H5 (interview half): the timeout really killed the engine child, so its
    // spans can't drain into whatever run registers next.
    expect(h.cancelEngineRun).toHaveBeenCalledTimes(1)
  })

  it('a genuinely UNREACHABLE provider still says unreachable — nothing came back', async () => {
    h.runNativeTask.mockResolvedValue(null)
    await interviewing()
    await act(async () => {
      await captured.app!.send('hello')
    })
    expect(finished()[0].outcome).toBe('failed')
    expect(finished()[0].detail).toContain('could not be reached')
    expect(finished()[0].detail).not.toMatch(/we stopped it/)
    // We never cancelled anything here, so nothing was killed.
    expect(h.cancelEngineRun).not.toHaveBeenCalled()
  })

  it('a STUB still says stub — a placeholder, not a cancellation and not an outage', async () => {
    h.runNativeTask.mockResolvedValue({ response: '[offline:local:local-model] handled: nothing to call' })
    await interviewing()
    await act(async () => {
      await captured.app!.send('hello')
    })
    expect(finished()[0].outcome).toBe('failed')
    expect(finished()[0].detail).toContain('placeholder reply')
    expect(finished()[0].detail).not.toMatch(/we stopped it|could not be reached/)
  })

  it('a blank (non-real) reply is not a pass either', async () => {
    h.runNativeTask.mockResolvedValue({ response: '' })
    await interviewing()
    await act(async () => {
      await captured.app!.send('hello')
    })
    expect(finished()[0].outcome).not.toBe('passed')
  })

  it('a REAL reply still passes (the honest green)', async () => {
    h.runNativeTask.mockResolvedValue({ response: 'What is the audience for this?' })
    await interviewing()
    await act(async () => {
      await captured.app!.send('hello')
    })
    expect(finished()[0]).toMatchObject({ kind: 'project', outcome: 'passed' })
  })
})

describe('M1 — every real engine runner registers a live run', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    cleanStores()
    h.runNativeTask.mockReset()
    h.runNativeVerify.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanStores()
  })

  it('the auto-compaction summariser registers as a "compaction" run', async () => {
    h.runNativeTask.mockImplementation(() => new Promise(() => {}))
    // A thread long enough that there is something to compact.
    localStorage.setItem(
      'scprism.session',
      JSON.stringify({
        threads: {
          [UNIVERSAL]: Array.from({ length: 14 }, (_, i) => ({
            id: `m${i}`,
            kind: i % 2 === 0 ? 'user' : 'assistant',
            text: `turn ${i} — something worth summarising`,
          })),
        },
        verdicts: [],
        stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      }),
    )
    renderApp()
    await settle()

    await act(async () => {
      void captured.app!.compressNow()
      await Promise.resolve()
    })
    await settle()

    expect(live()).toHaveLength(1)
    expect(live()[0].kind).toBe('compaction')
  })

  it('a standing TASK schedule registers as a "task" run and clears with its outcome', async () => {
    h.runNativeTask.mockResolvedValue(verdict(true))
    addSchedule('summarise yesterday', 1, '')
    renderApp()
    await settle()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    await settle()

    expect(live()).toHaveLength(0) // it finished within the tick
    expect(finished()[0]).toMatchObject({ kind: 'task', outcome: 'passed' })
    expect(finished()[0].intent).toBe('summarise yesterday')
  })

  it('a standing TEST schedule registers as a "test" run, with the real pass/fail', async () => {
    h.runNativeVerify.mockResolvedValue({ passed: false })
    const project = addProject('Dashboard', 'ship it', 'npm test')
    updateProject(project.id, { status: 'planned' })
    addSchedule('nightly checks', 1, '', project.id, 'test')
    renderApp()
    await settle()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    await settle()

    expect(h.runNativeVerify).toHaveBeenCalled()
    expect(finished()[0]).toMatchObject({ kind: 'test', outcome: 'failed' })
    expect(finished()[0].intent).toMatch(/npm test/)
  })
})
