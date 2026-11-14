// STOP, FOR ONE AI ANSWERING (2026-11-15), through the real store.
//
// A team run and a build show their Stop on the board. One AI answering a
// message is not drawn there — its bubble says it is thinking — so its Stop
// is where the answer was asked for: while it answers, Send is Stop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import type { Verdict } from '../engine/types'

const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
  cancelEngineRun: vi.fn(async (_id: string) => {}),
}))

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    expandUserPath: async (p: string) => p.replace(/^~/, '/Users/test'),
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
    readSpansTail: async () => [],
    appendChatNote: async () => {},
    appendVaultNote: async () => '/vault/conversations/x.md',
    readVaultFile: async () => null,
    writeVaultNote: async () => '/vault/note.md',
    runNativeTask: h.runNativeTask,
    cancelEngineRun: h.cancelEngineRun,
  }
})

const captured: { app?: ReturnType<typeof useApp> } = {}
function Capture() {
  captured.app = useApp()
  return null
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Capture />
              <Workspace />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

async function settle(n = 30) {
  await act(async () => {
    for (let i = 0; i < n; i++) await Promise.resolve()
  })
}

function connected() {
  localStorage.setItem(
    'scprism.settings',
    JSON.stringify({
      providers: [
        { id: 'claude-cli', name: 'Claude', baseUrl: '', apiKey: '', enabled: true, primary: true, connected: true },
      ],
    }),
  )
}

describe('Work composer — Stop while one AI answers', () => {
  beforeEach(() => {
    localStorage.clear()
    connected()
    h.runNativeTask.mockReset()
    h.cancelEngineRun.mockReset()
    h.cancelEngineRun.mockImplementation(async () => {})
  })
  afterEach(() => localStorage.clear())

  it('Send becomes Stop while the answer is being written, and Stop ends it', async () => {
    let killed: (v: Verdict | null) => void = () => {}
    h.runNativeTask.mockImplementation(() => new Promise<Verdict | null>((res) => (killed = res)))
    h.cancelEngineRun.mockImplementation(async () => killed(null))
    renderWorkspace()
    await settle()
    expect(screen.queryByRole('button', { name: 'Stop this answer' })).toBeNull()

    // A greeting: one AI answers it, no team is staffed.
    fireEvent.change(screen.getByRole('textbox', { name: /describe/i }), {
      target: { value: 'hello, are you there?' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    await settle(40)
    expect(h.runNativeTask).toHaveBeenCalledTimes(1)
    const stop = screen.getByRole('button', { name: 'Stop this answer' })
    expect(stop.textContent).toBe('Stop')
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()

    await act(async () => {
      fireEvent.click(stop)
    })
    await settle(40)
    expect(h.cancelEngineRun).toHaveBeenCalledTimes(1)
    // The answer is over: Send is back, and the room said what happened.
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop this answer' })).toBeNull()
    expect(screen.getByText('Stopped by you — no answer was written.')).toBeTruthy()
  })

  it('Stop is asked once: a second press before the engine has gone does nothing', async () => {
    h.runNativeTask.mockImplementation(() => new Promise<Verdict | null>(() => {}))
    renderWorkspace()
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: /describe/i }), {
      target: { value: 'hello, are you there?' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    await settle(40)
    const stop = screen.getByRole('button', { name: 'Stop this answer' })
    await act(async () => {
      fireEvent.click(stop)
    })
    const stopping = screen.getByRole('button', { name: 'Stopping this answer' }) as HTMLButtonElement
    expect(stopping.disabled).toBe(true)
    expect(stopping.textContent).toBe('Stopping…')
    await act(async () => {
      fireEvent.click(stopping)
    })
    expect(h.cancelEngineRun).toHaveBeenCalledTimes(1)
  })
})
