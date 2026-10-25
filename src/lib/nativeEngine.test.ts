import { describe, expect, it } from 'vitest'
import {
  expandUserPath,
  formatAdoptResult,
  formatLearnResult,
  isNative,
  parseLearnReport,
  pickFile,
  readAdoptedRouter,
  readMcpServers,
  readTextFile,
  revealPath,
  routeReasonLabel,
  runNativeLearn,
  runNativeLearnApply,
  runNativeMcpList,
  runNativeProject,
  runNativeProjectFinish,
  runNativeProjectMerge,
  runNativeTask,
  runNativeTeam,
  runNativeVerify,
  writeMcpServers,
} from './nativeEngine'
import type { EngineProviders, LearnReport, TeamBoardMsg, TeamResult } from './nativeEngine'

const providersFixture: EngineProviders = { baseUrl: '', apiKey: '' }

// Under jsdom there is no Tauri shell, so `window.__TAURI_INTERNALS__` is absent.
// mapVerdict and defaultVaultDir are not exercised here: the former is not
// exported, and the latter needs the native path bridge. We only assert the
// browser-safe fallbacks that are reachable through the public exports.
describe('nativeEngine (browser / jsdom context)', () => {
  it('isNative() is false without __TAURI_INTERNALS__', () => {
    expect('__TAURI_INTERNALS__' in window).toBe(false)
    expect(isNative()).toBe(false)
  })

  it('runNativeTask resolves to null when not native', async () => {
    const verdict = await runNativeTask('add a rate-limit guard', '~/sc-vault')
    expect(verdict).toBeNull()
  })

  it('revealPath is a no-op when not native (no invoke, no throw)', async () => {
    await expect(revealPath('/Users/me/SC Projects/demo')).resolves.toBeUndefined()
  })

  it('pickFile resolves to null when not native', async () => {
    await expect(pickFile()).resolves.toBeNull()
  })

  it('readTextFile resolves to null when not native', async () => {
    await expect(readTextFile('/Users/me/notes.md')).resolves.toBeNull()
  })

  it('runNativeProject resolves to null when not native', async () => {
    const verdict = await runNativeProject('x', '/p', '/v', providersFixture)
    expect(verdict).toBeNull()
  })

  it('runNativeProject resolves to null when not native (existing-mode opts)', async () => {
    const verdict = await runNativeProject('x', '/p', '/v', providersFixture, {
      existingMode: true,
      slug: 'my-slug',
      neverTouch: ['secrets', 'secrets/**'],
    })
    expect(verdict).toBeNull()
  })

  it('runNativeProject resolves to null when not native (runBranch resume opt)', async () => {
    const verdict = await runNativeProject('x', '/p', '/v', providersFixture, {
      existingMode: true,
      slug: 'my-slug',
      runBranch: 'scprism/my-slug-1',
    })
    expect(verdict).toBeNull()
  })

  it('runNativeProjectMerge resolves to null when not native', async () => {
    const result = await runNativeProjectMerge('/p', 'scprism/my-slug-1', 'main')
    expect(result).toBeNull()
  })

  it('runNativeProjectFinish resolves to null when not native', async () => {
    const result = await runNativeProjectFinish('/p', 'main')
    expect(result).toBeNull()
  })

  it('runNativeVerify resolves to null when not native', async () => {
    const verdict = await runNativeVerify('/p', 'npm test', '~/sc-vault', providersFixture)
    expect(verdict).toBeNull()
  })

  it('runNativeTeam resolves to null when not native', async () => {
    const result = await runNativeTeam(
      'draft a launch plan',
      '~/sc-vault',
      providersFixture,
      'lead:local,researcher:local',
      1,
      5000,
    )
    expect(result).toBeNull()
  })

  it('runNativeLearn resolves to null when not native', async () => {
    const report = await runNativeLearn('~/sc-vault')
    expect(report).toBeNull()
  })

  it('readMcpServers resolves to [] when not native', async () => {
    const servers = await readMcpServers('~/sc-vault')
    expect(servers).toEqual([])
  })

  it('writeMcpServers resolves to false when not native', async () => {
    const ok = await writeMcpServers('~/sc-vault', [{ name: 'filesystem', command: ['npx', '-y', 'server'] }])
    expect(ok).toBe(false)
  })

  it('runNativeMcpList resolves to an honest error when not native', async () => {
    const result = await runNativeMcpList('~/sc-vault', 'filesystem')
    expect(result).toEqual({ ok: false, error: 'the installed app is required to test MCP servers' })
  })
})

