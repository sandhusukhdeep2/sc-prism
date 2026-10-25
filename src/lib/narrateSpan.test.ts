// Mission Control (2026-08-05 spec §Plain-English narration) — the binding
// honesty rules for the span → sentence mapper:
//
//   1. one line per REAL span, nothing invented;
//   2. names/models/tools come from `span.attrs` ONLY — a missing attr yields
//      a GENERIC honest phrase, never a guessed model or agent name;
//   3. an unknown span kind gets an honest generic line, never a guess about
//      what that step does.
//
// The table below is the contract. Anything that would let a fabricated name
// or a fabricated activity through must fail here.
import { describe, expect, it } from 'vitest'
import { narrateSpan, narrationLines } from './narrate'
import type { EngineSpan } from './nativeEngine'

function span(over: Partial<EngineSpan> & { attrs?: Record<string, unknown> }): EngineSpan {
  return { name: 'model_call', ...over }
}

// Every real model/agent/tool name that may appear in a narration line. If a
// sentence contains one of these, a span attr must have carried it.
const NAMES = ['qwen2.5-coder', 'researcher', 'gemini', 'claude', 'gpt-4o', 'example.com']

describe('narrateSpan — the span → sentence table', () => {
  const table: { what: string; span: EngineSpan; expected: string }[] = [
    {
      what: 'a team member thinking on a named local model',
      span: span({
        type: 'model_call',
        attrs: { agent: 'researcher', provider: 'local', model: 'qwen2.5-coder', is_local: true },
      }),
      expected: 'researcher is thinking on 🔒 local · qwen2.5-coder…',
    },
    {
      what: 'a finished model turn',
      span: span({
        type: 'model_call',
        status: 'ok',
        attrs: { agent: 'critic', provider: 'gemini', model: 'gemini-2.0-flash' },
      }),
      expected: 'critic replied on gemini · gemini-2.0-flash',
    },
    {
      what: 'a model turn that errored',
      span: span({ type: 'model_call', status: 'error', attrs: { agent: 'critic' } }),
      expected: 'critic hit an error',
    },
    {
      what: 'a web fetch, in flight, with a URL attr',
      span: span({
        name: 'tool_exec',
        type: 'tool_exec',
        attrs: { provider: 'web', server: 'web', tool: 'web_fetch', url: 'https://example.com/a/b' },
      }),
      expected: 'fetching example.com…',
    },
    {
      what: 'a web search with a query attr',
      span: span({
        name: 'tool_exec',
        type: 'tool_exec',
        attrs: { provider: 'web', server: 'web', tool: 'web_search', query: 'payroll rules' },
      }),
      expected: 'searching the web for “payroll rules”…',
    },
    {
      what: 'a vault read (Part 1 vault tools)',
      span: span({
        name: 'tool_exec',
        type: 'tool_exec',
        attrs: { provider: 'vault', server: 'vault', tool: 'vault_read' },
      }),
      expected: 'reading your vault…',
    },
    {
      what: 'a finished vault read (no clumsy stemming)',
      span: span({
        name: 'tool_exec',
        type: 'tool_exec',
        status: 'ok',
        attrs: { provider: 'vault', server: 'vault', tool: 'vault_read' },
      }),
      expected: 'read your vault',
    },
    {
      what: 'a vault search',
      span: span({
        name: 'tool_exec',
        type: 'tool_exec',
        attrs: { provider: 'vault', tool: 'vault_search' },
      }),
      expected: 'searching your vault…',
    },
    {
      what: 'an MCP tool naming its server + tool',
      span: span({
        name: 'tool_exec',
        type: 'tool_exec',
        attrs: { provider: 'mcp', server: 'notion', tool: 'search_pages' },
      }),
      expected: 'using notion·search_pages…',
    },
    {
      what: 'Tier-1 in flight',
      span: span({ name: 'tier1', type: 'tool_exec' }),
      expected: 'running your verify command…',
    },
    { what: 'Tier-1 passed', span: span({ name: 'tier1', type: 'tool_exec', status: 'ok', attrs: { passed: true } }), expected: 'your checks passed' },
    { what: 'Tier-1 failed', span: span({ name: 'tier1', type: 'tool_exec', status: 'error', attrs: { passed: false } }), expected: 'your checks failed' },
    {
      // Tier-1 is a PROJECT gate. A chat message has no codebase, so the user's
      // `npm test` was never run — saying "no verify command set" to someone who
      // set one is a lie, and a silent pass is worse.
      what: 'Tier-1 skipped because this run had nothing to verify',
      span: span({
        name: 'tier1', type: 'tool_exec', status: 'ok',
        attrs: { passed: true, skipped: true, commands: [], skipped_commands: ['npm test'] },
      }),
      expected: 'nothing to verify — no project bound, so your checks were skipped',
    },
    {
      // A NEW project's early steps run before the step that writes
      // package.json, and the engine skips the gate for exactly that shape.
      // "no project bound" would be a lie here — a project IS bound; its
      // workspace just doesn't contain what the verify command needs yet.
      what: 'Tier-1 skipped because the bound workspace has no project manifest yet',
      span: span({
        name: 'tier1', type: 'tool_exec', status: 'ok',
        attrs: {
          passed: true, skipped: true, commands: [], skipped_commands: ['npm test'],
          skip_reason:
            'skipped — the workspace has no project to verify yet. `npm test` ran in ' +
            '/w and found no package.json / project manifest (ENOENT) — expected while ' +
            'early steps run before the step that creates it.',
        },
      }),
      expected: 'nothing to verify yet — the workspace has no project manifest, so your checks were skipped',
    },
    {
      what: 'Tier-1 skipped because no verify command is configured at all',
      span: span({
        name: 'tier1', type: 'tool_exec', status: 'ok',
        attrs: { passed: true, skipped: true, commands: [] },
      }),
      expected: 'no verify command set — skipped your checks',
    },
    {
      what: 'the Tier-2 judge (a model_call span NAMED eval)',
      span: span({ name: 'eval', type: 'model_call', attrs: { provider: 'local', model: 'qwen2.5-coder' } }),
      expected: 'grading the result on local · qwen2.5-coder…',
    },
    { what: 'Tier-2 passed', span: span({ name: 'tier2', type: 'verdict', status: 'ok', attrs: { passed: true } }), expected: 'the review passed' },
    { what: 'the verdict — passed', span: span({ name: 'verdict', type: 'verdict', status: 'ok', attrs: { passed: true } }), expected: 'done — passed' },
    { what: 'the verdict — failed', span: span({ name: 'verdict', type: 'verdict', attrs: { passed: false } }), expected: 'done — failed' },
    { what: 'the root run span', span: span({ name: 'run:A-1042', type: 'run', status: 'ok' }), expected: 'the run finished' },
    { what: 'the planner', span: span({ name: 'plan', type: 'hook', status: 'ok' }), expected: 'planned the steps' },
    { what: 'memory retrieval', span: span({ name: 'memory', type: 'retrieval' }), expected: 'looking through what it remembers…' },
    {
      what: 'a governance block',
      span: span({ name: 'tool_exec', type: 'tool_exec', status: 'error', attrs: { provider: 'mcp', server: 'fs', tool: 'delete', blocked: true } }),
      expected: 'blocked fs·delete — your rules said no',
    },
    {
      // A vault withhold is the PROMISE being kept ("your notes stayed here"),
      // so it says so instead of the generic redaction line.
      what: 'a withheld vault result',
      span: span({ name: 'tool_exec', type: 'tool_exec', attrs: { provider: 'vault', tool: 'vault_read', withheld: true } }),
      expected: 'kept your vault content off the cloud',
    },
    {
      what: 'a withheld (sensitive) result from any other tool source',
      span: span({ name: 'tool_exec', type: 'tool_exec', attrs: { provider: 'mcp', server: 'fs', tool: 'read_file', withheld: true } }),
      expected: 'kept a tool result off the cloud (sensitive)',
    },
    {
      // The read NAMES the note when the span carries its path (a real fact
      // from the result) — "reading your vault" is a weaker disclosure.
      what: 'a vault read that named its note',
      span: span({ name: 'tool_exec', type: 'tool_exec', status: 'ok', attrs: { provider: 'vault', server: 'vault', tool: 'vault_read', path: 'notes/health.md' } }),
      expected: 'read notes/health.md',
    },
    {
      what: 'a tool held for approval',
      span: span({ name: 'tool_exec', type: 'tool_exec', attrs: { provider: 'mcp', server: 'notion', tool: 'search_pages', held: true } }),
      expected: 'waiting for your OK to use notion·search_pages',
    },
    // M2 — telemetry appends a span only when it CLOSES, so every span a
    // narration surface can see has already finished. These four read as if
    // they were still happening.
    {
      what: 'a route decision (a finished span, so past tense)',
      span: span({ name: 'route', type: 'route', status: 'ok', attrs: { route: 'local' } }),
      expected: 'routed this to local',
    },
    {
      what: 'an approval gate check',
      span: span({ name: 'gate:web_fetch', type: 'hook', status: 'ok' }),
      expected: 'checked permission for web_fetch',
    },
    {
      what: 'a training write',
      span: span({ name: 'training', type: 'hook', status: 'ok' }),
      expected: 'recorded what it learned',
    },
    {
      what: 'a vault write',
      span: span({ name: 'vault_write:reports/day.md', type: 'tool_exec', status: 'ok' }),
      expected: 'saved reports/day.md to your vault',
    },
  ]

  for (const row of table) {
    it(`${row.what} → “${row.expected}”`, () => {
      expect(narrateSpan(row.span)).toBe(row.expected)
    })
  }
})

