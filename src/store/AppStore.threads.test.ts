import { describe, expect, it } from 'vitest'
import {
  UNIVERSAL,
  activeMessages,
  activeThreadKey,
  projectTurnToMessage,
  reducer,
  seedThreadsFromProjects,
  threadFor,
  threadsFromPersisted,
} from './AppStore'
import type { ChatMessage } from './AppStore'
import { summaryMessage } from '../lib/compaction'
import type { ProjectTurn } from '../lib/projects'
import type { Verdict } from '../engine/types'

const userMsg = (id: string, text = 'hi'): ChatMessage => ({ id, kind: 'user', text })
const asstMsg = (id: string, text = ''): ChatMessage => ({ id, kind: 'assistant', text })

// Minimal-but-valid Verdict fixture — mirrors the makeVerdict helper in
// projectRun.test.ts: every field ADD_VERDICT touches is real, the rest is
// filler so the shape type-checks.
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

// ---------------------------------------------------------------------------
// pure selectors
// ---------------------------------------------------------------------------

describe('activeThreadKey', () => {
  it('a bound project id is its own thread key', () => {
    expect(activeThreadKey('p1')).toBe('p1')
  })
  it('undefined (no bound project) is the universal thread', () => {
    expect(activeThreadKey(undefined)).toBe(UNIVERSAL)
    expect(UNIVERSAL).toBe('universal')
  })
  it('an empty string is the universal thread', () => {
    expect(activeThreadKey('')).toBe(UNIVERSAL)
  })
})

describe('threadFor', () => {
  it('returns the array for a present key', () => {
    const arr = [userMsg('a')]
    expect(threadFor({ p1: arr }, 'p1')).toBe(arr)
  })
  it('returns [] for an absent key', () => {
    expect(threadFor({}, 'nope')).toEqual([])
  })
})

describe('projectTurnToMessage', () => {
  it("maps a 'user' turn to a user message", () => {
    const t: ProjectTurn = { role: 'user', text: 'hi' }
    const m = projectTurnToMessage('p1', t, 0)
    expect(m.kind).toBe('user')
    expect(m).toMatchObject({ kind: 'user', text: 'hi' })
  })
  it("maps an 'ai' turn to an assistant message", () => {
    const t: ProjectTurn = { role: 'ai', text: 'yo' }
    const m = projectTurnToMessage('p1', t, 1)
    expect(m.kind).toBe('assistant')
    expect(m).toMatchObject({ kind: 'assistant', text: 'yo' })
  })
  it('id embeds the projectId and idx for stability', () => {
    const m = projectTurnToMessage('proj-9', { role: 'user', text: 'x' }, 3)
    expect(m.id).toContain('proj-9')
    expect(m.id).toContain('3')
  })
})

// ---------------------------------------------------------------------------
// reducer — thread routing
// ---------------------------------------------------------------------------

// Minimal cast state — the message branches only read threads + activeProjectId
// (spread the rest), same minimal-cast approach as AppStore.reducer.test.ts.
const threadsBase = (over: Partial<{ activeProjectId?: string; threads: Record<string, ChatMessage[]> }> = {}) =>
  ({ threads: {}, activeProjectId: undefined, ...over }) as Parameters<typeof reducer>[0]

describe('reducer ADD_MESSAGE thread routing', () => {
  it('lands in the universal thread when no project is active', () => {
    const next = reducer(threadsBase(), { type: 'ADD_MESSAGE', message: userMsg('u1') })
    expect(next.threads[UNIVERSAL]).toEqual([userMsg('u1')])
    expect(activeMessages(next)).toEqual([userMsg('u1')])
  })
  it('lands in the active project thread when one is bound', () => {
    const next = reducer(threadsBase({ activeProjectId: 'p1' }), {
      type: 'ADD_MESSAGE',
      message: userMsg('u1'),
    })
    expect(next.threads.p1).toEqual([userMsg('u1')])
    expect(next.threads[UNIVERSAL]).toBeUndefined()
  })
  it('an explicit thread wins over the active project', () => {
    const next = reducer(threadsBase({ activeProjectId: 'p1' }), {
      type: 'ADD_MESSAGE',
      message: userMsg('u1'),
      thread: 'p2',
    })
    expect(next.threads.p2).toEqual([userMsg('u1')])
    expect(next.threads.p1).toBeUndefined()
  })
})

