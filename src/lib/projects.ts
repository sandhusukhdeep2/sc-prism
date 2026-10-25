// SC Prism — project workspace store (persisted under `scprism.projects` +
// disk store). A project is a durable multi-step build tracked end to end:
// goal → AI interview → plan → run loop (one verified step at a time) →
// verdicts. Mirrors the managers.ts singleton-store pattern exactly (same
// localStorage + disk-hydration shape) so the run driver and UI can rely on
// identical semantics.

import { useSyncExternalStore } from 'react'
import {
  agentNameKey,
  agentRoster,
  agentSlug,
  agentsForProject,
  systemAgents,
  type StoredAgent,
} from './agents'
import { sitOutLine, splitRoster, type SitOut } from './roster'
import { isNative, storeGet, storeSet } from './nativeEngine'

export type ProjectStatus =
  | 'new'
  | 'interviewing'
  | 'planned'
  | 'running'
  | 'awaiting'
  | 'done'
  | 'attention'

export interface ProjectTurn {
  role: 'ai' | 'user'
  text: string
}

export interface Project {
  id: string
  name: string
  slug: string
  path: string
  goal: string
  verifyCommand: string
  createdAt: number
  status: ProjectStatus
  brief: string
  plan: string[]
  stepIndex: number
  refinePass: number
  transcript: ProjectTurn[]
  verdictIds: string[]
  lastNote: string
  mode?: 'new' | 'existing'
  baseBranch?: string
  runBranch?: string
  /** 'lead:<id>,planner:<id>,developer:<id>'. '' (default) = single-doer,
   *  today's unchanged behavior. Set = the build runs a per-role board for
   *  each step instead of one model (P1-2/P1-3). */
  roster?: string
}

export interface ProjectsState {
  projects: Project[]
}

const STORAGE_KEY = 'scprism.projects'
const STATUSES: ProjectStatus[] = [
  'new',
  'interviewing',
  'planned',
  'running',
  'awaiting',
  'done',
  'attention',
]

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** lowercase, [a-z0-9-], collapse runs of anything else to a single '-',
 * trim leading/trailing '-'; empty/unusable input falls back to 'project'. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'project'
}

const PLAN_BLOCK_RE = /===PLAN===\s*([\s\S]*?)\s*===END===/

/**
 * Parse a "===PLAN===\nbrief: <one line>\n1. step\n2. step\n===END===" block
 * out of arbitrary model narration. Forgiving: tolerates surrounding prose,
 * extra whitespace, numbered ("1.") or dashed ("-"/"*") steps, and a missing
 * `brief:` line (brief then defaults to ''). Returns null when no block is
 * found, or the block parses to zero steps.
 */
export function parsePlanBlock(text: string): { brief: string; plan: string[] } | null {
  const match = text.match(PLAN_BLOCK_RE)
  if (!match) return null

  const lines = match[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  let brief = ''
  let i = 0
  const briefMatch = lines[0]?.match(/^brief:\s*(.*)$/i)
  if (briefMatch) {
    brief = briefMatch[1].trim()
    i = 1
  }

  const plan: string[] = []
  for (; i < lines.length; i++) {
    const line = lines[i]
    const numbered = line.match(/^\d+[.)]\s*(.+)$/)
    const dashed = line.match(/^[-*]\s*(.+)$/)
    if (numbered) plan.push(numbered[1].trim())
    else if (dashed) plan.push(dashed[1].trim())
    // stray narration lines inside the block are ignored
  }

  if (plan.length === 0) return null
  return { brief, plan }
}

