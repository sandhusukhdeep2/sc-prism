import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import VerdictCard, { toVerdictView, type Verdict as VerdictView } from './VerdictCard'
import type { Verdict } from '../engine/types'

/**
 * The app learns to say ATTENTION (owed follow-up #1 to dc4124e).
 *
 * The engine already records a three-valued `Verdict.outcome`: a run whose
 * deterministic Tier-1 gate genuinely EXECUTED the project's checks over real
 * written files and PASSED, while the Tier-2 LLM reviewer dissented on score,
 * is `attention` — "the checks passed, the reviewer wasn't satisfied". It is
 * not a pass (the strict `passed` flag stays false, so project.py's git
 * checkpoint and the training rewards it gates do not loosen) and it is not the
 * flat failure it used to be recorded as. The card is where a user meets that
 * distinction, so these lock in:
 *
 *   • three visually distinct head states,
 *   • the engine's own `outcomeReason` sentence shown verbatim,
 *   • a verdict predating the field rendering EXACTLY as it always did,
 *   • a recorded judge contradiction said out loud instead of left in JSON.
 */

// The real shape of the run this fix came from: a Node CLI, 6 files, `npm test`
// green, judge 0.5 against a 0.7 threshold.
function engineVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    taskId: 'A-1042',
    task: 'build the todo CLI',
    route: {
      target: 'cloud',
      model: 'claude-opus',
      via: 'via Bifrost',
      reason: 'reasoning load',
      routeLabel: 'internal → cloud · claude-opus',
    },
    tier1: { tests: '11/11', lint: true, build: true, pass: true },
    tier2: { evalScore: 0.5, passed: false, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
    tokensIn: 1200,
    tokensOut: 380,
    cost: 0.012,
    durationMs: 4200,
    modelRoute: '1,200 tok in / 380 out',
    hooks: { blocked: 0, passed: true },
    writeback: { path: 'verdicts/A-1042.json', validated: false, committed: false },
    passed: false,
    ...over,
  }
}

const ATTENTION_REASON =
  'tests passed, reviewer dissented — the deterministic tier-1 gate ran `npm test` against 6 written file(s) and PASSED, ' +
  'but the tier-2 reviewer scored 0.5 below its 0.7 threshold. This run is NOT a failure: the work exists and its ' +
  'checks pass. It needs a look, not a redo.'

function renderCard(v: VerdictView) {
  // VerdictCard is a react-router <Link>, so it needs a Router in context.
  return render(
    <MemoryRouter>
      <VerdictCard v={v} />
    </MemoryRouter>,
  )
}

