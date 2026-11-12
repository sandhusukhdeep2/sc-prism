import { describe, expect, it } from 'vitest'
import { measureWorkload } from './workloadMeasure'
import type { Settings } from './settings'
import type { Verdict } from '../engine/types'

// "Fix by your measurement first" — the stop the slider starts on comes from
// the judge's own scores for the local model on this Mac, nothing else.
function settings(localModel = 'qwen-local'): Settings {
  return {
    providers: [
      { id: 'claude-cli', name: 'Claude', baseUrl: '', apiKey: '', enabled: true, primary: true },
      { id: 'local', name: 'Local', baseUrl: 'http://localhost:1234', apiKey: '', enabled: true, primary: false, model: localModel },
    ],
  } as unknown as Settings
}

function judged(model: string, score: number): Verdict {
  return {
    taskId: `t-${Math.random()}`,
    passed: score >= 0.5,
    native: { models_used: [`local · ${model}`] },
    tier2: { evalScore: score, passed: score >= 0.5, judge: 'j', trajectory: 'trajectory ok' },
  } as unknown as Verdict
}

const many = (model: string, score: number, n: number) => Array.from({ length: n }, () => judged(model, score))

describe('measureWorkload — the stop the judged runs point to', () => {
  it('reads the local model’s own judged runs', () => {
    const m = measureWorkload(settings(), many('qwen-local', 0.8, 12))
    expect(m.stop).toBe('primary-checks')
    expect(m.why).toBe('your local model averaged 0.80 over 12 judged runs')
  })

  it('runs on another local model are not evidence about this one', () => {
    const m = measureWorkload(settings('qwen-local'), many('some-other-model', 0.9, 50))
    expect(m.stop).toBeNull()
    expect(m.why).toMatch(/^only 0 judged runs/)
  })

  it('a local model with no id set has nothing measured against it', () => {
    expect(measureWorkload(settings(''), many('qwen-local', 0.9, 50)).stop).toBeNull()
  })

  it('with no cloud AI connected there is no split to measure toward', () => {
    const s = settings()
    s.providers[0].enabled = false
    expect(measureWorkload(s, many('qwen-local', 0.9, 50)).why).toBe(
      'no cloud AI is connected — every seat runs on this Mac',
    )
  })
})