// P3-2: parseLearnReport is the pure raw-JSON -> LearnReport mapping used by
// runNativeLearn after JSON.parse. Fixtures below are captured from a REAL
// `python -m scprism_engine train --vault <v> --dry-run` run against a vault
// with 117 accumulated training records (see task-P3-2-brief.md).
describe('parseLearnReport (defensive parse of the real train --dry-run shape)', () => {
  it('maps a real DISCARD report, pulling lift/regressions from gate (not reward_lift)', () => {
    const raw = {
      vault: '/Users/me/sc-vault',
      records: 117,
      dry_run: true,
      trained: true,
      metrics: { records: 117, groups: 4, epochs: 60, lr: 0.5 },
      reward_before: 0.98356828,
      reward_after: 0.98706334,
      reward_lift: 0.00349506,
      gate: {
        promote: false,
        decision: 'DISCARD',
        lift: -0.375,
        min_lift: 0.0,
        baseline_mean: 0.5,
        candidate_mean: 0.125,
        per_golden: [
          { golden_id: 'add-rate-limit-guard', baseline: 0.5, candidate: 0.0, delta: -0.5, regressed: true },
          { golden_id: 'refactor-auth-module', baseline: 0.5, candidate: 0.5, delta: 0.0, regressed: false },
        ],
        regressions: ['add-rate-limit-guard', 'summarize-config', 'tight-envelope-runaway'],
        reason: 'DISCARD: no lift (-0.375000 <= 0.0)',
      },
      promoted: false,
      decision: 'DISCARD',
      reason: 'DISCARD: no lift (-0.375000 <= 0.0)',
      current_version: null,
    }
    const report = parseLearnReport(raw)
    expect(report).toEqual({
      decision: 'DISCARD',
      promoted: false,
      reason: 'DISCARD: no lift (-0.375000 <= 0.0)',
      lift: -0.375, // from gate.lift, NOT reward_lift (0.00349506)
      regressions: ['add-rate-limit-guard', 'summarize-config', 'tight-envelope-runaway'],
      recordCount: 117,
    })
  })

  it('maps a PROMOTE report (no regressions, positive gate lift)', () => {
    const raw = {
      records: 200,
      gate: { promote: true, decision: 'PROMOTE', lift: 0.12, regressions: [], reason: 'PROMOTE: lift 0.12 > 0.0' },
      promoted: true,
      decision: 'PROMOTE',
      reason: 'PROMOTE: lift 0.12 > 0.0',
      current_version: 3,
    }
    const report = parseLearnReport(raw)
    expect(report).toEqual({
      decision: 'PROMOTE',
      promoted: true,
      reason: 'PROMOTE: lift 0.12 > 0.0',
      lift: 0.12,
      regressions: [],
      recordCount: 200,
    })
  })

  it('returns null for malformed input: not an object', () => {
    expect(parseLearnReport('DISCARD')).toBeNull()
    expect(parseLearnReport(null)).toBeNull()
    expect(parseLearnReport(undefined)).toBeNull()
    expect(parseLearnReport(42)).toBeNull()
  })

  it('returns null when decision is missing or not a string', () => {
    expect(parseLearnReport({})).toBeNull()
    expect(parseLearnReport({ decision: 1, promoted: false })).toBeNull()
  })

  it('falls back to gate.reason and omits optional fields when gate is absent', () => {
    const report = parseLearnReport({ decision: 'DISCARD', promoted: false })
    expect(report).toEqual({
      decision: 'DISCARD',
      promoted: false,
      reason: '',
      lift: undefined,
      regressions: undefined,
      recordCount: undefined,
    })
  })

  it('coerces a truthy non-boolean promoted and uses gate.reason when top-level reason is absent', () => {
    const report = parseLearnReport({
      decision: 'PROMOTE',
      promoted: 1,
      gate: { reason: 'gate says go', lift: 0.5, regressions: ['x'] },
    })
    expect(report).toEqual({
      decision: 'PROMOTE',
      promoted: true,
      reason: 'gate says go',
      lift: 0.5,
      regressions: ['x'],
      recordCount: undefined,
    })
  })
})

