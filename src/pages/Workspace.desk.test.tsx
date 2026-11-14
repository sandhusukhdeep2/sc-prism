// The Work page's desk, mounted WHOLE (2026-08-28). Every prior desk test
// mounted <Desk show="needs"> in isolation, so nothing ever proved the page's
// own composition: the header that counts, the rail that shows, and the way
// the ambient slice is opened (a "Coworker desk" toggle then; the Desk tab
// beside the chat since 2026-11-14). The failure this
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

  // 2026-11-14 ("Visible agents"): the ambient desk is no longer a band on the
  // page. The Manager's room offers it beside the chat; the decision stays on
  // the page whether or not it is open.
  it('the ambient desk opens beside the chat on request — and never carries the decision', () => {
    ask(['What are your top three clients?'], Date.now())
    renderWorkspace()

    const open = screen.getByRole('button', { name: 'Desk' })
    // The button may only advertise what its own click shows — and on hover
    // it says what is on the desk, in counts from the stores.
    expect(open.textContent).not.toMatch(/needs your decision/i)
    expect(open.getAttribute('title') ?? '').toMatch(/on duty|loop|nothing on the desk yet/)
    expect(open.getAttribute('title') ?? '').not.toMatch(/needs your decision/i)
    expect(screen.queryByRole('tab', { name: 'Desk' })).not.toBeInTheDocument()
    fireEvent.click(open)
    expect(screen.getByRole('tab', { name: 'Desk' })).toHaveAttribute('aria-selected', 'true')
    // The question is still on the page, once: in the row that needs him.
    expect(screen.getAllByText(/what are your top three clients\?/i)).toHaveLength(1)
  })
})
