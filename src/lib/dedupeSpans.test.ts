import { describe, expect, it } from 'vitest'
import { dedupeSpans } from './dedupeSpans'
import type { EngineSpan } from './nativeEngine'

const s = (span_id: string, start: number): EngineSpan => ({ name: 'model_call', type: 'model_call', status: 'ok', start, span_id, attrs: {} })

describe('dedupeSpans — a build’s finished steps are not counted twice under the live step', () => {
  it('keeps one copy of a span that arrives from two sources', () => {
    expect(dedupeSpans([s('a', 1), s('b', 2), s('a', 1)])).toEqual([s('a', 1), s('b', 2)])
  })
  it('keeps spans that carry no span_id (older lines) untouched', () => {
    const anon: EngineSpan = { name: 'model_call', type: 'model_call', status: 'ok', start: 3, attrs: {} }
    expect(dedupeSpans([anon, s('a', 1), anon])).toHaveLength(3)
  })
  it('returns an empty list for an empty list', () => {
    expect(dedupeSpans([])).toEqual([])
  })
})
