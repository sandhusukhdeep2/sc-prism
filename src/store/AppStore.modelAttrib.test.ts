import { describe, expect, it } from 'vitest'
import {
  UNIVERSAL,
  messageModelFromVerdict,
  reducer,
  threadsFromPersisted,
} from './AppStore'
import type { ChatMessage } from './AppStore'
import type { Verdict } from '../engine/types'

// Multi-model chat — per-message attribution. Covers the pure derivation
// (messageModelFromVerdict), the id-scoped reducer (SET_MESSAGE_MODEL), and the
// optional-meta persistence round-trip (threadsFromPersisted / isChatMessage).

const asst = (id: string, text = 'hello'): ChatMessage => ({ id, kind: 'assistant', text })

// Minimal-but-valid Verdict fixture (mirrors makeVerdict in the other store
// tests). `over` swaps in the fields a given case exercises.
function makeVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    taskId: 't-1',
    task: 'do the thing',
    route: {
      target: 'local',
      model: 'qwen2.5-coder',
      via: 'via gateway',
      reason: 'kept local — cheap inference, zero egress',
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
    response: 'a real answer',
    ...over,
  }
}

// A cast base for the reducer cases — SET_MESSAGE_MODEL only reads state.threads
// + activeProjectId, same minimal-state pattern as AppStore.reducer.test.ts.
const base = {
  threads: {} as Record<string, ChatMessage[]>,
  activeProjectId: undefined,
} as Parameters<typeof reducer>[0]

function withThreads(threads: Record<string, ChatMessage[]>) {
  return { ...base, threads } as Parameters<typeof reducer>[0]
}

describe('messageModelFromVerdict (honest per-message attribution)', () => {
  it('names the REAL model from native.models_used[0] with the route reason + local flag', () => {
    const v = makeVerdict({
      native: {
        hooksFired: [],
        hookDecisions: [],
        blocks: 0,
        approvals: 0,
        memoryInjected: 0,
        disclosed: [],
        rejectedWrites: 0,
        cacheHits: 0,
        cacheMisses: 0,
        spansPath: '',
        models_used: ['claude · claude-3.5-sonnet'],
      },
      route: {
        target: 'cloud',
        model: 'claude · claude-3.5-sonnet',
        via: 'via gateway',
        reason: 'heavy reasoning — routed to your primary',
        routeLabel: 'cloud · claude · claude-3.5-sonnet',
      },
    })
    expect(messageModelFromVerdict(v)).toEqual({
      model: 'claude · claude-3.5-sonnet',
      routeReason: 'heavy reasoning — routed to your primary',
      isLocal: false,
    })
  })

  it('falls back to the route model when the verdict carries no models_used', () => {
    const meta = messageModelFromVerdict(makeVerdict())
    expect(meta?.model).toBe('qwen2.5-coder')
    expect(meta?.isLocal).toBe(true)
  })

  // H3 reconciliation: attribution meta no longer carries an `isReal` flag —
  // the live sendIntent flow only attributes a REAL completion (a stub/offline
  // verdict routes to an honest error card, never an attributed bubble), so a
  // "stub chip" branch could never fire in production. The derivation therefore
  // names the real model regardless of the sentinel and leaves the "is it real"
  // gate to the caller. A stub verdict still yields no fabricated model.
  it('names the route model without any stub flag (real-vs-stub is the caller’s gate)', () => {
    const meta = messageModelFromVerdict(makeVerdict({ response: '[stub: no live model configured]' }))
    expect(meta?.model).toBe('qwen2.5-coder')
    expect(meta).not.toHaveProperty('isReal')
  })

  it('returns null (no chip) when neither models_used nor a route model names a model', () => {
    const v = makeVerdict()
    // strip every model source the derivation can honestly read
    const stripped = { ...v, native: undefined, route: { ...v.route, model: '' } } as Verdict
    expect(messageModelFromVerdict(stripped)).toBeNull()
  })
})

