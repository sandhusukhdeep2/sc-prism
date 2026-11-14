import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import GovernanceReview from './GovernanceReview'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

// Seen on a first run, 2026-11-15: on the Review screen the steps along the
// top still marked "Interview" as the one you were on.
describe('Review — the step marked is the one you are on', () => {
  beforeEach(() => localStorage.clear())

  it('marks Review, with Interview done', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/governance-review']}>
        <SettingsProvider>
          <OnboardingProvider>
            <GovernanceReview />
          </OnboardingProvider>
        </SettingsProvider>
      </MemoryRouter>,
    )
    const active = container.querySelectorAll('.step__item--active')
    expect(active).toHaveLength(1)
    expect(active[0].textContent).toBe('Review')
    const done = [...container.querySelectorAll('.step__item--done')].map((e) => e.textContent)
    expect(done).toContain('✓Interview')
  })
})