describe('VerdictCard — the three outcome states are visually distinct', () => {
  it('PASSED: the gold pass pill, and nothing about attention', () => {
    const v = engineVerdict({
      passed: true,
      outcome: 'passed',
      tier2: { evalScore: 0.91, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
    })
    const { container } = renderCard(toVerdictView(v))
    const badge = container.querySelector('.verdict__badge')
    expect(badge?.textContent).toBe('✓ PASSED')
    expect(badge?.className).not.toMatch(/attention/)
    expect(screen.queryByText(/NEEDS A LOOK/)).not.toBeInTheDocument()
  })

  it('ATTENTION: its own amber pill that reads as neither a pass nor a failure', () => {
    const v = engineVerdict({ outcome: 'attention', outcomeReason: ATTENTION_REASON })
    const { container } = renderCard(toVerdictView(v))
    const badge = container.querySelector('.verdict__badge')
    expect(badge?.textContent).toBe('⚠ NEEDS A LOOK')
    // A distinct modifier class — the styling hook that makes it amber rather
    // than the gold achievement pill.
    expect(badge?.className).toMatch(/verdict__badge--attention/)
    // And it never claims a pass.
    expect(screen.queryByText('✓ PASSED')).not.toBeInTheDocument()
  })

  it('FAILED: no pass pill and no attention pill', () => {
    const v = engineVerdict({ outcome: 'failed', outcomeReason: 'tier-1 failed; no files were produced' })
    const { container } = renderCard(toVerdictView(v))
    expect(container.querySelector('.verdict__badge')).toBeNull()
    expect(screen.queryByText(/NEEDS A LOOK/)).not.toBeInTheDocument()
    expect(screen.queryByText(/PASSED/)).not.toBeInTheDocument()
  })

  // A chat turn the judge cleared (engine outcome 'replied', mode 'converse').
  // Its `passed` is TRUE — but the gold pill would dress a conversation up as
  // verified work, and no pill at all would render a success the way every
  // failure renders. A quiet neutral pill of its own.
  it('REPLIED: a quiet neutral pill — not the gold pass, not a warning', () => {
    const v = engineVerdict({
      passed: true,
      outcome: 'replied',
      outcomeReason: 'the reply cleared the judge at 0.82 (threshold 0.7).',
      tier2: { evalScore: 0.82, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
    })
    const { container } = renderCard(toVerdictView(v))
    const badge = container.querySelector('.verdict__badge')
    expect(badge?.textContent).toBe('REPLIED')
    expect(badge?.className).toMatch(/verdict__badge--replied/)
    expect(badge?.className).not.toMatch(/attention/)
    expect(screen.queryByText('✓ PASSED')).not.toBeInTheDocument()
    expect(screen.queryByText(/NEEDS A LOOK/)).not.toBeInTheDocument()
  })

  it('the four states produce four different head renderings', () => {
    const head = (v: Verdict) => {
      const { container, unmount } = renderCard(toVerdictView(v))
      const text = container.querySelector('.verdict__head')?.textContent ?? ''
      unmount()
      return text
    }
    const passed = head(engineVerdict({ passed: true, outcome: 'passed' }))
    const replied = head(engineVerdict({ passed: true, outcome: 'replied' }))
    const attention = head(engineVerdict({ outcome: 'attention' }))
    const failed = head(engineVerdict({ outcome: 'failed' }))
    expect(new Set([passed, replied, attention, failed]).size).toBe(4)
  })
})

describe('VerdictCard — the engine gets to explain itself', () => {
  it('shows the REAL outcomeReason sentence, verbatim', () => {
    const v = engineVerdict({ outcome: 'attention', outcomeReason: ATTENTION_REASON })
    renderCard(toVerdictView(v))
    expect(screen.getByText(ATTENTION_REASON)).toBeInTheDocument()
    // Including the part that matters most to a user: this is not a redo.
    expect(screen.getByText(/It needs a look, not a redo\./)).toBeInTheDocument()
  })

  it('does not print an outcome note when the engine wrote none', () => {
    const { container } = renderCard(toVerdictView(engineVerdict({ outcome: 'attention' })))
    expect(container.querySelector('.verdict__why')).toBeNull()
  })

  it('an ATTENTION run does not have its Tier-1 line drawn as a short-circuit', () => {
    // The old mapper fed the OVERALL pass into the Tier-1 line, so a run whose
    // tests genuinely went green rendered "✕ tests 11/11 · short-circuited".
    const view = toVerdictView(engineVerdict({ outcome: 'attention' }))
    expect(view.tier1).toContain('✓ tests 11/11')
    expect(view.tier1).not.toContain('short-circuited')
  })

  it('an ATTENTION run does not claim Tier 2 was skipped — it ran and dissented', () => {
    const view = toVerdictView(engineVerdict({ outcome: 'attention' }))
    expect(view.tier2).toContain('the reviewer dissented')
    expect(view.tier2).toContain('0.50')
    expect(view.tier2).not.toContain('skipped')
  })
})

describe('VerdictCard — a recorded judge contradiction is surfaced, not buried', () => {
  const claim =
    'judge called the artifact "truncated / no implementation" over 6 file(s) on disk behind a passing tier-1 gate'

  it('says so on the card, with what it means for the score', () => {
    const v = engineVerdict({
      outcome: 'attention',
      outcomeReason: ATTENTION_REASON,
      tier2: {
        evalScore: 0.5,
        passed: false,
        judge: 'DeepEval judge',
        trajectory: 'trajectory ok',
        contradictions: [claim],
      },
    })
    renderCard(toVerdictView(v))
    expect(screen.getByText(new RegExp('judge contradiction'))).toBeInTheDocument()
    expect(screen.getByText(new RegExp(escapeRe(claim)))).toBeInTheDocument()
    expect(screen.getByText(/score is unreliable for this run/)).toBeInTheDocument()
  })

  it('says nothing at all when none were recorded (never a clean bill of health)', () => {
    const { container } = renderCard(toVerdictView(engineVerdict({ outcome: 'attention' })))
    expect(container.querySelector('.verdict__contradiction')).toBeNull()
    expect(screen.queryByText(/contradiction/i)).not.toBeInTheDocument()
  })
})

describe('VerdictCard — an OLD verdict is never back-filled with a guess', () => {
  it('a non-passing verdict with NO `outcome` renders exactly as it did before', () => {
    // Byte-for-byte the same head as the pre-change renderer produced: no badge.
    const legacy = engineVerdict({ passed: false })
    expect(legacy.outcome).toBeUndefined()
    const { container } = renderCard(toVerdictView(legacy))
    expect(container.querySelector('.verdict__badge')).toBeNull()
    expect(container.querySelector('.verdict__why')).toBeNull()
    expect(container.querySelector('.verdict__contradiction')).toBeNull()
    expect(screen.queryByText(/NEEDS A LOOK/)).not.toBeInTheDocument()
  })

  it('a legacy non-pass keeps the old Tier-1/Tier-2 lines too (no silent re-reading)', () => {
    const view = toVerdictView(engineVerdict({ passed: false }))
    expect(view.tier1).toContain('short-circuited')
    expect(view.tier2).toBe('— skipped (Tier 1 failed)')
    expect(view.outcome).toBeUndefined()
    expect(view.outcomeReason).toBeUndefined()
  })

  it('a legacy PASSING verdict still shows the gold pill', () => {
    const legacy = engineVerdict({
      passed: true,
      tier2: { evalScore: 0.91, passed: true, judge: 'DeepEval judge', trajectory: 'trajectory ok' },
    })
    const { container } = renderCard(toVerdictView(legacy))
    expect(container.querySelector('.verdict__badge')?.textContent).toBe('✓ PASSED')
    expect(container.querySelector('.verdict__badge')?.className).not.toMatch(/attention/)
  })

  it('the static demo view (no `passed` field at all) is unchanged', () => {
    const demo: VerdictView = {
      task: 'add a rate-limit guard to the uploader',
      route: 'internal → local',
      model: 'qwen2.5-coder',
      tier1: '14/14 · lint ok · build ok',
      tier2: 'eval 0.91 · DeepEval judge',
      hooks: '0 blocked',
      cost: '$0.004',
      writeback: 'notes/uploader.md',
    }
    const { container } = renderCard(demo)
    expect(container.querySelector('.verdict__badge')?.textContent).toBe('✓ PASSED')
  })
})

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
