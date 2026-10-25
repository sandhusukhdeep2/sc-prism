import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASK_FENCE,
  MAX_QUESTIONS,
  answeredCount,
  answeredQuestions,
  askBlockedReason,
  askCharter,
  askedQuestions,
  contextThin,
  parseAskBlock,
  questionKey,
  renderContextNote,
  stripAskBlock,
  type QuestionSet,
} from './businessInterview'

// The store is a module singleton loaded from localStorage at import time, so
// the state-changing tests re-import a fresh copy (same idiom as managers.test).
async function fresh() {
  vi.resetModules()
  return await import('./businessInterview')
}

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

const block = (...qs: string[]) => ['```' + ASK_FENCE, ...qs.map((q) => `q: ${q}`), '```'].join('\n')

// ---------------------------------------------------------------------------
// The block — a question is a question, and a malformed one is nothing at all
// ---------------------------------------------------------------------------

describe('parseAskBlock', () => {
  it('reads up to three one-line questions', () => {
    const parsed = parseAskBlock(`Nothing else needed.\n\n${block('Who are your biggest clients?', 'What do you charge?')}`)
    expect(parsed).toEqual({
      status: 'ok',
      questions: ['Who are your biggest clients?', 'What do you charge?'],
      dropped: 0,
    })
  })

  it('CAPS the set at three and says how many it cut', () => {
    const parsed = parseAskBlock(block('a?', 'b?', 'c?', 'd?', 'e?'))
    expect(parsed.status).toBe('ok')
    if (parsed.status !== 'ok') return
    expect(parsed.questions).toHaveLength(MAX_QUESTIONS)
    expect(parsed.questions).toEqual(['a?', 'b?', 'c?'])
    expect(parsed.dropped).toBe(2)
  })

  it('no block at all is not an ask', () => {
    expect(parseAskBlock('Tidied the vault index.')).toEqual({ status: 'none' })
  })

  it('REFUSES a malformed block rather than repairing it into questions', () => {
    const reason = (t: string) => {
      const p = parseAskBlock(t)
      return p.status === 'refused' ? p.reason : `not refused (${p.status})`
    }
    expect(reason('```' + ASK_FENCE + '\nq: who?')).toContain('never closed')
    expect(reason(`${block('a?')}\n${block('b?')}`)).toContain('more than one')
    expect(reason('```' + ASK_FENCE + '\nwho are your clients?\n```')).toContain('unreadable line')
    expect(reason('```' + ASK_FENCE + '\n```')).toContain('asked nothing')
    // NOT terminal: a quoted example, or a block the model then retracts, must
    // never reach the desk as a real question.
    expect(reason(`${block('a?')}\nActually, ignore that.`)).toContain('not the last thing')
  })

  it('strips the block out of the prose, so asking is never counted as work', () => {
    const text = `NOTHING_NEEDED — everything is quiet\n\n${block('who?')}`
    expect(stripAskBlock(text).trim()).toBe('NOTHING_NEEDED — everything is quiet')
  })
})

// ---------------------------------------------------------------------------
// The note — the only memory, and it says where each line came from
// ---------------------------------------------------------------------------

describe('the business context note', () => {
  it('creates the note with BOTH provenance headings and the answers as his words', () => {
    const note = renderContextNote(null, [{ q: 'Who are your clients?', a: 'Two councils.' }], 0)
    expect(note).toContain('What the user told me (their own words)')
    expect(note).toContain('What I read in the vault myself')
    expect(note).toContain('**Q:** Who are your clients?')
    expect(note).toContain('**A:** Two councils.')
    expect(note).toContain('This note is the only memory')
  })

  it('appends later answers ABOVE the reading section — testimony and inference never mix', () => {
    const first = renderContextNote(null, [{ q: 'Who?', a: 'Councils.' }], 0)
    const withReading = first.replace('_nothing recorded here yet._', '- the vault mentions invoices')
    const second = renderContextNote(withReading, [{ q: 'What do you charge?', a: 'Day rate.' }], 0)
    const told = second.indexOf('**A:** Day rate.')
    const read = second.indexOf('- the vault mentions invoices')
    expect(told).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(told) // his words stay in his section
    expect(second).toContain('**A:** Councils.') // nothing already there is lost
  })

  it('an UNANSWERED question never becomes content', () => {
    const note = renderContextNote(null, [{ q: 'Who are your clients?', a: '   ' }], 0)
    expect(note).not.toContain('Who are your clients?')
    expect(note).toContain('_nothing yet — no question has been answered._')
    expect(answeredCount(note)).toBe(0)
  })

  it('counts real answers and reads back the questions it holds', () => {
    const note = renderContextNote(
      null,
      [
        { q: 'Who?', a: 'Councils.' },
        { q: 'What?', a: 'Integration work.' },
      ],
      0,
    )
    expect(answeredCount(note)).toBe(2)
    expect(answeredQuestions(note)).toEqual(['Who?', 'What?'])
    expect(contextThin(note)).toBe(true) // two answers is still thin
    expect(contextThin(null)).toBe(true) // no note at all is as thin as it gets
    const three = renderContextNote(note, [{ q: 'When?', a: 'Quarterly.' }], 0)
    expect(answeredCount(three)).toBe(3)
    expect(contextThin(three)).toBe(false) // the leg is earned
  })
})

