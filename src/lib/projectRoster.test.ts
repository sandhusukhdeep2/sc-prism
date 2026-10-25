import { beforeEach, describe, expect, it, vi } from 'vitest'

// The vault seam only. The parser + store run for real; only the native bridge
// is stubbed, so the "resolveVaultDir runs FIRST" discipline stays observable.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  resolveVaultDir: vi.fn(async (p?: string) => (p === '~/vault' ? '/home/sukh/vault' : '/vault')),
  writeVaultNote: vi.fn(async (_v: string, rel: string, _c: string) => `/vault/${rel}`),
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

import { allowAllProviders, type RosterGate } from './roster'
import type { Capability } from './delegation'
import type { RosterEvidence, RosterRole } from './projectRoster'

// Both stores are module singletons whose state loads at import time, so every
// store test gets a FRESH registry (mirrors agentProposals.test.ts). `R` and
// `A` must come from the SAME fresh registry, or `createFromRoster` would write
// into a different agent library than the one the assertions read.
let R: typeof import('./projectRoster')
let A: typeof import('./agents')

async function fresh(): Promise<void> {
  localStorage.clear()
  vi.resetModules()
  A = await import('./agents')
  R = await import('./projectRoster')
}

const NEEDS = [
  'a market scan of three competitors before we price',
  'a landing page that explains the offer',
  'weekly numbers pulled from the vault into one note',
]

const EVIDENCE: RosterEvidence = {
  projectId: 'proj-1',
  projectName: 'Pricing relaunch',
  needs: NEEDS,
}

function block(roles: string[]): string {
  return ['Here is who I think it needs.', '', '```PROPOSE_ROSTER', roles.join('\n---\n'), '```'].join(
    '\n',
  )
}

const SCOUT = [
  'role: Market scout',
  'purpose: scan the three competitors and write what they charge',
  'model: local',
  'model_why: bulk reading, and it never leaves the Mac',
  'capabilities: vault, web',
  `need: ${NEEDS[0]}`,
].join('\n')

const WRITER = [
  'role: Writer',
  'purpose: draft the landing page copy',
  'model: claude',
  'model_why: the strongest reasoner here, and this is persuasion',
  'capabilities: writes',
  `need: ${NEEDS[1]}`,
].join('\n')

// ---------------------------------------------------------------------------

describe('rosterCharter — the manager is only offered what is real', () => {
  beforeEach(fresh)

  it('offers only usable AI and only the capabilities the user holds', () => {
    const brief = R.rosterCharter({
      projectName: 'Pricing relaunch',
      needs: NEEDS,
      usableAI: ['claude', 'local'],
      userGrants: ['vault', 'web'],
    })
    expect(brief).toContain('claude, local')
    expect(brief).not.toContain('gemini')
    expect(brief).toContain('vault, web')
    expect(brief).not.toContain('writes')
    expect(brief).toContain(NEEDS[0])
  })

  it('refuses to invite a roster when the project has no recorded needs', () => {
    const brief = R.rosterCharter({
      projectName: 'Empty',
      needs: [],
      usableAI: ['local'],
      userGrants: ['vault'],
    })
    expect(brief).toContain('do NOT propose a roster')
  })

  it('refuses to invite a roster when nothing can run', () => {
    const brief = R.rosterCharter({
      projectName: 'Pricing relaunch',
      needs: NEEDS,
      usableAI: [],
      userGrants: ['vault'],
    })
    expect(brief).toContain('do NOT propose a roster')
  })

  it('says plainly when the user has granted nothing', () => {
    const brief = R.rosterCharter({
      projectName: 'P',
      needs: NEEDS,
      usableAI: ['local'],
      userGrants: [],
    })
    expect(brief).toContain('granted NO capabilities')
  })
})

