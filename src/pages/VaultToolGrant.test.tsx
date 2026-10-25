import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'
import { withVaultGranted } from '../lib/nativeEngine'

// The held-by-default finding (2026-08-05 audit). The app ships mcpApproval
// 'ask', which writes the `all` sentinel into <vault>/mcp-approvals.json and
// therefore threads `--require-approval all` — so the engine's ApprovalGate held
// EVERY tool call, including the companion's own vault tools. The companion
// could not read a single note without a manual approval per call: it burned its
// tool budget on holds and then reported itself blind, which is the exact
// blindness the vault tools were built to end.
//
// The fix is a pre-grant, not a weaker gate: the four vault tools are read-only
// (no write/rename/delete exists in the source) and, since the vault egress
// floor, zero-egress — so granting them costs nothing. mcp/web tools reach the
// network and the user's own servers, and MUST stay held.
//
// Both writers of that file are covered here: the onboarding Tools card
// (CompanionGrants.chooseMcp) and the revocable Settings posture control.

const writeApprovals = vi.hoisted(() =>
  vi.fn(async (_vault: string, _policy: { require: string[]; granted: string[] }) => true),
)
const readApprovals = vi.hoisted(() =>
  vi.fn(async () => ({ require: ['files'], granted: ['files', 'echo·add'] })),
)

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    resolveVaultDir: async () => '/resolved-vault',
    readMcpApprovals: readApprovals,
    writeMcpApprovals: writeApprovals,
    readMcpServers: async () => [],
    writeMcpServers: async () => true,
    runNativeMcpList: async () => ({ ok: false as const, error: 'not native in tests' }),
    sendTelegram: async () => null,
    checkExtensions: async () => ({}),
    readTrainingCount: async () => 0,
  }
})

// Imported AFTER the mock so both pages see the stubbed native edge.
const CompanionGrants = (await import('./CompanionGrants')).default
const Settings = (await import('./Settings')).default

function renderPage(node: React.ReactElement, route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SettingsProvider>
        <OnboardingProvider>{node}</OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

/** The policy the page actually persisted on its last write. */
function lastWrite() {
  const calls = writeApprovals.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][1]
}

describe('withVaultGranted — the union rule itself', () => {
  it('adds the vault server while preserving every other granted name, in order', () => {
    expect(withVaultGranted(['files', 'echo·add'])).toEqual(['files', 'echo·add', 'vault'])
  })

  it('is idempotent — a policy already granting vault is returned unchanged', () => {
    const already = ['vault', 'files']
    expect(withVaultGranted(already)).toBe(already)
  })

  it('grants the vault SERVER, never the "all" sentinel (mcp/web stay held)', () => {
    expect(withVaultGranted([])).toEqual(['vault'])
  })
})

describe('CompanionGrants — the Tools card pre-grants the vault source', () => {
  beforeEach(() => {
    localStorage.clear()
    writeApprovals.mockClear()
    readApprovals.mockClear()
  })
  afterEach(() => localStorage.clear())

  async function chooseTools(label: string) {
    renderPage(<CompanionGrants />, '/companion-grants')
    fireEvent.click(screen.getByText('Grant — build real files'))
    fireEvent.click(screen.getByText('Deny — stay offline'))
    fireEvent.click(screen.getByText('Deny — hands off the machine'))
    fireEvent.click(screen.getByText('Deny — no commands'))
    await waitFor(() => expect(screen.getByText(label)).not.toBeDisabled())
    fireEvent.click(screen.getByText(label))
    await waitFor(() => expect(writeApprovals).toHaveBeenCalled())
  }

  it('"Ask me first" still holds every other tool, but not the vault', async () => {
    await chooseTools('Ask me first (recommended)')
    const policy = lastWrite()
    // The gate is NOT weakened: the sentinel that holds mcp/web is still written.
    expect(policy.require).toContain('all')
    expect(policy.require).toContain('files') // the user's curated name survives
    // ...and the companion's own eyes are pre-granted.
    expect(policy.granted).toContain('vault')
    expect(policy.granted).toEqual(expect.arrayContaining(['files', 'echo·add']))
  })

  it('"Ask me first" pre-grants the READ-ONLY CLASS, so a first session is not spent approving reads', async () => {
    // A new install must start where the 2026-08-17 migration puts an existing
    // one: reading runs, acting waits. The mount migration would not reach a
    // policy written AFTER the app mounted, so the wizard sets it itself —
    // otherwise a first session burns its wakes on prompts for vault/web reads.
    await chooseTools('Ask me first (recommended)')
    const policy = lastWrite()
    expect(policy.granted).toContain('read-only')
    expect(policy.require).toContain('all') // the acting gate is NOT weakened
    expect(policy.require).not.toContain('read-only')
  })

  it('"Allow within the gates" drops only the sentinel and keeps the pre-grant', async () => {
    await chooseTools('Allow within the gates')
    const policy = lastWrite()
    expect(policy.require).not.toContain('all')
    expect(policy.require).toContain('files')
    expect(policy.granted).toContain('vault')
  })
})

describe('Settings — the Tools posture control pre-grants the vault source', () => {
  beforeEach(() => {
    localStorage.clear()
    writeApprovals.mockClear()
    readApprovals.mockClear()
    // The Tools card only renders its real controls in the installed app.
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    localStorage.clear()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('toggling the posture writes vault into granted and preserves the rest', async () => {
    renderPage(<Settings />, '/settings')
    const toggle = await screen.findByRole('switch', { name: /ask before tool calls/i })
    fireEvent.click(toggle)
    await waitFor(() => expect(writeApprovals).toHaveBeenCalled())

    const policy = lastWrite()
    expect(policy.granted).toContain('vault')
    expect(policy.granted).toEqual(expect.arrayContaining(['files', 'echo·add']))
    expect(policy.require).toContain('files')
  })
})
