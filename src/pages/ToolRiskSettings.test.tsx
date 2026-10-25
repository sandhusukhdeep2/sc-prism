import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'
import { FIRST_PARTY_READ_ONLY, READ_ONLY_GRANT, readsRunFree } from '../lib/toolRisk'

// WHAT RUNS FREELY vs WHAT WAITS — the visible, reversible half of the risk
// classification (2026-08-17).
//
// "this software is asking for permission every time… again and again." The
// fix pre-grants the READ-ONLY class, so Settings must say so in his words and
// let him take it back. The rule these tests defend: A CAPABILITY SHOWN MUST BE
// THE ONE ENFORCED. The switch reads its state from the policy FILE — the same
// bytes the engine's gate reads — and writes the exact shape the gate honours.

const policyFile = vi.hoisted(() => ({
  current: { require: ['all'], granted: ['web_search', 'vault'] } as {
    require: string[]
    granted: string[]
  },
}))
const writeApprovals = vi.hoisted(() =>
  vi.fn(async (_vault: string, policy: { require: string[]; granted: string[] }) => {
    policyFile.current = policy
    return true
  }),
)

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    readMcpApprovals: async () => ({ ...policyFile.current }),
    writeMcpApprovals: writeApprovals,
    readMcpServers: async () => [],
    writeMcpServers: async () => true,
    runNativeMcpList: async () => ({ ok: false as const, error: 'not native in tests' }),
    readSpansTail: async () => [],
    checkExtensions: async () => ({}),
    readTrainingCount: async () => 0,
    sendTelegram: async () => null,
  }
})

const Settings = (await import('./Settings')).default

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

const READS_SWITCH = /let reading run without asking/i

describe('Settings — what runs freely vs what waits', () => {
  beforeEach(() => {
    localStorage.clear()
    writeApprovals.mockClear()
    policyFile.current = { require: ['all'], granted: ['web_search', 'vault'] }
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    localStorage.clear()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('shows the switch OFF while the policy still holds everything', async () => {
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: READS_SWITCH })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/Hold everything — ask before every tool/i)).toBeTruthy()
  })

  it('shows the switch ON — and NAMES what runs freely — under the migrated policy', async () => {
    policyFile.current = { require: ['all'], granted: ['vault', READ_ONLY_GRANT] }
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: READS_SWITCH })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    // Every freed tool is named on the page, straight from the enforced table —
    // the user can see exactly what he gave away.
    const shown = screen.getByText(/Runs freely:/i).parentElement?.textContent ?? ''
    for (const tool of [...FIRST_PARTY_READ_ONLY.vault, ...FIRST_PARTY_READ_ONLY.web]) {
      expect(shown).toContain(tool)
    }
    // …and what still waits, including the honest reason for MCP servers.
    expect(shown).toMatch(/Still waits for you/i)
    expect(shown).toMatch(/writes, sends, spends/i)
    expect(shown).toMatch(/every tool from every MCP server/i)
  })

  it('turning it ON writes the class grant and preserves every existing name', async () => {
    renderSettings()
    fireEvent.click(await screen.findByRole('switch', { name: READS_SWITCH }))
    await waitFor(() => expect(writeApprovals).toHaveBeenCalled())
    const written = writeApprovals.mock.calls[0][1]
    expect(readsRunFree(written)).toBe(true)
    expect(written.require).toEqual(['all']) // the ask-first posture is untouched
    expect(written.granted).toEqual(['web_search', 'vault', READ_ONLY_GRANT])
  })

  it('turning it OFF tightens back to hold-everything, and the choice STICKS', async () => {
    policyFile.current = { require: ['all'], granted: ['vault', READ_ONLY_GRANT] }
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: READS_SWITCH })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(toggle)
    await waitFor(() => expect(writeApprovals).toHaveBeenCalled())

    const written = writeApprovals.mock.calls[0][1]
    expect(readsRunFree(written)).toBe(false)
    // The require-side mark is what survives the next launch's migration.
    expect(written.require).toContain(READ_ONLY_GRANT)
    expect(written.granted).not.toContain(READ_ONLY_GRANT)
    expect(written.granted).toContain('vault') // his own grants are not touched
    // …and the page immediately tells the truth about the new state.
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    expect(screen.getByText(/Hold everything — ask before every tool/i)).toBeTruthy()
  })

  it('never weakens the ask-first gate itself (the `all` sentinel survives both ways)', async () => {
    renderSettings()
    fireEvent.click(await screen.findByRole('switch', { name: READS_SWITCH }))
    await waitFor(() => expect(writeApprovals).toHaveBeenCalled())
    expect(writeApprovals.mock.calls[0][1].require).toContain('all')
    expect(writeApprovals.mock.calls[0][1].granted).not.toContain('all')
  })
})