describe('parseRosterBlock — a roster lists roles, AI and capabilities', () => {
  beforeEach(fresh)

  it('parses every row with its AI and its capabilities', () => {
    const parsed = R.parseRosterBlock(block([SCOUT, WRITER]), EVIDENCE)
    expect(parsed.status).toBe('ok')
    if (parsed.status !== 'ok') return
    expect(parsed.input.roles).toHaveLength(2)
    const [a, b] = parsed.input.roles
    expect(a.name).toBe('Market scout')
    expect(a.model).toBe('local')
    expect(a.capabilities).toEqual(['vault', 'web'])
    expect(a.need).toBe(NEEDS[0])
    expect(b.name).toBe('Writer')
    expect(b.model).toBe('claude')
    expect(b.capabilities).toEqual(['writes'])
  })

  it('accepts a role with no capabilities at all', () => {
    const none = SCOUT.replace('capabilities: vault, web\n', '')
    const parsed = R.parseRosterBlock(block([none]), EVIDENCE)
    expect(parsed.status).toBe('ok')
    if (parsed.status !== 'ok') return
    expect(parsed.input.roles[0].capabilities).toEqual([])
  })

  it('REFUSES an invented need — the same sin as fabricated activity', () => {
    const invented = SCOUT.replace(NEEDS[0], 'a viral TikTok strategy nobody asked for')
    const parsed = R.parseRosterBlock(block([invented]), EVIDENCE)
    expect(parsed.status).toBe('refused')
    if (parsed.status !== 'refused') return
    expect(parsed.reason).toContain("can't verify")
  })

  it('REFUSES a capability the app cannot enforce, rather than quietly dropping it', () => {
    const bogus = SCOUT.replace('capabilities: vault, web', 'capabilities: vault, send_email')
    const parsed = R.parseRosterBlock(block([bogus]), EVIDENCE)
    expect(parsed.status).toBe('refused')
    if (parsed.status !== 'refused') return
    expect(parsed.reason).toContain('send_email')
    expect(parsed.reason).toContain('can enforce')
  })

  it('refuses an unknown AI', () => {
    const parsed = R.parseRosterBlock(
      block([SCOUT.replace('model: local', 'model: grok')]),
      EVIDENCE,
    )
    expect(parsed.status).toBe('refused')
  })

  it.each([
    ['a missing field', block([SCOUT.replace(/^purpose:.*$/m, '')])],
    ['an unknown field', block([`${SCOUT}\nsalary: 100`])],
    ['a duplicate field', block([`${SCOUT}\nmodel: claude`])],
    ['an unreadable line', block([`${SCOUT}\njust some prose`])],
    ['an empty block', block([''])],
  ])('refuses %s', (_what, text) => {
    expect(R.parseRosterBlock(text, EVIDENCE).status).toBe('refused')
  })

  it('refuses a block that is not the last thing in the reply', () => {
    const parsed = R.parseRosterBlock(
      `${block([SCOUT])}\n\nActually, ignore that.`,
      EVIDENCE,
    )
    expect(parsed.status).toBe('refused')
    if (parsed.status !== 'refused') return
    expect(parsed.reason).toContain('not the last thing')
  })

  it('refuses an unclosed fence and a second block', () => {
    expect(
      R.parseRosterBlock('```PROPOSE_ROSTER\nrole: X', EVIDENCE).status,
    ).toBe('refused')
    expect(
      R.parseRosterBlock(`${block([SCOUT])}\n${block([WRITER])}`, EVIDENCE).status,
    ).toBe('refused')
  })

  it('refuses two roles with the same name', () => {
    const parsed = R.parseRosterBlock(block([SCOUT, SCOUT]), EVIDENCE)
    expect(parsed.status).toBe('refused')
    if (parsed.status !== 'refused') return
    expect(parsed.reason).toContain('ambiguous')
  })

  it('caps the roster size', () => {
    const many = Array.from({ length: R.MAX_ROLES + 1 }, (_v, i) =>
      SCOUT.replace('role: Market scout', `role: R${i}`),
    )
    expect(R.parseRosterBlock(block(many), EVIDENCE).status).toBe('refused')
  })

  it('reports no block at all as none, not as a refusal', () => {
    expect(R.parseRosterBlock('just a normal reply', EVIDENCE).status).toBe('none')
  })

  it('strips the block so a roster reply never reads as work done', () => {
    expect(R.stripRosterBlock(block([SCOUT])).trim()).toBe('Here is who I think it needs.')
  })
})

describe('projectNeeds — the citable pool is the project own plan', () => {
  beforeEach(fresh)

  it('is the plan steps, verbatim, deduped', () => {
    expect(
      R.projectNeeds({ plan: ['  step one  ', 'step two', 'step one', ''] }),
    ).toEqual(['step one', 'step two'])
  })

  it('is EMPTY for an unplanned project — nothing to staff against', () => {
    expect(R.projectNeeds({})).toEqual([])
    expect(R.projectNeeds({ plan: [] })).toEqual([])
  })
})