describe('reducer APPEND_ASSISTANT (cross-thread find)', () => {
  it('appends the line to an assistant message in a NON-active thread', () => {
    const base = threadsBase({ threads: { [UNIVERSAL]: [], p1: [asstMsg('a1', '')] } })
    const next = reducer(base, { type: 'APPEND_ASSISTANT', id: 'a1', line: 'first line' })
    const msg = next.threads.p1.find((m) => m.id === 'a1')
    expect(msg).toMatchObject({ kind: 'assistant', text: 'first line' })
  })
  it('joins onto existing text with a newline', () => {
    const base = threadsBase({ threads: { p1: [asstMsg('a1', 'line one')] } })
    const next = reducer(base, { type: 'APPEND_ASSISTANT', id: 'a1', line: 'line two' })
    const msg = next.threads.p1.find((m) => m.id === 'a1')
    expect(msg).toMatchObject({ text: 'line one\nline two' })
  })
})

describe('reducer REMOVE_MESSAGE (cross-thread)', () => {
  it('removes the id from whichever thread holds it', () => {
    const base = threadsBase({ threads: { [UNIVERSAL]: [userMsg('u1')], p1: [asstMsg('a1', 'x')] } })
    const next = reducer(base, { type: 'REMOVE_MESSAGE', id: 'a1' })
    expect(next.threads.p1.find((m) => m.id === 'a1')).toBeUndefined()
    expect(next.threads[UNIVERSAL]).toEqual([userMsg('u1')])
  })
})

describe('reducer ADD_VERDICT', () => {
  const verdictBase = (over: Partial<{ activeProjectId?: string; threads: Record<string, ChatMessage[]> }> = {}) =>
    ({
      threads: { [UNIVERSAL]: [] },
      verdicts: [] as Verdict[],
      stats: { tokensToday: 0, costToday: 0, tier1Saves: 0, localSharePct: 0, evalAvg: 0 },
      totalRuns: 0,
      localRuns: 0,
      evalSum: 0,
      evalCount: 0,
      activeProjectId: undefined,
      ...over,
    }) as Parameters<typeof reducer>[0]

  it('appends the verdict message to the ACTIVE thread and prepends to verdicts', () => {
    const v = makeVerdict({ taskId: 'X-1' })
    const next = reducer(verdictBase({ activeProjectId: 'p1', threads: { [UNIVERSAL]: [], p1: [] } }), {
      type: 'ADD_VERDICT',
      verdict: v,
    })
    expect(next.verdicts[0]).toBe(v)
    expect(next.threads.p1).toEqual([{ id: 'v-X-1', kind: 'verdict', verdict: v }])
    expect(next.threads[UNIVERSAL]).toEqual([])
  })

  it('with no active project the verdict message lands in the universal thread', () => {
    const v = makeVerdict({ taskId: 'X-2' })
    const next = reducer(verdictBase(), { type: 'ADD_VERDICT', verdict: v })
    expect(next.threads[UNIVERSAL]).toEqual([{ id: 'v-X-2', kind: 'verdict', verdict: v }])
  })

  it('an explicit thread routes the verdict card there, not the active thread', () => {
    // Active is universal (no bound project); the origin thread is p1.
    const v = makeVerdict({ taskId: 'X-3' })
    const next = reducer(verdictBase({ threads: { [UNIVERSAL]: [], p1: [] } }), {
      type: 'ADD_VERDICT',
      verdict: v,
      thread: 'p1',
    })
    // Card lands in the named thread, NOT the on-screen (universal) thread.
    expect(next.threads.p1).toEqual([{ id: 'v-X-3', kind: 'verdict', verdict: v }])
    expect(next.threads[UNIVERSAL]).toEqual([])
    // The verdict itself is still recorded regardless of the card destination.
    expect(next.verdicts[0]).toBe(v)
  })

  it('card:false records the verdict + stats but appends NO chat card to any thread', () => {
    const v = makeVerdict({ taskId: 'X-4' })
    const before = verdictBase({ activeProjectId: 'p1', threads: { [UNIVERSAL]: [], p1: [] } })
    const next = reducer(before, { type: 'ADD_VERDICT', verdict: v, card: false })
    // Verdict + rolling stats/accumulators still update.
    expect(next.verdicts[0]).toBe(v)
    expect(next.totalRuns).toBe(before.totalRuns + 1)
    // No new message in ANY thread — every thread array length is unchanged.
    for (const key of Object.keys(next.threads)) {
      expect(next.threads[key].length).toBe(before.threads[key].length)
    }
  })
})

