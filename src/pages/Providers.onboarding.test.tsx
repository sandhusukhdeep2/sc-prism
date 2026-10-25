import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Providers from './Providers'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={['/onboarding/providers']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Providers />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Onboarding wizard — local provider model pick', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  // A real local server rejects the placeholder model id, so the wizard must
  // let the user pick a served model at connect time (same fix as Settings).
  it('offers the model field + live model loading on the Local card', () => {
    renderWizard()
    expect(screen.getByLabelText('Model for Local model')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '▾ load models' })).toBeInTheDocument()
    expect(screen.getByLabelText('Thinking effort for Local model')).toBeInTheDocument()
  })

  it('offers model + thinking on an enabled cloud brand card too', async () => {
    renderWizard()
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Claude' }))
    expect(screen.getByLabelText(/Model for Claude/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Thinking effort for Claude/)).toBeInTheDocument()
  })

  // Subscription CLIs expose no listing API, so the picker is a curated list
  // of aliases the CLI resolves — newest/recommended pinned on top, plus
  // "custom…" so any other id still works.
  it('CLI mode gets the curated model list, recommended first', async () => {
    renderWizard()
    const { fireEvent, within } = await import('@testing-library/react')
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Claude' }))
    fireEvent.click(screen.getByText('Pro/Max plan'))
    const select = screen.getByLabelText(/Model for Claude Code/) as HTMLSelectElement
    expect(within(select).getByRole('group', { name: 'Recommended — newest' })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: /fable — Fable 5/ })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: /haiku — Haiku 4.5/ })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: 'custom…' })).toBeInTheDocument()
    // picking a curated alias persists it as the provider model
    fireEvent.change(select, { target: { value: 'fable' } })
    expect((screen.getByLabelText(/Model for Claude Code/) as HTMLSelectElement).value).toBe('fable')
  })
})
