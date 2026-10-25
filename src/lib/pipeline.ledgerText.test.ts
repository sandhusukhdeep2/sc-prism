// The ledger's two text bugs, found by rendering Sukhdeep's REAL verdicts:
// a stuttering skip reason, and a harness-decorated prompt standing in for the
// user's task. Both are honesty bugs — the row showed OUR words as HIS.
import { describe, expect, it } from 'vitest'
import { checkLine, outcomeWord, shortSkipReason, taskLabel } from './pipeline'
import type { Verdict } from '../engine/types'

// The exact reason his engine recorded, verbatim.
const REAL_SKIP =
  'skipped — no project bound, nothing to verify. A verify command is configured, ' +
  'but this run has no project directory (a chat message, a manager report, a ' +
  'heartbeat wake), so there is no codebase to run it against. Nothing was ' +
  'checked: this is neither a pass nor a test failure. Attach a project ' +
  '(Projects → attach a folder) for its verify command to run on that project’s work.'

describe('shortSkipReason — the clause a row can hold', () => {
  it('drops the duplicated opener the caller is about to write', () => {
    expect(shortSkipReason(REAL_SKIP)).toBe('no project bound, nothing to verify')
  })

  it('so the rendered line no longer stutters', () => {
    const v = { tier1: { skipped: true, skipReason: REAL_SKIP } } as unknown as Verdict
    expect(checkLine(v)).toBe('checks skipped — no project bound, nothing to verify')
    expect(checkLine(v)).not.toMatch(/skipped — skipped/)
  })

  it('keeps a reason that does not start with the word "skipped"', () => {
    expect(shortSkipReason('no verify command configured.')).toBe('no verify command configured')
  })

  it('an empty reason still says something true', () => {
    const v = { tier1: { skipped: true } } as unknown as Verdict
    expect(checkLine(v)).toBe('checks skipped — nothing to verify')
  })
})

describe('a replied chat turn — its own word, and no check noise', () => {
  it('outcomeWord for the replied tone is "replied"', () => {
    expect(outcomeWord('replied')).toBe('replied')
  })

  it('checkLine says NOTHING for a replied verdict', () => {
    // "checks skipped — no project bound" is a true sentence about a task run
    // with nowhere to run its checks. On a chat row it is noise dressed as a
    // caveat: a conversation never had checks to skip.
    const v = {
      passed: true,
      outcome: 'replied',
      tier1: { skipped: true, skipReason: REAL_SKIP },
      tier2: { evalScore: 0.82 },
    } as unknown as Verdict
    expect(checkLine(v)).toBe('')
  })

  it('a non-replied verdict with the same tier shape keeps its honest line', () => {
    const v = { tier1: { skipped: true, skipReason: REAL_SKIP } } as unknown as Verdict
    expect(checkLine(v)).toBe('checks skipped — no project bound, nothing to verify')
  })
})

describe('taskLabel — the user’s task, not the harness’s prompt', () => {
  it('unwraps the propose-an-agent brief to what he actually asked', () => {
    const decorated =
      '[PROPOSE AN AGENT] Sukhdeep is asking for a new agent on the Work page. ' +
      'His request:\n\nwe need someone watching compliance\n\nDo NOT create anything — you propose.'
    expect(taskLabel(decorated)).toBe('propose an agent — we need someone watching compliance')
  })

  it('never leaks the instruction block into the row', () => {
    const decorated = '[PROPOSE AN AGENT] blah. His request:\n\nt===yes\n\nDo NOT create anything'
    const label = taskLabel(decorated)
    expect(label).not.toMatch(/Do NOT create/)
    expect(label).not.toMatch(/PROPOSE_AGENT/)
  })

  it('strips the agent-definition prefix and keeps the real task', () => {
    expect(
      taskLabel('[AGENT · archivist · filing · library model: local] tidy last week’s notes'),
    ).toBe('tidy last week’s notes')
  })

  it('keeps an ordinary task exactly as the user wrote it', () => {
    expect(taskLabel('Create a wordpress theme like moppers slashcreative')).toBe(
      'Create a wordpress theme like moppers slashcreative',
    )
  })

  it('takes the first line of a multi-line task rather than the whole essay', () => {
    expect(taskLabel('summarise the vault\n\nand then do more things')).toBe('summarise the vault')
  })

  it('clips a very long single line instead of blowing the row open', () => {
    const long = 'x'.repeat(200)
    const out = taskLabel(long)
    expect(out.length).toBeLessThanOrEqual(90)
    expect(out.endsWith('…')).toBe(true)
  })

  it('a verdict with no task at all says so, and invents nothing', () => {
    expect(taskLabel(undefined)).toBe('a recorded run')
    expect(taskLabel('   ')).toBe('a recorded run')
  })
})
