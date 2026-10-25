import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

// Same one-call short-circuit as Settings.approvalMode.test.tsx — Settings
// mounts EngineExtensions whose effect hits the Tauri path plugin in jsdom.
vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

// The dependency dial (Sukhdeep, 2026-08-29: "is there any drag button where
// we can increase the dependency on a online AI? Or local AI?"). A real drag
// control in the Routing card, three stops: Local first · Balanced · Online
// first. It persists as settings.routeBias, and the card says out loud what
// outranks it (per-message choice, privacy floor).
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

describe('Settings — the dependency dial', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('renders a slider at Balanced by default', () => {
    renderSettings()
    const dial = screen.getByRole('slider', { name: /dependency dial/i })
    expect(dial).toHaveValue('1')
    // Scoped to the DIAL's own readout — the crew-lean row below it also has a
    // "Balanced" control, and a bare text query matched both (2026-08-31).
    expect(screen.getByRole('slider', { name: /dependency dial/i })).toHaveAttribute(
      'aria-valuetext',
      'Balanced',
    )
  })

  it('dragging to Local first persists routeBias local', () => {
    renderSettings()
    const dial = screen.getByRole('slider', { name: /dependency dial/i })
    fireEvent.change(dial, { target: { value: '0' } })
    expect(dial).toHaveValue('0')
    const stored = JSON.parse(localStorage.getItem('scprism.settings') ?? '{}') as {
      routeBias?: string
    }
    expect(stored.routeBias).toBe('local')
  })

  it('dragging to Online first persists routeBias cloud, and the card stays honest about what outranks it', () => {
    renderSettings()
    const dial = screen.getByRole('slider', { name: /dependency dial/i })
    fireEvent.change(dial, { target: { value: '2' } })
    const stored = JSON.parse(localStorage.getItem('scprism.settings') ?? '{}') as {
      routeBias?: string
    }
    expect(stored.routeBias).toBe('cloud')
    // The honesty line: the floor and the per-message choice outrank the dial.
    expect(screen.getByText(/always outrank the dial/i)).toBeInTheDocument()
  })
})
