import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

// Design 2026-11-08 §D: the rail stopped listing Automations and never listed
// the companion pages; Settings' own nav is where you change the app, so it
// reaches them. Same harness as Settings.ais.test.tsx.
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

beforeEach(() => localStorage.clear())

describe("Settings' nav reaches the rest", () => {
  it.each([
    ['Automations', '/automations'],
    ['Companion grants', '/companion-grants'],
  ])('links to %s', (name, href) => {
    renderSettings()
    expect(screen.getByRole('link', { name })).toHaveAttribute('href', href)
  })

  it('does not link to Companion wakes — that onboarding page starts a model run on every visit', () => {
    renderSettings()
    expect(screen.queryByRole('link', { name: 'Companion wakes' })).toBeNull()
  })

  it('still marks exactly one section as active', () => {
    renderSettings()
    expect(document.querySelectorAll('.settings__navitem.is-active')).toHaveLength(1)
  })
})
