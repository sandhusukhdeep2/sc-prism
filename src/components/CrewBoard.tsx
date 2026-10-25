// CrewBoard — the v2 Work board (visual system v2 spec, 2026-08-18).
//
// A live run renders as a PIPELINE of column stacks — one column per stage the
// ENGINE really reported — each holding the agents at that stage: a monogram
// tinted by its own model, the agent's name, `provider · model` in mono, what
// it is doing right now, and a thin progress line. Above the columns: the
// overlapping crew cluster with its count badge, and the 🔒 badge.
//
// AGENTS ARE NOT PEOPLE. Every coworker here is a MONOGRAM in its model's
// colour — never a face, never a stock photo. The reference this design comes
// from used human photographs; a photograph would have made the prettiest
// element on the page the only dishonest one.
//
// This component DERIVES NOTHING itself. Every fact it draws comes from
// src/lib/pipeline.ts (which in turn reuses `delegationSteps` / `agentOrbs` /
// `modelColor` over real spans), so the honesty rules are provable without a
// DOM — see pipeline.test.ts — and provable again here in CrewBoard.test.tsx.
//
//   · a monogram pulses ONLY when `live` is true (the caller passes
//     `activeRuns(...).length > 0`, so a PAUSED run cannot glow)
//   · a name and a `provider · model` come from real span attrs; a missing
//     attr yields the honest generic and a GREY monogram
//   · no crew → this component renders NOTHING, rather than an empty pipeline
//   · the 🔒 badge appears only when a vault read really happened
//   · the count is real span states, never a plan
import { useState, type ReactNode } from 'react'
import { useNow } from '../lib/useNow'
import { agentDossier } from '../lib/agentDossier'
import AgentDossierPanel from './AgentDossierPanel'
import { agentOrbs } from '../lib/orbs'
import { IDLE_HUE } from '../lib/modelColor'
import {
  agentTint,
  crewCountLabel,
  crewCounts,
  monogram,
  pendingDecisions,
  agentWork,
  pipelineStages,
  silenceIsLong,
  silenceLine,
  silenceSeconds,
  vaultBadge,
  type PipelineMember,
  type PipelineStage,
} from '../lib/pipeline'
import type { EngineSpan } from '../lib/nativeEngine'
import type { LiveRun } from '../lib/liveRuns'
import './CrewBoard.css'
import Icon from './Icon'

/** The one line saying what this coworker is doing RIGHT NOW — its real ask
 *  while the span is open, its real outcome once the engine closed it. */
function nowLine(m: PipelineMember): string {
  if (m.step.state === 'working') return `asked to ${m.step.asked}`
  return m.step.outcome || m.step.asked
}

function Mono({
  letter,
  color,
  pulse,
  size,
}: {
  letter: string
  color: string
  pulse: boolean
  size: 'sm' | 'lg'
}) {
  const idle = color === IDLE_HUE
  return (
    <span
      className={
        `crew__mono crew__mono--${size}` +
        (idle ? ' crew__mono--idle' : '') +
        (pulse ? ' crew__mono--pulse' : '')
      }
      // The halo is drawn in THIS agent's own model colour, not a house blue.
      // The app's whole palette says blue = cloud, green = on your Mac — so a
      // local agent glowing blue would contradict the one thing the colour is
      // for. `--tint` carries it into the keyframes.
      style={{ background: color, ['--tint' as string]: color }}
      aria-hidden="true"
    >
      {letter}
    </span>
  )
}


/**
 * `provider · model`, cut to what a 200px card can hold.
 *
 * A local model's real id can be enormous — Sukhdeep's is
 * "Qwen3.6-35B-A3B-Claude-4.7-Opus-Reasoning-Distilled-MLX-oQ4-MTP" — and
 * printed in full it wrapped over three lines and pushed everything else out
 * of the card. The head of the name is the part that identifies it, and the
 * full string stays in the title attribute, so nothing is hidden.
 */
export function shortAi(ai: string, cap = 22): string {
  const [provider, ...rest] = ai.split(' · ')
  const model = rest.join(' · ')
  if (!model) return provider
  const short = model.length <= cap ? model : `${model.slice(0, cap - 1).trimEnd()}…`
  return `${provider} · ${short}`
}

