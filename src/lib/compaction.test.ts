import { describe, expect, it } from 'vitest'
import {
  KEEP_RECENT,
  canCompact,
  compactionArchiveMarkdown,
  renderMessageLine,
  shouldDrop,
  splitForCompaction,
  structuralSummary,
  summaryMessage,
  summaryPromptFor,
  verdictLabel,
} from './compaction'
import type { ChatMessage } from '../store/AppStore'
import type { Verdict } from '../engine/types'

const userMsg = (id: string, text = 'hi'): ChatMessage => ({ id, kind: 'user', text })
const asstMsg = (id: string, text = 'yo'): ChatMessage => ({ id, kind: 'assistant', text })
const dividerMsg = (id: string, text = 'div'): ChatMessage => ({ id, kind: 'divider', text })
const errorMsg = (id: string, text = 'boom'): ChatMessage => ({
  id,
  kind: 'error',
  text,
  intent: 'retry me',
  providerId: 'local',
})

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

const verdictMsg = (id: string, over: Partial<Verdict> = {}): ChatMessage => ({
  id,
  kind: 'verdict',
  verdict: makeVerdict(over),
})

describe('splitForCompaction', () => {
  it('length <= keepRecent (default 6) → older [], recent = all', () => {
    const messages = [userMsg('1'), userMsg('2'), userMsg('3')]
    expect(splitForCompaction(messages)).toEqual({ older: [], recent: messages })
  })

  it('length === keepRecent exactly → still a no-op split', () => {
    const messages = Array.from({ length: KEEP_RECENT }, (_, i) => userMsg(`${i}`))
    expect(splitForCompaction(messages)).toEqual({ older: [], recent: messages })
  })

  it('length > keepRecent → older = head, recent = last keepRecent', () => {
    const messages = Array.from({ length: 10 }, (_, i) => userMsg(`${i}`))
    const { older, recent } = splitForCompaction(messages)
    expect(older).toEqual(messages.slice(0, 4))
    expect(recent).toEqual(messages.slice(4))
    expect(recent).toHaveLength(KEEP_RECENT)
  })

  it('a custom keepRecent is honored', () => {
    const messages = Array.from({ length: 10 }, (_, i) => userMsg(`${i}`))
    const { older, recent } = splitForCompaction(messages, 3)
    expect(older).toEqual(messages.slice(0, 7))
    expect(recent).toEqual(messages.slice(7))
    expect(recent).toHaveLength(3)
  })
})

describe('renderMessageLine', () => {
  it('renders a user message', () => {
    expect(renderMessageLine(userMsg('u1', 'hello there'))).toBe('user: hello there')
  })
  it('renders an assistant message', () => {
    expect(renderMessageLine(asstMsg('a1', 'hi back'))).toBe('assistant: hi back')
  })
  it('renders a divider message', () => {
    expect(renderMessageLine(dividerMsg('d1', 'note'))).toBe('divider: note')
  })
  it('renders an error message', () => {
    expect(renderMessageLine(errorMsg('e1', 'send failed'))).toBe('error: send failed')
  })
  it('renders a PASS verdict', () => {
    const m = verdictMsg('v1', { taskId: 'A-1', passed: true })
    expect(renderMessageLine(m)).toBe('verdict A-1 PASS')
  })
  it('renders a FAIL verdict', () => {
    const m = verdictMsg('v2', { taskId: 'A-2', passed: false })
    expect(renderMessageLine(m)).toBe('verdict A-2 FAIL')
  })
})

describe('structuralSummary', () => {
  it('with 2 user msgs + 1 verdict: contains the count, both truncated asks, the outcome', () => {
    const older = [
      userMsg('u1', 'first ask'),
      verdictMsg('v1', { taskId: 'A-1', passed: true }),
      userMsg('u2', 'second ask'),
    ]
    const out = structuralSummary(older)
    expect(out).toContain('Earlier context (3 messages):')
    expect(out).toContain('- You asked:')
    expect(out).toContain('  • first ask')
    expect(out).toContain('  • second ask')
    expect(out).toContain('- Outcomes:')
    expect(out).toContain('  • verdict A-1 PASS')
  })

  it('with none of a category, that section reads (none)', () => {
    const out = structuralSummary([asstMsg('a1', 'just chatter')])
    expect(out).toContain('Earlier context (1 messages):')
    expect(out).toContain('- You asked:\n  • (none)')
    expect(out).toContain('- Outcomes:\n  • (none)')
  })

  it('truncates a >100-char user ask to 100 chars + an ellipsis', () => {
    const long = 'x'.repeat(150)
    const out = structuralSummary([userMsg('u1', long)])
    expect(out).toContain(`  • ${'x'.repeat(100)}…`)
    expect(out).not.toContain('x'.repeat(101))
  })

  it('an exactly-100-char user ask is not truncated', () => {
    const exact = 'y'.repeat(100)
    const out = structuralSummary([userMsg('u1', exact)])
    expect(out).toContain(`  • ${exact}`)
    expect(out).not.toContain(`${exact}…`)
  })
})

