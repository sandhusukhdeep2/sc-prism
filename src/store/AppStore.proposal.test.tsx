import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { Verdict } from '../engine/types'

// Same harness shape as AppStore.heartbeat.test.tsx: force native, stub the
// vault side-effects, leave storeGet PENDING for every key except 'managers'.
// What this file pins is the 2026-08-11 spec's source (a): a wake reply may END
// with a PROPOSE_AGENT block — and an evidence-free or malformed one is
// IGNORED with an honest note, never coerced into a proposal.
const h = vi.hoisted(() => ({
  runNativeTask: vi.fn(),
  writeVaultNote: vi.fn(
    async (_vault: string, rel: string, _content: string): Promise<string | null> => `/vault/${rel}`,
  ),
  cancelEngineRun: vi.fn(async () => {}),
  notifyManagerReport: vi.fn(),
}))

// The phone line is spied on, not sent: a wake that RESTED must never report a
// heartbeat "passed" to Telegram (see the NOTHING_NEEDED + block case below).
vi.mock('../lib/telegramNotify', async (orig) => {
  const actual = await orig<typeof import('../lib/telegramNotify')>()
  return { ...actual, notifyManagerReport: h.notifyManagerReport }
})

vi.mock('../lib/nativeEngine', async (orig) => {
  const actual = await orig<typeof import('../lib/nativeEngine')>()
  return {
    ...actual,
    isNative: () => true,
    resolveVaultDir: async () => '/vault',
    appendChatNote: async () => {},
    readVaultFile: async () => null,
    writeVaultNote: h.writeVaultNote,
    storeGet: (key: string) =>
      key === 'managers' ? Promise.resolve(null) : new Promise<string | null>(() => {}),
    storeSet: async () => {},
    runNativeTask: h.runNativeTask,
    cancelEngineRun: h.cancelEngineRun,
  }
})

// A REAL verdict in the persisted session — this is what gives the wake a
// verifiable evidence pool. Its taskId is the ONLY id a proposal may cite.
const REAL_RUN_ID = 'run-real-42'

function seedSession(): void {
  localStorage.setItem(
    'scprism.session',
    JSON.stringify({
      threads: { universal: [] },
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      verdicts: [
        {
          taskId: REAL_RUN_ID,
          task: 'a real run',
          route: {},
          tier1: {},
          tier2: {},
          passed: true,
          // `models_used` is what marks a run as REAL: the evidence pool
          // excludes simulated verdicts exactly as agent activity does, so a
          // demo-mode seed can never become citable evidence.
          native: { models_used: ['claude-cli · claude-opus'] },
          at: '2026-08-11T09:00:00.000Z',
        },
      ],
    }),
  )
}

function seedManagersStore(): void {
  localStorage.setItem(
    'scprism.managers',
    JSON.stringify({
      managers: [
        {
          id: 'mgr-companion',
          providerId: 'primary',
          name: 'Companion',
          enabled: false,
          heartbeat: {
            enabled: true,
            charter: 'watch the projects and vault',
            everyMinutes: 30,
            lastBeat: 0,
            beats: [],
          },
        },
      ],
      jobs: [],
      seeded: true,
    }),
  )
}

const wakeVerdict = (response: string): Verdict =>
  ({ response, tokensIn: 100, tokensOut: 20 }) as unknown as Verdict

function block(over: Partial<Record<string, string>> = {}, drop: string[] = []): string {
  const fields: Record<string, string> = {
    name: 'policy-warden',
    purpose: 'check each diff against our policy list',
    model: 'claude',
    model_why: 'the policy text is long and needs careful reading',
    skills: 'policy-diff',
    evidence: REAL_RUN_ID,
    evidence_note: 'three runs stalled on a policy question',
    ...over,
  }
  const lines = Object.entries(fields)
    .filter(([k]) => !drop.includes(k))
    .map(([k, v]) => `${k}: ${v}`)
  return ['```PROPOSE_AGENT', ...lines, '```'].join('\n')
}

