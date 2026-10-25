// The LIVE AGENT card — 2026-08-16 honesty pass, Finding 1.
//
// WHY THIS FILE LOOKS LIKE THIS. The old version of this test rendered
// `<AgentCard a={sample} />` against a hand-built literal, so it passed
// forever while the card was DEAD on the real screen: its only input was a
// store slice whose sole producer was the simulator, unreachable on a native
// install with a real primary. The panel was empty 100% of the time, sitting
// directly under the glowing live-run cards.
//
// So every assertion here goes through the REAL store: a run is registered the
// way the app registers one (`beginLiveRun`), the spans come back from a
// mocked `readSpansTail` exactly as the engine writes them, and the card is
// read out of the rendered Work page. A literal is never constructed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Workspace from '../pages/Workspace'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'
import { getProjects, removeProject } from '../lib/projects'
import type { EngineSpan } from '../lib/nativeEngine'

const h = vi.hoisted(() => ({ readSpansTail: vi.fn(async () => [] as EngineSpan[]) }))

// Native (the span tail only runs there). `storeGet` stays PENDING so settings
// never hydrate and the connectivity cold-probe never fires — the same
// isolation Workspace.liveSignals.test.tsx uses.
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

async function mounted() {
  const view = render(
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
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return view
}

// UPDATED (visual system v2, 2026-08-18). These four assertions used to read
// `.agentcard` — the live-agent panel in the Work page's right rail. The v2
// rebuild retires that rail on the Universal thread: "who is on this run" is
// now the LIVE RUN CARD (kind · intent · elapsed, glowing only while the run
// executes) with the CREW BOARD beneath it (a monogram per agent, tinted by
// its own model, `provider · model` in mono). `<AgentCard>` itself is NOT
// deleted — the Editor still renders it, and its own honesty rules are
// unchanged — so nothing here is dropped: every claim these tests protected is
// re-asserted against the surface that now carries it.
const liveCard = (): HTMLElement | null => document.querySelector('.lrun__card')
const board = (): HTMLElement | null => document.querySelector('.crew')

describe('Live agent surface — real runs only', () => {
  beforeEach(() => {
    localStorage.clear()
    h.readSpansTail.mockReset()
    h.readSpansTail.mockResolvedValue([])
  })
  afterEach(() => {
    for (const p of getProjects().projects) removeProject(p.id)
    localStorage.clear()
  })

  it('renders the REAL agent + model of a genuinely running task, with elapsed time', async () => {
    // A real model_call span of the run about to start (the engine writes
    // these; agentOrbs is what every other live surface reads them with).
    h.readSpansTail.mockResolvedValue([
      {
        name: 'model_call',
        type: 'model_call',
        status: 'ok',
        start: (Date.now() + 1_000) / 1000,
        attrs: { agent: 'implementer', provider: 'openai', model: 'gpt-4o' },
      },
    ])
    await mounted()

    await act(async () => {
      captured.app!.beginLiveRun({ kind: 'chat', intent: 'add a rate-limit guard to the uploader' })
    })
    await act(async () => {
      await Promise.resolve()
    })

    const live = liveCard()!.textContent ?? ''
    expect(live).toContain('implementer') // the span's agent, not a role we invented
    expect(live).toContain('gpt-4o') // the model that really answered
    expect(live).toContain('add a rate-limit guard to the uploader')
    expect(live).toMatch(/\d+:\d\d/) // elapsed, a real clock over a real start
    // …and the board says the same two facts in the v2 language.
    const crew = board()!.textContent ?? ''
    expect(crew).toContain('implementer')
    expect(crew).toContain('openai · gpt-4o')
    // The fabrications are gone: no progress bar, no percentage, no token burn.
    expect(live).not.toContain('%')
    expect(document.querySelector('.agentcard__bar')).toBeNull()
  })

  it('with no span yet it names the KIND of run and claims NO model call', async () => {
    await mounted()
    await act(async () => {
      captured.app!.beginLiveRun({ kind: 'manager', intent: 'Vault health' })
    })

    const live = liveCard()!.textContent ?? ''
    expect(live).toContain('manager')
    expect(live).toContain('Vault health')
    // The old card said "no model call reported yet" in words. The v2 surfaces
    // say it by claiming nothing at all: no model chip on the card, and no
    // board (no crew → no pipeline). Strictly stronger, same promise.
    expect(document.querySelector('.lrun__model')).toBeNull()
    expect(board()).toBeNull()
  })

  it('a run PARKED on the user is not shown as executing — nothing is behind it', async () => {
    await mounted()
    let id = ''
    await act(async () => {
      id = captured.app!.beginLiveRun({ kind: 'project', intent: 'build the dashboard' })
    })
    expect(liveCard()!.className).toContain('lrun__card--glow')

    await act(async () => {
      captured.app!.pauseLiveRun(id, true)
    })
    expect(liveCard()!.className).not.toContain('lrun__card--glow')
    expect(liveCard()!.className).toContain('lrun__card--paused')
    expect(screen.getByText('waiting on you')).toBeInTheDocument()
    // and the board says WHAT it is waiting for, without one glowing monogram
    expect(document.querySelector('.crew__mono--pulse')).toBeNull()
    expect(screen.getByText('Waiting on your answer')).toBeInTheDocument()
  })

  it('nothing running → the honest empty state, and no elapsed clock', async () => {
    await mounted()
    expect(liveCard()).toBeNull()
    expect(board()).toBeNull()
    expect(document.querySelector('.agentcard__elapsed')).toBeNull()
    // The Work page says, in the ledger, that it has measured nothing yet.
    expect(screen.getByText(/no runs yet — your first run's story lands here/)).toBeInTheDocument()
  })
})

// The dead slice must not come back — not on the Work page, not in the Editor,
// not in the store. Same discipline as the deleted loop simulator's sweep in
// Automations.test.tsx: a source-tree scan, because a UI assertion against a
// literal is exactly what failed to catch this for weeks.
describe('the simulator-only live-agent slice is gone from the source tree', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full)
    }
  }
  walk('src')

  const offendersMatching = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, 'utf8')))

  it('no liveAgents / SET_AGENTS symbol survives anywhere in src/', () => {
    expect(offendersMatching(/\bliveAgents\b|\bSET_AGENTS\b/)).toEqual([])
  })

  it('no toAgentView (the burn/eval/progress fabricator) survives in src/', () => {
    expect(offendersMatching(/\btoAgentView\b/)).toEqual([])
  })
})
