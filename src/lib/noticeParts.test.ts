import { describe, expect, it } from 'vitest'
import { noticeParts } from './noticeParts'

// A chat notice is the APP speaking: a sentence. The team-run notice used to
// end with the full absolute path of the saved board inside one monospace
// block (his screenshot, 2026-11-11). The sentence and the file are separate
// things: the sentence reads, the file is a reveal action named by its name.
describe('noticeParts — the sentence, and the file it mentions', () => {
  it('splits a saved-board path off the end of a team notice', () => {
    const p = noticeParts('team run did not pass — [llm-judge] two seats answered | score=0.675 vs threshold=0.7 → BELOW | envelope ok · 2,967/100,000 tok · board saved: /Users/me/sc-vault/agents/board-hello-1032bacd.jsonl')
    expect(p.body).toBe('team run did not pass — [llm-judge] two seats answered | score=0.675 vs threshold=0.7 → BELOW | envelope ok · 2,967/100,000 tok')
    expect(p.path).toBe('/Users/me/sc-vault/agents/board-hello-1032bacd.jsonl')
    expect(p.file).toBe('board-hello-1032bacd.jsonl')
  })
  it('leaves a notice with no saved file alone', () => {
    expect(noticeParts('Not started — another run was in progress. Try again once nothing is running.')).toEqual({
      body: 'Not started — another run was in progress. Try again once nothing is running.',
    })
  })
  it('keeps text that follows on later lines (a salvage line) in the body', () => {
    const p = noticeParts('team run passed · board saved: /v/agents/board-x.jsonl\n\nwhat got done: 2 seats answered')
    expect(p.path).toBe('/v/agents/board-x.jsonl')
    expect(p.body).toBe('team run passed\n\nwhat got done: 2 seats answered')
  })
})
