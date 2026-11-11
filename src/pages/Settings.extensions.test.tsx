import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

// 2026-11-11: LightRAG, DeepEval and the gateway daemon all read "not installed
// here" in the installed app. The daemon had been in the bundle all along (the
// check only looked at a developer checkout), and the two libraries are now
// packaged with the app. The rows say what each one really does when it is on.
vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '',
    readMcpServers: async () => [],
    readMcpApprovals: async () => ({ require: [], granted: [] }),
    checkExtensions: async () => ({ deepeval: true, lightrag: true, llm: false, bifrost: true }),
    readTrainingCount: async () => 0,
  }
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

describe('Settings — the engine extensions that ship with the app', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('shows all three as included once the bridge reports them', async () => {
    renderSettings()
    await waitFor(() => expect(screen.getAllByText(/included with the app/)).toHaveLength(3))
    expect(screen.queryByText(/not installed here/)).not.toBeInTheDocument()
    for (const name of [/Enable LightRAG/, /Enable DeepEval/, /Enable Prism Gateway/]) {
      expect(screen.getByRole('switch', { name })).toHaveAttribute('aria-disabled', 'false')
    }
  })

  it('says what switching LightRAG on costs, and that note text stays local', async () => {
    renderSettings()
    await waitFor(() => expect(screen.getAllByText(/included with the app/)).toHaveLength(3))
    expect(screen.getByText(/built on your local model only/)).toBeInTheDocument()
    expect(screen.getByText(/the first run reads every note/)).toBeInTheDocument()
  })

  // The daemon speaks HTTP to a provider; a primary that runs through its own
  // command-line tool is spawned in-process, so the engine never uses the
  // daemon for it. The row says so instead of implying the switch does something.
  it('says when the daemon is not used: the primary runs through a command-line tool', async () => {
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({
        engineFlags: { deepeval: false, lightrag: true, bifrost: true },
        providers: [{ id: 'claude-cli', enabled: true, primary: true }],
      }),
    )
    renderSettings()
    await waitFor(() => expect(screen.getAllByText(/included with the app/)).toHaveLength(3))
    expect(screen.getByText(/not used right now/)).toBeInTheDocument()
    // …so LightRAG is not sitting out either, and the note saying it does is not shown.
    expect(screen.queryByText(/LightRAG sits out/)).not.toBeInTheDocument()
  })

  it('warns that LightRAG sits out only when the daemon is really in use', async () => {
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({ engineFlags: { deepeval: false, lightrag: true, bifrost: true } }),
    )
    renderSettings()
    await waitFor(() => expect(screen.getAllByText(/included with the app/)).toHaveLength(3))
    expect(screen.getByText(/LightRAG sits out/)).toBeInTheDocument()
    expect(screen.queryByText(/not used right now/)).not.toBeInTheDocument()
  })

  it('no longer says the two libraries cannot be on together', () => {
    expect(readFileSync('src/pages/Settings.tsx', 'utf8')).not.toMatch(/use different runtimes/)
  })
})
