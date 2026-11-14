import { describe, expect, it } from 'vitest'
import { foldSeatTurns } from './chatFold'
import type { ChatMessage } from '../store/AppStore'

// THE CHAT FOLDS A RUN'S OWN TURNS (2026-11-12). In the coworker app the owner
// showed as his reference, a run's activity is one line ("Ran 20 commands")
// that opens into its steps, and the answer stands on its own under it. Here a
// team run posted every seat's turn as a full bubble, so the answer sat under
// a screen of working-out. The turns are still all there — folded, one click
// away, and never altered.
const user = (id: string, text: string): ChatMessage => ({ id, kind: 'user', text })
const seat = (id: string, agent: string, provider: string, text = 'x', round = 1): ChatMessage => ({
  id, kind: 'seat', agent, provider, model: 'm', text, round,
})
const notice = (id: string, text: string): ChatMessage => ({ id, kind: 'notice', text })
const answer = (id: string, text: string): ChatMessage => ({ id, kind: 'assistant', text })

describe('foldSeatTurns', () => {
  it('folds a run of seat turns into one item, in place', () => {
    const out = foldSeatTurns([
      user('u', '→ team: plan it'),
      seat('s1', 'lead', 'claude-cli'),
      seat('s2', 'researcher', 'local'),
      seat('s3', 'critic', 'gemini'),
      notice('n', 'team run passed'),
      answer('a', 'here is the plan'),
    ])
    expect(out.map((m) => m.kind)).toEqual(['user', 'seats', 'notice', 'assistant'])
    const fold = out[1]
    expect(fold.kind === 'seats' && fold.seats.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
  })

  it('keeps every turn exactly as it was', () => {
    const turns = [seat('s1', 'lead', 'claude-cli', 'first'), seat('s2', 'critic', 'gemini', 'second')]
    const fold = foldSeatTurns(turns)[0]
    expect(fold.kind === 'seats' && fold.seats).toEqual(turns)
  })

  it('one seat’s single turn is not a crowd — it stays a bubble', () => {
    const out = foldSeatTurns([user('u', 'x'), seat('s1', 'lead', 'local'), answer('a', 'y')])
    expect(out.map((m) => m.kind)).toEqual(['user', 'seat', 'assistant'])
  })

  it('two runs fold separately', () => {
    const out = foldSeatTurns([
      seat('a1', 'lead', 'local'), seat('a2', 'critic', 'local'),
      answer('x', 'one'),
      seat('b1', 'lead', 'local'), seat('b2', 'critic', 'local'),
    ])
    expect(out.map((m) => m.kind)).toEqual(['seats', 'assistant', 'seats'])
  })

  it('the fold has a stable id, so opening it survives a new message arriving', () => {
    const a = foldSeatTurns([seat('s1', 'lead', 'local'), seat('s2', 'critic', 'local')])[0]
    const b = foldSeatTurns([seat('s1', 'lead', 'local'), seat('s2', 'critic', 'local'), answer('z', 'later')])[0]
    expect(a.id).toBe(b.id)
  })

  it('a conversation with no seat turns is returned untouched', () => {
    const msgs = [user('u', 'hello'), answer('a', 'hi')]
    expect(foldSeatTurns(msgs)).toEqual(msgs)
  })
})
