import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Welcome from './Welcome'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'
import pkg from '../../package.json'

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

// Seen on a first run of the 0.2.1 build with an empty home folder: the very
// first screen said "v0.1 · solo alpha". The label was typed by hand once and
// never moved. It is read from the package now, so it cannot fall behind.
describe('Welcome — the version it shows is the app’s own', () => {
  beforeEach(() => localStorage.clear())

  it('prints the package version, not a hand-typed one', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SettingsProvider>
          <OnboardingProvider>
            <Welcome />
          </OnboardingProvider>
        </SettingsProvider>
      </MemoryRouter>,
    )
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(screen.getByText(`v${pkg.version} · solo alpha`)).toBeInTheDocument()
  })
})
