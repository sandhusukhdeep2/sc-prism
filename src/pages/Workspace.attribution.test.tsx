import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, UNIVERSAL, type ChatMessage } from '../store/AppStore'
import { modelColor } from '../lib/modelColor'

// Multi-model chat — the per-message attribution chip under an assistant bubble.
// Same provider-stack + persisted-session seeding as Workspace.meter.test.tsx.
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

describe('Workspace assistant attribution chip', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('renders the chip (model + route reason) for an assistant message WITH meta', () => {
    seedUniversal([
      {
        id: 'a1',
        kind: 'assistant',
        text: 'here is your answer',
        model: 'claude · claude-3.5-sonnet',
        routeReason: 'heavy reasoning — routed to your primary',
        isLocal: false,
      },
    ])
    const { container } = renderWorkspace()
    expect(screen.getByText('claude · claude-3.5-sonnet')).toBeTruthy()
    expect(screen.getByText('· heavy reasoning — routed to your primary')).toBeTruthy()
    // dot color == modelColor(provider) — normalized through the same jsdom path
    const expected = document.createElement('span')
    expected.style.background = modelColor('claude · claude-3.5-sonnet')
    const dot = container.querySelector('.msg__attribdot') as HTMLElement
    expect(dot).toBeTruthy()
    expect(dot.style.background).toBe(expected.style.background)
    // a cloud reply shows no lock; the removed stub chip (H3) never appears
    expect(container.querySelector('.msg__attriblock')).toBeNull()
    expect(container.querySelector('.msg__attribstub')).toBeNull()
  })

  it('shows 🔒 for a local reply', () => {
    seedUniversal([
      {
        id: 'a1',
        kind: 'assistant',
        text: 'kept on device',
        model: 'local · qwen2.5-coder',
        routeReason: 'kept local — cheap inference, zero egress',
        isLocal: true,
      },
    ])
    const { container } = renderWorkspace()
    expect(container.querySelector('.msg__attriblock')?.textContent).toBe('🔒')
    expect(container.querySelector('.msg__attribstub')).toBeNull()
  })

  // H3: the `· stub` chip branch was unreachable in production (a stub/offline
  // verdict routes to an honest error card, never an attributed bubble), so it
  // was removed. This guards that no attributed bubble ever renders a stub chip.
  it('never renders a stub chip on an attributed bubble (the dead branch is gone)', () => {
    seedUniversal([
      {
        id: 'a1',
        kind: 'assistant',
        text: 'a real answer',
        model: 'local · qwen2.5-coder',
        routeReason: 'kept local — cheap inference, zero egress',
        isLocal: true,
      },
    ])
    const { container } = renderWorkspace()
    expect(container.querySelector('.msg__attribstub')).toBeNull()
  })

  it('renders NO chip for an assistant message without meta (byte-identical to before)', () => {
    seedUniversal([{ id: 'a1', kind: 'assistant', text: 'plain reply' }])
    const { container } = renderWorkspace()
    expect(screen.getByText('plain reply')).toBeTruthy()
    expect(container.querySelector('.msg__attrib')).toBeNull()
    expect(container.querySelector('.msg__aicol')).toBeNull()
  })
})
