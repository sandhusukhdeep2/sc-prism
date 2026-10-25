import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The vault seam only. The parser + store are exercised for real; only the
// native bridge (resolveVaultDir / writeVaultNote / readVaultFile) is stubbed,
// so the "resolveVaultDir runs FIRST" discipline is actually observable.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async (p?: string) => (p === '~/vault' ? '/home/sukh/vault' : '/vault')),
  writeVaultNote: vi.fn(async (_v: string, rel: string, _content: string) => `/vault/${rel}`),
  readVaultFile: vi.fn(async () => null as string | null),
}))
vi.mock('./nativeEngine', async (orig) => {
  const actual = await orig<typeof import('./nativeEngine')>()
  return { ...actual, ...native }
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app',
  homeDir: async () => '/home',
  join: async (...parts: string[]) => parts.join('/'),
}))

import {
  parseProposalBlock,
  proposalCharter,
  proposalEvidencePool,
  proposeAgentBrief,
  stripProposalBlock,
  type AgentProposal,
  type NewProposalInput,
} from './agentProposals'

// Both stores are module singletons whose state loads at import time, so every
// store test gets a FRESH registry (mirrors managers.test.ts / agents.test.ts).
// `S` and `A` must come from the SAME fresh registry — a stale `agents` import
// would be a different library than the one `createFromProposal` writes to.
let S: typeof import('./agentProposals')
let A: typeof import('./agents')

async function fresh(keepStorage = false): Promise<void> {
  if (!keepStorage) localStorage.clear()
  vi.resetModules()
  S = await import('./agentProposals')
  A = await import('./agents')
}

// A well-formed block citing one id from the verified pool below.
const GOOD_BLOCK = [
  'Three runs needed a policy check and nobody owns it.',
  '',
  '```PROPOSE_AGENT',
  'name: policy-warden',
  'purpose: check each diff against our policy list',
  'model: claude',
  'model_why: the policy text is long and needs careful reading',
  'skills: policy-diff, secret-scan',
  'evidence: run-aaa, run-bbb',
  'evidence_note: three runs in a row stalled on a policy question',
  '```',
].join('\n')

const POOL = ['run-aaa', 'run-bbb', 'run-ccc']
const HEARTBEAT = { source: 'heartbeat', knownRunIds: POOL } as const

function input(over: Partial<NewProposalInput> = {}): NewProposalInput {
  return {
    name: 'policy-warden',
    purpose: 'check each diff against our policy list',
    model: 'claude',
    modelWhy: 'long policy text',
    skills: ['policy-diff'],
    evidence: { kind: 'runs', refs: ['run-aaa'], quote: 'three runs stalled' },
    source: 'heartbeat',
    ...over,
  }
}

beforeEach(async () => {
  native.isNative.mockReturnValue(true)
  native.writeVaultNote.mockClear()
  native.resolveVaultDir.mockClear()
  native.readVaultFile.mockReset().mockResolvedValue(null)
  await fresh()
})
afterEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// The block format — strict, and REFUSING is the default
// ---------------------------------------------------------------------------

