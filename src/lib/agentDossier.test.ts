import { describe, expect, it } from 'vitest'
import {
  agentDossier,
  agentsInRun,
  aiLabel,
  dossierCostLine,
  routingLine,
  toolEnding,
  toolTarget,
} from './agentDossier'
import { IDLE_HUE } from './modelColor'
import type { EngineSpan } from './nativeEngine'

// Spans shaped exactly like the ones in Sukhdeep's real sc-vault/spans.jsonl —
// including the `reason` attr the engine writes when the egress floor pins a
// call to the on-device model, which is the most useful thing the panel shows
// and the easiest thing to accidentally invent.
const call = (over: Partial<EngineSpan> & { attrs?: Record<string, unknown> } = {}): EngineSpan => ({
  name: 'model_call',
  type: 'model_call',
  status: 'ok',
  duration_ms: 8_000,
  ...over,
  attrs: {
    agent: 'researcher',
    provider: 'local',
    model: 'Qwen3.8-27B-4bit',
    is_local: true,
    is_real: true,
    round: 1,
    tokens_in: 900,
    tokens_out: 100,
    ...(over.attrs ?? {}),
  },
})

const tool = (over: Partial<EngineSpan> & { attrs?: Record<string, unknown> } = {}): EngineSpan => {
  const given = over.attrs ?? {}
  // The default target is only supplied when the caller named none — otherwise
  // a fixture default (a vault path) would shadow the url/query under test,
  // since `toolTarget` reads path first.
  const hasTarget = 'path' in given || 'query' in given || 'url' in given || 'server' in given
  return {
    name: 'tool_exec',
    type: 'tool_exec',
    status: 'ok',
    duration_ms: 40,
    ...over,
    attrs: {
      agent: 'researcher',
      tool: 'vault_read',
      ok: true,
      ...(hasTarget ? {} : { path: 'notes/pricing.md' }),
      ...given,
    },
  }
}

