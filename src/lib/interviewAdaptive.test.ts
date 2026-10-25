import { describe, it, expect, vi } from 'vitest'
import {
  ADAPTIVE_MAX,
  ADAPTIVE_TOKEN_BUDGET,
  STANDARD_FALLBACK_MARKER,
  buildAdaptiveQuestionPrompt,
  generateAdaptiveQuestion,
  nextAdaptiveStep,
  sanitizeGeneratedQuestion,
  scriptedFallbackDisplay,
  type AdaptiveAnswers,
  type AdaptiveQuestionDeps,
} from './interviewAdaptive'
import type { EngineProviders } from './nativeEngine'

const providers: EngineProviders = { baseUrl: 'http://localhost:1234/v1', apiKey: 'k' }

const ctx: AdaptiveAnswers = {
  business: 'Logistics business — freight, fleet operations and compliance.',
  companyName: 'Northwind Supply',
  qa: [
    { q: 'Which systems hold your freight data today?', a: 'MYOB and a custom TMS spreadsheet' },
    { q: 'Who handles compliance paperwork?', a: 'I do it myself every Friday' },
  ],
}

interface Harness {
  deps: AdaptiveQuestionDeps
  runTask: ReturnType<typeof vi.fn>
}

function makeDeps(over: Partial<AdaptiveQuestionDeps> = {}): Harness {
  const runTask = vi.fn()
  const deps: AdaptiveQuestionDeps = {
    runTask,
    isRealCompletion: (s): s is string =>
      typeof s === 'string' && !s.startsWith('[offline:') && !s.startsWith('[stub:'),
    modelMeta: () => ({ model: 'anthropic · claude-x', isLocal: false }),
    ...over,
  }
  return { deps, runTask }
}

describe('buildAdaptiveQuestionPrompt', () => {
  it('carries the goal, the seed answers, and every prior Q&A', () => {
    const p = buildAdaptiveQuestionPrompt(ctx)
    expect(p).toContain('Business description: Logistics business — freight')
    expect(p).toContain('Company: Northwind Supply')
    // Prior answers so far — both pairs, question and answer.
    expect(p).toContain('Q: Which systems hold your freight data today?')
    expect(p).toContain('A: MYOB and a custom TMS spreadsheet')
    expect(p).toContain('A: I do it myself every Friday')
    // The exact one-question ask from the spec.
    expect(p).toContain(
      'Ask the ONE next most useful question for setting up their AI workbench; reply with ONLY the question text, one sentence.',
    )
  })

  it('omits the answers-so-far section on the first generation', () => {
    const p = buildAdaptiveQuestionPrompt({ ...ctx, qa: [] })
    expect(p).not.toContain('Answers so far:')
    expect(p).toContain('Business description:')
  })
})

describe('sanitizeGeneratedQuestion', () => {
  it('keeps a clean one-line question as-is', () => {
    expect(sanitizeGeneratedQuestion('What slows your team down most each week?')).toBe(
      'What slows your team down most each week?',
    )
  })

  it('strips wrapping quotes and chatty prefixes', () => {
    expect(sanitizeGeneratedQuestion('"Question: What tools do you pay for today?"')).toBe(
      'What tools do you pay for today?',
    )
    expect(sanitizeGeneratedQuestion('1. “Who approves invoices?”')).toBe('Who approves invoices?')
  })

  it('rejects empty and multi-line replies (fallback territory)', () => {
    expect(sanitizeGeneratedQuestion('')).toBeNull()
    expect(sanitizeGeneratedQuestion('   \n  \n')).toBeNull()
    expect(
      sanitizeGeneratedQuestion('Sure! Here is my question:\nWhat is your biggest bottleneck?'),
    ).toBeNull()
  })

  it('caps a runaway sentence at ~200 chars', () => {
    const long = `Why ${'really '.repeat(60)}long?`
    const out = sanitizeGeneratedQuestion(long)
    expect(out).not.toBeNull()
    expect((out as string).length).toBeLessThanOrEqual(200)
    expect(out).toMatch(/…$/)
  })
})