describe('reducer COMPACT_THREAD', () => {
  const compactBase = (over: Partial<{ activeProjectId?: string; threads: Record<string, ChatMessage[]> }> = {}) =>
    ({
      threads: {},
      verdicts: [] as Verdict[],
      stats: { tokensToday: 12, costToday: 0.5, tier1Saves: 3, localSharePct: 70, evalAvg: 0.8 },
      totalRuns: 5,
      localRuns: 3,
      evalSum: 4,
      evalCount: 5,
      activeProjectId: undefined,
      ...over,
    }) as Parameters<typeof reducer>[0]

  it('a thread of 10 messages, keepRecent 6 → [summary divider, ...last 6]; other threads/verdicts/stats untouched', () => {
    const ten = Array.from({ length: 10 }, (_, i) => userMsg(`m${i}`, `text ${i}`))
    const other = [userMsg('keep-1'), asstMsg('keep-2')]
    const before = compactBase({ threads: { p1: ten, [UNIVERSAL]: other } })
    const next = reducer(before, {
      type: 'COMPACT_THREAD',
      thread: 'p1',
      summaryId: 'sum-1',
      summary: 'Plan: X. Tasks done: Y. Decisions: Z.',
      keepRecent: 6,
    })

    expect(next.threads.p1).toHaveLength(7)
    expect(next.threads.p1[0]).toEqual(summaryMessage('sum-1', 'Plan: X. Tasks done: Y. Decisions: Z.'))
    expect(next.threads.p1[0].kind).toBe('divider')
    // the last 6 originals, in order, preserved verbatim
    expect(next.threads.p1.slice(1)).toEqual(ten.slice(4))

    // other threads untouched
    expect(next.threads[UNIVERSAL]).toBe(other)
    expect(next.threads[UNIVERSAL]).toEqual(other)

    // verdicts/stats/accumulators untouched
    expect(next.verdicts).toBe(before.verdicts)
    expect(next.stats).toBe(before.stats)
    expect(next.totalRuns).toBe(before.totalRuns)
    expect(next.localRuns).toBe(before.localRuns)
    expect(next.evalSum).toBe(before.evalSum)
    expect(next.evalCount).toBe(before.evalCount)
  })

  it('a thread of <= keepRecent messages is a no-op (state unchanged)', () => {
    const five = Array.from({ length: 5 }, (_, i) => userMsg(`m${i}`))
    const before = compactBase({ threads: { p1: five } })
    const next = reducer(before, {
      type: 'COMPACT_THREAD',
      thread: 'p1',
      summaryId: 'sum-1',
      summary: 'irrelevant',
      keepRecent: 6,
    })
    expect(next).toBe(before)
  })

  it('exactly keepRecent messages (default 6) is also a no-op', () => {
    const six = Array.from({ length: 6 }, (_, i) => userMsg(`m${i}`))
    const before = compactBase({ threads: { p1: six } })
    const next = reducer(before, {
      type: 'COMPACT_THREAD',
      thread: 'p1',
      summaryId: 'sum-1',
      summary: 'irrelevant',
    })
    expect(next).toBe(before)
    expect(next.threads.p1).toBe(six)
  })

  it('a missing thread key (never existed) is also a no-op', () => {
    const before = compactBase({ threads: { [UNIVERSAL]: [] } })
    const next = reducer(before, {
      type: 'COMPACT_THREAD',
      thread: 'ghost',
      summaryId: 'sum-1',
      summary: 'irrelevant',
    })
    expect(next).toBe(before)
  })
})

