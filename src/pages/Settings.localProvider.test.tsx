import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

// Same short-circuit as the other Settings tests: EngineExtensions' mount
// effect calls resolveVaultDir → the Tauri path plugin, which jsdom lacks.
vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, resolveVaultDir: async () => '' }
})

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

describe('Settings — Local model card', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  // A local server (LM Studio, Ollama, oMLX…) serves REAL model ids and
  // rejects the placeholder — without this field the user cannot ever set one.
  it('offers the model + thinking controls on the Local model card', () => {
    renderSettings()
    expect(screen.getByLabelText('Model for Local model')).toBeInTheDocument()
    expect(screen.getByLabelText('Thinking effort for Local model')).toBeInTheDocument()
  })

  it('masks the API key, and the eye toggle reveals/hides it', () => {
    renderSettings()
    const key = () => screen.getByLabelText('API key for Local model') as HTMLInputElement
    expect(key().type).toBe('password')
    fireEvent.change(key(), { target: { value: 'sekrit-1' } })

    fireEvent.click(screen.getByRole('button', { name: 'Show API key for Local model' }))
    expect(key().type).toBe('text')
    expect(key().value).toBe('sekrit-1')

    fireEvent.click(screen.getByRole('button', { name: 'Hide API key for Local model' }))
    expect(key().type).toBe('password')
  })
})
