import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import LearningPanel from './LearningPanel'
import { SettingsProvider } from '../lib/settings'

// LearningPanel (P4-1) — the honest "Run learning step" panel, extracted from
// Stats so it can be shared with the first-class Training page. Self-contained
// (reads settings itself), so only SettingsProvider is needed in the wrapper.

// Native bridges: nativeEngine.ts calls the Tauri path plugin (for
// resolveVaultDir's default-vault-dir path) and `invoke` (for
// read_training_count / run_engine_train). Mocked so the native-path tests
// below can drive real records/decisions without a real Tauri IPC bridge.
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/fake/appdata',
  homeDir: async () => '/fake/home',
  join: async (...parts: string[]) => parts.filter(Boolean).join('/'),
}))

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

function renderPanel() {
  return render(
    <SettingsProvider>
      <LearningPanel />
    </SettingsProvider>,
  )
}

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

describe('LearningPanel — browser (no native shell)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('shows the honest browser note instead of a training-record count', () => {
    renderPanel()

    expect(screen.getByText(/training runs in the installed app/i)).toBeInTheDocument()
    // No control is even offered without the native engine — no fake button state.
    expect(screen.queryByRole('button', { name: /run learning step/i })).not.toBeInTheDocument()
  })

  it('never renders a fabricated training-record figure or fake decision', () => {
    renderPanel()

    // The old Memory-page fabrications must never leak into this shared panel.
    expect(screen.queryByText(/\+0\.03/)).not.toBeInTheDocument()
    expect(screen.queryByText(/1300/)).not.toBeInTheDocument()
    expect(screen.queryByText(/PROMOTED/)).not.toBeInTheDocument()
  })

  it('keeps the dry-run disclosure in the header', () => {
    renderPanel()
    expect(screen.getByText(/dry run, never auto-promotes/i)).toBeInTheDocument()
  })
})

describe('LearningPanel — native shell (real record count + decision)', () => {
  beforeEach(() => {
    localStorage.clear()
    goNative()
    invokeMock.mockReset()
  })

  afterEach(() => {
    localStorage.clear()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('disables the button and shows an honest empty state when there are 0 training records', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_training_count') return 0
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    renderPanel()

    const btn = await screen.findByRole('button', { name: /run learning step/i })
    await waitFor(() => expect(btn).toBeDisabled())
    expect(screen.getByText(/not enough training records yet/i)).toBeInTheDocument()
  })

  it('enables the button once a real (non-zero) record count loads', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_training_count') return 42
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    renderPanel()

    expect(await screen.findByText('42')).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: /run learning step/i })
    await waitFor(() => expect(btn).not.toBeDisabled())
  })

  it('running the learning step shows only the REAL decision/lift from the engine response', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_training_count') return 42
      if (cmd === 'run_engine_train') {
        return JSON.stringify({
          records: 42,
          decision: 'PROMOTE',
          promoted: false,
          gate: { lift: 0.07, decision: 'PROMOTE', promote: true, reason: 'beats goldens' },
        })
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    renderPanel()

    const btn = await screen.findByRole('button', { name: /run learning step/i })
    await waitFor(() => expect(btn).not.toBeDisabled())
    fireEvent.click(btn)

    // Honest verdict color: a PROMOTE win reads as a win (ok), not a colorless no-op.
    expect(await screen.findByText('PROMOTE')).toHaveClass('learnpanel__decision--promote')
    expect(screen.getAllByText(/lift 0\.07/).length).toBeGreaterThan(0)
    // Still never the fabricated Memory-page figures.
    expect(screen.queryByText(/\+0\.03/)).not.toBeInTheDocument()
    expect(screen.queryByText(/1300/)).not.toBeInTheDocument()
  })
})

