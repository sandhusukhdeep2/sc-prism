import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider, useConnectivity } from '../lib/connectivity'
import { AppProvider, UNIVERSAL, connectivityErrorText, timeoutErrorText, useApp,
  chatWallMs,
} from './AppStore'
import type { ServiceHealth } from '../lib/connectivity'

// Hoisted spies for the two seams sendIntent's native chat path drives.
const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
  cancelEngineRun: vi.fn(async () => {}),
}))

// Native chat path is the subject: force native, stub the vault/note side-
// effects, and make the engine call + cancel observable. `storeGet` is left
// PENDING on purpose so SettingsProvider never flips `hydrated` → the
// connectivity cold-probe (a real network ping) never runs and health stays
// empty. That isolates the ONLY writer of health in this flow: sendIntent's
// markUnreachable — which is exactly what the honesty fix must (not) call.
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    appendChatNote: async () => {},
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    runNativeTask: h.runNativeTask,
    cancelEngineRun: h.cancelEngineRun,
  }
})

const captured: { app?: ReturnType<typeof useApp>; health?: Record<string, ServiceHealth> } = {}
function Capture() {
  captured.app = useApp()
  captured.health = useConnectivity().health
  return null
}

function renderApp() {
  return render(
    <SettingsProvider>
      <ConnectivityProvider>
        <AppProvider>
          <Capture />
        </AppProvider>
      </ConnectivityProvider>
    </SettingsProvider>,
  )
}

function errorText(): string | undefined {
  const msgs = captured.app!.state.threads[UNIVERSAL] ?? []
  return msgs.find((m) => m.kind === 'error')?.text
}

describe('sendIntent honesty — timeout vs genuine unreachable (native)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.cancelEngineRun.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('TIMEOUT → honest "took too long / stopped" copy, cancels the run, does NOT mark the provider unreachable', async () => {
    // A run that never settles: only the client wall can end the race.
    h.runNativeTask.mockImplementation(() => new Promise(() => {}))
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      const p = captured.app!.sendIntent('hello there')
      await vi.advanceTimersByTimeAsync(chatWallMs({ stallMs: 0 } as never) + 1_000)
      await p
    })

    // Honest timeout copy — NOT the "unreachable — nothing was sent" lie.
    expect(errorText()).toBe(timeoutErrorText('Local model'))
    // The real cancel fired for the abandoned subprocess.
    expect(h.cancelEngineRun).toHaveBeenCalled()
    // A slow provider is NOT a down provider: connectivity must stay clean.
    expect(captured.health!['local']?.status).not.toBe('unreachable')
  })

  it('GENUINE null from the engine → "unreachable — nothing was sent", marks the provider unreachable, no cancel', async () => {
    // The engine returns null immediately (real error / offline) — not a timeout.
    h.runNativeTask.mockResolvedValue(null)
    renderApp()
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await captured.app!.sendIntent('hello there')
    })

    expect(errorText()).toBe(connectivityErrorText('Local model', 'unreachable'))
    // A genuine error DID trip connectivity state (gates the next send).
    expect(captured.health!['local']?.status).toBe('unreachable')
    // Nothing timed out, so no subprocess cancel was issued.
    expect(h.cancelEngineRun).not.toHaveBeenCalled()
  })
})
