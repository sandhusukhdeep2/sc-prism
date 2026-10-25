import { describe, expect, it } from 'vitest'
import { providerInitial } from './Workspace'

// CHAT WAS THE ONE PLACE AN AI WAS A BLANK CIRCLE. Everywhere else in the app a
// coworker is a monogram in its model's colour — the board's seats, the rail's
// crew, the coworker panel's header. The chat disc was styled to hold a letter
// (.msg__orb sets font-weight, colour and centring) and was never given one.
describe('the chat disc names its provider, like every other coworker mark', () => {
  it('takes the PROVIDER’s initial, which is what the colour already encodes', () => {
    expect(providerInitial('local · Qwen3.8-27B-4bit')).toBe('L')
    expect(providerInitial('claude-cli · opus')).toBe('C')
    expect(providerInitial('gemini · gemini-2.5-flash')).toBe('G')
  })

  it('a bare provider with no model still has an initial', () => {
    expect(providerInitial('openai')).toBe('O')
  })

  it('an unnamed model leaves the disc BLANK — the same non-claim the grey makes', () => {
    expect(providerInitial('')).toBe('')
    expect(providerInitial('   ')).toBe('')
    expect(providerInitial('  ·  ')).toBe('')
  })
})
