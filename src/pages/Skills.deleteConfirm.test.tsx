import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Skills from './Skills'
import { create as createSkill } from '../lib/skills'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'

// P5 (safety): the Skills ✕ used to permanently erase a user-authored SKILL.md
// from disk on a single hover-click, with no confirmation and no undo. It now
// arms an in-app two-step confirm — the durable removal only fires after an
// explicit "confirm". These tests are the revert-failing guard for that.
function renderSkills() {
  return render(
    <MemoryRouter initialEntries={['/skills']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Skills />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Skills — two-step delete confirm (no one-click data loss)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('arms a confirm on the first ✕ click and only deletes after an explicit confirm', () => {
    createSkill({ name: 'zappy-scan', description: 'd', whenToUse: 'w', provenance: 'hand-written' })
    renderSkills()

    // The card's ✕ (accessible name "Delete zappy-scan") is present.
    expect(screen.getByRole('button', { name: /^delete zappy-scan$/i })).toBeInTheDocument()

    // First click on the ✕ must NOT delete — it only arms the confirm.
    fireEvent.click(screen.getByRole('button', { name: /^delete zappy-scan$/i }))
    expect(screen.getByRole('button', { name: /confirm delete zappy-scan/i })).toBeInTheDocument()

    // Cancelling disarms it and keeps the skill (the ✕ returns).
    fireEvent.click(screen.getByRole('button', { name: /cancel deleting zappy-scan/i }))
    expect(screen.getByRole('button', { name: /^delete zappy-scan$/i })).toBeInTheDocument()

    // Re-arm, then confirm — now the durable removal actually happens.
    fireEvent.click(screen.getByRole('button', { name: /^delete zappy-scan$/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm delete zappy-scan/i }))

    // Nothing referencing the skill's delete affordance remains.
    expect(screen.queryByRole('button', { name: /delete zappy-scan/i })).not.toBeInTheDocument()
  })
})