describe('parseProposalBlock — a proposal needs REAL evidence or it is not made', () => {
  it('parses a well-formed, evidenced block into exactly its fields', () => {
    const r = parseProposalBlock(GOOD_BLOCK, HEARTBEAT)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.input).toMatchObject({
      name: 'policy-warden',
      purpose: 'check each diff against our policy list',
      model: 'claude',
      modelWhy: 'the policy text is long and needs careful reading',
      skills: ['policy-diff', 'secret-scan'],
      source: 'heartbeat',
    })
    // the REAL cited ids ride along, plus the note — nothing paraphrased away
    expect(r.input.evidence).toEqual({
      kind: 'runs',
      refs: ['run-aaa', 'run-bbb'],
      quote: 'three runs in a row stalled on a policy question',
    })
  })

  it('REFUSES a block with no evidence field at all — no proposal, an honest reason', () => {
    const block = GOOD_BLOCK.split('\n')
      .filter((l) => !l.startsWith('evidence'))
      .join('\n')
    const r = parseProposalBlock(block, HEARTBEAT)
    expect(r).toEqual({ status: 'refused', reason: 'no evidence cited' })
  })

  it('REFUSES an empty evidence field (the field is there, the evidence is not)', () => {
    const r = parseProposalBlock(GOOD_BLOCK.replace('evidence: run-aaa, run-bbb', 'evidence:'), HEARTBEAT)
    expect(r).toEqual({ status: 'refused', reason: 'no evidence cited' })
  })

  it('REFUSES an id outside the verified pool — an invented citation is not evidence', () => {
    const r = parseProposalBlock(GOOD_BLOCK.replace('run-bbb', 'run-zzz'), HEARTBEAT)
    expect(r.status).toBe('refused')
    if (r.status !== 'refused') return
    expect(r.reason).toContain("can't verify")
    expect(r.reason).toContain('run-zzz')
  })

  it('REFUSES everything when the pool is EMPTY (no runs → no citable evidence)', () => {
    const r = parseProposalBlock(GOOD_BLOCK, { source: 'heartbeat', knownRunIds: [] })
    expect(r.status).toBe('refused')
  })

  it('a reply with NO block is simply "none" — nothing to note, nothing recorded', () => {
    expect(parseProposalBlock('Tidied the vault index.', HEARTBEAT)).toEqual({ status: 'none' })
  })

  describe('malformed blocks are IGNORED (refused with a reason), never repaired', () => {
    const cases: [string, string, string][] = [
      ['an unclosed fence', GOOD_BLOCK.replace(/```$/, ''), 'never closed'],
      [
        'a line that is not key: value',
        GOOD_BLOCK.replace('model: claude', 'just some prose here'),
        'unreadable line',
      ],
      ['an unknown field', GOOD_BLOCK.replace('skills:', 'budget:'), 'unknown field'],
      [
        'a duplicate field',
        GOOD_BLOCK.replace('purpose: check each diff against our policy list', 'name: other\npurpose: x'),
        'duplicate field',
      ],
      ['a missing required field', GOOD_BLOCK.replace(/^name: .*$/m, ''), 'missing "name"'],
      ['an empty required field', GOOD_BLOCK.replace(/^purpose: .*$/m, 'purpose:'), 'missing "purpose"'],
      ['an unknown model', GOOD_BLOCK.replace('model: claude', 'model: gpt-9'), 'not one of'],
      ['two blocks in one reply', `${GOOD_BLOCK}\n\n${GOOD_BLOCK}`, 'more than one'],
      // The charter says "END your reply with exactly this block". Enforced,
      // not merely requested — a block the model retracts, or one QUOTED as an
      // illustration inside a code sample, is not a decision.
      [
        'a block the model retracts on the next line',
        `${GOOD_BLOCK}\n\nActually, ignore that.`,
        'not the last thing in the reply',
      ],
      [
        'a block quoted inside a code sample',
        `Here is what one looks like:\n\n\`\`\`text\n${GOOD_BLOCK}\n\`\`\`\n`,
        'not the last thing in the reply',
      ],
    ]
    for (const [label, text, reason] of cases) {
      it(`${label} → refused (${reason}), and it does not throw`, () => {
        const r = parseProposalBlock(text, HEARTBEAT)
        expect(r.status).toBe('refused')
        if (r.status !== 'refused') return
        expect(r.reason).toContain(reason)
      })
    }
  })

  describe('values are BOUNDED — a field is not a smuggling channel', () => {
    it('caps each skill at 40 chars (a 20,000-char "skill" is not a skill)', () => {
      const huge = 'x'.repeat(20_000)
      const r = parseProposalBlock(GOOD_BLOCK.replace('skills: policy-diff, secret-scan', `skills: ${huge}`), HEARTBEAT)
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return
      expect(r.input.skills).toHaveLength(1)
      expect(r.input.skills[0]).toHaveLength(40)
    })

    it('dedupes cited refs and caps them at 8', () => {
      const pool = Array.from({ length: 12 }, (_, i) => `run-${i}`)
      const cited = [...pool, ...pool].join(', ')
      const r = parseProposalBlock(GOOD_BLOCK.replace('evidence: run-aaa, run-bbb', `evidence: ${cited}`), {
        source: 'heartbeat',
        knownRunIds: pool,
      })
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return
      expect(r.input.evidence.refs).toEqual(pool.slice(0, 8))
    })

    it("stores the POOL's casing, so a printed id always resolves later", () => {
      const r = parseProposalBlock(GOOD_BLOCK.replace('evidence: run-aaa, run-bbb', 'evidence: RUN-AAA'), HEARTBEAT)
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return
      expect(r.input.evidence.refs).toEqual(['run-aaa'])
    })
  })

  describe('source (b): the user asking on Work', () => {
    const asked = (request: string) => ({ source: 'asked', request }) as const
    const blockNoEvidence = GOOD_BLOCK.split('\n')
      .filter((l) => !l.startsWith('evidence'))
      .join('\n')

    it("uses the user's OWN message as the evidence, quoted verbatim", () => {
      const r = parseProposalBlock(blockNoEvidence, asked('we need someone to check compliance'))
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return
      expect(r.input.evidence).toEqual({
        kind: 'asked',
        refs: [],
        quote: 'we need someone to check compliance',
      })
      expect(r.input.source).toBe('asked')
    })

    it('an empty request is refused — there is then nothing real to cite', () => {
      expect(parseProposalBlock(blockNoEvidence, asked('   '))).toEqual({
        status: 'refused',
        reason: 'no request text to cite as evidence',
      })
    })

    it('run ids written in a CHAT block are ignored — the request stays the evidence', () => {
      const r = parseProposalBlock(GOOD_BLOCK, asked('we need a compliance person'))
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return
      expect(r.input.evidence.kind).toBe('asked')
      expect(r.input.evidence.refs).toEqual([])
    })
  })
})

