// The day's first model check (the owner, 2026-11-14: "every time when we
// start working for the day … check the new available AIs models and add to
// in our list … Always prefer a new one, the greatest one").
//
// Rules, not a model, decide every move here:
//   • a metered key moves only to a NEWER VERSION OF THE SAME MODEL — never to
//     a dearer tier;
//   • the primary on a subscription CLI moves to the top model its plan offers
//     (a tier move costs limits there, not a bill) — and only once that model
//     has actually answered;
//   • the local AI is never moved: its place on the workload slider was
//     measured on the model it has.
import { describe, expect, it } from 'vitest'
import {
  chatModels,
  checkDue,
  modelCheckLine,
  newerInFamily,
  newSince,
  parseModelId,
  planModelCheck,
  topCliChoice,
} from './modelCheck'
import type { ProviderConfig } from './settings'

const DAY = 24 * 60 * 60_000
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h).getTime()

describe('checkDue — once per calendar day', () => {
  it('is due when it has never run', () => {
    expect(checkDue(0, at(2026, 11, 14))).toBe(true)
  })
  it('is not due again the same day, however many hours pass', () => {
    expect(checkDue(at(2026, 11, 14, 7), at(2026, 11, 14, 23))).toBe(false)
  })
  it('is due the next morning even if fewer than 24 hours passed', () => {
    expect(checkDue(at(2026, 11, 14, 23), at(2026, 11, 15, 6))).toBe(true)
    expect(at(2026, 11, 15, 6) - at(2026, 11, 14, 23)).toBeLessThan(DAY)
  })
})

describe('parseModelId — family and version', () => {
  it('reads the words as the family and the numbers as the version', () => {
    expect(parseModelId('claude-fable-5-2')).toEqual({ family: 'claude-fable', version: [5, 2] })
    expect(parseModelId('gpt-5.1')).toEqual({ family: 'gpt', version: [5, 1] })
    expect(parseModelId('gemini-2.5-pro')).toEqual({ family: 'gemini-pro', version: [2, 5] })
  })
  it('a dated snapshot keeps its version; the date is not a version', () => {
    expect(parseModelId('claude-sonnet-4-5-20250929')).toEqual({ family: 'claude-sonnet', version: [4, 5] })
  })
  it('an old-style id with the version first is the same family', () => {
    expect(parseModelId('claude-3-5-sonnet-20241022')).toEqual({ family: 'claude-sonnet', version: [3, 5] })
  })
  it('a qualifier makes a different family', () => {
    expect(parseModelId('gpt-5-mini').family).toBe('gpt-mini')
    expect(parseModelId('gemini-3-pro-preview').family).toBe('gemini-pro-preview')
  })
  it('an always-current alias has no version', () => {
    expect(parseModelId('gemini-flash-latest')).toEqual({ family: 'gemini-flash-latest', version: [] })
  })
})

describe('newerInFamily', () => {
  const listed = [
    'claude-fable-5-1',
    'claude-fable-5-2',
    'claude-opus-5-5',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
  ]
  it('finds the newest version of the model you are on', () => {
    expect(newerInFamily('claude-fable-5-1', listed)).toBe('claude-fable-5-2')
    expect(newerInFamily('claude-sonnet-5', listed)).toBe('claude-sonnet-5-5')
  })
  it('stays put when you are already on the newest', () => {
    expect(newerInFamily('claude-fable-5-2', listed)).toBe('')
  })
  it('never crosses to another tier, however much newer', () => {
    expect(newerInFamily('claude-haiku-5-5', listed)).toBe('')
    expect(newerInFamily('claude-opus-5-5', listed)).toBe('')
  })
  it('never moves to a preview, a mini or any other qualified model', () => {
    expect(newerInFamily('gpt-5', ['gpt-5', 'gpt-5-mini', 'gpt-6-preview'])).toBe('')
    expect(newerInFamily('gpt-5', ['gpt-5', 'gpt-5.1', 'gpt-6-preview'])).toBe('gpt-5.1')
  })
  it('leaves an always-current alias and an unknown name alone', () => {
    expect(newerInFamily('gemini-flash-latest', ['gemini-flash-latest', 'gemini-3-flash'])).toBe('')
    expect(newerInFamily('', listed)).toBe('')
    expect(newerInFamily('my-own-model', listed)).toBe('')
  })
  it('compares versions as numbers, not text', () => {
    expect(newerInFamily('gpt-5.9', ['gpt-5.9', 'gpt-5.10'])).toBe('gpt-5.10')
  })
})

