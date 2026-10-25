// The shared tool_call guard, and the pure user-visible paths that must use it.
//
// The live bug (2026-08-17): the Work chat rendered an unexecuted ```tool_call
// request as the assistant's answer. The engine now strips fences at the
// source; this file pins the CLIENT backstop and the rule that a future path
// cannot quietly reintroduce the bug — every surface that shows raw model text
// runs it through `guardAnswerText`.
import { describe, expect, it } from 'vitest'
import {
  INCOMPLETE_PREFIX,
  guardAnswerText,
  hasToolCallFence,
  incompleteReason,
  isIncompleteInvestigation,
  stripToolCallBlocks,
} from './answerText'
import { chatTurnFromOutcome, teamReportBody } from '../store/AppStore'
import { verdictFeedback } from './projectRun'
import type { Verdict } from '../engine/types'
import type { TeamResult } from './nativeEngine'

// Verbatim from the saved Verdict the user's chat rendered.
const LIVE_BUG =
  "The HTTPS fetcher hit a local issue, so I'll search for this instead.\n\n" +
  '```tool_call\n{"tool": "web_search", "arguments": {"query": "themeforest.net slashcreative"}}\n```'

describe('guardAnswerText — the shared guard', () => {
  it('strips the live bug’s fence, keeps its prose, and marks it incomplete', () => {
    const out = guardAnswerText(LIVE_BUG)
    expect(out).not.toContain('```tool_call')
    expect(out).not.toContain('web_search')
    expect(out).toContain("The HTTPS fetcher hit a local issue, so I'll search for this instead.")
    expect(isIncompleteInvestigation(out)).toBe(true)
    expect(out.startsWith(INCOMPLETE_PREFIX)).toBe(true)
  })

  it('leaves a normal completion byte-identical', () => {
    for (const text of [
      'Here is the answer: 42.',
      '```python\nprint("hi")\n```', // an ordinary code fence is not protocol
      '',
      'I thought about calling a tool and then just answered.',
    ]) {
      expect(guardAnswerText(text)).toBe(text)
      expect(hasToolCallFence(text)).toBe(false)
    }
  })

  it('strips every block, not only the first', () => {
    const text = 'one\n```tool_call\n{"tool":"a"}\n```\ntwo\n```tool_call\n{"tool":"b"}\n```\nthree'
    const body = stripToolCallBlocks(text)
    expect(body).not.toContain('```tool_call')
    expect(body).toContain('one')
    expect(body).toContain('two')
    expect(body).toContain('three')
  })

  it('an unterminated fence owns the rest of the reply', () => {
    expect(stripToolCallBlocks('prose first\n```tool_call\n{"tool": "web_')).toBe('prose first')
  })

  it('never marks the same text twice', () => {
    const once = guardAnswerText(LIVE_BUG)
    expect(guardAnswerText(once)).toBe(once)
  })

  it('exposes the reason so a run row can say what stopped short', () => {
    // The engine's own exhaustion wording, which the run row must be able to
    // show without the surrounding prose.
    const engineText =
      '[incomplete: I ran out of tool turns (12 used) while still researching — ' +
      'this is what I had, not a finished answer.]\n\nsome partial notes'
    expect(incompleteReason(engineText)).toBe(
      'I ran out of tool turns (12 used) while still researching — this is what I had, not a finished answer.',
    )
    expect(incompleteReason('A perfectly ordinary answer.')).toBe('')
  })

  it('passes non-strings straight through', () => {
    expect(guardAnswerText(undefined)).toBeUndefined()
    expect(guardAnswerText(null)).toBeNull()
    expect(hasToolCallFence(undefined)).toBe(false)
  })
})

// --- Every user-visible path that can surface a raw completion -------------
//
// The three below are pure and testable here; the manager report, the desk's
// finished-run row and the heartbeat beat line are driver-side and are pinned
// in AppStore.toolCallGuard.test.tsx against the real store.

describe('THE CHAT TURN never shows a tool_call fence', () => {
  const verdict = (response: string) => ({ response, tokensIn: 1, tokensOut: 1 }) as unknown as Verdict

  it('strips and marks a reply that still carries an unexecuted request', () => {
    const turn = chatTurnFromOutcome({ timedOut: false, value: verdict(LIVE_BUG) })
    expect(turn.kind).toBe('ok')
    if (turn.kind !== 'ok') return
    expect(turn.response).not.toContain('```tool_call')
    expect(isIncompleteInvestigation(turn.response)).toBe(true)
  })

  it('leaves an ordinary answer untouched', () => {
    const turn = chatTurnFromOutcome({ timedOut: false, value: verdict('All done: 3 files.') })
    expect(turn.kind).toBe('ok')
    if (turn.kind !== 'ok') return
    expect(turn.response).toBe('All done: 3 files.')
  })
})

describe('A TEAM ANSWER (and the desk row built from it) never shows a fence', () => {
  const team = (synthesis: string) =>
    ({
      passed: true,
      synthesis,
      reason: '',
      tokens: 10,
      tokenBudget: 100,
      overBudget: false,
      verdictPath: '',
    }) as unknown as TeamResult

  it('guards both the saved report body and the one-line run summary', () => {
    const { text, summary } = teamReportBody(team(LIVE_BUG))
    expect(text).not.toContain('```tool_call')
    expect(summary).not.toContain('```tool_call')
    expect(isIncompleteInvestigation(summary)).toBe(true)
  })

  it('leaves an ordinary synthesis untouched', () => {
    expect(teamReportBody(team('We agreed on plan B.')).summary).toBe('We agreed on plan B.')
  })
})

describe('A PROJECT ANSWER never shows a fence', () => {
  const v = (response: string) =>
    ({ response, tier1: { pass: true, tests: '', log: '' } }) as unknown as Verdict

  it('strips and marks the completion used as the step note / refine feedback', () => {
    const out = verdictFeedback(v(LIVE_BUG))
    expect(out).not.toContain('```tool_call')
    expect(isIncompleteInvestigation(out)).toBe(true)
  })

  it('leaves an ordinary completion untouched', () => {
    expect(verdictFeedback(v('The step wrote two files.'))).toBe('The step wrote two files.')
  })
})
