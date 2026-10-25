import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Agents from './Agents'
import { create as createAgent, list as listAgents, remove as removeAgent } from '../lib/agents'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// P10 honesty: the Agents page used to pop a hardcoded "capture toast" offering
// to draft a `pr-reviewer` agent "to check PRs before merge" — a fabricated
// suggestion backed by no real signal. It was removed. This is the revert-failing
// guard: no fabricated suggestion toast may reappear on the page.
function renderAgents() {
  return render(
    <MemoryRouter initialEntries={['/agents']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Agents />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Agents — no fabricated suggestion toast', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('renders no hardcoded capture toast (no fabricated "draft it" prompt)', () => {
    renderAgents()
    // The fabricated toast is gone: neither its element nor its CTA survives.
    expect(document.querySelector('.capture-toast')).toBeNull()
    expect(screen.queryByRole('button', { name: /draft it/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/check PRs before merge/i)).not.toBeInTheDocument()
  })

  // P6 honesty: the "+ New agent" tile used to offer TWO buttons — "Structured
  // form" and "Describe it → draft" — that both called the same onStart(); the
  // describe-to-draft flow never existed. Collapsed to one honest button.
  it('the new-agent tile offers no fabricated "describe → draft" affordance', () => {
    renderAgents()
    expect(screen.queryByRole('button', { name: /describe it/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/the Companion drafts it/i)).not.toBeInTheDocument()
    // The single honest entry point remains.
    expect(screen.getByRole('button', { name: /open form/i })).toBeInTheDocument()
  })
})

// P9 (safety): deleting an agent is permanent, so it is a two-step arm-then-
// confirm (mirrors SkillCard's round-1 pattern) — one click on "Delete agent"
// only arms it; the durable removal needs an explicit confirm.
describe('Agents — permanent agent delete is two-step (P9)', () => {
  beforeEach(() => {
    localStorage.clear()
    createAgent({ name: 'Doomed', role: 'r', model: 'local', skills: [], assignedTo: '' })
  })
  afterEach(() => {
    for (const a of listAgents()) if (!a.system) removeAgent(a.id)
    localStorage.clear()
  })

  it('a single click on "Delete agent" ARMS the confirm — nothing is removed until confirm', () => {
    renderAgents()
    fireEvent.click(screen.getByRole('button', { name: /actions for Doomed/i }))
    // One click arms; the agent must still be present (no native window.confirm).
    fireEvent.click(screen.getByRole('button', { name: /^Delete Doomed$/i }))
    expect(screen.getByText('Doomed')).toBeInTheDocument()
    // The explicit confirm performs the durable removal.
    fireEvent.click(screen.getByRole('button', { name: /confirm delete Doomed/i }))
    expect(screen.queryByText('Doomed')).not.toBeInTheDocument()
  })

  it('cancel disarms without deleting', () => {
    renderAgents()
    fireEvent.click(screen.getByRole('button', { name: /actions for Doomed/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Delete Doomed$/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel deleting Doomed/i }))
    expect(screen.getByText('Doomed')).toBeInTheDocument()
    // Back to the un-armed affordance.
    expect(screen.getByRole('button', { name: /^Delete Doomed$/i })).toBeInTheDocument()
  })
})
