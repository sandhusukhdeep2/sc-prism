import { describe, expect, it } from 'vitest'
import { UNIVERSAL, activeMessages, healPendingBubbles, reducer, sanitizeActiveProjectId } from './AppStore'
import type { ChatMessage, Notice } from './AppStore'
import type { LiveRun } from '../lib/liveRuns'

const errorMsg: ChatMessage = {
  id: 'e1',
  kind: 'error',
  text: 'Local model is unreachable — nothing was sent. Start the server and retry.',
  intent: 'build my site',
  providerId: 'local',
}

// The ADD_MESSAGE / REMOVE_MESSAGE cases only touch state.threads +
// activeProjectId (spread the rest), so a minimal cast state exercises them
// without exporting AppState. No active project → the universal thread.
const base = {
  threads: {} as Record<string, ChatMessage[]>,
  activeProjectId: undefined,
} as Parameters<typeof reducer>[0]

describe('reducer message handling', () => {
  it("stores an 'error' message via ADD_MESSAGE", () => {
    const next = reducer(base, { type: 'ADD_MESSAGE', message: errorMsg })
    // .at(-1) needs ES2022 lib; this repo targets ES2021 (tsconfig.json), so
    // index from length instead — same assertion, no lib bump.
    const msgs = activeMessages(next)
    expect(msgs[msgs.length - 1]).toEqual(errorMsg)
  })

  it('REMOVE_MESSAGE drops exactly the given id', () => {
    const withMsg = reducer(base, { type: 'ADD_MESSAGE', message: errorMsg })
    const next = reducer(withMsg, { type: 'REMOVE_MESSAGE', id: 'e1' })
    expect(activeMessages(next).find((m) => m.id === 'e1')).toBeUndefined()
    expect(activeMessages(next).length).toBe(activeMessages(withMsg).length - 1)
  })
})

const notice: Notice = { id: 'n1', projectId: 'proj-1', text: '«Site» is done — check it', kind: 'done' }

// ADD_NOTICE / CLEAR_NOTICE only touch state.notices (spread the rest), same
// minimal-cast-state approach as the message cases above.
const noticeBase = { notices: [] as Notice[] } as Parameters<typeof reducer>[0]

describe('reducer notice handling', () => {
  it('stores a notice via ADD_NOTICE', () => {
    const next = reducer(noticeBase, { type: 'ADD_NOTICE', notice })
    expect(next.notices[next.notices.length - 1]).toEqual(notice)
  })

  it('CLEAR_NOTICE drops exactly the given id', () => {
    const withNotice = reducer(noticeBase, { type: 'ADD_NOTICE', notice })
    const next = reducer(withNotice, { type: 'CLEAR_NOTICE', id: 'n1' })
    expect(next.notices.find((n) => n.id === 'n1')).toBeUndefined()
    expect(next.notices.length).toBe(withNotice.notices.length - 1)
  })

  it('CLEAR_NOTICE leaves other notices untouched', () => {
    const other: Notice = { id: 'n2', projectId: 'proj-2', text: '«App» needs attention', kind: 'attention' }
    const withBoth = reducer(reducer(noticeBase, { type: 'ADD_NOTICE', notice }), {
      type: 'ADD_NOTICE',
      notice: other,
    })
    const next = reducer(withBoth, { type: 'CLEAR_NOTICE', id: 'n1' })
    expect(next.notices).toEqual([other])
  })
})

// SET_ACTIVE_PROJECT only touches state.activeProjectId (spread the rest),
// same minimal-cast-state approach as the message/notice cases above.
const activeProjectBase = { activeProjectId: undefined } as Parameters<typeof reducer>[0]

describe('reducer SET_ACTIVE_PROJECT (P2-4: bind a project to the Workspace)', () => {
  it('binds the given project id', () => {
    const next = reducer(activeProjectBase, { type: 'SET_ACTIVE_PROJECT', projectId: 'proj-1' })
    expect(next.activeProjectId).toBe('proj-1')
  })

  it('rebinds to a different project id, overwriting the previous one', () => {
    const first = reducer(activeProjectBase, { type: 'SET_ACTIVE_PROJECT', projectId: 'proj-1' })
    const next = reducer(first, { type: 'SET_ACTIVE_PROJECT', projectId: 'proj-2' })
    expect(next.activeProjectId).toBe('proj-2')
  })

  it('an empty string clears the binding to undefined (not "")', () => {
    const bound = reducer(activeProjectBase, { type: 'SET_ACTIVE_PROJECT', projectId: 'proj-1' })
    const next = reducer(bound, { type: 'SET_ACTIVE_PROJECT', projectId: '' })
    expect(next.activeProjectId).toBeUndefined()
  })

  it('leaves other state fields untouched', () => {
    const withMsg = reducer(base, { type: 'ADD_MESSAGE', message: errorMsg })
    const next = reducer(withMsg, { type: 'SET_ACTIVE_PROJECT', projectId: 'proj-1' })
    expect(next.threads).toBe(withMsg.threads)
  })
})

