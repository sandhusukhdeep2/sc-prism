// SC Prism — the cinematic run stage (Task B5). Renders inside a project's
// detail view while its build is live: an agent orb "spawns" out of the
// floating Companion orb's corner for the active step, completed steps
// collapse into a row of dots, a glowing bar tracks stepIndex/plan.length,
// a narration strip reuses the EngineConsole span-tail pattern, and an
// awaiting run parks behind a circle-anchored Yes/No request card.
//
// Native-gated visuals only — no simulation fallback (a project never runs
// in the browser demo), so this stays silent whenever there is nothing real
// to show. All motion is transform/opacity keyframes (GPU-friendly) except
// the explicitly-requested glow pulses (box-shadow, matching the app's
// existing dockPulse/approvalPulse language) — every animation here has a
// `prefers-reduced-motion` static fallback (see ProjectRunStage.css).

import { useEffect, useRef } from 'react'
import { useApp, latestNotice } from '../store/AppStore'
import { useSettings } from '../lib/settings'
import { useSpanTail } from '../lib/engineConsole'
import { FAIL_GLYPH } from '../lib/glyphs'
import { isNative } from '../lib/nativeEngine'
import type { Project } from '../lib/projects'
import './ProjectRunStage.css'

export default function ProjectRunStage({ project }: { project: Project }) {
  const { state, answerProjectRequest } = useApp()
  const { settings } = useSettings()

  const running = project.status === 'running'
  const awaiting = project.status === 'awaiting'
  const { lines, seen, boxRef } = useSpanTail(settings.vaultPath, running)

  // Focus management for the awaiting-decision modal (aria-modal). When the gate
  // parks, move focus to its primary action; while open, Escape resolves it as
  // "No, park it" (the safe, nothing-runs choice); on close, focus returns to
  // whatever launched the run. answerProjectRequest is a stable memoized action.
  const yesRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!awaiting) return
    const trigger = document.activeElement as HTMLElement | null
    yesRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') answerProjectRequest(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (trigger && typeof trigger.focus === 'function') trigger.focus()
    }
  }, [awaiting, answerProjectRequest])

  const total = project.plan.length
  if (total === 0 || (!running && !awaiting)) return null

  const doneCount = Math.min(project.stepIndex, total)
  const displayIndex = Math.min(project.stepIndex, total - 1)
  const stepLabel = `step ${displayIndex + 1} of ${total} — ${project.plan[displayIndex]}`
  const pct = Math.round((doneCount / total) * 100)
  const request = latestNotice(state.notices, project.id, 'request')

  return (
    <div className="prs" aria-live="polite">
      <div className="prs__row">
        <div className="prs__dots">
          {project.plan.slice(0, doneCount).map((label, i) => (
            <span key={i} className="prs__dot prs__dot--pop" title={label} />
          ))}
          {running && (
            // Keyed by step + refine pass so a fresh spawn animation plays
            // for every new attempt, not just every new step.
            <span
              key={`${project.stepIndex}-${project.refinePass}`}
              className="prs__orb"
              aria-hidden="true"
            />
          )}
        </div>
        {project.refinePass > 0 && (
          <span className="prs__refine mono">refine pass {project.refinePass}</span>
        )}
      </div>

      <div className="prs__steplabel mono">{stepLabel}</div>

      <div className="prs__bar">
        <div
          className={'prs__barfill' + (running ? ' prs__barfill--live' : '')}
          style={{ width: `${pct}%` }}
        />
      </div>

      {isNative() && (lines.length > 0 || running) && (
        <div className="prs__console">
          <div className="prs__consolehead mono">
            <span className={'prs__consoledot' + (running ? ' prs__consoledot--live' : '')} />
            narration {running ? '· live' : `· last run (${seen} spans)`}
          </div>
          <div className="prs__consolebody mono" ref={boxRef}>
            {lines.map((l, i) => (
              <div
                key={i}
                className={'prs__consoleline' + (l.startsWith(FAIL_GLYPH) ? ' prs__consoleline--err' : '')}
              >
                {l}
              </div>
            ))}
            {running && (
              <div className="prs__consoleline prs__consoleline--wait">
                … working (narration appears as each phase completes)
              </div>
            )}
          </div>
        </div>
      )}

      {awaiting && (
        <div
          className="prs__overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Project run needs your decision"
        >
          <div className="prs__card">
            <span className="prs__cardorb" aria-hidden="true" />
            <div className="prs__cardtext">
              {request?.text ?? `«${project.name}» is stuck — try one more refine pass?`}
            </div>
            <div className="prs__cardbtns">
              <button
                ref={yesRef}
                type="button"
                className="prs__cardyes"
                onClick={() => answerProjectRequest(true)}
              >
                Yes, one more
              </button>
              <button type="button" className="prs__cardno" onClick={() => answerProjectRequest(false)}>
                No, park it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
