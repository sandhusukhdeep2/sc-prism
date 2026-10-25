// SC Prism — pure Coworker Desk aggregator.
//
// The desk surfaces "what needs me" across every store in one place: parked
// project asks, parked manager dispatches,
// projects that stalled with a note, and a connectivity problem the user
// already dismissed the banner for. Every function here is a pure,
// deterministic projection of its inputs — no store singletons, no React, no
// `Date.now()` (time is always passed in as `now`). D3 (the desk UI) imports
// these names verbatim, so the exported surface is load-bearing.

import type { ManagersState, ManagerJob } from './managers'
import type { Project } from './projects'
import type { Notice } from '../store/AppStore'
import type { Verdict } from '../engine/types'
import type { Schedule } from './schedules'
import type { HeldToolCall, PendingApproval } from './nativeEngine'
import type { AgentProposal } from './agentProposals'
import { rowCapabilityLine, type ReviewedRow, type RosterProposal, type RosterRole } from './projectRoster'
import type { QuestionSet } from './businessInterview'
import { isAttention, tally, type OutcomeTally } from './verdictOutcome'

export type DeskItem =
  // A run PAUSED RIGHT NOW at a held tool call, blocking on a live Approve/Deny
  // (the engine's BlockingApprovalBroker wrote the request and is polling for
  // our decision). DISTINCT from the after-the-fact `tool-approval` grant below:
  // this decides a run that is blocked at THIS instant. `id` is the decision
  // key; `at` is epoch MILLISECONDS (converted from the request's seconds here).
  | { kind: 'live-approval'; id: string; server: string; tool: string; at?: number; title: string; detail: string }
  | { kind: 'project-ask'; projectId: string; title: string; detail: string }
  | { kind: 'dispatch'; jobId: string; title: string; detail: string }
  // A real MCP tool call the engine HELD for sign-off (approval.py). `name` is
  // the grant target (the tool name the engine matches); `server`/`tool`/`at`
  // drive the label + relative time. Approving grants it for the NEXT run.
  | { kind: 'tool-approval'; name: string; server: string; tool: string; at?: number; title: string; detail: string }
  | { kind: 'project-attention'; projectId: string; title: string; detail: string }
  // A new agent the companion PROPOSED (2026-08-11 spec). It is not an agent
  // yet and is not in the library — this row is the only place it exists until
  // the user taps Create. The whole record rides along so the row can show the
  // model + why, what it would carry, and the REAL evidence, unparaphrased.
  | { kind: 'agent-proposal'; proposalId: string; title: string; detail: string; proposal: AgentProposal }
  // A whole PROJECT ROSTER the manager proposed (2026-08-15 spec §"He staffs a
  // project"). Same law as `agent-proposal`, at team scale: none of these roles
  // exists in the library, none counts in any stat, and ONE Create makes them
  // all real. The record rides along so each row can show its AI, the
  // capabilities it would get, and the project need it exists for.
  | { kind: 'roster-proposal'; rosterId: string; title: string; detail: string; roster: RosterProposal }
  // Questions the companion asked about the business (2026-08-15 spec §4).
  // They are QUESTIONS, never claims: nothing here is knowledge, and nothing
  // reaches the vault note until the user types an answer himself. The set
  // rides along so the row can render one input per question.
  | { kind: 'business-question'; setId: string; title: string; detail: string; set: QuestionSet }
  | { kind: 'connectivity'; title: string; detail: string }