// LF-2 — the human-gated "Adopt this router" flow. The dry run stays the
// preview; adopting runs the engine WITHOUT --dry-run (the golden gate still
// decides). The adopted router is shown honestly from current.json.
describe('LearningPanel — LF-2 adopt flow (native shell)', () => {
  beforeEach(() => {
    localStorage.clear()
    goNative()
    invokeMock.mockReset()
  })

  afterEach(() => {
    localStorage.clear()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('shows the honest empty adopted-router state when no current.json exists', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_training_count') return 42
      if (cmd === 'read_vault_file') throw new Error('no such file') // none adopted
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    renderPanel()

    expect(
      await screen.findByText(/no learned router adopted yet — routing uses the built-in rules/i),
    ).toBeInTheDocument()
  })

  it('renders the currently-adopted router parsed from current.json (route-policy kind)', async () => {
    // Bifrost OFF so the honest line is just the adopted version (no daemon note).
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({ engineFlags: { bifrost: false }, engineFlagsTouched: true }),
    )
    invokeMock.mockImplementation(async (cmd: string, args?: { relpath?: string }) => {
      if (cmd === 'read_training_count') return 42
      if (cmd === 'read_vault_file') {
        if (args?.relpath === 'training/models/current.json') {
          return JSON.stringify({ version: 'v3', previous: 'v2', updated: '2026-07-23T09:00:00Z' })
        }
        if (args?.relpath === 'training/models/v3/weights.json') {
          return JSON.stringify({ kind: 'route-policy', logits: {} })
        }
        throw new Error('no such file')
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    renderPanel()

    expect(await screen.findByText(/adopted router: v3/i)).toBeInTheDocument()
    // No Bifrost caveat when the daemon is off.
    expect(screen.queryByText(/not applied to bifrost routing/i)).not.toBeInTheDocument()
    // And never the dishonest "runtime doesn't use it" for a real route-policy.
    expect(screen.queryByText(/runtime doesn't use it/i)).not.toBeInTheDocument()
  })

  // LF-fix F: current.json alone is not enough — only a route-policy snapshot is
  // actually consulted by the runtime Gateway. An llm-policy snapshot must NOT be
  // presented as an active adoption.
  it('does not claim active adoption for a non-route-policy (llm-policy) snapshot', async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { relpath?: string }) => {
      if (cmd === 'read_training_count') return 42
      if (cmd === 'read_vault_file') {
        if (args?.relpath === 'training/models/current.json') {
          return JSON.stringify({ version: 'v7', updated: '2026-07-23' })
        }
        if (args?.relpath === 'training/models/v7/weights.json') {
          return JSON.stringify({ kind: 'llm-policy', logits: {} })
        }
        throw new Error('no such file')
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    renderPanel()

    expect(
      await screen.findByText(/exists but the runtime doesn't use it/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/adopted router: v7/i)).not.toBeInTheDocument()
  })

  // LF-fix F: with the Bifrost flag on, the Go daemon routes and the adopted
  // router is not consulted — the line must say so honestly.
  it('notes an adopted route-policy does not apply when Bifrost routing is on', async () => {
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({ engineFlags: { bifrost: true }, engineFlagsTouched: true }),
    )
    invokeMock.mockImplementation(async (cmd: string, args?: { relpath?: string }) => {
      if (cmd === 'read_training_count') return 42
      if (cmd === 'read_vault_file') {
        if (args?.relpath === 'training/models/current.json') {
          return JSON.stringify({ version: 'v3', updated: '2026-07-23' })
        }
        if (args?.relpath === 'training/models/v3/weights.json') {
          return JSON.stringify({ kind: 'route-policy', logits: {} })
        }
        throw new Error('no such file')
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    renderPanel()

    expect(
      await screen.findByText(/not applied to bifrost routing/i),
    ).toBeInTheDocument()
  })

  it('offers no Adopt button before any run, nor after a DISCARD', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_training_count') return 42
      if (cmd === 'read_vault_file') throw new Error('no such file')
      if (cmd === 'run_engine_train') {
        return JSON.stringify({
          records: 42,
          decision: 'DISCARD',
          promoted: false,
          gate: { lift: -0.01, decision: 'DISCARD', promote: false, reason: 'no lift' },
        })
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    renderPanel()

    const runBtn = await screen.findByRole('button', { name: /run learning step/i })
    // Never offered before a result.
    expect(screen.queryByRole('button', { name: /adopt this router/i })).not.toBeInTheDocument()
    await waitFor(() => expect(runBtn).not.toBeDisabled())
    fireEvent.click(runBtn)

    expect(await screen.findByText(/kept the current router/i)).toBeInTheDocument()
    // A DISCARD is a muted no-change, never painted like a win.
    expect(screen.getByText('DISCARD')).toHaveClass('learnpanel__decision--discard')
    // A DISCARD leaves nothing worth adopting — still no button.
    expect(screen.queryByRole('button', { name: /adopt this router/i })).not.toBeInTheDocument()
  })

  it('offers Adopt after PROMOTE; adopting calls the apply bridge and shows the real outcome + refreshed version', async () => {
    // Bifrost OFF so the refreshed adopted line is the clean version string.
    localStorage.setItem(
      'scprism.settings',
      JSON.stringify({ engineFlags: { bifrost: false }, engineFlagsTouched: true }),
    )
    let adopted = false
    invokeMock.mockImplementation(async (cmd: string, args?: { relpath?: string }) => {
      if (cmd === 'read_training_count') return 42
      if (cmd === 'read_vault_file') {
        if (!adopted) throw new Error('no such file') // none adopted at mount
        if (args?.relpath === 'training/models/current.json') {
          return JSON.stringify({ version: 'v4', updated: '2026-07-23' })
        }
        if (args?.relpath === 'training/models/v4/weights.json') {
          return JSON.stringify({ kind: 'route-policy', logits: {} })
        }
        throw new Error('no such file')
      }
      if (cmd === 'run_engine_train') {
        return JSON.stringify({
          records: 42,
          decision: 'PROMOTE',
          promoted: false,
          gate: { lift: 0.07, decision: 'PROMOTE', promote: true, reason: 'beats goldens' },
        })
      }
      if (cmd === 'run_engine_train_apply') {
        adopted = true // the engine rewrote current.json -> v4
        return JSON.stringify({
          records: 42,
          decision: 'PROMOTE',
          promoted: true,
          version: 'v4',
          gate: { lift: 0.07, decision: 'PROMOTE', promote: true, reason: 'beats goldens' },
        })
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })

    renderPanel()

    const runBtn = await screen.findByRole('button', { name: /run learning step/i })
    await waitFor(() => expect(runBtn).not.toBeDisabled())
    fireEvent.click(runBtn)

    const adoptBtn = await screen.findByRole('button', { name: /adopt this router/i })
    // The verbatim honest scope disclosure sits with the adopt button — now also
    // scoping the adopted router to Auto-route mode (R1).
    expect(
      screen.getByText(/only takes effect in Auto-route mode — sensitive work always stays local; a pinned primary always wins/i),
    ).toBeInTheDocument()

    fireEvent.click(adoptBtn)

    // The REAL apply outcome — a persisted adoption, not a dry preview.
    expect(
      await screen.findByText(/adopted — the trained router beat the goldens/i),
    ).toBeInTheDocument()
    // The adopted-router line refreshed from the rewritten current.json.
    expect(await screen.findByText(/adopted router: v4/i)).toBeInTheDocument()
    // Honesty: never claims the model learned / fine-tuned.
    expect(screen.queryByText(/fine-tune/i)).not.toBeInTheDocument()

    // LF-fix H: after a successful adopt the button is DISABLED (relabelled
    // "Adopted") so a re-click can't re-train + mint another identical version.
    const adoptedBtn = await screen.findByRole('button', { name: /^adopted$/i })
    expect(adoptedBtn).toBeDisabled()
  })
})