describe('the wake charter tells the model the format AND the evidence rule', () => {
  it('lists the REAL citable ids and says an unevidenced block is discarded', () => {
    const c = proposalCharter(POOL)
    expect(c).toContain('PROPOSE_AGENT')
    expect(c).toContain('run-aaa, run-bbb, run-ccc')
    expect(c).toContain('DISCARDED')
  })

  it('with no runs at all it tells the model NOT to propose (no ids to invent from)', () => {
    const c = proposalCharter([])
    expect(c).toContain('do NOT propose')
    expect(c).not.toContain('name: <short-role-name>')
  })

  it('the Work brief carries the user words and omits the evidence field', () => {
    const b = proposeAgentBrief('we need someone for invoices')
    expect(b).toContain('we need someone for invoices')
    expect(b).toContain('PROPOSE_AGENT')
    expect(b).not.toContain('evidence: <comma-separated run ids')
  })

  it('names the agents that ALREADY exist, so "no existing agent covers it" is checkable', () => {
    const c = proposalCharter(POOL, ['compliance-checker', 'test-writer'])
    expect(c).toContain('compliance-checker, test-writer')
    expect(c).toContain('Do NOT propose any of these')
    expect(proposalCharter(POOL)).toContain('no agents in the library yet')
  })

  it('the evidence pool is REAL task ids, deduped, newest first', () => {
    const real = (taskId: string) => ({ taskId, native: { models_used: ['claude-cli · x'] } })
    expect(proposalEvidencePool([real('a'), real('a'), real(''), real('b')])).toEqual(['a', 'b'])
    expect(proposalEvidencePool([])).toEqual([])
  })

  it('EXCLUDES simulated runs — a demo verdict is not citable evidence', () => {
    expect(
      proposalEvidencePool([
        { taskId: 'sim-1' }, // no native at all → the sim made it
        { taskId: 'sim-2', native: { models_used: [] } },
        { taskId: 'real-1', native: { models_used: ['local · qwen'] } },
      ]),
    ).toEqual(['real-1'])
  })
})

// ---------------------------------------------------------------------------
// The store — a proposal is NOT an agent
// ---------------------------------------------------------------------------

