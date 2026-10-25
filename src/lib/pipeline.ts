// pipeline — the DERIVATIONS behind the v2 Work board (visual system v2 spec,
// 2026-08-18). Pure: types + functions over real spans/runs/verdicts, no I/O,
// no React, so every one of the spec's seven honesty rules is unit-testable
// here rather than only in a rendered tree.
//
// This module DERIVES ONLY. It reuses `delegationSteps` (the agent + provider ·
// model + ask + state, already read from real span attrs), `agentOrbs` (one orb
// per agent that really has a model_call span) and `modelColor` — it does not
// re-read spans to invent a second, competing account of a run.
//
// THE RULES THIS FILE ENFORCES
//  1. Nothing "pulses" here: liveness is the caller's real `live` flag (from
//     `activeRuns`), and `memberIsLive` refuses to return true without it.
//  2. Nothing is guessed. A missing attr yields the honest generic
//     `delegationSteps` already produces, and an absent provider yields the
//     GREY idle hue — never a colour that names a model we don't know.
//  3. Stages are the engine's own `round` attr. No spans → no stages → the
//     board draws no pipeline at all.
//  4. `vaultReads` counts only tool_exec spans that really READ the vault.
//  5. `crewCounts` counts real span states, and refuses to call anything
//     "working" while nothing is live.
//  7. `weekArcs` counts only verdicts that carry a real timestamp, and reports
//     the undated ones separately instead of folding them into the week.
import type { EngineSpan } from './nativeEngine'
import { delegationSteps, spansForTask, type DelegationStep } from './delegation'
import type { AgentOrb } from './orbs'
import { IDLE_HUE, modelColor } from './modelColor'
import type { FinishedRun, LiveRun } from './liveRuns'
import { elapsedLabel } from './liveRuns'
import type { Verdict } from '../engine/types'
import { verdictTone, type VerdictTone } from './verdictOutcome'

// ---------------------------------------------------------------------------
// The crew — who is on this run
// ---------------------------------------------------------------------------

/** The monogram for an agent: its first letter. Never a face, never a photo. */
export function monogram(agent: string): string {
  const first = (agent ?? '').trim().charAt(0)
  return first ? first.toUpperCase() : '·'
}

/**
 * The tint for one agent, from the model that REALLY answered.
 *
 * `provider` empty means the span never said which AI this was, so there is no
 * model to name and the monogram goes GREY (idle / not connected). Grey is a
 * non-claim; it is never used for a model that did answer.
 */
export function agentTint(provider: string, model = ''): string {
  const p = (provider ?? '').trim()
  if (!p) return IDLE_HUE
  return modelColor(model ? `${p} · ${model}` : p)
}

/** The counts behind "N working" — REAL span states, never a plan. */
export interface CrewCounts {
  /** every agent with a real model_call span on this run */
  total: number
  /** spans still open, and a run genuinely executing behind them */
  working: number
  /** spans the engine closed with status ok */
  passed: number
  /** spans the engine closed with status error */
  failed: number
  /** spans still open with NOTHING live — an unfinished trace, not activity */
  unfinished: number
}

/**
 * Rule 5. `live` is the caller's real signal (`activeRuns(...).length > 0`).
 * An open span with nothing live is `unfinished`, never `working`: the run it
 * belonged to has gone, and the last thing the engine wrote just never closed.
 */
export function crewCounts(orbs: readonly AgentOrb[], live: boolean): CrewCounts {
  let working = 0
  let passed = 0
  let failed = 0
  let unfinished = 0
  for (const o of orbs) {
    if (o.outcome === 'ok') passed++
    else if (o.outcome === 'failed') failed++
    else if (live) working++
    else unfinished++
  }
  return { total: orbs.length, working, passed, failed, unfinished }
}

/**
 * The sentence under the crew cluster. '' when there is no crew — never
 * "0 working", which reads like activity that is merely idle.
 */
export function crewCountLabel(c: CrewCounts): string {
  if (c.total === 0) return ''
  const parts: string[] = []
  if (c.working > 0) parts.push(`${c.working} working`)
  if (c.passed > 0) parts.push(`${c.passed} answered`)
  if (c.failed > 0) parts.push(`${c.failed} failed`)
  if (c.unfinished > 0) parts.push(`${c.unfinished} unfinished`)
  return parts.join(' · ')
}

