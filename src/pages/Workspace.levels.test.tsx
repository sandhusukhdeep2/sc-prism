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

/** Three AIs really connected: the Claude subscription (primary), the local
 *  model, and Gemini by key. */
function threeAIs() {
  localStorage.setItem(
    'scprism.settings',
    JSON.stringify({
      providers: [
        { id: 'claude-cli', name: 'Claude', baseUrl: '', apiKey: '', enabled: true, primary: true, connected: true },
        { id: 'local', name: 'Local model', baseUrl: 'http://localhost:1234', apiKey: '', enabled: true, primary: false, connected: true },
        { id: 'gemini', name: 'Gemini', baseUrl: '', apiKey: 'g-real', enabled: true, primary: false, connected: true },
      ],
      workload: 'agents',
    }),
  )
}

const line = () => screen.getByLabelText('Who takes this, and why').textContent ?? ''
const teamRoster = () => (h.sendTeam.mock.calls[0][0] as { roster: string }).roster

beforeEach(() => {
  localStorage.clear()
  h.send.mockClear()
  h.sendIntent.mockClear()
  h.sendTeam.mockClear()
})
afterEach(() => localStorage.clear())

// THREE LEVELS (2026-11-14). The owner: "a normal hello or a normal thinking
// question — only the primary… a little complex, the primary and local… more
// complex, all the AIs. Even a normal hello takes all three AIs." (He had sent
// "?" and it staffed three, for 8,121 tokens.)
describe('Work composer — talk, a job for two, a job for everyone', () => {
  it('a message with no words in it never staffs a team', () => {
    threeAIs()
    renderWorkspace()
    sendDraft('?')
    expect(h.sendTeam).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('an ordinary question goes to one AI, and the composer says so first', () => {
    threeAIs()
    renderWorkspace()
    type('What is the difference between RAG and fine-tuning?')
    expect(line()).toMatch(/a question, not a job, so no team is staffed/)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(h.sendTeam).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('one piece of work is sent to two seats — and the line names the two that will run', () => {
    threeAIs()
    renderWorkspace()
    type('fix the footer link')
    expect(line()).toBe(
      'lead on Claude + researcher on your local model · one piece of work, so two seats — pick the team to put every AI on it',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(h.sendTeam).toHaveBeenCalledTimes(1)
    expect(teamRoster()).toBe('lead:claude-cli,researcher:local')
  })

  it('a big job is sent to every seat, and the line says what made it big', () => {
    threeAIs()
    renderWorkspace()
    type('audit the vault for stale notes')
    expect(line()).toBe(
      'lead on Claude + researcher on your local model + critic on Gemini · “audit” asks for more than one pair of eyes',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(teamRoster()).toBe('lead:claude-cli,researcher:local,critic:gemini')
  })

  it('picking the team by hand puts every AI on one piece of work', () => {
    threeAIs()
    renderWorkspace()
    type('fix the footer link')
    openComposerControls()
    fireEvent.click(screen.getByRole('radio', { name: /^team$/i }))
    expect(line()).toContain('critic on Gemini')
    expect(line()).toContain('you picked the team')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(teamRoster()).toBe('lead:claude-cli,researcher:local,critic:gemini')
  })

  it('the line follows the workload slider — it names the seats as the slider seated them', () => {
    threeAIs()
    const s = JSON.parse(localStorage.getItem('scprism.settings')!)
    localStorage.setItem('scprism.settings', JSON.stringify({ ...s, workload: 'primary-checks' }))
    renderWorkspace()
    type('fix the footer link')
    // "Primary checks only": the local model does the work and Claude checks.
    expect(line()).toContain('researcher on your local model + critic on Claude')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(teamRoster()).toBe('researcher:local,critic:claude-cli')
  })
})
