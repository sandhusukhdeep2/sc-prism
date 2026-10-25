// SC Prism — the Coworker Desk. Mounted in Workspace (no props — it reads
// every store itself, exactly like the header status line above it does
// independently), it surfaces everything that needs the user's decision plus
// a compact snapshot of what's running, how healthy things are, and what
// happened recently. All the real logic (ordering, gating, formatting) lives
// in the pure, unit-tested ../lib/desk — this file only owns the JSX/CSS and
// which store function each button calls.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import {
  buildDeskItems,
  buildProgressMeta,
  freeStandingSchedules,
  groupProjectSchedules,
  nextDueSchedule,
  passRate,
  passRateChipClass,
  proposalEvidenceHead,
  proposalEvidenceRuns,
  proposalReadingLine,
  proposalModelLine,
  proposalTouchLine,
  recentManagerRuns,
  recentProjects,
  rosterHeadLine,
  rosterRoleCapabilityLine,
  rosterRoleModelLine,
  rosterRoleNeedLine,
  rosterRoleRefusedLine,
  type DeskItem,
} from '../lib/desk'
import {
  createFromRoster,
  dismiss as dismissRosterRecord,
  hydrateRostersFromVault,
  persistRostersToVault,
  plannedNames,
  reviewRoster,
  rosterSitOutLine,
  useProjectRosters,
  type RosterRole,
} from '../lib/projectRoster'
import { rosterGate } from '../lib/roster'
import { CAPABILITIES, appRunCapabilities, capabilityLabel, type Capability } from '../lib/delegation'
import {
  createFromProposal,
  dismiss as dismissProposalRecord,
  hydrateProposalsFromVault,
  persistProposalsToVault,
  plannedAgentName,
  useAgentProposals,
  type ReviewedValues,
} from '../lib/agentProposals'
import {
  dismissSet,
  persistQuestionsToVault,
  hydrateQuestionsFromVault,
  recordAnswers,
  saveAnswersToVault,
  useBusinessQuestions,
} from '../lib/businessInterview'
import { persistAgentToVault, useAgents, type AgentModel } from '../lib/agents'
import { useApp } from '../store/AppStore'
import {
  DRIVER_TICK_MS,
  driverStalled,
  driverStalledLine,
  useManagerActions,
  useManagers,
} from '../lib/managers'
import Icon from './Icon'
import { useProjects } from '../lib/projects'
import { useSilenceClock } from '../lib/useNow'
import { useSchedules } from '../lib/schedules'
import { useSettings } from '../lib/settings'
import { downLabel, isEffectivelyDown, probeTargets, useConnectivity } from '../lib/connectivity'
import { notifyNeedsYou } from '../lib/telegramNotify'
import {
  recentTelegramNotes,
  telegramDecidedTargets,
  telegramNoteText,
  useTelegramDecisions,
} from '../lib/telegramApprovals'
import {
  decideApproval,
  dropAlreadyGranted,
  grantToolApproval,
  isNative,
  readHeldToolCalls,
  readMcpApprovals,
  readPendingApprovals,
  readSpansTail,
  resolveVaultDir,
  type HeldToolCall,
  type PendingApproval,
} from '../lib/nativeEngine'
import './Desk.css'

function dueText(ms: number): string {
  if (ms <= 0) return 'due now'
  const m = Math.ceil(ms / 60_000)
  return m < 60 ? `in ${m}m` : `in ${Math.round(m / 60)}h`
}