describe('the proposal store', () => {
  it('records a proposal WITHOUT touching the agent library', () => {
    const before = A.list().length
    const p = S.propose(input(), 1000)!
    expect(p.status).toBe('open')
    expect(S.openProposals(S.list())).toHaveLength(1)
    // the library is untouched — no entry, no count, no stat
    expect(A.list()).toHaveLength(before)
    expect(A.list().filter((a) => a.name === 'policy-warden')).toHaveLength(0)
  })

  it('never proposes the same role twice (open, or dismissed on the same evidence)', () => {
    expect(S.propose(input(), 1000)).not.toBeNull()
    expect(S.propose(input(), 2000)).toBeNull() // still open
    S.dismiss(S.list()[0].id, 3000)
    expect(S.propose(input(), 4000)).toBeNull() // dismissed → must not nag
    expect(S.list()).toHaveLength(1)
  })

  // Audit (2026-08-11): dismissal was a life sentence for a ROLE NAME. Any
  // status blocked it forever, with no un-dismiss anywhere in the app — the
  // only escape was hand-editing the vault ledger AND clearing localStorage.
  describe('the dedupe is scoped — sticky, not a life sentence', () => {
    it('refuses a name an AGENT already carries (the charter promises no duplicate)', () => {
      const dup = input({ name: 'compliance-checker' }) // the seeded library agent
      expect(S.blockedReason(dup)).toContain('already exists')
      expect(S.propose(dup, 1000)).toBeNull()
    })

    it('a DISMISSED name comes back when genuinely NEW evidence is cited', () => {
      const p = S.propose(input(), 1000)!
      S.dismiss(p.id, 2000)
      // same runs → still nagging, still refused
      expect(S.propose(input(), 3000)).toBeNull()
      // different runs → a new argument the user has not seen
      const fresher = input({ evidence: { kind: 'runs', refs: ['run-ccc'], quote: 'two more stalled' } })
      expect(S.blockedReason(fresher)).toBeNull()
      expect(S.propose(fresher, 4000)).not.toBeNull()
      expect(S.openProposals(S.list())).toHaveLength(1)
    })

    it('a CREATED proposal stops blocking once its agent is deleted from the library', () => {
      const p = S.propose(input(), 1000)!
      const agent = S.createFromProposal(
        p.id,
        { name: p.name, purpose: p.purpose, model: p.model, skills: p.skills },
        2000,
      )!
      // while the agent exists the name is taken
      expect(S.propose(input(), 3000)).toBeNull()
      A.remove(agent.id)
      // ...deleted → the role can be proposed again
      expect(S.blockedReason(input())).toBeNull()
      expect(S.propose(input(), 4000)).not.toBeNull()
    })

    it('every refusal has an honest, quotable reason', () => {
      S.propose(input(), 1000)
      expect(S.blockedReason(input())).toContain('already waiting on your desk')
      expect(S.blockedReason(input({ name: '  ' }))).toContain('needs a name')
    })
  })

  it('dismiss is sticky: the record survives as dismissed and leaves the desk', () => {
    const p = S.propose(input(), 1000)!
    S.dismiss(p.id, 2000)
    expect(S.list()).toHaveLength(1)
    expect(S.list()[0]).toMatchObject({ status: 'dismissed', decidedAt: 2000 })
    expect(S.openProposals(S.list())).toHaveLength(0)
  })

  it('a dismissal survives a RELOAD (fresh module registry, same localStorage)', async () => {
    const p = S.propose(input(), 1000)!
    S.dismiss(p.id, 2000)
    await fresh(true) // reload: new module registry, the SAME stored ledger
    expect(S.list()).toHaveLength(1)
    expect(S.list()[0].status).toBe('dismissed')
    expect(S.openProposals(S.list())).toHaveLength(0)
    // ...and it still refuses to be re-proposed after the reload
    expect(S.propose(input(), 5000)).toBeNull()
  })
})

