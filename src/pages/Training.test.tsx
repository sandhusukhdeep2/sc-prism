import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Training from './Training'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// THE TRAINING TAB SAYS EACH THING ONCE (2026-11-14, the once-only pass). Seen
// in the installed app: "never the models' weights" twice in the head, and
// "dry run" four times down the page — in the head's sentence, in a card
// title wrapped around the panel ("Learning step — a dry run — nothing is
// adopted without you"), in the panel's own heading, and under its button.
function renderTraining() {
  return render(
    <MemoryRouter initialEntries={['/library?tab=training']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Training />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const count = (re: RegExp) => (document.body.textContent ?? '').match(re)?.length ?? 0

describe('the Training tab says each thing once', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('says what is learned — route policy, never the models’ weights — once', () => {
    renderTraining()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Improve\s*routing/)
    expect(count(/never the models[’'] weights/g)).toBe(1)
  })

  it('the learning step is headed once, by the panel itself', () => {
    renderTraining()
    expect(count(/learning step/gi)).toBeLessThanOrEqual(3) // the panel's heading, its button, and no wrapper title
    expect(screen.queryByText('a dry run — nothing is adopted without you')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: 'Learning step' })).not.toBeInTheDocument()
  })
})