async function boot() {
  vi.resetModules()
  const settings = await import('../lib/settings')
  const connectivity = await import('../lib/connectivity')
  const store = await import('./AppStore')
  const managers = await import('../lib/managers')
  const proposals = await import('../lib/agentProposals')
  const agents = await import('../lib/agents')
  const S = settings.SettingsProvider
  const C = connectivity.ConnectivityProvider
  const A = store.AppProvider
  render(
    <S>
      <C>
        <A>
          <div />
        </A>
      </C>
    </S>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  return { managers, proposals, agents }
}

describe('heartbeat wake — the reply may PROPOSE an agent (source (a))', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
    h.notifyManagerReport.mockClear()
    seedManagersStore()
    seedSession()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  async function tick(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
  }

  it('tells the model the format AND lists the only citable run ids', async () => {
    h.runNativeTask.mockResolvedValue(wakeVerdict('Tidied the vault index.'))
    await boot()
    await tick()
    const prompt = h.runNativeTask.mock.calls[0][0] as string
    expect(prompt).toContain('PROPOSE_AGENT')
    expect(prompt).toContain(REAL_RUN_ID)
    expect(prompt).toContain('DISCARDED')
  })

  it('a well-formed, EVIDENCED block records a proposal — parked, never an agent', async () => {
    h.runNativeTask.mockResolvedValue(wakeVerdict(`Tidied the vault index.\n\n${block()}`))
    const { managers, proposals, agents } = await boot()
    const agentsBefore = agents.list().length
    await tick()

    const recorded = proposals.openProposals(proposals.list())
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      name: 'policy-warden',
      purpose: 'check each diff against our policy list',
      model: 'claude',
      modelWhy: 'the policy text is long and needs careful reading',
      skills: ['policy-diff'],
      source: 'heartbeat',
      status: 'open',
    })
    // the evidence is the REAL run id the app can verify
    expect(recorded[0].evidence).toEqual({
      kind: 'runs',
      refs: [REAL_RUN_ID],
      quote: 'three runs stalled on a policy question',
    })
    // NOTHING entered the agent library
    expect(agents.list()).toHaveLength(agentsBefore)
    // the beat says so, honestly
    const beat = managers.getManagers().managers[0].heartbeat!.beats[0]
    expect(beat.line).toContain('proposed a new agent: policy-warden')
    // and the ledger is written vault-side (audit + restart survival)
    expect(
      h.writeVaultNote.mock.calls.some(([, rel]) => rel === 'proposals/agent-proposals.json'),
    ).toBe(true)
  })

  it('a block with NO evidence is REFUSED — no proposal, and the beat says why', async () => {
    h.runNativeTask.mockResolvedValue(
      wakeVerdict(`Tidied the vault index.\n\n${block({}, ['evidence', 'evidence_note'])}`),
    )
    const { managers, proposals, agents } = await boot()
    const agentsBefore = agents.list().length
    await tick()

    expect(proposals.list()).toHaveLength(0)
    expect(agents.list()).toHaveLength(agentsBefore)
    const beat = managers.getManagers().managers[0].heartbeat!.beats[0]
    expect(beat.line).toContain('proposal ignored (no evidence cited)')
    expect(
      h.writeVaultNote.mock.calls.some(([, rel]) => rel === 'proposals/agent-proposals.json'),
    ).toBe(false)
  })

  it('a cited id the app cannot VERIFY is refused — invented evidence is not evidence', async () => {
    h.runNativeTask.mockResolvedValue(wakeVerdict(`Tidied up.\n\n${block({ evidence: 'run-i-made-up' })}`))
    const { managers, proposals } = await boot()
    await tick()

    expect(proposals.list()).toHaveLength(0)
    const beat = managers.getManagers().managers[0].heartbeat!.beats[0]
    expect(beat.line).toContain("can't verify")
    expect(beat.line).toContain('run-i-made-up')
  })

  it('a MALFORMED block is ignored: no proposal, no crash, the beat still records the work', async () => {
    const broken = block().replace('model: claude', 'this line is just prose')
    h.runNativeTask.mockResolvedValue(wakeVerdict(`Tidied the vault index.\n\n${broken}`))
    const { managers, proposals } = await boot()
    await tick()

    expect(proposals.list()).toHaveLength(0)
    const beat = managers.getManagers().managers[0].heartbeat!.beats[0]
    // the real work is still reported first — the ignored block is a suffix
    expect(beat.line).toMatch(/^Tidied the vault index\./)
    expect(beat.line).toContain('proposal ignored (unreadable line')
    expect(beat.ok).toBe(true)
  })

  it('an ordinary reply with no block leaves the beat line byte-identical', async () => {
    h.runNativeTask.mockResolvedValue(wakeVerdict('Tidied the vault index.'))
    const { managers, proposals } = await boot()
    await tick()

    expect(proposals.list()).toHaveLength(0)
    expect(managers.getManagers().managers[0].heartbeat!.beats[0].line).toBe('Tidied the vault index.')
  })

  // Audit (2026-08-11): `parseWakeReply` classified 'rested' only when
  // EVERYTHING after the first line was blank — so appending a proposal block
  // turned an honest "nothing needed" wake into recorded WORK: an entry in
  // reports/<slug>/heartbeat.md, a "passed" line to the phone, and a 'worked'
  // beat. A proposal is a suggestion, never work.
  describe('a NOTHING_NEEDED wake that also proposes still RESTED', () => {
    const heartbeatWrites = () =>
      h.writeVaultNote.mock.calls.filter(([, rel]) => String(rel).endsWith('heartbeat.md'))

    it('an ACCEPTED block: rested beat, no work report, no phone success', async () => {
      h.runNativeTask.mockResolvedValue(
        wakeVerdict(`NOTHING_NEEDED — everything is quiet\n\n${block()}`),
      )
      const { managers, proposals } = await boot()
      await tick()

      const beat = managers.getManagers().managers[0].heartbeat!.beats[0]
      expect(beat.action).toBe('rested')
      expect(beat.line).toContain('everything is quiet')
      expect(beat.line).toContain('proposed a new agent: policy-warden')
      // the proposal itself IS recorded — resting is about the work, not the suggestion
      expect(proposals.openProposals(proposals.list())).toHaveLength(1)
      expect(heartbeatWrites()).toHaveLength(0)
      expect(h.notifyManagerReport).not.toHaveBeenCalled()
    })

    it('a REFUSED block: still rested, and the beat carries the honest reason', async () => {
      h.runNativeTask.mockResolvedValue(
        wakeVerdict(`NOTHING_NEEDED — everything is quiet\n\n${block({ evidence: 'run-i-made-up' })}`),
      )
      const { managers, proposals } = await boot()
      await tick()

      const beat = managers.getManagers().managers[0].heartbeat!.beats[0]
      expect(beat.action).toBe('rested')
      expect(beat.line).toContain("can't verify")
      expect(proposals.list()).toHaveLength(0)
      expect(heartbeatWrites()).toHaveLength(0)
      expect(h.notifyManagerReport).not.toHaveBeenCalled()
    })

    it('a wake that really WORKED still reports the work (the fix cuts nothing real)', async () => {
      h.runNativeTask.mockResolvedValue(wakeVerdict(`Tidied the vault index.\n\n${block()}`))
      const { managers } = await boot()
      await tick()

      const beat = managers.getManagers().managers[0].heartbeat!.beats[0]
      expect(beat.action).toBe('worked')
      expect(heartbeatWrites()).toHaveLength(1)
      expect(h.notifyManagerReport).toHaveBeenCalledWith(expect.any(String), 'heartbeat', true)
    })
  })

  it('the wake prompt lists the agents that ALREADY exist', async () => {
    h.runNativeTask.mockResolvedValue(wakeVerdict('Tidied the vault index.'))
    const { agents } = await boot()
    await tick()
    const prompt = h.runNativeTask.mock.calls[0][0] as string
    expect(prompt).toContain('Agents that already exist')
    expect(prompt).toContain(agents.list()[0].name)
  })

  it('a block naming an agent that already exists is refused, with the real reason', async () => {
    h.runNativeTask.mockResolvedValue(
      wakeVerdict(`Tidied up.\n\n${block({ name: 'compliance-checker' })}`),
    )
    const { managers, proposals } = await boot()
    await tick()

    expect(proposals.list()).toHaveLength(0)
    const beat = managers.getManagers().managers[0].heartbeat!.beats[0]
    expect(beat.line).toContain('an agent named "compliance-checker" already exists')
  })

  it('with NO runs recorded there is no citable evidence — the charter says do not propose', async () => {
    localStorage.removeItem('scprism.session') // no verdicts → empty pool
    h.runNativeTask.mockResolvedValue(wakeVerdict(`Tidied up.\n\n${block()}`))
    const { proposals } = await boot()
    await tick()

    const prompt = h.runNativeTask.mock.calls[0][0] as string
    expect(prompt).toContain('do NOT propose')
    expect(proposals.list()).toHaveLength(0) // and the block is refused anyway
  })
})

