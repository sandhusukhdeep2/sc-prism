import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

// 2026-11-11: computer use that can see. Computer control could only be
// granted in the first-run wizard, and nothing in the app could say "my local
// model can see images" or "a cloud AI may be shown my screen" — so the engine's
// new see-then-act path could not be switched on from the app at all.
vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?section=capabilities']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Settings />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const stored = () => JSON.parse(localStorage.getItem('scprism.settings') ?? '{}')

describe('Settings — computer control and who may see the screen', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('all three switches are off on a fresh install', () => {
    renderSettings()
    for (const name of [/let agents control this Mac/i, /my local model can see images/i, /a cloud AI may be shown my screen/i]) {
      expect(screen.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'false')
    }
  })

  it('the cloud switch cannot be turned on while computer control is off', () => {
    renderSettings()
    const cloud = screen.getByRole('switch', { name: /a cloud AI may be shown my screen/i })
    expect(cloud).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(cloud)
    expect(cloud).toHaveAttribute('aria-checked', 'false')
    expect(stored().screenToCloud ?? false).toBe(false)
  })

  it('turning computer control on unlocks it, and each switch saves its own setting', () => {
    renderSettings()
    fireEvent.click(screen.getByRole('switch', { name: /let agents control this Mac/i }))
    expect(stored().computerControl).toBe(true)
    const cloud = screen.getByRole('switch', { name: /a cloud AI may be shown my screen/i })
    expect(cloud).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(cloud)
    expect(stored().screenToCloud).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: /my local model can see images/i }))
    expect(stored().localVision).toBe(true)
  })

  it('turning computer control off also takes the cloud switch off', () => {
    localStorage.setItem('scprism.settings', JSON.stringify({ computerControl: true, screenToCloud: true }))
    renderSettings()
    fireEvent.click(screen.getByRole('switch', { name: /let agents control this Mac/i }))
    expect(stored().computerControl).toBe(false)
    expect(stored().screenToCloud).toBe(false)
  })

  it('names the two macOS permissions only the owner can grant', () => {
    renderSettings()
    expect(screen.getByText(/Screen Recording/)).toBeInTheDocument()
    expect(screen.getByText(/Accessibility/)).toBeInTheDocument()
  })
})
