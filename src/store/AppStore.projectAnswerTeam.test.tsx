// "ONE MORE TRY?" IS RUN BY THE TEAM AS IT IS SET NOW (2026-11-15).
//
// Seen in the installed app: a build failed twice with its writing seat on a
// local model, and parked on "give it one more shot?". The project's team was
// changed in Details — both seats moved to another AI — and Yes was pressed.
// The retry ran on the OLD team: the engine was launched with the seats the
// build had been staffed with before it parked.
//
// A build's team is settled once, when the run starts, so that an edit made
// while a step is running cannot change the seats under it. But a build that
// is waiting on its owner is not running anything, and changing the team is
// the most natural answer to the question it is asking. The Yes is handed to a
// new run, which staffs from what is set now — through the same gates as any
// start — and the room says so.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider, useApp } from './AppStore'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'
import type { Verdict } from '../engine/types'

const h = vi.hoisted(() => ({ runNativeProject: vi.fn() }))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    expandUserPath: async (p: string) => p.replace(/^~/, '/Users/test'),
    appendChatNote: async () => {},
    appendVaultNote: async () => '/vault/conversations/x.md',
    readVaultFile: async () => null,
    writeVaultNote: async () => '/vault/note.md',
    readSpansTail: async () => [],
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    runNativeProject: h.runNativeProject,
    runNativeProjectFinish: async () => ({ ok: true, detail: '' }),
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

const verdict = (passed: boolean): Verdict =>
  ({
    taskId: 'T-team',
    task: 'x',
    response: passed ? 'Wrote hello.md.' : '',
    route: { target: 'cloud', model: 'm', via: '', reason: '', routeLabel: 'cloud · m' },
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

async function settle(n = 20) {
  await act(async () => {
    for (let i = 0; i < n; i++) await Promise.resolve()
  })
}

/** The driver polls for the answer on a timer; give it real time to see one. */
async function answered() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 450))
  })
  await settle(40)
}

const find = (id: string) => getProjects().projects.find((p) => p.id === id)!
const room = (id: string) =>
  (captured.app!.state.threads[id] ?? []).map((m) => ('text' in m ? `${m.kind}: ${m.text}` : m.kind))

const LOCAL_WRITER = 'implementer:local,planner:claude-cli'
const CLOUD_WRITER = 'implementer:claude-cli,planner:claude-cli'

function clean() {
  for (const p of getProjects().projects) removeProject(p.id)
  localStorage.clear()
}

/** A build stuck on its only step, its question open, with a driver waiting on the answer. */
async function parkedWithADriver() {
  localStorage.setItem(
    'scprism.settings',
    JSON.stringify({
      providers: [
        { id: 'claude-cli', name: 'Claude', baseUrl: '', apiKey: '', enabled: true, primary: true, connected: true },
        { id: 'local', name: 'Local model', baseUrl: 'http://localhost:1234', apiKey: '', enabled: true, primary: false, connected: true },
      ],
      projectWrites: true,
    }),
  )
  const p = addProject('hello crew', 'greet the crew', '', '~/vault/projects/hello-crew')
  updateProject(p.id, {
    plan: ['Write hello.md'],
    stepIndex: 0,
    refinePass: 2,
    status: 'awaiting',
    lastNote: 'the file was not written',
    roster: LOCAL_WRITER,
  })
  renderApp()
  await settle()
  await act(async () => {
    void captured.app!.runProject(p.id)
  })
  await settle(30)
  expect(find(p.id).status).toBe('awaiting')
  expect(h.runNativeProject).not.toHaveBeenCalled()
  return p.id
}

describe('a parked question, answered after the team was changed', () => {
  beforeEach(() => {
    clean()
    h.runNativeProject.mockReset()
    h.runNativeProject.mockResolvedValue(verdict(true))
  })
  afterEach(clean)

  it('the one more try runs on the team that is set now', async () => {
    const id = await parkedWithADriver()
    updateProject(id, { roster: CLOUD_WRITER })
    await act(async () => {
      captured.app!.answerProjectRequest(true, id)
    })
    await answered()

    expect(h.runNativeProject).toHaveBeenCalledTimes(1)
    const [intent, , , , opts] = h.runNativeProject.mock.calls[0]
    expect(opts.roster).toBe(CLOUD_WRITER)
    // It is still the retry that was asked for: one more pass at the same step.
    expect(String(intent)).toContain('Refine')
    expect(opts.refineFeedback).toBe('the file was not written')
    expect(find(id).status).toBe('done')
  })

  it('the room is told the retry is on the new team', async () => {
    const id = await parkedWithADriver()
    updateProject(id, { roster: CLOUD_WRITER })
    await act(async () => {
      captured.app!.answerProjectRequest(true, id)
    })
    await answered()
    expect(room(id)).toContain(
      'notice: The team was changed while this build waited — the one more try runs on the team set now.',
    )
  })

  it('the Yes is not asked for a second time', async () => {
    const id = await parkedWithADriver()
    updateProject(id, { roster: CLOUD_WRITER })
    await act(async () => {
      captured.app!.answerProjectRequest(true, id)
    })
    await answered()
    // One Yes, one retry: the build did not park on the same question again.
    expect(find(id).status).not.toBe('awaiting')
    expect(h.runNativeProject).toHaveBeenCalledTimes(1)
  })

  it('with the team left alone, the retry runs on it and nothing is said', async () => {
    const id = await parkedWithADriver()
    await act(async () => {
      captured.app!.answerProjectRequest(true, id)
    })
    await answered()
    expect(h.runNativeProject).toHaveBeenCalledTimes(1)
    expect(h.runNativeProject.mock.calls[0][4].roster).toBe(LOCAL_WRITER)
    expect(room(id).some((l) => l.includes('team was changed'))).toBe(false)
  })

  it('a No is a No, whatever was changed', async () => {
    const id = await parkedWithADriver()
    updateProject(id, { roster: CLOUD_WRITER })
    await act(async () => {
      captured.app!.answerProjectRequest(false, id)
    })
    await answered()
    expect(h.runNativeProject).not.toHaveBeenCalled()
    expect(find(id).status).toBe('attention')
  })
})
