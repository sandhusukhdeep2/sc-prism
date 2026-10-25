import { describe, expect, it } from 'vitest'
import {
  estimateTokens,
  meterFor,
  messageText,
  threadTokens,
  THREAD_CONTEXT_BUDGET,
  type Meter,
} from './contextMeter'
import type { ChatMessage } from '../store/AppStore'
import type { Verdict } from '../engine/types'

// Minimal-but-valid Verdict fixture — mirrors src/lib/desk.test.ts's
// makeVerdict pattern: every field messageText/meterFor could touch gets a
// real value, everything else is filler so the shape type-checks.
function makeVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    taskId: 't-1',
    task: 'do the thing',
    route: {
      target: 'local',
      model: 'qwen2.5-coder',
      via: 'via gateway',
      reason: 'routine',
      routeLabel: 'local · qwen2.5-coder',
    },
    tier1: { tests: '0/0', lint: true, build: true, pass: true },
    tier2: { evalScore: 0.9, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
    tokensIn: 100,
    tokensOut: 50,
    cost: 0.01,
    durationMs: 1000,
    modelRoute: '100 tok in / 50 out',
    hooks: { blocked: 0, passed: true },
    writeback: { path: 'verdicts/t-1.json', validated: true, committed: true },
    passed: true,
    ...over,
  }
}

describe('estimateTokens', () => {
  it('empty string -> 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('4-char string -> 1', () => {
    expect(estimateTokens('abcd')).toBe(1)
  })

  it('5-char string -> 2 (rounds up)', () => {
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('a longer string estimates ~chars/4', () => {
    const text = 'x'.repeat(400)
    expect(estimateTokens(text)).toBe(100)
  })
})

describe('messageText', () => {
  it('user -> its text', () => {
    const m: ChatMessage = { id: '1', kind: 'user', text: 'hello there' }
    expect(messageText(m)).toBe('hello there')
  })

  it('assistant -> its text', () => {
    const m: ChatMessage = { id: '2', kind: 'assistant', text: 'here is my reply' }
    expect(messageText(m)).toBe('here is my reply')
  })

  it('divider -> its text', () => {
    const m: ChatMessage = { id: '3', kind: 'divider', text: '--- switched project ---' }
    expect(messageText(m)).toBe('--- switched project ---')
  })

  it('error -> its text', () => {
    const m: ChatMessage = {
      id: '4',
      kind: 'error',
      text: 'send failed',
      intent: 'do the thing',
      providerId: 'local',
    }
    expect(messageText(m)).toBe('send failed')
  })

  it('verdict (passed) -> synthesized PASS line', () => {
    const m: ChatMessage = { id: '5', kind: 'verdict', verdict: makeVerdict({ taskId: 'A-1042', passed: true }) }
    expect(messageText(m)).toBe('verdict A-1042 PASS')
  })

  it('verdict (failed) -> synthesized FAIL line', () => {
    const m: ChatMessage = { id: '6', kind: 'verdict', verdict: makeVerdict({ taskId: 'B-7', passed: false }) }
    expect(messageText(m)).toBe('verdict B-7 FAIL')
  })
})

describe('threadTokens', () => {
  it('empty thread -> 0', () => {
    expect(threadTokens([])).toBe(0)
  })

  it('sums estimateTokens(messageText(m)) across messages', () => {
    const messages: ChatMessage[] = [
      { id: '1', kind: 'user', text: 'abcd' }, // 1 token
      { id: '2', kind: 'assistant', text: 'abcde' }, // 2 tokens
      { id: '3', kind: 'divider', text: '' }, // 0 tokens
    ]
    expect(threadTokens(messages)).toBe(3)
  })
})

describe('meterFor', () => {
  // Build a single user message whose text is exactly `chars` long so tokens
  // land at Math.ceil(chars / 4) — pick chars as a multiple of 4 so tokens is
  // exact and pct is exact for a given budget.
  function threadOfTokens(tokens: number): ChatMessage[] {
    return [{ id: '1', kind: 'user', text: 'x'.repeat(tokens * 4) }]
  }

  it('reports tokens/budget/pct/remaining for a simple thread', () => {
    const messages = threadOfTokens(10)
    const meter = meterFor(messages, 100)
    expect(meter.tokens).toBe(10)
    expect(meter.budget).toBe(100)
    expect(meter.pct).toBe(10)
    expect(meter.remaining).toBe(90)
    expect(meter.level).toBe('green')
    expect(meter.offerCompact).toBe(false)
    expect(meter.autoCompact).toBe(false)
    expect(meter.hardCompact).toBe(false)
  })

  it('defaults budget to THREAD_CONTEXT_BUDGET when omitted', () => {
    const meter = meterFor([])
    expect(meter.budget).toBe(THREAD_CONTEXT_BUDGET)
    expect(meter.tokens).toBe(0)
    expect(meter.pct).toBe(0)
    expect(meter.level).toBe('green')
  })

  const cases: Array<{ pct: number; level: Meter['level']; offer: boolean; auto: boolean; hard: boolean }> = [
    { pct: 0, level: 'green', offer: false, auto: false, hard: false },
    { pct: 59, level: 'green', offer: false, auto: false, hard: false },
    { pct: 60, level: 'amber', offer: true, auto: false, hard: false },
    { pct: 75, level: 'amber', offer: true, auto: true, hard: false },
    { pct: 85, level: 'amber', offer: true, auto: true, hard: false },
    { pct: 86, level: 'red', offer: true, auto: true, hard: false },
    { pct: 89, level: 'red', offer: true, auto: true, hard: false },
    { pct: 90, level: 'red', offer: true, auto: true, hard: true },
  ]

  for (const c of cases) {
    it(`pct=${c.pct} -> level ${c.level}, offer=${c.offer} auto=${c.auto} hard=${c.hard}`, () => {
      const budget = 100
      const messages = threadOfTokens(c.pct)
      const meter = meterFor(messages, budget)
      expect(meter.pct).toBe(c.pct)
      expect(meter.level).toBe(c.level)
      expect(meter.offerCompact).toBe(c.offer)
      expect(meter.autoCompact).toBe(c.auto)
      expect(meter.hardCompact).toBe(c.hard)
    })
  }

  it('tokens > budget clamps pct to 100, remaining to 0, all flags true, level red', () => {
    const budget = 100
    const messages = threadOfTokens(150) // 150% of budget
    const meter = meterFor(messages, budget)
    expect(meter.tokens).toBe(150)
    expect(meter.pct).toBe(100)
    expect(meter.remaining).toBe(0)
    expect(meter.level).toBe('red')
    expect(meter.offerCompact).toBe(true)
    expect(meter.autoCompact).toBe(true)
    expect(meter.hardCompact).toBe(true)
  })

  it('a larger, realistic default budget (24_000) at exactly 60% is amber and offers compaction', () => {
    // 60% of 24_000 tokens = 14_400 tokens = 57_600 chars.
    const chars = Math.round(0.6 * THREAD_CONTEXT_BUDGET) * 4
    const messages: ChatMessage[] = [{ id: '1', kind: 'user', text: 'x'.repeat(chars) }]
    const meter = meterFor(messages)
    expect(meter.pct).toBe(60)
    expect(meter.level).toBe('amber')
    expect(meter.offerCompact).toBe(true)
    expect(meter.autoCompact).toBe(false)
    expect(meter.hardCompact).toBe(false)
  })
})