/** Compact "when" for a held call, computed at render (needs the wall clock). */
function relTime(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Stable session key for one held (server·tool) — the dismiss + dedupe key. */
function heldKey(h: { server: string; tool: string }): string {
  return `${h.server} ${h.tool}`
}

function rowKey(item: DeskItem): string {
  if (item.kind === 'project-ask' || item.kind === 'project-attention') return `${item.kind}-${item.projectId}`
  if (item.kind === 'dispatch') return `${item.kind}-${item.jobId}`
  if (item.kind === 'tool-approval') return `${item.kind}-${item.server}-${item.tool}`
  if (item.kind === 'live-approval') return `${item.kind}-${item.id}`
  if (item.kind === 'agent-proposal') return `${item.kind}-${item.proposalId}`
  if (item.kind === 'roster-proposal') return `${item.kind}-${item.rosterId}`
  if (item.kind === 'business-question') return `${item.kind}-${item.setId}`
  return item.kind // connectivity — buildDeskItems emits at most one of each
}

export interface ToolNotice {
  kind: 'ok' | 'error'
  text: string
}

// Held-tool read, DEDUPED across the concurrent `useDeskState` instances that
// mount together: the Workspace header status line, the always-visible
// <Desk show="needs">, and (when expanded) <Desk show="rest">. Each instance
// keeps its own held/vault React state, but the underlying vault I/O
// (resolveVaultDir + readSpansTail + readMcpApprovals) is shared — the FIRST
// caller for a vault path starts the read and every concurrent caller reuses
// that same in-flight promise, so the span tail is read ONCE per poll cycle
// instead of the 2-3× it was. The map entry clears the moment the read settles,
// so the next ~4s poll starts a fresh read: the refresh cadence and the
// dismiss/granted-filter logic are all unchanged — only the duplicate I/O is
// removed. Keyed by the raw vaultPath (what callers pass), which resolveVaultDir
// maps deterministically to a directory.
interface HeldRead {
  vault: string
  held: HeldToolCall[]
  // Live blocking-approval requests (paused runs). Folded into THIS shared read
  // rather than a 3rd concurrent poller — the desk's single ~4s native poll now
  // covers held spans, the approval policy, AND the pending dir in one pass.
  pending: PendingApproval[]
}
// Session-local decision sets, MODULE-level (2026-08-28). The Work page runs
// TWO Desk hook instances — the header's count and the rail's rows. When these
// were per-instance useState, a Dismiss or an Approve mutated only the
// instance whose button was clicked: the header kept counting an item the rail
// had already dropped, "1 thing needs your decision" over zero rows, forever.
// One shared copy is the only shape in which the two surfaces CANNOT drift;
// useSyncExternalStore keeps every mounted instance live on the same set.
let sharedDismissed: ReadonlySet<string> = new Set()
let sharedDecidedIds: ReadonlySet<string> = new Set()
const deskSetSubs = new Set<() => void>()
function subscribeDeskSets(fn: () => void): () => void {
  deskSetSubs.add(fn)
  return () => {
    deskSetSubs.delete(fn)
  }
}
const readDismissed = (): ReadonlySet<string> => sharedDismissed
const readDecidedIds = (): ReadonlySet<string> => sharedDecidedIds
function updateDismissed(up: (prev: ReadonlySet<string>) => ReadonlySet<string>): void {
  sharedDismissed = up(sharedDismissed)
  deskSetSubs.forEach((f) => f())
}
function updateDecidedIds(up: (prev: ReadonlySet<string>) => ReadonlySet<string>): void {
  sharedDecidedIds = up(sharedDecidedIds)
  deskSetSubs.forEach((f) => f())
}
/** Test-only: module state outlives a render — scenarios need a fresh start. */
export function resetDeskDecisionSets(): void {
  sharedDismissed = new Set()
  sharedDecidedIds = new Set()
  deskSetSubs.forEach((f) => f())
}

const heldReadInFlight = new Map<string, Promise<HeldRead>>()

function readHeldForVault(vaultPath: string): Promise<HeldRead> {
  const existing = heldReadInFlight.get(vaultPath)
  if (existing) return existing
  const promise = (async (): Promise<HeldRead> => {
    try {
      const v = await resolveVaultDir(vaultPath)
      const [spans, policy, pending] = await Promise.all([
        readSpansTail(v),
        readMcpApprovals(v),
        readPendingApprovals(v),
      ])
      return {
        vault: v,
        // Both policy fields: `require` can demand the read-only class back
        // (a user who tightened to hold-everything), and the desk must mirror
        // the gate's precedence rather than a stale grant.
        held: dropAlreadyGranted(readHeldToolCalls(spans), policy.granted, policy.require),
        pending,
      }
    } finally {
      heldReadInFlight.delete(vaultPath)
    }
  })()
  heldReadInFlight.set(vaultPath, promise)
  return promise
}

export function useDeskState() {
  const { state } = useApp()
  const managers = useManagers()
  const { projects } = useProjects()
  const { settings } = useSettings()
  const connectivity = useConnectivity()

  // Held MCP tool calls (real held spans off the vault's span tail). Native
  // only — the browser reads nothing, so no tool-approval items ever appear.
  // `dismissed` is a session-local set of held keys the user hid or approved;
  // `toolNotice` is the honest confirmation/error after an Approve. We also
  // cross-check the CURRENT approval policy here: `dismissed` is session-local
  // and resets on a Desk remount, so without this an already-granted tool
  // (approved in an earlier session, or elsewhere) would re-surface as "held
  // for your approval" even though it would NOT be held on the next run —
  // dishonest. `dropAlreadyGranted` filters those out so an item appears ONLY
  // when the tool still genuinely needs approval.
  const [held, setHeld] = useState<HeldToolCall[]>([])
  const [vault, setVault] = useState('')
  const dismissed = useSyncExternalStore(subscribeDeskSets, readDismissed)
  const [toolNotice, setToolNotice] = useState<ToolNotice | null>(null)

  // Live blocking-approval requests (paused runs). `pending` is the last read of
  // the vault's approvals/pending dir; `decidedIds` is a session-local set of
  // request ids the user already answered this session — an optimistic removal
  // so a click never leaves a ghost row in the ~4s gap before the next poll
  // re-reads the (now engine-cleaned) pending set. A request that VANISHES
  // (the engine's timeout resolved it) drops naturally: the next poll's set no
  // longer contains it. Native only — the browser reads nothing.
  const [pending, setPending] = useState<PendingApproval[]>([])
  const decidedIds = useSyncExternalStore(subscribeDeskSets, readDecidedIds)

  // Proposed agents (2026-08-11 spec). The store is the ONLY place a proposal
  // lives until Create is tapped — nothing here is in the agent library, in any
  // count, or in any stat. The vault ledger is merged in once per vault path so
  // a proposal (and a dismissal) survives a restart; the merge is by id/name, so
  // the concurrent Desk instances calling it are idempotent.
  const proposals = useAgentProposals()
  useEffect(() => {
    if (!isNative()) return
    void hydrateProposalsFromVault(settings.vaultPath)
  }, [settings.vaultPath])

  // Business questions (2026-08-15 spec §4). Same shape as the proposals above:
  // the store holds QUESTIONS (never facts), and the vault ledger is merged in
  // so a dismissed set cannot come back after a restart. The ANSWERS never live
  // here — they go straight to the vault note, which is the only memory.
  const questionSets = useBusinessQuestions()
  useEffect(() => {
    if (!isNative()) return
    void hydrateQuestionsFromVault(settings.vaultPath)
  }, [settings.vaultPath])

  // Project rosters (2026-08-15 spec). Identical law to the proposals above,
  // at team scale: nothing here is an agent until the ONE Create is tapped.
  const rosters = useProjectRosters()
  useEffect(() => {
    if (!isNative()) return
    void hydrateRostersFromVault(settings.vaultPath)
  }, [settings.vaultPath])

  // The ceiling on every grant this desk can hand out — the SAME definition the
  // team launcher threads to the engine, so what a row promises and what the
  // engine enforces are one list. A row can never be created holding more.
  const userGrants = appRunCapabilities(settings)

  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    const fetchHeld = async () => {
      try {
        // Shared, deduped read (see readHeldForVault above): concurrent Desk
        // instances reuse ONE in-flight vault read instead of each polling it.
        const { vault: v, held: h, pending: p } = await readHeldForVault(settings.vaultPath)
        if (cancelled) return
        setVault(v)
        setHeld(h)
        setPending(p)
      } catch {
        // best-effort: a failed span or policy read just leaves the desk without held items
      }
    }
    void fetchHeld()
    const t = setInterval(() => void fetchHeld(), 4000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [settings.vaultPath])

  // Auto-clear the confirmation/error after a few seconds (the × also clears it).
  useEffect(() => {
    if (!toolNotice) return
    const t = setTimeout(() => setToolNotice(null), 6000)
    return () => clearTimeout(t)
  }, [toolNotice])

  const visibleHeld = held.filter((h) => !dismissed.has(heldKey(h)))

  // Approve = grant this tool in <vault>/mcp-approvals.json for the NEXT run.
  // Honesty: the already-held call already returned and the run finished — this
  // never re-runs it, it only permits future runs. On success we hide every
  // held row for that tool name and confirm truthfully; on failure we say so.
  const approveTool = useCallback(
    async (name: string) => {
      const ok = await grantToolApproval(vault, name)
      if (ok) {
        updateDismissed((prev) => {
          const next = new Set(prev)
          for (const h of held) if (h.tool === name) next.add(heldKey(h))
          return next
        })
        setToolNotice({ kind: 'ok', text: `Approved — ${name} will be allowed on your next run.` })
      } else {
        setToolNotice({ kind: 'error', text: `Couldn't save approval for ${name} — the installed app is required.` })
      }
    },
    [vault, held],
  )

  // Dismiss = local-only hide for this session. The tool stays ungranted, so it
  // will be held again on the next run (correct — dismiss is not approval).
  const dismissTool = useCallback((key: string) => {
    updateDismissed((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }, [])

  const clearToolNotice = useCallback(() => setToolNotice(null), [])

  // Decisions that arrived from the PHONE (2026-08-11 spec). The desk shows
  // them as such — source + when — so the app and the phone never silently
  // disagree, and a tap that landed too late says exactly that instead of
  // looking like it worked.
  const telegramNotes = recentTelegramNotes(useTelegramDecisions(), Date.now())

  // Paused runs still awaiting a decision this session (an answered request is
  // hidden immediately via decidedIds; a vanished one drops when the next poll
  // no longer returns it). A request answered FROM TELEGRAM is hidden the same
  // way — the decision is already written, so leaving the row would be a lie.
  const phoneDecided = telegramDecidedTargets()
  const visiblePending = pending.filter((p) => !decidedIds.has(p.id) && !phoneDecided.has(p.id))

  // Approve / Deny a paused run: write the decision to the vault (atomic) so the
  // engine resumes — "allow" runs the tool, "deny" honestly does not. The row is
  // removed OPTIMISTICALLY (before the write settles) so a click never leaves a
  // ghost; on a failed write (e.g. no native shell) the run is still paused, so
  // we restore the row and say so honestly rather than pretend it resolved.
  const decideApprovalAction = useCallback(
    async (id: string, decision: 'allow' | 'deny') => {
      updateDecidedIds((prev) => new Set(prev).add(id))
      const ok = await decideApproval(vault, id, decision)
      if (!ok) {
        updateDecidedIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        setToolNotice({ kind: 'error', text: "Couldn't send your decision — the installed app is required." })
      }
    },
    [vault],
  )

  // CREATE — the human's tap, and the only thing in the app that turns a
  // proposal into an agent. It writes exactly the values passed in (the
  // reviewed originals, or what "Edit first" edited them to), then persists the
  // ledger vault-side so the audit trail records what was really created. The
  // confirmation says plainly that the new agent has no history yet.
  const createProposedAgent = useCallback(
    (id: string, values: ReviewedValues) => {
      const agent = createFromProposal(id, values, Date.now())
      if (!agent) {
        setToolNotice({ kind: 'error', text: "That proposal was already decided — nothing was created." })
        return
      }
      // The born-complete definition file, immediately — not waiting for the
      // next page sync (research-first creation, 2026-08-29).
      void persistAgentToVault(agent, settings.vaultPath)
      void persistProposalsToVault(settings.vaultPath)
      setToolNotice({
        kind: 'ok',
        text: `Created ${agent.name} — it's in your agents now, with no runs yet.`,
      })
    },
    [settings.vaultPath],
  )

  // DISMISS — sticky by design: the record survives (status 'dismissed') so the
  // same role is never proposed again. Not a session-local hide like the held
  // tool rows above.
  const dismissProposal = useCallback(
    (id: string) => {
      dismissProposalRecord(id, Date.now())
      void persistProposalsToVault(settings.vaultPath)
    },
    [settings.vaultPath],
  )

  // CREATE THE ROSTER — ONE tap, the whole team. Writes exactly the rows the
  // human reviewed (edited or original), clamped twice on the way through:
  // a seat whose AI can't answer is not created (and is named), and every grant
  // is intersected with the user's own. Nothing is spent beyond this approval.
  const createProposedRoster = useCallback(
    (id: string, rows: readonly RosterRole[]) => {
      const out = createFromRoster(
        id,
        rows,
        { gate: rosterGate(settings, { health: connectivity.health }), userGrants },
        Date.now(),
      )
      if (!out) {
        setToolNotice({ kind: 'error', text: 'That roster was already decided — nothing was created.' })
        return
      }
      void persistRostersToVault(settings.vaultPath)
      if (out.created.length === 0) {
        setToolNotice({
          kind: 'error',
          text: `Nothing was created — ${rosterSitOutLine(out.sitOut)}`,
        })
        return
      }
      const names = out.created.map((a) => a.name).join(', ')
      const sat = out.sitOut.length ? ` · ${rosterSitOutLine(out.sitOut)}` : ''
      setToolNotice({
        kind: 'ok',
        text: `Created ${out.created.length} agent${out.created.length === 1 ? '' : 's'}: ${names} — no runs yet.${sat}`,
      })
    },
    [settings, connectivity.health, userGrants],
  )

  // DISMISS — sticky, exactly like a dismissed agent proposal.
  const dismissRoster = useCallback(
    (id: string) => {
      dismissRosterRecord(id, Date.now())
      void persistRostersToVault(settings.vaultPath)
    },
    [settings.vaultPath],
  )

  // ANSWER — his own words, written to the vault note that is the companion's
  // only memory of this business. Honest in both directions: only the questions
  // he actually typed an answer to are recorded, and if the WRITE fails we say
  // so plainly, because the answers would then exist nowhere.
  const answerQuestions = useCallback(
    async (id: string, answers: string[]) => {
      const pairs = recordAnswers(id, answers, Date.now())
      void persistQuestionsToVault(settings.vaultPath)
      if (pairs.length === 0) {
        setToolNotice({ kind: 'ok', text: 'Closed — nothing was recorded, so nothing changed.' })
        return
      }
      const ok = await saveAnswersToVault(pairs, settings.vaultPath, Date.now())
      setToolNotice(
        ok
          ? {
              kind: 'ok',
              text: `Saved ${pairs.length} answer${pairs.length === 1 ? '' : 's'} to business/context.md — that note is all it remembers.`,
            }
          : {
              kind: 'error',
              text: "Couldn't write business/context.md — your answers were NOT saved. The installed app is required.",
            },
      )
    },
    [settings.vaultPath],
  )

  // DISMISS — sticky, like a dismissed proposal: those questions are never
  // asked again, and nothing about them is recorded as knowledge.
  const dismissQuestions = useCallback(
    (id: string) => {
      dismissSet(id, Date.now())
      void persistQuestionsToVault(settings.vaultPath)
    },
    [settings.vaultPath],
  )

  // Same trio ConnectivityBanner.tsx uses, so the desk's copy matches the
  // banner's exactly — they never render together (buildDeskItems gates the
  // connectivity item on anyDown && bannerDismissed; the banner covers the
  // un-dismissed case).
  const down = probeTargets(settings).filter((p) => isEffectivelyDown(connectivity.health[p.id]))
  const first = down[0]
  const firstHealth = first ? connectivity.health[first.id] : undefined
  const firstStatus = firstHealth?.status === 'checking' ? firstHealth.prev : firstHealth?.status
  const downSummary = first
    ? `${first.name} — ${downLabel(first, firstStatus)}${down.length > 1 ? ` (+${down.length - 1} more)` : ''}`
    : ''

  const items = buildDeskItems({
    managers,
    projects,
    notices: state.notices,
    anyDown: connectivity.anyDown,
    bannerDismissed: connectivity.bannerDismissed,
    downSummary,
    heldToolCalls: visibleHeld,
    pendingApprovals: visiblePending,
    proposals,
    rosters,
    questionSets,
  })

  // Telegram courtesy nudge — fed the SAME aggregated count the header prints.
  // It used to count only held+pending: a third private definition of the
  // number, matching neither the header nor the rail. Module-level dedupe in
  // notifyNeedsYou fires only when the count INCREASES, so approving or
  // dismissing items never re-pings the phone.
  useEffect(() => {
    notifyNeedsYou(items.length)
  }, [items.length])

  const running = projects.find((p) => p.status === 'running')

  return {
    items,
    down,
    running,
    approveTool,
    dismissTool,
    decideApprovalAction,
    createProposedAgent,
    dismissProposal,
    createProposedRoster,
    dismissRoster,
    answerQuestions,
    dismissQuestions,
    userGrants,
    // The SAME seat test the create path uses, so what the row warns about and
    // what Create really does can never disagree.
    gate: rosterGate(settings, { health: connectivity.health }),
    toolNotice,
    telegramNotes,
    clearToolNotice,
  }
}

/**
 * The companion's questions about the business — its own row, because it owns
 * one input per question plus the two-step dismiss confirm.
 *
 * Everything here is a QUESTION. The row says so out loud: nothing is recorded
 * until the user types an answer, an answer he leaves blank is not stored at
 * all, and the row names the file his words go into — `business/context.md`,
 * which is the only thing the companion remembers about the business.
 */
function QuestionRow({
  item,
  onAnswer,
  onDismiss,
}: {
  item: Extract<DeskItem, { kind: 'business-question' }>
  onAnswer: (id: string, answers: string[]) => void
  onDismiss: (id: string) => void
}) {
  const set = item.set
  const [answers, setAnswers] = useState<string[]>(() => set.questions.map(() => ''))
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const anyAnswered = answers.some((a) => a.trim() !== '')

  return (
    <div className="desk__row desk__row--question">
      <div className="desk__rowtext">
        <span className="desk__rowtitle">{item.title}</span>
        <span className="desk__rowdetail">{item.detail}</span>
        {set.questions.map((q, i) => (
          <label key={q} className="desk__proplabel">
            {q}
            <input
              className="desk__propinput"
              value={answers[i] ?? ''}
              aria-label={q}
              onChange={(e) =>
                setAnswers((prev) => {
                  const next = [...prev]
                  next[i] = e.target.value
                  return next
                })
              }
            />
          </label>
        ))}
        <span className="desk__propnote">
          Your words go into business/context.md — that note is all it remembers about your
          business. A question you leave blank is not recorded as anything.
        </span>
      </div>
      <div className="desk__rowactions">
        {confirmDismiss ? (
          <>
            <span className="desk__propconfirmq">Dismiss for good?</span>
            <button type="button" className="desk__btn desk__btn--no" onClick={() => onDismiss(set.id)}>
              Yes, dismiss
            </button>
            <button type="button" className="desk__btn" onClick={() => setConfirmDismiss(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="desk__btn desk__btn--yes"
              disabled={!anyAnswered}
              title={anyAnswered ? 'save these answers' : 'answer at least one question first'}
              onClick={() => onAnswer(set.id, answers)}
            >
              Save answers
            </button>
            <button type="button" className="desk__btn" onClick={() => setConfirmDismiss(true)}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The review row for a PROPOSED agent — its own component (not a DeskRow
 * branch) because it owns three pieces of local state no other row has: the
 * edit-first form, and the two-step dismiss confirm.
 *
 * What it shows is the whole point, and it shows the two kinds of content
 * SEPARATELY: the manager's CLAIMS (purpose, why that model, its reading of the
 * evidence — all free text the model wrote) and the FACTS (each cited run
 * resolved against this app's own verdict log: task, pass/fail, when). A model
 * sentence must never be able to read as a citation, so they never share a
 * block. What this row does NOT do is create anything — until Create is tapped
 * the proposal exists only here and in the ledger, never in the agent library.
 */
function ProposalRow({
  item,
  onCreate,
  onDismiss,
}: {
  item: Extract<DeskItem, { kind: 'agent-proposal' }>
  onCreate: (id: string, values: ReviewedValues) => void
  onDismiss: (id: string) => void
}) {
  const p = item.proposal
  // The REAL run history — the row resolves every cited id against it, so the
  // evidence shown is the app's own record and not the model's description of it.
  const { state } = useApp()
  const agents = useAgents()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(p.name)
  const [purpose, setPurpose] = useState(p.purpose)
  const [model, setModel] = useState<AgentModel>(p.model)
  const [skills, setSkills] = useState(p.skills.join(', '))
  // Two-step confirm (the desk's idiom for a decision with no undo): Dismiss is
  // STICKY — the same proposal never comes back — so one stray click must not
  // spend it.
  const [confirmDismiss, setConfirmDismiss] = useState(false)

  const edited: ReviewedValues = {
    name: name.trim(),
    purpose: purpose.trim(),
    model,
    skills: skills.split(',').map((s) => s.trim()).filter(Boolean),
  }
  const original: ReviewedValues = {
    name: p.name,
    purpose: p.purpose,
    model: p.model,
    skills: p.skills,
  }

  // The evidence, resolved against the real verdict log (facts), and the
  // manager's own note about it (a claim) — kept apart on purpose.
  const runs = proposalEvidenceRuns(p, state.verdicts)
  const head = proposalEvidenceHead(p, runs.filter((r) => r.found).length)
  const reading = proposalReadingLine(p)

  // What Create would REALLY name this agent: the library is checked BEFORE the
  // tap, so a collision is visible rather than a surprise afterwards.
  const wanted = (editing ? edited.name : original.name).trim()
  const planned = plannedAgentName(wanted, agents)
  const collision = wanted && planned !== wanted ? planned : ''

  return (
    <div className="desk__row desk__row--proposal">
      <div className="desk__rowtext">
        <span className="desk__rowtitle">{item.title}</span>
        {/* The manager's CLAIMS — free text it wrote. Labelled as such. */}
        <span className="desk__propclaimhead">what the manager says</span>
        <span className="desk__rowdetail desk__propclaim">{item.detail}</span>
        <span className="desk__propmeta desk__propclaim">{proposalModelLine(p)}</span>
        <span className="desk__propmeta desk__propclaim">{proposalTouchLine(p)}</span>
        {reading && <span className="desk__propmeta desk__propclaim">{reading}</span>}
        {/* The FACTS — read out of this app's own run history. */}
        <span className="desk__propevidencehead">{head}</span>
        {runs.map((r) => (
          <span
            key={r.ref}
            className={'desk__propevidence mono' + (r.found ? '' : ' desk__propevidence--gone')}
          >
            {r.text}
          </span>
        ))}
        {collision && (
          <span className="desk__propwarn">
            An agent called “{wanted}” already exists — Create will name this one “{collision}”.
          </span>
        )}
        <span className="desk__propnote">
          Not created yet — it appears in your agents only when you tap Create.
        </span>
        {editing && (
          <div className="desk__propform">
            <label className="desk__proplabel">
              name
              <input
                className="desk__propinput"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="Agent name"
              />
            </label>
            <label className="desk__proplabel">
              what it does
              <input
                className="desk__propinput"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                aria-label="What it does"
              />
            </label>
            <label className="desk__proplabel">
              model
              <select
                className="desk__propinput"
                value={model}
                onChange={(e) => setModel(e.target.value as AgentModel)}
                aria-label="Model"
              >
                <option value="claude">claude</option>
                <option value="gemini">gemini</option>
                <option value="local">local</option>
              </select>
            </label>
            <label className="desk__proplabel">
              skills
              <input
                className="desk__propinput"
                value={skills}
                onChange={(e) => setSkills(e.target.value)}
                aria-label="Skills"
              />
            </label>
          </div>
        )}
      </div>
      <div className="desk__rowactions">
        {editing ? (
          <>
            <button
              type="button"
              className="desk__btn desk__btn--yes"
              disabled={!edited.name}
              onClick={() => onCreate(p.id, edited)}
            >
              Create with these
            </button>
            <button type="button" className="desk__btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : confirmDismiss ? (
          <>
            <span className="desk__propconfirmq">Dismiss for good?</span>
            <button
              type="button"
              className="desk__btn desk__btn--no"
              onClick={() => onDismiss(p.id)}
            >
              Yes, dismiss
            </button>
            <button type="button" className="desk__btn" onClick={() => setConfirmDismiss(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="desk__btn desk__btn--yes"
              onClick={() => onCreate(p.id, original)}
            >
              Create
            </button>
            <button type="button" className="desk__btn" onClick={() => setEditing(true)}>
              Edit first
            </button>
            <button type="button" className="desk__btn" onClick={() => setConfirmDismiss(true)}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The review row for a PROPOSED PROJECT ROSTER (2026-08-15 spec) — the whole
 * team on one card, and ONE Create for all of it.
 *
 * Every row states four things and hides none of them: the role, WHICH AI it
 * would run on (and why), the CAPABILITIES it would actually get, and the
 * project's own need it exists for, quoted verbatim. Two clamps are visible
 * before the tap, not discovered after it:
 *   • a capability the USER does not hold is struck through with the reason —
 *     the manager asked, and it cannot be given;
 *   • a seat whose AI cannot answer on this Mac is marked "can't be staffed"
 *     with the provider's own reason and will not be created.
 * Editing a row edits what Create writes — the originals are never used once a
 * value has been changed.
 */
function RosterRow({
  item,
  userGrants,
  gate,
  onCreate,
  onDismiss,
}: {
  item: Extract<DeskItem, { kind: 'roster-proposal' }>
  userGrants: readonly Capability[]
  gate: (token: string) => string
  onCreate: (id: string, rows: readonly RosterRole[]) => void
  onDismiss: (id: string) => void
}) {
  const r = item.roster
  const agents = useAgents()
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<RosterRole[]>(() => r.roles.map((x) => ({ ...x })))
  const [confirmDismiss, setConfirmDismiss] = useState(false)

  // What Create would REALLY do with these values, right now.
  const source = editing ? rows : r.roles
  const { rows: reviewed, sitOut } = reviewRoster(source, { gate, userGrants })
  const willCreate = reviewed.filter((row) => !row.sitOutReason)
  const planned = plannedNames(
    willCreate.map((row) => row.role),
    agents,
  )

  const patch = (i: number, next: Partial<RosterRole>) =>
    setRows((prev) => prev.map((row, j) => (j === i ? { ...row, ...next } : row)))

  const toggleCap = (i: number, cap: Capability) =>
    patch(i, {
      capabilities: rows[i].capabilities.includes(cap)
        ? rows[i].capabilities.filter((c) => c !== cap)
        : [...rows[i].capabilities, cap],
    })

  return (
    <div className="desk__row desk__row--proposal">
      <div className="desk__rowtext">
        <span className="desk__rowtitle">{item.title}</span>
        <span className="desk__rowdetail">{item.detail}</span>
        <span className="desk__propmeta">{rosterHeadLine(r)}</span>
        {reviewed.map((row, i) => (
          <div key={`${row.role.name}-${i}`} className="desk__rosterrow">
            <span className="desk__rostername">
              {row.role.name}
              {planned[i] && planned[i] !== row.role.name && !row.sitOutReason && (
                <span className="desk__propwarn"> → will be created as “{planned[i]}”</span>
              )}
            </span>
            <span className="desk__propmeta desk__propclaim">{row.role.purpose}</span>
            <span className="desk__propmeta desk__propclaim mono">
              {rosterRoleModelLine(row.role)}
            </span>
            <span className="desk__propmeta mono">{rosterRoleCapabilityLine(row)}</span>
            {rosterRoleRefusedLine(row) && (
              <span className="desk__propwarn mono">{rosterRoleRefusedLine(row)}</span>
            )}
            <span className="desk__propevidence">{rosterRoleNeedLine(row.role)}</span>
            {row.sitOutReason && (
              <span className="desk__propwarn">
                can’t be staffed — {row.sitOutReason}. This role will NOT be created.
              </span>
            )}
            {editing && (
              <div className="desk__propform">
                <label className="desk__proplabel">
                  role
                  <input
                    className="desk__propinput"
                    value={rows[i].name}
                    onChange={(e) => patch(i, { name: e.target.value })}
                    aria-label={`Role ${i + 1} name`}
                  />
                </label>
                <label className="desk__proplabel">
                  what it does
                  <input
                    className="desk__propinput"
                    value={rows[i].purpose}
                    onChange={(e) => patch(i, { purpose: e.target.value })}
                    aria-label={`Role ${i + 1} purpose`}
                  />
                </label>
                <label className="desk__proplabel">
                  which AI
                  <select
                    className="desk__propinput"
                    value={rows[i].model}
                    onChange={(e) => patch(i, { model: e.target.value as AgentModel })}
                    aria-label={`Role ${i + 1} AI`}
                  >
                    <option value="claude">claude</option>
                    <option value="gemini">gemini</option>
                    <option value="local">local</option>
                  </select>
                </label>
                <div className="desk__proplabel">
                  may
                  {CAPABILITIES.map((cap) => {
                    const held = userGrants.includes(cap)
                    return (
                      <label key={cap} className="desk__capbox">
                        <input
                          type="checkbox"
                          checked={rows[i].capabilities.includes(cap)}
                          disabled={!held}
                          onChange={() => toggleCap(i, cap)}
                          aria-label={`Role ${i + 1} ${cap}`}
                        />
                        <span className={held ? '' : 'desk__capoff'}>{capabilityLabel(cap)}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
        {sitOut.length > 0 && !editing && (
          <span className="desk__propwarn">{rosterSitOutLine(sitOut)}</span>
        )}
        <span className="desk__propnote">
          Not created yet — these appear in your agents only when you tap Create, and one tap
          creates all {willCreate.length} of them.
        </span>
      </div>
      <div className="desk__rowactions">
        {editing ? (
          <>
            <button
              type="button"
              className="desk__btn desk__btn--yes"
              disabled={willCreate.length === 0}
              onClick={() => onCreate(r.id, rows)}
            >
              Create these {willCreate.length}
            </button>
            <button
              type="button"
              className="desk__btn"
              onClick={() => {
                setRows(r.roles.map((x) => ({ ...x })))
                setEditing(false)
              }}
            >
              Cancel
            </button>
          </>
        ) : confirmDismiss ? (
          <>
            <span className="desk__propconfirmq">Dismiss for good?</span>
            <button type="button" className="desk__btn desk__btn--no" onClick={() => onDismiss(r.id)}>
              Yes, dismiss
            </button>
            <button type="button" className="desk__btn" onClick={() => setConfirmDismiss(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="desk__btn desk__btn--yes"
              disabled={willCreate.length === 0}
              onClick={() => onCreate(r.id, r.roles)}
            >
              Create all {willCreate.length}
            </button>
            <button type="button" className="desk__btn" onClick={() => setEditing(true)}>
              Edit first
            </button>
            <button type="button" className="desk__btn" onClick={() => setConfirmDismiss(true)}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function DeskRow({
  item,
  onAnswer,
  onResume,
  onApproveDispatch,
  onRejectDispatch,
  onApproveTool,
  onDismissTool,
  onDecideApproval,
  onRetry,
  retryBusy,
}: {
  item: DeskItem
  onAnswer: (grant: boolean) => void
  onResume: (projectId: string) => void
  onApproveDispatch: (jobId: string) => void
  onRejectDispatch: (jobId: string) => void
  onApproveTool: (name: string) => void
  onDismissTool: (key: string) => void
  onDecideApproval: (id: string, decision: 'allow' | 'deny') => void
  onRetry: () => void
  retryBusy: boolean
}) {
  // A live-approval (a run paused RIGHT NOW) leads the rail and reads as urgent.
  const isLive = item.kind === 'live-approval'
  return (
    <div className={'desk__row' + (isLive ? ' desk__row--live' : '')}>
      <div className="desk__rowtext">
        <span className="desk__rowtitle">{item.title}</span>
        <span className="desk__rowdetail">
          {item.detail}
          {(item.kind === 'tool-approval' || item.kind === 'live-approval') && item.at != null && (
            <span className="desk__rowtime mono"> · {relTime(item.at)}</span>
          )}
        </span>
      </div>
      <div className="desk__rowactions">
        {item.kind === 'live-approval' && (
          <>
            {/* Approve → the tool ACTUALLY runs (the engine resumes and delegates
                to the inner, still-gated call). Deny → it is honestly NOT run and
                the run continues. Not "grant for next time" — this decides the
                run that is blocked at this instant. */}
            <button
              type="button"
              className="desk__btn desk__btn--yes"
              onClick={() => onDecideApproval(item.id, 'allow')}
            >
              Approve
            </button>
            <button
              type="button"
              className="desk__btn desk__btn--no"
              onClick={() => onDecideApproval(item.id, 'deny')}
            >
              Deny
            </button>
          </>
        )}
        {item.kind === 'project-ask' && (
          <>
            <button type="button" className="desk__btn desk__btn--yes" onClick={() => onAnswer(true)}>
              Yes
            </button>
            <button type="button" className="desk__btn desk__btn--no" onClick={() => onAnswer(false)}>
              No
            </button>
            {/* Resume fallback (B4): after a reload the parked driver is gone,
                so Yes/No above would no-op — Resume re-parks the ask with a
                live driver behind it. Mirrors Projects.tsx's dual affordance
                for status 'awaiting' (proj__startbtn + proj__askbanner both
                shown together). */}
            <button type="button" className="desk__btn" onClick={() => onResume(item.projectId)}>
              Resume
            </button>
          </>
        )}
        {item.kind === 'dispatch' && (
          <>
            <button
              type="button"
              className="desk__btn desk__btn--yes"
              onClick={() => onApproveDispatch(item.jobId)}
            >
              Approve
            </button>
            <button type="button" className="desk__btn desk__btn--no" onClick={() => onRejectDispatch(item.jobId)}>
              Reject
            </button>
          </>
        )}
        {item.kind === 'tool-approval' && (
          <>
            <button
              type="button"
              className="desk__btn desk__btn--yes"
              onClick={() => onApproveTool(item.name)}
            >
              Approve
            </button>
            <button
              type="button"
              className="desk__btn"
              onClick={() => onDismissTool(`${item.server} ${item.tool}`)}
            >
              Dismiss
            </button>
          </>
        )}
        {item.kind === 'project-attention' && (
          <button type="button" className="desk__btn" onClick={() => onResume(item.projectId)}>
            Resume
          </button>
        )}
        {item.kind === 'connectivity' && (
          <>
            <button type="button" className="desk__btn" onClick={onRetry} disabled={retryBusy}>
              {retryBusy ? 'checking…' : 'Retry'}
            </button>
            <Link to="/providers" className="desk__btn desk__btn--link">
              Open Providers ›
            </Link>
          </>
        )}
      </div>
    </div>
  )
}

// `show` lets the Work page split the desk: 'needs' renders only the urgent
// "Needs you" decisions (kept always-visible), 'rest' renders the ambient
// Happening/Health/Catch-up (tucked behind a collapse), 'all' (default) is the
// whole desk for any other caller.
export default function Desk({
  show = 'all',
  now: fixedNow,
}: {
  show?: 'all' | 'needs' | 'rest'
  /** Injected wall clock (tests). Omitted → a slow tick while a manager is on. */
  now?: number
}) {
  const { state, answerProjectRequest, runProject } = useApp()
  const managers = useManagers()
  const { approve, reject } = useManagerActions()
  const { projects } = useProjects()
  const schedules = useSchedules()
  const { settings } = useSettings()
  const connectivity = useConnectivity()
  const [connBusy, setConnBusy] = useState(false)

  const {
    items,
    down,
    running: runningProject,
    approveTool,
    dismissTool,
    decideApprovalAction,
    createProposedAgent,
    dismissProposal,
    createProposedRoster,
    dismissRoster,
    answerQuestions,
    dismissQuestions,
    toolNotice,
    telegramNotes,
    clearToolNotice,
    userGrants,
    gate,
  } = useDeskState()

  const retry = async () => {
    setConnBusy(true)
    try {
      await connectivity.probeAll()
    } finally {
      setConnBusy(false)
    }
  }

  // --- Happening now ---
  const enabledManagers = managers.managers.filter((m) => m.enabled)
  const lastManagerRun = recentManagerRuns(managers, 1)[0]
  // Project-bound build/test loops (P2-4) group under their project instead
  // of feeding the single free-standing nextDueSchedule line below. Before
  // any project loop is ever added, every schedule is free-standing, so
  // `projectLoops` is [] and `nextDue` is computed over the exact same list
  // as before — byte-identical when the feature is unused.
  const projectLoops = groupProjectSchedules(schedules, projects)
  const nextDue = nextDueSchedule(freeStandingSchedules(schedules, projects), Date.now())
  const hasHappeningNow =
    Boolean(runningProject) || enabledManagers.length > 0 || Boolean(nextDue) || projectLoops.length > 0

  // --- Health (vault name + engine mode are structural facts — always
  // present — so this section never actually renders empty; the whole-desk
  // null check below only needs to weigh the three dynamic sections). ---
  const providersSummary =
    down.length > 0 ? `${down.length} AI ${down.length === 1 ? 'service' : 'services'} down` : 'AI connected'
  const vaultName = settings.vaultPath.split('/').filter(Boolean).pop() ?? 'vault'
  const engineMode = isNative() ? 'real engine' : 'simulation'
  const rate = passRate(state.verdicts)

  // --- Catch-up ---
  const catchUpRuns = recentManagerRuns(managers, 3)
  const catchUpProjects = recentProjects(projects, 3)
  const hasCatchUp = catchUpRuns.length > 0 || catchUpProjects.length > 0

  // The "Needs you" slice stays alive while a tool-approval confirmation is
  // showing, even if approving cleared the last item — otherwise the honest
  // "allowed on your next run" note would vanish the instant it appeared. A
  // Telegram-sourced decision keeps it alive for the same reason: the row it
  // answered is gone, and the desk must still say what happened to it.
  // A DEAD MANAGER IS SOMETHING THAT NEEDS YOU. It is not an "activity" line —
  // nothing is happening, that is the whole problem — and it must not wait
  // behind the collapsed ambient desk, which is where a week of silence went
  // unnoticed.
  //
  // Watched only while a manager is switched ON: a manager the user has turned
  // off is supposed to be quiet, and the app must never scold him for a choice
  // he made. The clock is what lets this be seen at all — a stopped loop
  // changes no state, so without it the notice could only appear if something
  // else re-rendered the desk, and by definition nothing else is running.
  // `driverStalled` is called WITHOUT the hook snapshot on purpose: ticks are
  // recorded in live module state and never emitted (they must not re-render
  // the app every 30s), so the snapshot cannot see them.
  const watchingDriver = enabledManagers.length > 0
  const silenceNow = useSilenceClock(watchingDriver, DRIVER_TICK_MS, fixedNow)
  const stalledMs = watchingDriver ? driverStalled(silenceNow) : null
  const showNeeds =
    items.length > 0 || toolNotice != null || telegramNotes.length > 0 || stalledMs != null

  // Nothing to show for this slice → render nothing (so the caller's wrapper
  // can also collapse away).
  if (show === 'needs' && !showNeeds) return null
  if (show === 'rest' && !hasHappeningNow && !hasCatchUp) return null
  if (show === 'all' && !showNeeds && !hasHappeningNow && !hasCatchUp) return null

  return (
    <div className="desk">
      {show !== 'rest' && showNeeds && (
        <section className="desk__section">
          <div className="desk__kicker">Needs you</div>
          {stalledMs != null && (
            <div className="desk__notice desk__notice--err" role="alert">
              <span className="desk__noticetext">{driverStalledLine(stalledMs)}</span>
            </div>
          )}
          {toolNotice && (
            <div className={'desk__notice' + (toolNotice.kind === 'error' ? ' desk__notice--err' : '')}>
              <span className="desk__noticetext">{toolNotice.text}</span>
              <button
                type="button"
                className="desk__noticex"
                onClick={clearToolNotice}
                aria-label="Dismiss message"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )}
          {/* A decision that arrived from the PHONE, shown as such — source +
              when. The app and the phone must never silently disagree: an
              Approve that landed is named as an Approve from Telegram, and a
              tap that arrived after the request timed out says exactly that
              (nothing was decided) instead of looking like it worked. */}
          {telegramNotes.map((n) => (
            <div
              key={`${n.key}-${n.at}`}
              className={'desk__notice' + (n.outcome === 'decided' ? '' : ' desk__notice--err')}
            >
              <span className="desk__noticetext">{telegramNoteText(n)}</span>
              <span className="desk__rowtime mono"> · {relTime(n.at)}</span>
            </div>
          ))}
          <div className="desk__rail">
            {items.map((item) =>
              item.kind === 'agent-proposal' ? (
                <ProposalRow
                  key={rowKey(item)}
                  item={item}
                  onCreate={createProposedAgent}
                  onDismiss={dismissProposal}
                />
              ) : item.kind === 'roster-proposal' ? (
                <RosterRow
                  key={rowKey(item)}
                  item={item}
                  userGrants={userGrants}
                  gate={gate}
                  onCreate={createProposedRoster}
                  onDismiss={dismissRoster}
                />
              ) : item.kind === 'business-question' ? (
                <QuestionRow
                  key={rowKey(item)}
                  item={item}
                  onAnswer={(id, answers) => void answerQuestions(id, answers)}
                  onDismiss={dismissQuestions}
                />
              ) : (
              <DeskRow
                key={rowKey(item)}
                item={item}
                onAnswer={answerProjectRequest}
                onResume={(id) => void runProject(id)}
                onApproveDispatch={(id) => approve(id, Date.now())}
                onRejectDispatch={(id) => reject(id, Date.now())}
                onApproveTool={(name) => void approveTool(name)}
                onDismissTool={dismissTool}
                onDecideApproval={(id, decision) => void decideApprovalAction(id, decision)}
                onRetry={() => void retry()}
                retryBusy={connBusy}
              />
              ),
            )}
          </div>
        </section>
      )}

      {show !== 'needs' && hasHappeningNow && (
        <section className="desk__section">
          <div className="desk__kicker">Happening now</div>
          <div className="desk__now">
            {runningProject && (
              <Link to={`/projects?open=${runningProject.id}`} className="desk__nowitem">
                <span className="desk__nowlabel">{runningProject.name}</span>
                <span className="desk__nowmeta mono">{buildProgressMeta(runningProject)} ›</span>
              </Link>
            )}
            {enabledManagers.length > 0 && (
              <div className="desk__nowitem">
                <span className="desk__nowlabel">
                  {enabledManagers.length} manager{enabledManagers.length === 1 ? '' : 's'} on duty
                </span>
                {lastManagerRun && (
                  <span className="desk__nowmeta mono">
                    last: {lastManagerRun.title} {lastManagerRun.ok ? '✓' : '✕'}
                  </span>
                )}
              </div>
            )}
            {nextDue && (
              <div className="desk__nowitem">
                <span className="desk__nowlabel">{nextDue.task}</span>
                <span className="desk__nowmeta mono">{dueText(nextDue.dueInMs)}</span>
              </div>
            )}
            {projectLoops.map((g) => {
              const due = nextDueSchedule(g.schedules, Date.now())
              const enabledCount = g.schedules.filter((s) => s.enabled).length
              return (
                <Link
                  key={g.projectId}
                  to={`/projects?open=${g.projectId}`}
                  className="desk__nowitem"
                >
                  <span className="desk__nowlabel">
                    {g.projectName} · {g.schedules.length} loop{g.schedules.length === 1 ? '' : 's'}
                  </span>
                  <span className="desk__nowmeta mono">
                    {enabledCount} of {g.schedules.length} on
                    {due ? ` · next ${dueText(due.dueInMs)}` : ''}
                  </span>
                </Link>
              )
            })}
          </div>
        </section>
      )}

      {show !== 'needs' && (
      <section className="desk__section">
        <div className="desk__kicker">Health</div>
        <div className="desk__chips">
          <span className={'desk__chip' + (down.length > 0 ? ' desk__chip--warn' : '')}>{providersSummary}</span>
          <span className="desk__chip">vault {vaultName}</span>
          <span className="desk__chip">{engineMode}</span>
          {/* The pass rate NAMES ITS DENOMINATOR. It used to read "pass 60%"
              over a mix of three outcomes; attention runs are now held out of
              the ratio and counted in their own chip beside it, so neither
              number can be read as something it isn't. */}
          {rate !== null && rate.decided > 0 && (
            <span className={'desk__chip ' + passRateChipClass(rate.passRate)}>
              pass {Math.round(rate.passRate * 100)}% of {rate.decided} decided
            </span>
          )}
          {rate !== null && rate.attention > 0 && (
            <span className="desk__chip desk__chip--warn">
              {rate.attention} needed a look · not counted
            </span>
          )}
        </div>
      </section>
      )}

      {show !== 'needs' && hasCatchUp && (
        <section className="desk__section">
          <div className="desk__kicker">Catch-up</div>
          <div className="desk__catchup">
            {catchUpRuns.length > 0 && (
              <div className="desk__catchcol">
                {catchUpRuns.map((r, i) => (
                  <Link key={i} to="/vault" className="desk__catchrow">
                    <span className={'desk__dot ' + (r.ok ? 'desk__dot--ok' : 'desk__dot--err')} />
                    <span className="desk__catchtitle">{r.title}</span>
                    <span className="desk__catchsummary mono">{r.summary}</span>
                    {/* WHEN, always — and loudly when it is old. Two failures
                        from five weeks earlier sat here reading as current,
                        blaming a local model that had been working again for
                        weeks. A row under a "happening now" heading has to
                        carry its own age or it lies by placement. */}
                    <span
                      className={
                        'desk__catchage mono' + (r.stale ? ' desk__catchage--stale' : '')
                      }
                    >
                      {r.stale ? `${relTime(r.at)} — not recent` : relTime(r.at)}
                    </span>
                  </Link>
                ))}
              </div>
            )}
            {catchUpProjects.length > 0 && (
              <div className="desk__catchcol">
                {catchUpProjects.map((p) => (
                  <Link key={p.id} to={`/projects?open=${p.id}`} className="desk__catchrow">
                    <span className="desk__catchtitle">{p.name}</span>
                    <span className="desk__catchsummary mono">{p.lastNote || p.status}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