describe('Create — the human tap, and the only thing that makes an agent', () => {
  it('writes EXACTLY the reviewed values and the new agent has genuinely empty stats', () => {
    const p = S.propose(input(), 1000)!
    const before = A.list().length
    const agent = S.createFromProposal(
      p.id,
      { name: p.name, purpose: p.purpose, model: p.model, skills: p.skills },
      2000,
    )!
    expect(A.list()).toHaveLength(before + 1)
    expect(agent).toMatchObject({
      name: 'policy-warden',
      role: 'check each diff against our policy list',
      model: 'claude',
      skills: ['policy-diff'],
      system: false,
      // never seeded, never inherited
      usage: 0,
      evalScore: 0,
    })
    expect(A.list().find((a) => a.id === agent.id)).toBeTruthy()
    // ...and it reads as an agent with NO history: 'no runs yet', 0 runs.
    expect(A.agentActivity(agent, [])).toMatchObject({ state: 'idle', label: 'no runs yet', runs: 0 })
    // the proposal is closed out with the audit link to the agent it produced
    expect(S.list()[0]).toMatchObject({ status: 'created', createdAgentId: agent.id, decidedAt: 2000 })
    expect(S.openProposals(S.list())).toHaveLength(0)
  })

  it('EDIT FIRST applies the edited values, not the originals', () => {
    const p = S.propose(input(), 1000)!
    const agent = S.createFromProposal(
      p.id,
      {
        name: 'risk-warden',
        purpose: 'reads the policy file and blocks risky diffs',
        model: 'local',
        skills: ['policy-diff', 'secret-scan'],
      },
      2000,
    )!
    expect(agent).toMatchObject({
      name: 'risk-warden',
      role: 'reads the policy file and blocks risky diffs',
      model: 'local',
      skills: ['policy-diff', 'secret-scan'],
      usage: 0,
      evalScore: 0,
    })
    // no agent under the ORIGINAL suggested name was created
    expect(A.list().find((a) => a.name === 'policy-warden')).toBeUndefined()
    // the ledger records what was actually created, not the original suggestion
    expect(S.list()[0]).toMatchObject({ name: 'risk-warden', model: 'local', status: 'created' })
  })

  // Audit (2026-08-11): Create never consulted the library, so it would happily
  // mint a SECOND agent under a name already in use (the seeded
  // 'compliance-checker' is exactly such a name, and "Edit first" can type any
  // name at all). It now suffixes instead — and the desk shows that planned
  // name before the tap (`plannedAgentName`).
  it('a name the library already holds is SUFFIXED, never duplicated', () => {
    const p = S.propose(input(), 1000)!
    expect(S.plannedAgentName('compliance-checker')).toBe('compliance-checker 2')
    const agent = S.createFromProposal(
      p.id,
      { name: 'compliance-checker', purpose: p.purpose, model: p.model, skills: p.skills },
      2000,
    )!
    expect(agent.name).toBe('compliance-checker 2')
    expect(A.list().filter((a) => a.name === 'compliance-checker')).toHaveLength(1)
    // the ledger records the name that was REALLY written
    expect(S.list()[0]).toMatchObject({ name: 'compliance-checker 2', status: 'created' })
  })

  it('a second tap creates nothing (an already-decided proposal is a no-op)', () => {
    const p = S.propose(input(), 1000)!
    const values = { name: p.name, purpose: p.purpose, model: p.model, skills: p.skills }
    expect(S.createFromProposal(p.id, values, 2000)).not.toBeNull()
    const after = A.list().length
    expect(S.createFromProposal(p.id, values, 3000)).toBeNull()
    expect(A.list()).toHaveLength(after)
  })
})

// ---------------------------------------------------------------------------
// The vault ledger — auditable, and survives a restart
// ---------------------------------------------------------------------------

