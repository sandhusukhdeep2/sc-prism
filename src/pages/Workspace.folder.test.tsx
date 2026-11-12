// The folder lane of a project's room (2026-11-11), through the REAL store.
//
// A change typed in a project's room goes to that project's folder — and the
// composer says so BEFORE the send, with the reason. A question does not. One
// click flips either. Outside a project there is no folder to offer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import { addProject, getProjects, removeProject, updateProject } from '../lib/projects'
import type { Verdict } from '../engine/types'

const h = vi.hoisted(() => ({
  runNativeTeam: vi.fn(),
  runNativeTask: vi.fn(),
  runNativeProject: vi.fn(),
  spans: [] as unknown[],
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    expandUserPath: async (p: string) => p.replace(/^~/, '/Users/test'),
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    readSpansTail: async () => h.spans as never[],
    appendChatNote: async () => {},
    appendVaultNote: async () => '/vault/conversations/x.md',
    readVaultFile: async () => null,
    writeVaultNote: async () => '/vault/note.md',
    runNativeTeam: h.runNativeTeam,
    runNativeTask: h.runNativeTask,
    runNativeProject: h.runNativeProject,
    cancelEngineRun: async () => {},
  }
})

const captured: { app?: ReturnType<typeof useApp> } = {}
function Capture() {
  captured.app = useApp()
  return null
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Capture />
              <Workspace />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const verdict = {
  taskId: 'T-job',
  task: 'x',
  response: 'Rewrote hello.md.',
  route: { target: 'local', model: 'qwen', via: '', reason: '', routeLabel: 'local · qwen' },
  tier1: { tests: '1/1', lint: true, build: true, pass: true },
  tier2: { evalScore: 0.9, passed: true, judge: 'j', trajectory: 't' },
  tokensIn: 1,
  tokensOut: 1,
  cost: 0,
  durationMs: 1,
  modelRoute: '',
  hooks: { blocked: 0, passed: true },
  writeback: { path: '', validated: true, committed: true },
  passed: true,
} as unknown as Verdict

function clean() {
  for (const p of getProjects().projects) removeProject(p.id)
  localStorage.clear()
}

async function openRoom(): Promise<string> {
  const p = addProject('hello crew', 'greet the crew', '', '~/vault/projects/hello-crew')
  updateProject(p.id, { plan: ['Write hello.md'], stepIndex: 1, status: 'done' })
  renderWorkspace()
  await act(async () => {
    captured.app!.setActiveProject(p.id)
    await Promise.resolve()
  })
  return p.id
}

function type(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: /describe/i }), { target: { value: text } })
}

async function send() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

function openComposerControls() {
  if (screen.queryAllByRole('radio').length > 0) return
  fireEvent.click(screen.getByRole('button', { name: /Change who takes this/i }))
}

describe('Work composer → the project folder', () => {
  beforeEach(() => {
    clean()
    h.runNativeProject.mockReset()
    h.runNativeProject.mockResolvedValue(verdict)
    h.runNativeTeam.mockReset()
    h.runNativeTask.mockReset()
  })
  afterEach(clean)

  it('a change says, before the send, that it goes to the folder and why', async () => {
    await openRoom()
    type('Rewrite hello.md as a warmer greeting')
    expect(screen.getByLabelText('Who takes this, and why').textContent).toBe(
      'your team makes this change in ~/vault/projects/hello-crew — because you asked for a change',
    )
    expect(screen.getByText('your team works in the folder')).toBeTruthy()
  })

  it('sending it runs the build in the folder, not a board that cannot write', async () => {
    const id = await openRoom()
    type('Rewrite hello.md as a warmer greeting')
    await send()
    expect(h.runNativeProject).toHaveBeenCalledTimes(1)
    expect(h.runNativeProject.mock.calls[0][1]).toBe('/Users/test/vault/projects/hello-crew')
    expect(h.runNativeTeam).not.toHaveBeenCalled()
    expect(getProjects().projects.find((p) => p.id === id)!.plan).toHaveLength(2)
    expect(screen.getByText('→ folder: Rewrite hello.md as a warmer greeting')).toBeTruthy()
  })

  it('a question is not sent to the folder', async () => {
    await openRoom()
    type('Why is the greeting on two lines in this project?')
    expect(screen.getByLabelText('Who takes this, and why').textContent).not.toMatch(/folder/)
    expect(screen.queryByText('your team works in the folder')).toBeNull()
  })

  it('the folder can be picked by hand for a remark', async () => {
    await openRoom()
    type('the greeting should be warmer')
    expect(screen.queryByText('your team works in the folder')).toBeNull()
    openComposerControls()
    fireEvent.click(screen.getByRole('radio', { name: /^folder$/i }))
    expect(screen.getByLabelText('Who takes this, and why').textContent).toBe(
      'your team makes this change in ~/vault/projects/hello-crew — you chose the folder',
    )
    await send()
    expect(h.runNativeProject).toHaveBeenCalledTimes(1)
  })

  it('a change can be taken OUT of the folder by picking the team', async () => {
    await openRoom()
    type('Rewrite hello.md as a warmer greeting')
    openComposerControls()
    fireEvent.click(screen.getByRole('radio', { name: /^team$/i }))
    expect(screen.queryByText('your team works in the folder')).toBeNull()
    expect(screen.getByText('your team takes this')).toBeTruthy()
  })

  it('a folder that is busy says so and does not send', async () => {
    const id = await openRoom()
    await act(async () => {
      updateProject(id, { status: 'attention', stepIndex: 0 })
    })
    type('Rewrite hello.md')
    openComposerControls()
    fireEvent.click(screen.getByRole('radio', { name: /^folder$/i }))
    expect(screen.getByLabelText('Who takes this, and why').textContent).toMatch(
      /^the folder cannot take this yet — a step in this project needs attention first/,
    )
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('outside a project there is no folder to offer', async () => {
    renderWorkspace()
    await act(async () => {
      await Promise.resolve()
    })
    type('Rewrite hello.md as a warmer greeting')
    expect(screen.getByLabelText('Who takes this, and why').textContent).not.toMatch(/folder/)
    openComposerControls()
    expect(screen.queryByRole('radio', { name: /^folder$/i })).toBeNull()
  })
})

// Seen in the installed app after a real run (2026-11-11): a project's room
// said "the last team run · nothing is running now" over nothing at all — the
// label was about the app's last run, the board was about the project's.
describe('a project’s room labels only a board it is drawing', () => {
  beforeEach(clean)
  afterEach(clean)

  it('says nothing about a last run when it has no crew to show', async () => {
    // The app's last finished run WAS a crew — but it was not this project's.
    const t = Date.now() / 1000 - 600
    const seat = (id: string, agent: string, at: number) => ({
      span_id: id, run_id: 'old-run', type: 'model_call', name: 'model_call',
      start: at, end: at + 1, status: 'ok',
      attrs: { agent, provider: 'local', model: 'gemma', is_real: true },
    })
    h.spans = [
      seat('a', 'lead', t),
      seat('b', 'researcher', t + 2),
      { span_id: 'r', run_id: 'old-run', type: 'run', name: 'run:old', start: t, end: t + 4, status: 'ok', attrs: {} },
    ]
    await openRoom()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(document.querySelectorAll('.crew__seat, .stage__seat')).toHaveLength(0)
    expect(screen.queryByText(/nothing is running now/)).toBeNull()
    h.spans = []
  })
})