// P3-3: formatLearnResult is the pure, testable core of the "Run learning
// step" panel — the exact honest one-liner shown for every state, so the
// copy can never drift into "the model learns/retrains itself" territory.
// It ALWAYS frames the result as ROUTE SELECTION (which model handles a
// task), never LLM weight fine-tuning, and never fabricates a decision.
describe('formatLearnResult (honest copy for the "Run learning step" panel)', () => {
  it('DISCARD: keeps the current router, honestly, with the gate lift number', () => {
    const report: LearnReport = {
      decision: 'DISCARD',
      promoted: false,
      reason: 'DISCARD: no lift (-0.375000 <= 0.0)',
      lift: -0.375,
      regressions: ['add-rate-limit-guard'],
      recordCount: 117,
    }
    expect(formatLearnResult(report, 117)).toBe(
      "Kept the current router — the newly trained one didn't beat the goldens (lift -0.375).",
    )
  })

  it('PROMOTE: frames it as route selection, dry-run only, never applied', () => {
    const report: LearnReport = {
      decision: 'PROMOTE',
      promoted: true,
      reason: 'PROMOTE: lift 0.12 > 0.0',
      lift: 0.12,
      regressions: [],
      recordCount: 200,
    }
    expect(formatLearnResult(report, 200)).toBe(
      'The new router would improve routing (lift 0.12) — dry run, not applied.',
    )
  })

  it('null report (run failed / non-native / malformed): honest error, never fabricated', () => {
    expect(formatLearnResult(null, 117)).toBe("Couldn't run the learning step — try again.")
  })

  it('no records yet: honest message, and a stray non-null report is never fabricated into a decision', () => {
    expect(formatLearnResult(null, 0)).toBe('Not enough training records yet — run some tasks first.')
    const report: LearnReport = { decision: 'PROMOTE', promoted: true, reason: 'x', lift: 0.5 }
    expect(formatLearnResult(report, 0)).toBe('Not enough training records yet — run some tasks first.')
  })

  it('missing lift falls back honestly instead of fabricating a number', () => {
    const report: LearnReport = { decision: 'DISCARD', promoted: false, reason: '' }
    expect(formatLearnResult(report, 10)).toBe(
      "Kept the current router — the newly trained one didn't beat the goldens (lift unknown).",
    )
  })

  it('never claims the model itself learns/retrains — copy stays route-selection framed', () => {
    const discard = formatLearnResult(
      { decision: 'DISCARD', promoted: false, reason: '', lift: -0.1 },
      50,
    )
    const promote = formatLearnResult(
      { decision: 'PROMOTE', promoted: true, reason: '', lift: 0.1 },
      50,
    )
    for (const s of [discard, promote, formatLearnResult(null, 0), formatLearnResult(null, 5)]) {
      expect(s.toLowerCase()).not.toContain('the model')
      expect(s.toLowerCase()).not.toContain('retrain')
      expect(s.toLowerCase()).not.toContain('fine-tun')
      expect(s.toLowerCase()).not.toContain('itself')
    }
  })
})

// LF-2: formatAdoptResult is the pure copy for the human-gated "Adopt this
// router" (non-dry-run) result. A PROMOTE here is a REAL persisted adoption
// (the golden gate approved it); a DISCARD wrote nothing. It stays framed as
// ROUTE SELECTION, never model learning.
describe('formatAdoptResult (honest copy for "Adopt this router")', () => {
  // R1: the adopted router only GOVERNS the default lane in Auto-route mode, so
  // the copy must be scoped to the mode — never an unconditional "live router".
  it('PROMOTE in Auto-route: reports it now governs the default lane (live)', () => {
    const s = formatAdoptResult({ decision: 'PROMOTE', promoted: true, reason: '', lift: 0.1 }, true)
    expect(s).toBe(
      'Adopted — the trained router beat the goldens and now governs your default routing lane (Auto-route is on).',
    )
  })

  it('PROMOTE while pinned: says the router applies in Auto-route mode, primary still wins', () => {
    const s = formatAdoptResult({ decision: 'PROMOTE', promoted: true, reason: '', lift: 0.1 }, false)
    expect(s).toBe(
      'Adopted — the trained router beat the goldens. It governs the default lane in Auto-route mode; while a provider is pinned, your primary still answers.',
    )
    // The false "live router for route selection" claim must be gone (R1).
    expect(s).not.toContain('the live router')
    // Default arg (no mode passed) is the safe pinned copy, never the live claim.
    expect(formatAdoptResult({ decision: 'PROMOTE', promoted: true, reason: '' })).toBe(s)
  })

  it('DISCARD: nothing adopted, the current router stays live', () => {
    const s = formatAdoptResult({ decision: 'DISCARD', promoted: false, reason: '', lift: -0.1 })
    expect(s).toBe(
      "Not adopted — the newly trained router didn't beat the goldens, so the current router stays live.",
    )
  })

  // LF-fix G: a NOOP (cold vault / no records) never reached the golden gate, so
  // it must NOT be reported as "didn't beat the goldens" (a DISCARD). Distinct,
  // honest copy that says nothing was trained.
  it('NOOP: reports nothing to adopt (no records), not a gate failure', () => {
    const s = formatAdoptResult({ decision: 'NOOP', promoted: false, reason: 'cold vault' })
    expect(s).toBe(
      'Nothing to adopt yet — no training records, so no router was trained (run some tasks first).',
    )
    // Reverting the NOOP branch would show the DISCARD copy — this pins it.
    expect(s).not.toContain("didn't beat the goldens")
  })

  it('null report: honest error, never a fabricated adoption', () => {
    expect(formatAdoptResult(null)).toBe("Couldn't adopt the router — try again.")
  })

  it('never claims the model itself learns/retrains/fine-tunes', () => {
    const strings = [
      formatAdoptResult({ decision: 'PROMOTE', promoted: true, reason: '' }),
      formatAdoptResult({ decision: 'DISCARD', promoted: false, reason: '' }),
      formatAdoptResult(null),
    ]
    for (const s of strings) {
      expect(s.toLowerCase()).not.toContain('the model')
      expect(s.toLowerCase()).not.toContain('retrain')
      expect(s.toLowerCase()).not.toContain('fine-tun')
    }
  })
})

