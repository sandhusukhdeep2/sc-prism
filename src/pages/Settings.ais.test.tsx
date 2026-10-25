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

// Sukhdeep, 2026-09-03: "I can see the option all local / balanced / all
// Claude, but I have more than two AIs … you just give me a token budget for
// all of them together, but I need token budget for each and every AI …
// it's a bit confusing. Can you rethink how we can handle this?"
//
// He was right: four overlapping controls in one card, a preset that could
// only ever mean Claude, and one budget for every AI at once. This replaces
// them with one row per AI he has actually connected.
function withAIs(...ids: string[]) {
  localStorage.setItem(
    'scprism.settings',
    JSON.stringify({
      providers: ids.map((id, i) => ({
        id,
        name: id,
        baseUrl: '',
        apiKey: 'k',
        enabled: true,
        primary: i === 0,
        connected: true,
      })),
    }),
  )
}

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

describe('Your AIs — one row per connected AI', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('lists every connected AI by name', () => {
    withAIs('claude-cli', 'gemini', 'local')
    renderSettings()
    expect(screen.getByText(/your ais/i)).toBeInTheDocument()
    expect(screen.getAllByText(/claude/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/gemini/i).length).toBeGreaterThan(0)
  })

  it('gives EACH AI its own token alert, not one shared number', () => {
    withAIs('claude-cli', 'gemini', 'local')
    renderSettings()
    expect(screen.getByLabelText(/token alert for claude/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/token alert for gemini/i)).toBeInTheDocument()
  })

  it('persists a per-AI alert independently', () => {
    withAIs('claude-cli', 'gemini')
    renderSettings()
    const g = screen.getByLabelText(/token alert for gemini/i)
    fireEvent.change(g, { target: { value: '500000' } })
    fireEvent.blur(g)
    const stored = JSON.parse(localStorage.getItem('scprism.settings') ?? '{}')
    expect(stored.brandBudgets?.gemini).toBe(500000)
    // Claude's alert is untouched by editing Gemini's.
    expect(stored.brandBudgets?.claude).toBeUndefined()
  })

  it('offers unlimited, and says what that means', () => {
    withAIs('claude-cli')
    renderSettings()
    const input = screen.getByLabelText(/token alert for claude/i)
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    const stored = JSON.parse(localStorage.getItem('scprism.settings') ?? '{}')
    expect(stored.brandBudgets?.claude).toBe(0)
    expect(screen.getAllByText(/no alert|unlimited/i).length).toBeGreaterThan(0)
  })

  it('offers one crew button per cloud the user actually has', () => {
    // The old row said "All cloud" and silently meant whichever it found
    // first, so Gemini was unreachable.
    withAIs('claude-cli', 'gemini', 'local')
    renderSettings()
    expect(screen.getByRole('button', { name: /all on claude/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /all on gemini/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^all cloud$/i })).not.toBeInTheDocument()
  })

  it('does not offer a cloud button for an AI that is not connected', () => {
    withAIs('claude-cli', 'local')
    renderSettings()
    expect(screen.queryByRole('button', { name: /all on gemini/i })).not.toBeInTheDocument()
  })
})
