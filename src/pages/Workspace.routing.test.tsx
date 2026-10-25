// Sukh decides who does the work, and says why (2026-08-15 spec §One front door).
//
// The point of this file is that the routing line is NOT decoration. It states
// the choice AND its reason before the send, and the choice it states is the
// one the message actually gets: the pick becomes the run's real route hint,
// which the gateway honours within the sensitivity floor. So each test below
// checks BOTH halves — what the user is told, and what was really sent.
//
// The store's `send`/`sendIntent` are spied (the engine itself is exercised in
// engine/tests), so these assertions are about the DECISION and its arguments.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// The composer's target + route pills now live behind a "Change" disclosure:
// the DEFAULT is stated in words beside the send button ("Sukh takes this"),
// and the seven pills that used to shout from the composer open deliberately.
// Nothing about the controls changed — same options, same aria-labels, same
// per-message reset — so opening the panel is plumbing, not the thing under
// test, and this helper does it on demand and only once.
function openComposerControls() {
  if (screen.queryAllByRole('radio').length > 0) return
  const change = screen.queryByRole('button', { name: /Change who takes this/i })
  if (change) fireEvent.click(change)
}
import { setInterview } from '../lib/interview'

const h = vi.hoisted(() => ({
  send: vi.fn(async (..._args: unknown[]) => {}),
  sendIntent: vi.fn(async (..._args: unknown[]) => {}),
  sendTeam: vi.fn(async (..._args: unknown[]) => {}),
}))

vi.mock('../store/AppStore', async (orig) => {
  const actual = await orig<typeof import('../store/AppStore')>()
  return {
    ...actual,
    useApp: () => ({
      ...actual.useApp(),
      send: h.send,
      sendIntent: h.sendIntent,
      sendTeam: h.sendTeam,
    }),
  }
})

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Workspace />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const composer = () => screen.getByRole('textbox', { name: /describe/i }) as HTMLTextAreaElement

function type(text: string) {
  fireEvent.change(composer(), { target: { value: text } })
}

function sendDraft(text: string) {
  type(text)
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

// Sprint B (2026-08-30): the composer DEFAULTS to the team lane. These tests
// exercise the MANAGER (plain-send) lane's routing contract, so they select
// it first — one deliberate click, exactly as a user would.
function pickManager() {
  openComposerControls()
  fireEvent.click(screen.getByRole('radio', { name: /your local model/i }))
}

/** The route hint `send` was really called with (its 3rd argument). */
function sentRoute(): unknown {
  return h.send.mock.calls[0]?.[2]
}

beforeEach(() => {
  localStorage.clear()
  h.send.mockClear()
  h.sendIntent.mockClear()
  h.sendTeam.mockClear()
})
afterEach(() => {
  localStorage.clear()
})

describe('the routing line — a choice AND its reason, never a silent pick', () => {
  it('shows nothing until there is a job to route', () => {
    renderWorkspace()
    expect(screen.queryByLabelText('Who takes this, and why')).not.toBeInTheDocument()
  })

  it('names who takes it and why, as soon as something is typed', () => {
    renderWorkspace()
    type('write the launch note')
    const line = screen.getByLabelText('Who takes this, and why')
    expect(line.textContent).toBeTruthy()
    // The DEFAULT install has only the local model connected, so the honest
    // answer is that one AI — and it says so rather than performing a team.
    expect(line.textContent).toContain('your local model')
    expect(line.textContent).toMatch(/only AI connected|not a team/)
  })

  it('the reason is the SENSITIVITY FLOOR when one applies, in the engine’s own words', () => {
    setInterview({ sensitiveWords: ['mortgage'] })
    renderWorkspace()
    type('summarize my mortgage statement')
    const line = screen.getByLabelText('Who takes this, and why')
    // routeReasonLabel's own sentence — the one the verdict card shows too.
    expect(line.textContent).toContain('zero egress')
    expect(line.className).toContain('chat__routing--floor')
  })

  it('the stated choice is the route the message REALLY gets', () => {
    renderWorkspace()
    pickManager()
    sendDraft('write the launch note')
    // The only connected AI is local, so Sukh picks local — and that is what
    // was sent, not 'auto'. The line and the run agree by construction.
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(sentRoute()).toBe('local')
  })

  it('your own explicit route override still wins, and the line says so', () => {
    renderWorkspace()
    type('write the launch note')
    pickManager()
    fireEvent.click(screen.getByRole('radio', { name: 'cloud' }))
    expect(screen.getByLabelText('Who takes this, and why').textContent).toContain(
      'you overrode this to cloud',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sentRoute()).toBe('cloud')
  })
})

describe('staffing a project from the composer', () => {
  it('is offered but DISABLED with the reason when no project is open', () => {
    renderWorkspace()
    openComposerControls()
    fireEvent.click(screen.getByRole('button', { name: /more ▾/ }))
    const staff = screen.getByRole('radio', { name: 'staff project' })
    expect(staff).toBeDisabled()
    expect(staff).toHaveAttribute('title', expect.stringContaining('open a project first'))
  })
})
