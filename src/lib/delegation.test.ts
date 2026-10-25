import { describe, expect, it } from 'vitest'

import { agentCapabilityNames,
  CAPABILITIES,
  VAULT_FLOOR_REASON,
  agentCapabilitiesArg,
  appRunCapabilities,
  availableTeam,
  capabilityLabel,
  decideRouting,
  delegationLine,
  delegationSteps,
  delegationSummary,
  grantSubset,
  normalizeCapabilities,
  routingLine,
  sensitiveFloorReason,
  sensitiveHit,
  spansForTask,
  teamCapabilityArgs,
  userCapabilities,
  userCapabilitiesArg,
  type Capability,
  type Teammate,
} from './delegation'
import { routeReasonLabel, type EngineSpan } from './nativeEngine'
import { DEFAULT_SETTINGS } from './settings'

// The two AI that genuinely work on this install (measured 2026-08-15): Claude
// on the subscription CLI (~10s, strongest reasoner) and the local gemma
// (~15s, zero egress). Gemini is unavailable — Google closed that login for
// individual accounts — which is exactly the honest-single/honest-pair case.
const CLAUDE: Teammate = {
  token: 'claude',
  label: 'Claude',
  local: false,
  typicalSeconds: 10,
  strongestReasoner: true,
}
const LOCAL: Teammate = {
  token: 'local',
  label: 'your local model',
  local: true,
  typicalSeconds: 15,
  strongestReasoner: false,
}

describe('capabilities — the app-side mirror', () => {
  it('carries only what the engine can enforce', () => {
    expect([...CAPABILITIES]).toEqual(['vault', 'web', 'computer', 'terminal', 'tools', 'writes'])
  })

  it('drops a name the engine has no gate for', () => {
    expect(normalizeCapabilities('vault, WEB , telepathy')).toEqual(['vault', 'web'])
  })

  it('derives the user grant from real state, never assumed', () => {
    const settings = { webResearch: true, projectWrites: false, computerControl: false, terminalControl: false }
    expect(
      userCapabilities({ settings, vaultToolsGranted: true, mcpServers: 0 }),
    ).toEqual(['vault', 'web'])
    expect(
      userCapabilities({
        settings: { webResearch: false, projectWrites: true, computerControl: false, terminalControl: false },
        vaultToolsGranted: false,
        mcpServers: 2,
      }),
    ).toEqual(['tools', 'writes'])
  })

  it('never lets a request exceed the user (the display mirror of the engine rule)', () => {
    const { granted, refused } = grantSubset(['vault'], ['vault', 'web', 'writes'])
    expect(granted).toEqual(['vault'])
    expect(refused.map((r) => r.capability)).toEqual(['web', 'writes'])
    expect(refused[0].reason).toContain('you have not granted')
  })

  it('names each capability in plain words', () => {
    expect(capabilityLabel('vault')).toBe('read your vault')
    expect(capabilityLabel('writes')).toBe('write project files')
  })

  it('serializes the grant for the engine argv', () => {
    expect(userCapabilitiesArg(['web', 'vault'])).toBe('vault,web')
    const json = agentCapabilitiesArg([
      { name: 'Researcher', capabilities: ['web'] },
      { name: '  ', capabilities: ['vault'] },
      { name: 'Scribe', capabilities: [] },
    ])
    expect(JSON.parse(json)).toEqual({ Researcher: ['web'], Scribe: [] })
  })
})