describe('the vault ledger', () => {
  it('resolves the vault dir FIRST — a ~ path never reaches the bridge', async () => {
    S.propose(input(), 1000)
    expect(await S.persistProposalsToVault('~/vault')).toBe(true)
    expect(native.resolveVaultDir).toHaveBeenCalledWith('~/vault')
    const [vault, rel, body] = native.writeVaultNote.mock.calls[0]
    expect(vault).toBe('/home/sukh/vault') // resolved, not the tilde
    expect(rel).toBe(S.PROPOSALS_VAULT_PATH)
    expect(JSON.parse(body)[0]).toMatchObject({ name: 'policy-warden', status: 'open' })
  })

  it('writes nothing in the browser (non-native) and says so honestly', async () => {
    native.isNative.mockReturnValue(false)
    S.propose(input(), 1000)
    expect(await S.persistProposalsToVault('/vault')).toBe(false)
    expect(native.writeVaultNote).not.toHaveBeenCalled()
  })

  it('hydrates vault-only records on a fresh install, keeping a DISMISSED one dismissed', async () => {
    const stored: AgentProposal[] = [
      {
        id: 'prop-from-vault',
        name: 'invoice-chaser',
        purpose: 'chases unpaid invoices',
        model: 'gemini',
        modelWhy: 'cheap and fast',
        skills: [],
        evidence: { kind: 'runs', refs: ['run-aaa'], quote: '' },
        source: 'heartbeat',
        at: 10,
        status: 'dismissed',
        decidedAt: 20,
      },
    ]
    native.readVaultFile.mockResolvedValue(JSON.stringify(stored))
    expect(S.list()).toHaveLength(0)
    expect(await S.hydrateProposalsFromVault('/vault')).toBe(1)
    expect(S.list()[0].status).toBe('dismissed')
    expect(S.openProposals(S.list())).toHaveLength(0)
    // sticky across the restart: the same role cannot be re-proposed
    expect(S.propose({ ...input(), name: 'invoice-chaser' }, 30)).toBeNull()
  })

  it('a corrupt / missing ledger adopts nothing and never throws', async () => {
    native.readVaultFile.mockResolvedValue('{ not json')
    expect(await S.hydrateProposalsFromVault('/vault')).toBe(0)
    native.readVaultFile.mockResolvedValue(null)
    expect(await S.hydrateProposalsFromVault('/vault')).toBe(0)
  })

  // Audit (2026-08-11): persist wrote the whole file from memory, and memory is
  // EMPTY on a fresh install / cleared webview storage. One mutation before
  // hydration truncated the ledger and destroyed every past dismissal.
  it('persist MERGES with what is already in the vault — it never truncates it', async () => {
    const stored: AgentProposal[] = [
      {
        id: 'prop-old',
        name: 'invoice-chaser',
        purpose: 'chases unpaid invoices',
        model: 'gemini',
        modelWhy: 'cheap',
        skills: [],
        evidence: { kind: 'runs', refs: ['run-aaa'], quote: '' },
        source: 'heartbeat',
        at: 10,
        status: 'dismissed',
        decidedAt: 20,
      },
    ]
    native.readVaultFile.mockResolvedValue(JSON.stringify(stored))
    // this process never hydrated — it knows only its own new record
    S.propose(input(), 1000)
    expect(await S.persistProposalsToVault('/vault')).toBe(true)
    const body = JSON.parse(native.writeVaultNote.mock.calls[0][2]) as AgentProposal[]
    expect(body.map((p) => p.id).sort()).toEqual(['prop-old', S.list()[0].id].sort())
    expect(body.find((p) => p.id === 'prop-old')?.status).toBe('dismissed')
  })

  it('a vault record with a NEWER decision wins on hydrate (two windows, one ledger)', async () => {
    const p = S.propose(input(), 1000)!
    // the other window dismissed the same record and wrote it to the vault
    native.readVaultFile.mockResolvedValue(
      JSON.stringify([{ ...p, status: 'dismissed', decidedAt: 9000 }]),
    )
    expect(await S.hydrateProposalsFromVault('/vault')).toBe(1)
    expect(S.list()).toHaveLength(1)
    expect(S.list()[0].status).toBe('dismissed')
  })

  it('an OLDER vault copy never resurrects a decided record', async () => {
    const p = S.propose(input(), 1000)!
    S.dismiss(p.id, 5000)
    native.readVaultFile.mockResolvedValue(JSON.stringify([{ ...p, status: 'open' }]))
    expect(await S.hydrateProposalsFromVault('/vault')).toBe(0)
    expect(S.list()[0].status).toBe('dismissed')
  })
})

// ---------------------------------------------------------------------------
// The block is not the wake's WORK — it is a suggestion appended to it
// ---------------------------------------------------------------------------

describe('stripProposalBlock — the prose alone', () => {
  it('removes the block and leaves the reply text', () => {
    expect(stripProposalBlock(GOOD_BLOCK).trim()).toBe(
      'Three runs needed a policy check and nobody owns it.',
    )
  })

  it('a reply with no block is returned untouched', () => {
    expect(stripProposalBlock('NOTHING_NEEDED — everything is quiet')).toBe(
      'NOTHING_NEEDED — everything is quiet',
    )
  })

  it('an UNCLOSED block is cut to the end (nothing of it leaks into the prose)', () => {
    const open = 'NOTHING_NEEDED — quiet\n\n```PROPOSE_AGENT\nname: x'
    expect(stripProposalBlock(open).trim()).toBe('NOTHING_NEEDED — quiet')
  })
})

// RESEARCH-FIRST CREATION (Sukhdeep, 2026-08-29 evening): "manager should
// need to rewrite each and every agent properly before creating that agent…
// do the research, gather data, then create it." A proposal already CARRIES
// the research — the observed pattern (evidence quote), the recorded run ids,
// the model reasoning (modelWhy). Creation composes them into the agent's
// charter, so no approved agent is ever born bare.
describe('createFromProposal writes a researched charter', () => {
  it('the new agent carries purpose, observed pattern, run ids, and model reasoning', () => {
    const p = S.propose(input(), 1000)!
    const agent = S.createFromProposal(
      p.id,
      { name: p.name, purpose: p.purpose, model: p.model, skills: p.skills },
      2000,
    )!
    const charter = agent.charter ?? ''
    expect(charter).toContain('check each diff against our policy list')
    expect(charter).toContain('three runs stalled')
    expect(charter).toContain('long policy text')
    expect(charter).toContain('run-aaa')
  })
})
