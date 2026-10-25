import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import Welcome from './Welcome'
import { SettingsProvider, DEFAULT_SETTINGS } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

// Company mode phase A slice 1: the wizard's first real fork + the host's
// Hosting card. Solo stays the default; choosing 'host' mints ONE join code
// that never silently changes; the card is honest that member joining ships
// next; stop-hosting returns to solo and keeps the code.
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

describe('company mode — fork + hosting card', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('defaults solo; no Hosting card renders', () => {
    expect(DEFAULT_SETTINGS.companyMode).toBe('solo')
    renderSettings()
    expect(screen.queryByText(/Company hosting/)).not.toBeInTheDocument()
  })

  it('the Welcome fork offers both paths; company choice mints a code', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SettingsProvider>
          <OnboardingProvider>
            <Welcome />
          </OnboardingProvider>
        </SettingsProvider>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText(/My company — I’ll host/))
    const stored = JSON.parse(localStorage.getItem('scprism.settings') ?? '{}') as {
      companyMode?: string
      companyCode?: string
    }
    expect(stored.companyMode).toBe('host')
    expect(stored.companyCode).toMatch(/^[A-Z2-9]{6}$/)
  })

  it('host mode shows the card with the real code, honest next-update line, and stop-hosting keeps the code', () => {
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({ companyMode: 'host', companyCode: 'ABC234' }),
    )
    renderSettings()
    expect(screen.getByText(/Company hosting/)).toBeInTheDocument()
    expect(screen.getByText(/ABC234/)).toBeInTheDocument()
    // The card explains how a teammate actually connects, and is honest that
    // joining is not in this build yet (2026-08-31 rebuild).
    expect(screen.getByText(/land on/i)).toBeInTheDocument()
    expect(screen.getByText(/never hold a key/i)).toBeInTheDocument()
    expect(screen.getByText(/not in this build yet/i)).toBeInTheDocument()
    // Stopping hosting ASKS first — it used to switch silently on one click.
    fireEvent.click(screen.getByRole('button', { name: /stop hosting/i }))
    expect(
      JSON.parse(localStorage.getItem('scprism.settings') ?? '{}').companyMode,
    ).toBe('host')
    fireEvent.click(screen.getByRole('button', { name: /yes, back to solo/i }))
    const stored = JSON.parse(localStorage.getItem('scprism.settings') ?? '{}') as {
      companyMode?: string
      companyCode?: string
    }
    expect(stored.companyMode).toBe('solo')
    expect(stored.companyCode).toBe('ABC234')
  })
})
