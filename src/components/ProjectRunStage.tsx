// ProjectRunStage — where a project's build stands, inside its Details: the
// steps already done as a row of dots, the step being worked ("step 2 of 3 —
// …") over a bar.
//
// It used to carry an orb and a live narration console as well (Task B5).
// Since 2026-11-14 the strip above the chat draws who is working and the
// Steps tab holds the log, so here a build is said ONCE: which step, how far.
// And a build parked on the user's answer is asked ONCE, in the Needs-you row
// above the chat — the pop-up card that asked it again here is gone, and with
// it a window-wide Escape key that quietly answered "No".
//
// Native-gated — a project never runs in the browser demo — so this stays
// silent whenever there is nothing real to show. Motion is transform/opacity
// with a `prefers-reduced-motion` static fallback (see ProjectRunStage.css).

import type { Project } from '../lib/projects'
import './ProjectRunStage.css'

export default function ProjectRunStage({ project }: { project: Project }) {
  const running = project.status === 'running'
  const awaiting = project.status === 'awaiting'

  const total = project.plan.length
  if (total === 0 || (!running && !awaiting)) return null

  const doneCount = Math.min(project.stepIndex, total)
  const displayIndex = Math.min(project.stepIndex, total - 1)
  const stepLabel = `step ${displayIndex + 1} of ${total} — ${project.plan[displayIndex]}`
  const pct = Math.round((doneCount / total) * 100)

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

    </div>
  )
}
