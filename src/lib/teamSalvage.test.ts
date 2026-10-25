import { describe, expect, it } from 'vitest'
import { teamSalvageLine } from './teamSalvage'
import type { EngineSpan } from './nativeEngine'

// Sukhdeep, watching a real run in the app on 2026-08-31: a three-AI board
// researched his own product for five minutes — Claude Opus searched and
// fetched his pricing page, his local Qwen answered, Gemini ran four more
// queries to get around a ThemeForest block — and when the run hit OUR five
// minute wall he was told only:
//
//   "We stopped the team run at 5 minutes — that is our own wall, not a
//    provider failure. Try a smaller task."
//
// Every one of those findings was already on disk in the run's spans. The wall
// is fine; throwing the work away silently is not. This builds the one honest
// line that says what the team actually got done before we stopped it — from
// the spans themselves, so it can never claim work that did not happen.

const span = (name: string, attrs: Record<string, unknown>, run = 'R1'): EngineSpan => ({
  name,
  attrs,
  run_id: run,
})

describe('teamSalvageLine — what the team got done before our wall', () => {
  it('is empty when the run did nothing worth reporting', () => {
    expect(teamSalvageLine([], 'R1')).toBe('')
    expect(teamSalvageLine([span('plan', {})], 'R1')).toBe('')
  })

  it('counts only the spans belonging to THIS run', () => {
    const spans = [
      span('tool_exec', { tool: 'web_search', is_error: false }, 'R1'),
      span('tool_exec', { tool: 'web_search', is_error: false }, 'OTHER'),
      span('model_call', { provider: 'claude-cli' }, 'R1'),
    ]
    const line = teamSalvageLine(spans, 'R1')
    expect(line).toContain('1 web lookup')
    expect(line).not.toContain('2 web lookup')
  })

  it('names the seats that answered and the models behind them', () => {
    const spans = [
      span('model_call', { provider: 'claude-cli', model: 'opus', agent: 'lead' }),
      span('model_call', { provider: 'local', model: 'Qwen3.6', agent: 'researcher' }),
      span('model_call', { provider: 'gemini', model: 'gemini-flash-latest', agent: 'critic' }),
    ]
    const line = teamSalvageLine(spans, 'R1')
    expect(line).toContain('lead')
    expect(line).toContain('researcher')
    expect(line).toContain('critic')
  })

  it('reports successful lookups and does not count the failed ones as finds', () => {
    const spans = [
      span('tool_exec', { tool: 'web_search', is_error: false }),
      span('tool_exec', { tool: 'web_fetch', is_error: false }),
      span('tool_exec', { tool: 'web_fetch', is_error: true, error: 'HTTP 403' }),
    ]
    const line = teamSalvageLine(spans, 'R1')
    expect(line).toContain('2 web lookups')
    // The failures are named too — a 403 the user's own site returned is a
    // fact they may need, not noise to hide.
    expect(line).toContain('1 failed')
  })

  it('names the pages actually read, so the findings are recoverable', () => {
    const spans = [
      span('tool_exec', {
        tool: 'web_fetch',
        is_error: false,
        url: 'https://www.slashcreative.co/themes/moppers-version-2/pricing/',
      }),
    ]
    expect(teamSalvageLine(spans, 'R1')).toContain('slashcreative.co')
  })

  it('never claims a seat answered when only tools ran', () => {
    const line = teamSalvageLine([span('tool_exec', { tool: 'web_search', is_error: false })], 'R1')
    expect(line).toContain('1 web lookup')
    expect(line).not.toContain('answered')
  })
})

// Verified in the app on 2026-08-31 and it produced NOTHING: the client's run
// id is only a CANCEL handle (src-tauri passes it to kill the child), while the
// engine mints its own `run_id` for spans. Filtering by the client's id matched
// zero spans on every real run, so the salvage line never appeared — the exact
// "built but doesn't actually work" failure this feature was fixing.
//
// The app holds ONE engine slot at a time (TEAM_BUSY_TEXT refuses a second),
// so the last run in the tail IS the run that just stopped. That invariant is
// what makes the fallback sound rather than a guess.
describe('teamSalvageLine — when the caller has no id the engine recognises', () => {
  it('falls back to the most recent run in the tail', () => {
    const spans: EngineSpan[] = [
      span('tool_exec', { tool: 'web_search', is_error: false }, 'older-run'),
      span('model_call', { provider: 'claude-cli', model: 'opus', agent: 'lead' }, 'engine-run'),
      span('tool_exec', { tool: 'web_fetch', is_error: false, url: 'https://x.test/a' }, 'engine-run'),
      span('tool_exec', { tool: 'web_fetch', is_error: false, url: 'https://x.test/b' }, 'engine-run'),
    ]
    // The client's own id appears nowhere in the spans — exactly the real case.
    const line = teamSalvageLine(spans, 'run-1756000000-abc')
    expect(line).toContain('1 seat answered')
    expect(line).toContain('2 web lookups')
    // The older run's lookup must NOT be folded in.
    expect(line).not.toContain('3 web lookups')
  })

  it('still honours an id that DOES appear, rather than always taking the last', () => {
    const spans: EngineSpan[] = [
      span('tool_exec', { tool: 'web_search', is_error: false }, 'mine'),
      span('tool_exec', { tool: 'web_search', is_error: false }, 'later'),
      span('tool_exec', { tool: 'web_search', is_error: false }, 'later'),
    ]
    expect(teamSalvageLine(spans, 'mine')).toContain('1 web lookup')
  })
})

it('shortens a long local model id so the line stays readable', () => {
  // Real name from Sukhdeep's oMLX server — 54 chars, and it appeared beside a
  // second seat and a host list in one line.
  const long = 'Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-MLX-oQ4-MTP'
  const line = teamSalvageLine(
    [span('model_call', { provider: 'local', model: long, agent: 'researcher' })],
    'R1',
  )
  expect(line).toContain('Qwen3.6-35B')
  expect(line).not.toContain(long)
  expect(line).toContain('…')
})
