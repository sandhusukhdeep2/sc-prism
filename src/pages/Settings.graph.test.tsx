import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from './Settings'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

// 2026-11-11: LightRAG's graph is built by an explicit step, never inside a
// run (it reads every note through the local model — minutes). The Settings
// row says whether the graph is built and offers the build.
const h = vi.hoisted(() => ({
  graphIndexStatus: vi.fn(),
  runGraphIndex: vi.fn(),
}))

vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    readMcpServers: async () => [],
    readMcpApprovals: async () => ({ require: [], granted: [] }),
    checkExtensions: async () => ({ deepeval: true, lightrag: true, llm: false, bifrost: true }),
    readTrainingCount: async () => 0,
    graphIndexStatus: h.graphIndexStatus,
    runGraphIndex: h.runGraphIndex,
  }
})

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings?section=capabilities']}>
      <SettingsProvider>
        <OnboardingProvider>
          <Settings />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Settings — the graph index is built by its own step', () => {
  beforeEach(() => {
    localStorage.clear()
    h.graphIndexStatus.mockReset()
    h.runGraphIndex.mockReset()
  })
  afterEach(() => localStorage.clear())

  it('says the graph is not built yet and what answers until it is', async () => {
    h.graphIndexStatus.mockResolvedValue({ ready: false, docs: 0, built_at: 0, notes: 45, available: true })
    renderSettings()
    expect(await screen.findByText(/graph not built yet/)).toBeInTheDocument()
    expect(screen.getByText(/the built-in recall answers until it is/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Build the graph index' })).toBeInTheDocument()
  })

  it('building says it is working, then reports what was built', async () => {
    h.graphIndexStatus.mockResolvedValueOnce({ ready: false, docs: 0, built_at: 0, notes: 45, available: true })
    let finish: (v: unknown) => void = () => {}
    h.runGraphIndex.mockImplementation(() => new Promise((res) => { finish = res }))
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Build the graph index' }))
    expect(await screen.findByText(/reading your notes on your local model/)).toBeInTheDocument()
    expect(h.runGraphIndex).toHaveBeenCalledTimes(1)
    expect(h.runGraphIndex.mock.calls[0][0]).toBe('/vault')
    h.graphIndexStatus.mockResolvedValue({ ready: true, docs: 45, built_at: 1_800_000_000, notes: 45, available: true })
    await act(async () => {
      finish({ ok: true, docs: 45, model_calls: 120, seconds: 600 })
      await Promise.resolve()
    })
    expect(await screen.findByText(/graph built from 45 notes/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rebuild' })).toBeInTheDocument()
  })

  it('a build that could not run says why, in the engine’s words', async () => {
    h.graphIndexStatus.mockResolvedValue({ ready: false, docs: 0, built_at: 0, notes: 45, available: true })
    h.runGraphIndex.mockResolvedValue({ ok: false, reason: 'the local model did not answer, so nothing was indexed' })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Build the graph index' }))
    expect(await screen.findByText(/the local model did not answer/)).toBeInTheDocument()
  })

  it('says when notes changed since the graph was built', async () => {
    h.graphIndexStatus.mockResolvedValue({ ready: true, docs: 40, built_at: 1_800_000_000, notes: 45, available: true })
    renderSettings()
    await waitFor(() => expect(screen.getByText(/graph built from 40 notes/)).toBeInTheDocument())
    expect(screen.getByText(/you have 45 now/)).toBeInTheDocument()
  })

  // A BUILD CAN BE STOPPED AND CONTINUED (2026-11-12). On a real vault a full
  // build on a local model was about ten minutes a note — thirteen hours for
  // 81 — and every start threw the earlier hours away.
  it('a build that was stopped says how far it got and offers to continue', async () => {
    h.graphIndexStatus.mockResolvedValue({
      ready: false, partial: true, indexed: 15, failed: 3, docs: 0, built_at: 0, notes: 81, available: true,
    })
    h.runGraphIndex.mockResolvedValue({ ok: true, docs: 81, model_calls: 10, seconds: 5 })
    renderSettings()
    expect(await screen.findByText(/15 of 81 notes are in the graph/)).toBeInTheDocument()
    expect(screen.getByText(/3 failed and will be tried again/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue the build' }))
    await waitFor(() => expect(h.runGraphIndex).toHaveBeenCalledTimes(1))
    // Continuing keeps what is there: it does not ask for a fresh start.
    expect(h.runGraphIndex.mock.calls[0][3]).toBe(false)
  })

  it('starting over is its own button, and asks for a fresh start', async () => {
    h.graphIndexStatus.mockResolvedValue({
      ready: false, partial: true, indexed: 15, failed: 0, docs: 0, built_at: 0, notes: 81, available: true,
    })
    h.runGraphIndex.mockResolvedValue({ ok: true, docs: 81, model_calls: 10, seconds: 5 })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Start over' }))
    await waitFor(() => expect(h.runGraphIndex).toHaveBeenCalledTimes(1))
    expect(h.runGraphIndex.mock.calls[0][3]).toBe(true)
  })

  it('rebuilding a finished graph starts from nothing — it is a rebuild', async () => {
    h.graphIndexStatus.mockResolvedValue({ ready: true, partial: false, indexed: 45, failed: 0, docs: 45, built_at: 1_800_000_000, notes: 45, available: true })
    h.runGraphIndex.mockResolvedValue({ ok: true, docs: 45, model_calls: 10, seconds: 5 })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Rebuild' }))
    await waitFor(() => expect(h.runGraphIndex).toHaveBeenCalledTimes(1))
    expect(h.runGraphIndex.mock.calls[0][3]).toBe(true)
  })

  it('a first build says plainly that it is long and can be stopped', async () => {
    h.graphIndexStatus.mockResolvedValue({ ready: false, partial: false, indexed: 0, failed: 0, docs: 0, built_at: 0, notes: 81, available: true })
    renderSettings()
    expect(
      await screen.findByText(/several model calls a note on your local model, so a large vault takes hours/),
    ).toBeInTheDocument()
    expect(screen.getByText(/You can stop it and continue later/)).toBeInTheDocument()
  })

  it('while it builds, it shows how many notes are in', async () => {
    h.graphIndexStatus.mockResolvedValue({ ready: false, partial: true, indexed: 15, failed: 0, docs: 0, built_at: 0, notes: 81, available: true })
    h.runGraphIndex.mockImplementation(() => new Promise(() => {}))
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Continue the build' }))
    expect(await screen.findByText(/15 of 81 notes in the graph so far/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })
})
