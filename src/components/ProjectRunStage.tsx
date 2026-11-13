// ProjectRunStage — where a project's build stands, inside its Details: the
// steps already done as a row of dots, the step being worked ("step 2 of 3 —
// …") over a bar, and, when the build parks on the user, the Yes/No card.
//
// It used to carry an orb and a live narration console as well (Task B5).
// Since 2026-11-14 the strip above the chat draws who is working and the
// Steps tab holds the log, so here a build is said ONCE: which step, how far.
//
// Native-gated — a project never runs in the browser demo — so this stays
// silent whenever there is nothing real to show. Motion is transform/opacity
// with a `prefers-reduced-motion` static fallback (see ProjectRunStage.css).

import { useEffect, useRef } from 'react'
import { useApp, latestNotice } from '../store/AppStore'
import type { Project } from '../lib/projects'
import './ProjectRunStage.css'

export default function ProjectRunStage({ project }: { project: Project }) {
  const { state, answerProjectRequest } = useApp()

  const running = project.status === 'running'
  const awaiting = project.status === 'awaiting'

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
