import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Only the native seam is mocked (the desk polls the vault for held/pending
// tool calls, and the proposal ledger is written vault-side). The proposal
// store, the desk projection and the agent library are all REAL here — that is
// the whole point: the assertions below are about what really lands in the
// library, and when.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async () => '/vault'),
  readSpansTail: vi.fn(async () => [] as unknown[]),
  readMcpApprovals: vi.fn(async () => ({ require: [] as string[], granted: [] as string[] })),
  readPendingApprovals: vi.fn(async () => [] as unknown[]),
  readVaultFile: vi.fn(async () => null as string | null),
  writeVaultNote: vi.fn(async (_v: string, rel: string) => `/vault/${rel}`),
}))
vi.mock('../lib/nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('../lib/nativeEngine')>()
  return { ...actual, ...native }
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app',
  homeDir: async () => '/home',
  join: async (...parts: string[]) => parts.join('/'),
}))

import Desk from './Desk'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider } from '../store/AppStore'
import { list as listAgents, remove as removeAgent } from '../lib/agents'
import {
  dismiss,
  list as listProposals,
  propose,
  type NewProposalInput,
} from '../lib/agentProposals'

// The proposal store is a module singleton that refuses to propose the same
// ROLE NAME twice (that is what stops a dismissal from nagging), so each test
// works on its own freshly-named role rather than fighting the dedupe.
let seq = 0
function freshName(): string {
  return `compliance-checker-${++seq}`
}
function titleFor(name: string): string {
  return `New agent proposed — ${name}`
}

function input(over: Partial<NewProposalInput> = {}): NewProposalInput {
  return {
    name: 'compliance-checker',
    purpose: 'check each diff against our policy list',
    model: 'claude',
    modelWhy: 'the policy text is long and needs careful reading',
    skills: ['policy-diff'],
    evidence: { kind: 'runs', refs: ['run-aaa', 'run-bbb'], quote: 'three runs stalled on policy' },
    source: 'heartbeat',
    ...over,
  }
}

/** Put REAL runs in the persisted session, so the desk row can resolve the ids
 *  a proposal cites against the app's own verdict log. */
function seedVerdicts(verdicts: Record<string, unknown>[]): void {
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { universal: [] },
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      verdicts: verdicts.map((v) => ({ route: {}, tier1: {}, tier2: {}, ...v })),
    }),
  )
}

function renderDesk() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Desk show="needs" />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

/** Every proposal recorded in this file is cleaned up so the module-level
 *  store (a singleton) can't leak a row into the next test. */
function clearProposals(): void {
  for (const p of listProposals()) if (p.status === 'open') dismiss(p.id, Date.now())
}

beforeEach(() => {
  localStorage.clear()
  native.isNative.mockReturnValue(true)
  native.writeVaultNote.mockClear()
  native.readVaultFile.mockReset().mockResolvedValue(null)
})
afterEach(() => {
  clearProposals()
  localStorage.clear()
  vi.clearAllMocks()
})

