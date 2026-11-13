// A job typed in a project's room is done in that project's folder (2026-11-11).
//
// Found by sending a real one: "Rewrite hello.md as a warmer greeting" went to
// a board that had never been shown the folder, and nothing on disk changed.
// These drive the REAL store: the job becomes the project's next step, the
// governed build runs it in the folder, and a refusal leaves the plan alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider, useApp } from './AppStore'
import { addProject, attachProject, getProjects, removeProject, updateProject } from '../lib/projects'
import type { Verdict } from '../engine/types'

const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
  runNativeTeam: vi.fn(),
  runNativeProject: vi.fn(),
  native: { on: true },
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => h.native.on,
    resolveVaultDir: async () => '/vault',
    expandUserPath: async (p: string) => p.replace(/^~/, '/Users/test'),
    appendChatNote: async () => {},
    appendVaultNote: async () => '/vault/conversations/x.md',
    readVaultFile: async () => null,
    writeVaultNote: async () => '/vault/note.md',
    readSpansTail: async () => [],
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    runNativeTask: h.runNativeTask,
    runNativeTeam: h.runNativeTeam,
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
    taskId: 'T-job',
    task: 'x',
    response: passed ? 'Rewrote hello.md.' : '',
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
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

function clean() {
  for (const p of getProjects().projects) removeProject(p.id)
  localStorage.clear()
}

const find = (id: string) => getProjects().projects.find((p) => p.id === id)!
/** The room's lines as plain `{kind, text}` — a verdict card has no text. */
const thread = (id: string) =>
  (captured.app!.state.threads[id] ?? []).map((m) => ({
    kind: m.kind,
    text: 'text' in m ? m.text : '',
  }))

function finishedProject() {
  const p = addProject('hello crew', 'greet the crew', '', '~/vault/projects/hello-crew')
  updateProject(p.id, { plan: ['Write hello.md'], stepIndex: 1, status: 'done' })
  return p.id
}

async function sendJob(id: string, text: string) {
  await act(async () => {
    captured.app!.setActiveProject(id)
  })
  await act(async () => {
    await captured.app!.sendProjectJob({ text, display: `→ folder: ${text}` })
  })
  await settle()
}

