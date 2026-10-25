// Mission-control adversarial audit (2026-08-06) — the Work page's LIVE
// signals, end to end through the real store.
//
// Everything on this page that says "something is happening" — the glowing
// card, the console's live header, the narration strip, the orb pulse — must
// derive from runs that are genuinely EXECUTING. Three ways that was false:
//
//   H1  a build parked on "one more refine?" kept every one of them lit while
//       its engine subprocess had already exited (potentially all night);
//   M3  with two runs in flight the strip silently mixed both runs' steps;
//   M4  the orbs were built from the UNFILTERED span tail, so a background
//       heartbeat pulsed orbs reconstructed from the last team run in the file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Workspace from './Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import { addProject, removeProject, getProjects } from '../lib/projects'
import type { EngineSpan } from '../lib/nativeEngine'

const T0 = 1_700_000_000_000

// A finished team run already sitting in spans.jsonl — the "ghost" the orbs
// used to reconstruct and pulse under an unrelated live run.
const ghostSpans: EngineSpan[] = [
  {
    name: 'model_call',
    type: 'model_call',
    status: 'ok',
    start: (T0 - 600_000) / 1000,
    attrs: { agent: 'ghostwriter', provider: 'openai', model: 'gpt-4o' },
  },
]

const h = vi.hoisted(() => ({ readSpansTail: vi.fn(async () => [] as EngineSpan[]) }))

// Native (the console/orbs only render there). `storeGet` stays PENDING so
// SettingsProvider never hydrates and the connectivity cold-probe never runs —
// the same isolation AppStore.liveRuns.test.tsx uses.
vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    readSpansTail: h.readSpansTail,
    storeGet: () => new Promise<string | null>(() => {}),
    storeSet: async () => {},
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

/** Mount, let the span tail's first fetch land, and return the app handle. */
async function mounted() {
  const view = renderWorkspace()
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return view
}

describe('Work page live signals', () => {
  beforeEach(() => {
    localStorage.clear()
    h.readSpansTail.mockReset()
    h.readSpansTail.mockResolvedValue([])
  })
  afterEach(() => {
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
  })

  // H1 — the park.
  it('a PARKED run lights nothing: no glow, no live console, no narration strip', async () => {
    await mounted()
    let id = ''
    await act(async () => {
      id = captured.app!.beginLiveRun({ kind: 'project', intent: 'build the dashboard' })
    })
    // Executing: everything is lit, as it should be.
    //
    // UPDATED 2026-08-19: the page-level black "engine console · live" header
    // is gone — the console became a per-STEP detail you open on the step you
    // want, so there is no page-wide header left to assert. The page's live
    // signal is the run card's glow, which is what these lines now carry.
    expect(document.querySelector('.lrun__card--glow')).not.toBeNull()

    await act(async () => {
      captured.app!.pauseLiveRun(id, true)
    })

    // Parked: the card remains (it really does resume on the answer) but says
    // so, and NOTHING on the page claims work is happening.
    //
    // UPDATED (visual system v2, 2026-08-18): scoped to the live-run card. The
    // v2 board now ALSO names the parked run — in the black "Your call" column
    // that says what it is waiting for — so the intent legitimately appears
    // twice on the page. The claim under test is unchanged: this card still
    // carries the run and still says "waiting on you".
    const cards = document.querySelector('.lrun') as HTMLElement
    expect(within(cards).getByText('build the dashboard')).toBeInTheDocument()
    expect(within(cards).getByText('waiting on you')).toBeInTheDocument()
    expect(document.querySelector('.lrun__card--glow')).toBeNull()
    expect(document.querySelector('.chat__earlier--narrate')).toBeNull()

    // Answered: live again.
    await act(async () => {
      captured.app!.pauseLiveRun(id, false)
    })
    expect(document.querySelector('.lrun__card--glow')).not.toBeNull()
  })

  // M3 — two runs in flight.
  it('with 2 runs in flight the narration strip claims neither run’s steps', async () => {
    h.readSpansTail.mockResolvedValue([
      {
        name: 'tier1',
        type: 'tool_exec',
        status: 'ok',
        start: (Date.now() + 1_000) / 1000,
        attrs: { passed: true },
      },
    ])
    await mounted()
    await act(async () => {
      captured.app!.beginLiveRun({ kind: 'chat', intent: 'ask one' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText(/runs in flight/)).not.toBeInTheDocument()

    await act(async () => {
      captured.app!.beginLiveRun({ kind: 'team', intent: 'ask two' })
    })
    const strip = document.querySelector('.chat__narration')
    expect(strip?.textContent).toMatch(/2 runs in flight/)
    expect(strip?.textContent).toMatch(/see the task cards above/)
    // ...and no step is narrated as belonging to either run. The guarantee that
    // used to be doubled in the page-level console header is now structural:
    // `currentRunSpans` returns [] whenever 2+ runs are in flight, so there are
    // no spans for any step detail to draw in the first place.
    expect(screen.queryByText('your checks passed')).not.toBeInTheDocument()
    expect(document.querySelector('.crew')).toBeNull()
  })

  // M4 — the orbs.
  it('the orbs follow THIS run’s spans, never the stale tail, while a run is live', async () => {
    h.readSpansTail.mockResolvedValue(ghostSpans)
    const project = addProject('Dashboard', 'ship it', 'npm test')
    await mounted()
    await act(async () => {
      captured.app!.setActiveProject(project.id)
    })
    // Idle: the rail may show the last run's orbs — that is the honest
    // "last run" fallback and it does not pulse.
    expect(document.querySelector('.orb__dot--pulse')).toBeNull()

    // A heartbeat starts now. The ghost's spans predate it, so they are not
    // this run's — no orb may be reconstructed from them, and above all none
    // may pulse.
    await act(async () => {
      captured.app!.beginLiveRun({ kind: 'heartbeat', intent: 'a background beat' })
    })
    expect(screen.queryByText('ghostwriter')).not.toBeInTheDocument()
    expect(document.querySelector('.orb__dot--pulse')).toBeNull()
  })
})
