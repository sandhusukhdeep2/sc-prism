// SC Prism — simulated engine types.
// Mirrors the product schemas: a Task Contract feeds the router + two-tier verifier,
// which produces the signature Verdict artifact. All in-memory, no I/O.

export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted'

export type AgentState = 'planning' | 'executing' | 'verifying' | 'blocked' | 'done'

// Free-form: real runs carry the ACTUAL "provider · model" label from the
// engine; the browser sim uses its representative names.
export type ModelId = string

export type RouteTarget = 'local' | 'cloud'

// The parsed intent — what the orchestrator commits to before any model is touched.
export interface TaskContract {
  id: string
  intent: string
  sensitivity: Sensitivity
  keywords: string[]
  reasoningLoad: number // 0..1 heuristic — how much "thinking" the task needs
  createdAt: number
}

// The routing decision: sensitivity pushes local, reasoning load pulls cloud.
export interface RouteDecision {
  target: RouteTarget
  model: ModelId
  via: string // e.g. 'via Bifrost'
  reason: string
  routeLabel: string // display, e.g. 'internal → local · qwen2.5-coder'
}

// Tier 1 — deterministic, free (0 tokens): tests + lint + build. A fail short-circuits.
export interface Tier1Result {
  tests: string // e.g. '14/14'
  lint: boolean
  build: boolean
  pass: boolean
  // The raw command output (stdout/stderr) from the real engine's Tier-1
  // run — the actual failure text a refine pass should quote. Only set by
  // the native (real-engine) path; the sim leaves it undefined.
  log?: string
  // The gate did NOT run: this run had nothing to check (no verify command, or
  // no project directory to run one against — chat, a manager report, a
  // heartbeat wake). `pass` is true alongside it (there is nothing to
  // disprove), so any renderer MUST read `skipped` FIRST: a tick drawn over a
  // gate that never executed is exactly the silent pass the honesty rules
  // forbid. `skipReason` is the engine's own words for why.
  skipped?: boolean
  skipReason?: string
}

// Tier 2 — the LLM-judge eval, only runs if Tier 1 passed.
export interface Tier2Result {
  evalScore: number // 0..1
  passed: boolean
  judge: string // 'DeepEval judge'
  trajectory: string // 'trajectory ok'
  // --- native engine enrichment (optional; only the REAL Python engine sets
  // these — the browser sim omits them, so every field is optional). ---
  metrics?: Record<string, number> // eval sub-metrics (trajectory, tool-use, …)
  envelopeOk?: boolean // stayed within the token/step/latency envelope
  breaches?: readonly string[] // envelope breaches, if any
  judgeNotes?: string // the judge's rationale
  // Claims the judge made that the DETERMINISTIC layer disproved
  // (`evals.detect_contradictions` — e.g. "truncated / no implementation /
  // required files" asserted over files that exist on disk behind a green
  // gate). Non-empty means the reviewer got a FACT wrong, so its score is
  // unreliable for this run. The engine only ever RECORDS these — it never
  // edits its reviewer's marks — which makes the UI the only place a user can
  // learn of them. Burying them in JSON is therefore not an option.
  contradictions?: readonly string[]
}

export interface HookResult {
  blocked: number
  passed: boolean
}

export interface WritebackResult {
  path: string
  validated: boolean
  committed: boolean
}

// One recorded hook decision (allow / deny / ask) from the real engine.
export interface HookDecision {
  hook: string
  action: string
  reason: string
}