describe('decideRouting — never a silent pick', () => {
  it('always carries a reason', () => {
    const choice = decideRouting({ intent: 'draft the launch note', team: [CLAUDE, LOCAL] })
    expect(choice.reason).not.toBe('')
    expect(routingLine(choice)).toContain(choice.reason)
  })

  it('refuses honestly when nobody can answer, naming every excluded seat', () => {
    const choice = decideRouting({
      intent: 'anything',
      team: [],
      sitOut: [{ role: 'Claude', token: 'claude', reason: 'Claude is switched off in Settings' }],
    })
    expect(choice.mode).toBe('refused')
    expect(choice.assigned).toEqual([])
    expect(choice.reason).toContain('Claude is switched off in Settings')
  })

  it('routes reasoning work to the strongest reasoner, and says that is why', () => {
    const choice = decideRouting({
      intent: 'debug why the gateway drops the retry',
      team: [CLAUDE, LOCAL],
    })
    expect(choice.mode).toBe('delegate')
    expect(choice.assigned[0].token).toBe('claude')
    expect(choice.reason).toContain('strongest reasoner')
    expect(choice.reason).toContain('debug')
  })

  it('routes bulk work local, and says egress is why', () => {
    const choice = decideRouting({
      intent: 'summarize these twelve meeting notes',
      team: [CLAUDE, LOCAL],
    })
    expect(choice.assigned[0].token).toBe('local')
    expect(choice.reason).toContain('egress')
  })

  it("says 'the manager itself' when the manager's own AI is the pick", () => {
    const choice = decideRouting({
      intent: 'plan the next tranche',
      team: [CLAUDE, LOCAL],
      managerToken: 'claude',
    })
    expect(choice.mode).toBe('self')
    expect(routingLine(choice)).toContain('the manager itself')
  })

  it('assembles a team when asked and 2+ AI can really run', () => {
    const choice = decideRouting({
      intent: 'research and then critique the pricing model',
      team: [CLAUDE, LOCAL],
      wantsTeam: true,
    })
    expect(choice.mode).toBe('team')
    expect(choice.assigned.map((t) => t.token)).toEqual(['claude', 'local'])
    expect(choice.reason).toContain('leads')
    expect(choice.reason).toContain('your local model')
  })
})

describe('decideRouting — the floor always wins', () => {
  it("keeps a sensitive job local and shows the ENGINE's own reason", () => {
    const choice = decideRouting({
      intent: 'summarize my mortgage statement',
      sensitiveWords: ['mortgage'],
      team: [CLAUDE, LOCAL],
    })
    expect(choice.floor).toBe(true)
    expect(choice.assigned[0].token).toBe('local')
    // Byte-identical to gateway.py's own RouteDecision.reason...
    expect(choice.engineReason).toBe("sensitive keyword 'mortgage' -> keep local (no egress)")
    // ...and rendered through the SAME mapper the verdict card uses, so the
    // sentence before the run is the sentence after it.
    expect(choice.reason).toContain(routeReasonLabel(false, [choice.engineReason]))
    expect(choice.reason).toContain('zero egress')
  })

  it('beats a reasoning keyword that would otherwise pull it to Claude', () => {
    const choice = decideRouting({
      // 'debug' is a HEAVY word — without the floor this goes to Claude.
      intent: 'debug the payroll export for my salary rows',
      sensitiveWords: ['salary'],
      team: [CLAUDE, LOCAL],
    })
    expect(choice.assigned[0].token).toBe('local')
    expect(choice.engineReason).toContain('salary')
  })

  it('beats an explicit team ask — a team cannot egress what the floor holds', () => {
    const choice = decideRouting({
      intent: 'review my salary bands with the team',
      sensitiveWords: ['salary'],
      team: [CLAUDE, LOCAL],
      wantsTeam: true,
    })
    expect(choice.mode).not.toBe('team')
    expect(choice.assigned).toEqual([LOCAL])
  })

  it('uses loop.py VAULT_LOCAL_REASON verbatim for a vault-derived job', () => {
    const choice = decideRouting({
      intent: 'what did I decide about pricing last month',
      vaultDerived: true,
      team: [CLAUDE, LOCAL],
    })
    expect(choice.engineReason).toBe(VAULT_FLOOR_REASON)
    expect(choice.engineReason).toBe('vault content read -> kept local (no egress)')
    expect(choice.assigned[0].local).toBe(true)
  })

  it('refuses rather than egressing when there is nowhere local to run it', () => {
    const choice = decideRouting({
      intent: 'summarize my mortgage statement',
      sensitiveWords: ['mortgage'],
      team: [CLAUDE],
    })
    expect(choice.mode).toBe('refused')
    expect(choice.floor).toBe(true)
    expect(choice.reason).toContain('no local model is connected')
  })

  it('matches the user own words case-insensitively', () => {
    expect(sensitiveHit('My MORTGAGE is due', ['mortgage'])).toBe('mortgage')
    expect(sensitiveHit('nothing private here', ['mortgage'])).toBe('')
    expect(sensitiveFloorReason('x')).toBe("sensitive keyword 'x' -> keep local (no egress)")
  })
})

