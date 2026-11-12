import { describe, expect, it } from 'vitest'
import { effortsArg } from './efforts'

// Each AI's thinking effort is ITS OWN (2026-11-12). Settings holds one per
// provider; only the primary's used to be sent, and the engine applied it to
// every provider in the run — a critic seat on Gemini thought at the level
// chosen for Claude and timed out. This is the list the engine is now given.
describe('effortsArg — each enabled provider with its own level', () => {
  const p = (id: string, effort: string | undefined, enabled = true) => ({ id, effort, enabled })

  it('lists every enabled provider the engine knows, with its own level', () => {
    expect(effortsArg([p('claude-cli', 'max'), p('gemini', 'low'), p('local', undefined)])).toBe(
      'claude-cli=max,gemini=low,local=',
    )
  })

  it('a provider with no level is listed as having none — it must not inherit one', () => {
    expect(effortsArg([p('claude-cli', 'high'), p('gemini', '')])).toBe('claude-cli=high,gemini=')
  })

  it('a provider that is switched off is not in the run', () => {
    expect(effortsArg([p('claude-cli', 'high'), p('gemini', 'low', false)])).toBe('claude-cli=high')
  })

  it('a level that is not on the ladder is no level', () => {
    expect(effortsArg([p('gemini', 'turbo'), p('openai', 'MEDIUM')])).toBe('gemini=,openai=medium')
  })

  it('a custom endpoint is the engine’s local path, and speaks for it only when it is the primary', () => {
    const custom = { id: 'custom-1', effort: 'high', enabled: true, primary: true }
    expect(effortsArg([custom, p('gemini', 'low')])).toBe('local=high,gemini=low')
    expect(effortsArg([{ ...custom, primary: false }, p('local', 'low')])).toBe('local=low')
  })

  it('nothing enabled still says so, rather than saying nothing', () => {
    // An empty list would read as "an older caller" and bring the single
    // run-wide level back.
    expect(effortsArg([])).toBe('local=')
  })
})