// Governance/observability detail carried ONLY from the real Python engine.
// Present on native verdicts, absent on browser-sim verdicts.
export interface NativeVerdictExtra {
  hooksFired: readonly string[]
  hookDecisions: readonly HookDecision[]
  blocks: number // count of blocked writes/tools
  approvals: number // count of human approvals granted
  memoryInjected: number // count of memory items injected under budget
  disclosed: readonly string[] // skills/context disclosed
  rejectedWrites: number // count of vault writes the validator rejected
  cacheHits: number
  cacheMisses: number
  spansPath: string // <vault>/spans.jsonl
  // REAL "provider · model" labels that answered this run (dispatcher/team
  // bookkeeping — e.g. 'gemini · gemini-2.0-flash', 'local · local-model',
  // 'claude-cli · claude-...'). Optional: only real-engine runs the client
  // has re-mapped since this field was added carry it; older persisted
  // verdicts simply have no attributable activity, never a fabricated one.
  // `src/lib/agents.ts`'s `agentActivity` attributes a verdict to an agent
  // by checking whether an entry's provider part (before the first ' · ')
  // contains the agent's model token.
  models_used?: readonly string[]
}

// The Verdict — the product's signature artifact.
export interface Verdict {
  taskId: string
  task: string
  route: RouteDecision
  tier1: Tier1Result
  tier2: Tier2Result
  tokensIn: number
  tokensOut: number
  cost: number
  durationMs: number
  modelRoute: string // display, e.g. '1,240 tok in / 380 out'
  hooks: HookResult
  writeback: WritebackResult
  passed: boolean
  // The engine's honest four-valued outcome (see RawVerdict.outcome).
  // `passed` is true exactly for 'passed' and 'replied'; 'attention' means the
  // deterministic checks ran over real files and passed while the LLM reviewer
  // dissented, which is neither a pass nor a failure; 'replied' is a chat
  // turn's pass — the judge cleared the reply, and there were no files or
  // checks BY DESIGN. Undefined on the sim path and on verdicts predating the
  // field — unknown, never assumed 'failed'.
  outcome?: 'passed' | 'replied' | 'attention' | 'failed'
  outcomeReason?: string
  // The assistant completion text produced this run — surfaced in the Workspace
  // chat. Set by the native (real-engine) path; the sim leaves it undefined.
  response?: string
  // Only set by the native (real-engine) path; the sim leaves it undefined.
  native?: NativeVerdictExtra
  // ISO timestamp from the engine; native runs only.
  at?: string
  // Project-mode extras (engine `project` subcommand only) — the files the
  // run wrote inside the project dir, and the resulting git checkpoint (a
  // passing run commits; `git_checkpoint` is absent until then, or on a
  // "skipped: <reason>" no-op commit). `baseBranch`/`runBranch`/`overwrote`
  // are existing-mode-only (engine `project --existing`): which branches this
  // step ran on, and which written paths already existed before this step.
  project?: {
    files_written: readonly string[]
    git_checkpoint?: string
    baseBranch?: string
    runBranch?: string
    overwrote?: readonly string[]
  }
  // Refine lineage: which attempt at ONE logical step this run was. A step that
  // failed and was refined produces attempt 1, attempt 2, … — each its own
  // governed run with its own verdict, tied together by `group` and ordered by
  // `number` (the engine also keeps the group's ledger at
  // `<vault>/verdicts/attempts/<group>.json`). Absent when the run was never
  // tracked as part of a refine loop — which is NOT the same as "attempt 1",
  // and must never be rendered as one.
  attempt?: {
    number: number
    group: string
    /** This run carried the previous attempt's failure as feedback. */
    isRefine: boolean
    /** The attempt this one is fixing. */
    previousTaskId?: string
  }
}

// --------------------------------------------------------------------------
// Observability dashboard — the wire shape of the engine's `dashboard`
// subcommand JSON (engine/scprism_engine/observability.py :: dashboard()).
// Field names are kept snake_case to match the JSON exactly (no remap).
// --------------------------------------------------------------------------

export interface DashModelCost {
  calls: number
  tokens_in: number
  tokens_out: number
  tokens: number
  cost: number
  provider: string
}

export interface DashOperationCost {
  calls: number
  tokens: number
  cost: number
  models: Record<string, number>
}

