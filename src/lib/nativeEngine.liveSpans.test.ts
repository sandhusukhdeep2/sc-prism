import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Since 2026-11-09 the engine announces a model call or a tool call when it
// OPENS (status "open", same span_id) and rewrites the span when it closes —
// the only way a board can show a seat thinking / reading / searching while
// it happens. The tail reader therefore keeps ONE record per span_id, the
// last one written, so nothing downstream counts a call twice.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { readSpansTail } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}
function goBrowser() {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

const open = { run_id: 'r1', span_id: 's1', name: 'model_call', type: 'model_call', start: 10, end: null, duration_ms: null, status: 'open', attrs: { agent: 'scout', provider: 'local' } }
const closed = { ...open, end: 12, duration_ms: 2000, status: 'ok', attrs: { ...open.attrs, tokens_out: 42 } }
const other = { run_id: 'r1', span_id: 's2', name: 'tool_exec', type: 'tool_exec', start: 11, end: null, duration_ms: null, status: 'open', attrs: { agent: 'scout', tool: 'vault_read' } }

beforeEach(() => {
  goNative()
  invokeMock.mockReset()
})
afterEach(goBrowser)

describe('readSpansTail — one record per span', () => {
  it('folds an open line into its close and keeps the slot where the span first appeared', async () => {
    invokeMock.mockResolvedValue([open, other, closed].map((s) => JSON.stringify(s)))
    const spans = await readSpansTail('/vault', 60)
    expect(spans.map((s) => s.span_id)).toEqual(['s1', 's2'])
    expect(spans[0].status).toBe('ok')
    expect(spans[0].attrs?.tokens_out).toBe(42)
  })
  it('a span nobody has closed reads as open — that is the live state, not an error', async () => {
    invokeMock.mockResolvedValue([open].map((s) => JSON.stringify(s)))
    const spans = await readSpansTail('/vault', 60)
    expect(spans).toHaveLength(1)
    expect(spans[0].status).toBe('open')
  })
  it('a line with no span_id (an older writer) is kept as it is', async () => {
    const legacy = { name: 'hook', type: 'hook', start: 1, status: 'ok', attrs: {} }
    invokeMock.mockResolvedValue([legacy, legacy].map((s) => JSON.stringify(s)))
    expect(await readSpansTail('/vault', 60)).toHaveLength(2)
  })
})
