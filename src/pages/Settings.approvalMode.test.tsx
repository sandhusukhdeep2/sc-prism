import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

// Settings mounts EngineExtensions, whose mount effect calls
// resolveVaultDir → expandUserPath → the Tauri path plugin unconditionally
// (that helper is documented native-only; nothing before this test rendered
// <Settings/> directly in jsdom to hit it). Short-circuit just that one call
// so the unrelated native bridge is never touched — everything else in
// nativeEngine (including its own isNative() guards) stays real.
vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

// MV5 (Manager View §5): the Settings toggle for the build-approval gate —
// "Approve each team before it runs" (default) vs "Run automatically".
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

describe('Settings — Approvals toggle (MV5)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('defaults on ("Approve each team before it runs")', () => {
    renderSettings()
    const toggle = screen.getByRole('switch', { name: /approve each team before it runs/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/approve each team before it runs/i)).toBeInTheDocument()
  })

  it('clicking the toggle switches to auto, and back to approve', () => {
    renderSettings()
    const toggle = screen.getByRole('switch', { name: /approve each team before it runs/i })

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/^run automatically$/i)).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/approve each team before it runs/i)).toBeInTheDocument()
  })
})
