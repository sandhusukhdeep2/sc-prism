// The Work page's desk, mounted WHOLE (2026-08-28). Every prior desk test
// mounted <Desk show="needs"> in isolation, so nothing ever proved the page's
// own composition: the header that counts, the rail that shows, and the
// "Coworker desk" toggle that expands the ambient slice. The failure this
// guards: the header said "1 thing needs your decision" (an open business
// question set, real and honest) while the row carrying it was unreachable —
// and the collapsed toggle repeated the count while its click revealed a
// slice that could not contain the item.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { ask } from '../lib/businessInterview'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

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

describe('the Work page desk — what is counted must be visible', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('an open question set renders BOTH the header count and the actual row', () => {
    ask(['What are your top three clients?'], Date.now())
    renderWorkspace()

    // The header counts it…
    expect(screen.getAllByText(/1 thing needs your decision/i).length).toBeGreaterThan(0)
    // …and the rail SHOWS it — the question itself, with its inline actions.
    expect(screen.getByText(/what are your top three clients\?/i)).toBeInTheDocument()
    expect(screen.getByText('Needs you')).toBeInTheDocument()
  })

  it('the collapsed toggle never advertises the needs count — its click reveals the ambient slice, not the decision', () => {
    ask(['What are your top three clients?'], Date.now())
    renderWorkspace()

    const toggle = screen.getByRole('button', { name: /coworker desk/i })
    // The toggle may only advertise what its own click shows.
    expect(toggle.textContent).not.toMatch(/needs your decision/i)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })
})
