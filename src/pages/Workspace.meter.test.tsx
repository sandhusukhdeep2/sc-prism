import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, UNIVERSAL, type ChatMessage } from '../store/AppStore'

// Mirrors main.tsx's provider stack (same pattern as Workspace.sidebar.test.tsx),
// mounted directly on the Work page. Runs non-native (no __TAURI_INTERNALS__
// stub) — the sidebar test doesn't set it either, and neither the meter strip
// nor its levers are native-gated.
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

function seedUniversal(messages: ChatMessage[]) {
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { [UNIVERSAL]: messages },
      verdicts: [],
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
    }),
  )
}

// P2-4: the context meter strip + Compress now / New session levers on the
// Work page. "Compress now" only shows once lib/contextMeter's meterFor
// crosses the soft (60%) threshold for the ACTIVE thread — proven here on
// both sides of that line, using the same persisted-session seeding pattern
// as Workspace.sidebar.test.tsx.
describe('Workspace context meter + compaction levers', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('shows the meter and a Compress now button once the thread is past the soft threshold', () => {
    // 25 assistant messages of 2,500 chars (~625 tokens each) ≈ 15,625
    // estimated tokens against the 24,000-token budget → pct ≈ 65: past the
    // 60% offerCompact line but safely under the 75% autoCompact line, so the
    // store's own auto-compact effect doesn't fire and rewrite the thread out
    // from under this assertion.
    const messages: ChatMessage[] = Array.from({ length: 25 }, (_, i) => ({
      id: `long-${i}`,
      kind: 'assistant',
      text: 'x'.repeat(2_500),
    }))
    seedUniversal(messages)
    renderWorkspace()

    // P10: the label is scoped to the thread's own budget ("thread X%"), not a
    // model's context window.
    expect(screen.getByText(/memory 65% full/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /compress now/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new session/i })).toBeInTheDocument()
  })

  it('hides the Compress now button on a short thread below the soft threshold', () => {
    const messages: ChatMessage[] = [
      { id: 'short-1', kind: 'user', text: 'hello' },
      { id: 'short-2', kind: 'assistant', text: 'hi there' },
    ]
    seedUniversal(messages)
    renderWorkspace()

    expect(screen.getByText(/memory 0% full/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /compress now/i })).not.toBeInTheDocument()
    // New session may still be present — only Compress now is threshold-gated.
    expect(screen.getByRole('button', { name: /new session/i })).toBeInTheDocument()
  })
})