// The web branches used to be DEAD CODE: the engine wrote no url/host/query, so
// every real web call fell through to the generic phrase. Below are the span
// shapes `webtools.WebToolProvider.call_tool` actually emits now, so these
// branches are exercised by real spans rather than by hand-written attrs that
// nothing produces. Keep this table in step with `_web_span_attrs`.
describe('narrateSpan — the LIVE web branches, on real span shapes', () => {
  const web = (attrs: Record<string, unknown>, status?: string): EngineSpan =>
    span({ name: 'tool_exec', type: 'tool_exec', status, attrs })

  it('a finished fetch names the host and how much came back', () => {
    expect(
      narrateSpan(
        web(
          {
            provider: 'web',
            server: 'web',
            tool: 'web_fetch',
            url: 'https://docs.anthropic.com/en/docs/agents',
            host: 'docs.anthropic.com',
            status: 200,
            bytes: 49152,
            is_error: false,
          },
          'ok',
        ),
      ),
    ).toBe('fetched docs.anthropic.com — 48 KB')
  })

  it('an in-flight fetch names where it is going', () => {
    expect(
      narrateSpan(
        web({ provider: 'web', server: 'web', tool: 'web_fetch', url: 'https://example.org/a' }),
      ),
    ).toBe('fetching example.org…')
  })

  it('a failed fetch says the real HTTP status, not just "something went wrong"', () => {
    expect(
      narrateSpan(
        web(
          {
            provider: 'web',
            server: 'web',
            tool: 'web_fetch',
            url: 'https://example.com/gone',
            host: 'example.com',
            status: 404,
            is_error: true,
          },
          'ok',
        ),
      ),
    ).toBe("couldn't fetch example.com (404)")
  })

  it('a finished search says the query AND how many hits it got', () => {
    expect(
      narrateSpan(
        web(
          {
            provider: 'web',
            server: 'web',
            tool: 'web_search',
            query: 'mlx speculative decoding',
            result_count: 8,
            is_error: false,
          },
          'ok',
        ),
      ),
    ).toBe('searched the web for “mlx speculative decoding” — 8 results')
  })

  it('a search that found NOTHING says so — 0 is a real answer', () => {
    expect(
      narrateSpan(
        web(
          { provider: 'web', server: 'web', tool: 'web_search', query: 'payroll rules', result_count: 0 },
          'ok',
        ),
      ),
    ).toBe('searched the web for “payroll rules” — 0 results')
  })

  it('a withheld web result STILL reads as withheld (the 🔒 affordance is intact)', () => {
    expect(
      narrateSpan(
        web({ provider: 'web', server: 'web', tool: 'web_fetch', withheld: true }, 'ok'),
      ),
    ).toBe('kept a tool result off the cloud (sensitive)')
  })

  it('a BLOCKED web call names no destination — the engine records none', () => {
    // THE PRIVACY LINE from the UI side: a blocked call did not egress, so its
    // argument is never on the span and can never be narrated.
    const line = narrateSpan(
      web({ provider: 'web', server: 'web', tool: 'web_search', blocked: true }, 'error'),
    )
    expect(line).toBe('blocked web_search — your rules said no')
    expect(line).not.toMatch(/https?:|—\s\d/)
  })
})