describe('reducer RESET_THREAD', () => {
  const resetBase = (over: Partial<{ activeProjectId?: string; threads: Record<string, ChatMessage[]> }> = {}) =>
    ({
      threads: {},
      verdicts: [makeVerdict()] as Verdict[],
      stats: { tokensToday: 12, costToday: 0.5, tier1Saves: 3, localSharePct: 70, evalAvg: 0.8 },
      totalRuns: 5,
      localRuns: 3,
      evalSum: 4,
      evalCount: 5,
      activeProjectId: undefined,
      ...over,
    }) as Parameters<typeof reducer>[0]

  it('empties the named thread; other threads + verdicts + stats untouched', () => {
    const p1 = [userMsg('m1'), asstMsg('m2', 'reply'), userMsg('m3')]
    const other = [userMsg('keep-1'), asstMsg('keep-2', 'kept')]
    const before = resetBase({ threads: { p1, [UNIVERSAL]: other } })
    const next = reducer(before, { type: 'RESET_THREAD', thread: 'p1' })

    // named thread emptied
    expect(next.threads.p1).toEqual([])
    // sibling thread untouched (same reference)
    expect(next.threads[UNIVERSAL]).toBe(other)
    // verdicts + stats + accumulators untouched (same references)
    expect(next.verdicts).toBe(before.verdicts)
    expect(next.stats).toBe(before.stats)
    expect(next.totalRuns).toBe(before.totalRuns)
    expect(next.localRuns).toBe(before.localRuns)
    expect(next.evalSum).toBe(before.evalSum)
    expect(next.evalCount).toBe(before.evalCount)
  })

  it('resetting a never-seen thread key just creates an empty one; siblings intact', () => {
    const other = [userMsg('keep-1')]
    const before = resetBase({ threads: { [UNIVERSAL]: other } })
    const next = reducer(before, { type: 'RESET_THREAD', thread: 'ghost' })
    expect(next.threads.ghost).toEqual([])
    expect(next.threads[UNIVERSAL]).toBe(other)
  })
})

// ---------------------------------------------------------------------------
// persistence migration
// ---------------------------------------------------------------------------

describe('threadsFromPersisted', () => {
  it('round-trips a new-format threads record', () => {
    const parsed = { threads: { [UNIVERSAL]: [userMsg('u1')] } }
    expect(threadsFromPersisted(parsed)).toEqual({ [UNIVERSAL]: [userMsg('u1')] })
  })
  it('ensures a universal key exists on a threads record that lacks one', () => {
    const parsed = { threads: { p1: [userMsg('u1')] } }
    expect(threadsFromPersisted(parsed)).toEqual({ p1: [userMsg('u1')], [UNIVERSAL]: [] })
  })
  it('migrates the OLD flat {messages:[...]} format into the universal thread', () => {
    const parsed = { messages: [userMsg('u1')] }
    expect(threadsFromPersisted(parsed)).toEqual({ [UNIVERSAL]: [userMsg('u1')] })
  })
  it('rejects an empty / garbage object', () => {
    expect(threadsFromPersisted({})).toBeNull()
    expect(threadsFromPersisted({ nonsense: 1 })).toBeNull()
  })
  it('rejects a threads record containing an invalid message', () => {
    const parsed = { threads: { [UNIVERSAL]: [{ id: 'bad', kind: 'nope' }] } }
    expect(threadsFromPersisted(parsed)).toBeNull()
  })
  it('rejects when a thread value is not an array', () => {
    const parsed = { threads: { [UNIVERSAL]: 'not-an-array' } }
    expect(threadsFromPersisted(parsed)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// project transcript seeding
// ---------------------------------------------------------------------------

describe('seedThreadsFromProjects', () => {
  const project = (id: string, transcript: ProjectTurn[]) => ({ id, transcript })

  it('seeds a project thread from its transcript when none exists', () => {
    const out = seedThreadsFromProjects(
      { [UNIVERSAL]: [] },
      [project('p1', [{ role: 'user', text: 'hi' }, { role: 'ai', text: 'yo' }])],
    )
    expect(out.p1).toEqual([
      projectTurnToMessage('p1', { role: 'user', text: 'hi' }, 0),
      projectTurnToMessage('p1', { role: 'ai', text: 'yo' }, 1),
    ])
  })

  it('does NOT overwrite a thread that already has messages', () => {
    const existing = [userMsg('keep')]
    const out = seedThreadsFromProjects(
      { p1: existing },
      [project('p1', [{ role: 'user', text: 'hi' }])],
    )
    expect(out.p1).toBe(existing)
  })

  it('adds no key for a project with an empty transcript', () => {
    const out = seedThreadsFromProjects({ [UNIVERSAL]: [] }, [project('p1', [])])
    expect(out.p1).toBeUndefined()
    expect('p1' in out).toBe(false)
  })
})