// ---------------------------------------------------------------------------
// Source (b): the user asking on Work. The composer's "new agent" target sends
// the proposal brief through the NORMAL companion send and passes the user's
// raw request along, so the reply's block is recorded with THAT request as its
// evidence — quoted verbatim, never paraphrased.
// ---------------------------------------------------------------------------

describe('Work "new agent" ask — the user is the evidence (source (b))', () => {
  const captured: {
    sendIntent?: (
      intent: string,
      display?: string,
      route?: undefined,
      image?: undefined,
      proposalRequest?: string,
    ) => Promise<void>
    state?: import('./AppStore').AppState
  } = {}

  async function bootChat() {
    vi.resetModules()
    const settings = await import('../lib/settings')
    const connectivity = await import('../lib/connectivity')
    const store = await import('./AppStore')
    const proposals = await import('../lib/agentProposals')
    const agents = await import('../lib/agents')
    const S = settings.SettingsProvider
    const C = connectivity.ConnectivityProvider
    const A = store.AppProvider
    captured.sendIntent = undefined
    const Capture = () => {
      const app = store.useApp()
      captured.sendIntent = app.sendIntent
      captured.state = app.state
      return null
    }
    render(
      <S>
        <C>
          <A>
            <Capture />
          </A>
        </C>
      </S>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    return { proposals, agents }
  }

  const REQUEST = 'we need someone to chase unpaid invoices'
  const chatVerdict = (response: string): Verdict =>
    ({
      taskId: 'chat-1',
      task: REQUEST,
      route: {},
      tier1: {},
      tier2: {},
      passed: true,
      response,
      tokensIn: 10,
      tokensOut: 5,
    }) as unknown as Verdict

  const notices = (): string[] =>
    Object.values(captured.state?.threads ?? {})
      .flat()
      .filter((m) => m.kind === 'notice')
      .map((m) => (m as { text: string }).text)

  beforeEach(() => {
    localStorage.clear()
    h.runNativeTask.mockReset()
    h.writeVaultNote.mockClear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it("records the proposal with the user's OWN words as evidence, and creates nothing", async () => {
    const askBlock = block({ name: 'invoice-chaser' }, ['evidence', 'evidence_note'])
    h.runNativeTask.mockResolvedValue(chatVerdict(`Here is what I'd add.\n\n${askBlock}`))
    const { proposals, agents } = await bootChat()
    const before = agents.list().length

    await act(async () => {
      await captured.sendIntent!('[PROPOSE AN AGENT] …', `→ propose an agent: ${REQUEST}`, undefined, undefined, REQUEST)
    })

    const open = proposals.openProposals(proposals.list())
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ name: 'invoice-chaser', source: 'asked', status: 'open' })
    expect(open[0].evidence).toEqual({ kind: 'asked', refs: [], quote: REQUEST })
    expect(agents.list()).toHaveLength(before) // still not an agent
    expect(notices().some((t) => /waiting under "Needs you"/.test(t))).toBe(true)
  })

  it('a malformed block records NOTHING and says so in the chat', async () => {
    const broken = block({ name: 'invoice-chaser' }, ['evidence', 'evidence_note']).replace(
      'model: claude',
      'some prose instead',
    )
    h.runNativeTask.mockResolvedValue(chatVerdict(`Sure.\n\n${broken}`))
    const { proposals } = await bootChat()

    await act(async () => {
      await captured.sendIntent!('[PROPOSE AN AGENT] …', 'display', undefined, undefined, REQUEST)
    })

    expect(proposals.list()).toHaveLength(0)
    expect(notices().some((t) => /No agent was proposed/.test(t))).toBe(true)
  })

  it('an ordinary send (no request passed) never looks for a block and posts no notice', async () => {
    h.runNativeTask.mockResolvedValue(chatVerdict(`Sure.\n\n${block()}`))
    const { proposals } = await bootChat()

    await act(async () => {
      await captured.sendIntent!('what is the weather')
    })

    expect(proposals.list()).toHaveLength(0)
    expect(notices()).toHaveLength(0)
  })
})
