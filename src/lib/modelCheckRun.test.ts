// The runner around the model-check rules: it asks each AI, proves a tier move
// before making it, applies what stands, and remembers the day.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadModelCheck, runModelCheck, saveModelCheck } from './modelCheckRun'
import type { ProviderConfig } from './settings'

function provider(patch: Partial<ProviderConfig> & { id: string }): ProviderConfig {
  return { name: patch.id, baseUrl: 'https://x', apiKey: 'k', enabled: true, primary: false, ...patch }
}

const providers = [
  provider({ id: 'claude-cli', name: 'Claude Code', baseUrl: '', apiKey: '', primary: true, model: 'opus' }),
  provider({ id: 'local', name: 'Local', model: 'Qwen3.6-35B', baseUrl: 'http://localhost:8000' }),
  provider({ id: 'gemini', name: 'Gemini', model: 'gemini-2.5-flash' }),
]

function deps(over: Partial<Parameters<typeof runModelCheck>[0]> = {}) {
  return {
    providers,
    auto: true,
    now: 1000,
    list: vi.fn(async (p: ProviderConfig) =>
      p.id === 'gemini' ? ['gemini-2.5-flash', 'gemini-3-flash'] : ['Qwen3.6-35B'],
    ),
    probe: vi.fn(async () => ({ ok: true, error: '' })),
    apply: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('runModelCheck', () => {
  it('never asks a subscription CLI for a list — it has none', async () => {
    const list = vi.fn(async (_p: ProviderConfig) => ['a-model'])
    await runModelCheck(deps({ list }))
    expect(list.mock.calls.map(([p]) => p.id).sort()).toEqual(['gemini', 'local'])
  })

  it('moves the primary CLI to its top model only after that model answers', async () => {
    const d = deps()
    const result = await runModelCheck(d)
    expect(d.probe).toHaveBeenCalledWith('claude-cli', 'fable')
    expect(d.apply).toHaveBeenCalledWith('claude-cli', 'fable')
    expect(result.moves.map((m) => m.to)).toEqual(['fable', 'gemini-3-flash'])
    expect(result.skipped).toEqual([])
  })

  it('a top model that does not answer is not moved to, and the reason is kept', async () => {
    const d = deps({ probe: vi.fn(async () => ({ ok: false, error: 'model not available on this plan' })) })
    const result = await runModelCheck(d)
    expect(d.apply).not.toHaveBeenCalledWith('claude-cli', expect.anything())
    expect(result.moves.map((m) => m.providerId)).toEqual(['gemini'])
    expect(result.skipped).toEqual([
      { providerId: 'claude-cli', name: 'Claude Code', to: 'fable', reason: 'model not available on this plan' },
    ])
  })

  it('a newer version on a key is taken on the AI’s own listing, with no probe', async () => {
    const d = deps()
    await runModelCheck(d)
    expect(d.apply).toHaveBeenCalledWith('gemini', 'gemini-3-flash')
    expect(d.probe).not.toHaveBeenCalledWith('gemini', expect.anything())
  })

  it('one AI failing to list does not stop the others', async () => {
    const d = deps({
      list: vi.fn(async (p: ProviderConfig) => {
        if (p.id === 'local') throw new Error('connection refused')
        return ['gemini-2.5-flash', 'gemini-3-flash']
      }),
    })
    const result = await runModelCheck(d)
    expect(result.moves.some((m) => m.providerId === 'gemini')).toBe(true)
    expect(loadModelCheck().catalog.local).toBeUndefined()
  })

  it('remembers what it saw and when, so the same day is not checked twice', async () => {
    await runModelCheck(deps())
    const saved = loadModelCheck()
    expect(saved.last?.at).toBe(1000)
    expect(saved.catalog.gemini.models).toEqual(['gemini-2.5-flash', 'gemini-3-flash'])
  })

  it('the next day reports what is new since', async () => {
    saveModelCheck({ catalog: { local: { models: ['Qwen3.6-35B'], at: 1 } }, last: null })
    const d = deps({ list: vi.fn(async () => ['Qwen3.6-35B', 'Qwen3.7-40B']), providers: [providers[1]] })
    const result = await runModelCheck(d)
    expect(result.fresh).toEqual([{ providerId: 'local', name: 'Local', models: ['Qwen3.7-40B'] }])
    expect(d.apply).not.toHaveBeenCalled()
  })

  it('a damaged record is read as never checked', () => {
    localStorage.setItem('scprism.modelCheck', '{not json')
    expect(loadModelCheck()).toEqual({ catalog: {}, last: null })
  })
})
