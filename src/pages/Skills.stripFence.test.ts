import { describe, expect, it } from 'vitest'
import { stripCodeFence } from './Skills'

// The improve flow unwraps a whole-response markdown code fence the model may
// add despite the "ONLY the body" instruction, so the fence never lands
// inside SKILL.md. It must be surgical: only a fence wrapping the ENTIRE
// response is stripped, and inner content survives byte-for-byte.
describe('stripCodeFence', () => {
  it('unwraps a whole-response fence with a language tag, keeping inner content verbatim', () => {
    const inner = '# Procedure\n\n1. Do the thing.\n2. Verify.'
    expect(stripCodeFence('```markdown\n' + inner + '\n```')).toBe(inner)
  })

  it('unwraps a whole-response fence with no language tag', () => {
    const inner = 'line one\nline two'
    expect(stripCodeFence('```\n' + inner + '\n```')).toBe(inner)
  })

  it('leaves plain text untouched, including surrounding whitespace (no trim)', () => {
    const plain = '  # Procedure\n\n1. Step.  \n'
    expect(stripCodeFence(plain)).toBe(plain)
  })

  it('does NOT strip a fence that is embedded mid-body with trailing prose', () => {
    const body = 'Here is the code:\n```js\nconst x = 1\n```\nThat is the whole thing.'
    expect(stripCodeFence(body)).toBe(body)
  })

  it('preserves inner code fences when the outer wrapper is stripped', () => {
    // A doc body that itself contains a fenced example, wrapped once by the model.
    const inner = 'Use this:\n```js\nconst x = 1\n```\nDone.'
    expect(stripCodeFence('```markdown\n' + inner + '\n```')).toBe(inner)
  })
})
