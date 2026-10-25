// liveRuns — the ONE source of truth for "what is the app running right now"
// (Mission Control Part 2, 2026-08-05 spec §Live task cards).
//
// HONESTY LAW (the whole point of this module): a card may glow ONLY while its
// run is genuinely live. A `LiveRun` exists for exactly as long as the app has
// an in-flight runner behind it — every runner registers on start and ALWAYS
// clears in a `finally` (see AppStore's beginLiveRun/endLiveRun). A leaked
// entry would make a card glow forever, i.e. fabricate activity, which is this
// product's cardinal sin.
//
// This file is PURE (types + derivations, no I/O, no React) so the honesty
// rules are unit-testable: which spans may be attributed to a card, how the
// elapsed clock reads, and what a finished row is allowed to claim.
import { incompleteReason, isIncompleteInvestigation } from './answerText'
import type { EngineSpan } from './nativeEngine'

/**
 * Every kind of run the APP itself starts. One badge per kind on the card.
 *
 * A scheduled task, a scheduled verify and a loop step are NOT chats — they get
 * their own kinds so a card never mislabels which machine is running (M1).
 * 'compaction' is the summariser the app runs over an over-long thread.
 */
export type LiveRunKind =
  | 'chat'
  | 'team'
  | 'manager'
  | 'heartbeat'
  | 'project'
  | 'loop'
  | 'task'
  | 'test'
  | 'compaction'

/**
 * How a run ENDED, as far as the app can honestly tell:
 *  - 'passed'  — it produced the real result it set out to produce
 *  - 'failed'  — it ran and did not pass / could not produce a real reply
 *  - 'stopped' — it was cut short (client timeout, cancel) so the outcome is
 *                genuinely unknown; never dressed up as a pass or a fail.
 */
export type RunOutcome = 'passed' | 'failed' | 'stopped'

export interface LiveRun {
  /** The app's own run id (nativeEngine.newRunId), unique per registration. */
  id: string
  kind: LiveRunKind
  /** A short human intent — what the user actually asked for, truncated. */
  intent: string
  /** Wall clock (ms) at registration; drives the elapsed timer. */
  startedAt: number
  /**
   * The models/agents the app ASKED the engine for on this run (e.g. a team
   * roster the user typed). A REQUEST, not a routing claim — chat runs leave
   * this empty because the gateway decides the route and the app must never
   * guess it. What actually answered comes from real spans (`runSpans`).
   */
  models: string[]
  /**
   * PARKED on a human answer: the run is still registered (it resumes when the
   * user replies) but NO engine is executing — the subprocess has already
   * exited. Nothing may pulse, glow or read "live" while this is true, or the
   * app fabricates activity for as long as the user takes to answer (the
   * project build's "one more refine?" gate can park all night).
   */
  paused?: boolean
}

export interface FinishedRun {
  id: string
  kind: LiveRunKind
  intent: string
  startedAt: number
  endedAt: number
  outcome: RunOutcome
  /** The honest one-liner for a failed/stopped run ('' when it passed). */
  detail: string
}

/** Finished rows kept on the Work page (the newest N). */
export const FINISHED_RUN_CAP = 5

/** Badge text for a kind. Plain words — no jargon, nothing invented. */
export function kindLabel(kind: LiveRunKind): string {
  switch (kind) {
    case 'chat':
      return 'chat'
    case 'team':
      return 'team'
    case 'manager':
      return 'manager'
    case 'heartbeat':
      return 'heartbeat'
    case 'project':
      return 'project'
    case 'loop':
      return 'loop'
    case 'task':
      return 'task'
    case 'test':
      return 'test'
    case 'compaction':
      return 'tidying'
    default:
      return 'run'
  }
}

/**
 * The runs that are genuinely EXECUTING right now — every live run minus the
 * ones parked on a human answer. This is the ONE input to anything that says
 * "something is happening" (glow, pulse, the console's live header): a parked
 * run has no engine behind it, so it may never drive any of them.
 */
export function activeRuns(live: readonly LiveRun[]): LiveRun[] {
  return live.filter((r) => !r.paused)
}

