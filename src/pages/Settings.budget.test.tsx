import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

// Sukhdeep, 2026-09-03: "I also need a controller that show me dependency on a
// local more or online more … How many token I use? What is the budget?"
//
// Built after a live board spent 110,873 tokens against an invisible 100,000
// default, lost its third agent, and returned an empty answer.
function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Settings />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('the token budget card', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('shows the budget in force even when the user has set none', () => {
    // 0 means "engine default". Showing a blank would leave the user unable to
    // reason about a limit that is nonetheless enforced.
    renderSettings()
    expect(screen.getByText(/token budget/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/tokens per run/i)).toBeInTheDocument()
    expect(screen.getByText(/100,000/)).toBeInTheDocument()
  })

  it('says what happens when a run reaches the limit', () => {
    renderSettings()
    expect(screen.getByText(/stop/i)).toBeInTheDocument()
  })

  it('persists a budget the user sets', () => {
    renderSettings()
    const input = screen.getByLabelText(/tokens per run/i)
    fireEvent.change(input, { target: { value: '250000' } })
    fireEvent.blur(input)
    const stored = JSON.parse(localStorage.getItem('scprism.settings') ?? '{}')
    expect(stored.tokenBudget).toBe(250000)
  })

  it('clamps a budget too small to finish a turn', () => {
    renderSettings()
    const input = screen.getByLabelText(/tokens per run/i)
    fireEvent.change(input, { target: { value: '500' } })
    fireEvent.blur(input)
    const stored = JSON.parse(localStorage.getItem('scprism.settings') ?? '{}')
    expect(stored.tokenBudget).toBe(10000)
  })

  it('shows where the work actually ran — local versus cloud', () => {
    renderSettings()
    // Two surfaces mention the Mac; assert on the budget card's own split,
    // which states BOTH sides so the dependency is legible at a glance.
    expect(screen.getAllByText(/on your Mac/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/in the cloud/i)).toBeInTheDocument()
  })
})
