import { describe, expect, it } from 'vitest'
import { pipelineStages, projectRunSpans, stageLabel, stageLabelForStep } from './pipeline'
import type { EngineSpan } from './nativeEngine'

// THE BOARD SUKHDEEP KEEPS DRAWING: columns that are the PHASES of a job, each
// with the coworker that did it. A project already runs one engine call per
// plan step with a roster he staffed; none of that reached the spans, so the
// board could only ever show the step happening right now — one anonymous
// column that changed N times — and the crew was nowhere.

const runSpan = (taskId: string, spanId: string): EngineSpan => ({
  name: 'run',
  type: 'run',
  status: 'ok',
  span_id: spanId,
  attrs: { task_id: taskId },
})

const call = (parent: string, agent: string, stage: string, spanId: string): EngineSpan => ({
  name: 'model_call',
  type: 'model_call',
  status: 'ok',
  span_id: spanId,
  parent_id: parent,
  duration_ms: 5_000,
  start: 1,
  attrs: { agent, round: stage, provider: 'local', model: 'Qwen', is_real: true },
})

describe('a project’s board is its whole build, not the step running now', () => {
  const spans: EngineSpan[] = [
    runSpan('step-a', 'r1'),
    call('r1', 'researcher', '1 · Research the CLI shape', 'c1'),
    runSpan('step-b', 'r2'),
    call('r2', 'writer', '2 · Draft the digest', 'c2'),
    runSpan('unrelated', 'r3'),
    call('r3', 'someone-else', 'Working', 'c3'),
  ]

  it('gathers every step’s spans, and only this project’s', () => {
    const got = projectRunSpans(spans, ['step-a', 'step-b'])
    const agents = got.filter((s) => s.type === 'model_call').map((s) => s.attrs?.agent)
    expect(agents).toEqual(['researcher', 'writer'])
    expect(got.some((s) => s.attrs?.agent === 'someone-else')).toBe(false)
  })

  it('keeps them in PLAN order — the order they happened and he approved', () => {
    const got = projectRunSpans(spans, ['step-b', 'step-a'])
    const agents = got.filter((s) => s.type === 'model_call').map((s) => s.attrs?.agent)
    expect(agents).toEqual(['writer', 'researcher'])
  })

  it('becomes one COLUMN PER STEP, each carrying the seat that did it', () => {
    const stages = pipelineStages(projectRunSpans(spans, ['step-a', 'step-b']), false)
    expect(stages.map((s) => s.label)).toEqual([
      '1 · Research the CLI shape',
      '2 · Draft the digest',
    ])
    expect(stages[0].members.map((m) => m.step.agent)).toEqual(['researcher'])
    expect(stages[1].members.map((m) => m.step.agent)).toEqual(['writer'])
  })

  it('a step whose spans have scrolled out of the tail is skipped, not drawn empty', () => {
    const got = projectRunSpans(spans, ['long-gone', 'step-a'])
    expect(got.filter((s) => s.type === 'model_call')).toHaveLength(1)
  })

  it('a repeated id cannot double a column', () => {
    const got = projectRunSpans(spans, ['step-a', 'step-a'])
    expect(got.filter((s) => s.type === 'model_call')).toHaveLength(1)
  })

  it('no ids yet — a project that has finished nothing draws no board', () => {
    expect(projectRunSpans(spans, [])).toEqual([])
  })
})

describe('a column is named by the PLAN, never by an invented phase', () => {
  const plan = ['Research how similar CLI tools format output', 'Draft the digest', '']

  it('uses the step’s own text, numbered so the order survives', () => {
    expect(stageLabelForStep(plan, 1)).toBe('2 · Draft the digest')
  })

  it('clips a long step rather than letting it break the column', () => {
    const label = stageLabelForStep(plan, 0)
    expect(label.startsWith('1 · Research how similar CLI tools')).toBe(true)
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(40)
  })

  it('an empty step still gets an honest number, not a made-up name', () => {
    expect(stageLabelForStep(plan, 2)).toBe('Step 3')
    expect(stageLabelForStep([], 0)).toBe('Step 1')
  })

  it('never invents Planning / Research / Drafting when the plan does not say them', () => {
    // A reference design showed those columns. They are lovely, and they are
    // fiction unless the plan really says them.
    const label = stageLabelForStep(['Fix the uploader guard'], 0)
    expect(label).toBe('1 · Fix the uploader guard')
  })
})

describe('stageLabel tells a team ROUND from a named phase', () => {
  it('a bare number is a team round and gets the word', () => {
    expect(stageLabel('1')).toBe('Round 1')
    expect(stageLabel(' 2 ')).toBe('Round 2')
  })

  it('a written label is left alone — "Round 2 · Draft the digest" is mangled', () => {
    expect(stageLabel('2 · Draft the digest')).toBe('2 · Draft the digest')
    expect(stageLabel('Check-in')).toBe('Check-in')
  })

  it('the engine’s own two words still win', () => {
    expect(stageLabel('synthesis')).toBe('Pulling together')
    expect(stageLabel('refused')).toBe('Refused by the engine')
  })

  it('no stage at all is one honest "Working" column', () => {
    expect(stageLabel('')).toBe('Working')
  })
})