describe('decideRouting — one AI is not a team', () => {
  it('says so plainly instead of performing a roster', () => {
    const choice = decideRouting({
      intent: 'research and critique the pricing model',
      team: [CLAUDE],
      wantsTeam: true,
      sitOut: [
        { role: 'Gemini', token: 'gemini', reason: "Gemini CLI (Google login) isn't connected" },
      ],
    })
    expect(choice.mode).not.toBe('team')
    expect(choice.assigned).toEqual([CLAUDE])
    expect(choice.soloNote).toContain('not a team')
    expect(choice.reason).toContain('not a team')
  })

  it('keeps the excluded seat and its reason — never a quiet shrink', () => {
    const choice = decideRouting({
      intent: 'anything',
      team: [CLAUDE, LOCAL],
      sitOut: [
        { role: 'Gemini', token: 'gemini', reason: "Gemini CLI (Google login) isn't connected" },
      ],
    })
    expect(choice.sitOut).toHaveLength(1)
    expect(choice.sitOut[0].reason).toContain("isn't connected")
    expect(choice.soloNote).toBe('')
  })
})

describe('availableTeam — reuses the roster gate, never invents a seat', () => {
  it('excludes a provider that is switched off, with its reason', () => {
    const { team, sitOut } = availableTeam(DEFAULT_SETTINGS)
    // Defaults: only the local model is enabled; the cloud brands are off.
    expect(team.map((t) => t.token)).toEqual(['local'])
    const gemini = sitOut.find((s) => s.token === 'gemini')
    expect(gemini?.reason).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Delegation — derived from real spans only
// ---------------------------------------------------------------------------

function modelCall(attrs: Record<string, unknown>, start = 1): EngineSpan {
  return { name: 'model_call', type: 'model_call', start, attrs }
}

describe('delegationSteps — agent + AI + ask + outcome, all from spans', () => {
  it('renders one row per delegated turn', () => {
    const steps = delegationSteps([
      modelCall(
        {
          agent: 'Researcher',
          provider: 'local',
          model: 'gemma-4-26b',
          round: '1',
          is_real: true,
          tokens_out: 412,
        },
        1,
      ),
      modelCall(
        {
          agent: 'Lead',
          provider: 'claude-cli',
          model: 'opus',
          round: 'synthesis',
          is_real: true,
          tokens_out: 900,
        },
        2,
      ),
    ])
    expect(steps).toHaveLength(2)
    expect(steps[0].agent).toBe('Researcher')
    expect(steps[0].ai).toBe('local · gemma-4-26b')
    expect(steps[0].asked).toContain('round 1')
    expect(steps[0].outcome).toContain('412')
    expect(steps[1].asked).toContain("pull the team's work")
    expect(delegationLine(steps[1])).toBe(
      "Lead · claude-cli · opus — asked to pull the team's work into one answer → answered (900 tokens back)",
    )
  })

  it('never dresses an unreachable provider as a completed turn', () => {
    const steps = delegationSteps([
      modelCall({ agent: 'Scout', provider: 'gemini-cli', model: 'opus', is_real: false }),
    ])
    expect(steps[0].state).toBe('unreachable')
    expect(steps[0].outcome).toContain('nothing was sent')
  })

  it('reads an open turn as still working, never as a pass', () => {
    const steps = delegationSteps([modelCall({ agent: 'Scout', provider: 'local', model: 'g' })])
    expect(steps[0].state).toBe('working')
    expect(steps[0].outcome).toBe('')
    expect(delegationLine(steps[0])).toContain('still working')
  })

  it('shows a capability the ENGINE refused — enforcement is visible', () => {
    const steps = delegationSteps([
      {
        name: 'tool_exec',
        type: 'tool_exec',
        start: 3,
        attrs: {
          agent: 'Scribe',
          provider: 'web',
          tool: 'web_fetch',
          refused: true,
          reason: 'Scribe was not granted the web capability',
        },
      },
    ])
    expect(steps[0].state).toBe('refused')
    expect(steps[0].asked).toBe('use web_fetch')
    expect(steps[0].outcome).toContain('not granted')
  })

  it('ignores a solo run — a span with no agent is not a delegation', () => {
    expect(delegationSteps([modelCall({ provider: 'local', model: 'g', is_real: true })])).toEqual(
      [],
    )
  })

  it('orders by the real span clock', () => {
    const steps = delegationSteps([
      modelCall({ agent: 'B', provider: 'p', model: 'm', is_real: true }, 9),
      modelCall({ agent: 'A', provider: 'p', model: 'm', is_real: true }, 2),
    ])
    expect(steps.map((s) => s.agent)).toEqual(['A', 'B'])
  })

  it('summarizes without claiming activity that is not there', () => {
    expect(delegationSummary([])).toBe('')
    const steps = delegationSteps([
      modelCall({ agent: 'A', provider: 'local', model: 'g', is_real: true }, 1),
      modelCall({ agent: 'B', provider: 'claude-cli', model: 'opus', is_real: true }, 2),
    ])
    expect(delegationSummary(steps)).toBe('2 agents on 2 AIs')
  })
})

describe('spansForTask — a step is never pinned on the wrong run', () => {
  const tail: EngineSpan[] = [
    // An OLDER run, still in the tail.
    { name: 'run:old', type: 'run', span_id: 'r1', start: 1, attrs: { task_id: 'OLD' } },
    {
      name: 'model_call',
      type: 'model_call',
      span_id: 'm1',
      parent_id: 'r1',
      start: 2,
      attrs: { agent: 'Ghost', provider: 'local', model: 'g', is_real: true },
    },
    // THE run we care about.
    { name: 'run:new', type: 'run', span_id: 'r2', start: 3, attrs: { task_id: 'NEW' } },
    {
      name: 'model_call',
      type: 'model_call',
      span_id: 'm2',
      parent_id: 'r2',
      start: 4,
      attrs: { agent: 'Scout', provider: 'local', model: 'g', is_real: true },
    },
    // A grandchild — parentage is walked, not just one level.
    {
      name: 'tool_exec',
      type: 'tool_exec',
      span_id: 't1',
      parent_id: 'm2',
      start: 5,
      attrs: { agent: 'Scout', provider: 'web', tool: 'web_fetch', refused: true, reason: 'no web' },
    },
  ]

  it('returns only the named run family', () => {
    const mine = spansForTask(tail, 'NEW')
    expect(mine.map((s) => s.span_id)).toEqual(['m2', 't1'])
    expect(delegationSteps(mine).every((s) => s.agent === 'Scout')).toBe(true)
  })

  it('returns NOTHING when the run has aged out of the tail', () => {
    expect(spansForTask(tail, 'GONE')).toEqual([])
    expect(spansForTask(tail, '')).toEqual([])
  })

  it("never leaks another run's steps", () => {
    expect(spansForTask(tail, 'OLD').map((s) => s.span_id)).toEqual(['m1'])
  })
})

describe('the engine seam — capability argv', () => {
  it('sends NOTHING when no seat was staffed (no grant → no gate)', () => {
    expect(
      teamCapabilityArgs([{ name: 'lead', capabilities: [] }], ['vault', 'web']),
    ).toBeNull()
  })

  it('sends the ceiling and the per-agent request when a seat IS staffed', () => {
    const args = teamCapabilityArgs(
      [
        { name: 'lead', capabilities: ['vault'] },
        { name: 'scout', capabilities: [] },
      ],
      ['vault', 'writes'],
    )
    expect(args).not.toBeNull()
    expect(args!.userCapabilities).toBe('vault,writes')
    expect(JSON.parse(args!.agentCapabilities)).toEqual({ lead: ['vault'], scout: [] })
  })

  it('states the ceiling from run facts, not guesses', () => {
    // vault: the vault source is built for every app run. tools: the bridge
    // passes no --mcp-server, so an app run has none. web/writes: Settings.
    expect(appRunCapabilities({ webResearch: false, projectWrites: false, computerControl: false, terminalControl: false })).toEqual(['vault'])
    expect(appRunCapabilities({ webResearch: true, projectWrites: true, computerControl: false, terminalControl: false })).toEqual([
      'vault',
      'web',
      'writes',
    ])
  })
})

describe('the capability vocabulary matches the engine', () => {
  it('every capability the UI can show has an engine gate', () => {
    // Mirrors engine/scprism_engine/capabilities.py :: CAPABILITIES. If this
    // ever drifts, the app could show a grant nothing enforces.
    const engineSide: Capability[] = ['vault', 'web', 'computer', 'terminal', 'tools', 'writes']
    expect([...CAPABILITIES].sort()).toEqual([...engineSide].sort())
  })
})

// UI/UX pass (2026-08-29, felt firsthand in the browser walk): the refused
// routing strip rendered a full governance PARAGRAPH above a still-full
// composer — reads as breakage, not guidance. The strip now gets ONE
// actionable line; the full reason still lands in-thread when a launch is
// actually refused (sendTeam's notice path, unchanged).
describe('routingLine — refused mode stays one actionable line', () => {
  it('compacts to a short line pointing at Settings', () => {
    const line = routingLine({
      mode: 'refused',
      assigned: [],
      reason:
        'No agent could run: every seat on this team is on a provider that isn’t connected — Claude sits out: Claude is switched off in Settings · your local model sits out: Local model is unreachable right now. Connect one in Settings and launch again.',
      engineReason: '',
      floor: false,
      soloNote: '',
    } as never)
    expect(line.length).toBeLessThan(90)
    expect(line).toMatch(/nobody can take this/i)
    expect(line).toMatch(/settings/i)
  })
})

// Computer control (2026-08-31): the one capability that must NEVER default
// on. The ceiling includes 'computer' only when the user flipped the grant —
// and the engine's per-agent gate still intersects on top.
describe('the computer capability rides the explicit grant only', () => {
  it('absent by default; present when computerControl is true', () => {
    const base = { webResearch: true, projectWrites: true, computerControl: false, terminalControl: false }
    expect(appRunCapabilities(base)).not.toContain('computer')
    expect(appRunCapabilities(base)).not.toContain('terminal')
    expect(appRunCapabilities({ ...base, computerControl: true })).toContain('computer')
    expect(appRunCapabilities({ ...base, terminalControl: true })).toContain('terminal')
  })
})

// An agent's declared tools ARE its capability request (found live
// 2026-08-31: the seeded Researcher's file said tools:[web] and the gate
// still denied it, because only `skills` was read — the crew then honestly
// reported "permission not granted" for a grant nothing had consulted).
describe('agentCapabilityNames — the file’s tools line is honoured', () => {
  it('reads tools, and still accepts skills for back-compat', () => {
    expect(agentCapabilityNames({ tools: ['web'], skills: ['web-digest'] })).toEqual(['web'])
    expect(agentCapabilityNames({ skills: ['vault'] })).toEqual(['vault'])
    expect(agentCapabilityNames({ tools: ['terminal', 'computer'] })).toEqual([
      'computer',
      'terminal',
    ])
  })

  it('an unknown name is dropped, and no agent yields nothing', () => {
    expect(agentCapabilityNames({ tools: ['telepathy'] })).toEqual([])
    expect(agentCapabilityNames(undefined)).toEqual([])
  })
})
