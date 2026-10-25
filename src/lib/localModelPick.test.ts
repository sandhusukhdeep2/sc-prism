import { describe, expect, it } from 'vitest'
import type { LocalModelRow, LocalServerStatus, ModelQuality, ModelSpeed } from './localModels'
import { buildKindPicks, pickForKind, WORK_KINDS } from './localModelPick'

// The best local model FOR EACH KIND OF WORK (2026-08-29).
//
// The measured rows (2026-08-17) tell him what each model IS — this helper
// tells him what each model is FOR. Retrieval and research live on turnaround,
// so they weigh speed; the implementer and reviewer are judged on their output,
// so they weigh the Tier-2 score; chat wants both. Same honesty rules as the
// rows the picks are built from: an unmeasured model is never ranked or
// suggested, no vendor claims, and every reason cites the real numbers.
//
// And the 2026-08-28 lesson: his server holds ONE big model resident. Seats
// bound to gemma errored with the server refusing once Qwen was resident —
// a per-kind mix that needs two models that cannot co-load is a plan for that
// exact failure, so it is called out and collapsed to one compromise.

const FAST = 'gemma-4-26b-a4b-it-4bit'
const STRONG = 'Qwen3.8-27B-4bit'
const UNRUN = 'glm-4.5-air-6bit'

const speed = (tokensPerSec: number | null, p50Ms: number, samples: number): ModelSpeed => ({
  samples,
  p50Ms,
  p90Ms: p50Ms,
  tokensPerSec,
})
const quality = (mean: number, runsCount: number): ModelQuality => ({ mean, runs: runsCount })

function row(id: string, over: Partial<LocalModelRow> = {}): LocalModelRow {
  const s = over.speed ?? null
  const q = over.quality ?? null
  return {
    id,
    measured: s !== null || q !== null,
    ranked: s !== null || q !== null,
    speed: s,
    quality: q,
    sizeGb: null,
    loadEstimateSec: null,
    fit: 'unknown',
    fitLine: '',
    suggestion: '',
    ...over,
  }
}

// The real machine's shape: gemma is fast and decent, Qwen is slow and strong.
const fast = () => row(FAST, { speed: speed(28.6, 9_800, 12), quality: quality(0.6, 1), sizeGb: 15.2, fit: 'fits' })
const strong = () => row(STRONG, { speed: speed(2.6, 115_000, 14), quality: quality(0.81, 14), sizeGb: 21.36, fit: 'fits' })
const unrun = () => row(UNRUN, { sizeGb: 42.36, fit: 'wont-load' })

describe('pickForKind — the weighting per kind, every reason citing real numbers', () => {
  const rows = [strong(), fast(), unrun()]

  it('weighs SPEED for retrieval and research — the measured tok/s, named', () => {
    for (const kind of ['retrieval', 'research'] as const) {
      const p = pickForKind(rows, kind)!
      expect(p.id).toBe(FAST)
      expect(p.reason).toContain('fastest measured here')
      expect(p.reason).toContain('29 tok/s over 12 runs')
    }
  })

  it('weighs QUALITY for the implementer and reviewer — the judged mean, named', () => {
    for (const kind of ['implementer', 'reviewer'] as const) {
      const p = pickForKind(rows, kind)!
      expect(p.id).toBe(STRONG)
      expect(p.reason).toContain('highest judged quality')
      expect(p.reason).toContain('0.81 over 14 runs')
    }
  })

  it('balances BOTH for chat, and the reason cites both measurements', () => {
    // gemma: fastest by far, judged 0.60. Qwen: 12x slower, judged 0.81.
    // Balanced on measured ratios, gemma wins — and the line says both numbers,
    // not a composite nobody can check.
    const p = pickForKind(rows, 'chat')!
    expect(p.id).toBe(FAST)
    expect(p.reason).toContain('balance')
    expect(p.reason).toContain('29 tok/s over 12 runs')
    expect(p.reason).toContain('0.60')
  })

  it('never suggests an unmeasured model, however large its promise', () => {
    for (const kind of WORK_KINDS) {
      expect(pickForKind([unrun()], kind)).toBeNull()
      expect(pickForKind([strong(), fast(), unrun()], kind)!.id).not.toBe(UNRUN)
    }
  })

  it('never suggests a model the server says cannot load right now', () => {
    // gemma leads every speed metric — but the server's own arithmetic says it
    // won't fit today, so retrieval falls back to the model that CAN answer.
    const blocked = [row(FAST, { speed: speed(28.6, 9_800, 12), fit: 'wont-load' }), strong()]
    const p = pickForKind(blocked, 'retrieval')!
    expect(p.id).toBe(STRONG)
    expect(p.reason).toContain('the only measured model that can load right now')
    // And when NOTHING measured can load, there is no pick at all.
    expect(pickForKind([row(FAST, { speed: speed(28.6, 9_800, 12), fit: 'wont-load' })], 'retrieval')).toBeNull()
  })

  it('says when a speed-weighted kind had no speed to weigh, and shows what it used', () => {
    const judgedOnly = [
      row(FAST, { quality: quality(0.5, 2) }),
      row(STRONG, { quality: quality(0.7, 3) }),
    ]
    const p = pickForKind(judgedOnly, 'retrieval')!
    expect(p.id).toBe(STRONG)
    expect(p.reason).toContain('no speed recorded yet')
    expect(p.reason).toContain('highest judged quality (0.70 over 3 runs)')
  })

  it('says when a quality-weighted kind had no judged runs, and shows what it used', () => {
    const timedOnly = [
      row(FAST, { speed: speed(28.6, 9_800, 12) }),
      row(STRONG, { speed: speed(2.6, 115_000, 14) }),
    ]
    const p = pickForKind(timedOnly, 'implementer')!
    expect(p.id).toBe(FAST)
    expect(p.reason).toContain('no judged runs yet')
    expect(p.reason).toContain('fastest measured here')
  })

  it('chat with no model measured on both falls back to the judged one, saying so', () => {
    const split = [
      row(FAST, { speed: speed(28.6, 9_800, 12) }),
      row(STRONG, { quality: quality(0.7, 3) }),
    ]
    const p = pickForKind(split, 'chat')!
    expect(p.id).toBe(STRONG)
    expect(p.reason).toContain('judged')
    expect(p.reason).toContain('0.70 over 3 runs')
  })

  it('one measured model is "the only", never "the best"', () => {
    const p = pickForKind([fast(), unrun()], 'reviewer')!
    expect(p.id).toBe(FAST)
    expect(p.reason).toContain('the only model with runs recorded here')
    expect(p.reason).not.toContain('highest')
    expect(p.reason).not.toContain('fastest')
  })

  it('breaks a tied metric toward the model with more evidence behind it', () => {
    const tied = [
      row(FAST, { quality: quality(0.8, 3) }),
      row(STRONG, { quality: quality(0.8, 14) }),
    ]
    const p = pickForKind(tied, 'reviewer')!
    expect(p.id).toBe(STRONG)
    expect(p.reason).toContain('0.80 over 14 runs')
  })
})

