import { describe, expect, it } from 'vitest'
import { narrateStatus, narrateRun } from './narrate'
import type { EngineSpan } from './nativeEngine'
import type { Verdict } from '../engine/types'

// Minimal Verdict fixture — only the fields narrateRun reads matter here.
function verdict(over: Partial<Verdict>): Verdict {
  return {
    taskId: 't', task: 'x',
    route: { target: 'cloud' } as Verdict['route'],
    tier1: {} as Verdict['tier1'],
    tier2: { evalScore: 0.9 } as Verdict['tier2'],
    modelRoute: 'm', passed: true,
    ...over,
  } as Verdict
}

function mc(agent: string, provider: string, route: string, reason: string, isLocal: boolean): EngineSpan {
  return { name: 'model_call', type: 'model_call', status: 'ok', duration_ms: 100, attrs: { agent, provider, route, reason, is_local: isLocal } }
}

describe('narrateStatus', () => {
  it('renders one honest phrase per agent from real span fields; local turns get the lock', () => {
    const spans: EngineSpan[] = [
      mc('planner', 'gemini', 'cloud', 'research', false),
      mc('developer', 'local', 'local', 'private lookup', true),
      mc('lead', 'claude', 'cloud', 'reasoning', false),
    ]
    expect(narrateStatus(spans)).toBe('research → gemini · 🔒 private lookup on local · reasoning → claude')
  })

  it('marks a local route with the lock even when is_local is absent', () => {
    expect(narrateStatus([mc('developer', 'local', 'local', 'secrets', false)])).toBe('🔒 secrets on local')
  })

  it('falls back to the role name when a span carries no reason', () => {
    const s: EngineSpan = { name: 'model_call', type: 'model_call', attrs: { agent: 'lead', provider: 'claude', route: 'cloud' } }
    expect(narrateStatus([s])).toBe('lead → claude')
  })

  it('keeps only the first turn per agent (task-as-spine order)', () => {
    const spans = [mc('developer', 'local', 'local', 'first', true), mc('developer', 'local', 'local', 'second', true)]
    expect(narrateStatus(spans)).toBe('🔒 first on local')
  })

  it('ignores non-model_call spans and returns empty when there is nothing to narrate', () => {
    const tier1: EngineSpan = { name: 'tier1', type: 'tool_exec', status: 'ok', attrs: { passed: true } }
    expect(narrateStatus([tier1])).toBe('')
    expect(narrateStatus([])).toBe('')
  })

  // M4: a tool-using / tool-blocked / result-withheld run must NOT read the same
  // as a plain run — the status line names the real tool + governance activity.
  it('appends an honest tool + governance phrase from real tool_exec spans', () => {
    const call = (over: Record<string, unknown>): EngineSpan => ({
      name: 'tool_exec', type: 'tool_exec', status: 'ok',
      attrs: { provider: 'mcp', server: 'files', tool: 'read_file', ...over },
    })
    const spans: EngineSpan[] = [
      mc('developer', 'claude', 'cloud', 'edits', false),
      call({}),
      call({ blocked: true, status: 'error' }),
      call({ withheld: true }),
    ]
    const s = narrateStatus(spans)
    expect(s).toContain('used 1 tool')
    expect(s).toContain('blocked 1 (governance)')
    expect(s).toContain('withheld 1 result from cloud')
  })

  // Vault disclosure (2026-08-05 audit). `toolPhrase` counted only provider='mcp',
  // so a run that read the user's notes — and even one whose vault result was
  // WITHHELD from the cloud — narrated exactly like a run that touched nothing.
  it('counts vault reads separately and never drops a withheld vault result', () => {
    const vault = (over: Record<string, unknown>): EngineSpan => ({
      name: 'tool_exec', type: 'tool_exec', status: 'ok',
      attrs: { provider: 'vault', server: 'vault', tool: 'vault_read', ...over },
    })
    const s = narrateStatus([
      mc('developer', 'claude', 'cloud', 'edits', false),
      vault({}),
      vault({ tool: 'vault_search' }),
      vault({ withheld: true }),
      vault({ blocked: true, status: 'error' }),
    ])
    // "he read 2 of your notes" is a different fact from "he used 2 tools".
    expect(s).toContain('read 2 vault notes')
    expect(s).not.toContain('used 2 tools')
    expect(s).toContain('withheld 1 result from cloud')
    expect(s).toContain('blocked 1 (governance)')
  })

  // Web disclosure (2026-08-17). `toolPhrase` counted mcp + vault only, so a run
  // that went out to the internet 6 times read exactly like a run that touched
  // nothing — the same blindness vault had, on the tool the user complained about.
  it('counts web lookups separately from other tools', () => {
    const w = (over: Record<string, unknown>): EngineSpan => ({
      name: 'tool_exec', type: 'tool_exec', status: 'ok',
      attrs: { provider: 'web', server: 'web', tool: 'web_fetch', ...over },
    })
    const s = narrateStatus([
      mc('researcher', 'claude', 'cloud', 'lookup', false),
      w({ host: 'docs.anthropic.com', status: 200, bytes: 4096 }),
      w({ tool: 'web_search', query: 'payroll rules', result_count: 8 }),
      w({ withheld: true }),
      w({ blocked: true, status: 'error' }),
    ])
    expect(s).toContain('🌐 2 web lookups')
    expect(s).not.toContain('used 2 tools')
    expect(s).toContain('withheld 1 result from cloud')
    expect(s).toContain('blocked 1 (governance)')
  })

  it('says lookup (singular) for a single web call', () => {
    const s = narrateStatus([
      mc('researcher', 'claude', 'cloud', 'lookup', false),
      { name: 'tool_exec', type: 'tool_exec', status: 'ok',
        attrs: { provider: 'web', server: 'web', tool: 'web_fetch', host: 'example.com' } },
    ])
    expect(s).toContain('1 web lookup')
    expect(s).not.toContain('lookups')
  })

  it('says note (singular) for a single vault read', () => {
    const s = narrateStatus([
      mc('developer', 'claude', 'cloud', 'edits', false),
      { name: 'tool_exec', type: 'tool_exec', status: 'ok',
        attrs: { provider: 'vault', server: 'vault', tool: 'vault_read' } },
    ])
    expect(s).toContain('read 1 vault note')
  })

  it('adds no tool phrase to a plain run, and never a bare phrase with no model activity', () => {
    // No model calls -> stays empty even if a tool_exec span is present.
    const toolOnly: EngineSpan = {
      name: 'tool_exec', type: 'tool_exec', status: 'ok',
      attrs: { provider: 'mcp', server: 'files', tool: 'read_file' },
    }
    expect(narrateStatus([toolOnly])).toBe('')
    // A model-only run reads exactly as before (no tool clutter).
    expect(narrateStatus([mc('lead', 'claude', 'cloud', 'reasoning', false)])).toBe('reasoning → claude')
  })
})