export interface DeskInputs {
  managers: ManagersState
  projects: readonly Project[]
  notices: readonly Notice[]
  anyDown: boolean
  bannerDismissed: boolean
  downSummary: string // pre-formatted by the caller (e.g. 'Local model — unreachable')
  // Real held MCP tool calls (readHeldToolCalls over the span tail), already
  // deduped + newest-first + local-dismissals removed by the caller. Omitted /
  // [] (the default) → no tool-approval items → byte-identical to before.
  heldToolCalls?: readonly HeldToolCall[]
  // Real paused runs awaiting a live Approve/Deny (readPendingApprovals over
  // the vault's approvals/pending dir), already read + newest-first + decided-
  // this-session removed by the caller. Omitted / [] (the default) → no
  // live-approval items → byte-identical to before.
  pendingApprovals?: readonly PendingApproval[]
  // Every proposal the store holds (decided ones included) — the gate below
  // keeps only the OPEN ones, so a created or dismissed proposal can never
  // re-appear on the desk. Omitted / [] (the default) → no proposal items →
  // byte-identical to before.
  proposals?: readonly AgentProposal[]
  // Every roster proposal the store holds (decided ones included) — the gate
  // below keeps only the OPEN ones, so a staffed or dismissed roster can never
  // re-appear. Omitted / [] (the default) → no roster items → byte-identical.
  rosters?: readonly RosterProposal[]
  // Every question set the store holds (decided ones included) — the gate below
  // keeps only the OPEN one. Omitted / [] (the default) → no question items →
  // byte-identical to before.
  questionSets?: readonly QuestionSet[]
}

/**
 * Last matching notice's text for one project+kind, scanning from the end —
 * mirrors AppStore.tsx's `latestNotice` (notices only accumulate; a forward
 * scan would surface a stale earlier ask instead of the current one). Not
 * imported from AppStore because only TYPES may be imported from stores here.
 */
function latestNoticeText(
  notices: readonly Notice[],
  projectId: string,
  kind: Notice['kind'],
): string | undefined {
  for (let i = notices.length - 1; i >= 0; i--) {
    const n = notices[i]
    if (n.projectId === projectId && n.kind === kind) return n.text
  }
  return undefined
}

/** A dispatch or team job parked awaiting the user's OK — mirrors Agents.tsx's `parked`. */
function isParkedDispatch(j: ManagerJob): boolean {
  return (j.kind === 'dispatch' || j.kind === 'team') && (j.pendingSince ?? 0) > 0
}

