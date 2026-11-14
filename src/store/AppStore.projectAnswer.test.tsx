// A parked "one more try?" is answered by its own two buttons — always.
//
// Seen in the installed app, 2026-11-14: a build parked on that question, the
// app was restarted, and the question was then on screen THREE times (the
// Needs-you row, a banner in Details, a pop-up card). After a restart the
// driver that was waiting is gone, so Yes and No did NOTHING in all three
// places — only a third button, "Resume", worked, and then Yes had to be
// pressed again. These drive the REAL store: with no driver waiting, Yes
// starts the build again with the answer already given, and No stops it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider, useApp } from './AppStore'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'
import type { Verdict } from '../engine/types'

const h = vi.hoisted(() => ({ runNativeProject: vi.fn(), native: { on: true } }))

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
    taskId: 'T-again',
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

async function settle(n = 12) {
  await act(async () => {
    for (let i = 0; i < n; i++) await Promise.resolve()
  })
}

const find = (id: string) => getProjects().projects.find((p) => p.id === id)!

/** A build that parked on "one more try?" before the app was closed. */
function parkedProject() {
  const p = addProject('hello crew', 'greet the crew', '', '~/vault/projects/hello-crew')
  updateProject(p.id, {
    plan: ['Write hello.md', 'Rewrite hello.md'],
    stepIndex: 1,
    refinePass: 2,
    status: 'awaiting',
    lastNote: 'the file was not written',
  })
  return p.id
}

describe('a parked question, answered after a restart', () => {
  beforeEach(() => {
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
    h.runNativeProject.mockReset()
    h.runNativeProject.mockResolvedValue(verdict(true))
    h.native.on = true
  })
  afterEach(() => {
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
  })

  it('Yes runs the one more try — no second button, no second Yes', async () => {
    const id = parkedProject()
    renderApp()
    await settle()
    await act(async () => {
      captured.app!.answerProjectRequest(true, id)
    })
    await settle(40)
    expect(h.runNativeProject).toHaveBeenCalledTimes(1)
    // It ran one more pass at the step that was stuck (a refine, carrying
    // what went wrong) and — passing this time — finished the build.
    const intent = String(h.runNativeProject.mock.calls[0][0])
    expect(intent).toContain('Refine')
    expect(String(h.runNativeProject.mock.calls[0][4].refineFeedback)).toBe('the file was not written')
    expect(find(id).status).toBe('done')
    expect(find(id).stepIndex).toBe(2)
  })

  it('No stops it there: nothing runs, and the project says it needs attention', async () => {
    const id = parkedProject()
    renderApp()
    await settle()
    await act(async () => {
      captured.app!.answerProjectRequest(false, id)
    })
    await settle()
    expect(h.runNativeProject).not.toHaveBeenCalled()
    expect(find(id).status).toBe('attention')
    // What went wrong is kept — it is why the project needs attention.
    expect(find(id).lastNote).toBe('the file was not written')
  })

  // A Yes is an answer to ONE question on ONE run. Two ways it could leak,
  // both caught by review of the first version of this change:
  it('a Yes whose build could not start is not kept for a later question', async () => {
    const id = parkedProject()
    renderApp()
    await settle()
    // The build is refused before it starts (no engine to run it on)…
    h.native.on = false
    await act(async () => {
      captured.app!.answerProjectRequest(true, id)
    })
    await settle(20)
    expect(h.runNativeProject).not.toHaveBeenCalled()
    // …and later the same project is started again by hand. It is still stuck
    // on the same question, and it must ASK — the earlier Yes is spent.
    h.native.on = true
    await act(async () => {
      void captured.app!.runProject(id)
    })
    await settle(40)
    expect(h.runNativeProject).not.toHaveBeenCalled()
    expect(find(id).status).toBe('awaiting')
  })

  it('an answer for one project is never taken by another project’s waiting build', async () => {
    // A is parked with a live driver behind it; B was left waiting by a restart.
    const a = parkedProject()
    const pb = addProject('second', 'x', '', '~/vault/projects/second')
    updateProject(pb.id, { plan: ['one'], stepIndex: 0, refinePass: 2, status: 'awaiting', lastNote: 'b is stuck' })
    renderApp()
    await settle()
    await act(async () => {
      void captured.app!.runProject(a)
    })
    await settle(20)
    expect(find(a).status).toBe('awaiting')
    // "No" on B's row stops B — and says nothing to A.
    await act(async () => {
      captured.app!.answerProjectRequest(false, pb.id)
    })
    await settle(20)
    expect(find(pb.id).status).toBe('attention')
    expect(find(a).status).toBe('awaiting')
    expect(h.runNativeProject).not.toHaveBeenCalled()
    // A's own answer still reaches A.
    await act(async () => {
      captured.app!.answerProjectRequest(false, a)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400))
    })
    await settle(20)
    expect(find(a).status).toBe('attention')
  })

  it('an answer for a project that is not waiting does nothing', async () => {
    const p = addProject('other', 'x', '', '~/vault/projects/other')
    updateProject(p.id, { plan: ['a'], stepIndex: 0, status: 'planned' })
    renderApp()
    await settle()
    await act(async () => {
      captured.app!.answerProjectRequest(true, p.id)
    })
    await settle()
    expect(h.runNativeProject).not.toHaveBeenCalled()
    expect(find(p.id).status).toBe('planned')
  })
})
