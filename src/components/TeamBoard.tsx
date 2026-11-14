// TeamBoard — the room's team, at the top of the room (2026-11-14).
//
// The owner, of the mockup that draws this: "perfect example what I want".
// Every seat this room would put on a job stands here whether or not anything
// is running: a ring, the seat's name, the AI it runs on, and — once it has
// taken a turn — what it is doing and its tokens. A run is drawn ON the team:
// the seat at work breathes, and the handoff in flight carries packets (the
// animation he asked to keep).
//
// It also says the three things the slim strip said, once each: what is
// running and for how long (with Stop), and — for a room with no run of its
// own — where the engine is busy.
//
// MOTION IS A CLAIM: a ring breathes and packets travel only where
// `teamBoard` says work is in flight; a parked run moves nothing; with
// reduced motion asked for the live link is marked and nothing travels. The
// component derives nothing itself.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BOARD_H, BOARD_W, teamBoard, type RosterSeat } from '../lib/teamBoard'
import { elapsedLabel, kindLabel, runRoom, type LiveRun } from '../lib/liveRuns'
import { useNarrow } from '../lib/useNarrow'
import { shortAi } from './CrewBoard'
import { useNow } from '../lib/useNow'
import type { EngineSpan } from '../lib/nativeEngine'
import './TeamBoard.css'

/** Three packets, evenly spaced along the 1.6 s trip. */
const PACKET_DELAYS = [0, 0.53, 1.06]
/** How big a packet looks on screen, in CSS pixels (its radius). */
const PACKET_PX = 4.5
/** The longest handoff label the board prints (see where it is used). */
const HANDOFF_LABEL_MAX = 24