describe('reducer SET_MESSAGE_MODEL', () => {
  it('sets the meta on the assistant message with that id', () => {
    const start = withThreads({ [UNIVERSAL]: [asst('a1')] })
    const next = reducer(start, {
      type: 'SET_MESSAGE_MODEL',
      id: 'a1',
      model: 'gemini · gemini-2.0-flash',
      routeReason: 'kept local — cheap inference, zero egress',
      isLocal: true,
    })
    const m = next.threads[UNIVERSAL][0]
    expect(m).toMatchObject({
      id: 'a1',
      kind: 'assistant',
      text: 'hello',
      model: 'gemini · gemini-2.0-flash',
      routeReason: 'kept local — cheap inference, zero egress',
      isLocal: true,
    })
  })

  it('is a no-op for an unknown id (message + threads unchanged)', () => {
    const start = withThreads({ [UNIVERSAL]: [asst('a1')] })
    const next = reducer(start, { type: 'SET_MESSAGE_MODEL', id: 'nope', model: 'x' })
    expect(next.threads[UNIVERSAL][0]).toEqual(asst('a1'))
  })

  it('leaves other messages and other threads untouched', () => {
    const start = withThreads({
      [UNIVERSAL]: [asst('a1'), asst('a2')],
      p1: [asst('b1')],
    })
    const next = reducer(start, { type: 'SET_MESSAGE_MODEL', id: 'a1', model: 'claude · c' })
    expect(next.threads[UNIVERSAL][1]).toEqual(asst('a2'))
    expect(next.threads.p1[0]).toEqual(asst('b1'))
    // only a1 gained meta
    expect(next.threads[UNIVERSAL][0]).toMatchObject({ id: 'a1', model: 'claude · c' })
  })

  it('only writes the fields the action carries — never blanks or fabricates one', () => {
    const start = withThreads({ [UNIVERSAL]: [asst('a1')] })
    const next = reducer(start, { type: 'SET_MESSAGE_MODEL', id: 'a1', model: 'local · m', routeReason: 'r' })
    const m = next.threads[UNIVERSAL][0] as Extract<ChatMessage, { kind: 'assistant' }>
    expect(m.model).toBe('local · m')
    expect(m.routeReason).toBe('r')
    // fields the action didn't carry are absent, not set to undefined chips
    expect('isLocal' in m).toBe(false)
  })

  it('never touches a non-assistant message that happens to share the id (guarded on kind)', () => {
    const userLike: ChatMessage = { id: 'a1', kind: 'user', text: 'hi' }
    const start = withThreads({ [UNIVERSAL]: [userLike] })
    const next = reducer(start, { type: 'SET_MESSAGE_MODEL', id: 'a1', model: 'x' })
    expect(next.threads[UNIVERSAL][0]).toEqual(userLike)
  })
})

describe('optional-meta persistence round-trip (back-compat)', () => {
  it('rehydrates an assistant message WITH meta unchanged', () => {
    const withMeta: ChatMessage = {
      id: 'a1',
      kind: 'assistant',
      text: 'hello',
      model: 'claude · claude-3.5-sonnet',
      routeReason: 'heavy reasoning — routed to your primary',
      isLocal: false,
    }
    // Serialize exactly as saveSession does (JSON round-trip), then rehydrate.
    const parsed = JSON.parse(JSON.stringify({ threads: { [UNIVERSAL]: [withMeta] } }))
    expect(threadsFromPersisted(parsed)).toEqual({ [UNIVERSAL]: [withMeta] })
  })

  it('an assistant message WITHOUT meta stays valid (pre-attribution session)', () => {
    const parsed = JSON.parse(JSON.stringify({ threads: { [UNIVERSAL]: [asst('a1')] } }))
    expect(threadsFromPersisted(parsed)).toEqual({ [UNIVERSAL]: [asst('a1')] })
  })

  it('rejects a persisted message whose meta field is the WRONG type (no misleading chip)', () => {
    const bad = { threads: { [UNIVERSAL]: [{ id: 'a1', kind: 'assistant', text: 'x', model: 123 }] } }
    expect(threadsFromPersisted(bad)).toBeNull()
  })
})