describe('the desk row lines', () => {
  beforeEach(fresh)

  const role: RosterRole = {
    name: 'Market scout',
    purpose: 'scan competitors',
    model: 'local',
    modelWhy: 'bulk reading, stays on the Mac',
    capabilities: ['vault', 'web'],
    need: NEEDS[0],
  }

  it('names which AI and why, what it may touch, and the need it serves', async () => {
    const D = await import('./desk')
    const { rows } = R.reviewRoster([role], {
      gate: allowAllProviders,
      userGrants: ['vault'] as Capability[],
    })
    expect(D.rosterRoleModelLine(role)).toBe(
      'would run on local — bulk reading, stays on the Mac',
    )
    expect(D.rosterRoleCapabilityLine(rows[0])).toBe('may: read your vault')
    expect(D.rosterRoleRefusedLine(rows[0])).toContain('not granted: web')
    expect(D.rosterRoleNeedLine(role)).toBe(`for: “${NEEDS[0]}”`)
  })

  it('says nothing was refused when nothing was', async () => {
    const D = await import('./desk')
    const { rows } = R.reviewRoster([role], {
      gate: allowAllProviders,
      userGrants: ['vault', 'web'] as Capability[],
    })
    expect(D.rosterRoleRefusedLine(rows[0])).toBe('')
  })

  it('heads the card with the real shape of the roster', async () => {
    const D = await import('./desk')
    const parsed = R.parseRosterBlock(block([SCOUT, WRITER]), EVIDENCE)
    if (parsed.status !== 'ok') throw new Error('fixture')
    const p = R.propose(parsed.input, 1000)!
    expect(D.rosterHeadLine(p)).toBe(
      '2 roles across 2 AI — one approval creates all of them',
    )
  })
})

describe('reviewRoster — the desk shows the truth before the tap', () => {
  beforeEach(fresh)

  it('clamps every row to the user own grants and says what was refused', () => {
    const roles: RosterRole[] = [
      {
        name: 'Market scout',
        purpose: 'scan competitors',
        model: 'local',
        modelWhy: 'local',
        capabilities: ['vault', 'web'],
        need: NEEDS[0],
      },
    ]
    const { rows } = R.reviewRoster(roles, {
      gate: allowAllProviders,
      userGrants: ['vault'] as Capability[],
    })
    expect(rows[0].granted).toEqual(['vault'])
    expect(rows[0].refused.map((r) => r.capability)).toEqual(['web'])
    expect(R.rowCapabilityLine(rows[0])).toBe('read your vault')
  })

  it('reads honestly when a row gets nothing', () => {
    const { rows } = R.reviewRoster(
      [
        {
          name: 'Critic',
          purpose: 'poke holes',
          model: 'local',
          modelWhy: 'x',
          capabilities: [],
          need: NEEDS[0],
        },
      ],
      { gate: allowAllProviders, userGrants: [] },
    )
    expect(R.rowCapabilityLine(rows[0])).toContain('no capabilities')
  })

  it('keeps an unusable seat WITH its reason — never a quiet drop', () => {
    const gate: RosterGate = (t) => (t === 'gemini' ? "Gemini CLI isn't connected" : '')
    const { rows, sitOut } = R.reviewRoster(
      [
        {
          name: 'Scout',
          purpose: 'research',
          model: 'gemini',
          modelWhy: 'x',
          capabilities: [],
          need: NEEDS[0],
        },
      ],
      { gate, userGrants: [] },
    )
    expect(rows[0].sitOutReason).toContain("isn't connected")
    expect(R.rosterSitOutLine(sitOut)).toContain("Scout can't be staffed")
  })
})