describe('Desk — a proposed agent (Needs you)', () => {
  it('renders what it would do, the model AND why, what it may touch, and the REAL evidence', async () => {
    const name = freshName()
    propose(input({ name }), Date.now())
    renderDesk()

    expect(await screen.findByText(titleFor(name))).toBeInTheDocument()
    expect(screen.getByText('check each diff against our policy list')).toBeInTheDocument()
    expect(
      screen.getByText('would run on claude — the policy text is long and needs careful reading'),
    ).toBeInTheDocument()
    expect(screen.getByText('may touch: policy-diff')).toBeInTheDocument()
    // Everything the MODEL wrote is grouped under a label that says so — the
    // model's note about the evidence included. It is a reading, not a citation.
    expect(screen.getByText('what the manager says')).toBeInTheDocument()
    expect(
      screen.getByText('the manager’s reading: three runs stalled on policy'),
    ).toBeInTheDocument()
    // ...and the EVIDENCE is the runs themselves, resolved from the app's own
    // history. Neither cited id is in this (empty) verdict log, so the row says
    // exactly that rather than printing ids that resolve to nothing.
    expect(
      screen.getByText('evidence — none of the runs it cited are in your history any more'),
    ).toBeInTheDocument()
    expect(screen.getByText(/run-aaa — no longer in your run history/)).toBeInTheDocument()
    // and the row says plainly that nothing exists yet
    expect(screen.getByText(/Not created yet/)).toBeInTheDocument()
    for (const label of ['Create', 'Edit first', 'Dismiss']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  // The audit case, verbatim: the model wrote "runs hi-1789bd62, yes-b2ef8534,
  // ok-4d902250: three runs needed a compliance check nobody owns" — and those
  // three runs were the user typing "hi", "yes" and "ok". Real ids, fabricated
  // narrative. The row now shows what those runs REALLY were.
  it('resolves each cited run against the REAL history — task text, pass/fail, when', async () => {
    seedVerdicts([
      { taskId: 'hi-1789bd62', task: 'hi', passed: false, at: '2026-08-11T09:31:00.000Z' },
      { taskId: 'yes-b2ef8534', task: 'yes', passed: false, at: '2026-08-11T09:33:00.000Z' },
    ])
    const name = freshName()
    propose(
      input({
        name,
        evidence: {
          kind: 'runs',
          refs: ['hi-1789bd62', 'yes-b2ef8534', 'gone-1'],
          quote: 'three runs needed a compliance check nobody owns',
        },
      }),
      Date.now(),
    )
    renderDesk()
    await screen.findByText(titleFor(name))

    expect(screen.getByText(/hi-1789bd62 · failed · “hi”/)).toBeInTheDocument()
    expect(screen.getByText(/yes-b2ef8534 · failed · “yes”/)).toBeInTheDocument()
    // a ref that no longer resolves is SAID, not quietly dropped
    expect(screen.getByText(/gone-1 — no longer in your run history/)).toBeInTheDocument()
    // only the resolved ones are counted as evidence
    expect(screen.getByText('evidence — 2 runs from your history:')).toBeInTheDocument()
    // and the model's sentence is still there — labelled as its reading
    expect(
      screen.getByText('the manager’s reading: three runs needed a compliance check nobody owns'),
    ).toBeInTheDocument()
  })

  it('warns BEFORE Create when the name is already taken, and Create suffixes it', async () => {
    // 'compliance-checker' is a seeded library agent — the spec's own example
    // name collides with it, which is exactly how this used to mint a duplicate.
    propose(input({ name: 'compliance-checker' , evidence: { kind: 'asked', refs: [], quote: 'we need one' }, source: 'asked' }), Date.now())
    // ...propose refuses that name outright, so drive the collision the other
    // way: a real proposal, renamed onto a taken name with "Edit first".
    const name = freshName()
    propose(input({ name }), Date.now())
    renderDesk()
    await screen.findByText(titleFor(name))

    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }))
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'compliance-checker' } })
    expect(
      screen.getByText(/already exists — Create will name this one “compliance-checker 2”/),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Create with these' }))
    await waitFor(() =>
      expect(listAgents().filter((a) => a.name === 'compliance-checker 2')).toHaveLength(1),
    )
    expect(listAgents().filter((a) => a.name === 'compliance-checker')).toHaveLength(1)
    // the library is a module singleton in this file — put it back as we found it
    removeAgent(listAgents().find((a) => a.name === 'compliance-checker 2')!.id)
  })

  it("quotes the user's own request when they asked for it on Work", async () => {
    propose(
      input({
        name: `invoice-chaser-${++seq}`,
        source: 'asked',
        evidence: { kind: 'asked', refs: [], quote: 'we need someone to chase invoices' },
      }),
      Date.now(),
    )
    renderDesk()
    expect(
      await screen.findByText('you asked: “we need someone to chase invoices”'),
    ).toBeInTheDocument()
  })

  it('NOTHING is in the agent library before Create — the proposal exists only on the desk', async () => {
    const before = listAgents().length
    const name = freshName()
    propose(input({ name }), Date.now())
    renderDesk()
    await screen.findByText(titleFor(name))
    expect(listAgents()).toHaveLength(before)
    expect(listAgents().find((a) => a.role === 'check each diff against our policy list')).toBeUndefined()
  })

  it('Create writes EXACTLY the reviewed values, with genuinely empty stats, and says so', async () => {
    const before = listAgents().length
    const name = freshName()
    propose(input({ name }), Date.now())
    renderDesk()
    await screen.findByText(titleFor(name))

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(listAgents()).toHaveLength(before + 1))
    const created = listAgents()[listAgents().length - 1]
    expect(created).toMatchObject({
      name,
      role: 'check each diff against our policy list',
      model: 'claude',
      skills: ['policy-diff'],
      system: false,
      usage: 0, // never seeded, never inherited
      evalScore: 0,
    })
    // honest confirmation, and the row is gone (it is an agent now, not a proposal)
    expect(await screen.findByText(/with no runs yet/)).toBeInTheDocument()
    expect(screen.queryByText(titleFor(name))).not.toBeInTheDocument()
    // the ledger is persisted vault-side for the audit trail
    await waitFor(() =>
      expect(native.writeVaultNote).toHaveBeenCalledWith(
        '/vault',
        'proposals/agent-proposals.json',
        expect.stringContaining('"status": "created"'),
      ),
    )
  })

  it('EDIT FIRST creates the EDITED values, not the originals', async () => {
    const before = listAgents().length
    const name = freshName()
    propose(input({ name }), Date.now())
    renderDesk()
    await screen.findByText(titleFor(name))

    fireEvent.click(screen.getByRole('button', { name: 'Edit first' }))
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'policy-warden' } })
    fireEvent.change(screen.getByLabelText('What it does'), {
      target: { value: 'reads the policy file and blocks risky diffs' },
    })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'local' } })
    fireEvent.change(screen.getByLabelText('Skills'), { target: { value: 'policy-diff, secret-scan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create with these' }))

    await waitFor(() => expect(listAgents()).toHaveLength(before + 1))
    const created = listAgents()[listAgents().length - 1]
    expect(created).toMatchObject({
      name: 'policy-warden',
      role: 'reads the policy file and blocks risky diffs',
      model: 'local',
      skills: ['policy-diff', 'secret-scan'],
      usage: 0,
      evalScore: 0,
    })
    // the ORIGINAL suggestion was never written
    expect(listAgents().filter((a) => a.name === name)).toHaveLength(0)
  })

  it('Dismiss takes TWO taps, creates nothing, and is STICKY across a reload', async () => {
    const before = listAgents().length
    const name = freshName()
    propose(input({ name }), Date.now())
    const view = renderDesk()
    await screen.findByText(titleFor(name))

    // one tap only arms the confirm — the proposal is still there
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByText('Dismiss for good?')).toBeInTheDocument()
    expect(screen.getByText(titleFor(name))).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Yes, dismiss' }))
    await waitFor(() => expect(screen.queryByText(titleFor(name))).not.toBeInTheDocument())
    expect(listAgents()).toHaveLength(before) // dismissing is not creating

    // "reload": tear the desk down and mount it again against the same store
    view.unmount()
    renderDesk()
    await waitFor(() => expect(native.resolveVaultDir).toHaveBeenCalled())
    expect(screen.queryByText(titleFor(name))).not.toBeInTheDocument()
    // ...and the record survives as the dismissal that stops it nagging again
    expect(listProposals().find((p) => p.name === name)?.status).toBe('dismissed')
  })

  it('no proposal → no proposal row (the desk is byte-identical to before)', async () => {
    renderDesk()
    await waitFor(() => expect(native.resolveVaultDir).toHaveBeenCalled())
    expect(screen.queryByText(/New agent proposed/)).not.toBeInTheDocument()
  })
})
