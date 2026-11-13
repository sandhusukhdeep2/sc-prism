// RunStrip — this room's run, in one slim band above the chat (2026-11-14).
//
// The owner, on the old Stage: "very complicated… repetitive information is a
// lot", and of the animation in it: "that I like". So the animation stays and
// everything around it goes. The strip says the three things a run has to
// say, once each:
//   1. what is running, and for how long;
//   2. who is on it — the seats on one line, with packets travelling the
//      handoff that is carrying work right now;
//   3. who is speaking, on which AI, and what it is doing.
// Nothing else on the page restates any of them (spec: 2026-11-14 "The chat is
// the room").
//
// MOTION IS A CLAIM, exactly as on the stage: packets travel only where
// `stageModel` says work is in flight; a parked run neither pulses nor speaks;
// with reduced motion asked for the live link is marked and nothing moves.
// The strip derives nothing itself.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { STRIP_H, packetRadii, stageModel } from '../lib/stageModel'
import { elapsedLabel, kindLabel, runRoom, type LiveRun } from '../lib/liveRuns'
import { useNarrow } from '../lib/useNarrow'
import { useNow } from '../lib/useNow'
import type { EngineSpan } from '../lib/nativeEngine'
import './RunStrip.css'

/** Three packets, evenly spaced along the 1.6 s trip. */
const PACKET_DELAYS = [0, 0.53, 1.06]

export default function RunStrip({
  runs,
  spans,
  live,
  elsewhere,
  roomName,
  onOpenRoom,
  onOpenAgent,
  fullViewHref,
  now: fixedNow,
}: {
  /** THIS room's runs — executing or parked on the user. */
  runs: readonly LiveRun[]
  /** The spans honestly attributable to this room's run ([] when they cannot
   *  be told apart — then no crew is drawn). */
  spans: EngineSpan[]
  /** This room has a run genuinely executing. */
  live: boolean
  /** What is executing in OTHER rooms (the engine takes one job at a time). */
  elsewhere: readonly LiveRun[]
  /** A room's name, for "Busy in …". */
  roomName: (room: string) => string
  onOpenRoom?: (room: string) => void
  /** A seat was opened: the page shows that agent's own record. */
  onOpenAgent?: (agent: string) => void
  /** Where the same run is drawn full window (the Live page). */
  fullViewHref?: string
  /** Injected wall clock (tests). Omitted → a 1 s tick while anything runs. */
  now?: number
}) {
  const now = useNow(runs.length > 0 || elsewhere.length > 0, fixedNow)
  const model = useMemo(() => stageModel(spans, live, 'row'), [spans, live])
  const still = useNarrow('(prefers-reduced-motion: reduce)')
  // The links are drawn in a 1000 × 100 box stretched to the track, so the
  // track is measured and a packet's radii are set per axis to stay round.
  const trackRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const drawn = runs.length > 0 && model.seats.length > 0
  useEffect(() => {
    const el = trackRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setBox((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [drawn])
  const packet = packetRadii(box.w, box.h, STRIP_H)
  // Every engine executing right now, wherever it belongs.
  const atOnce = runs.filter((r) => !r.paused).length + elsewhere.length

  if (runs.length === 0) {
    // Not this room's run to draw — but a message sent from here would wait
    // for it, so the room says where the engine is, in one line.
    const first = elsewhere[0]
    if (!first) return null
    const room = runRoom(first)
    const name = roomName(room)
    return (
      <section className="strip strip--elsewhere" aria-label="The engine is busy in another room">
        <span className="strip__dot" aria-hidden="true" />
        <span className="strip__busy">
          Busy in {name} — {first.intent}
          {elsewhere.length > 1 ? ` (+${elsewhere.length - 1} more)` : ''}
        </span>
        <span className="strip__elapsed mono">{elapsedLabel(first.startedAt, now)}</span>
        {onOpenRoom && (
          <button type="button" className="strip__go" aria-label={`Go to ${name}`} onClick={() => onOpenRoom(room)}>
            Go there
          </button>
        )}
      </section>
    )
  }

  return (
    <section className={'strip' + (live ? ' is-live' : '')} aria-label="This room’s run">
      <div className="strip__runs">
        {runs.map((r, i) => (
          <div key={r.id} className="strip__run">
            <span className={`strip__kind strip__kind--${r.kind}`}>{kindLabel(r.kind)}</span>
            <span className="strip__intent" title={r.intent}>
              {r.intent}
            </span>
            {r.paused && <span className="strip__waiting">waiting on you</span>}
            <span className="strip__elapsed mono">{elapsedLabel(r.startedAt, now)}</span>
            {fullViewHref && live && i === 0 && (
              <Link
                to={fullViewHref}
                className="strip__full"
                aria-label="Watch this run full window"
                title="Watch this run full window"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                  <path d="M14 4.5h5.5V10M19.5 4.5l-6.2 6.2M10 19.5H4.5V14M4.5 19.5l6.2-6.2" />
                </svg>
              </Link>
            )}
          </div>
        ))}
      </div>
      {drawn && (
        <div className="strip__track" ref={trackRef} style={{ ['--n' as string]: model.seats.length }}>
          <svg className="strip__links" viewBox={`0 0 1000 ${STRIP_H}`} preserveAspectRatio="none" aria-hidden="true">
            {model.links.map((l) => (
              <g key={`${l.from}>${l.to}`}>
                <path
                  className={'strip__link' + (l.live ? ' is-live' : '') + (l.back ? ' is-back' : '')}
                  d={l.d}
                  vectorEffect="non-scaling-stroke"
                />
                {l.live &&
                  !still &&
                  PACKET_DELAYS.map((delay) => (
                    <ellipse key={delay} className="strip__packet" rx={packet.rx} ry={packet.ry}>
                      <animateMotion dur="1.6s" begin={`${delay}s`} repeatCount="indefinite" path={l.d} />
                    </ellipse>
                  ))}
              </g>
            ))}
          </svg>
          {model.seats.map((s, i) => (
            <button
              key={s.name}
              type="button"
              className={
                'strip__seat' +
                (s.running ? ' is-running' : '') +
                (s.state.kind === 'no-answer' ? ' is-no' : '') +
                (s.local ? ' is-local' : '')
              }
              style={{ left: `${s.x}%`, ['--tint' as string]: s.tint, ['--i' as string]: i }}
              aria-label={`What ${s.name} is doing`}
              title={`${s.ai}${s.state.kind !== 'idle' ? ` — ${s.state.text}` : ''}`}
              onClick={() => onOpenAgent?.(s.name)}
            >
              <span className="strip__ring" aria-hidden="true">
                {s.state.kind === 'no-answer' ? '✕' : s.letter}
              </span>
              <span className="strip__name">{s.name}</span>
            </button>
          ))}
        </div>
      )}
      {live && !drawn && (
        // No crew to draw, and it says which reason: a second engine at work
        // (here or in another room) means no step can be pinned on this run;
        // otherwise the run simply has not reported its first step.
        <p className="strip__caption" role="status">
          <span className="strip__captiontext">
            {atOnce > 1
              ? `${atOnce} runs at once — their steps can’t be told apart, so no crew is drawn`
              : 'working — no engine step reported yet'}
          </span>
        </p>
      )}
      {live && drawn && model.caption && (
        <p className="strip__caption" role="status">
          <b>{model.caption.who}</b>
          <span className="strip__captionai mono">{model.caption.ai}</span>
          <span className="strip__captiontext">{model.caption.text}</span>
        </p>
      )}
    </section>
  )
}