describe('chatModels and newSince', () => {
  it('leaves out models that do not chat', () => {
    expect(
      chatModels(['gpt-5', 'text-embedding-3-large', 'whisper-1', 'gpt-image-1', 'tts-1', 'omni-moderation-latest']),
    ).toEqual(['gpt-5'])
  })
  it('the first look at an AI claims nothing is new', () => {
    expect(newSince(undefined, ['a', 'b'])).toEqual([])
  })
  it('afterwards, new is what was not there last time', () => {
    expect(newSince(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c'])
  })
})

describe('topCliChoice — the greatest model a subscription CLI offers', () => {
  it('points a lower curated alias at the top one', () => {
    expect(topCliChoice('claude-cli', 'opus')).toBe('fable')
    expect(topCliChoice('claude-cli', 'sonnet')).toBe('fable')
  })
  it('is silent when already there, on the CLI default, or on a hand-typed id', () => {
    expect(topCliChoice('claude-cli', 'fable')).toBe('')
    expect(topCliChoice('claude-cli', '')).toBe('')
    expect(topCliChoice('claude-cli', 'claude-opus-4-1')).toBe('')
  })
  it('is silent for a CLI with no curated list', () => {
    expect(topCliChoice('codex-cli', 'whatever')).toBe('')
  })
  it('is silent for a CLI whose runs are not passed a model', () => {
    // Only the Claude CLI's real runs carry `--model`; a "move" anywhere else
    // would change a setting nothing reads.
    expect(topCliChoice('gemini-cli', 'gemini-2.5-pro')).toBe('')
  })
})

function provider(patch: Partial<ProviderConfig> & { id: string }): ProviderConfig {
  return { name: patch.id, baseUrl: 'https://x', apiKey: 'k', enabled: true, primary: false, ...patch }
}

describe('planModelCheck', () => {
  const providers = [
    provider({ id: 'claude-cli', name: 'Claude Code', baseUrl: '', apiKey: '', primary: true, model: 'opus' }),
    provider({ id: 'local', name: 'Local', model: 'Qwen3.6-35B', baseUrl: 'http://localhost:8000' }),
    provider({ id: 'gemini', name: 'Gemini', model: 'gemini-2.5-flash' }),
    provider({ id: 'openai', name: 'OpenAI', model: 'gpt-5', enabled: false }),
  ]
  const listings = {
    local: ['Qwen3.6-35B', 'Qwen3.7-40B'],
    gemini: ['gemini-2.5-flash', 'gemini-3-flash', 'gemini-3-pro', 'gemini-embedding-001'],
    openai: ['gpt-5', 'gpt-5.1'],
  }

  it('the first check records what each AI offers and moves to the newest', () => {
    const plan = planModelCheck({ providers, catalog: {}, listings, now: 100, auto: true })
    expect(plan.catalog.gemini).toEqual({ models: listings.gemini, at: 100 })
    expect(plan.catalog.local).toEqual({ models: listings.local, at: 100 })
    // Nothing is called "new" on a first look.
    expect(plan.fresh).toEqual([])
    expect(plan.moves).toEqual([
      { providerId: 'claude-cli', name: 'Claude Code', from: 'opus', to: 'fable', why: 'greatest' },
      { providerId: 'gemini', name: 'Gemini', from: 'gemini-2.5-flash', to: 'gemini-3-flash', why: 'newer' },
    ])
  })

  it('an AI that is switched off is not looked at', () => {
    const plan = planModelCheck({ providers, catalog: {}, listings, now: 100, auto: true })
    expect(plan.catalog.openai).toBeUndefined()
    expect(plan.moves.some((m) => m.providerId === 'openai')).toBe(false)
  })

  it('the local AI is told about, never moved', () => {
    const plan = planModelCheck({
      providers,
      catalog: { local: { models: ['Qwen3.6-35B'], at: 1 } },
      listings,
      now: 100,
      auto: true,
    })
    expect(plan.fresh).toEqual([{ providerId: 'local', name: 'Local', models: ['Qwen3.7-40B'] }])
    expect(plan.moves.some((m) => m.providerId === 'local')).toBe(false)
  })

  it('a subscription CLI that is not the primary keeps its model', () => {
    const second = providers.map((p) =>
      p.id === 'claude-cli' ? { ...p, primary: false } : p.id === 'gemini' ? { ...p, primary: true } : p,
    )
    const plan = planModelCheck({ providers: second, catalog: {}, listings, now: 100, auto: true })
    expect(plan.moves.map((m) => m.providerId)).toEqual(['gemini'])
  })

  it('with moving switched off it still records and reports, and moves nothing', () => {
    const plan = planModelCheck({
      providers,
      catalog: { gemini: { models: ['gemini-2.5-flash'], at: 1 } },
      listings,
      now: 100,
      auto: false,
    })
    expect(plan.moves).toEqual([])
    expect(plan.fresh).toEqual([
      { providerId: 'gemini', name: 'Gemini', models: ['gemini-3-flash', 'gemini-3-pro'] },
    ])
  })

  it('an AI whose list could not be read keeps its last record', () => {
    const before = { gemini: { models: ['gemini-2.5-flash'], at: 1 } }
    const plan = planModelCheck({ providers, catalog: before, listings: { local: listings.local }, now: 100, auto: true })
    expect(plan.catalog.gemini).toEqual(before.gemini)
  })
})

describe('modelCheckLine — one line, or nothing', () => {
  it('says nothing when nothing changed', () => {
    expect(modelCheckLine({ at: 1, moves: [], fresh: [], skipped: [] })).toBe('')
  })
  it('names each move and each AI with new models', () => {
    expect(
      modelCheckLine({
        at: 1,
        moves: [{ providerId: 'claude-cli', name: 'Claude Code', from: 'opus', to: 'fable', why: 'greatest' }],
        fresh: [{ providerId: 'local', name: 'Local', models: ['a', 'b', 'c', 'd'] }],
        skipped: [],
      }),
    ).toBe('Claude Code now runs on fable (was opus) · new on Local: a, b, c +1 more')
  })
  it('says when a newer model was there but did not answer', () => {
    expect(
      modelCheckLine({
        at: 1,
        moves: [],
        fresh: [],
        skipped: [{ providerId: 'claude-cli', name: 'Claude Code', to: 'fable', reason: 'model not available on this plan' }],
      }),
    ).toBe('Claude Code stays as it is — fable did not answer (model not available on this plan)')
  })
})
