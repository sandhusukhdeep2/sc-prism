// RunStage — the run, drawn to be WATCHED (2026-11-11).
//
// The owner: "Build in the form of animation… agent communicating to agent,
// show with the animation… user can see the animation most of the time", with
// the text and the terminal one step away. This is the animation-first view of
// the same facts the crew board draws: seats on an arc, a curved link for each
// handoff, packets travelling the link that is carrying work right now, and
// one sentence saying who is speaking.
//
// MOTION IS A CLAIM. A packet travels only where `stageModel` says work is in
// flight (a live run, the latest handoff, its receiver working). A finished
// run is a still picture. With reduced motion asked for, the live link is
// marked and nothing moves. This component derives nothing itself.
import { useMemo } from 'react'
import { STAGE_H, STAGE_W, stageModel } from '../lib/stageModel'
import { useNarrow } from '../lib/useNarrow'
import { shortAi } from './CrewBoard'
import type { EngineSpan } from '../lib/nativeEngine'
import './RunStage.css'

/** Three packets, evenly spaced along the 1.8 s trip. */
const PACKET_DELAYS = [0, 0.6, 1.2]

export default function RunStage({
  spans,
  live,
  onOpenAgent,
}: {
  /** The spans honestly attributable to the current run. */
  spans: EngineSpan[]
  /** Genuinely executing — a parked or finished run is not. */
  live: boolean
  /** A seat was opened: the page shows that agent's own record. */
  onOpenAgent?: (agent: string) => void
}) {
  const model = useMemo(() => stageModel(spans, live), [spans, live])
  const still = useNarrow('(prefers-reduced-motion: reduce)')
  if (model.seats.length === 0) return null
  return (
    <section
      className={'stage' + (live ? ' is-live' : '')}
      aria-label="The run, drawn"
      style={{ ['--n' as string]: model.seats.length }}
    >
      <div className="stage__canvas">
        <svg
          className="stage__links"
          viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {model.links.map((l) => (
            <g key={`${l.from}>${l.to}`}>
              <path
                className={'stage__link' + (l.live ? ' is-live' : '') + (l.back ? ' is-back' : '')}
                d={l.d}
                vectorEffect="non-scaling-stroke"
              />
              {l.live &&
                !still &&
                PACKET_DELAYS.map((delay) => (
                  <circle key={delay} className="stage__packet" r="6">
                    <animateMotion dur="1.8s" begin={`${delay}s`} repeatCount="indefinite" path={l.d} />
                  </circle>
                ))}
            </g>
          ))}
        </svg>
        {model.links
          .filter((l) => l.label)
          .map((l) => (
            <span
              key={`${l.from}>${l.to}`}
              className={'stage__linklabel' + (l.live ? ' is-live' : '')}
              style={{ left: `${l.lx}%`, top: `${l.ly}%` }}
            >
              {l.label}
            </span>
          ))}
        {model.seats.map((s, i) => (
          <button
            key={s.name}
            type="button"
            className={
              'stage__seat' +
              (s.running ? ' is-running' : '') +
              (s.state.kind === 'no-answer' ? ' is-no' : '') +
              (s.local ? ' is-local' : '')
            }
            style={{ left: `${s.x}%`, top: `${s.y}%`, ['--tint' as string]: s.tint, ['--i' as string]: i }}
            aria-label={`What ${s.name} is doing`}
            onClick={() => onOpenAgent?.(s.name)}
          >
            <span className="stage__ring" aria-hidden="true">
              {s.state.kind === 'no-answer' ? '✕' : s.letter}
            </span>
            <span className="stage__name">{s.name}</span>
            <span className="stage__ai mono" title={s.ai}>
              {shortAi(s.ai)}
            </span>
            {s.state.kind !== 'idle' && (
              <span className="stage__state" title={s.state.cause}>
                {s.state.text}
              </span>
            )}
            {s.state.tokens > 0 && (
              <span className="stage__tokens mono">{s.state.tokens.toLocaleString()} tokens</span>
            )}
          </button>
        ))}
      </div>
      {model.caption && (
        <p className="stage__caption" role="status">
          <b>{model.caption.who}</b>
          <span className="stage__captionai mono">{model.caption.ai}</span>
          <span className="stage__captiontext">{model.caption.text}</span>
        </p>
      )}
    </section>
  )
}