// A backticked snippet immediately followed by "as the [Tier-1] verify
// command" — the plan's own canonical phrasing ("Run `npm test` as the
// Tier-1 verify command and fix failures until it passes").
const VERIFY_ADJACENT_RE = /`([^`\n]+)`\s+as\s+(?:the\s+)?(?:tier[\s-]?1\s+)?verify\s+command/i
const VERIFY_PHRASE_RE = /\bverify\s+command\b/i

/**
 * The Tier-1 verify command the plan ITSELF names, or ''. Never invents one:
 * with no verify command, Tier-1 skips honestly and the judge grades alone —
 * but a plan that ends "Run `npm test` as the Tier-1 verify command…" while
 * verifyCommand stays '' silently loses the deterministic gate the plan
 * promised (the node-cli 20-minute refine ping-pong, 2026-08-28).
 *
 * Sources, most-explicit first:
 *   1. A step (or the goal) naming a backticked command adjacent to the
 *      "verify command" phrase, or a verify-command step with exactly ONE
 *      backticked snippet. Several non-adjacent snippets = refuse to guess.
 *   2. `npm test` only when BOTH package.json and tests appear in the
 *      plan/goal — the standard invocation of what the plan says it builds.
 */
export function extractVerifyCommand(plan: string[], goal: string): string {
  for (const step of [...plan, goal]) {
    if (!VERIFY_PHRASE_RE.test(step)) continue
    const adjacent = step.match(VERIFY_ADJACENT_RE)
    if (adjacent) return adjacent[1].trim()
    const ticked = [...step.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter(Boolean)
    if (ticked.length === 1) return ticked[0]
  }
  const text = [goal, ...plan].join('\n')
  if (/package\.json/i.test(text) && /\btests?\b/i.test(text)) return 'npm test'
  return ''
}

/** Default workspace directory for a new project (expansion of `~` happens
 * in the driver, not here). */
/**
 * One vault, everything in it (Sukhdeep, 2026-08-31): new projects live at
 * `<vault>/projects/<slug>` — the company's one vault carries its work, its
 * records, and its agents together, portable across machines. With no vault
 * known the classic home stands; a project the user pathed explicitly is
 * never moved.
 */
export function defaultProjectPath(slug: string, vaultPath?: string): string {
  const vault = (vaultPath ?? '').trim().replace(/\/+$/, '')
  return vault ? `${vault}/projects/${slug}` : `~/SC Projects/${slug}`
}

/**
 * Default role-team roster for a new project's "team of models" toggle,
 * keyed off the settings primary provider (mirrors `defaultTeamRoster` in
 * managers.ts, same lead/local conventions, but with this feature's own
 * lead/planner/developer roles): the primary AI leads (per ADR-007 the
 * driver orchestrates, never a model), gemini plans, and a local model
 * implements to keep cost down.
 */
/* NOTE (2026-08-12): no live caller — a project's real team comes from
 * `projectBuildRoster` below, which takes the provider gate. If this is ever
 * wired up again it must take that gate too, or it will name `gemini`/`local`
 * whether or not either is connected. */
export function defaultProjectRoster(primaryProviderId: string): string {
  return `lead:${primaryProviderId},planner:gemini,developer:local`
}

/**
 * The roster string a project's build actually uses — the single decision
 * point for the build wiring (`runProject` → `runNativeProject`'s `roster`
 * opt). Resolution order, simplest-intent first:
 *   1. This project's OWN assigned agents (`agentsForProject`) — the
 *      exception the primary sets up for a SPECIFIC requirement. When any
 *      exist, `agentRoster` of them is the team, overriding everything below.
 *   2. An explicit manual `project.roster` override (non-blank) — a roster
 *      the user typed by hand.
 *   3. THE DEFAULT: the enabled SYSTEM agents (`systemAgents`, the sys-*
 *      Planner/Implementer/Reviewer/… division set up at install), as
 *      `agentRoster`. So with zero per-project setup a project already builds
 *      with the existing multi-model system team on their configured models.
 * With no system agents at all (empty/none-enabled), this yields '' — an
 * honest single-doer, never a fabricated roster. Pure: no store reads, every
 * input is an explicit argument (`agents` is the full StoredAgent list the
 * caller passes, e.g. AppStore's `list()`), so it's testable without touching
 * the agents/projects singletons' live state.
 */
export function projectBuildRoster(
  project: Project,
  agents: StoredAgent[],
  /** Token → '' or the reason that provider can't take a seat. Required for the
   *  same reason `agentRoster`'s is: "the agent is enabled" never meant "its
   *  model can run", and treating the two as one fact put offline stubs on real
   *  boards.
   *
   *  PASS `allowAllProviders` FROM A UI CALL SITE. This function DROPS the
   *  agents that fail the check, and a dropped agent leaves no trace for the
   *  downstream `filterRoster` to report — so a caller that gates here and then
   *  filters again shows the user "Default team (your system agents)" while the
   *  Researcher has silently vanished for Gemini being switched off. Gate ONCE,
   *  in the filter that also reports (`lib/roster.ts`: no silent shrinking). */
  providerCheck: (token: string) => string,
): string {
  const assigned = agentsForProject(agents, project.id)
  if (assigned.length > 0) return agentRoster(assigned, providerCheck)
  // A hand-typed override is the user's own words, so it is not rewritten
  // here — the launch path staffs it (`staffRoster`) and filters it
  // (`filterRoster`), and REPORTS what either gate drops.
  if ((project.roster ?? '').trim()) return project.roster ?? ''
  return agentRoster(systemAgents(agents), providerCheck)
}

/**
 * THE STAFFING GATE (2026-08-30). A roster's role key must name a REAL
 * library/system agent, or the seat is REFUSED with the reason — never sent
 * to the engine, whose `parse_agents` would silently bind a fallback charter
 * ("Act as the team's lead."). Observed live 2026-08-29 (proj-site-launch):
 * a "lead:claude" override put a seat on the board that spoke as a generic
 * verifier ("I'll run the Tier-1 checks") and wrote no FILE blocks, lap after
 * lap — a coworker who does not exist, running on a made-up charter.
 *
 * Matching is the SAME rule the team launcher's capability lookup uses
 * (AppStore.launchTeam): the agent's roster slug, or its display name typed in
 * the user's own words — both case-insensitive. Rosters BUILT from the library
 * (assigned agents, the default system team) are `agentSlug` output already,
 * so this gate can only ever bite a hand-typed override. Kept seats are
 * re-joined through `splitRoster`'s normal reading (bare key → `:local`),
 * exactly what the launch path's `filterRoster` would do next.
 */
export function staffRoster(
  roster: string,
  agents: readonly StoredAgent[],
): { roster: string; unstaffed: SitOut[] } {
  const kept: string[] = []
  const unstaffed: SitOut[] = []
  for (const { role, token } of splitRoster(roster)) {
    const key = role.toLowerCase()
    const staffed = agents.some(
      (a) => agentSlug(a.name) === agentSlug(key) || agentNameKey(a.name) === agentNameKey(role),
    )
    if (staffed) kept.push(`${role}:${token}`)
    else unstaffed.push({ role, token, reason: `no agent in your library is named “${role}”` })
  }
  return { roster: kept.join(','), unstaffed }
}

/** The honest refusal when staffing leaves NOTHING — same voice as
 *  `emptyRosterRefusal`: the run never started, and the fix is named. */
export function unstaffedRefusal(unstaffed: readonly SitOut[]): string {
  return (
    `No seat could be staffed: ${sitOutLine([...unstaffed])}. ` +
    'Name agents from your library, or clear the override to build with the system team.'
  )
}

// ---------------------------------------------------------------------------
// Sanitize (back-compat on load — every missing field gets a safe default)
// ---------------------------------------------------------------------------

function isProjectStatus(v: unknown): v is ProjectStatus {
  return typeof v === 'string' && (STATUSES as string[]).includes(v)
}

function isProjectTurn(v: unknown): v is ProjectTurn {
  if (!v || typeof v !== 'object') return false
  const t = v as Partial<ProjectTurn>
  return (t.role === 'ai' || t.role === 'user') && typeof t.text === 'string'
}

function sanitizeProject(v: unknown): Project | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Partial<Project>
  if (typeof p.id !== 'string') return null
  let status: ProjectStatus = isProjectStatus(p.status) ? p.status : 'new'
  let lastNote = typeof p.lastNote === 'string' ? p.lastNote : ''
  // Recover orphaned running projects: normalize to 'attention' with interrupt note
  if (status === 'running') {
    status = 'attention'
    lastNote = 'run interrupted — press Start to resume'
  }
  // Normalize mode: 'existing' only when exactly that string, else 'new'
  const mode = p.mode === 'existing' ? 'existing' : 'new'
  // Normalize branches: strings else ''
  const baseBranch = typeof p.baseBranch === 'string' ? p.baseBranch : ''
  const runBranch = typeof p.runBranch === 'string' ? p.runBranch : ''
  // Roster: string else '' (unset = single-doer, today's behavior).
  const roster = typeof p.roster === 'string' ? p.roster : ''
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : '',
    slug: typeof p.slug === 'string' ? p.slug : '',
    path: typeof p.path === 'string' ? p.path : '',
    goal: typeof p.goal === 'string' ? p.goal : '',
    verifyCommand: typeof p.verifyCommand === 'string' ? p.verifyCommand : '',
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
    status,
    brief: typeof p.brief === 'string' ? p.brief : '',
    plan: Array.isArray(p.plan) ? p.plan.filter((s): s is string => typeof s === 'string') : [],
    stepIndex: typeof p.stepIndex === 'number' ? p.stepIndex : 0,
    refinePass: typeof p.refinePass === 'number' ? p.refinePass : 0,
    transcript: Array.isArray(p.transcript) ? p.transcript.filter(isProjectTurn) : [],
    verdictIds: Array.isArray(p.verdictIds)
      ? p.verdictIds.filter((s): s is string => typeof s === 'string')
      : [],
    lastNote,
    mode,
    baseBranch,
    runBranch,
    roster,
  }
}

const EMPTY: ProjectsState = { projects: [] }

function sanitize(v: unknown): ProjectsState {
  if (typeof v !== 'object' || v === null) return { ...EMPTY }
  const s = v as Partial<ProjectsState>
  return {
    projects: Array.isArray(s.projects)
      ? s.projects.map(sanitizeProject).filter((p): p is Project => p !== null)
      : [],
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let state: ProjectsState = load()
const listeners = new Set<() => void>()
let diskHydrated = !isNative()

function load(): ProjectsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? sanitize(JSON.parse(raw)) : { ...EMPTY }
  } catch {
    return { ...EMPTY }
  }
}

function emit(): void {
  for (const l of listeners) l()
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* non-fatal */
  }
  if (diskHydrated) void storeSet('projects', JSON.stringify(state))
}

if (isNative()) {
  void storeGet('projects').then((raw) => {
    if (raw) {
      try {
        state = sanitize(JSON.parse(raw))
      } catch {
        /* keep localStorage copy */
      }
    }
    diskHydrated = true
    // Always notify — even when disk had no projects — so hydration-gated
    // consumers (e.g. the Work page's dangling-id heal) re-run only once the
    // real on-disk state is known, never against the pre-hydration cache.
    emit()
  })
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getProjects(): ProjectsState {
  return state
}

function setState(next: ProjectsState): void {
  state = next
  persist()
  emit()
}

let seq = 0

export function addProject(
  name: string,
  goal: string,
  verifyCommand: string,
  path?: string,
): Project {
  const slug = slugify(name)
  const project: Project = {
    id: `proj-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    name: name.trim(),
    slug,
    path: path ?? defaultProjectPath(slug),
    goal: goal.trim(),
    verifyCommand: verifyCommand.trim(),
    createdAt: Date.now(),
    status: 'new',
    brief: '',
    plan: [],
    stepIndex: 0,
    refinePass: 0,
    transcript: [],
    verdictIds: [],
    lastNote: '',
    mode: 'new',
    baseBranch: '',
    runBranch: '',
    roster: '',
  }
  setState({ ...state, projects: [project, ...state.projects] })
  return project
}