describe('scriptedFallbackDisplay', () => {
  it('appends the EXACT honest marker to a scripted question', () => {
    expect(STANDARD_FALLBACK_MARKER).toBe('(standard question — no live model)')
    expect(scriptedFallbackDisplay('Which departments does the company have?')).toBe(
      'Which departments does the company have? (standard question — no live model)',
    )
  })
})

describe('nextAdaptiveStep', () => {
  it('caps the adaptive phase at 5 generated questions', () => {
    expect(ADAPTIVE_MAX).toBe(5)
    expect(nextAdaptiveStep(ADAPTIVE_MAX, true, true)).toEqual({ kind: 'scripted', marked: false })
    expect(nextAdaptiveStep(ADAPTIVE_MAX + 1, true, true)).toEqual({
      kind: 'scripted',
      marked: false,
    })
    expect(nextAdaptiveStep(ADAPTIVE_MAX - 1, true, true)).toEqual({ kind: 'generate' })
    expect(nextAdaptiveStep(0, true, true)).toEqual({ kind: 'generate' })
  })

  it('goes scripted WITH the marker when there is no live model to generate', () => {
    expect(nextAdaptiveStep(0, false, true)).toEqual({ kind: 'scripted', marked: true })
    expect(nextAdaptiveStep(0, true, false)).toEqual({ kind: 'scripted', marked: true })
  })
})

describe('generateAdaptiveQuestion', () => {
  it('runs ONE governed task whose prompt carries the prior answers, with tokenBudget 4000', async () => {
    const { deps, runTask } = makeDeps()
    runTask.mockResolvedValue({ response: 'What would you automate first if it just worked?' })

    const out = await generateAdaptiveQuestion('/vault', providers, ctx, deps)

    expect(runTask).toHaveBeenCalledTimes(1)
    const args = runTask.mock.calls[0]
    expect(args[0]).toContain('A: MYOB and a custom TMS spreadsheet') // prior answers ride the prompt
    expect(args[1]).toBe('/vault')
    expect(args[2]).toBe(providers)
    expect(args[6]).toBe(4_000) // the run's hard token cap (--token-budget)
    expect(args[6]).toBe(ADAPTIVE_TOKEN_BUDGET)
    expect(out).toEqual({
      q: 'What would you automate first if it just worked?',
      model: 'anthropic · claude-x',
      isLocal: false,
    })
  })

  it('stub reply → null (the caller falls back to a marked scripted question)', async () => {
    const { deps, runTask } = makeDeps()
    runTask.mockResolvedValue({ response: '[stub: no provider configured]' })
    expect(await generateAdaptiveQuestion('/vault', providers, ctx, deps)).toBeNull()
  })

  it('engine error (null) and unusable multi-line replies → null', async () => {
    const { deps, runTask } = makeDeps()
    runTask.mockResolvedValue(null)
    expect(await generateAdaptiveQuestion('/vault', providers, ctx, deps)).toBeNull()

    runTask.mockResolvedValue({ response: 'Q1?\nQ2?' })
    expect(await generateAdaptiveQuestion('/vault', providers, ctx, deps)).toBeNull()
  })

  it('timeout → null (the interview never blocks on a provider)', async () => {
    const { deps, runTask } = makeDeps({ timeoutMs: 10 })
    runTask.mockReturnValue(new Promise(() => {})) // provider never answers
    expect(await generateAdaptiveQuestion('/vault', providers, ctx, deps)).toBeNull()
  })

  it('no model meta → attribution stays empty, never fabricated', async () => {
    const { deps, runTask } = makeDeps({ modelMeta: () => null })
    runTask.mockResolvedValue({ response: 'Who are your top three clients?' })
    expect(await generateAdaptiveQuestion('/vault', providers, ctx, deps)).toEqual({
      q: 'Who are your top three clients?',
      model: '',
      isLocal: false,
    })
  })

  it('local-route meta is carried through (🔒 honesty)', async () => {
    const { deps, runTask } = makeDeps({
      modelMeta: () => ({ model: 'local · qwen2.5-coder', isLocal: true }),
    })
    runTask.mockResolvedValue({ response: 'Which records must never leave this machine?' })
    const out = await generateAdaptiveQuestion('/vault', providers, ctx, deps)
    expect(out?.model).toBe('local · qwen2.5-coder')
    expect(out?.isLocal).toBe(true)
  })
})