describe('narrateSpan — a MISSING attr yields a generic line, never an invented name', () => {
  it('a model_call with no agent and no model names neither', () => {
    const line = narrateSpan(span({ type: 'model_call' }))
    expect(line).toBe('your AI is thinking…')
    for (const n of NAMES) expect(line).not.toContain(n)
  })

  it('a model_call with an agent but NO model does not invent a model', () => {
    const line = narrateSpan(span({ type: 'model_call', attrs: { agent: 'researcher' } }))
    expect(line).toBe('researcher is thinking…')
    expect(line).not.toMatch(/on /)
  })

  it('a web fetch with NO url attr stays generic — no host is guessed', () => {
    const line = narrateSpan(
      span({ name: 'tool_exec', type: 'tool_exec', attrs: { provider: 'web', server: 'web', tool: 'web_fetch' } }),
    )
    expect(line).toBe('fetching a page from the web…')
    for (const n of NAMES) expect(line).not.toContain(n)
  })

  it('a web search with NO query attr does not invent one', () => {
    expect(
      narrateSpan(span({ name: 'tool_exec', type: 'tool_exec', attrs: { provider: 'web', tool: 'web_search' } })),
    ).toBe('searching the web…')
  })

  it('an MCP call with NO server/tool attrs says "a connected tool"', () => {
    const line = narrateSpan(span({ name: 'tool_exec', type: 'tool_exec', attrs: { provider: 'mcp' } }))
    expect(line).toBe('using a connected tool…')
    for (const n of NAMES) expect(line).not.toContain(n)
  })

  it('a Tier-1 span with no passed attr does not claim a result', () => {
    const line = narrateSpan(span({ name: 'tier1', type: 'tool_exec' }))
    expect(line).not.toMatch(/passed|failed/)
  })

  it('a verdict span with no passed attr does not claim pass or fail', () => {
    expect(narrateSpan(span({ name: 'verdict', type: 'verdict' }))).toBe('writing the verdict…')
  })
})

