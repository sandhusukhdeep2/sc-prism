import { describe, expect, it } from 'vitest'
import { crewSize, lastFinishedRunSpans, outcomeLabel, outcomeDetail
} from './liveRuns'
import type { EngineSpan } from './nativeEngine'


// The product's most important fact was being forgotten thirty seconds after
// it happened: a real team run across two different AIs left no trace on the
// page, because the crew board is live-only. These slice the last finished run
// out of the engine's own log so the crew survives the run.
describe('lastFinishedRunSpans — the crew stays on screen after the work', () => {
  const call = (agent: string, provider: string): EngineSpan =>
    ({ name: 'model_call', type: 'model_call', status: 'ok', attrs: { agent, provider, is_real: true } }) as EngineSpan
  const mark = (id: string): EngineSpan =>
    ({ name: `run:${id}`, type: 'run', status: 'ok', attrs: {} }) as EngineSpan

  it('takes everything after the previous run marker, up to the last one', () => {
    const spans = [
      call('old-lead', 'local'),
      mark('run-one'),
      call('lead', 'claude-cli'),
      call('researcher', 'local'),
      mark('run-two'),
    ]
    const got = lastFinishedRunSpans(spans)
    expect(got).toHaveLength(3)
    expect(got.map((s) => (s.attrs ?? {}).agent)).toEqual(['lead', 'researcher', undefined])
    // the PREVIOUS run's agent is not dragged in
    expect(got.some((s) => (s.attrs ?? {}).agent === 'old-lead')).toBe(false)
  })

  it('with a single marker the whole tail is that run', () => {
    const spans = [call('lead', 'claude-cli'), call('researcher', 'local'), mark('only')]
    expect(lastFinishedRunSpans(spans)).toHaveLength(3)
  })

  it('nothing finished yet means [] — never a guess', () => {
    expect(lastFinishedRunSpans([call('lead', 'claude-cli')])).toEqual([])
    expect(lastFinishedRunSpans([])).toEqual([])
  })

  it('crewSize counts DISTINCT agents, so a solo reply is not a crew', () => {
    expect(crewSize([call('lead', 'claude-cli')])).toBe(1)
    expect(crewSize([call('lead', 'claude-cli'), call('lead', 'local')])).toBe(1)
    expect(crewSize([call('lead', 'claude-cli'), call('researcher', 'local')])).toBe(2)
    expect(crewSize([mark('x')])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Sukhdeep photographed this on the desk:
//
//   HEARTBEAT  Sukh is awake — one governed ch…  passed  [incomplete: I ran
//   out of tool turns (6 used) while still researching — this is what I had,
//   not a finished answer.]
//
// Two defects in one row. The chip says PASSED next to text saying the run
// never finished — they cannot both be true, and this product exists to not
// do that. And the raw `[incomplete: …]` marker is protocol, shown verbatim,
// crowding the title out to an ellipsis.
// ---------------------------------------------------------------------------
describe('a run that did not finish is not "passed"', () => {
  const run = (over = {}) =>
    ({
      id: 'r1',
      title: 'Sukh is awake — one governed check',
      outcome: 'passed',
      detail:
        '[incomplete: I ran out of tool turns (6 used) while still researching — this is what I had, not a finished answer.]',
      ...over,
    }) as never

  it('says incomplete, whatever the stored outcome claims', () => {
    expect(outcomeLabel(run())).toBe('incomplete')
    expect(outcomeLabel(run({ outcome: 'failed' }))).toBe('incomplete')
  })

  it('leaves an ordinary passed run alone', () => {
    expect(outcomeLabel(run({ detail: 'all checks green' }))).toBe('passed')
  })

  it('shows the reason as prose, not as a bracketed marker', () => {
    const d = outcomeDetail(run())
    expect(d).not.toContain('[incomplete:')
    expect(d).not.toContain(']')
    expect(d).toContain('ran out of tool turns')
  })

  it('keeps the reason short enough not to crowd out the title', () => {
    // The title was truncated to "one governed ch…" while the marker ran the
    // full width. The row has one title and one reason; the title wins.
    expect(outcomeDetail(run()).length).toBeLessThanOrEqual(80)
  })

  it('an empty or marker-only detail leaves nothing behind', () => {
    expect(outcomeDetail(run({ detail: '[incomplete: ]' }))).toBe('')
  })
})