/**
 * Every span a PROJECT's build really produced, across all of its steps.
 *
 * A project runs one engine call per plan step, so each step is a separate run
 * with its own id — which is why the board could only ever show the step
 * happening right now, one anonymous column at a time, however many phases the
 * plan had. The project keeps the task id of every step it finished
 * (`verdictIds`), and `spansForTask` can gather a run's whole span family from
 * one, so the build's real shape is recoverable: one column per step, each
 * carrying the seat that did it.
 *
 * In plan order, because that is the order they happened and the order the user
 * approved. Ids with no spans left in the tail are skipped rather than drawn as
 * empty columns — the tail is finite, and an old step having scrolled out of it
 * is not a step that did nothing.
 */
export function projectRunSpans(
  spans: readonly EngineSpan[],
  verdictIds: readonly string[],
): EngineSpan[] {
  const out: EngineSpan[] = []
  const seen = new Set<string>()
  for (const id of verdictIds) {
    for (const span of spansForTask(spans, id)) {
      // A span can only belong to one run, but a defensive de-dupe keeps a
      // repeated id (a resumed step recorded twice) from doubling a column.
      const key = span.span_id ?? `${span.type}:${span.start}:${span.name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(span)
    }
  }
  return out
}

/**
 * The board column name for a project's plan step.
 *
 * It is the step's OWN text, clipped — the plan the user read and approved,
 * never a phase name the app invented. A reference design showed columns called
 * Planning / Research / Drafting; those are lovely and they are fiction unless
 * the plan really says them, so what shows is what the plan says.
 *
 * Numbered ("1 · Draft the CLI") so the columns keep the plan's order even when
 * two steps start with the same words, and short enough to sit under a column.
 */
export function stageLabelForStep(plan: readonly string[], idx: number): string {
  const raw = (plan[idx] ?? '').trim()
  const n = idx + 1
  if (!raw) return `Step ${n}`
  const first = raw.split('\n')[0].trim()
  const clipped = first.length <= 34 ? first : `${first.slice(0, 33).trimEnd()}…`
  return `${n} · ${clipped}`
}

/**
 * How long since ANYTHING happened on this run, and what the last thing was.
 *
 * WHY THIS EXISTS. A three-agent team was asked to review this very screen and
 * its sharpest finding was: "Is it stuck? Unanswerable. Idle is one
 * undifferentiated state covering thinking, silent retry, rate-limiting, and
 * hung." That is exactly right. A pulsing monogram says "something is
 * happening" and says it identically at four seconds and at four minutes, so
 * the one decision the user actually has to make — keep waiting, or stop it —
 * has nothing to go on.
 *
 * The fix is not a spinner with a better animation, it is a NUMBER. Silence is
 * measured from the newest real span edge: a still-open span's start (it began
 * that long ago and has not come back), or a closed span's end (nothing has
 * happened since). Both are facts the engine wrote.
 *
 * Returns null when the run is not live, or when no span carries a usable
 * clock — an idle board says nothing about waiting, and a run whose spans have
 * no timestamps is not going to be described with a guess.
 *
 * `now` and span times are both engine-clock SECONDS (spans.jsonl `start`), so
 * the caller converts once rather than every reader converting differently.
 */
export function silenceSeconds(
  spans: readonly EngineSpan[],
  live: boolean,
  nowSec: number,
): number | null {
  if (!live) return null
  let newest = 0
  for (const span of spans) {
    const start = typeof span.start === 'number' ? span.start : 0
    if (!start) continue
    // A closed span's edge is its END; an open one's edge is its START, which
    // is the moment we last heard anything at all about it.
    const closed = span.status === 'ok' || span.status === 'error'
    const dur = typeof span.duration_ms === 'number' ? span.duration_ms : 0
    const edge = closed ? start + dur / 1000 : start
    if (edge > newest) newest = edge
  }
  if (!newest) return null
  return Math.max(0, Math.round(nowSec - newest))
}

/**
 * The waiting line, or '' when there is nothing honest to say.
 *
 * Deliberately states the DURATION rather than a verdict. The app does not know
 * that a four-minute local call is stuck — on Sukhdeep's Mac a single on-device
 * call has legitimately taken 413 seconds — so it reports the fact and lets the
 * person holding the context decide. Saying "stuck" would be a guess wearing a
 * warning's clothes.
 */
export function silenceLine(seconds: number | null): string {
  if (seconds === null) return ''
  if (seconds < 20) return 'working now'
  if (seconds < 90) return `working — ${seconds}s since the last step`
  const mins = Math.round(seconds / 60)
  return `working — nothing new for ${mins} min`
}

/** True once the wait is long enough to be worth a person's attention. Not a
 *  claim that anything is wrong: a threshold for raising the line's contrast,
 *  set above the slowest single call really measured on this machine. */
export function silenceIsLong(seconds: number | null): boolean {
  return seconds !== null && seconds >= 420
}

// ---------------------------------------------------------------------------
// The pipeline — column stacks, one per real stage
// ---------------------------------------------------------------------------

export interface PipelineMember {
  /** The real step, verbatim from `delegationSteps`. */
  step: DelegationStep
  monogram: string
  /** The model tint, or grey when the span named no provider. */
  color: string
  /** May this monogram pulse? Only an open span under a genuinely live run. */
  live: boolean
  /** How many model turns this agent really took at this stage (>= 1). A
   *  tool-using agent takes several; they are ONE card, and this is the count
   *  so the card can say so instead of being drawn N times. */
  turns: number
}

export interface PipelineStage {
  key: string
  label: string
  members: PipelineMember[]
}

/**
 * The column label for the engine's raw `round` attr.
 *
 * Every branch is entailed by the attr the engine wrote (delegation.ts's
 * `askedFor` reads the same values): '' — the span carried no round at all —
 * is ONE honest "Working" column, not a guessed phase name.
 */
export function stageLabel(stage: string): string {
  if (stage === 'refused') return 'Refused by the engine'
  if (stage === 'synthesis') return 'Pulling together'
  if (!stage) return 'Working'
  // A BARE NUMBER is a team round and gets the word; anything else is already
  // a label the caller wrote — a project's plan step, say — and prefixing it
  // with "Round" mangles it into "Round 2 · Draft the digest". The attr now
  // carries both kinds since a solo run can name its own stage.
  return /^\d+$/.test(stage.trim()) ? `Round ${stage.trim()}` : stage.trim()
}

/** Rule 1: a member pulses only under a live run, and only while its own span
 *  is still open. A paused run makes `live` false at the caller, so nothing
 *  here can glow for it. */
export function memberIsLive(step: DelegationStep, live: boolean): boolean {
  return live && step.state === 'working'
}

/**
 * Rule 3 — the stages of a run, 1:1 with its real spans.
 *
 * One column per DISTINCT `round` the engine reported, in the order those
 * rounds really first happened. No spans (or no span carrying an `agent` attr)
 * → no stages → the board draws no pipeline: there is no crew, so there is
 * nothing to draw a pipeline of.
 */
export function pipelineStages(spans: readonly EngineSpan[], live: boolean): PipelineStage[] {
  const steps = delegationSteps(spans)
  const order: string[] = []
  const byStage = new Map<string, PipelineMember[]>()
  // ONE CARD PER AGENT PER STAGE (2026-08-19).
  //
  // An agent that uses tools takes SEVERAL model turns in one round — a real
  // run of Sukhdeep's had the researcher call its local model seven times, with
  // a vault read between each — and every turn was drawn as its own card. The
  // column became seven identical "researcher · local · Qwen…" cards stacked on
  // top of each other, which reads as seven researchers rather than one doing
  // seven turns of work, and buries the lead beneath them.
  //
  // Turns are folded into the agent's ONE card. Nothing is discarded: the card
  // carries the LATEST turn (so a working agent still shows what it is doing
  // now), and `turns` records how many there really were, so the count can be
  // stated rather than implied. A still-working turn always wins over a
  // finished one, because "is it running?" is the fact the card exists to show.
  const seatOf = new Map<string, PipelineMember>()
  for (const step of steps) {
    const key = step.stage
    if (!byStage.has(key)) {
      order.push(key)
      byStage.set(key, [])
    }
    // provider · model was already parsed into `ai`; the provider half is the
    // part that decides the hue, exactly as it does everywhere else.
    const provider = step.ai === 'an AI' ? '' : (step.ai.split(' · ')[0] ?? '')
    const seatKey = `${key}\u0000${step.agent}`
    const existing = seatOf.get(seatKey)
    if (existing) {
      existing.turns += 1
      // Later turn wins, and a WORKING turn beats a finished one.
      const takeover = step.at >= existing.step.at || step.state === 'working'
      if (takeover) {
        existing.step = step
        existing.color = agentTint(provider)
        existing.live = memberIsLive(step, live)
      }
      continue
    }
    const member: PipelineMember = {
      step,
      monogram: monogram(step.agent),
      color: agentTint(provider),
      live: memberIsLive(step, live),
      turns: 1,
    }
    seatOf.set(seatKey, member)
    byStage.get(key)!.push(member)
  }
  return order.map((key) => ({ key, label: stageLabel(key), members: byStage.get(key)! }))
}

/**
 * The REAL spans behind ONE pipeline column.
 *
 * It re-reads the SAME `round` attr `pipelineStages` grouped the column by, so
 * the step's expandable detail can only ever show that step's own spans — the
 * black engine console cannot drift back into being a box that shows whatever
 * happened to be in the file. 'refused' selects the engine-refused tool calls
 * that made the refusal column, exactly as `delegationSteps` does.
 */
export function stageSpans(spans: readonly EngineSpan[], stage: string): EngineSpan[] {
  return spans.filter((s) => {
    const a = s.attrs ?? {}
    const refused = s.type === 'tool_exec' && a.refused === true
    if (stage === 'refused') return refused
    if (refused) return false
    const raw = a.round
    const round = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : ''
    return round === stage
  })
}

// ---------------------------------------------------------------------------
// "Your call" — the decisions really parked on the user
// ---------------------------------------------------------------------------

export interface PendingDecision {
  key: string
  label: string
  detail: string
}

/**
 * The last column exists only when something REALLY waits on Sukhdeep. Two
 * real facts feed it, and nothing else:
 *  • a `tool_exec` span the engine held for approval and that carries no
 *    `resolved` attr yet (an answered hold is not a pending one — the same
 *    distinction narrate.ts makes);
 *  • a live run the app itself parked on a human answer (`LiveRun.paused`).
 * No pending decision → no "Your call" column, rather than an empty one.
 */
export function pendingDecisions(
  spans: readonly EngineSpan[],
  live: readonly LiveRun[],
): PendingDecision[] {
  const out: PendingDecision[] = []
  spans.forEach((s, i) => {
    if (s.type !== 'tool_exec') return
    const a = s.attrs ?? {}
    if (a.held !== true) return
    if (typeof a.resolved === 'string' && a.resolved) return
    const tool = typeof a.tool === 'string' ? a.tool : ''
    const agent = typeof a.agent === 'string' ? a.agent : ''
    out.push({
      key: `held-${s.span_id ?? i}`,
      label: 'Needs your OK',
      detail: `${agent || 'a run'} wants to use ${tool || 'a tool'}`,
    })
  })
  for (const r of live) {
    if (!r.paused) continue
    out.push({ key: `paused-${r.id}`, label: 'Waiting on your answer', detail: r.intent })
  }
  return out
}

// ---------------------------------------------------------------------------
// The 🔒 badge
// ---------------------------------------------------------------------------

/** The vault tools that genuinely READ the user's notes. A future vault_write
 *  is not a read, and is deliberately absent (same rule narrate.ts applies). */
export const VAULT_READ_TOOLS = new Set(['vault_read', 'vault_search', 'vault_list'])

/**
 * Rule 4 — how many vault reads REALLY happened on this run.
 *
 * A held-but-unanswered call has not read anything yet; a blocked one never
 * ran; an errored one did not come back. None of them earn the badge.
 */
export function vaultReads(spans: readonly EngineSpan[]): number {
  let n = 0
  for (const s of spans) {
    if (s.type !== 'tool_exec') continue
    const a = s.attrs ?? {}
    if (a.provider !== 'vault') continue
    if (typeof a.tool !== 'string' || !VAULT_READ_TOOLS.has(a.tool)) continue
    if (a.blocked === true) continue
    if (a.held === true && !a.resolved) continue
    if (s.status === 'error' || a.is_error === true) continue
    n++
  }
  return n
}

/**
 * WHAT ONE AGENT HAS ACTUALLY DONE, counted per agent.
 *
 * The board says who is on the job and what each is asked to do; it has never
 * said what any of them has to SHOW for it. Sukhdeep's own design note asks for
 * exactly this — "8 results · 4 vault notes" under the coworker's name — and
 * every number in it is a real `tool_exec` span this run wrote.
 *
 * NOTHING HERE IS A PROGRESS ESTIMATE. The reference mock also carried a
 * "drafting section 2 of 4" and a filling bar; there is no section count
 * anywhere in the engine, so inventing one would put the most confident-looking
 * number on the card underneath the least true. What is counted is what
 * happened: notes read, search results returned. An agent with nothing to show
 * yields an empty string and the card says nothing.
 */
export function agentWork(spans: readonly EngineSpan[], agent: string): string {
  let notes = 0
  let results = 0
  for (const s of spans) {
    if (s.type !== 'tool_exec') continue
    const a = s.attrs ?? {}
    if (a.agent !== agent) continue
    // The same exclusions vaultReads uses: a refused, unresolved-held or
    // errored call did not read anything, so it is not counted as work done.
    if (a.blocked === true) continue
    if (a.held === true && !a.resolved) continue
    if (s.status === 'error' || a.is_error === true) continue
    if (a.provider === 'vault' && typeof a.tool === 'string' && VAULT_READ_TOOLS.has(a.tool)) {
      notes++
      continue
    }
    // Web search reports how many results it really returned.
    if (typeof a.result_count === 'number' && Number.isFinite(a.result_count)) {
      results += a.result_count
    }
  }
  const bits: string[] = []
  if (results) bits.push(`${results} result${results === 1 ? '' : 's'}`)
  if (notes) bits.push(`${notes} vault note${notes === 1 ? '' : 's'}`)
  return bits.join(' · ')
}

/** The badge text, or '' when no vault read happened (so no badge renders). */
export function vaultBadge(spans: readonly EngineSpan[]): string {
  const n = vaultReads(spans)
  if (n === 0) return ''
  return `read ${n} vault ${n === 1 ? 'note' : 'notes'} — stayed on this Mac`
}

// ---------------------------------------------------------------------------
// Recent runs + this week's arcs — every number measured
// ---------------------------------------------------------------------------

/** How long a finished run really took, from its own two measured clocks. */
export function runDuration(run: FinishedRun): string {
  return elapsedLabel(run.startedAt, run.endedAt)
}

/** Rule 7 — this week, counted only from verdicts that carry a REAL timestamp. */
export interface WeekArcs {
  /** TASK verdicts with a parseable `at` inside the window (chat excluded) */
  dated: number
  passed: number
  attention: number
  failed: number
  /** chat turns (`outcome: 'replied'`) inside the window. The arcs are a
   *  statement about WORK — a reply belongs in neither ("passed" would claim
   *  verified work, "needed a look" is the red badge this fix removes) — so
   *  conversation is counted separately and never folded into the arcs OR
   *  their denominator. */
  replied: number
  /** verdicts with no usable timestamp — they cannot be placed in a week, so
   *  they are reported separately and never folded into the counts above */
  undated: number
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function weekArcs(
  verdicts: readonly Verdict[],
  now: number,
  windowMs = WEEK_MS,
): WeekArcs {
  let dated = 0
  let passed = 0
  let attention = 0
  let failed = 0
  let replied = 0
  let undated = 0
  for (const v of verdicts) {
    const t = v.at ? Date.parse(v.at) : NaN
    if (!Number.isFinite(t)) {
      undated++
      continue
    }
    if (t < now - windowMs || t > now) continue
    const tone = verdictTone(v)
    // Chat is not work: a replied turn joins no arc and no denominator (the
    // fall-through below used to count it as `failed` — the weekly copy of
    // the red-badge bug).
    if (tone === 'replied') {
      replied++
      continue
    }
    dated++
    if (tone === 'passed') passed++
    else if (tone === 'attention') attention++
    else failed++
  }
  return { dated, passed, attention, failed, replied, undated }
}

/**
 * Cloud spend claimed for TODAY — summed from the same dated verdicts the
 * panels read, never from an accumulator. The 2026-08-28 screenshot this
 * prevents: "This week — no runs recorded this week yet" directly above
 * "$0.45 spent on cloud today", read from a persisted counter nothing ever
 * reset — the word "today" was decoration. Deriving from the one array makes
 * the footer structurally incapable of contradicting the card above it.
 * Local calendar day, because "today" is a word about the user's own day.
 */
export function todaySpend(verdicts: readonly Verdict[], now: number): number {
  const day = new Date(now).toDateString()
  let sum = 0
  for (const v of verdicts) {
    const t = v.at ? Date.parse(v.at) : NaN
    if (!Number.isFinite(t)) continue
    if (new Date(t).toDateString() !== day) continue
    if (typeof v.cost === 'number' && Number.isFinite(v.cost)) sum += v.cost
  }
  return Math.round(sum * 1000) / 1000
}

/** What the arcs panel SAYS when it cannot draw: '' when it can. */
export function weekEmptyLine(a: WeekArcs): string {
  if (a.dated > 0) return ''
  if (a.replied > 0)
    // A week of pure conversation: "no runs recorded" would deny turns that
    // plainly happened, and drawing the arcs would dress chat up as work.
    return `no task runs this week — ${a.replied} chat repl${a.replied === 1 ? 'y' : 'ies'}, and chat isn't counted as work`
  return a.undated > 0
    ? `no timed runs this week — ${a.undated} earlier run${a.undated === 1 ? ' carries' : 's carry'} no timestamp, so ${a.undated === 1 ? 'it' : 'they'} can't be placed in a week`
    : 'no runs recorded this week yet'
}

/** The sweep of one arc, 0..1. 0 when there is nothing measured to sweep. */
export function arcFraction(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.max(0, Math.min(1, part / whole))
}

// ---------------------------------------------------------------------------
// ONE measured source for the ledger (2026-08-18 UI fix)
// ---------------------------------------------------------------------------
//
// THE BUG THIS SECTION EXISTS TO KILL. "Recent runs" used to read
// `state.finishedRuns` — a SESSION list the store deliberately never persists
// (see AppStore's PersistedSession: liveRuns/finishedRuns are reset to [] on
// every load) — while "This week" read `state.verdicts`, which IS persisted.
// So after a restart the same panel pair rendered, side by side:
//
//     Recent runs — "no runs yet"     |     This week — "1 passed · 14 needed a look"
//
// Both cannot be true. The persisted verdicts WIN: a Verdict is the engine's
// own recorded artifact of a real run (its task, its recorded outcome, its
// measured `durationMs`, the route it really took), it survives the restarts
// this user does constantly, and it is what every other measured surface in
// the app already counts. `finishedRuns` keeps its honest, SESSION-scoped home
// on the live task cards, where its label says exactly that.
//
// Structurally: `RunLedger` now takes ONE array. Two panels derived from one
// source cannot disagree.

/** One row of "Recent runs" — every field read off a real recorded Verdict. */
export interface LedgerRow {
  key: string
  /** The run's own task text, verbatim. */
  task: string
  tone: VerdictTone
  /** The outcome word, from the tone the ENGINE recorded. */
  outcome: string
  /** What the checks really did. '' when the verdict recorded nothing. */
  detail: string
  /** 'local' / 'cloud' — the route the engine recorded. '' when it recorded none. */
  ranOn: string
  /** The measured duration. '' when the verdict carried none. */
  took: string
  /** Parsed `at`, or 0 when the verdict carries no usable timestamp. */
  at: number
  /** Whether this row can be placed in time at all (drives the arcs' window). */
  dated: boolean
}

/**
 * How many recent rows the ledger panel shows.
 *
 * Four, not six. As a full-width band under the work this sits between the
 * conversation and the composer, so every row it draws is height the chat
 * loses — and Sukhdeep's note was that it takes more space than it needs. Four
 * is enough to see a pattern (a run of failures, a change of route) which is
 * the only reason to look at this list rather than at Stats.
 */
export const RECENT_RUN_CAP = 4

/** m:ss (h:mm:ss past an hour) for a measured millisecond duration. */
export function msLabel(ms: number): string {
  return elapsedLabel(0, Math.max(0, ms))
}

/** The outcome word for a tone. 'unknown-nonpass' is NOT rounded to "failed":
 *  the app knows it did not pass and knows nothing more. */
export function outcomeWord(tone: VerdictTone): string {
  if (tone === 'passed') return 'passed'
  if (tone === 'replied') return 'replied'
  if (tone === 'attention') return 'needed a look'
  if (tone === 'failed') return 'failed'
  return 'did not pass'
}

/**
 * What the checks really did on this run, in the engine's own terms.
 *
 * A SKIPPED Tier-1 gate says it skipped and why — a tick over a gate that never
 * executed is exactly the silent pass the honesty rules forbid. Nothing is
 * synthesised: a verdict that recorded no tests and no score yields ''.
 */
/**
 * The engine's skip reason, cut to the CLAUSE a ledger row can hold.
 *
 * The real reason is a full paragraph written for the Verdict page ("skipped —
 * no project bound, nothing to verify. A verify command is configured, but this
 * run has no project directory … Attach a project …"), and it opens with the
 * word the caller is about to prefix. Rendered raw in a row it read
 * "checks skipped — skipped — no project bound…", stuttering and then clipping
 * mid-sentence. This keeps the FIRST clause and drops the duplicated opener;
 * the full reason is untouched on the Verdict page, which has room for it.
 */
export function shortSkipReason(reason: string): string {
  const first = (reason || '').split(/(?<=\.)\s|\n/)[0].trim()
  const deduped = first.replace(/^skipped\s*[—–-]\s*/i, '')
  return deduped.replace(/[.,]$/, '').trim()
}

export function checkLine(v: Verdict): string {
  // A replied chat turn has NO check story to tell. "checks skipped — no
  // project bound" is a true caveat on a task run; on a chat row it reads as
  // something going wrong with a conversation that never had checks to skip.
  if (verdictTone(v) === 'replied') return ''
  const parts: string[] = []
  const t1 = v.tier1
  if (t1?.skipped) {
    const why = shortSkipReason(t1.skipReason || '')
    parts.push(`checks skipped — ${why || 'nothing to verify'}`)
  } else if (t1?.tests) {
    parts.push(`tests ${t1.tests}${t1.pass ? ' ✓' : ' ✕'}`)
  }
  const score = v.tier2?.evalScore
  if (!t1?.skipped && typeof score === 'number') parts.push(`reviewer ${score.toFixed(2)}`)
  return parts.join(' · ')
}

/**
 * The row's label: what the USER asked for, not what the harness sent.
 *
 * Some runs are launched with a DECORATED prompt — the "propose an agent" brief
 * wraps the user's sentence in a page of instructions to the model, and an
 * agent-targeted turn is prefixed with an `[AGENT · name · role …]` definition
 * block. Those decorations are real and belong in the transcript, but a ledger
 * row that prints them shows the user a wall of our own instructions where the
 * name of their task should be. (This is the same mistake as slugging a run
 * from its decorated prompt: the harness's words standing in for the user's.)
 *
 * Nothing is invented here — every branch returns text the verdict really
 * carried; it only chooses WHICH part of it names the run.
 */
export function taskLabel(task: string | undefined, cap = 90): string {
  const raw = (task ?? '').trim()
  if (!raw) return 'a recorded run'

  // "[PROPOSE AN AGENT] … His request:\n\n<what he actually typed>\n\nDo NOT…"
  const proposal = /^\[PROPOSE AN AGENT\]/i.test(raw)
  if (proposal) {
    const asked = raw.split(/request:\s*/i)[1]?.split(/\n\s*\n/)[0]?.trim() ?? ''
    return clip(asked ? `propose an agent — ${asked}` : 'propose an agent', cap)
  }

  // "[AGENT · archivist · role · library model: X — a definition, …] <task>"
  const agentPrefix = raw.match(/^\[AGENT[^\]]*\]\s*/i)
  if (agentPrefix) return clip(raw.slice(agentPrefix[0].length).trim() || 'a recorded run', cap)

  return clip(raw.split('\n')[0].trim() || 'a recorded run', cap)
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap - 1).trimEnd()}…`
}

/**
 * The newest recorded runs, newest first — the SAME array the arcs count.
 *
 * Dated runs sort by their real timestamp; a verdict with no usable `at` still
 * gets a row (it IS a recorded run) but sorts last and is marked `dated:false`,
 * which is precisely why the arcs can honestly say "no timed runs this week"
 * while rows are on screen. That is a statement, not a contradiction.
 */
export function recentRuns(verdicts: readonly Verdict[], cap = RECENT_RUN_CAP): LedgerRow[] {
  return verdicts
    .map((v, i) => {
      const parsed = v.at ? Date.parse(v.at) : NaN
      const dated = Number.isFinite(parsed)
      const tone = verdictTone(v)
      return {
        key: v.taskId || `verdict-${i}`,
        task: taskLabel(v.task),
        tone,
        outcome: outcomeWord(tone),
        detail: checkLine(v),
        ranOn: v.route?.target ?? '',
        took: typeof v.durationMs === 'number' && v.durationMs > 0 ? msLabel(v.durationMs) : '',
        at: dated ? parsed : 0,
        dated,
      }
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, cap)
}