export interface DashHook {
  fires: number
  total_ms: number
  avg_ms: number
  blocks: number
  /** the hook itself could not do its job — the only thing badgeable as broken. */
  errors: number
  /** the hook RAN and recorded a failing run (the stop ratchet's "compliance
   *  ratchet: FAIL — task not done"). That is the enforcement layer WORKING.
   *  Optional: a dashboard from an older engine build does not carry it. */
  failed_outcomes?: number
}

export interface DashCache {
  total_calls: number
  hits: number
  misses: number
  hit_rate: number
  by_kind: Record<string, number>
  warmth: number
  warmth_curve: readonly number[]
}

export interface DashEvalPoint {
  run_id: string
  task_id: string
  start: number
  eval_score: number
}

export interface DashDrift {
  kind: string // 'eval_score_drop' | 'cache_hit_drop' | 'cost_spike'
  severity: string // 'warn' | 'alert'
  baseline: number
  latest: number
  delta: number
  reason: string
}

export interface DashRun {
  run_id: string
  task_id: string
  start: number
  tokens: number
  cost: number
  eval_score: number | null
  passed: boolean | null
  cache_hit_rate: number
  model_calls: number
}

export interface Dashboard {
  vault: string
  runs: number
  run_series: readonly DashRun[]
  total_tokens: number
  total_cost: number
  cost_by_model: Record<string, DashModelCost>
  cost_by_operation: Record<string, DashOperationCost>
  token_burn_by_time: Record<string, number>
  hooks: Record<string, DashHook>
  eval_trend: readonly DashEvalPoint[]
  cache: DashCache
  drift: readonly DashDrift[]
  healthy: boolean
  // Tier-1 gate health (observability.tier1_stats). Optional: a dashboard
  // written by an older engine build does not carry it, and a page must then
  // say "not measured" rather than render a zero as if it were a measurement.
  tier1?: DashTier1
}

// What the deterministic gate actually did, measured from the tier1 spans.
//
// `blocked` is the hero number — a run the gate RAN on and caught something in,
// short-circuiting Tier-2 so the judge's tokens were never spent. `failed` is
// every non-passing run, which is NOT the same thing: it also contains
// `not_found` (the gate could not run at all — no binary, no project directory,
// ENOENT: nothing was verified) and `unknown` (failed before the app recorded
// which of the two it was). Reporting `failed` as saves is what turned 53 runs
// that verified nothing into a gold "53 saves" hero.
export interface DashTier1 {
  runs: number
  ran: number
  passed: number
  failed: number
  skipped: number
  /** the gate had nothing to check because this run had no project directory
   *  (chat, a manager report, a heartbeat wake) — never a save, never a caught
   *  failure, never an error, and never part of `ran`. */
  skipped_nothing_to_verify?: number
  /** the gate had nothing to check because no verify command was configured. */
  skipped_no_commands?: number
  not_found: number
  /** failed runs recorded before `not_found` existed — claimed as neither. */
  unknown?: number
  /** the real saves: failed - not_found - unknown. */
  blocked?: number
  caught: Record<string, number>
  judged_runs: number
  avg_judge_tokens: number
}

// A live agent (AI worker) advancing through states as the task runs.
export interface Agent {
  id: string
  role: string
  model: ModelId
  state: AgentState
  task: string
  burn: number // tokens consumed so far
  evalScore: number // 0..1, 0 until verified
  progress: number // 0..100
}

// Streamed engine events — the store turns these into UI updates.
export type EngineEvent =
  | { type: 'contract'; contract: TaskContract }
  | { type: 'assistant'; line: string }
  | { type: 'route'; decision: RouteDecision }
  | { type: 'agent'; agent: Agent }
  | { type: 'tier1'; result: Tier1Result }
  | { type: 'tier2'; result: Tier2Result }
  | { type: 'writeback'; writeback: WritebackResult }
  | { type: 'verdict'; verdict: Verdict }
