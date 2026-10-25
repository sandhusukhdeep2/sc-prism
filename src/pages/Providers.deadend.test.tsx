import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Providers from './Providers'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '', isNative: () => false }
})

// ---------------------------------------------------------------------------
// THE FIRST-RUN DEAD END (pre-launch UI audit, 2026-09-03).
//
// A stranger downloads the app. They have no API key, no local model server,
// and have never installed a subscription CLI. The local card is pre-enabled
// pointing at localhost:1234 and cannot go green. "Test primary & continue"
// refuses: "Connect at least one service above (green ✓) before continuing."
// The "Skip cloud for now" escape renders only when something is ALREADY
// connected, so they never see it.
//
// The only control left is "✕ Close" — which called finish(), marking setup
// DONE for someone who connected nothing. Close must mean close.
//
// This is the launch blocker: it is the first screen a stranger sees, and it
// has no honest way forward.
// ---------------------------------------------------------------------------
function renderProviders() {
  return render(
    <MemoryRouter initialEntries={['/providers']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Providers />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('a first-run user with nothing connected', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('is offered a way forward, not only a way to close', () => {
    renderProviders()
    expect(
      screen.getByRole('button', { name: /continue without|connect one later|set this up later/i }),
    ).toBeInTheDocument()
  })

  it('the way forward says what it costs them', () => {
    renderProviders()
    const btn = screen.getByRole('button', { name: /continue without|connect one later|set this up later/i })
    // It must not read as a neutral "skip" — nothing works without an AI.
    expect(screen.getByText(/until you connect|nothing can run|won't be able to run/i)).toBeInTheDocument()
    expect(btn).not.toBeDisabled()
  })

  it('closing the wizard does NOT mark setup finished', () => {
    renderProviders()
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    const st = JSON.parse(localStorage.getItem('scprism.onboarding') ?? '{}')
    expect(st.done).not.toBe(true)
  })
})