// LF-fix E: routeReasonLabel derives the verdict card's route line from the
// engine's REAL RouteDecision.reason instead of fabricating "heavy reasoning"
// for every cloud run. A learned-policy reason is surfaced verbatim; the
// built-in branches map to their established copy; explicit-primary is named
// honestly; no reason at all falls back to the built-in labels.
describe('routeReasonLabel (honest route label from the real reason)', () => {
  it('surfaces a learned-policy CLOUD route verbatim (no fabricated "heavy reasoning")', () => {
    const reason = "learned route policy v3: bucket 'docs' -> cloud (p=0.61)"
    const s = routeReasonLabel(true, [reason])
    expect(s).toBe(reason)
    expect(s).not.toContain('heavy reasoning')
  })

  it('surfaces a learned-policy LOCAL route verbatim', () => {
    const reason = "learned route policy v5: bucket 'test-gen' -> local (p=0.72)"
    expect(routeReasonLabel(false, [reason])).toBe(reason)
  })

  it('names an explicit-primary cloud route honestly, NOT as heavy reasoning', () => {
    const s = routeReasonLabel(true, ['default -> primary (claude) per user selection'])
    expect(s).toBe('routed to your chosen primary')
    expect(s).not.toContain('heavy reasoning')
  })

  it('keeps the established copy for a reasoning-keyword cloud route', () => {
    const s = routeReasonLabel(true, ["reasoning keyword 'design' -> cloud"])
    expect(s).toBe('heavy reasoning — routed to your primary')
  })

  it('names a sensitive local route honestly (zero egress)', () => {
    const s = routeReasonLabel(false, ["sensitive keyword 'token' -> keep local (no egress)"])
    expect(s).toBe('kept local — sensitive data stays on your machine (zero egress)')
  })

  // R2: heavy reasoning with no usable cloud stays LOCAL — the card must NOT
  // claim "routed to your primary" (the primary was bypassed / never used).
  it('names a heavy-reasoning-with-no-cloud route as kept local, never "routed to your primary"', () => {
    const s = routeReasonLabel(false, ['heavy reasoning, but no cloud configured -> local'])
    expect(s).toBe('heavy reasoning — kept local (no cloud configured)')
    expect(s).not.toContain('routed to your primary')
  })

  it('falls back to built-in labels when no reason was carried (older verdict)', () => {
    expect(routeReasonLabel(false, [])).toBe('kept local — cheap inference, zero egress')
    expect(routeReasonLabel(true, [])).toBe('heavy reasoning — routed to your primary')
  })
})

// LF-2: readAdoptedRouter and runNativeLearnApply short-circuit safely without
// a native shell (jsdom) — no throw, honest null. The parse is exercised via
// the LearningPanel component test (which mocks the read_vault_file bridge).
describe('LF-2 adopt bridges (browser / jsdom — no native shell)', () => {
  it('readAdoptedRouter resolves to null without the native file bridge', async () => {
    expect(await readAdoptedRouter('~/sc-vault')).toBeNull()
  })

  it('runNativeLearnApply resolves to null when not native', async () => {
    expect(isNative()).toBe(false)
    expect(await runNativeLearnApply('~/sc-vault')).toBeNull()
  })
})