describe('a job for the folder — through the real store', () => {
  beforeEach(() => {
    clean()
    h.native.on = true
    h.runNativeProject.mockReset()
    h.runNativeProject.mockResolvedValue(verdict(true))
  })
  afterEach(clean)

  it('becomes the next step and the build runs it in the folder', async () => {
    const id = finishedProject()
    renderApp()
    await settle()
    await sendJob(id, 'Rewrite hello.md as a warmer greeting')

    expect(h.runNativeProject).toHaveBeenCalledTimes(1)
    const [intent, dir, , , opts] = h.runNativeProject.mock.calls[0]
    expect(intent).toBe('Project goal: greet the crew\nStep 2 of 2: Rewrite hello.md as a warmer greeting')
    expect(dir).toBe('/Users/test/vault/projects/hello-crew')
    // A job about the folder is shown the folder; it does not wipe the build's memory.
    expect(opts.showFolder).toBe(true)
    expect(opts.workingReset).toBe(false)

    const p = find(id)
    expect(p.plan).toEqual(['Write hello.md', 'Rewrite hello.md as a warmer greeting'])
    expect(p.status).toBe('done')
    expect(p.stepIndex).toBe(2)
    expect(p.verdictIds).toContain('T-job')
  })

  // Found in the real app, 2026-11-14: this exact job ran its board three
  // times and changed nothing — "all file writes rejected: planner was not
  // granted the 'writes' capability". The engine lets the FIRST seat write;
  // the built-in team led with the Planner and no seat was asked for writes.
  it('on the built-in team, the seat that does the work leads and is asked for writes', async () => {
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
    const id = finishedProject()
    renderApp()
    await settle()
    await sendJob(id, 'Rewrite hello.md as a warmer greeting')

    expect(h.runNativeProject).toHaveBeenCalledTimes(1)
    const [, , , providers, opts] = h.runNativeProject.mock.calls[0]
    const seats = String(opts.roster).split(',').map((s: string) => s.split(':')[0])
    expect(seats.length).toBeGreaterThan(1)
    expect(seats[0]).toBe('implementer')
    const asked = JSON.parse(providers.agentCapabilities) as Record<string, string[]>
    expect(asked.implementer).toContain('writes')
    // Only the writer was asked for it, and the user's own grant rides along
    // for the engine to intersect.
    expect(Object.entries(asked).filter(([, caps]) => caps.includes('writes')).map(([n]) => n)).toEqual(['implementer'])
    expect(String(providers.userCapabilities).split(',')).toContain('writes')
  })

  it('says in the room what was sent and what became of it', async () => {
    const id = finishedProject()
    renderApp()
    await settle()
    await sendJob(id, 'Rewrite hello.md as a warmer greeting')
    const lines = thread(id).map((m) => `${m.kind}: ${m.text}`)
    expect(lines).toContain('user: → folder: Rewrite hello.md as a warmer greeting')
    expect(lines).toContain('notice: Step 2 of 2 — your team is working in ~/vault/projects/hello-crew now.')
  })

  it('an opened folder takes its first job with no interview', async () => {
    const p = attachProject('site', '/Users/someone/site', '', '')
    renderApp()
    await settle()
    await sendJob(p.id, 'Fix the footer link')
    expect(h.runNativeProject).toHaveBeenCalledTimes(1)
    const [intent, dir, , , opts] = h.runNativeProject.mock.calls[0]
    expect(intent).toBe('Step 1 of 1: Fix the footer link')
    expect(dir).toBe('/Users/someone/site')
    expect(opts.existingMode).toBe(true)
    expect(opts.showFolder).toBe(true)
  })

  it('a build that cannot start is refused BEFORE the plan is touched', async () => {
    const id = finishedProject()
    renderApp()
    await settle()
    h.native.on = false
    await sendJob(id, 'Rewrite hello.md')
    expect(h.runNativeProject).not.toHaveBeenCalled()
    expect(find(id).plan).toEqual(['Write hello.md'])
    expect(find(id).status).toBe('done')
    expect(thread(id).map((m) => m.text)).toContain(
      'Not sent to the folder — «hello crew» needs the installed app to run.',
    )
  })

  it('a project whose step needs attention keeps its plan', async () => {
    const id = finishedProject()
    updateProject(id, { status: 'attention', stepIndex: 0 })
    renderApp()
    await settle()
    await sendJob(id, 'Rewrite hello.md')
    expect(h.runNativeProject).not.toHaveBeenCalled()
    expect(find(id).plan).toEqual(['Write hello.md'])
    expect(thread(id).some((m) => /needs attention first/.test(m.text))).toBe(true)
  })
})

describe('a team asked from a project’s room is told which project', () => {
  beforeEach(() => {
    clean()
    h.native.on = true
    h.runNativeTeam.mockReset()
    h.runNativeTeam.mockResolvedValue({
      run_id: 'r1',
      board: [],
      synthesis: 'hello.md greets the crew',
      board_path: '',
      tokens: 10,
      passed: true,
      overBudget: false,
      tokenBudget: 100000,
      reason: '',
      taskId: 'r1',
      spansPath: '',
      verdictPath: '',
    })
  })
  afterEach(clean)

  it('the board is handed the folder, read-only', async () => {
    const id = finishedProject()
    renderApp()
    await settle()
    await act(async () => {
      captured.app!.setActiveProject(id)
    })
    await act(async () => {
      await captured.app!.sendTeam({ task: 'What does hello.md say?' })
    })
    await settle()
    expect(h.runNativeTeam).toHaveBeenCalledTimes(1)
    const providers = h.runNativeTeam.mock.calls[0][2]
    expect(providers.projectDir).toBe('~/vault/projects/hello-crew')
    expect(providers.context).toContain('You are working on the project "hello crew"')
  })

  it('outside a project there is no folder to hand over', async () => {
    renderApp()
    await settle()
    await act(async () => {
      await captured.app!.sendTeam({ task: 'What is new?' })
    })
    await settle()
    expect(h.runNativeTeam.mock.calls[0][2].projectDir).toBe('')
  })
})