describe('summaryPromptFor', () => {
  it('instructs Plan / Tasks done / Decisions, faithfulness, and includes every older line', () => {
    const older = [userMsg('u1', 'do X'), verdictMsg('v1', { taskId: 'A-1', passed: true })]
    const prompt = summaryPromptFor(older)
    expect(prompt).toContain('Plan')
    expect(prompt).toContain('Tasks done')
    expect(prompt).toContain('Decisions')
    expect(prompt.toLowerCase()).toContain('do not invent')
    expect(prompt).toContain('compact')
    for (const m of older) {
      expect(prompt).toContain(renderMessageLine(m))
    }
  })
})

describe('compactionArchiveMarkdown', () => {
  it('contains the nowIso, threadKey, the summary, and EVERY older rendered line', () => {
    const older = [
      userMsg('u1', 'do X'),
      asstMsg('a1', 'did X'),
      verdictMsg('v1', { taskId: 'A-1', passed: true }),
      dividerMsg('d1', 'switched project'),
    ]
    const summary = 'Plan: ship X. Tasks done: X shipped. Decisions: none.'
    const nowIso = '2026-07-12T00:00:00.000Z'
    const md = compactionArchiveMarkdown('universal', older, summary, nowIso)

    expect(md).toContain(nowIso)
    expect(md).toContain('thread universal')
    expect(md).toContain(summary)
    expect(md).toContain(`### Full transcript (${older.length} messages)`)
    for (const m of older) {
      expect(md).toContain(`- ${renderMessageLine(m)}`)
    }
  })
})

describe('summaryMessage', () => {
  it('is a divider whose text starts with the compacted-context marker and carries the summary', () => {
    const m = summaryMessage('sum-1', 'Plan: ship X.')
    expect(m.id).toBe('sum-1')
    expect(m.kind).toBe('divider')
    expect(m).toMatchObject({ kind: 'divider' })
    if (m.kind === 'divider') {
      expect(m.text.startsWith('— compacted earlier context —')).toBe(true)
      expect(m.text).toContain('Plan: ship X.')
    }
  })
})

describe('canCompact (the convergence guard)', () => {
  it('empty older → false (nothing to compact)', () => {
    expect(canCompact([])).toBe(false)
  })
  it('a lone summary divider → false (re-summarizing gains nothing, would loop)', () => {
    expect(canCompact([dividerMsg('d1')])).toBe(false)
  })
  it('two dividers → false (still only summaries)', () => {
    expect(canCompact([dividerMsg('d1'), dividerMsg('d2')])).toBe(false)
  })
  it('a single real user message → true (compressible)', () => {
    expect(canCompact([userMsg('u1')])).toBe(true)
  })
  it('a divider mixed with a real message → true (has something compressible)', () => {
    expect(canCompact([dividerMsg('d1'), userMsg('u1')])).toBe(true)
  })
})

describe('shouldDrop (the non-lossy gate)', () => {
  it('native + archived → drop is safe', () => {
    expect(shouldDrop(true, true)).toBe(true)
  })
  it('native + NOT archived → NEVER drop (keep the full thread)', () => {
    expect(shouldDrop(false, true)).toBe(false)
  })
  it('non-native (ephemeral demo) + not archived → drop is fine', () => {
    expect(shouldDrop(false, false)).toBe(true)
  })
  it('non-native + archived → drop is fine', () => {
    expect(shouldDrop(true, false)).toBe(true)
  })
})

// An engine run whose deterministic Tier-1 checks ran over real written files
// and PASSED, while the Tier-2 LLM reviewer dissented, is not a failure — and a
// compacted thread must not tell the model (or the user) that it was one.
describe('verdictLabel (the three-valued outcome)', () => {
  it('a passing verdict is PASS', () => {
    expect(verdictLabel({ passed: true, outcome: 'passed' })).toBe('PASS')
  })
  it('tests passed + reviewer dissented is ATTENTION, never FAIL', () => {
    expect(verdictLabel({ passed: false, outcome: 'attention' })).toBe('ATTENTION')
  })
  it('a genuine failure is still FAIL', () => {
    expect(verdictLabel({ passed: false, outcome: 'failed' })).toBe('FAIL')
  })
  it('a verdict predating the outcome field falls back to passed', () => {
    expect(verdictLabel({ passed: true })).toBe('PASS')
    expect(verdictLabel({ passed: false })).toBe('FAIL')
  })
})