// ---------------------------------------------------------------------------
// sanitizeActiveProjectId — back-compat tolerance for a persisted session
// predating P2-4 (no activeProjectId key at all) or a malformed one.
// ---------------------------------------------------------------------------

describe('sanitizeActiveProjectId', () => {
  it('passes through a non-empty string unchanged', () => {
    expect(sanitizeActiveProjectId('proj-1')).toBe('proj-1')
  })

  it('undefined (missing key, pre-P2-4 session) sanitizes to undefined', () => {
    expect(sanitizeActiveProjectId(undefined)).toBeUndefined()
  })

  it('an empty string sanitizes to undefined (matches the reducer clear rule)', () => {
    expect(sanitizeActiveProjectId('')).toBeUndefined()
  })

  it('a non-string value (number, object, null) sanitizes to undefined, no throw', () => {
    expect(sanitizeActiveProjectId(42)).toBeUndefined()
    expect(sanitizeActiveProjectId(null)).toBeUndefined()
    expect(sanitizeActiveProjectId({ id: 'proj-1' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// LIVE_RUN_PAUSE (mission-control audit H1) — a run that is parked on a human
// answer stays registered (it really does resume) but is flagged so nothing on
// the Work page glows, pulses or reads "live" while no engine is executing.
// ---------------------------------------------------------------------------

const withRuns = (runs: LiveRun[]) =>
  ({ liveRuns: runs, finishedRuns: [] }) as unknown as Parameters<typeof reducer>[0]

const run = (id: string, over: Partial<LiveRun> = {}): LiveRun => ({
  id,
  kind: 'project',
  intent: 'build the dashboard',
  startedAt: 1_700_000_000_000,
  models: [],
  ...over,
})

describe('reducer LIVE_RUN_PAUSE', () => {
  it('parks exactly the named run and leaves the others alone', () => {
    const next = reducer(withRuns([run('a'), run('b')]), {
      type: 'LIVE_RUN_PAUSE',
      id: 'a',
      paused: true,
    })
    expect(next.liveRuns.find((r) => r.id === 'a')?.paused).toBe(true)
    expect(next.liveRuns.find((r) => r.id === 'b')?.paused).toBeUndefined()
    // Parking never removes the run — the build resumes on the answer.
    expect(next.liveRuns).toHaveLength(2)
  })

  it('unparks on the answer', () => {
    const parked = withRuns([run('a', { paused: true })])
    const next = reducer(parked, { type: 'LIVE_RUN_PAUSE', id: 'a', paused: false })
    expect(next.liveRuns[0].paused).toBe(false)
  })

  it('an id that is not live is a no-op — a stray park conjures no card', () => {
    const next = reducer(withRuns([]), { type: 'LIVE_RUN_PAUSE', id: 'ghost', paused: true })
    expect(next.liveRuns).toHaveLength(0)
  })
})

// THE STUCK BUBBLE (2026-08-28): the node-cli thread showed "Sukh is thinking…
// (subscription replies take 15–45s)" with NO engine process alive — the app
// had closed mid-run and persisted the empty assistant placeholder that IS the
// typing indicator. Pending is a live-session fact; a restored thread may
// carry answers and honest notices, never an open promise.
describe('healPendingBubbles — a pending indicator must not survive a restart', () => {
  it("an empty assistant bubble becomes the app's own honest notice", () => {
    const threads = {
      [UNIVERSAL]: [
        { id: 'u1', kind: 'user', text: 'do reserch' },
        { id: 'a1', kind: 'assistant', text: '' },
      ] as ChatMessage[],
    }
    const healed = healPendingBubbles(threads)
    const msgs = healed[UNIVERSAL]
    expect(msgs[1].kind).toBe('notice')
    expect((msgs[1] as { text: string }).text).toMatch(/reply never arrived/i)
    // The user's own message is untouched.
    expect(msgs[0]).toEqual(threads[UNIVERSAL][0])
  })

  it('finished bubbles and every other kind pass through untouched — same reference', () => {
    const threads = {
      [UNIVERSAL]: [
        { id: 'u1', kind: 'user', text: 'hi' },
        { id: 'a1', kind: 'assistant', text: 'hello' },
      ] as ChatMessage[],
    }
    expect(healPendingBubbles(threads)).toBe(threads)
  })
})
