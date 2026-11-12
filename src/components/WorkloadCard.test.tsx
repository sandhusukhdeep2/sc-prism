import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import WorkloadCard from './WorkloadCard'
import { SettingsProvider } from '../lib/settings'
import type { Verdict } from '../engine/types'

// THE WORKLOAD SLIDER, as the owner asked for it (2026-11-12): "one slider that
// changes the dependency… primary AI just gives the instruction and checks the
// work… fix by your measurement first, but give the slider to the user. If the
// user wants to go all in with local, he can."
const STORE = 'scprism.settings'

function seed(over: Record<string, unknown> = {}) {
  localStorage.setItem(
    STORE,
    JSON.stringify({
      providers: [
        { id: 'claude-cli', name: 'Claude', baseUrl: '', apiKey: '', enabled: true, primary: true },
        { id: 'local', name: 'Local model', baseUrl: 'http://localhost:1234', apiKey: '', enabled: true, primary: false, model: 'qwen-local' },
        { id: 'gemini', name: 'Gemini', baseUrl: '', apiKey: 'g-real', enabled: true, primary: false },
      ],
      ...over,
    }),
  )
}

const stored = () => JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, unknown>

function judged(score: number, n: number): Verdict[] {
  return Array.from({ length: n }, (_, i) => ({
    taskId: `t-${i}`,
    passed: true,
    native: { models_used: ['local · qwen-local'] },
    tier2: { evalScore: score, passed: true, judge: 'j', trajectory: 'trajectory ok' },
  })) as unknown as Verdict[]
}

function show(verdicts: Verdict[] = [], localTokensPerSec?: number | null) {
  return render(
    <SettingsProvider>
      <WorkloadCard verdicts={verdicts} localTokensPerSec={localTokensPerSec} />
    </SettingsProvider>,
  )
}

const slider = () => screen.getByRole('slider', { name: /workload/i })
// The composer's team is the first group in the table; a project build's
// system agents can carry the same role names further down.
const seat = (role: string) =>
  within(screen.getAllByRole('row', { name: new RegExp(`^${role}\\b`) })[0])

describe('the workload slider', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('starts on the measurement — and with none, says why and moves nobody', () => {
    seed()
    show()
    expect(screen.getByRole('button', { name: 'Follow my measured runs' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/only 0 judged runs on your local model so far/)).toBeInTheDocument()
    // The default team is exactly as connected: nobody moved.
    expect(seat('lead').getByText('Claude')).toBeInTheDocument()
    expect(seat('researcher').getByText('Local model')).toBeInTheDocument()
    expect(seat('critic').getByText('Gemini')).toBeInTheDocument()
    expect(screen.queryByText(/^was /)).toBeNull()
  })

  it('with enough judged runs the measured stop is in force, with its evidence', () => {
    seed()
    show(judged(0.62, 14))
    expect(screen.getByText(/your local model averaged 0\.62 over 14 judged runs/)).toBeInTheDocument()
    expect(slider()).toHaveAttribute('aria-valuetext', 'Claude leads and checks')
    // Claude plans and checks; the critic moved off Gemini, and the card says so.
    expect(seat('critic').getByText('Claude')).toBeInTheDocument()
    expect(seat('critic').getByText('was Gemini')).toBeInTheDocument()
    // …and the measurement is cached where a run can read it.
    expect(stored().workloadMeasured).toBe('primary-leads')
  })

  it('dragging to the far end goes all in on local', () => {
    seed()
    show()
    fireEvent.change(slider(), { target: { value: '3' } })
    expect(stored().workload).toBe('local-all')
    expect(stored().routeBias).toBe('local')
    for (const role of ['lead', 'researcher', 'critic']) {
      expect(seat(role).getByText('Local model')).toBeInTheDocument()
    }
    expect(screen.getByText(/your own tests are the independent check/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Follow my measured runs' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('each stop says who plans, who does the work and who checks', () => {
    seed()
    show()
    fireEvent.change(slider(), { target: { value: '2' } })
    expect(stored().workload).toBe('primary-checks')
    expect(seat('lead').getByText('plans')).toBeInTheDocument()
    expect(seat('lead').getByText('Local model')).toBeInTheDocument()
    expect(seat('critic').getByText('checks')).toBeInTheDocument()
    expect(seat('critic').getByText('Claude')).toBeInTheDocument()
  })

  it('the slider can be switched off: each agent keeps the AI set on it', () => {
    seed({ workload: 'local-all' })
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Each agent’s own AI' }))
    expect(stored().workload).toBe('agents')
    expect(seat('critic').getByText('Gemini')).toBeInTheDocument()
    expect(slider()).toBeDisabled()
  })

  it('a second opinion goes to the other connected AI', () => {
    seed({ workload: 'primary-leads' })
    show()
    const box = screen.getByRole('checkbox', { name: /A different AI double-checks/ })
    expect(seat('critic').getByText('Claude')).toBeInTheDocument()
    fireEvent.click(box)
    expect(stored().workloadSecondOpinion).toBe(true)
    expect(seat('critic').getByText('Gemini')).toBeInTheDocument()
  })

  it('with no second AI connected the second opinion is not offered as if it were', () => {
    localStorage.setItem(
      STORE,
      JSON.stringify({
        providers: [
          { id: 'claude-cli', name: 'Claude', baseUrl: '', apiKey: '', enabled: true, primary: true },
          { id: 'local', name: 'Local model', baseUrl: 'http://localhost:1234', apiKey: '', enabled: true, primary: false },
        ],
      }),
    )
    show()
    expect(screen.getByRole('checkbox', { name: /A different AI double-checks/ })).toBeDisabled()
  })

  it('says what leaning on the local model costs in time, from its measured speed', () => {
    seed({ workload: 'primary-checks' })
    show([], 5.4)
    expect(
      screen.getByText(/Your local model has been answering at about 5 tokens a second/),
    ).toBeInTheDocument()
  })

  it('with no speed measured it does not guess one', () => {
    seed({ workload: 'primary-checks' })
    show([], null)
    expect(screen.queryByText(/tokens a second/)).toBeNull()
  })

  it('a stop that gives the local model no seat has no such cost to state', () => {
    seed({ workload: 'primary-all' })
    show([], 5.4)
    expect(screen.queryByText(/tokens a second/)).toBeNull()
  })

  it('says what the slider does not touch', () => {
    seed()
    show()
    expect(screen.getByText(/A team you staffed by hand keeps its own seats/)).toBeInTheDocument()
    expect(screen.getByText(/the privacy floor outranks every stop/i)).toBeInTheDocument()
  })
})