// H2 — the engine opens a model_call with provider/model BEFORE the call and
// sets `is_real` when it closes. `is_real: false` means the gateway STUBBED it
// (no key / unreachable host / unsigned-in CLI): nothing was sent and nothing
// came back. Narrating that as a reply "on claude · claude-sonnet-4-5" is the
// exact fabrication this module exists to prevent — and it contradicted the
// chat, which said "unreachable — nothing was sent" for the same turn.
describe('narrateSpan — a STUBBED model call is never narrated as a reply', () => {
  const stub = (attrs: Record<string, unknown>): EngineSpan =>
    span({ type: 'model_call', status: 'ok', attrs: { is_real: false, ...attrs } })

  it('says it could not reach the model — and does NOT say it replied', () => {
    const line = narrateSpan(stub({ agent: 'lead', provider: 'claude', model: 'claude-sonnet-4-5' }))
    expect(line).toBe("couldn't reach claude · claude-sonnet-4-5 — nothing was sent")
    expect(line).not.toMatch(/replied|thinking/)
  })

  it('names no model when the span carried none', () => {
    expect(narrateSpan(stub({ agent: 'lead' }))).toBe("couldn't reach your AI — nothing was sent")
  })

  it('a stubbed Tier-2 judge did not grade anything either', () => {
    const line = narrateSpan(
      span({ name: 'eval', type: 'model_call', status: 'ok', attrs: { is_real: false, provider: 'gemini', model: 'gemini-2.0-flash' } }),
    )
    expect(line).toBe("couldn't reach gemini · gemini-2.0-flash to grade the result")
    expect(line).not.toMatch(/^graded/)
  })

  it('a REAL call still narrates as the reply it was (is_real true / absent)', () => {
    expect(
      narrateSpan(span({ type: 'model_call', status: 'ok', attrs: { is_real: true, agent: 'lead', provider: 'claude', model: 'sonnet' } })),
    ).toBe('lead replied on claude · sonnet')
    // An OPEN span has no is_real yet — that must not read as a stub.
    expect(narrateSpan(span({ type: 'model_call', attrs: { agent: 'lead' } }))).toBe('lead is thinking…')
  })
})

// H3 — the blocking approval broker emits TWO held=true spans (engine
// approval.py): the pause, then the OUTCOME carrying `resolved`. Reading only
// `held` left an already-answered hold saying "waiting for your OK".
describe('narrateSpan — an ANSWERED approval reports the answer, not the pause', () => {
  const held = (attrs: Record<string, unknown>): EngineSpan =>
    span({
      name: 'tool_exec',
      type: 'tool_exec',
      attrs: { provider: 'mcp', server: 'notion', tool: 'search_pages', held: true, awaiting: true, ...attrs },
    })

  it('allow → "you approved …"', () => {
    expect(narrateSpan(held({ resolved: 'allow' }))).toBe('you approved notion·search_pages')
  })

  it('deny → "you declined …"', () => {
    expect(narrateSpan(held({ resolved: 'deny', status: 'error' }))).toBe('you declined notion·search_pages')
  })

  it('timeout → it timed out waiting, never "approved"', () => {
    const line = narrateSpan(held({ resolved: 'timeout' }))
    expect(line).toBe('notion·search_pages timed out waiting for your OK')
    expect(line).not.toMatch(/approved|declined/)
  })

  it('the pause itself (no `resolved` yet) still says it is waiting', () => {
    expect(narrateSpan(held({}))).toBe('waiting for your OK to use notion·search_pages')
  })

  it('an unknown outcome word claims nothing about which way it went', () => {
    const line = narrateSpan(held({ resolved: 'something-new' }))
    expect(line).not.toMatch(/approved|declined|waiting for your OK to use/)
    expect(line.length).toBeGreaterThan(0)
  })

  it('the pause and its outcome are DIFFERENT lines, so the dupe-collapse keeps both', () => {
    const lines = narrationLines([held({}), held({ resolved: 'allow' })], 10).map((l) => l.text)
    expect(lines).toEqual(['waiting for your OK to use notion·search_pages', 'you approved notion·search_pages'])
  })
})

