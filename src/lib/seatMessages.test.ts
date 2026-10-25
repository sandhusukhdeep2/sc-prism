import { describe, expect, it } from 'vitest'
import { seatMessagesFromBoard } from './seatMessages'

// "Multiple AIs in the same chat with multiple agents" (Sukhdeep, standing
// loop): after a team run, each seat's REAL board contribution becomes its
// own bubble. This parser reads the persisted board JSONL — the audited
// a2a record — and nothing else: only real seats (is_real true), never the
// trailing synthesis line, never invented text.
const LINES = [
  JSON.stringify({ from: 'planner', provider: 'claude-cli', model: 'opus', content: 'Plan: three sections.', is_real: true, round: 1 }),
  JSON.stringify({ from: 'researcher', provider: 'local', model: 'qwen', content: 'Found two sources.', is_real: true, round: 1 }),
  JSON.stringify({ from: 'ghost', provider: 'gemini-cli', model: 'opus', content: 'stub text', is_real: false, round: 1 }),
  JSON.stringify({ synthesis: 'Final answer.', tokens: 1234 }),
].join('\n')

describe('seatMessagesFromBoard', () => {
  it('yields one message per REAL seat, in board order, with brand attached', () => {
    const out = seatMessagesFromBoard(LINES)
    expect(out).toEqual([
      { agent: 'planner', provider: 'claude-cli', model: 'opus', text: 'Plan: three sections.', round: 1 },
      { agent: 'researcher', provider: 'local', model: 'qwen', text: 'Found two sources.', round: 1 },
    ])
  })

  it('tolerates a corrupt line and an empty file', () => {
    expect(seatMessagesFromBoard('not json\n' + LINES.split('\n')[0])).toHaveLength(1)
    expect(seatMessagesFromBoard('')).toEqual([])
  })
})
