// STOP (2026-11-14). A team run can take five minutes and a build much longer,
// and the room had no way to stop either. Stop is a real stop: the engine's
// own subprocess is cancelled, the run ends as "stopped by you" — not as a
// failure — and a build is left needing attention at the step it was on, so
// Resume carries on from there. These drive the REAL store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { AppProvider, useApp } from './AppStore'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'
import type { Verdict } from '../engine/types'
import type { TeamResult } from '../lib/nativeEngine'

const h = vi.hoisted(() => ({
  runNativeProject: vi.fn(),
  runNativeTeam: vi.fn(),
  cancelEngineRun: vi.fn(async (_id: string) => {}),
}))

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
    runNativeTeam: h.runNativeTeam,
    runNativeProjectFinish: async () => ({ ok: true, detail: '' }),
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

async function settle(n = 12) {
  await act(async () => {
    for (let i = 0; i < n; i++) await Promise.resolve()
  })
}

const find = (id: string) => getProjects().projects.find((p) => p.id === id)!
const live = () => captured.app!.state.liveRuns
const lines = (thread: string) =>
  (captured.app!.state.threads[thread] ?? []).map((m) => ('text' in m ? m.text : ''))

function connected() {
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
}

describe('Stop', () => {
  beforeEach(() => {
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
    h.runNativeProject.mockReset()
    h.runNativeTeam.mockReset()
    h.cancelEngineRun.mockClear()
    connected()
  })
  afterEach(() => {
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
  })

  it('a team run: the engine is cancelled and the room is told it was stopped — not that it failed', async () => {
    // The engine child dies when cancelled: its call comes back with nothing.
    let killed: (r: TeamResult | null) => void = () => {}
    h.runNativeTeam.mockImplementation(() => new Promise<TeamResult | null>((res) => (killed = res)))
    h.cancelEngineRun.mockImplementation(async () => killed(null))
    renderApp()
    await settle()
    await act(async () => {
      void captured.app!.sendTeam({ task: 'compare the two plans', roster: 'lead:claude,researcher:local' })
    })
    await settle(20)
    expect(live()).toHaveLength(1)
    const run = live()[0]
    expect(run.kind).toBe('team')
    expect(run.stoppable).toBe(true)

    await act(async () => {
      captured.app!.stopLiveRun(run.id)
    })
    await settle(30)
    // The cancel named the engine's own run — for a team run, the same id.
    expect(h.cancelEngineRun).toHaveBeenCalledWith(run.id)
    expect(live()).toHaveLength(0)
    const finished = captured.app!.state.finishedRuns[0]
    expect(finished.outcome).toBe('stopped')
    expect(finished.detail).toBe('stopped by you')
    const said = lines('universal').join('\n')
    expect(said).toContain('Stopped — you stopped this team run')
    expect(said).not.toMatch(/failed/i)
  })

  it('a build: the step in hand is cancelled, no further step starts, and Resume carries on from there', async () => {
    const p = addProject('site', 'ship the site', '', '~/vault/projects/site')
    updateProject(p.id, { plan: ['lay the base', 'add the page', 'polish'], stepIndex: 0, status: 'planned' })
    const started: string[] = []
    let killed: (v: Verdict | null) => void = () => {}
    h.runNativeProject.mockImplementation((_intent: string, _dir: string, _vault: string, _prov: unknown, _opts: unknown, engineRunId: string) => {
      started.push(engineRunId)
      return new Promise<Verdict | null>((res) => (killed = res))
    })
    h.cancelEngineRun.mockImplementation(async () => killed(null))
    renderApp()
    await settle()
    await act(async () => {
      void captured.app!.runProject(p.id)
    })
    await settle(40)
    expect(started).toHaveLength(1)
    const run = live().find((r) => r.kind === 'project')!
    expect(run.stoppable).toBe(true)

    await act(async () => {
      captured.app!.stopLiveRun(run.id)
    })
    await settle(40)
    // The cancel named the STEP's engine run, which is not the card's id.
    expect(h.cancelEngineRun).toHaveBeenCalledWith(started[0])
    expect(started[0]).not.toBe(run.id)
    // Nothing else started, and the card is gone.
    expect(started).toHaveLength(1)
    expect(live()).toHaveLength(0)
    expect(captured.app!.state.finishedRuns[0]).toMatchObject({ outcome: 'stopped', detail: 'stopped by you' })
    // Left where it was, needing attention, saying why.
    expect(find(p.id).status).toBe('attention')
    expect(find(p.id).stepIndex).toBe(0)
    expect(find(p.id).lastNote).toBe('Stopped by you at step 1 of 3 — Resume build carries on from this step.')
  })

  it('only a run that can really be stopped is offered: one AI answering is not', async () => {
    renderApp()
    await settle()
    let id = ''
    await act(async () => {
      id = captured.app!.beginLiveRun({ kind: 'manager', intent: 'Ops · morning sweep' })
    })
    expect(live()[0].stoppable).toBeFalsy()
    await act(async () => {
      captured.app!.stopLiveRun(id)
    })
    // Asking anyway cancels nothing.
    expect(h.cancelEngineRun).not.toHaveBeenCalled()
    await act(async () => {
      captured.app!.endLiveRun(id, 'passed')
    })
  })
})