/** m:ss (or h:mm:ss past an hour) since `startedAt`. Never negative. */
export function elapsedLabel(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/**
 * The outcome word shown on a finished row.
 *
 * Nearly always the stored outcome verbatim — with ONE override that is not
 * negotiable. A run whose answer carries the `[incomplete: …]` marker did not
 * finish, whatever the stored outcome says. Sukhdeep photographed a desk row
 * reading `passed` beside "I ran out of tool turns … not a finished answer";
 * both cannot be true, and a product whose claim is that it does not lie about
 * its own work cannot ship the pair.
 *
 * The marker wins because it is the more specific fact: the engine wrote it
 * knowing exactly why the turn ended, while the outcome is a coarser summary
 * that a partial answer can still satisfy.
 */
export function outcomeLabel(run: FinishedRun): string {
  if (isIncompleteInvestigation(run.detail)) return 'incomplete'
  if (run.outcome === 'passed') return 'passed'
  if (run.outcome === 'failed') return 'failed'
  return 'stopped'
}

/**
 * The detail line WITHOUT the outcome word the chip beside it already says (A3,
 * 2026-08-11 acceptance walk).
 *
 * A real finished row read `HEARTBEAT · Sukh is awake… · stopped · stopped at
 * 240s (possibly waiting on a held tool approval)` — chip and detail both opened
 * with "stopped". Details are written as whole sentences ("stopped at 240s…"),
 * which is right on their own but doubles up beside the chip. So ONLY a leading
 * repeat of that row's own outcome word is trimmed, along with any separator
 * that followed it; every other word survives, and both pieces of information
 * stay on the row. A detail that was nothing BUT the duplicate returns '' — the
 * chip alone already said it.
 */
/** How much of an incomplete reason a row may show before it crowds the title
 *  out to an ellipsis — which is what happened on the row that prompted this. */
const MAX_DETAIL = 80

export function outcomeDetail(run: FinishedRun): string {
  const raw = (run.detail ?? '').trim()
  if (!raw) return ''

  // `[incomplete: …]` is a PROTOCOL marker, not prose. Rendering it verbatim
  // put brackets and machinery on a row a person reads, and its full width
  // truncated the run's own title. Show the reason the engine wrote, alone.
  if (isIncompleteInvestigation(raw)) {
    const reason = incompleteReason(raw)
    if (!reason) return ''
    return reason.length > MAX_DETAIL ? reason.slice(0, MAX_DETAIL - 1).trimEnd() + '…' : reason
  }

  const re = new RegExp(`^${outcomeLabel(run)}\\b[\\s:·—–-]*`, 'i')
  return re.test(raw) ? raw.replace(re, '').trim() : raw
}

/**
 * The spans that may honestly be attributed to ONE live run.
 *
 * The engine generates its own telemetry run_id (uuid4, engine-side) — the
 * app's run id is only a subprocess handle, so a span cannot be matched to an
 * app run by id. That leaves two honest facts: a span's real start time, and
 * how many runs the app has in flight. So:
 *
 *  - 2+ runs live  → NO attribution at all (we genuinely cannot tell whose
 *    span this is; naming a model on the wrong card would be a fabrication).
 *  - exactly 1 live run → its spans are the ones that STARTED at or after the
 *    run was registered (the app registers before spawning the engine, so a
 *    real span of this run can never predate it).
 */
export function runSpans(spans: EngineSpan[], run: LiveRun, liveCount: number): EngineSpan[] {
  if (liveCount !== 1) return []
  return spans.filter((s) => typeof s.start === 'number' && s.start * 1000 >= run.startedAt)
}

/**
 * The spans of whatever is running RIGHT NOW, for the chat column's narration
 * and the console body: the spans that started at or after the one live run
 * began. [] when nothing is live, so narration can never outlive a run.
 *
 * EXACTLY the same honesty rule as `runSpans`, and for the same reason. This
 * used to take the OLDEST live run's start, which meant that with two runs in
 * flight a FINISHED run's spans (its verdict, "the run finished") stayed in the
 * body under a `live` header while a different run was the live one. With 2+
 * runs the app genuinely cannot tell whose span is whose, so it shows none and
 * says so.
 */
export function currentRunSpans(spans: EngineSpan[], live: readonly LiveRun[]): EngineSpan[] {
  if (live.length !== 1) return []
  const since = live[0].startedAt
  return spans.filter((s) => typeof s.start === 'number' && s.start * 1000 >= since)
}

/**
 * The spans of the MOST RECENTLY FINISHED run — so the crew that did the work
 * is still on screen after the work is done.
 *
 * WHY THIS EXISTS. `currentRunSpans` above is deliberately live-only, and the
 * crew board it feeds renders nothing once a run ends. That left the product
 * unable to show its single most important fact: Sukhdeep launched a team
 * across two different AIs — `lead` on claude-cli, `researcher` on his local
 * Qwen with seven vault reads between turns — and thirty seconds later the page
 * had no memory of it. He could only ever glimpse his crew mid-run, which is
 * precisely when he is least likely to be looking.
 *
 * HOW IT SLICES. The engine closes every run with one `run:<id>` span. So the
 * last finished run is everything AFTER the second-to-last `run:` marker, up to
 * and including the last one. If the tail holds only one marker, the whole tail
 * is that run. No marker at all means nothing has finished — [], never a guess.
 *
 * This attributes spans by POSITION IN THE ENGINE'S OWN LOG, not by time
 * window, so it cannot drift the way a timestamp comparison can.
 */
export function lastFinishedRunSpans(spans: EngineSpan[]): EngineSpan[] {
  const marks: number[] = []
  for (let i = 0; i < spans.length; i++) {
    if (typeof spans[i].name === 'string' && spans[i].name.startsWith('run:')) marks.push(i)
  }
  if (marks.length === 0) return []
  const end = marks[marks.length - 1]
  const start = marks.length >= 2 ? marks[marks.length - 2] + 1 : 0
  return spans.slice(start, end + 1)
}

/**
 * Did that run genuinely involve more than one coworker? A single-agent chat
 * turn is not a crew, and drawing a one-monogram "board" for it would dress an
 * ordinary reply up as teamwork.
 */
export function crewSize(spans: EngineSpan[]): number {
  const names = new Set<string>()
  for (const s of spans) {
    const agent = (s.attrs ?? {}).agent
    if (typeof agent === 'string' && agent.trim()) names.add(agent.trim())
  }
  return names.size
}

/** Trim a free-text intent to one readable card line (never mid-word ellipsis). */
export function shortIntent(text: string, max = 90): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  return one.slice(0, max - 1).trimEnd() + '…'
}
