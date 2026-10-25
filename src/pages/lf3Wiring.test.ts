import { describe, expect, it } from 'vitest'
import skillsSrc from './Skills.tsx?raw'
import agentsSrc from './Agents.tsx?raw'

// Vite resolves `?raw` imports to the file's text (typed in src/raw-modules.d.ts).

// LF-3 page-wiring pin, updated by the 2026-08-09 honesty pass. The Skills page
// (underperforming gate + improve drawer's recentFailures) and the Agents page
// (per-skill helping signal) used to project over session verdicts UNION the
// loaded loop run's verdicts (`allVerdicts`). The loop simulator that produced
// that second stream is deleted, so `state.verdicts` — the session verdict log —
// is now the ONE real stream, and neither page may reach for the removed loop
// slice or the removed merge helper again.

const pages: Array<[string, string]> = [
  ['Skills.tsx', skillsSrc],
  ['Agents.tsx', agentsSrc],
]

describe('LF-3 page wiring reads the one real verdict stream', () => {
  for (const [name, src] of pages) {
    describe(name, () => {
      it('feeds the skill projection from state.verdicts', () => {
        expect(src).toMatch(/=\s*state\.verdicts\b/)
      })

      it('never reaches for the deleted loop slice or the deleted merge helper', () => {
        expect(src).not.toMatch(/state\.loop\b/)
        expect(src).not.toMatch(/allVerdicts\(/)
      })
    })
  }
})