describe('the store — a proposal is not a team', () => {
  beforeEach(fresh)

  function propose() {
    const parsed = R.parseRosterBlock(block([SCOUT, WRITER]), EVIDENCE)
    if (parsed.status !== 'ok') throw new Error('fixture should parse')
    return R.propose(parsed.input, 1000)
  }

  it('records nothing in the agent library until Create', () => {
    const before = A.list().length
    const p = propose()
    expect(p).not.toBeNull()
    expect(A.list()).toHaveLength(before)
    expect(R.openRosters(R.list())).toHaveLength(1)
  })

  it('creates the WHOLE roster on ONE approval', () => {
    const p = propose()!
    const out = R.createFromRoster(p.id, p.roles, {
      gate: allowAllProviders,
      userGrants: ['vault', 'web', 'writes'],
    }, 2000)
    expect(out).not.toBeNull()
    expect(out!.created).toHaveLength(2)
    expect(out!.created.map((a) => a.name)).toEqual(['Market scout', 'Writer'])
    // Both agents belong to the project, and start with no borrowed history.
    for (const agent of out!.created) {
      expect(agent.assignedTo).toBe('proj-1')
      expect(agent.usage).toBe(0)
      expect(agent.evalScore).toBe(0)
    }
    expect(R.list()[0].status).toBe('created')
  })

  it('creates exactly what was EDITED — the originals are never used', () => {
    const p = propose()!
    const edited: RosterRole[] = [
      { ...p.roles[0], name: 'Market analyst', model: 'claude', capabilities: ['web'] },
      { ...p.roles[1], purpose: 'draft AND ship the page' },
    ]
    const out = R.createFromRoster(p.id, edited, {
      gate: allowAllProviders,
      userGrants: ['vault', 'web', 'writes'],
    }, 2000)!
    expect(out.created[0].name).toBe('Market analyst')
    expect(out.created[0].model).toBe('claude')
    expect(out.created[0].skills).toEqual(['web'])
    expect(out.created[1].role).toBe('draft AND ship the page')
    // No agent carries the ORIGINAL values.
    expect(A.list().some((a) => a.name === 'Market scout')).toBe(false)
    // And the audit copy records what was really created.
    expect(R.list()[0].roles[0].name).toBe('Market analyst')
  })

  it('NEVER creates an agent holding a capability the user lacks', () => {
    const p = propose()!
    const out = R.createFromRoster(p.id, p.roles, {
      gate: allowAllProviders,
      userGrants: ['vault'],
    }, 2000)!
    // Researcher asked for vault+web; the user has only vault.
    expect(out.created[0].skills).toEqual(['vault'])
    // Writer asked for writes; the user does not have it at all.
    expect(out.created[1].skills).toEqual([])
  })

  it('does not staff a seat whose AI cannot answer, and says why', () => {
    const p = propose()!
    const gate: RosterGate = (t) => (t === 'claude' ? 'Claude is switched off in Settings' : '')
    const out = R.createFromRoster(p.id, p.roles, { gate, userGrants: ['vault', 'web'] }, 2000)!
    expect(out.created.map((a) => a.name)).toEqual(['Market scout'])
    expect(out.sitOut[0].reason).toContain('switched off')
  })

  it('a double tap never mints a second team', () => {
    const p = propose()!
    const opts = { gate: allowAllProviders, userGrants: ['vault', 'web', 'writes'] as Capability[] }
    expect(R.createFromRoster(p.id, p.roles, opts, 2000)).not.toBeNull()
    expect(R.createFromRoster(p.id, p.roles, opts, 2001)).toBeNull()
    expect(A.list().filter((a) => a.assignedTo === 'proj-1')).toHaveLength(2)
  })

  it('suffixes a name already in the library instead of shadowing it', () => {
    A.create({ name: 'Market scout', role: 'existing', model: 'local' })
    const p = propose()!
    // The desk warns about the collision BEFORE the tap...
    expect(R.plannedNames(p.roles)[0]).toBe('Market scout 2')
    const out = R.createFromRoster(p.id, p.roles, {
      gate: allowAllProviders,
      userGrants: ['vault', 'web', 'writes'],
    }, 2000)!
    // ...and Create writes exactly the name it warned about.
    expect(out.created[0].name).toBe('Market scout 2')
  })

  it('refuses to nag: one open roster per project, and staffing happens once', () => {
    const parsed = R.parseRosterBlock(block([SCOUT, WRITER]), EVIDENCE)
    if (parsed.status !== 'ok') throw new Error('fixture')
    expect(R.propose(parsed.input, 1000)).not.toBeNull()
    expect(R.propose(parsed.input, 1001)).toBeNull()
    expect(R.blockedReason(parsed.input)).toContain('already waiting')
    const open = R.openRosters(R.list())[0]
    R.createFromRoster(open.id, open.roles, {
      gate: allowAllProviders,
      userGrants: ['vault', 'web', 'writes'],
    }, 2000)
    expect(R.blockedReason(parsed.input)).toContain('already been staffed')
  })

  it('a dismissal is sticky for the same needs, but new needs are a new argument', () => {
    const p = propose()!
    R.dismiss(p.id, 1500)
    const parsed = R.parseRosterBlock(block([SCOUT, WRITER]), EVIDENCE)
    if (parsed.status !== 'ok') throw new Error('fixture')
    expect(R.propose(parsed.input, 1600)).toBeNull()
    expect(R.blockedReason(parsed.input)).toContain('same needs')
    const grown = {
      ...parsed.input,
      evidence: { ...EVIDENCE, needs: [...NEEDS, 'a pricing calculator'] },
    }
    expect(R.propose(grown, 1700)).not.toBeNull()
  })

  it('persists the ledger vault-side with resolveVaultDir FIRST', async () => {
    propose()
    native.writeVaultNote.mockClear()
    await R.persistRostersToVault('~/vault')
    expect(native.resolveVaultDir).toHaveBeenCalledWith('~/vault')
    const [vault, relpath] = native.writeVaultNote.mock.calls[0]
    expect(vault).toBe('/home/sukh/vault')
    expect(relpath).toBe(R.ROSTER_VAULT_PATH)
  })

  it('hydrates a decided record from the vault over an older open copy', async () => {
    const p = propose()!
    native.readVaultFile.mockResolvedValueOnce(
      JSON.stringify([{ ...p, status: 'dismissed', decidedAt: 9999 }]),
    )
    expect(await R.hydrateRostersFromVault()).toBe(1)
    expect(R.list()[0].status).toBe('dismissed')
  })
})