describe('opening the file on ONE coworker', () => {
  it('gathers only that agent’s spans, never the crew’s', () => {
    const spans = [
      call({ attrs: { agent: 'lead', tokens_in: 500, tokens_out: 50 } }),
      call({ attrs: { agent: 'researcher', tokens_in: 900, tokens_out: 100 } }),
      tool({ attrs: { agent: 'lead', tool: 'vault_list' } }),
    ]
    const d = agentDossier(spans, 'researcher', true)!
    expect(d.turns).toHaveLength(1)
    expect(d.tools).toHaveLength(0)
    expect(d.tokensIn).toBe(900)
  })

  it('sums tokens and model time from REAL attrs, never an estimate', () => {
    const d = agentDossier(
      [
        call({ duration_ms: 8_000, attrs: { tokens_in: 900, tokens_out: 100 } }),
        call({ duration_ms: 12_000, attrs: { tokens_in: 1_100, tokens_out: 300 } }),
      ],
      'researcher',
      false,
    )!
    expect(d.tokensIn).toBe(2_000)
    expect(d.tokensOut).toBe(400)
    expect(d.modelMs).toBe(20_000)
  })

  it('a turn that reported no tokens contributes nothing — not a guess', () => {
    const d = agentDossier([call({ attrs: { tokens_in: undefined, tokens_out: undefined } })], 'researcher', false)!
    expect(d.tokensIn).toBe(0)
    expect(d.tokensOut).toBe(0)
    expect(dossierCostLine(d)).not.toMatch(/in \//)
  })

  it('an agent that never ran has NO file to open', () => {
    expect(agentDossier([call()], 'nobody', true)).toBeNull()
    expect(agentDossier([], 'researcher', true)).toBeNull()
    expect(agentDossier([call()], '  ', true)).toBeNull()
  })
})

describe('what it says about where the work ran', () => {
  it('quotes the ENGINE’s own reason, verbatim — the thing the UI cannot infer', () => {
    const reason = 'vault content read -> kept local (no egress)'
    const d = agentDossier([call({ attrs: { reason } })], 'researcher', false)!
    expect(d.turns[0].reason).toBe(reason)
    expect(routingLine(d)).toBe(reason)
  })

  it('falls back to the bare fact when the engine gave no reason', () => {
    const local = agentDossier([call({ attrs: { reason: '' } })], 'researcher', false)!
    expect(routingLine(local)).toBe('ran on your Mac')
    const cloud = agentDossier(
      [call({ attrs: { reason: '', is_local: false, provider: 'claude-cli', model: 'opus' } })],
      'researcher',
      false,
    )!
    expect(routingLine(cloud)).toBe('answered by a cloud model')
  })

  it('“stayed on your Mac” needs EVERY turn local, not most of them', () => {
    const mixed = agentDossier(
      [call({ attrs: { is_local: true } }), call({ attrs: { is_local: false, provider: 'claude-cli' } })],
      'researcher',
      false,
    )!
    expect(mixed.allLocal).toBe(false)

    const all = agentDossier([call(), call()], 'researcher', false)!
    expect(all.allLocal).toBe(true)
  })

  it('names the model that answered LAST, because that is what it is running on now', () => {
    const d = agentDossier(
      [call(), call({ attrs: { provider: 'claude-cli', model: 'opus', is_local: false } })],
      'researcher',
      false,
    )!
    expect(d.ai).toBe('claude-cli · opus')
  })

  it('a tool-only agent borrows no colour from a call that never happened', () => {
    const d = agentDossier([tool()], 'researcher', false)!
    expect(d.color).toBe(IDLE_HUE)
    expect(d.ai).toBe('')
    expect(d.allLocal).toBe(false)
  })
})

describe('a paused run can never make a coworker look busy', () => {
  it('an open span is live only when the RUN is live', () => {
    const open = call({ status: 'running' })
    expect(agentDossier([open], 'researcher', true)!.live).toBe(true)
    expect(agentDossier([open], 'researcher', false)!.live).toBe(false)
  })

  it('a closed span is never live, however live the run is', () => {
    expect(agentDossier([call({ status: 'ok' })], 'researcher', true)!.live).toBe(false)
    expect(agentDossier([call({ status: 'error' })], 'researcher', true)!.live).toBe(false)
  })
})

describe('how a tool call really ended', () => {
  it('a gate refusal is a BLOCK, not a failure — it is a win and must read as one', () => {
    // The engine writes ok:false alongside blocked:true. Calling that "failed"
    // would turn a governance win into a bug report.
    expect(toolEnding({ blocked: true, ok: false })).toBe('blocked')
  })

  it('parked on a human decision is HELD, not failed', () => {
    expect(toolEnding({ held: true })).toBe('held')
    expect(toolEnding({ awaiting: true })).toBe('held')
  })

  it('a result kept out of a cloud POST is WITHHELD — the egress gate firing', () => {
    expect(toolEnding({ withheld: true })).toBe('withheld')
  })

  it('a real error is a failure', () => {
    expect(toolEnding({ is_error: true })).toBe('failed')
    expect(toolEnding({ ok: false })).toBe('failed')
  })

  it('and a plain call is plainly ok', () => {
    expect(toolEnding({ ok: true })).toBe('ok')
    expect(toolEnding(undefined)).toBe('ok')
  })

  it('names what the tool was pointed at, whichever attr carried it', () => {
    expect(toolTarget({ path: 'notes/a.md' })).toBe('notes/a.md')
    expect(toolTarget({ query: 'pricing' })).toBe('pricing')
    expect(toolTarget({ url: 'https://x.test' })).toBe('https://x.test')
    expect(toolTarget({})).toBe('')
  })

  it('carries every tool the agent ran, with its real ending', () => {
    const d = agentDossier(
      [
        tool({ attrs: { tool: 'vault_read', path: 'a.md', ok: true } }),
        tool({ attrs: { tool: 'web_fetch', url: 'https://x.test', blocked: true, ok: false } }),
      ],
      'researcher',
      false,
    )!
    expect(d.tools).toEqual([
      { name: 'vault_read', target: 'a.md', ending: 'ok', ms: 40 },
      { name: 'web_fetch', target: 'https://x.test', ending: 'blocked', ms: 40 },
    ])
  })
})

describe('the crew, and the labels', () => {
  it('lists every agent that really appears, in the order they first did', () => {
    const spans = [
      call({ attrs: { agent: 'lead' } }),
      call({ attrs: { agent: 'researcher' } }),
      call({ attrs: { agent: 'lead' } }),
      tool({ attrs: { agent: 'critic' } }),
    ]
    expect(agentsInRun(spans)).toEqual(['lead', 'researcher', 'critic'])
  })

  it('a span with no agent attr adds nobody', () => {
    expect(agentsInRun([{ name: 'model_call', type: 'model_call', attrs: {} }])).toEqual([])
  })

  it('the ai label degrades honestly when the span named only one half', () => {
    expect(aiLabel({ provider: 'local', model: 'Qwen' })).toBe('local · Qwen')
    expect(aiLabel({ provider: 'local' })).toBe('local')
    expect(aiLabel({ model: 'Qwen' })).toBe('Qwen')
    expect(aiLabel({})).toBe('')
  })

  it('the cost line states turns, real tokens and real time', () => {
    const d = agentDossier(
      [call({ duration_ms: 90_000, attrs: { tokens_in: 12_400, tokens_out: 900 } })],
      'researcher',
      false,
    )!
    expect(dossierCostLine(d)).toBe('1 turn · 12k in / 900 out · 1m 30s')
  })

  it('carries the CUT-OFF flag, because a truncated reasoning reply looks insane', () => {
    // Measured on the real endpoint: when the output cap bites, the server
    // returns the model's own monologue as the answer ("We need answer user's
    // request. Need produce final...") with reasoning_content empty. Without
    // this flag the panel shows that as what the agent said.
    const cut = agentDossier([call({ attrs: { truncated: true } })], 'researcher', false)!
    expect(cut.turns[0].truncated).toBe(true)
    const clean = agentDossier([call()], 'researcher', false)!
    expect(clean.turns[0].truncated).toBe(false)
  })

  it('records the stages it appeared at, in order, from the engine’s own attr', () => {
    const d = agentDossier(
      [call({ attrs: { round: 1 } }), call({ attrs: { round: 2 } }), call({ attrs: { round: 'synthesis' } })],
      'researcher',
      false,
    )!
    expect(d.stages).toEqual(['1', '2', 'synthesis'])
  })
})