// L1 — the vault default used to be "reading/read your vault", so ANY vault
// tool the app doesn't know (a future vault_write, say) was claimed as a read.
describe('narrateSpan — an unknown vault tool is not claimed as a read', () => {
  it('defaults to "using/used your vault"', () => {
    const open = span({ name: 'tool_exec', type: 'tool_exec', attrs: { provider: 'vault', tool: 'vault_write' } })
    const done = span({ name: 'tool_exec', type: 'tool_exec', status: 'ok', attrs: { provider: 'vault', tool: 'vault_write' } })
    expect(narrateSpan(open)).toBe('using your vault…')
    expect(narrateSpan(done)).toBe('used your vault')
    expect(narrateSpan(done)).not.toMatch(/read/)
  })

  it('a real vault_read still says read (the explicit entry)', () => {
    expect(
      narrateSpan(span({ name: 'tool_exec', type: 'tool_exec', status: 'ok', attrs: { provider: 'vault', tool: 'vault_read', path: 'notes/health.md' } })),
    ).toBe('read notes/health.md')
  })
})

describe('narrateSpan — an UNKNOWN span kind gets an honest generic line', () => {
  it('names the raw engine step and claims nothing about what it does', () => {
    const line = narrateSpan(span({ name: 'quantum_flux', type: 'hook' }))
    expect(line).toBe('working — engine step “quantum_flux”')
    // No invented activity verbs beyond the honest "working".
    expect(line).not.toMatch(/thinking|fetching|verify|grading|passed|failed/)
  })

  it('an unnamed span still yields an honest line rather than nothing', () => {
    expect(narrateSpan(span({ name: '', type: 'hook' }))).toBe('working — an engine step with no name')
  })

  it('never returns an empty string for any span shape', () => {
    const shapes: EngineSpan[] = [
      span({ name: '' }),
      span({ name: 'unknown', type: undefined }),
      span({ name: 'tool_exec', type: 'tool_exec' }), // tool_exec with NO provider (tier-style)
      span({ name: 'x', attrs: {} }),
    ]
    for (const s of shapes) expect(narrateSpan(s).length).toBeGreaterThan(0)
  })
})

describe('narrationLines', () => {
  it('is empty for no spans — nothing real to say, so nothing is said', () => {
    expect(narrationLines([])).toEqual([])
  })

  it('collapses consecutive duplicates and keeps the newest `limit` lines', () => {
    const spans: EngineSpan[] = [
      span({ name: 'plan', type: 'hook', status: 'ok' }),
      span({ name: 'tool_exec', type: 'tool_exec', attrs: { provider: 'vault', tool: 'vault_read' } }),
      span({ name: 'tool_exec', type: 'tool_exec', attrs: { provider: 'vault', tool: 'vault_read' } }),
      span({ name: 'tier1', type: 'tool_exec', status: 'ok', attrs: { passed: true } }),
      span({ name: 'verdict', type: 'verdict', status: 'ok', attrs: { passed: true } }),
    ]
    const lines = narrationLines(spans, 3).map((l) => l.text)
    expect(lines).toEqual(['reading your vault…', 'your checks passed', 'done — passed'])
  })

  it('emits one line per span in order when limit allows', () => {
    const spans: EngineSpan[] = [
      span({ type: 'model_call', attrs: { agent: 'lead', provider: 'claude', model: 'sonnet' } }),
      span({ name: 'tier1', type: 'tool_exec', status: 'ok', attrs: { passed: true } }),
    ]
    expect(narrationLines(spans, 10).map((l) => l.text)).toEqual([
      'lead is thinking on claude · sonnet…',
      'your checks passed',
    ])
  })
})