function Lock() {
  return (
    <svg className="board__lock" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

export default function TeamBoard({
  roster,
  runs,
  spans,
  live,
  answering = false,
  elsewhere,
  roomName,
  onOpenRoom,
  onOpenAgent,
  onStop,
  fullViewHref,
  engines,
  now: fixedNow,
}: {
  /** The seats this room would put on a job, in the roster's order. */
  roster: readonly RosterSeat[]
  /** THIS room's runs — executing or parked on the user (one AI answering a
   *  message is not one of them: see `answering`). */
  runs: readonly LiveRun[]
  /** The spans honestly attributable to this room's run ([] when they cannot
   *  be told apart — then no seat is lit). */
  spans: EngineSpan[]
  /** This room has a run genuinely executing. */
  live: boolean
  /** One AI is answering a message in this room. */
  answering?: boolean
  /** What is executing in OTHER rooms (the engine takes one job at a time). */
  elsewhere: readonly LiveRun[]
  /** A room's name, for "Busy in …". */
  roomName: (room: string) => string
  onOpenRoom?: (room: string) => void
  /** A seat with a record was opened: the page shows that agent's own record. */
  onOpenAgent?: (agent: string) => void
  /** How many engines are executing in all, when the room knows of one this
   *  board is not told about. Default: counted from `runs` and `elsewhere`. */
  engines?: number
  /** Stop a run (offered only for `run.stoppable` runs that are executing). */
  onStop?: (run: LiveRun) => void
  /** Where the same run is drawn full window (the Live page). */
  fullViewHref?: string
  /** Injected wall clock (tests). Omitted → a 1 s tick while anything runs. */
  now?: number
}) {
  const now = useNow(runs.length > 0 || elsewhere.length > 0, fixedNow)
  const model = useMemo(
    () => teamBoard({ roster, spans, live, answering }),
    [roster, spans, live, answering],
  )
  const still = useNarrow('(prefers-reduced-motion: reduce)')
  // The links are drawn in a 1000 × 100 box stretched over the rings, so the
  // band is measured and a packet's radii are set per axis to stay round.
  const bandRef = useRef<SVGSVGElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const drawn = model.seats.length > 0
  useEffect(() => {
    const el = bandRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setBox((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [drawn])
  const packet =
    box.w > 0 && box.h > 0
      ? { rx: (PACKET_PX * BOARD_W) / box.w, ry: (PACKET_PX * BOARD_H) / box.h }
      : { rx: 6, ry: 6 }
  // The runs Stop has been pressed for — said as "Stopping…" until the run
  // itself leaves the board. Asked once.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  // Every engine executing right now, wherever it belongs.
  const atOnce = engines ?? runs.filter((r) => !r.paused).length + elsewhere.length
  const busy = runs.length === 0 ? elsewhere[0] : undefined

  if (!drawn && runs.length === 0 && !busy) return null

  // A run of this room is executing and no seat can be lit for it — and it
  // says which reason: a second engine at work (here or in another room)
  // means no step can be pinned on this run; otherwise the run simply has not
  // reported its first step.
  // (A seat lit only because one AI is answering a message is not a step of
  // this run, so it does not count.)
  const unlit = live && runs.some((r) => !r.paused) && model.worked === 0
  const nameOf = (key: string) => model.seats.find((s) => s.key === key)?.name ?? key

  return (
    <section className={'board' + (live ? ' is-live' : '')} aria-label="Team board — this room’s team">
      {runs.length > 0 && (
        <div className="board__runs">
          {runs.map((r, i) => (
            <div key={r.id} className="board__run">
              <span className={`board__kind board__kind--${r.kind}`}>{kindLabel(r.kind)}</span>
              <span className="board__intent" title={r.intent}>
                {r.intent}
              </span>
              {r.paused && <span className="board__waiting">waiting on you</span>}
              <span className="board__elapsed mono">{elapsedLabel(r.startedAt, now)}</span>
              {onStop && r.stoppable && !r.paused && (
                <button
                  type="button"
                  className="board__stop"
                  disabled={stopping.has(r.id)}
                  aria-label={stopping.has(r.id) ? 'Stopping this run' : 'Stop this run'}
                  onClick={() => {
                    if (stopping.has(r.id)) return
                    setStopping((prev) => new Set(prev).add(r.id))
                    onStop(r)
                  }}
                >
                  {stopping.has(r.id) ? 'Stopping…' : 'Stop'}
                </button>
              )}
              {fullViewHref && live && i === 0 && (
                <Link
                  to={fullViewHref}
                  className="board__full"
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
      )}
      {busy && (
        // Not this room's run to draw — but a message sent from here would
        // wait for it, so the room says where the engine is, in one line.
        <div className="board__elsewhere">
          <span className="board__dot" aria-hidden="true" />
          <span className="board__busy">
            Busy in {roomName(runRoom(busy))} — {busy.intent}
            {elsewhere.length > 1 ? ` (+${elsewhere.length - 1} more)` : ''}
          </span>
          <span className="board__elapsed mono">{elapsedLabel(busy.startedAt, now)}</span>
          {onOpenRoom && (
            <button
              type="button"
              className="board__go"
              aria-label={`Go to ${roomName(runRoom(busy))}`}
              onClick={() => onOpenRoom(runRoom(busy))}
            >
              Go there
            </button>
          )}
        </div>
      )}
      {unlit && (
        <p className="board__note" role="status">
          {atOnce > 1
            ? `${atOnce} runs at once — their steps can’t be told apart, so no seat is lit`
            : 'working — no engine step reported yet'}
        </p>
      )}
      {drawn && (
        <div className="board__track" style={{ ['--n' as string]: model.seats.length }}>
          <svg
            ref={bandRef}
            className="board__links"
            viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {model.links.map((l) => (
              <g key={`${l.from}>${l.to}`}>
                <path
                  className={'board__link' + (l.live ? ' is-live' : '') + (l.back ? ' is-back' : '')}
                  d={l.d}
                  vectorEffect="non-scaling-stroke"
                />
                {l.live &&
                  !still &&
                  PACKET_DELAYS.map((delay) => (
                    <ellipse key={delay} className="board__packet" rx={packet.rx} ry={packet.ry}>
                      <animateMotion dur="1.6s" begin={`${delay}s`} repeatCount="indefinite" path={l.d} />
                    </ellipse>
                  ))}
              </g>
            ))}
          </svg>
          {/* A stage is a word or two ("round 1", "synthesis"). A build hands
              over with its whole step as the label; a sentence across the
              rings is not a stage name, and the run line and the chat already
              say which step this is — so it is not printed here. */}
          {model.links
            .filter((l) => l.latest && l.label && l.label.length <= HANDOFF_LABEL_MAX)
            .map((l) => (
              <span
                key={`${l.from}>${l.to}`}
                className={'board__handoff' + (l.d.includes('Q') ? ' is-arc' : '') + (l.back ? ' is-back' : '')}
                style={{ left: `${l.lx}%` }}
                role="img"
                aria-label={`${nameOf(l.from)} handed to ${nameOf(l.to)}: ${l.label}`}
                title={l.label}
              >
                {l.label}
              </span>
            ))}
          {model.seats.map((s, i) => {
            const no = s.state.kind === 'no-answer'
            const said = s.state.kind === 'idle' ? '' : s.state.text + (s.state.cause ? ` — ${s.state.cause}` : '')
            return (
              <button
                key={s.key}
                type="button"
                className={
                  'board__seat' +
                  (s.running ? ' is-running' : '') +
                  (no ? ' is-no' : '') +
                  (s.local ? ' is-local' : '') +
                  (s.worked || s.running ? '' : ' is-idle') +
                  (s.lead ? ' is-lead' : '')
                }
                style={{ ['--tint' as string]: s.tint, ['--i' as string]: i }}
                aria-label={`What ${s.name} is doing`}
                onClick={() => {
                  if (s.agent) onOpenAgent?.(s.agent)
                }}
              >
                <span className="board__ring" aria-hidden="true">
                  {no ? '✕' : s.letter}
                </span>
                <span className="board__name">{s.name}</span>
                <span className="board__ai" title={s.ai}>
                  {s.local && <Lock />}
                  {shortAi(s.ai, 20)}
                </span>
                {said && (
                  <span className={'board__state' + (no ? ' is-no' : '')} title={said}>
                    {said}
                  </span>
                )}
                {s.state.tokens > 0 && (
                  <span className="board__tokens mono">{s.state.tokens.toLocaleString()} tokens</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
