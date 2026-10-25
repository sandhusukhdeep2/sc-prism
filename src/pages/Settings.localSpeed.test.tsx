import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'
import type { EngineSpan } from '../lib/nativeEngine'

// FIX 3 (2026-08-16) — the measured local-speed note.
//
// The user's project interview was cancelled at 187s because a vault read had
// pinned the run to a 60-70s-per-call local model, and he met that as a mystery
// failure: nothing in the app had ever told him his local model was minutes
// slow. This note states the measurement BEFORE he meets it. It is factual —
// real recorded span durations — and it renders only when the number actually
// threatens a budget, so a fast local model produces no noise at all.

const spans: EngineSpan[] = []

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    readSpansTail: async () => spans,
    // The rest of the page's mount effects must not reach a missing Tauri
    // shell. Shapes mirror the real bridge's, so the page mounts as it really
    // does — only the span tail is the fixture under test.
    checkExtensions: async () => ({ python: true, git: true, node: true }),
    readMcpServers: async () => [],
    readMcpApprovals: async () => ({ require: [] as string[], granted: [] as string[] }),
    readTrainingCount: async () => 0,
    runNativeMcpList: async () => [],
    withVaultGranted: async <T,>(_v: string, fn: () => Promise<T>) => fn(),
  }
})

function call(route: 'local' | 'cloud', model: string, ms: number): EngineSpan {
  return {
    name: 'model_call',
    type: 'model_call',
    duration_ms: ms,
    start: 1,
    attrs: { route, model, is_local: route === 'local' },
  }
}

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

describe('Settings — measured local speed', () => {
  beforeEach(() => {
    localStorage.clear()
    spans.length = 0
  })
  afterEach(() => localStorage.clear())

  it('states the measured numbers and the budget derived from them when local is slow', async () => {
    spans.push(call('local', 'Qwen3.8-27B-4bit', 115_000), call('local', 'Qwen3.8-27B-4bit', 295_000))
    renderSettings()

    const note = await screen.findByTestId('local-speed-note')
    expect(note.textContent).toContain('Qwen3.8-27B-4bit')
    expect(note.textContent).toContain('295s')
    expect(note.textContent).toContain('reads your vault stays on this model')
    expect(note.textContent).toMatch(/counts as stalled/)
    expect(note.textContent).toMatch(/hard ceiling/)
  })

  it('says nothing at all when the local model is fast — no advisory noise', async () => {
    spans.push(call('local', 'gemma-4-26b-a4b-it-4bit', 4_900), call('local', 'gemma-4-26b-a4b-it-4bit', 5_300))
    renderSettings()

    await waitFor(() => expect(screen.getAllByText('Local model').length).toBeGreaterThan(0))
    expect(screen.queryByTestId('local-speed-note')).toBeNull()
  })

  it('says nothing when nothing has been measured — no measurement, no claim', async () => {
    renderSettings()
    await waitFor(() => expect(screen.getAllByText('Local model').length).toBeGreaterThan(0))
    expect(screen.queryByTestId('local-speed-note')).toBeNull()
  })
})