describe('narrateRun', () => {
  it('names the real models used, notes the lock when work stayed local, and reports a pass with the eval', () => {
    const s = narrateRun(
      verdict({
        passed: true,
        native: { models_used: ['gemini · x', 'local · y', 'claude · z'] } as unknown as Verdict['native'],
        tier2: { evalScore: 0.88 } as Verdict['tier2'],
        route: { target: 'local' } as Verdict['route'],
      }),
    )
    expect(s).toContain('gemini · x · local · y · claude · z')
    expect(s).toContain('🔒')
    expect(s).toContain('passed (eval 0.88)')
  })

  // The engine's third outcome, spoken into the project chat. Telling the user
  // "it did not pass verification" about a run whose Tier-1 tests genuinely ran
  // over the files it wrote and PASSED is the exact false report dc4124e set
  // out to stop; this names WHICH tier objected.
  it('an ATTENTION run says the checks passed and the reviewer dissented — never "did not pass verification"', () => {
    const s = narrateRun(
      verdict({
        passed: false,
        outcome: 'attention',
        native: { models_used: ['claude · x'] } as unknown as Verdict['native'],
        tier2: { evalScore: 0.5 } as Verdict['tier2'],
        route: { target: 'cloud' } as Verdict['route'],
      }),
    )
    expect(s).toContain('Tier-1 tests ran over the files it wrote and PASSED')
    expect(s).toContain('the Tier-2 reviewer dissented at 0.50')
    expect(s).toContain('needs a look, not a redo')
    expect(s).not.toContain('did not pass verification')
  })

  it('an ATTENTION run mentions a recorded judge contradiction', () => {
    const s = narrateRun(
      verdict({
        passed: false,
        outcome: 'attention',
        native: { models_used: ['claude · x'] } as unknown as Verdict['native'],
        tier2: {
          evalScore: 0.5,
          contradictions: ['judge called it truncated over 6 files on disk'],
        } as unknown as Verdict['tier2'],
        route: { target: 'cloud' } as Verdict['route'],
      }),
    )
    expect(s).toContain('judge called it truncated over 6 files on disk')
    expect(s).toContain('unreliable')
  })

  it('a verdict with NO recorded outcome keeps the original failure sentence', () => {
    const s = narrateRun(
      verdict({ passed: false, native: { models_used: ['claude · x'] } as unknown as Verdict['native'], route: { target: 'cloud' } as Verdict['route'] }),
    )
    expect(s).toContain('did not pass verification')
    expect(s).not.toContain('reviewer dissented')
  })

  it('gives an honest failure — stopped rather than write unverified work — and no lock when nothing was local', () => {
    const s = narrateRun(
      verdict({ passed: false, native: { models_used: ['gemini · x'] } as unknown as Verdict['native'], route: { target: 'cloud' } as Verdict['route'] }),
    )
    expect(s).toContain('did not pass verification')
    expect(s).not.toContain('🔒')
  })

  it('falls back to the route label when the verdict carries no models_used', () => {
    const s = narrateRun(
      verdict({ passed: true, native: undefined, route: { target: 'cloud', routeLabel: 'cloud · fast' } as Verdict['route'], tier2: { evalScore: 0.5 } as Verdict['tier2'] }),
    )
    expect(s).toContain('cloud · fast')
  })

  // M4: a step where governance blocked something reads differently from a
  // clean step — the real `native.blocks` count is surfaced, not swallowed.
  it('surfaces a governance block from the real native.blocks count', () => {
    const s = narrateRun(
      verdict({ passed: true, native: { models_used: ['local · y'], blocks: 2 } as unknown as Verdict['native'], route: { target: 'local' } as Verdict['route'], tier2: { evalScore: 0.9 } as Verdict['tier2'] }),
    )
    expect(s).toContain('Governance blocked 2 actions before it ran')
    // A clean step (no blocks) carries no such note.
    const clean = narrateRun(verdict({ passed: true, native: { models_used: ['local · y'], blocks: 0 } as unknown as Verdict['native'], route: { target: 'local' } as Verdict['route'], tier2: { evalScore: 0.9 } as Verdict['tier2'] }))
    expect(clean).not.toContain('Governance blocked')
  })
})
