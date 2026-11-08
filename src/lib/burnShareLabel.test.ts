import { describe, expect, it } from 'vitest'
import { burnShareLabel } from './burnShareLabel'

// Review 2026-11-08: the Console footer labelled the engine's TOKEN share
// "% of runs on your Mac" while Work's pill (a RUN share) said the same words
// with a different number. Each says what it counts.
describe('burnShareLabel', () => {
  it('an engine-attributed burn is a share of tokens', () => {
    expect(burnShareLabel(true, 66)).toBe('66% of tokens on your Mac')
  })
  it('the session fallback is a share of runs', () => {
    expect(burnShareLabel(false, 38)).toBe('38% of runs on your Mac')
  })
})