// ---------------------------------------------------------------------------
// The gate — he asks only when nothing else is available, and only once
// ---------------------------------------------------------------------------

describe('when he is allowed to ask', () => {
  const open: QuestionSet = { id: 's1', at: 1, questions: ['who?'], status: 'open' }

  it('allows a set when nothing is waiting and the context is thin', () => {
    expect(askBlockedReason({ needsYou: 0, contextThin: true, sets: [] })).toBeNull()
  })

  it('refuses when something is waiting on the user — rung 1 outranks a question', () => {
    expect(askBlockedReason({ needsYou: 1, contextThin: true, sets: [] })).toBe(
      'something is already waiting on you',
    )
  })

  it('refuses when the note already holds enough', () => {
    expect(askBlockedReason({ needsYou: 0, contextThin: false, sets: [] })).toBe(
      'the business context note already has what I need',
    )
  })

  it('refuses a SECOND open set — at most one question set at a time', () => {
    expect(askBlockedReason({ needsYou: 0, contextThin: true, sets: [open] })).toBe(
      'a question set is already open on your desk',
    )
    // A decided set is not an open one.
    expect(
      askBlockedReason({
        needsYou: 0,
        contextThin: true,
        sets: [{ ...open, status: 'dismissed' }],
      }),
    ).toBeNull()
  })

  it('the charter tells him what he already asked, and never invites him to claim an answer', () => {
    const charter = askCharter(['Who are your clients?'])
    expect(charter).toContain('do NOT ask them again')
    expect(charter).toContain('Who are your clients?')
    expect(charter).toContain('never write as if a question had been answered')
    expect(askCharter([])).toContain('You have not asked them anything yet.')
  })
})

// ---------------------------------------------------------------------------
// The store — no duplicate asking, and answers are the only thing recorded
// ---------------------------------------------------------------------------

describe('the question store', () => {
  it('records a set of questions and nothing else', async () => {
    const m = await fresh()
    const set = m.ask(['Who are your clients?', 'What do you charge?'], 1_000)
    expect(set).not.toBeNull()
    expect(set!.status).toBe('open')
    expect(set!.questions).toHaveLength(2)
    expect(m.openSet(m.list())!.id).toBe(set!.id)
  })

  it('NEVER re-asks a question he has already put — answered, dismissed or still open', async () => {
    const m = await fresh()
    m.ask(['Who are your clients?'], 1_000)
    m.dismissSet(m.list()[0].id, 2_000)
    // Same question, different punctuation/case — still the same question.
    expect(m.ask(['who are your CLIENTS'], 3_000)).toBeNull()
    // A question already ANSWERED in the note is never re-asked either, even
    // if this store was cleared in between (the note outlives it).
    const note = renderContextNote(null, [{ q: 'What do you charge?', a: 'Day rate.' }], 0)
    expect(m.ask(['What do you charge?'], 4_000, note)).toBeNull()
    // A genuinely new question still gets through, and only that one.
    const set = m.ask(['Who are your clients?', 'Who signs off on spend?'], 5_000, note)
    expect(set!.questions).toEqual(['Who signs off on spend?'])
  })

  it('records ONLY the answers he typed — a blank answer is closed, never stored', async () => {
    const m = await fresh()
    const set = m.ask(['Who are your clients?', 'What do you charge?'], 1_000)!
    const pairs = m.recordAnswers(set.id, ['Two councils.', '  '], 2_000)
    expect(pairs).toEqual([{ q: 'Who are your clients?', a: 'Two councils.' }])
    const stored = m.list().find((s) => s.id === set.id)!
    expect(stored.status).toBe('answered')
    expect(stored.answeredCount).toBe(1)
    // The set is closed, so a second submit records nothing at all.
    expect(m.recordAnswers(set.id, ['late'], 3_000)).toEqual([])
  })

  it('a dismissal is sticky and answers nothing', async () => {
    const m = await fresh()
    const set = m.ask(['Who are your clients?'], 1_000)!
    m.dismissSet(set.id, 2_000)
    const stored = m.list()[0]
    expect(stored.status).toBe('dismissed')
    expect(stored.answeredCount).toBe(0)
    expect(m.openSet(m.list())).toBeNull()
  })

  it('the question key normalises wording, so a reworded repeat is still a repeat', () => {
    expect(questionKey('Who are your clients?')).toBe(questionKey('who are your CLIENTS'))
    expect(questionKey('Who are your clients?')).not.toBe(questionKey('who signs off'))
  })

  it('lists what he has asked, in his original words, for the prompt', async () => {
    const m = await fresh()
    m.ask(['Who are your clients?'], 1_000)
    expect(askedQuestions(m.list(), null)).toEqual(['Who are your clients?'])
  })
})