export function buildDeskItems(i: DeskInputs): DeskItem[] {
  const items: DeskItem[] = []

  // 0. live-approval — a run PAUSED RIGHT NOW at a held tool call, blocking on
  // the user's Approve/Deny (the engine's BlockingApprovalBroker wrote the
  // request and is polling for our decision). This LEADS everything: a real
  // subprocess is waiting on this answer, so it is the single most urgent thing
  // on the desk. Only ever from REAL pending requests the engine wrote; none →
  // nothing here, byte-identical. The request's `at` is wall-clock epoch
  // SECONDS — convert to ms once here (like readHeldToolCalls does for held
  // spans / RunStream's `at * 1000`) so the row's relative time is honest.
  for (const p of i.pendingApprovals ?? []) {
    const summary = (p.args_summary ?? '').trim()
    items.push({
      kind: 'live-approval',
      id: p.id,
      server: p.server,
      tool: p.tool,
      at: typeof p.at === 'number' ? p.at * 1000 : undefined,
      title: `Build paused — ${p.server} · ${p.tool} needs your approval to run`,
      detail: summary || 'The run is waiting for your decision to continue.',
    })
  }

  // 1. project-ask — projects awaiting the user's yes/no (extra-refine handshake).
  for (const p of i.projects) {
    if (p.status !== 'awaiting') continue
    const detail = latestNoticeText(i.notices, p.id, 'request') ?? p.lastNote
    items.push({ kind: 'project-ask', projectId: p.id, title: p.name, detail })
  }

  // 2. dispatch — manager jobs parked awaiting an approve/reject.
  for (const j of i.managers.jobs) {
    if (!isParkedDispatch(j)) continue
    const manager = i.managers.managers.find((m) => m.id === j.managerId)
    const managerName = manager?.name ?? 'manager'
    items.push({ kind: 'dispatch', jobId: j.id, title: j.title, detail: `${managerName} · ${j.department}` })
  }

  // 3.5 tool-approval — real MCP tool calls the engine HELD for sign-off. Only
  // ever from real held spans (the caller reads them off the span tail); none →
  // nothing here. Honest label: approving grants the tool for the NEXT run, it
  // does not re-run the already-held call. The caller passes them newest-first.
  for (const h of i.heldToolCalls ?? []) {
    // Lead the row with the tool IDENTITY (server · tool) — what it is — and
    // move the "held for your approval" status phrase to the secondary line.
    const detail = `held for your approval${h.why ? ` — ${h.why}` : ''}`
    items.push({
      kind: 'tool-approval',
      name: h.tool,
      server: h.server,
      tool: h.tool,
      at: h.at,
      title: `${h.server} · ${h.tool}`,
      detail,
    })
  }

  // 4. project-attention — projects that stalled and left a note.
  for (const p of i.projects) {
    if (p.status !== 'attention') continue
    items.push({ kind: 'project-attention', projectId: p.id, title: p.name, detail: p.lastNote })
  }

  // 4.5 agent-proposal — a new agent the companion proposed and the user has
  // not decided on yet. ONLY 'open' records surface: a created one is already
  // an agent, and a dismissed one is dismissed FOREVER (the record survives
  // precisely so the same proposal cannot nag again). Nothing here exists in
  // the agent library — a proposal is not an agent until Create is tapped.
  for (const p of i.proposals ?? []) {
    if (p.status !== 'open') continue
    items.push({
      kind: 'agent-proposal',
      proposalId: p.id,
      title: `New agent proposed — ${p.name}`,
      detail: p.purpose,
      proposal: p,
    })
  }

  // 4.55 roster-proposal — a whole team the manager proposed for a project.
  // ONLY 'open' records surface, exactly like an agent proposal: a created
  // roster is already a team, and a dismissed one is dismissed for good. None
  // of these roles is in the agent library until the single Create is tapped.
  for (const r of i.rosters ?? []) {
    if (r.status !== 'open') continue
    const n = r.roles.length
    items.push({
      kind: 'roster-proposal',
      rosterId: r.id,
      title: `Team proposed for ${r.evidence.projectName} — ${n} role${n === 1 ? '' : 's'}`,
      detail: `Review who does what and what each may touch. One approval creates all ${n}; nothing exists until then.`,
      roster: r,
    })
  }

  // 4.6 business-question — the companion asking to be told something, because
  // he refuses to invent it (2026-08-15 spec §4). Only 'open' sets surface, and
  // only ONE can ever be open, so this row appears at most once. It sits at the
  // bottom of the needs-you list on purpose: nothing is blocked on it, and a
  // question must never outrank a real decision the user owes.
  for (const s of i.questionSets ?? []) {
    if (s.status !== 'open') continue
    const n = s.questions.length
    items.push({
      kind: 'business-question',
      setId: s.id,
      title: 'A few questions about your business',
      detail: `${n} question${n === 1 ? '' : 's'} — answer any of them, or dismiss. Nothing is recorded until you do.`,
      set: s,
    })
  }

  // 5. connectivity — ONLY when a service is down AND the user already
  // dismissed the banner (the banner covers the un-dismissed case; never both).
  if (i.anyDown && i.bannerDismissed) {
    items.push({ kind: 'connectivity', title: 'Connectivity issue', detail: i.downSummary })
  }

  return items
}

// ---------------------------------------------------------------------------
// Agent-proposal row lines (2026-08-11 spec) — PURE, so what the row claims is
// unit-tested. Every line is derived from the record; none of them soften the
// evidence into a vague "recent activity" phrase.
// ---------------------------------------------------------------------------

/** "would run on claude — <why>" (the why omitted only when the record has none). */
export function proposalModelLine(p: AgentProposal): string {
  const why = p.modelWhy.trim()
  return why ? `would run on ${p.model} — ${why}` : `would run on ${p.model}`
}

/** What it may touch: the skills it would carry, or an honest "none yet". */
export function proposalTouchLine(p: AgentProposal): string {
  return p.skills.length > 0
    ? `may touch: ${p.skills.join(', ')}`
    : 'may touch: nothing yet — it would carry no skills'
}

/**
 * The heading above the evidence. For an 'asked' proposal the evidence IS the
 * user's own words, so they are the line. For a 'runs' proposal this only says
 * how many cited runs the app could still resolve — the runs themselves are
 * rendered one per line by `proposalEvidenceRuns` below, from the verdict
 * history, NOT from anything the model wrote.
 */