/** Attach an existing project: mode 'existing', path stored verbatim (trimmed),
 * same id/slug/defaults pattern as addProject. */
export function attachProject(name: string, path: string, goal: string, verifyCommand: string): Project {
  const slug = slugify(name)
  const project: Project = {
    id: `proj-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    name: name.trim(),
    slug,
    path: path.trim(),
    goal: goal.trim(),
    verifyCommand: verifyCommand.trim(),
    createdAt: Date.now(),
    status: 'new',
    brief: '',
    plan: [],
    stepIndex: 0,
    refinePass: 0,
    transcript: [],
    verdictIds: [],
    lastNote: '',
    mode: 'existing',
    baseBranch: '',
    runBranch: '',
    roster: '',
  }
  setState({ ...state, projects: [project, ...state.projects] })
  return project
}

export function updateProject(id: string, patch: Partial<Project>): void {
  setState({
    ...state,
    projects: state.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  })
}

/** Which pipeline a send should run for the given active project (null =
 * universal). A project with no plan yet (and not done) is still being
 * interviewed; otherwise the project-aware companion handles the turn. */
export function nextSendMode(project: Project | null): 'companion' | 'project-interview' {
  if (!project) return 'companion'
  if (project.plan.length === 0 && project.status !== 'done') return 'project-interview'
  return 'companion'
}

export function appendTurn(id: string, turn: ProjectTurn): void {
  setState({
    ...state,
    projects: state.projects.map((p) =>
      p.id === id ? { ...p, transcript: [...p.transcript, turn] } : p,
    ),
  })
}

export function removeProject(id: string): void {
  setState({ ...state, projects: state.projects.filter((p) => p.id !== id) })
}

export function useProjects(): ProjectsState {
  return useSyncExternalStore(subscribe, getProjects, getProjects)
}

/** True once the on-disk projects have loaded (always true in the browser).
 *  Reactive: flips (and re-renders subscribers) when native disk hydration
 *  completes, so consumers can defer destructive fallbacks until then. */
export function useProjectsHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => diskHydrated,
    () => true,
  )
}