export default function CrewBoard({
  spans,
  live,
  runs,
  now: fixedNow,
  renderStageDetail,
}: {
  /** The spans honestly attributable to the current run — `currentRunSpans`,
   *  which is [] whenever 2+ runs are in flight (rule 6, and the reason this
   *  board can never cross-attribute one run's crew to another). */
  spans: EngineSpan[]
  /** Genuinely EXECUTING — `activeRuns(live).length > 0`. A parked run is not. */
  live: boolean
  /** Injected wall clock (tests). Omitted → a 1s tick while the run is live. */
  now?: number
  /** The app's live runs, for the parked-on-you decisions only. */
  runs: readonly LiveRun[]
  /**
   * The EXPANDABLE DETAIL of a pipeline step (2026-08-18 UI fix). The black
   * engine console used to be a permanent box under the chat, on screen even
   * when it had nothing but a finished run's trail to show — one of the blocks
   * that made Work taller than the window. It is now the `▸` detail of ONE
   * step: opened deliberately, closed by default, and gone entirely when there
   * is no pipeline to open. Nothing is rendered unless a caller supplies this.
   */
  renderStageDetail?: (stage: PipelineStage) => ReactNode
}) {
  // Which step's engine detail is open. Closed by default: the console is now
  // something the user ASKS for, never something the page keeps on screen.
  const [openStage, setOpenStage] = useState<string | null>(null)
  // WHICH COWORKER IS OPEN. The crew cluster used to be something you could
  // only look at; Sukhdeep asked to be able to click one and see what that
  // specific agent is doing. Held by NAME, not by index, so a crew that grows
  // mid-run cannot slide the panel onto a different agent.
  const [openAgent, setOpenAgent] = useState<string | null>(null)
  const stages = pipelineStages(spans, live)
  const decisions = pendingDecisions(spans, runs)
  const orbs = agentOrbs(spans)
  const counts = crewCounts(orbs, live)
  const countLine = crewCountLabel(counts)
  const badge = vaultBadge(spans)
  // HOW LONG SINCE ANYTHING HAPPENED. The clock ticks only while the run is
  // live (useNow's own rule), so an idle board animates nothing. Spans carry
  // engine-clock SECONDS, so the conversion happens once, here.
  const nowSec = useNow(live, fixedNow) / 1000
  const silence = silenceSeconds(spans, live, nowSec)
  const waiting = silenceLine(silence)
  // Null whenever that agent has no spans — clicking a seat that turns out to
  // have no record opens nothing rather than an empty sheet.
  const dossier = openAgent ? agentDossier(spans, openAgent, live) : null

  // No crew and nothing parked on the user: there is no pipeline to draw, so
  // none is drawn. An empty board would be a claim about a run that isn't one.
  if (stages.length === 0 && decisions.length === 0) return null

  const badgeCount = live ? counts.working : counts.total
  // The opened step, resolved against the stages that exist RIGHT NOW. A stage
  // that has gone (the run moved on, or ended) closes its own drawer rather
  // than leaving a detail panel attached to a step that is no longer there.
  const opened = openStage === null ? undefined : stages.find((s) => s.key === openStage)

  return (
    <section className="crew" aria-label="Who is on this run">
      <div className="crew__head">
        <span className="crew__title">Who&rsquo;s on it</span>
        {orbs.length > 0 && (
          <span className="crew__cluster">
            {orbs.map((o, i) => (
              // EVERY SEAT IS A BUTTON. The deploy stagger is a CSS custom
              // property rather than N keyframes, so a crew of any size lands
              // one after another in the order the engine really reported them.
              <button
                type="button"
                key={o.agent}
                className="crew__seat"
                style={{ ['--seat' as string]: String(i) }}
                aria-label={`What ${o.agent} is doing`}
                onClick={() => setOpenAgent(o.agent)}
              >
                <Mono
                  letter={monogram(o.agent)}
                  color={agentTint(o.provider, o.model)}
                  pulse={live && o.outcome === 'running'}
                  size="lg"
                />
                {i === 0 && badgeCount > 0 && (
                  <span className="crew__badge mono">{badgeCount}</span>
                )}
              </button>
            ))}
          </span>
        )}
        {countLine && <span className="crew__count mono">{countLine}</span>}
        {/* The one thing that told a user nothing: a pulse that looks identical
            at four seconds and four minutes. This states the number instead,
            and never calls it "stuck" — a local call here has honestly taken
            seven minutes, so the fact is reported and the judgement is left to
            the person who has the context. */}
        {waiting && (
          <span
            className={'crew__waiting mono' + (silenceIsLong(silence) ? ' is-long' : '')}
            aria-live="polite"
          >
            {waiting}
          </span>
        )}
        <span className="crew__spacer" />
        {/* Rule 4: only when a vault read really happened on this run. */}
        {badge && (
          <span className="crew__lock mono" title="Your notes were read on this machine.">
            🔒 {badge}
          </span>
        )}
      </div>

      <div className={'crew__cols' + (live ? ' is-live' : '')}>
        {stages.map((stage) => (
          <div className="crew__col" key={stage.key}>
            <div className="crew__stack">
              {stage.members.map((m, i) => (
                <button
                  type="button"
                  className="crew__item"
                  key={`${m.step.agent}-${m.step.at}-${i}`}
                  // `--seat` staggers the landing; `--tint` gives the working
                  // bar inside this card the same model colour as the monogram,
                  // so one coworker is one colour wherever it is drawn.
                  style={{ ['--seat' as string]: String(i), ['--tint' as string]: m.color }}
                  aria-label={`What ${m.step.agent} is doing`}
                  onClick={() => setOpenAgent(m.step.agent)}
                >
                  <Mono letter={m.monogram} color={m.color} pulse={m.live} size="sm" />
                  <div className="crew__body">
                    <div className="crew__name">
                      {m.step.agent}
                      {/* A tool-using agent takes several model turns in one
                          round. They are ONE card; this states how many rather
                          than drawing the same coworker N times. */}
                      {m.turns > 1 && (
                        <span className="crew__turns mono" title={`${m.turns} model turns`}>
                          ×{m.turns}
                        </span>
                      )}
                    </div>
                    <div className="crew__ai mono" title={m.step.ai}>
                      {shortAi(m.step.ai)}
                    </div>
                    <div className="crew__now">{nowLine(m)}</div>
                    {/* WHAT IT HAS TO SHOW FOR IT — real tool_exec counts, and
                        nothing when there are none. Never a progress estimate:
                        the engine has no notion of "section 2 of 4", so a bar
                        claiming one would be the most confident thing on the
                        card and the least true. */}
                    {(() => {
                      const work = agentWork(spans, m.step.agent)
                      return work ? <div className="crew__work mono">{work}</div> : null
                    })()}
                    {/* A progress line exists only while the span is open AND
                        the run is live — it is the pulse in another shape. */}
                    {m.live && (
                      <div className="crew__bar" role="img" aria-label={`${m.step.agent} is working`}>
                        <i />
                      </div>
                    )}
                  </div>
                  {m.step.state === 'done' && (
                    <span className="crew__tick crew__tick--ok" title="answered">
                      ✓
                    </span>
                  )}
                  {(m.step.state === 'unreachable' || m.step.state === 'refused') && (
                    <span className="crew__tick crew__tick--bad" title={m.step.outcome}>
                      ✕
                    </span>
                  )}
                </button>
              ))}
            </div>
            {/* The label sits BENEATH the stack — the reference's form
                language — and, when a caller can show this step's engine
                detail, it IS the `▸` control that opens it. */}
            {renderStageDetail ? (
              <button
                type="button"
                className="crew__collabel crew__collabel--btn"
                aria-expanded={openStage === stage.key}
                aria-label={`Engine steps for ${stage.label}`}
                onClick={() => setOpenStage((k) => (k === stage.key ? null : stage.key))}
              >
                {/* One glyph that ROTATES, rather than two different
                    characters swapped — the turn is the affordance. */}
                <Icon
                  name="chevron"
                  size={14}
                  className={'crew__chev' + (openStage === stage.key ? ' is-open' : '')}
                />
                <span className="crew__collabeltext">{stage.label}</span>
              </button>
            ) : (
              <div className="crew__collabel">{stage.label}</div>
            )}
          </div>
        ))}

        {decisions.length > 0 && (
          <div className="crew__col">
            <div className="crew__stack">
              {decisions.map((d) => (
                // BLACK is the accent, and it is spent here: the one card on the
                // screen that is waiting on Sukhdeep.
                <div className="crew__decide" key={d.key}>
                  <div className="crew__decidetitle">{d.label}</div>
                  <div className="crew__decidedetail">{d.detail}</div>
                </div>
              ))}
            </div>
            <div className="crew__collabel">Your call</div>
          </div>
        )}
      </div>

      {/* The opened step's engine detail. It only ever renders for a stage that
          really exists in `stages`, so it cannot outlive the step it belongs
          to: a run that ends takes its columns — and this drawer — with it. */}
      {renderStageDetail && opened && (
        <div className="crew__detail">{renderStageDetail(opened)}</div>
      )}

      {dossier && <AgentDossierPanel dossier={dossier} onClose={() => setOpenAgent(null)} />}
    </section>
  )
}