export function proposalEvidenceHead(p: AgentProposal, resolved: number): string {
  if (p.evidence.kind === 'asked') return `you asked: “${p.evidence.quote}”`
  if (p.evidence.refs.length === 0) return 'evidence — none cited'
  if (resolved === 0) return 'evidence — none of the runs it cited are in your history any more'
  return `evidence — ${resolved} run${resolved === 1 ? '' : 's'} from your history:`
}

/** One cited run, resolved against the app's OWN verdict log. `text` is a fact
 *  the app can prove; `found` is false when the id no longer resolves. */
export interface ProposalEvidenceRun {
  ref: string
  found: boolean
  text: string
}

/** 'YYYY-MM-DD HH:MM' in local time from a verdict's ISO `at`, or '' when the
 *  run carries no usable timestamp (never a fabricated one). */
function runStamp(at?: string): string {
  if (!at) return ''
  const t = Date.parse(at)
  if (Number.isNaN(t)) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * THE EVIDENCE, resolved: for each cited ref, the run it names — its real task
 * text, whether it passed, and when it ran — read out of `verdicts`, never out
 * of the model's prose. A ref that no longer resolves says exactly that rather
 * than being dropped in silence. This is the fix for a row that used to print
 * real ids glued to a model-authored narrative and call the whole thing
 * evidence: ids alone verify nothing about what those runs actually were.
 */
export function proposalEvidenceRuns(
  p: AgentProposal,
  verdicts: readonly Verdict[],
): ProposalEvidenceRun[] {
  if (p.evidence.kind !== 'runs') return []
  return p.evidence.refs.map((ref) => {
    const key = ref.trim().toLowerCase()
    const v = verdicts.find((x) => (x.taskId ?? '').trim().toLowerCase() === key)
    if (!v) return { ref, found: false, text: `${ref} — no longer in your run history` }
    const task = (v.task ?? '').trim().replace(/\s+/g, ' ')
    const when = runStamp(v.at)
    // Three-valued: an ATTENTION run cited as evidence must not be resolved to
    // the word "failed" — its checks ran and passed, only the reviewer objected.
    const outcomeWord = isAttention(v) ? 'needed a look' : v.passed ? 'passed' : 'failed'
    const parts = [ref, outcomeWord, task ? `“${task.slice(0, 80)}”` : 'no task text']
    if (when) parts.push(when)
    return { ref, found: true, text: parts.join(' · ') }
  })
}

/**
 * The manager's own words about the evidence (`evidence_note`) — free text the
 * model wrote, so it is labelled as a reading and can never be mistaken for a
 * citation. '' when the record carries none.
 */
export function proposalReadingLine(p: AgentProposal): string {
  if (p.evidence.kind !== 'runs') return ''
  const note = p.evidence.quote.trim()
  return note ? `the manager’s reading: ${note}` : ''
}

// ---------------------------------------------------------------------------
// Roster-proposal row lines (2026-08-15 spec) — PURE, same discipline as the
// agent-proposal lines above: every line is derived from the record, and none
// of them softens a capability or a project need into a vague phrase.
// ---------------------------------------------------------------------------

/** "would run on claude — <why>" for one roster row. */
export function rosterRoleModelLine(role: RosterRole): string {
  const why = role.modelWhy.trim()
  return why ? `would run on ${role.model} — ${why}` : `would run on ${role.model}`
}

/**
 * What this role would be ALLOWED to do — the clamped grant, in plain words.
 * "nothing" is stated outright rather than left blank: a row with no
 * capabilities is a real, honest answer, not a rendering gap.
 */
export function rosterRoleCapabilityLine(row: ReviewedRow): string {
  return `may: ${rowCapabilityLine(row)}`
}

/** The capabilities asked for and refused, with the reason. '' when none were. */
export function rosterRoleRefusedLine(row: ReviewedRow): string {
  if (row.refused.length === 0) return ''
  const names = row.refused.map((r) => r.capability).join(', ')
  return `not granted: ${names} — ${row.refused[0].reason}`
}

/** The project's OWN need this role exists for, quoted. Never paraphrased —
 *  the need is the evidence, and a paraphrase is not verifiable. */
export function rosterRoleNeedLine(role: RosterRole): string {
  return `for: “${role.need}”`
}

/** The one-line summary above the rows: how many roles, on how many AI. */
export function rosterHeadLine(roster: RosterProposal): string {
  const ais = new Set(roster.roles.map((r) => r.model))
  const n = roster.roles.length
  return `${n} role${n === 1 ? '' : 's'} across ${ais.size} AI — one approval creates all of them`
}

/** Local hour-of-day from the passed epoch — deterministic given `now`. */
export function greeting(now: number, name: string): string {
  const hour = new Date(now).getHours()
  const base = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  return name ? `${base}, ${name}` : base
}

/**
 * P8 (honesty): a running project isn't always "mid-build on step X". Two edge
 * states used to masquerade as active progress: an empty plan rendered a
 * nonsensical "step 0 of 0", and a stepIndex past the last step stayed pinned at
 * "step N of N" forever (the clamp hid that the steps were exhausted). This
 * classifies the real phase so each surface can name a truthful terminal/starting
 * state instead of a stuck step counter.
 *   'starting'   — running but no plan yet (spinning up)
 *   'building'   — genuinely on a step (stepIndex within the plan)
 *   'finishing'  — every step consumed (stepIndex >= plan.length), wrapping up
 */
export type BuildPhase = 'starting' | 'building' | 'finishing'
export function buildPhase(p: Project): BuildPhase {
  if (p.plan.length === 0) return 'starting'
  if (p.stepIndex >= p.plan.length) return 'finishing'
  return 'building'
}

/** Compact, honest progress meta for a running project (used by the Desk's
 * "Happening now" line): "step X of Y", "all Y steps done", or "getting started". */
export function buildProgressMeta(p: Project): string {
  const total = p.plan.length
  switch (buildPhase(p)) {
    case 'starting':
      return 'getting started'
    case 'finishing':
      return `all ${total} step${total === 1 ? '' : 's'} done`
    default:
      return `step ${p.stepIndex + 1} of ${total}`
  }
}

export function statusLine(items: DeskItem[], running: Project | undefined): string {
  const parts: string[] = []

  if (items.length > 0) {
    parts.push(
      items.length === 1 ? '1 thing needs your decision' : `${items.length} things need your decision`,
    )
  }

  if (running) {
    const total = running.plan.length
    const detail =
      buildPhase(running) === 'starting'
        ? 'is getting started'
        : buildPhase(running) === 'finishing'
          ? `is finishing up · all ${total} step${total === 1 ? '' : 's'} done`
          : `is mid-build, step ${running.stepIndex + 1} of ${total}`
    parts.push(`${running.name} ${detail}`)
  }

  return parts.join(' · ')
}

/**
 * The Desk's headline pass rate over the last `n` verdicts — or null when there
 * are none. AppStore.tsx's ADD_VERDICT reducer PREPENDS
 * (`verdicts: [v, ...state.verdicts]`), so index 0 is the NEWEST verdict —
 * the "last n" (most recently produced) are `verdicts.slice(0, n)`, not the
 * tail of the array.
 *
 * It returns the whole TALLY, not a bare fraction, because a bare fraction is
 * exactly how three outcomes get published as two. ATTENTION runs (Tier-1 ran
 * over real files and passed, the Tier-2 reviewer dissented) are held out of
 * `decided` — the rate's denominator — and reported as `attention`, which the
 * Desk prints next to the rate. See verdictOutcome.ts :: OutcomeTally.
 */
export function passRate(verdicts: readonly Verdict[], n = 10): OutcomeTally | null {
  if (verdicts.length === 0) return null
  const considered = verdicts.slice(0, n) // newest-first; first n = most recent n
  return tally(considered)
}

/**
 * P7 (honesty): a pass-rate must be COLOURED BY ITS REAL VALUE, never gilded.
 * Achievement-gold is EARNED only at a high rate (>=80%); a middling rate reads
 * amber (warn), a poor one reads red (danger). Returns the chip modifier class.
 */
export function passRateChipClass(rate: number): string {
  if (rate >= 0.8) return 'desk__chip--gold'
  if (rate >= 0.5) return 'desk__chip--passmid'
  return 'desk__chip--passbad'
}

/** A run older than this is not "happening now", whatever else is true. */
export const STALE_RUN_MS = 7 * 24 * 60 * 60 * 1000

export function recentManagerRuns(
  m: ManagersState,
  max = 3,
  now: number = Date.now(),
): { title: string; summary: string; ok: boolean; at: number; stale: boolean }[] {
  // ManagerJob.runs is newest-first (recordJobRun prepends), so runs[0] is
  // each job's latest run. Collect one candidate per job that has run at
  // least once, then sort the whole set by `at` desc.
  const candidates = m.jobs
    .filter((j) => j.runs.length > 0)
    .map((j) => {
      const run = j.runs[0]
      // A run carries its own age. Sukhdeep's desk showed two failures from
      // five weeks earlier under a heading that says "happening now", blaming
      // a local model that had been working again for weeks. The run is still
      // returned — hiding it would lose real information; what was wrong was
      // presenting it as current.
      return {
        title: j.title,
        summary: run.summary,
        ok: run.ok,
        at: run.at,
        stale: now - run.at > STALE_RUN_MS,
      }
    })
  candidates.sort((a, b) => b.at - a.at)
  return candidates.slice(0, max)
}

export function recentProjects(projects: readonly Project[], max = 3): Project[] {
  return [...projects].sort((a, b) => b.createdAt - a.createdAt).slice(0, max)
}

// ---------------------------------------------------------------------------
// Project-loop grouping (P2-4) — "Happening now" groups a project's own
// build/test loops under it instead of lumping them into the single
// free-standing nextDueSchedule line. Mirrors schedules.ts's
// `projectSchedules` filter (`s.projectId === projectId`) inline rather than
// importing it — per this file's header, only TYPES may be imported from
// stores here, and this stays a pure projection of the passed-in lists.
// ---------------------------------------------------------------------------

export interface ProjectLoopGroup {
  projectId: string
  projectName: string
  schedules: Schedule[]
}

/**
 * Every schedule bound to a REAL project (its `projectId` matches one of
 * `projects`), grouped under that project, in `projects`' own order. A
 * project with zero schedules of its own is omitted entirely — only
 * projects that actually own a loop appear. A schedule whose `projectId`
 * matches no known project (the project was deleted, or the id is stale) is
 * NOT grouped here — `freeStandingSchedules` below treats it as
 * free-standing rather than silently dropping it.
 */
export function groupProjectSchedules(
  schedules: readonly Schedule[],
  projects: readonly Project[],
): ProjectLoopGroup[] {
  const groups: ProjectLoopGroup[] = []
  for (const p of projects) {
    const mine = schedules.filter((s) => s.projectId === p.id)
    if (mine.length > 0) groups.push({ projectId: p.id, projectName: p.name, schedules: mine })
  }
  return groups
}

/**
 * Schedules NOT grouped under a real project — no `projectId` set, or one
 * that matches no known project (orphaned by a deleted project). Today,
 * before any project-bound loop is ever added (P2-4 is off by default),
 * every schedule has an unset/empty `projectId`, so this returns the input
 * list unchanged — the byte-identical behavior the Desk's existing
 * `nextDueSchedule` line depends on.
 */
export function freeStandingSchedules(
  schedules: readonly Schedule[],
  projects: readonly Project[],
): Schedule[] {
  const knownIds = new Set(projects.map((p) => p.id))
  return schedules.filter((s) => !s.projectId || !knownIds.has(s.projectId))
}

/**
 * The soonest-due ENABLED schedule. No next-due helper exists on the
 * schedules store (only `dueSchedules`, which answers "is it due NOW") — this
 * derives it from `lastRun + everyMinutes * 60_000`. `lastRun === 0` means
 * "never run", which is due now (`dueInMs: 0`) rather than the arithmetic
 * result of adding an interval to epoch 0.
 */
export function nextDueSchedule(
  schedules: readonly Schedule[],
  now: number,
): { task: string; dueInMs: number } | null {
  let best: { task: string; dueInMs: number } | null = null
  for (const s of schedules) {
    if (!s.enabled) continue
    const dueInMs = s.lastRun === 0 ? 0 : Math.max(0, s.lastRun + s.everyMinutes * 60_000 - now)
    if (best === null || dueInMs < best.dueInMs) best = { task: s.task, dueInMs }
  }
  return best
}