describe('buildKindPicks — the whole board, and the one-resident-model truth', () => {
  // The real server report of 2026-08-28: a 24.96 GB ceiling that holds EITHER
  // gemma (15.2 GB) or Qwen (21.36 GB), never both.
  const oneAtATime: LocalServerStatus = {
    ceilingGb: 24.96,
    residentGb: 0,
    loadSecondsPerGb: 1.6,
    sizeGb: { [FAST]: 15.2, [STRONG]: 21.36, [UNRUN]: 42.36 },
    resident: [],
  }
  const roomy: LocalServerStatus = { ...oneAtATime, ceilingGb: 48 }

  it('answers every kind, in the board order, when evidence exists', () => {
    const r = buildKindPicks([strong(), fast(), unrun()], roomy)
    expect(r.picks.map((p) => p.kind)).toEqual([...WORK_KINDS])
    expect(r.picks.find((p) => p.kind === 'retrieval')!.id).toBe(FAST)
    expect(r.picks.find((p) => p.kind === 'implementer')!.id).toBe(STRONG)
  })

  it('picks nothing at all when nothing is measured', () => {
    const r = buildKindPicks([unrun(), row(FAST, { sizeGb: 15.2 })], oneAtATime)
    expect(r.picks).toEqual([])
    expect(r.memoryNote).toBe('')
  })

  it('calls out a mix the server cannot hold, with the server\'s own figures, and collapses it', () => {
    // Independently, speed kinds want gemma and quality kinds want Qwen — the
    // exact split that errored live on 2026-08-28 once Qwen was resident.
    const r = buildKindPicks([strong(), fast(), unrun()], oneAtATime)
    expect(r.memoryNote).toContain('15 GB')
    expect(r.memoryNote).toContain('21 GB')
    expect(r.memoryNote).toContain('25 GB ceiling')
    expect(r.memoryNote).toContain("the server's own figures")
    expect(r.memoryNote).toContain('one model at a time')
    // Every kind now names the SAME model — the balanced compromise.
    for (const p of r.picks) expect(p.id).toBe(FAST)
    // A kind whose own pick was displaced says it is a compromise; a kind that
    // already wanted this model keeps its own sharper reason.
    expect(r.picks.find((p) => p.kind === 'implementer')!.reason).toContain('compromise')
    expect(r.picks.find((p) => p.kind === 'retrieval')!.reason).toContain('fastest measured here')
    expect(r.picks.find((p) => p.kind === 'retrieval')!.reason).not.toContain('compromise')
  })

  it('lets a split stand when the server\'s figures say both fit together', () => {
    const r = buildKindPicks([strong(), fast(), unrun()], roomy)
    expect(r.memoryNote).toBe('')
    expect(new Set(r.picks.map((p) => p.id)).size).toBe(2)
  })

  it('claims nothing about memory it was never told', () => {
    // No status at all — and rows without sizes: either way, no co-load claim.
    const noStatus = buildKindPicks([strong(), fast()], null)
    expect(noStatus.memoryNote).toBe('')
    expect(new Set(noStatus.picks.map((p) => p.id)).size).toBe(2)
    const noSizes = buildKindPicks(
      [row(STRONG, { quality: quality(0.81, 14) }), row(FAST, { speed: speed(28.6, 9_800, 12) })],
      { ...oneAtATime, sizeGb: {} },
    )
    expect(noSizes.memoryNote).toBe('')
  })
})
