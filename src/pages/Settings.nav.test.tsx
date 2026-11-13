import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
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

// SETTINGS, IN CATEGORIES (2026-11-12, lib/settingsSections.ts). The page was
// one scroll of every control; it is now a short list of categories with one
// on screen at a time, and a search that finds a control by its name.
describe('Settings shows one category at a time', () => {
  const sections = () => within(screen.getByRole('tablist', { name: 'Settings sections' }))

  it('lists the six categories and opens on the first', () => {
    renderSettings()
    expect(sections().getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Your AIs',
      'Routing & workload',
      'Capabilities',
      'You & appearance',
      'Connections',
      'Setup',
    ])
    expect(sections().getByRole('tab', { name: 'Your AIs' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { level: 2, name: 'Your AIs' })).toBeInTheDocument()
  })

  it('only the open category is on the page', () => {
    renderSettings()
    // The workload slider lives in Routing & workload — not on Your AIs.
    expect(screen.queryByRole('slider', { name: /workload/i })).toBeNull()
    fireEvent.click(sections().getByRole('tab', { name: 'Routing & workload' }))
    expect(screen.getByRole('slider', { name: /workload/i })).toBeInTheDocument()
    expect(sections().getByRole('tab', { name: 'Routing & workload' })).toHaveAttribute('aria-selected', 'true')
    // …and the theme lives in You & appearance — not here.
    expect(screen.queryByText('Appearance')).toBeNull()
    fireEvent.click(sections().getByRole('tab', { name: 'You & appearance' }))
    expect(screen.getByText('Appearance')).toBeInTheDocument()
    expect(screen.queryByRole('slider', { name: /workload/i })).toBeNull()
  })

  it('search narrows the list to where a control lives', () => {
    renderSettings()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'telegram' } })
    expect(sections().getAllByRole('tab').map((t) => t.textContent)).toEqual(['Connections'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'zzzz' } })
    expect(sections().queryAllByRole('tab')).toHaveLength(0)
    expect(screen.getByText('No setting matches “zzzz”.')).toBeInTheDocument()
  })

  it('an address can point straight at a category', () => {
    render(
      <MemoryRouter initialEntries={['/settings?section=capabilities']}>
        <SettingsProvider>
          <OnboardingProvider>
            <Settings />
          </OnboardingProvider>
        </SettingsProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Capabilities' })).toBeInTheDocument()
  })
})