// TG-3/TG-5: TeamResult gained governance fields (passed/overBudget/
// tokenBudget/reason/taskId/spansPath/verdictPath) mapped defensively from
// the engine's snake_case JSON, the same idiom as `mapVerdict` (which isn't
// exported either — see the
// comment above). `runNativeTeam` short-circuits to null under jsdom (no
// native bridge), so its raw -> TeamResult mapping can't be exercised through
// the public function directly; this proves the SAME defensive expressions
// (`!!raw.passed`, `Number(raw.token_budget ?? 0)`, `String(raw.reason ?? '')`,
// etc.) against a loosely-typed fixture, and that the result satisfies the
// `TeamResult` type.
describe('TeamResult governance fields (defensive mapping fixture)', () => {
  it('coerces a loosely-typed raw payload into a well-typed TeamResult', () => {
    const raw: Record<string, unknown> = {
      run_id: 'task-123',
      board: [] as TeamBoardMsg[],
      synthesis: 'final answer',
      board_path: '/vault/agents/board-task-123.jsonl',
      tokens: 160,
      passed: 1, // truthy, non-boolean — `!!raw.passed` must coerce to true
      // `over_budget` intentionally absent — must default falsy, not throw.
      token_budget: 5000,
      reason: undefined, // must default to '', not "undefined"
      task_id: 'task-123',
      spans_path: '/vault/spans.jsonl',
      // `verdict_path` intentionally absent — must default to '', not throw.
    }
    const mapped: TeamResult = {
      run_id: raw.run_id as string,
      board: raw.board as TeamBoardMsg[],
      synthesis: String(raw.synthesis ?? ''),
      board_path: String(raw.board_path ?? ''),
      tokens: Number(raw.tokens ?? 0),
      passed: !!raw.passed,
      overBudget: !!raw.over_budget,
      tokenBudget: Number(raw.token_budget ?? 0),
      reason: String(raw.reason ?? ''),
      taskId: String(raw.task_id ?? ''),
      spansPath: String(raw.spans_path ?? ''),
      verdictPath: String(raw.verdict_path ?? ''),
    }
    expect(mapped.passed).toBe(true)
    expect(mapped.overBudget).toBe(false)
    expect(mapped.tokenBudget).toBe(5000)
    expect(mapped.reason).toBe('')
    expect(mapped.taskId).toBe('task-123')
    expect(mapped.spansPath).toBe('/vault/spans.jsonl')
    expect(mapped.verdictPath).toBe('')
  })

  it('carries a real verdict_path through when the engine provides one', () => {
    const raw: Record<string, unknown> = {
      run_id: 'task-456',
      board: [] as TeamBoardMsg[],
      synthesis: 'final answer',
      board_path: '/vault/agents/board-task-456.jsonl',
      tokens: 90,
      passed: true,
      over_budget: false,
      token_budget: 100000,
      reason: 'ok',
      task_id: 'task-456',
      spans_path: '/vault/spans.jsonl',
      verdict_path: '/vault/verdicts/task-456.json',
    }
    const mapped: TeamResult = {
      run_id: raw.run_id as string,
      board: raw.board as TeamBoardMsg[],
      synthesis: String(raw.synthesis ?? ''),
      board_path: String(raw.board_path ?? ''),
      tokens: Number(raw.tokens ?? 0),
      passed: !!raw.passed,
      overBudget: !!raw.over_budget,
      tokenBudget: Number(raw.token_budget ?? 0),
      reason: String(raw.reason ?? ''),
      taskId: String(raw.task_id ?? ''),
      spansPath: String(raw.spans_path ?? ''),
      verdictPath: String(raw.verdict_path ?? ''),
    }
    expect(mapped.verdictPath).toBe('/vault/verdicts/task-456.json')
  })
})

describe('expandUserPath (pure branches without Tauri)', () => {
  it('returns empty string for paths starting with ~ but not ~ or ~/', async () => {
    const result = await expandUserPath('~foo/x')
    expect(result).toBe('')
  })

  it('returns empty string for ~name pattern', async () => {
    const result = await expandUserPath('~user/documents')
    expect(result).toBe('')
  })

  it('returns absolute path unchanged', async () => {
    const result = await expandUserPath('/absolute/path')
    expect(result).toBe('/absolute/path')
  })

  it('returns relative path unchanged', async () => {
    const result = await expandUserPath('relative/path')
    expect(result).toBe('relative/path')
  })

  it('trims whitespace', async () => {
    const result = await expandUserPath('  /absolute/path  ')
    expect(result).toBe('/absolute/path')
  })
})
