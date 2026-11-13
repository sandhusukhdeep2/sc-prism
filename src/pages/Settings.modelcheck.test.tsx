// Settings → Your AIs shows what the day's model check found, lets the owner
// switch the moving off, and run it again on demand (2026-11-14: "check the
// new available AIs models and add to in our list … Always prefer a new one").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const native = vi.hoisted(() => ({
  probeCli: vi.fn(async () => ({ ok: true, reply: 'ok', error: '' })),
}))

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return { ...actual, isNative: () => true, resolveVaultDir: async () => '', probeCli: native.probeCli,
    storeGet: async () => null, storeSet: async () => {} }
})

import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'
import { saveModelCheck } from '../lib/modelCheckRun'

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?section=ais']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Settings />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

const STORE = 'scprism.settings'
const stored = () => JSON.parse(localStorage.getItem(STORE) ?? '{}') as {
  autoNewestModel?: boolean
  providers?: { id: string; model?: string }[]
}

function seed() {
  localStorage.setItem(
    STORE,
    JSON.stringify({
      providers: [
        { id: 'claude-cli', name: 'Claude Code', baseUrl: '', apiKey: '', enabled: true, primary: true, connected: true, model: 'opus' },
      ],
    }),
  )
}

describe('Settings — the day’s model check', () => {
  beforeEach(() => {
    localStorage.clear()
    native.probeCli.mockClear()
    seed()
  })
  afterEach(() => localStorage.clear())

  it('says it has not checked yet, before the first check', async () => {
    renderSettings()
    expect(await screen.findByText('Newest models')).toBeInTheDocument()
    expect(screen.getByText(/not checked yet/i)).toBeInTheDocument()
  })

  it('shows what the last check did', async () => {
    saveModelCheck({
      catalog: {},
      last: {
        at: new Date(2026, 10, 14, 9, 2).getTime(),
        moves: [{ providerId: 'claude-cli', name: 'Claude Code', from: 'sonnet', to: 'opus', why: 'greatest' }],
        fresh: [],
        skipped: [],
      },
    })
    renderSettings()
    expect(await screen.findByText(/Claude Code now runs on opus \(was sonnet\)/)).toBeInTheDocument()
  })

  it('a check that found nothing says so plainly', async () => {
    saveModelCheck({ catalog: {}, last: { at: Date.now(), moves: [], fresh: [], skipped: [] } })
    renderSettings()
    expect(await screen.findByText(/every AI is on its newest model/i)).toBeInTheDocument()
  })

  it('moving is on by default and can be switched off', async () => {
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: /move each AI to its newest model/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    await waitFor(() => expect(stored().autoNewestModel).toBe(false))
  })

  it('Check now runs the check and moves the primary once the model answers', async () => {
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: /check now/i }))
    await waitFor(() => expect(native.probeCli).toHaveBeenCalledWith('claude', undefined, 'fable'))
    await waitFor(() =>
      expect(stored().providers?.find((p) => p.id === 'claude-cli')?.model).toBe('fable'),
    )
    expect(await screen.findByText(/Claude Code now runs on fable \(was opus\)/)).toBeInTheDocument()
  })

  it('with moving off, Check now moves nothing', async () => {
    renderSettings()
    fireEvent.click(await screen.findByRole('switch', { name: /move each AI to its newest model/i }))
    fireEvent.click(screen.getByRole('button', { name: /check now/i }))
    await waitFor(() => expect(screen.getByText(/every AI is on its newest model|checked/i)).toBeInTheDocument())
    expect(native.probeCli).not.toHaveBeenCalled()
    expect(stored().providers?.find((p) => p.id === 'claude-cli')?.model).toBe('opus')
  })
})
