// SC Prism — native (Tauri) engine bridge.
//
// When the app runs inside Tauri, `runNativeTask` invokes the Rust
// `run_engine_task` command, which shells out to the REAL Python engine
// (`python3 -m scprism_engine run …`) and returns the Verdict JSON. That raw
// shape is mapped onto the client `Verdict` used across the UI.
//
// Everything here is a no-op in the browser: `isNative()` is false, and
// `runNativeTask` returns `null` on any non-native context or error, so callers
// transparently fall back to the in-browser simulation.

import { invoke } from '@tauri-apps/api/core'
import { appDataDir, homeDir, join } from '@tauri-apps/api/path'
import type {
  Dashboard,
  HookDecision,
  HookResult,
  ModelId,
  NativeVerdictExtra,
  RouteDecision,
  RouteTarget,
  Tier1Result,
  Tier2Result,
  Verdict,
  WritebackResult,
} from '../engine/types'
import {
  classifyTool,
  READ_ONLY,
  READ_ONLY_GRANT,
  readsDecidedExplicitly,
  readsRunFree,
} from './toolRisk'

// ---------------------------------------------------------------------------
// Raw JSON emitted by the Python engine (engine/scprism_engine/writeback.py).
// ---------------------------------------------------------------------------

interface RawTier1 {
  ran: boolean
  passed?: boolean
  skipped?: boolean
  // Why the gate was skipped, and which configured commands it therefore never
  // ran. Absent on verdicts written by an older engine build.
  skip_reason?: string
  skipped_commands?: string[]
  tokens?: number
  commands?: string[]
  log?: string
}

interface RawTier2 {
  ran: boolean
  passed?: boolean
  score?: number
  eval_score?: number
  metrics?: Record<string, number>
  threshold?: number
  envelope_ok?: boolean
  breaches?: string[]
  tokens?: number
  judge_notes?: string
  rationale?: string
  reason?: string
  // Judge claims the deterministic layer disproved (writeback's
  // `_tier2_summary` → `evals.detect_contradictions`). Absent on older
  // verdicts and on any backend that never ran the check.
  contradictions?: string[]
}

interface RawHookDecision {
  hook?: string
  action?: string
  reason?: string
}

interface RawVerdict {
  task_id: string
  tier1: RawTier1
  tier2: RawTier2
  tokens_spent: number
  model_route: string[]
  hooks_fired: string[]
  artifacts: string[]
  passed: boolean
  // The engine's FOUR-valued outcome (writeback.Verdict.outcome). "attention"
  // is the run whose deterministic Tier-1 gate ran the project's checks over
  // real written files and PASSED while the Tier-2 LLM reviewer dissented —
  // "tests passed, reviewer wasn't satisfied". Recording that as a flat failure
  // is what put failures on work that had genuinely succeeded. "replied" is a
  // chat turn's pass (contract mode 'converse'): the judge cleared the reply,
  // and there were no files or checks to clear BY DESIGN. Absent on verdicts
  // written before the field existed; `passed` is then the only claim.
  outcome?: 'passed' | 'replied' | 'attention' | 'failed'
  outcome_reason?: string
  timestamp: string
  // The assistant completion text produced this run (`answer` is a mirror key).
  response?: string
  answer?: string
  // REAL provider · model pairs that answered this run.
  models_used?: string[]
  // The gateway's HONEST route reason(s) for this run (distinct, in order) — the
  // client labels the route from the REAL cause instead of a fabricated one
  // (LF-fix E). Absent on older verdicts / composite-doer runs -> built-in copy.
  model_route_reasons?: string[]
  // Governance / observability detail (present on real-engine verdicts only).
  hook_decisions?: RawHookDecision[]
  blocks?: unknown[]
  approvals?: unknown[]
  memory_injected?: unknown[]
  disclosed?: string[]
  rejected_writes?: unknown[]
  cache_hits?: number
  cache_misses?: number
  spans_path?: string
  // Free-form feature payload slot (writeback.Verdict.extras); project-mode
  // runs stash their write ledger + git checkpoint at extras.project.
  extras?: {
    project?: {
      files_written?: string[]
      git_checkpoint?: string
      // existing-mode only (engine `project --existing`): which branches this
      // step ran on, and which written paths already existed (overwrote).
      base_branch?: string
      run_branch?: string
      overwrote?: string[]
    }
    // Refine lineage (engine `project --attempt N --attempt-group ID`): which
    // attempt at ONE logical step this run was, and where its sibling attempts
    // are recorded. Absent on an untracked run.
    attempt?: {
      number?: number
      group?: string
      previous_task_id?: string
      is_refine?: boolean
      index?: string
    }
  }
}

// ---------------------------------------------------------------------------
// Native detection
// ---------------------------------------------------------------------------

/** True when running inside the Tauri webview (native shell present). */
export function isNative(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * A fresh, unique id for ONE native engine launch. The Rust bridge retains the
 * spawned child under this id (a `Mutex<HashMap<run_id, Child>>`), so a client
 * that gives up on a slow run can `cancelEngineRun(runId)` to actually kill the
 * subprocess — no zombie kept running after a timeout. Any unique string works;
 * this is distinct from the engine's own contract task_id (a run's Verdict id).
 */
export function newRunId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `run-${Date.now()}-${rand}`
}

/**
 * Kill the retained engine subprocess for `runId` (native only; a no-op in the
 * browser or when the run already finished / was never registered). Called when
 * a client-side hard timeout gives up on a run so the abandoned subprocess is
 * really stopped instead of lingering as a zombie that both wastes work and can
 * overlap the next scheduled run. Best-effort: any bridge error is swallowed —
 * the client has already moved on from this run.
 */
export async function cancelEngineRun(runId: string): Promise<void> {
  if (!isNative() || !runId) return
  try {
    await invoke('cancel_engine_run', { runId })
  } catch {
    /* best-effort — the run may have already exited; nothing to recover */
  }
}

/**
 * Default on-disk vault directory (`<appData>/vault`). Only meaningful in the
 * native shell; callers must guard with `isNative()`.
 */
export async function defaultVaultDir(): Promise<string> {
  const base = await appDataDir()
  return join(base, 'vault')
}

/**
 * Expand a leading `~` in a filesystem path to the user's home directory.
 * Absolute paths pass through unchanged; paths starting with ~ but not being
 * exactly ~ or ~/... return empty string (signal to callers to reject); anything
 * else (empty, relative, no leading `~`) is returned as-is — callers that want a
 * "fall back to a default directory" behavior for those cases (like `resolveVaultDir`
 * below) layer that on top. Native-only (uses the Tauri path plugin) — a literal `~`
 * must never reach the Rust bridge / Python engine, so any path-consuming native
 * call should run its input through this first.
 */
export async function expandUserPath(path: string): Promise<string> {
  const p = path.trim()
  if (p.startsWith('/')) return p
  if (p.startsWith('~') && p !== '~' && !p.startsWith('~/')) {
    // Invalid ~ pattern like ~foo/... — signal unusable path
    return ''
  }
  if (p === '~' || p.startsWith('~/')) {
    const home = await homeDir()
    const rest = p.slice(1).replace(/^\//, '')
    return rest ? join(home, rest) : home
  }
  return p
}

/**
 * Resolve the vault directory the engine should write to. Honors the path the
 * user picked during onboarding (Settings.vaultPath): absolute paths are used
 * as-is, a leading `~` expands to the home directory — so pointing it at an
 * Obsidian vault folder works. Empty/relative values fall back to the default
 * `<appData>/vault`.
 */
export async function resolveVaultDir(vaultPath?: string): Promise<string> {
  const p = (vaultPath ?? '').trim()
  if (!p || (!p.startsWith('/') && !p.startsWith('~'))) return defaultVaultDir()
  const expanded = await expandUserPath(p)
  // expandUserPath returns '' to signal an unusable ~ pattern (e.g. '~foo') —
  // fall back to the default vault dir exactly like the empty/relative case
  // above, rather than letting '' reach the engine as a vault path.
  return expanded || defaultVaultDir()
}

/**
 * Open the native folder picker (macOS dialog via the Rust bridge). Returns
 * the chosen POSIX path, or `null` when cancelled / not running natively.
 */
export async function pickFolder(prompt?: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('pick_folder', { prompt: prompt ?? null })
  } catch {
    return null
  }
}

/**
 * Open the native file picker (macOS dialog via the Rust bridge) for the chat
 * composer's 📎 attach button (Slice A: files). Returns the chosen POSIX
 * path, or `null` when cancelled / not running natively. Mirrors `pickFolder`.
 */
export async function pickFile(prompt?: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('pick_file', { prompt: prompt ?? null })
  } catch {
    return null
  }
}

/**
 * Read one arbitrary file's UTF-8 text content (absolute paths only, capped
 * at 200 KB) via the Rust bridge — the source of a chat attachment's
 * contents. Returns `null` on any failure (too large, binary/non-UTF-8,
 * missing, non-native): callers must surface an honest "couldn't attach
 * <name>" message rather than silently dropping the file.
 */
export async function readTextFile(path: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('read_text_file', { path })
  } catch {
    return null
  }
}

/**
 * Read a picked IMAGE file into a `data:<mime>;base64,<b64>` URI for the chat
 * composer's thumbnail preview (image attach). Path-safe on the Rust side
 * (absolute paths only, 5 MB cap, png/jpeg/gif/webp). Returns `null` on any
 * failure (too large, unsupported type, missing, non-native): the composer
 * surfaces an honest "couldn't attach <name>" rather than a broken preview.
 * The engine independently re-reads + validates the same file on send, so this
 * is purely the preview path.
 */
export async function readImageBase64(path: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('read_image_base64', { path })
  } catch {
    return null
  }
}

export interface VaultSyncResult {
  ok: boolean
  detail: string
}

/**
 * REAL git sync of the vault folder to a GitHub repo (init → commit → push to
 * main) via the Rust `sync_vault` command. The token travels via env inside
 * the bridge, never argv or the remote URL. Requires the native shell.
 */
export async function syncVaultToGithub(
  vault: string,
  repo: string,
  token: string,
  message?: string,
): Promise<VaultSyncResult> {
  if (!isNative()) return { ok: false, detail: 'sync needs the installed app' }
  try {
    const detail = await invoke<string>('sync_vault', {
      vault,
      repo,
      token,
      message: message ?? null,
    })
    return { ok: true, detail }
  } catch (e) {
    return { ok: false, detail: String(e) }
  }
}

/**
 * HTTP status of a GitHub API path (e.g. `/user`, `/repos/owner/name`), or
 * `null` when the request could not be made. Native goes through the Rust
 * probe (no CORS); the browser falls back to fetch (api.github.com sends CORS
 * headers, so this also works in dev).
 */
export async function githubApiStatus(path: string, token: string): Promise<number | null> {
  const url = `https://api.github.com${path}`
  const native = await nativePingProvider(url, token, 'bearer')
  if (native !== null) return native
  try {
    const r = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    return r.status
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Mapping raw engine JSON -> client Verdict
// ---------------------------------------------------------------------------

/**
 * The honest one-line route label for a verdict card, derived from the engine's
 * REAL `RouteDecision.reason`(s) (LF-fix E). A learned-policy route is surfaced
 * verbatim (it already names the version + bucket + probability honestly); the
 * built-in branches map to their established copy; an explicit-primary cloud
 * route is named as such (not fabricated as "heavy reasoning"). When no reason
 * was carried (older verdict / a composite doer that routes itself), it falls
 * back to the built-in labels — byte-identical to the pre-LF card.
 */
export function routeReasonLabel(isCloud: boolean, reasons: readonly string[]): string {
  const pick = reasons.find((r) =>
    isCloud
      ? /-> cloud|per user selection/i.test(r)
      : /-> local|zero egress|sensitive keyword/i.test(r),
  )
  if (pick) {
    if (/learned route policy/i.test(pick)) return pick
    // R2: heavy reasoning with no usable cloud stays LOCAL — the primary was
    // NOT used, so never say "routed to your primary" here (the keyless cloud
    // stub bug). Checked before the generic local labels below.
    if (/no cloud configured/i.test(pick))
      return 'heavy reasoning — kept local (no cloud configured)'
    if (/sensitive keyword/i.test(pick))
      return 'kept local — sensitive data stays on your machine (zero egress)'
    if (/reasoning keyword/i.test(pick)) return 'heavy reasoning — routed to your primary'
    if (/per user selection/i.test(pick)) return 'routed to your chosen primary'
  }
  return isCloud
    ? 'heavy reasoning — routed to your primary'
    : 'kept local — cheap inference, zero egress'
}

function mapVerdict(raw: RawVerdict, intent: string, durationMs: number): Verdict {
  const isCloud = raw.model_route.includes('cloud')
  const target: RouteTarget = isCloud ? 'cloud' : 'local'
  // The REAL model that answered (engine records provider · model per call);
  // prefer the cloud entry when both tiers were touched.
  const used = raw.models_used ?? []
  const realModel =
    used.find((m) => !m.startsWith('local')) ?? used[0] ?? (isCloud ? 'cloud model' : 'local model')
  const model = realModel as ModelId
  const route: RouteDecision = {
    target,
    model,
    via: 'via gateway',
    reason: routeReasonLabel(isCloud, raw.model_route_reasons ?? []),
    routeLabel: `${target} · ${realModel}`,
  }

  // Tier 1 — deterministic checks. The summary carries the command list; when
  // there was nothing to check the tier is "skipped" (and still passes, because
  // there is nothing to disprove).
  const t1 = raw.tier1
  const t1pass = t1.passed ?? false
  const t1count = t1.commands?.length ?? 0
  const t1skipped = t1.skipped === true
  const tests = t1skipped ? 'skipped' : t1pass ? `${t1count}/${t1count}` : `?/${t1count}`
  // lint/build are "this check PASSED" booleans, so a skipped gate must not set
  // them: nothing ran, so nothing passed. Renderers branch on `skipped` and
  // show the reason instead of a tick or a cross (VerdictDetail).
  const t1checked = t1pass && !t1skipped
  // Defensive: only a real string log is carried through — a missing/
  // non-string field (older engine, malformed JSON) leaves `log` undefined
  // so verdictFeedback's fallback path kicks in instead of quoting garbage.
  const tier1: Tier1Result = {
    tests,
    lint: t1checked,
    build: t1checked,
    pass: t1pass,
    ...(typeof t1.log === 'string' ? { log: t1.log } : {}),
    ...(t1skipped
      ? {
          skipped: true,
          skipReason:
            typeof t1.skip_reason === 'string' && t1.skip_reason.trim()
              ? t1.skip_reason.trim()
              : // An older engine recorded the flag but not the reason. Say what
                // is known — never invent one, and never let it read as a pass.
                'nothing to verify on this run — the gate did not run',
        }
      : {}),
  }

  // Tier 2 — only runs when Tier 1 passed; otherwise short-circuited.
  const t2 = raw.tier2
  const t2ran = t2.ran ?? false
  const tier2: Tier2Result = {
    evalScore: t2ran ? (t2.eval_score ?? t2.score ?? 0) : 0,
    passed: t2ran ? (t2.passed ?? false) : false,
    judge: 'DeepEval judge',
    trajectory: t2ran ? 'trajectory ok' : (t2.reason ?? 'not run'),
    // Real-engine enrichment — the eval sub-metrics, envelope check, and the
    // judge's rationale. Undefined for the browser sim.
    metrics: t2ran ? t2.metrics : undefined,
    envelopeOk: t2ran ? t2.envelope_ok : undefined,
    breaches: t2ran ? t2.breaches : undefined,
    judgeNotes: t2ran ? (t2.judge_notes ?? t2.rationale) : undefined,
    // Carried through verbatim, and ONLY when the engine recorded at least
    // one. An empty/absent list stays undefined so no surface can imply the
    // check ran and cleared the judge on a verdict that never had it.
    ...(t2ran && Array.isArray(t2.contradictions) && t2.contradictions.length > 0
      ? { contradictions: [...t2.contradictions] }
      : {}),
  }

  // Split the engine's total token spend into in/out: the judge tokens are the
  // "out" side, the rest is dispatch "in".
  const tokensOut = t2ran ? (t2.tokens ?? 0) : 0
  const tokensIn = Math.max(0, raw.tokens_spent - tokensOut)

  // Cloud frontier pricing vs near-free local inference (mirrors the sim).
  const rawCost = isCloud
    ? (tokensIn / 1_000_000) * 3 + (tokensOut / 1_000_000) * 15
    : ((tokensIn + tokensOut) / 1_000_000) * 0.12
  const cost = Math.max(0.001, Math.round(rawCost * 1000) / 1000)

  const blockCount = raw.blocks?.length ?? 0
  const hooks: HookResult = {
    blocked: blockCount || (raw.passed ? 0 : 1),
    passed: raw.passed,
  }
  const writeback: WritebackResult = {
    path: `verdicts/${raw.task_id}.json`,
    validated: raw.passed,
    committed: raw.passed,
  }

  // Governance / observability detail carried straight through from the engine.
  const hookDecisions: HookDecision[] = (raw.hook_decisions ?? []).map((h) => ({
    hook: h.hook ?? '',
    action: h.action ?? '',
    reason: h.reason ?? '',
  }))
  const native: NativeVerdictExtra = {
    hooksFired: raw.hooks_fired ?? [],
    hookDecisions,
    blocks: blockCount,
    approvals: raw.approvals?.length ?? 0,
    memoryInjected: raw.memory_injected?.length ?? 0,
    disclosed: raw.disclosed ?? [],
    rejectedWrites: raw.rejected_writes?.length ?? 0,
    cacheHits: raw.cache_hits ?? 0,
    cacheMisses: raw.cache_misses ?? 0,
    spansPath: raw.spans_path ?? '',
    // Real "provider · model" labels this run actually used (`used`, above)
    // — lets agents.ts's `agentActivity` attribute the run to an agent by
    // model, instead of the fake seeded usage/evalScore.
    models_used: used,
  }

  // Project-mode extras (engine `project` subcommand only) — absent for a
  // plain `run` verdict, and absent when post_dispatch never ran (raw failure
  // before any file write was attempted). `git_checkpoint` is only present
  // once the run passed and a git checkpoint was attempted. `baseBranch`/
  // `runBranch`/`overwrote` are existing-mode-only (engine `project
  // --existing`); defensive here since an older engine or malformed JSON
  // could omit or mistype them — only real strings/string-arrays are carried
  // through, everything else is dropped rather than trusted.
  const rawProject = raw.extras?.project
  const project = rawProject
    ? {
        files_written: rawProject.files_written ?? [],
        ...(rawProject.git_checkpoint !== undefined
          ? { git_checkpoint: rawProject.git_checkpoint }
          : {}),
        ...(typeof rawProject.base_branch === 'string'
          ? { baseBranch: rawProject.base_branch }
          : {}),
        ...(typeof rawProject.run_branch === 'string'
          ? { runBranch: rawProject.run_branch }
          : {}),
        ...(Array.isArray(rawProject.overwrote)
          ? { overwrote: rawProject.overwrote.filter((s): s is string => typeof s === 'string') }
          : {}),
      }
    : undefined

  // Refine lineage — which attempt at one logical step this was. Only a REAL
  // recorded number survives: an untracked run has no attempt, and a run whose
  // attempt number is missing/mistyped must render as "no attempt recorded",
  // never as "attempt 1" (a guess dressed as history).
  const rawAttempt = raw.extras?.attempt
  const attemptNumber =
    typeof rawAttempt?.number === 'number' && rawAttempt.number > 0
      ? rawAttempt.number
      : undefined
  const attempt = attemptNumber
    ? {
        number: attemptNumber,
        group: typeof rawAttempt?.group === 'string' ? rawAttempt.group : '',
        isRefine: rawAttempt?.is_refine === true,
        ...(typeof rawAttempt?.previous_task_id === 'string' && rawAttempt.previous_task_id
          ? { previousTaskId: rawAttempt.previous_task_id }
          : {}),
      }
    : undefined

  return {
    taskId: raw.task_id,
    task: intent,
    route,
    tier1,
    tier2,
    // Carried through verbatim. An older verdict has no `outcome`; we do NOT
    // synthesise one from `passed` (that would assert "failed" over a run whose
    // real outcome was never recorded) — the field simply stays undefined.
    ...(raw.outcome ? { outcome: raw.outcome } : {}),
    ...(raw.outcome_reason ? { outcomeReason: raw.outcome_reason } : {}),
    tokensIn,
    tokensOut,
    cost,
    durationMs,
    modelRoute: `${tokensIn.toLocaleString()} tok in / ${tokensOut} out`,
    hooks,
    writeback,
    passed: raw.passed,
    // The real assistant completion text (either key); undefined when absent.
    response: raw.response ?? raw.answer,
    native,
    at: raw.timestamp || undefined,
    ...(project ? { project } : {}),
    ...(attempt ? { attempt } : {}),
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Provider config forwarded to a native engine run so the real model call
 * actually authenticates. Carries the LOCAL server config plus the enabled
 * CLOUD providers' keys + chosen models and the primary provider id, so the
 * engine's gateway can route to (and authenticate) whichever provider is
 * primary. `baseUrl` should already be normalized (no trailing `/v1`); any
 * field may be empty/undefined. Keys are passed straight to the Rust bridge
 * (which forwards them as env, never argv/logs) — never persisted here.
 */
export interface EngineProviders {
  /** Local OpenAI-compatible server base URL (→ OPENAI_BASE_URL). */
  baseUrl: string
  /** OPENAI_API_KEY — shared by the local server and cloud OpenAI. */
  apiKey: string
  /** CLAUDE_API_KEY (Anthropic Messages API). */
  claudeApiKey?: string
  /** GEMINI_API_KEY (Google OpenAI-compat endpoint). */
  geminiApiKey?: string
  /** Primary provider id (→ SCPRISM_PRIMARY): 'local'|'openai'|'claude'|'gemini'. */
  primary?: string
  /** Model id for the local/custom OpenAI-compatible endpoint (→ OPENAI_MODEL). */
  localModel?: string
  /** Optional per-provider model overrides. */
  openaiModel?: string
  claudeModel?: string
  geminiModel?: string
  /** Workspace context (interview summary) → SCPRISM_CONTEXT, appended to the
   * Companion charter so the primary knows the business + governance rules. */
  context?: string
  /** User-defined sensitive words (comma separated) → SCPRISM_SENSITIVE:
   * force-local routing, same power as the built-in list. */
  sensitive?: string
  /** The user's own verify command → the engine's deterministic Tier-1 gate. */
  tier1?: string
  /**
   * The DIRECTORY that verify command runs in — the bound project's folder.
   *
   * Not cosmetic: the engine subprocess's own working directory is the app
   * bundle's engine folder, which has no `package.json` in it or in any
   * ancestor, so a Tier-1 that inherits it dies with `npm error ENOENT` on
   * every run. Empty means "a verify command is configured, but this run has no
   * project directory": Tier-1 is a PROJECT gate, so the engine SKIPS it and
   * says why ("no project bound, nothing to verify") rather than guessing a
   * folder — a guessed folder produces failures indistinguishable from real
   * ones — and rather than failing a run that had no code to test.
   */
  tier1Cwd?: string
  /** Model override for a CLI-bridge primary (e.g. "opus", "fable"). */
  cliModel?: string
  /** Thinking/effort level: low | medium | high | xhigh | max. */
  effort?: string
  /** Opt-in engine extensions (SCPRISM_DEEPEVAL / _LIGHTRAG / _BIFROST). */
  flagDeepeval?: boolean
  flagLightrag?: boolean
  flagBifrost?: boolean
  /** Web research (web design, 2026-07-23). When true, the Rust bridge threads
   * `--web` so the run's v2b loop gets the governed web_fetch/web_search tool
   * source. Opt-in, default off — omitted/false is byte-identical to today. */
  webResearch?: boolean
  /** Tool posture (companion grant): 'ask' threads `--require-approval all`
   * so held tool calls park on the Work desk — argv belt-and-braces with the
   * vault's mcp-approvals.json policy. Anything else omits the flag. */
  mcpApproval?: 'ask' | 'auto'
  /** Mid-run blocking approval (companion grant, 2026-07-29). When true, the
   * bridge threads `--approval-blocking --approval-timeout 300`: the run
   * pauses at a held tool call until Approve/Deny on the Work desk; silence
   * means the tool honestly does not run. Off/omitted = byte-identical run.
   * Only meaningful with an ACTIVE require policy (mcpApproval 'ask'). */
  approvalBlocking?: boolean
  /**
   * Per-run cap on model OUTPUT tokens (→ SCPRISM_MAX_TOKENS).
   *
   * A heartbeat wake passes a small one. It asks for a first-line summary, and
   * the engine's default ceiling is 4096 — which on a local model generating at
   * ~5 tokens/second is thirteen minutes of inference for an answer nobody
   * wanted that long. Measured on the user's Mac, capping it took the worst
   * local call in a wake from 413s to 237s. Omitted/0 → no env, so the engine
   * keeps its own default and the run is byte-identical.
   *
   * It does NOT shorten Claude: the gateway floors max_tokens per effort level
   * for Anthropic, so a small cap here only ever bites the slow local route,
   * which is the one costing the time.
   */
  maxTokens?: number
  /**
   * Plan N steps instead of the engine's default shape (→ `--steps N`).
   *
   * Only 1 is special: a SINGLE findings step. The default plan is
   * understand -> locate -> produce and each step runs its OWN tool loop with
   * its own turn budget, so a task that needs to read two notes reads them
   * three times over. Right for "change this repo", ruinous for "check in and
   * do one small thing" — measured on the heartbeat wake, the default plan cost
   * 15m24s and 69,976 tokens to return "I ran out of tool turns"; one step cost
   * 4m29s and 8,993. Omitted/0 → no flag, byte-identical.
   */
  steps?: number
  /**
   * Name the worker for this run (→ `--agent`), and the phase of a larger job
   * it belongs to (→ `--stage`).
   *
   * A team run has always named its agents. A solo run named nobody, so a chat
   * reply, a companion wake and a project plan step were unattributable — 209
   * of 219 runs in the user's real vault carry no agent, which is why the crew
   * board is absent on almost everything he does. Omitted → no flags.
   */
  agentName?: string
  stage?: string
  /**
   * Withhold the vault TOOLS from this run (→ `--no-vault-tools`).
   *
   * This is a SPEED switch, not a privacy one, and the two are entangled:
   * reading a note through a tool trips the egress floor, which pins every
   * later turn of the run to the on-device model. On this Mac that is the
   * difference between a companion wake that answers in 54 seconds on 4,247
   * tokens and one that spends seven to fifteen minutes and 26,000–43,000
   * tokens and has never once landed a usable answer.
   *
   * What it costs is real: the run cannot dig into notes it was not already
   * handed. Omitted/false → the flag is absent and the run is byte-identical.
   */
  noVaultTools?: boolean
  /** Optional web_search API key (→ SCPRISM_SEARCH_API_KEY, env-only via the
   * bridge, never argv). Empty = the keyless default backend. */
  searchApiKey?: string
  /** Optional web_search API endpoint (→ SCPRISM_SEARCH_ENDPOINT). */
  searchEndpoint?: string
  /**
   * Per-agent CAPABILITIES (Sukh-orchestrates design, 2026-08-15).
   *
   * `userCapabilities` is the human's OWN grant, comma-separated — the ceiling
   * the engine clamps every agent to (`capabilities.AgentGrants.__init__`), so
   * a manager can never hand out what the user does not hold.
   * `agentCapabilities` is a JSON object of agent name → requested grants
   * (`delegation.agentCapabilitiesArg`), or a bare comma list for a solo run.
   *
   * Both omitted/empty → no flags → no gate, byte-identical to a run before
   * this landed. THIS IS THE SEAM, NOT THE ENFORCEMENT: the engine refuses an
   * ungranted tool at `capabilities.AgentCapabilityGate.call_tool` and an
   * ungranted write at `project.apply_file_ops`, whatever the app sends.
   */
  userCapabilities?: string
  agentCapabilities?: string
}

/** Availability of the optional engine extensions on this machine. */
export interface ExtensionAvailability {
  deepeval: boolean
  lightrag: boolean
  llm: boolean
  bifrost: boolean
}

export async function checkExtensions(): Promise<ExtensionAvailability> {
  const none = { deepeval: false, lightrag: false, llm: false, bifrost: false }
  if (!isNative()) return none
  try {
    return await invoke<ExtensionAvailability>('check_extensions')
  } catch {
    return none
  }
}

/**
 * Write a markdown note into the vault (overwrite) — co-founder deliverables
 * like plans/first-automations.md. Returns the absolute path, or null on
 * failure / non-native. `relpath` must stay inside the vault (no `..`).
 */
export async function writeVaultNote(
  vault: string,
  relpath: string,
  content: string,
): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('write_vault_note', { vault, relpath, content })
  } catch {
    return null
  }
}

/** Append `content` to a vault file (true append, no size cap). Returns the path, or null (non-native / failure). */
export async function appendVaultNote(vault: string, relpath: string, content: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('append_vault_note', { vault, relpath, content })
  } catch {
    return null
  }
}

/** All markdown files in the vault (relative paths, sorted). */
export async function listVaultTree(vault: string): Promise<string[]> {
  if (!isNative()) return []
  try {
    return await invoke<string[]>('list_vault_tree', { vault })
  } catch {
    return []
  }
}

/**
 * Files under ONE vault subdirectory, any extension (relative paths, sorted).
 *
 * `listVaultTree` returns only `.md`, which is right for a markdown vault and
 * wrong for `tools/`, where every manifest is `.json`. The generated-tools view
 * showed "none yet" against a vault holding two tools purely because nothing
 * could see a non-markdown file.
 */
export async function listVaultDir(vault: string, subdir: string): Promise<string[]> {
  if (!isNative()) return []
  try {
    return await invoke<string[]>('list_vault_dir', { vault, subdir })
  } catch {
    return []
  }
}

/** One vault note's change-relevant identity — the heartbeat's unchanged-state
 *  guard compares these instead of paying a model to re-read the files. */
export interface VaultNoteMeta {
  path: string
  mtime: number
  size: number
}

/** All markdown files in the vault WITH mtime+size (sorted by path). Same walk
 *  and caps as list_vault_tree; the metadata is what turns "8 notes" from a
 *  count into a real change detector. */
export async function listVaultTreeMeta(vault: string): Promise<VaultNoteMeta[]> {
  if (!isNative()) return []
  try {
    return await invoke<VaultNoteMeta[]>('list_vault_tree_meta', { vault })
  } catch {
    return []
  }
}

/** Read one vault markdown file, or null (missing / too large / non-native). */
export async function readVaultFile(vault: string, relpath: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('read_vault_file', { vault, relpath })
  } catch {
    return null
  }
}

/** Delete one vault file. Returns an error string, or null on success. */
export async function deleteVaultFile(vault: string, relpath: string): Promise<string | null> {
  if (!isNative()) return 'native app required'
  try {
    await invoke('delete_vault_file', { vault, relpath })
    return null
  } catch (e) {
    return String(e)
  }
}

/** Files that reference `target` — real backlinks scanned on disk (≤20). */
export async function findBacklinks(vault: string, target: string): Promise<string[]> {
  if (!isNative()) return []
  try {
    return await invoke<string[]>('find_backlinks', { vault, target })
  } catch {
    return []
  }
}

/** Run the engine's real compliance export; also saved to
 * <vault>/exports/compliance-export.json. Returns the JSON, or null. */
export async function runNativeExport(vault: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('run_engine_export', { vault })
  } catch {
    return null
  }
}

/** OKF v0.1 validation report for the vault. */
export interface OkfReport {
  ok: boolean
  issues: { path: string; code: string; message: string }[]
  warnings: { path: string; code: string; message: string }[]
  doc_count: number
}

/** Validate the vault against the OKF contract (native engine). */
export async function runNativeOkf(vault: string): Promise<OkfReport | null> {
  if (!isNative()) return null
  try {
    const json = await invoke<string>('run_engine_okf', { vault })
    const r = JSON.parse(json) as OkfReport
    if (typeof r?.ok !== 'boolean') return null
    return r
  } catch {
    return null
  }
}

/** One MCP server registration, matching <vault>/mcp-servers.json entries. */
export interface McpServerConfig {
  name: string
  command: string[]
  allowed_tools?: string[] | null
}

/** A tool discovered on a live MCP server (from the engine handshake). */
export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

/** Result of testing (listing) a server: real tools, or an honest error string. */
export type McpTestResult =
  | { ok: true; server: string; tools: McpToolInfo[] }
  | { ok: false; error: string }

/** Read the vault's MCP server registrations. [] when non-native, missing, or malformed. */
export async function readMcpServers(vault: string): Promise<McpServerConfig[]> {
  if (!isNative()) return []
  try {
    const raw = await readVaultFile(vault, 'mcp-servers.json')
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data.filter(
      (e): e is McpServerConfig =>
        !!e && typeof e.name === 'string' && Array.isArray(e.command) &&
        e.command.every((c: unknown) => typeof c === 'string'),
    )
  } catch {
    return []
  }
}

/** Persist MCP server registrations to <vault>/mcp-servers.json. Returns true on success. */
export async function writeMcpServers(vault: string, servers: McpServerConfig[]): Promise<boolean> {
  if (!isNative()) return false
  const json = JSON.stringify(
    servers.map((s) => ({
      name: s.name,
      command: s.command,
      ...(s.allowed_tools && s.allowed_tools.length ? { allowed_tools: s.allowed_tools } : {}),
    })),
    null,
    2,
  )
  const path = await writeVaultNote(vault, 'mcp-servers.json', json)
  return path !== null
}

// ---------------------------------------------------------------------------
// MCP approval policy — <vault>/mcp-approvals.json ({require, granted}), the
// same file the engine's ApprovalGate reads (engine/scprism_engine/approval.py).
// A held tool call becomes "granted" for the NEXT run by adding its name here —
// approving never re-runs the already-held call, it only permits future runs.
// Mirrors readMcpServers/writeMcpServers (readVaultFile/writeVaultNote JSON).
// ---------------------------------------------------------------------------

/** The approval policy persisted at <vault>/mcp-approvals.json. */
export interface McpApprovalPolicy {
  require: string[]
  granted: string[]
}

/**
 * The engine's own vault tool source (`server_name: 'vault'`) — pre-granted, so
 * the posture control below never holds it.
 *
 * Ask-first writes the `all` sentinel, which held EVERY tool call including the
 * companion's own eyes: with the shipped default (mcpApproval 'ask') it could
 * not read a single note without a manual approval per call, burning its tool
 * budget on holds and reporting itself blind. These four tools are read-only —
 * no write, rename or delete exists in the source — and the engine forces a run
 * LOCAL the moment one returns content (loop.VAULT_LOCAL_REASON), so granting
 * them costs the user no egress and no mutation. mcp/web tools are NOT covered:
 * they reach the network and the user's own servers, and they stay held.
 */
export const VAULT_TOOL_SERVER = 'vault'

/** `granted` with the vault server unioned in, order + other names preserved. */
export function withVaultGranted(granted: string[]): string[] {
  return granted.includes(VAULT_TOOL_SERVER) ? granted : [...granted, VAULT_TOOL_SERVER]
}

/**
 * The pure half of the vault-grant MIGRATION: the policy this one must become.
 *
 * `withVaultGranted` was only ever applied when the user RE-SAVED their tool
 * posture (CompanionGrants' chooser, Settings' posture control). An install that
 * predates it — or one whose `granted` grew one approved tool name at a time via
 * the desk — never re-saves, so the server-level `vault` grant never lands. Its
 * companion then holds its OWN read-only note tools: with the blocking broker on,
 * every heartbeat wake stalls at the held call and dies at the 240s client
 * cancel, burning the engine lock each cadence (and blocking manager jobs).
 *
 * So the union is a migration, not a side effect of a user action. Rules:
 *  - `require` is preserved EXACTLY (posture is the user's choice, never ours).
 *  - every existing `granted` name survives, in order; only `vault` is appended.
 *  - an INACTIVE policy (empty `require`) is returned untouched — it can hold
 *    nothing, so the grant would be a no-op, and writing one would conjure an
 *    approvals file where the user has none.
 *  - idempotent: a policy that already carries the grant is returned BY
 *    IDENTITY, which is how the caller knows there is nothing to write.
 */
export function migrateVaultGrant(policy: McpApprovalPolicy): McpApprovalPolicy {
  if (policy.require.length === 0) return policy
  const granted = withVaultGranted(policy.granted)
  if (granted === policy.granted) return policy
  return { require: policy.require, granted }
}

/**
 * The pure half of the READ-ONLY CLASS migration (2026-08-17).
 *
 * The vault-server grant above fixed one source. It did not fix the shape of
 * the problem: with the `all` sentinel, every tool NAME the companion had not
 * met before costs its own approval prompt. The user met that as "this software
 * is asking for permission every time… again and again" — and his spans agreed:
 * 32 held calls, EVERY ONE a read (web_fetch 8x, vault_read 8x, web_search 6x,
 * project_status 6x, read_file 2x, vault_list 2x). An unattended wake that met
 * one stalled until the blocking timeout.
 *
 * He chose: let it work, hold only risky tools. So the migration adds the
 * read-only CLASS grant (`toolRisk.READ_ONLY_GRANT`) — not a list of names that
 * would go stale, and emphatically not the `all` wildcard. It frees exactly what
 * `engine/scprism_engine/toolrisk.py` proves read-only at the gate; every acting
 * tool, and every tool of every MCP server, is held exactly as before.
 *
 * Same rules as `migrateVaultGrant`, for the same reasons:
 *  - `require` is preserved EXACTLY — the posture is the user's choice.
 *  - every existing `granted` name survives, in order; only the class grant is
 *    appended (his hard-won per-tool grants are not "cleaned up").
 *  - an INACTIVE policy (empty `require`) is returned untouched — it holds
 *    nothing, so the grant is a no-op and writing one would conjure a posture.
 *  - a policy where the user ALREADY DECIDED (either way — see
 *    `readsDecidedExplicitly`) is returned untouched. A migration heals a
 *    default; it does not overrule a choice. Without this, tightening back to
 *    hold-everything would silently un-tighten on the next launch: Settings
 *    would say held, the gate would say free — the one failure this feature
 *    must not have.
 *  - idempotent: already-migrated is returned BY IDENTITY, so nothing is written
 *    on the second launch, or the hundredth.
 */
export function migrateReadOnlyGrant(policy: McpApprovalPolicy): McpApprovalPolicy {
  if (policy.require.length === 0) return policy
  if (readsDecidedExplicitly(policy)) return policy
  return { require: policy.require, granted: [...policy.granted, READ_ONLY_GRANT] }
}

/**
 * Both migrations, composed, as ONE pure transform. Identity when neither
 * changes anything — the caller writes only when the object actually differs.
 */
export function migrateToolPolicy(policy: McpApprovalPolicy): McpApprovalPolicy {
  const migrated = migrateReadOnlyGrant(migrateVaultGrant(policy))
  return migrated === policy ? policy : migrated
}

/**
 * Run the tool-policy migrations against the vault's real policy file, writing
 * ONLY when they actually change something. Returns the effective policy.
 *
 * Called once per app launch (AppProvider mount, and again if the vault path
 * changes) so an existing install self-heals without the user touching
 * anything — he does NOT have to re-save anything in Settings to stop being
 * asked about reads. Never throws; non-native → the inert empty policy, no
 * bridge calls.
 */
export async function ensureToolPolicyMigrated(vault: string): Promise<McpApprovalPolicy> {
  const policy = await readMcpApprovals(vault)
  const migrated = migrateToolPolicy(policy)
  if (migrated === policy) return policy
  await writeMcpApprovals(vault, migrated)
  return migrated
}

/** Coerce a policy field (string / list-of-strings / anything) into a clean name list. */
function toNameList(value: unknown): string[] {
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
  if (Array.isArray(value)) {
    return value.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
  }
  return []
}

/**
 * Read the vault's MCP approval policy. Missing / malformed / non-native →
 * `{require:[],granted:[]}` (never throws) — an inactive policy, exactly what
 * the engine treats as "no gate".
 */
export async function readMcpApprovals(vault: string): Promise<McpApprovalPolicy> {
  if (!isNative()) return { require: [], granted: [] }
  try {
    const raw = await readVaultFile(vault, 'mcp-approvals.json')
    if (!raw) return { require: [], granted: [] }
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { require: [], granted: [] }
    return {
      require: toNameList((data as Record<string, unknown>).require),
      granted: toNameList((data as Record<string, unknown>).granted),
    }
  } catch {
    return { require: [], granted: [] }
  }
}

/** Persist the MCP approval policy to <vault>/mcp-approvals.json. Non-native → false. */
export async function writeMcpApprovals(vault: string, policy: McpApprovalPolicy): Promise<boolean> {
  if (!isNative()) return false
  const json = JSON.stringify({ require: policy.require, granted: policy.granted }, null, 2)
  const path = await writeVaultNote(vault, 'mcp-approvals.json', json)
  return path !== null
}

/**
 * Grant approval for a tool (or server, or "all") by adding `name` to the
 * policy's `granted` list — read-modify-write, preserving `require` and
 * de-duping `granted`. `name` is matched by the engine against tool OR server
 * OR the "all" sentinel. Returns success; non-native → false. This permits the
 * NEXT run — it does NOT re-execute the already-held call.
 */
export async function grantToolApproval(vault: string, name: string): Promise<boolean> {
  if (!isNative()) return false
  const policy = await readMcpApprovals(vault)
  const granted = policy.granted.includes(name) ? policy.granted : [...policy.granted, name]
  return writeMcpApprovals(vault, { require: policy.require, granted })
}

// ---------------------------------------------------------------------------
// Mid-run BLOCKING approval — a run PAUSED RIGHT NOW at a held tool call,
// blocking on a live Approve/Deny. The engine (approval.py's
// BlockingApprovalBroker, off by default) writes a request to
// <vault>/approvals/pending/<id>.json and polls <vault>/approvals/decided/
// <id>.json for our answer: "allow" runs the tool, "deny"/timeout honestly does
// not, then it cleans up both files. This is DISTINCT from the after-the-fact
// grant above (grantToolApproval, which permits the NEXT run) — here a real
// subprocess is blocked waiting on THIS decision. Native-gated; a browser (no
// engine subprocess) has nothing to surface, so both wrappers no-op.
// ---------------------------------------------------------------------------

/**
 * One paused run awaiting a live decision — a request the engine wrote to
 * <vault>/approvals/pending/<id>.json. `id` is the decision key; `at` is
 * wall-clock epoch SECONDS (mirrors the file the engine wrote — the desk
 * converts to ms for its relative-time label, like RunStream's `at * 1000`).
 */
export interface PendingApproval {
  id: string
  run_id?: string
  server: string
  tool: string
  args_summary?: string
  at?: number
}

/**
 * Real paused runs awaiting a live Approve/Deny — scans the vault's
 * approvals/pending dir (read_pending_approvals). `[]` when non-native, the dir
 * is absent, or on any error, so nothing ever FABRICATES a pause: an item
 * appears only when the engine genuinely wrote a pending request.
 */
export async function readPendingApprovals(vault: string): Promise<PendingApproval[]> {
  if (!isNative()) return []
  try {
    const rows = await invoke<PendingApproval[]>('read_pending_approvals', { vault })
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/**
 * Answer a paused run: write <vault>/approvals/decided/<id>.json ATOMICALLY so
 * the engine resumes — `"allow"` runs the tool (still through the inner gates),
 * `"deny"` honestly does not. Returns true on success; non-native → false (no
 * engine subprocess is waiting). The engine cleans up the handshake files.
 */
export async function decideApproval(vault: string, id: string, decision: 'allow' | 'deny'): Promise<boolean> {
  if (!isNative()) return false
  try {
    await invoke('write_approval_decision', { vault, id, decision })
    return true
  } catch {
    return false
  }
}

/** Test a server by listing its tools through the engine (real handshake). */
export async function runNativeMcpList(vault: string, server: string): Promise<McpTestResult> {
  if (!isNative()) return { ok: false, error: 'the installed app is required to test MCP servers' }
  try {
    const out = await invoke<string>('run_engine_mcp', { vault, server })
    const r = JSON.parse(out) as { server?: string; tools?: McpToolInfo[] }
    if (!Array.isArray(r?.tools)) return { ok: false, error: 'unexpected response from the engine' }
    return { ok: true, server: r.server ?? server, tools: r.tools }
  } catch (e) {
    // invoke throws with the Rust Err string — often the engine's {"ok":false,"error":"..."} (stderr).
    let msg = e instanceof Error ? e.message : String(e)
    // Prefer decoding the engine's clean JSON error (unescapes quotes/newlines
    // correctly); fall back to a regex, then the raw message.
    const trimmed = msg.trim()
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown }
      if (typeof parsed?.error === 'string') msg = parsed.error
    } catch {
      const m = trimmed.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      if (m) {
        try {
          msg = JSON.parse(`"${m[1]}"`) as string
        } catch {
          msg = m[1]
        }
      }
    }
    return { ok: false, error: msg || 'the server did not respond' }
  }
}

/** Number of GRPO training records collected in this vault. */
export async function readTrainingCount(vault: string): Promise<number> {
  if (!isNative()) return 0
  try {
    return await invoke<number>('read_training_count', { vault })
  } catch {
    return 0
  }
}

/**
 * Probe a URL through the Rust `ping_provider` command (native only). Returns
 * the HTTP status code, or `null` when not native or the connection failed
 * (Rust returns Err → `invoke` throws). Used by `pingProvider` to sidestep
 * webview CORS on cross-origin health checks.
 */
export async function nativePingProvider(
  url: string,
  apiKey: string,
  authHeader?: 'bearer' | 'x-api-key',
): Promise<number | null> {
  if (!isNative()) return null
  try {
    return await invoke<number>('ping_provider', { url, apiKey, authHeader })
  } catch {
    return null
  }
}

/**
 * RAW JSON body of a provider GET, through the Rust bridge (native only, so a
 * localhost server is not blocked by the webview's CORS rules). `null` when not
 * native, the endpoint could not be reached, or it answered non-2xx — the
 * caller then has NO server report and must say so rather than guess.
 *
 * This is how the local-model picker reads `/v1/models/status`: the server's
 * own per-model sizes, memory ceiling and load-rate estimate. Same auth shape
 * as `listProviderModels` (Bearer when a key is set).
 */
export async function providerGetJson(url: string, apiKey: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('provider_get_json', { url, apiKey, authHeader: 'bearer' })
  } catch {
    return null
  }
}

/**
 * Durable disk store (survives force-quit, unlike webview localStorage which
 * flushes lazily). Backed by `<appData>/store/<key>.json` via Rust. No-ops /
 * null in the browser.
 */
export async function storeSet(key: string, value: string): Promise<void> {
  if (!isNative()) return
  try {
    await invoke('store_set', { key, value })
  } catch {
    // non-fatal: localStorage still holds the value
  }
}

/**
 * The Mac's wake state (2026-08-15 spec §1 — "don't work on a sleeping Mac").
 * 'dark' is a maintenance/dark wake or a machine already stepping down towards
 * sleep — a wake started there cannot finish. 'unknown' means we could not tell,
 * and the rule for unknown is always RUN: work is never skipped on a guess.
 * `detail` is the real reason, so a skipped beat can say why.
 */
export interface PowerState {
  state: 'full' | 'dark' | 'unknown'
  detail: string
}

/** Read the wake state from the native side. Browser / any failure → 'unknown'
 *  (→ the caller runs), never 'dark'. Cheap: one `pmset -g systemstate`. */
export async function readPowerState(): Promise<PowerState> {
  if (!isNative()) return { state: 'unknown', detail: 'not the installed app' }
  try {
    const p = await invoke<PowerState>('power_state')
    const state = p?.state === 'dark' ? 'dark' : p?.state === 'full' ? 'full' : 'unknown'
    return { state, detail: typeof p?.detail === 'string' ? p.detail : '' }
  } catch (e) {
    return { state: 'unknown', detail: `power state unreadable: ${String(e)}` }
  }
}

export async function storeGet(key: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string | null>('store_get', { key })
  } catch {
    return null
  }
}

/**
 * Append one chat turn (user message + assistant reply) to the vault's markdown
 * conversation log (`<vault>/conversations/chat-log.md`) via the Rust bridge.
 * Best-effort: no-ops in the browser and swallows errors so a failed note write
 * never disrupts the chat.
 */
export async function appendChatNote(vault: string, userMsg: string, assistantMsg: string, model: string): Promise<void> {
  if (!isNative()) return
  try { await invoke('append_chat_note', { vault, userMsg, assistantMsg, model }) } catch { /* non-fatal */ }
}

/** One telemetry span from the engine's spans.jsonl (subset we display). */
export interface EngineSpan {
  name: string
  type?: string
  status?: string
  duration_ms?: number
  start?: number
  attrs?: Record<string, unknown>
  // Identity + parentage, exactly as telemetry.py writes them. Optional because
  // an older/partial line may lack them — never synthesized here. They are what
  // lets a reader attribute a span to ONE run (`spansForTask`) instead of
  // guessing from the tail, which is how a step gets pinned on the wrong run.
  span_id?: string
  parent_id?: string | null
  run_id?: string
}

/**
 * Tail of the vault's span stream — the live "engine console" feed. Returns
 * parsed spans (newest last); [] in the browser or when nothing ran yet.
 */
export async function readSpansTail(vault: string, maxLines = 60): Promise<EngineSpan[]> {
  if (!isNative()) return []
  try {
    const lines = await invoke<string[]>('read_spans_tail', { vault, maxLines })
    const spans: EngineSpan[] = []
    for (const line of lines) {
      try {
        const d = JSON.parse(line) as EngineSpan
        if (d && typeof d.name === 'string') spans.push(d)
      } catch {
        // skip malformed line
      }
    }
    return spans
  } catch {
    return []
  }
}

/**
 * One MCP tool call the engine HELD for approval (approval.py's ApprovalGate
 * emits a `tool_exec` span with `held=true`, no egress). `server`/`tool` name
 * the held call; `why` is a short reason/args summary when the span carries one
 * (a held span usually carries none — that's honest, not a bug); `at` is the
 * span's start converted to epoch MILLISECONDS (the engine writes seconds; see
 * `readHeldToolCalls`) for a relative-time label comparable to `Date.now()`.
 */
export interface HeldToolCall {
  server: string
  tool: string
  why?: string
  at?: number
  /**
   * The serving source's audit tag ('vault' / 'web' / 'mcp'), when the span
   * carried one. It is the key the RISK CLASSIFICATION reads (see toolRisk.ts),
   * so `dropAlreadyGranted` can tell a read the policy now frees from an acting
   * call that still waits. Absent → treated as acting → still shown as held,
   * which is the safe direction.
   */
  provider?: string
}

/** Short "k=v, k=v" summary of a tool's arguments (≤3 keys, values clamped). */
function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    let val: string
    if (v === null || v === undefined) val = String(v)
    else if (Array.isArray(v)) val = `[${v.length}]`
    else if (typeof v === 'object') val = '{…}'
    else val = String(v)
    if (val.length > 24) val = val.slice(0, 23) + '…'
    parts.push(`${k}=${val}`)
    if (parts.length >= 3) break
  }
  return parts.join(', ')
}

/** A short "why" for a held call from its span attrs — args/why over the engine's boilerplate reason. */
function heldWhy(a: Record<string, unknown>): string | undefined {
  if (typeof a.why === 'string' && a.why.trim()) return a.why.trim()
  if (a.args && typeof a.args === 'object' && !Array.isArray(a.args)) {
    const s = summarizeArgs(a.args as Record<string, unknown>)
    if (s) return s
  }
  // Drop the engine's generic "held: …" boilerplate — it just restates the label.
  if (typeof a.reason === 'string') {
    const r = a.reason.trim()
    if (r && !r.startsWith('held:')) return r
  }
  return undefined
}

/**
 * PURE: the tool calls the engine HELD for approval, distilled from a span
 * tail. Keeps `tool_exec` spans with `attrs.held === true`, maps each to a
 * {server, tool, why, at}, DEDUPES by `server+' '+tool` keeping the latest
 * `at`, and returns them newest-first. `[]` when nothing was held. Unit-testable
 * without the native shell (operates on already-read spans). `at` is converted
 * from the engine's epoch-SECONDS `start` to epoch-MILLISECONDS here (once),
 * so callers can compare it to `Date.now()` directly — mirrors RunStream.tsx's
 * `now - s.start * 1000`. This function does NOT know about the approval
 * policy (`granted`) — it stays a pure span→item projection; cross-checking
 * an already-granted tool happens at the call site (see `dropAlreadyGranted`).
 */
export function readHeldToolCalls(spans: EngineSpan[]): HeldToolCall[] {
  const byKey = new Map<string, HeldToolCall>()
  for (const s of spans) {
    const isToolExec = s.type === 'tool_exec' || s.name === 'tool_exec'
    const a = s.attrs ?? {}
    if (!isToolExec || a.held !== true) continue
    const server = typeof a.server === 'string' && a.server ? a.server : 'mcp'
    const tool = typeof a.tool === 'string' && a.tool ? a.tool : (typeof s.name === 'string' ? s.name : 'tool')
    // `s.start` is the engine's time.time() — epoch SECONDS — while every JS
    // consumer (relTime/Date.now()) works in ms; convert here, once, so `at`
    // is honest ms like RunStream.tsx's `now - s.start * 1000` (else a held
    // row reads as tens of thousands of days ago).
    const at = typeof s.start === 'number' ? s.start * 1000 : undefined
    const why = heldWhy(a)
    const provider = typeof a.provider === 'string' && a.provider ? a.provider : undefined
    const key = server + ' ' + tool
    const prev = byKey.get(key)
    if (!prev || (at ?? 0) >= (prev.at ?? 0)) {
      byKey.set(key, {
        server,
        tool,
        ...(why ? { why } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(provider ? { provider } : {}),
      })
    }
  }
  return [...byKey.values()].sort((x, y) => (y.at ?? 0) - (x.at ?? 0))
}

/**
 * PURE cross-check: drop any held call that is already covered by the
 * approval policy's `granted` set — mirrors the engine's own `_granted`
 * matching in approval.py (`tool in granted OR server in granted`). An
 * already-granted tool would NOT be held on the caller's next run, so
 * leaving it in `readHeldToolCalls`'s output would be dishonest: it must not
 * surface as "held for your approval" when it no longer needs approval.
 *
 * Deliberately does NOT treat the `"all"` sentinel as a wildcard grant here —
 * `"all"` is a `require`-side sentinel (hold everything ungranted); it is not
 * a real tool/server name, so checking for it in `granted` would be matching
 * the wrong field's vocabulary. Applied at the call site (Desk.tsx's
 * `useDeskState`) so `readHeldToolCalls` itself stays pure and knows nothing
 * about the approval policy.
 *
 * It DOES mirror the read-only CLASS grant, because the engine now honours it:
 * when `granted` carries `READ_ONLY_GRANT`, a held span for a call the
 * classification proves read-only would not be held on the next run, so leaving
 * it on the desk would be the same dishonesty this function exists to prevent.
 * The mirror is conservative in exactly the way the gate is: the classification
 * needs the span's `provider`, and a span without one stays listed.
 */
export function dropAlreadyGranted(
  held: readonly HeldToolCall[],
  granted: readonly string[],
  // The require side, so the mirror honours the same precedence the gate does:
  // a user who tightened back to hold-everything must see his held calls again.
  // Defaulted so existing callers keep the pre-class behaviour exactly.
  require: readonly string[] = [],
): HeldToolCall[] {
  if (granted.length === 0) return [...held]
  const readsFree = readsRunFree({ require, granted })
  return held.filter(
    (h) =>
      !granted.includes(h.tool) &&
      !granted.includes(h.server) &&
      !(readsFree && classifyTool(h.provider, h.tool) === READ_ONLY),
  )
}

/**
 * Obsidian vaults registered on this Mac (read from Obsidian's own registry;
 * only paths that still exist). Empty in the browser or when Obsidian is not
 * installed.
 */
export async function detectObsidianVaults(): Promise<string[]> {
  if (!isNative()) return []
  try {
    return await invoke<string[]>('detect_obsidian_vaults')
  } catch {
    return []
  }
}

/**
 * Locate a subscription CLI (`claude` / `gemini` / `codex`) on this machine via
 * the Rust bridge. Returns its absolute path, or `null` when not installed or
 * not running natively.
 */
export async function checkCli(bin: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('check_cli', { bin })
  } catch {
    return null
  }
}

/**
 * Ask a subscription CLI to actually ANSWER once (the Rust `probe_cli`), which
 * is the only thing that proves it works. `checkCli` proves the binary exists —
 * a very different claim: a `gemini` that is installed and up to date still
 * fails every call once Google closes that account's OAuth tier, and the app
 * used to show it green and keep giving it work.
 *
 * `{ ok: true }` — it answered. `{ ok: false, error }` — it could not, carrying
 * the CLI's OWN error line. Non-native returns a not-ok with an honest reason
 * (nothing is claimed to have been probed).
 */
export async function probeCli(
  bin: string,
  timeoutSecs?: number,
): Promise<{ ok: boolean; reply: string; error: string }> {
  if (!isNative()) return { ok: false, reply: '', error: 'not running natively' }
  try {
    const reply = await invoke<string>('probe_cli', { bin, timeoutSecs })
    return { ok: true, reply, error: '' }
  } catch (e) {
    return { ok: false, reply: '', error: String((e as { message?: string })?.message ?? e ?? '') }
  }
}

/**
 * Send a one-way Telegram report via the Rust bridge (token never touches the
 * webview's network layer). Returns `null` on REAL delivery (Telegram 2xx),
 * else the honest error string — callers must not claim delivery on non-null.
 */
export async function sendTelegram(token: string, chatId: string, text: string): Promise<string | null> {
  if (!isNative()) return 'not running natively'
  try {
    await invoke('send_telegram', { token, chatId, text })
    return null
  } catch (e) {
    return String(e)
  }
}

// ---------------------------------------------------------------------------
// Telegram TWO-WAY — the inbound half (2026-08-11 spec). Every one of these is
// a thin pass-through to `src-tauri/src/telegram.rs`, which owns the bot token
// for as long as reports are on. Note what is NOT here: no wrapper returns the
// token, and the two send functions do not TAKE one — the native side uses the
// copy it already holds, so the webview never hands the secret back. Browser →
// every call no-ops honestly (there is no poller and nothing to decide).
// ---------------------------------------------------------------------------

/** One inbound Approve/Deny tap that already passed the native chat-id check. */
export interface TelegramDecision {
  callback_id: string
  request_id: string
  decision: string
  chat_id: string
}

/**
 * Start the native `getUpdates` poller with these credentials. Returns `null`
 * on success, else the honest error (never containing the token — the Rust side
 * builds every error from fixed strings + Telegram's own description).
 */
export async function startTelegramWatch(token: string, chatId: string): Promise<string | null> {
  if (!isNative()) return 'not running natively'
  try {
    await invoke('telegram_watch_start', { token, chatId })
    return null
  } catch (e) {
    return String(e)
  }
}

/** Stop polling and make the native side FORGET the token. Safe to call twice. */
export async function stopTelegramWatch(): Promise<void> {
  if (!isNative()) return
  try {
    await invoke('telegram_watch_stop')
  } catch {
    /* stopping must never throw into a settings render */
  }
}

/** Drain the taps received since the last call (`[]` off native or on error). */
export async function takeTelegramDecisions(): Promise<TelegramDecision[]> {
  if (!isNative()) return []
  try {
    const rows = await invoke<TelegramDecision[]>('telegram_take_decisions')
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** The native side's honest local log (ignored taps, poll failures). */
export async function readTelegramWatchLog(): Promise<string[]> {
  if (!isNative()) return []
  try {
    const rows = await invoke<string[]>('telegram_watch_log')
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/**
 * Send a DECISION REQUEST — `text` plus Approve/Deny buttons carrying the
 * opaque `requestId`. Fails (honestly) when reports are off: the native side
 * has no token then, which is what keeps a request message from ever outliving
 * the user's consent. Returns `null` on real delivery, else the error.
 */
export async function sendTelegramRequest(text: string, requestId: string): Promise<string | null> {
  if (!isNative()) return 'not running natively'
  try {
    await invoke('send_telegram_request', { text, requestId })
    return null
  } catch (e) {
    return String(e)
  }
}

/** Answer a tap honestly (approved / already timed out / unknown request). */
export async function answerTelegramCallback(callbackId: string, text: string): Promise<void> {
  if (!isNative()) return
  try {
    await invoke('telegram_answer_callback', { callbackId, text })
  } catch {
    /* an unanswerable tap (expired callback id) must not break the pump */
  }
}

/** Open an external URL in the system browser (native via Rust, else a new tab). */
export async function openExternal(url: string): Promise<void> {
  if (isNative()) {
    try {
      await invoke('open_url', { url })
      return
    } catch {
      /* fall through to window.open */
    }
  }
  window.open(url, '_blank', 'noreferrer')
}

/** One project file for the room's Files panel — a real filesystem fact. */
export interface ProjectFileMeta {
  path: string
  dir: boolean
  mtime: number
  size: number
}

/**
 * The room's Files panel listing (project-room spec): the project folder's
 * real contents — capped, dotfiles/node_modules skipped, symlinks never
 * followed. Empty in the browser and for a missing dir; never throws.
 */
export async function listProjectFiles(dir: string): Promise<ProjectFileMeta[]> {
  if (!isNative()) return []
  try {
    return await invoke<ProjectFileMeta[]>('list_project_files', { dir })
  } catch {
    return []
  }
}

/** Reveal one vault note in the Finder from its vault-relative path (audit
 *  fix 2026-08-30: a file the stream names is reachable where it is named).
 *  Best-effort: resolves the vault root, then the same reveal every other
 *  affordance uses; silent no-op in the browser / on failure. */
export async function revealVaultNote(vaultPath: string | undefined, rel: string): Promise<void> {
  if (!isNative() || !rel) return
  try {
    const vault = await resolveVaultDir(vaultPath)
    await revealPath(`${vault}/${rel}`)
  } catch {
    // reveal is a convenience — never an error surface
  }
}

/** Write one file inside a project directory (Editor project mode). The Rust
 *  side enforces containment: absolute dir, no traversal, no symlink writes.
 *  Returns the absolute path written, or null on failure/browser. */
export async function writeProjectFile(
  dir: string,
  rel: string,
  content: string,
): Promise<string | null> {
  if (!isNative()) return null
  try {
    return await invoke<string>('write_project_file', { dir, rel, content })
  } catch {
    return null
  }
}

/** Open a local file in its default app (browser for html, Preview for
 *  images — his ask, 2026-08-31). Absolute existing files only; silent no-op
 *  in the browser. */
export async function openPath(path: string): Promise<void> {
  if (!isNative()) return
  try {
    await invoke('open_path', { path })
  } catch {
    // opening is a convenience — never an error surface
  }
}

/**
 * Reveal a built project's folder in the Finder (macOS `open -R`). Native-only
 * — there is no browser fallback for revealing a filesystem path, so this is
 * a no-op off native. Callers must pass an already-expanded absolute path
 * (see `expandUserPath` + `isUsableProjectDir`); the Rust side re-checks and
 * rejects anything non-absolute.
 */
export async function revealPath(path: string): Promise<void> {
  if (!isNative()) return
  try {
    await invoke('reveal_path', { path })
  } catch {
    /* best-effort — nothing to fall back to */
  }
}

/**
 * Run one task through the real Python engine via the Rust bridge and return a
 * mapped client `Verdict`. Returns `null` when not native or on any error
 * (spawn failure, malformed JSON) so callers can fall back to the simulation.
 *
 * When a `providers` config is supplied, the enabled providers' keys + chosen
 * models and the primary provider id are forwarded to the engine (as env, via
 * the Rust bridge) so a native run authenticates against whichever provider is
 * primary — local OR a real cloud provider.
 */
/**
 * An image attached to a chat message. `path` is the picked file's absolute
 * POSIX path — forwarded to the engine as `--image <path>`, which reads +
 * validates + base64s it. `name` is the basename for the composer chip.
 */
export interface EngineImage {
  path: string
  name: string
}

/**
 * Listen for a native event the Rust side emits, and return an unsubscribe.
 *
 * The manager's real clock is an OS thread in the Rust process, because macOS
 * throttles timers in a hidden WKWebView and a page-only interval means a
 * minimised app stops managing anything. This is how that tick reaches the
 * driver.
 *
 * Non-native (the browser build) resolves to a no-op unsubscribe rather than
 * throwing, so a caller can register unconditionally.
 */
export async function listenNative(
  event: string,
  handler: () => void,
): Promise<() => void> {
  if (!isNative()) return () => {}
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const off = await listen(event, () => handler())
    return () => {
      try {
        off()
      } catch {
        /* already torn down */
      }
    }
  } catch {
    // No event API (an older shell, or the import failed) — the caller's own
    // fallback interval is still running, so this degrades to what it was.
    return () => {}
  }
}

export async function runNativeTask(
  intent: string,
  vault: string,
  providers?: EngineProviders,
  runId = '',
  route?: 'local' | 'cloud' | 'auto',
  image?: EngineImage,
  // Optional hard token cap for this run (heartbeat wakes pass 20_000). Same
  // contract as `runNativeTeam`'s: 0 (the default — every chat/manager caller
  // passes nothing) makes the Rust bridge omit `--token-budget` entirely, so
  // the engine command is byte-identical to before the parameter existed; > 0
  // rides the run's contract envelope and breaching it fails the Verdict.
  tokenBudget = 0,
  // Optional per-run cap on TOOL EXECUTIONS per model turn. 0 (the default —
  // every chat/manager caller passes nothing) makes the Rust bridge omit
  // `--tool-turns` entirely, so the engine resolves SCPRISM_TOOL_TURNS or its
  // own default (12) and the command is byte-identical to before. > 0 is a
  // deliberate smaller/larger choice for THIS run (the heartbeat wake asks for
  // fewer); the engine clamps whatever it is, so this can never unbound a loop.
  toolTurns = 0,
  // Optional contract mode (`--mode`). The chat path passes 'converse' — the
  // one bit of kind information that stops a Work-page message from reaching
  // the contract as an inferred WRITE task and being judged as a build that
  // produced no files. Omitted/empty → the invoke field is undefined, the Rust
  // bridge pushes no flag, and every existing caller is byte-identical.
  mode?: 'read' | 'write' | 'converse',
): Promise<Verdict | null> {
  if (!isNative()) return null
  const started = Date.now()
  try {
    const json = await invoke<string>('run_engine_task', {
      // Cancellation handle: the Rust bridge retains the spawned child under
      // this id so `cancelEngineRun(runId)` can kill it on a client timeout.
      // Empty ('') → the bridge runs it uncancellable, byte-identical to before.
      runId,
      intent,
      vault,
      baseUrl: providers?.baseUrl ?? '',
      apiKey: providers?.apiKey ?? '',
      claudeApiKey: providers?.claudeApiKey ?? '',
      geminiApiKey: providers?.geminiApiKey ?? '',
      primary: providers?.primary ?? '',
      localModel: providers?.localModel ?? '',
      openaiModel: providers?.openaiModel ?? '',
      claudeModel: providers?.claudeModel ?? '',
      geminiModel: providers?.geminiModel ?? '',
      context: providers?.context ?? '',
      sensitive: providers?.sensitive ?? '',
      tier1: providers?.tier1 ?? '',
      // The project folder the verify command runs in. '' is forwarded on
      // purpose — the engine then skips the gate with "no project bound,
      // nothing to verify" instead of running `npm test` inside the app bundle
      // (or failing a chat message for having no tests to run).
      tier1Cwd: providers?.tier1Cwd ?? '',
      cliModel: providers?.cliModel ?? '',
      effort: providers?.effort ?? '',
      maxTokens: providers?.maxTokens ?? 0,
      steps: providers?.steps ?? 0,
      agentName: providers?.agentName ?? '',
      stage: providers?.stage ?? '',
      noVaultTools: providers?.noVaultTools ?? false,
      flagDeepeval: providers?.flagDeepeval ?? false,
      flagLightrag: providers?.flagLightrag ?? false,
      flagBifrost: providers?.flagBifrost ?? false,
      // Web research (opt-in): the Rust bridge only threads `--web` when true.
      web: providers?.webResearch ?? false,
      // Tool posture + mid-run blocking approval (companion grant).
      approval: providers?.mcpApproval === 'ask' ? 'all' : undefined,
      approvalBlocking: providers?.approvalBlocking ?? false,
      searchApiKey: providers?.searchApiKey ?? '',
      searchEndpoint: providers?.searchEndpoint ?? '',
      userCapabilities: providers?.userCapabilities ?? '',
      agentCapabilities: providers?.agentCapabilities ?? '',
      // Per-message route hint (composer local/cloud/auto). Only local/cloud are
      // sent; auto/undefined → undefined, so the Rust bridge omits `--route` and
      // the run is byte-identical to no hint. The gateway keeps sensitive content
      // local regardless of this request.
      route: route === 'local' || route === 'cloud' ? route : undefined,
      // Attached image PATH (image attach). Present → the Rust bridge threads
      // `--image <path>`; undefined → omitted, byte-identical to a text-only run.
      // A vision route sends the image; a non-vision route is told honestly it
      // wasn't sent. An image on a LOCAL route stays local, as always.
      image: image?.path,
      // Hard token cap (heartbeat wakes). 0 → the bridge omits the flag, same
      // empty-omission discipline as `run_engine_team`'s budget.
      tokenBudget,
      // Per-run tool-turn cap; 0 → omitted → the engine's own bounded default.
      toolTurns,
      // Contract mode; the chat path's 'converse'. Absent/empty → undefined →
      // the bridge omits `--mode` and the engine infers read/write as ever.
      mode: mode || undefined,
    })
    const raw = JSON.parse(json) as RawVerdict
    if (typeof raw?.task_id !== 'string') return null
    return mapVerdict(raw, intent, Date.now() - started)
  } catch {
    return null
  }
}

/**
 * Run one project-mode step through the real Python engine (`project`
 * subcommand) via the Rust bridge, and return a mapped client `Verdict`.
 * Returns `null` when not native or on any error (spawn failure, malformed
 * JSON) — same contract as `runNativeTask`. Provider credentials travel the
 * same env-only path; `context`/`refineFeedback` are plain argv values (not
 * secrets), passed only when non-empty. `existingMode`/`slug`/`neverTouch`
 * drive the engine's existing-repo branch-per-run lifecycle (`--existing`
 * `--slug` `--never-touch`, repeatable) — all no-ops on the v1 new-project
 * path when omitted. `runBranch` (→ `--run-branch`, V2-5) is the caller's
 * STORED run branch from a prior run that already returned to base (e.g.
 * after an 'attention' verdict); when it still names a real local branch the
 * engine resumes it instead of creating a new numbered branch, so steps
 * already committed on it are never abandoned. `roster` (P1-3, → `--agents`)
 * is an optional `name:provider,name:provider` spec (e.g.
 * `lead:claude,planner:gemini,developer:local`); when given, the engine runs
 * this step through a per-role board instead of a single model (P1-2).
 * Omitting it is byte-identical to today (single doer, no board).
 */
// The last REAL reason a project bridge call failed ('' when the last call
// succeeded). A spawn/bridge failure and a wall-clock timeout are different
// facts; the driver reads this so it never reports one as the other.
let lastProjectError = ''
export function lastEngineProjectError(): string {
  return lastProjectError
}

export async function runNativeProject(
  intent: string,
  projectDir: string,
  vault: string,
  providers: EngineProviders,
  opts?: {
    context?: string
    refineFeedback?: string
    /** Which attempt at ONE logical step this run is (1 = the first try, 2 =
     *  the first refine, …). Only recorded alongside `attemptGroup` — a number
     *  with nothing to belong to is not history. */
    attempt?: number
    /** Stable id for the step these attempts belong to (`<projectId>:step-N`).
     *  The engine never infers it: only this driver knows two runs are the
     *  same step. */
    attemptGroup?: string
    /** Path to the previous attempt's verdict JSON — what the refine turn is
     *  shown the CURRENT contents of, and the link back to the attempt it is
     *  fixing. */
    previousVerdict?: string
    existingMode?: boolean
    slug?: string
    neverTouch?: string[]
    runBranch?: string
    roster?: string
    /** Hard token cap for this step's contract envelope. 0/absent -> the
     *  engine's contract default (100k). A four-seat board step measured
     *  105,843 tokens on 2026-08-29 and failed the ENVELOPE with a judge
     *  score that had passed — a build step's cap must be the caller's
     *  deliberate number. */
    tokenBudget?: number
  },
  runId = '',
): Promise<Verdict | null> {
  if (!isNative()) return null
  const started = Date.now()
  try {
    const json = await invoke<string>('run_engine_project', {
      // Cancellation handle (see runNativeTask). '' → uncancellable, unchanged.
      runId,
      intent,
      projectDir,
      vault,
      // The plan step this run IS, so the board can draw one column per step.
      // Forwarded HERE as well as on run_engine_task: the project path is a
      // different bridge command, and wiring the flag to only one of them is
      // how `--steps` and `--no-vault-tools` each sat unreachable for hours.
      stage: providers.stage ?? '',
      baseUrl: providers.baseUrl ?? '',
      apiKey: providers.apiKey ?? '',
      claudeApiKey: providers.claudeApiKey ?? '',
      geminiApiKey: providers.geminiApiKey ?? '',
      primary: providers.primary ?? '',
      localModel: providers.localModel ?? '',
      openaiModel: providers.openaiModel ?? '',
      claudeModel: providers.claudeModel ?? '',
      geminiModel: providers.geminiModel ?? '',
      // SCPRISM_CONTEXT (workspace/interview context, env-only) — distinct
      // from `projectContext` below (the project brief, an argv value).
      context: providers.context ?? '',
      sensitive: providers.sensitive ?? '',
      tier1: providers.tier1 ?? '',
      cliModel: providers.cliModel ?? '',
      effort: providers.effort ?? '',
      flagDeepeval: providers.flagDeepeval ?? false,
      flagLightrag: providers.flagLightrag ?? false,
      flagBifrost: providers.flagBifrost ?? false,
      // Web research (opt-in): the Rust bridge only threads `--web` when true.
      web: providers.webResearch ?? false,
      searchApiKey: providers.searchApiKey ?? '',
      searchEndpoint: providers.searchEndpoint ?? '',
      userCapabilities: providers.userCapabilities ?? '',
      agentCapabilities: providers.agentCapabilities ?? '',
      projectContext: opts?.context ?? '',
      refineFeedback: opts?.refineFeedback ?? '',
      attempt: opts?.attempt ?? 0,
      attemptGroup: opts?.attemptGroup ?? '',
      previousVerdict: opts?.previousVerdict ?? '',
      existingMode: opts?.existingMode ?? false,
      slug: opts?.slug ?? '',
      neverTouch: opts?.neverTouch ?? [],
      runBranch: opts?.runBranch ?? '',
      roster: opts?.roster ?? '',
      tokenBudget: opts?.tokenBudget ?? 0,
    })
    const raw = JSON.parse(json) as RawVerdict
    if (typeof raw?.task_id !== 'string') return null
    lastProjectError = ''
    return mapVerdict(raw, intent, Date.now() - started)
  } catch (e) {
    lastProjectError = String(e)
    return null
  }
}

/**
 * Run a project's verify command as a governed, read-only check (the
 * project "test loop", P2-2) via the Rust `run_engine_verify` command, and
 * return a mapped client `Verdict`. Returns `null` when not native or on any
 * error (spawn failure, malformed JSON) — same contract as `runNativeTask`/
 * `runNativeProject`. Under the hood this runs the engine's `run` subcommand
 * with `verifyCommand` as its `--tier1` and `projectDir` as `--tier1-cwd`
 * (P2-2's verify-only seam): `run` mode has no FILE-block writing and never
 * branches, so this WRITES NO PROJECT FILES and never touches git — it only
 * executes `verifyCommand` inside `projectDir` and reports pass/fail.
 * Provider credentials travel the same env-only path as `runNativeTask`.
 */
export async function runNativeVerify(
  projectDir: string,
  verifyCommand: string,
  vault: string,
  providers: EngineProviders,
): Promise<Verdict | null> {
  if (!isNative()) return null
  const started = Date.now()
  const intent = "Run the project's verification and report pass/fail — make no changes."
  try {
    const json = await invoke<string>('run_engine_verify', {
      projectDir,
      verifyCommand,
      vault,
      baseUrl: providers.baseUrl ?? '',
      apiKey: providers.apiKey ?? '',
      claudeApiKey: providers.claudeApiKey ?? '',
      geminiApiKey: providers.geminiApiKey ?? '',
      primary: providers.primary ?? '',
      localModel: providers.localModel ?? '',
      openaiModel: providers.openaiModel ?? '',
      claudeModel: providers.claudeModel ?? '',
      geminiModel: providers.geminiModel ?? '',
      context: providers.context ?? '',
      sensitive: providers.sensitive ?? '',
      cliModel: providers.cliModel ?? '',
      effort: providers.effort ?? '',
      flagDeepeval: providers.flagDeepeval ?? false,
      flagLightrag: providers.flagLightrag ?? false,
      flagBifrost: providers.flagBifrost ?? false,
    })
    const raw = JSON.parse(json) as RawVerdict
    if (typeof raw?.task_id !== 'string') return null
    return mapVerdict(raw, intent, Date.now() - started)
  } catch {
    return null
  }
}

/**
 * Merge a finished run branch into `projectDir`'s CURRENT branch (engine
 * `project-merge` op — a plain, local merge; NEVER pushes, forces, or
 * rebases; a conflict aborts the merge and reports it honestly). `into` is
 * the merge target guard (v2 final review): the merge only proceeds when the
 * repo is ACTUALLY checked out on `into` — pass the project's stored
 * `baseBranch` so an interrupted run (repo left on the run branch) or an
 * external checkout refuses closed instead of self-merging or merging into
 * the wrong branch. Returns `{ ok, detail }` parsed defensively from the
 * engine's stdout JSON — present regardless of exit code, same
 * stdout-regardless-of-exit contract as `runNativeProject` — or `null` when
 * not native or on any error (spawn failure, malformed JSON).
 */
export async function runNativeProjectMerge(
  projectDir: string,
  branch: string,
  into: string,
): Promise<{ ok: boolean; detail: string } | null> {
  if (!isNative()) return null
  try {
    const json = await invoke<string>('run_engine_project_merge', { projectDir, branch, into })
    const j = JSON.parse(json) as { ok?: unknown; detail?: unknown }
    return { ok: !!j.ok, detail: String(j.detail ?? '') }
  } catch {
    return null
  }
}

/**
 * Return an attached project to a clean state (engine `project-finish` op):
 * wip-commit any leftovers left on a `scprism/*` run branch, then checkout
 * `base`. Same `{ ok, detail }` / `null` contract as `runNativeProjectMerge`.
 */
export async function runNativeProjectFinish(
  projectDir: string,
  base: string,
): Promise<{ ok: boolean; detail: string } | null> {
  if (!isNative()) return null
  try {
    const json = await invoke<string>('run_engine_project_finish', { projectDir, base })
    const j = JSON.parse(json) as { ok?: unknown; detail?: unknown }
    return { ok: !!j.ok, detail: String(j.detail ?? '') }
  } catch {
    return null
  }
}

/** One relayed message on a team run's shared board. */
export interface TeamBoardMsg {
  from: string
  provider: string
  model: string
  content: string
  is_real: boolean
  round: number
}

/**
 * Result of a multi-agent team run (engine `team` subcommand). TG-3: a team
 * run is now GOVERNED exactly like a single task — `passed`/`overBudget`/
 * `tokenBudget`/`reason`/`taskId`/`spansPath` carry the same Verdict the
 * client gates single-task runs on (see `mapVerdict`'s `Verdict.passed`),
 * just inlined onto this result instead of a separate `Verdict` object.
 */
export interface TeamResult {
  run_id: string
  board: TeamBoardMsg[]
  synthesis: string
  board_path: string
  tokens: number
  /** Whether the governed Verdict passed (Tier-1 + Tier-2, no over-budget breach). */
  passed: boolean
  /** True when the token budget was breached before the run finished. */
  overBudget: boolean
  /** The budget actually enforced (0 request -> the contract default, 100_000). */
  tokenBudget: number
  /** Human-readable pass/fail rationale (judge notes, or the budget breach). */
  reason: string
  /** The governed run's contract task_id (== run_id). */
  taskId: string
  /** Path to this run's spans.jsonl, for reconstruction/observability. */
  spansPath: string
  /** Path to this run's saved Verdict (<vault>/verdicts/<taskId>.json) — a
   *  link to the persisted governance record, mirroring `board_path`. */
  verdictPath: string
}

/**
 * Run a multi-agent team: each agent on its own provider, communicating via
 * the orchestrator-relayed board. Returns the parsed result, or null when not
 * native / the run failed. Keys travel via the same env-only path as tasks;
 * `providers` is forwarded in full (the shared fields match `runNativeTask`'s
 * invoke payload) so a team run authenticates/routes exactly like a governed
 * task. `tokenBudget` (TG-3, 0 -> engine contract default) is enforced by the
 * engine BEFORE every agent/synthesis call and breaching it fails the
 * returned Verdict (`passed=false`, `overBudget=true`).
 */
export async function runNativeTeam(
  intent: string,
  vault: string,
  providers: EngineProviders,
  agents: string,
  rounds = 1,
  tokenBudget = 0,
  runId = '',
  // Per-run tool-turn cap — same omit-means-default contract as runNativeTask.
  toolTurns = 0,
  /** Contract mode for the team verdict — 'converse' judges a question put to
   *  the board as a conversation (outcome 'replied'). ''/absent -> the read
   *  default, byte-identical. */
  mode = '',
): Promise<TeamResult | null> {
  if (!isNative()) return null
  try {
    const json = await invoke<string>('run_engine_team', {
      // Cancellation handle (see runNativeTask). '' → uncancellable, unchanged.
      runId,
      intent,
      vault,
      agents,
      rounds,
      mode,
      tokenBudget,
      toolTurns,
      baseUrl: providers.baseUrl ?? '',
      apiKey: providers.apiKey ?? '',
      claudeApiKey: providers.claudeApiKey ?? '',
      geminiApiKey: providers.geminiApiKey ?? '',
      primary: providers.primary ?? '',
      localModel: providers.localModel ?? '',
      openaiModel: providers.openaiModel ?? '',
      claudeModel: providers.claudeModel ?? '',
      geminiModel: providers.geminiModel ?? '',
      context: providers.context ?? '',
      sensitive: providers.sensitive ?? '',
      // The engine's `team` subcommand has no `--tier1` flag (a team's
      // Tier-1 is a synthetic, always-advisory pass — there is no
      // deterministic check to feed a verify command into); forwarded here
      // only so this payload matches `runNativeTask`'s shared-field shape,
      // and harmlessly ignored by the Rust bridge (`run_engine_team` does
      // not declare a `tier1` parameter).
      tier1: providers.tier1 ?? '',
      cliModel: providers.cliModel ?? '',
      effort: providers.effort ?? '',
      flagDeepeval: providers.flagDeepeval ?? false,
      flagLightrag: providers.flagLightrag ?? false,
      flagBifrost: providers.flagBifrost ?? false,
      // Web research (opt-in): the Rust bridge only threads `--web` when true.
      web: providers.webResearch ?? false,
      // Tool posture + mid-run blocking approval (companion grant).
      approval: providers.mcpApproval === 'ask' ? 'all' : undefined,
      approvalBlocking: providers.approvalBlocking ?? false,
      searchApiKey: providers.searchApiKey ?? '',
      searchEndpoint: providers.searchEndpoint ?? '',
      userCapabilities: providers.userCapabilities ?? '',
      agentCapabilities: providers.agentCapabilities ?? '',
    })
    const raw = JSON.parse(json) as Record<string, unknown>
    if (typeof raw?.run_id !== 'string' || !Array.isArray(raw.board)) return null
    return {
      run_id: raw.run_id,
      board: raw.board as TeamBoardMsg[],
      synthesis: String(raw.synthesis ?? ''),
      board_path: String(raw.board_path ?? ''),
      tokens: Number(raw.tokens ?? 0),
      passed: !!raw.passed,
      overBudget: !!raw.over_budget,
      tokenBudget: Number(raw.token_budget ?? 0),
      reason: String(raw.reason ?? ''),
      taskId: String(raw.task_id ?? ''),
      spansPath: String(raw.spans_path ?? ''),
      verdictPath: String(raw.verdict_path ?? ''),
    }
  } catch {
    return null
  }
}

/**
 * Fetch the engine's observability dashboard (REAL cost/hook/eval/cache/drift
 * views) via the Rust bridge. Returns `null` when not native or on any error
 * (spawn failure, malformed JSON) so callers can fall back to store-derived
 * values. A pure read of the vault's span stream — no task is run.
 */
export async function nativeDashboard(vault: string): Promise<Dashboard | null> {
  const r = await readNativeDashboard(vault)
  return r.kind === 'ok' ? r.dash : null
}

/**
 * A dashboard read, with the REASON it produced nothing.
 *
 * `nativeDashboard` collapses "there is no engine here" (the browser) and "the
 * engine is installed but this read failed" into the same `null`, and pages
 * then narrate the first cause for the second: one dropped read flipped Memory
 * from "86% measured over every run" to "0%, this session only" and Stats' hero
 * to a session count captioned "engine history unavailable here" — a statement
 * about the wrong thing, repeated every 2.5s, with the failure itself never
 * surfaced. The two are distinguished here so callers can keep the last good
 * measurement and say what actually went wrong.
 */
export type DashboardRead =
  | { kind: 'ok'; dash: Dashboard }
  | { kind: 'no-engine' }
  | { kind: 'error'; error: string }

export async function readNativeDashboard(vault: string): Promise<DashboardRead> {
  if (!isNative()) return { kind: 'no-engine' }
  try {
    const json = await invoke<string>('run_engine_dashboard', { vault })
    const dash = JSON.parse(json) as Dashboard
    if (typeof dash?.vault !== 'string' || !Array.isArray(dash.run_series)) {
      return { kind: 'error', error: 'the engine returned an unreadable dashboard' }
    }
    return { kind: 'ok', dash }
  } catch (e) {
    return { kind: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// Learning step (engine `train --dry-run`) — raw JSON emitted by
// engine/scprism_engine's train command. Confirmed shape (real vault, 117
// records, run 2026-07-16):
//   { vault, records, dry_run, trained, metrics: {...},
//     reward_before, reward_after, reward_lift,
//     gate: { promote, decision, lift, min_lift, baseline_mean,
//              candidate_mean, per_golden: [...], regressions: [...], reason },
//     promoted, decision, reason, current_version }
// The gate's `lift`/`regressions` (from the golden lift-gate) are what govern
// promote/discard — NOT the top-level `reward_lift` (raw GRPO training-set
// reward delta) — so LearnReport pulls `lift`/`regressions` from `gate`.
// ---------------------------------------------------------------------------

interface RawTrainGate {
  promote?: boolean
  decision?: string
  lift?: number
  regressions?: string[]
  reason?: string
}

interface RawTrainReport {
  records?: number
  gate?: RawTrainGate
  promoted?: boolean
  decision?: string
  reason?: string
}

/**
 * The app's honest view of a `train --dry-run` report. This step improves
 * ROUTE SELECTION (which model handles a task) via the golden lift-gate — it
 * never fine-tunes LLM weights and never auto-promotes past the gate.
 */
export interface LearnReport {
  decision: string
  promoted: boolean
  reason: string
  lift?: number
  regressions?: string[]
  recordCount?: number
}

/**
 * Defensively map the raw `train --dry-run` JSON onto a `LearnReport`. Pure
 * (no I/O), so it's unit-testable directly: `runNativeLearn` calls it after
 * `JSON.parse`. Returns `null` when `raw` isn't a plausible report (no
 * string `decision`) instead of throwing or fabricating a decision.
 */
export function parseLearnReport(raw: unknown): LearnReport | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as RawTrainReport
  if (typeof r.decision !== 'string') return null
  const gate = typeof r.gate === 'object' && r.gate !== null ? r.gate : undefined
  return {
    decision: r.decision,
    promoted: !!r.promoted,
    reason: String(r.reason ?? gate?.reason ?? ''),
    lift: typeof gate?.lift === 'number' ? gate.lift : undefined,
    regressions: Array.isArray(gate?.regressions) ? gate.regressions : undefined,
    recordCount: typeof r.records === 'number' ? r.records : undefined,
  }
}

/**
 * Run the engine's learning step (`train --dry-run`) via the Rust bridge and
 * return the honest PROMOTE/DISCARD decision. ALWAYS dry-run (the Rust side
 * forces `--dry-run`): reports whether promoting would help ROUTE SELECTION
 * (which model handles a task) — never LLM weight fine-tuning, and this call
 * never persists weights even when the gate says PROMOTE. `null` on
 * non-native or any error (spawn failure, malformed/implausible JSON).
 */
export async function runNativeLearn(vault: string): Promise<LearnReport | null> {
  if (!isNative()) return null
  try {
    const json = await invoke<string>('run_engine_train', { vault })
    return parseLearnReport(JSON.parse(json))
  } catch {
    return null
  }
}

/**
 * The human's explicit "Adopt this router" (LF-2) — runs the engine's learning
 * step WITHOUT `--dry-run` (Rust `run_engine_train_apply`), so the engine
 * PERSISTS a new versioned route policy IFF the golden lift-gate says PROMOTE.
 * The gate stays the machine gate: this never bypasses it (a DISCARD writes
 * nothing and the current router stays live). Like `runNativeLearn`, it only
 * ever changes ROUTE SELECTION (which model handles a task, local vs cloud) —
 * never LLM weight fine-tuning. Same parse; `null` on non-native or any error.
 */
export async function runNativeLearnApply(vault: string): Promise<LearnReport | null> {
  if (!isNative()) return null
  try {
    const json = await invoke<string>('run_engine_train_apply', { vault })
    return parseLearnReport(JSON.parse(json))
  } catch {
    return null
  }
}

/**
 * The route policy a vault has currently ADOPTED, read from
 * `<vault>/training/models/current.json` (LF-2). Returns the honest
 * `{version, updated}` the ModelRegistry wrote, or `null` when no learned
 * router is adopted (file missing / unreadable / not the expected shape) — the
 * caller shows "routing uses the built-in rules" for `null`. Never throws.
 */
export interface AdoptedRouter {
  version: string
  updated?: string
  // The snapshot's policy kind from `<version>/weights.json`. Only a
  // `route-policy` is actually consulted by the runtime Gateway
  // (`load_current_route_policy` rejects any other kind, e.g. `llm-policy`), so
  // the UI must NOT claim active adoption unless this is `route-policy`
  // (LF-fix F). `undefined` when the weights file is missing/unreadable.
  kind?: string
}

export async function readAdoptedRouter(vault: string): Promise<AdoptedRouter | null> {
  const raw = await readVaultFile(vault, 'training/models/current.json')
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const rec = parsed as { version?: unknown; updated?: unknown }
    if (typeof rec.version !== 'string' || !rec.version) return null
    // Read the real snapshot kind so the caller can tell an ADOPTED-and-ACTIVE
    // route policy from a snapshot the runtime ignores (mirrors the engine's
    // `load_current_route_policy` gate: kind === 'route-policy').
    let kind: string | undefined
    const wraw = await readVaultFile(vault, `training/models/${rec.version}/weights.json`)
    if (wraw) {
      try {
        const w = JSON.parse(wraw) as { kind?: unknown }
        if (typeof w?.kind === 'string') kind = w.kind
      } catch {
        // Corrupt weights -> leave kind undefined (runtime won't use it either).
      }
    }
    return {
      version: rec.version,
      updated: typeof rec.updated === 'string' ? rec.updated : undefined,
      kind,
    }
  } catch {
    return null
  }
}

/**
 * Pure, honest one-line summary of a `train --dry-run` result (P3-3) — the
 * single source of truth for the "Run learning step" panel's copy, so it can
 * never drift into "the model learns/retrains itself" phrasing. This step
 * only ever changes ROUTE SELECTION (which model handles a task, via the
 * golden lift-gate), so every string below says "router"/"routing", never
 * "the model" or "fine-tune".
 *
 * `recordCount` (from `readTrainingCount`, independent of any run) is the
 * source of truth for "are there enough records at all" — checked BEFORE
 * looking at `report`, so a stray/stale report can never be presented as a
 * real result once records read zero. `report === null` covers every case
 * where a real decision could not be honestly shown: not native, the bridge
 * call failed, or the JSON was unparseable/implausible (see
 * `parseLearnReport`) — never fabricated into a fake PROMOTE/DISCARD.
 */
export function formatLearnResult(report: LearnReport | null, recordCount: number): string {
  if (recordCount <= 0) return 'Not enough training records yet — run some tasks first.'
  if (!report) return "Couldn't run the learning step — try again."
  const lift = typeof report.lift === 'number' ? String(report.lift) : 'unknown'
  if (report.decision === 'PROMOTE') {
    return `The new router would improve routing (lift ${lift}) — dry run, not applied.`
  }
  return `Kept the current router — the newly trained one didn't beat the goldens (lift ${lift}).`
}

/**
 * Pure, honest one-line summary of an "Adopt this router" (LF-2, non-dry-run)
 * result — the single source of truth for the adopt button's copy, so it can
 * never drift into "the model learned/retrained itself". A PROMOTE in non-dry
 * mode is a real, persisted adoption (the gate approved it); a DISCARD wrote
 * nothing and the current router stays live. Route SELECTION only — never LLM
 * weight fine-tuning. `null` (non-native / bridge error / unparseable JSON) is
 * never presented as a success.
 */
export function formatAdoptResult(report: LearnReport | null, autoRoute = false): string {
  if (!report) return "Couldn't adopt the router — try again."
  if (report.decision === 'PROMOTE') {
    // R1: the adopted router only GOVERNS the default lane in Auto-route mode.
    // Claiming it is "the live router" unconditionally is false while a provider
    // is pinned (the pinned primary answers), so scope the copy to the mode.
    return autoRoute
      ? 'Adopted — the trained router beat the goldens and now governs your default routing lane (Auto-route is on).'
      : 'Adopted — the trained router beat the goldens. It governs the default lane in Auto-route mode; while a provider is pinned, your primary still answers.'
  }
  // NOOP is the engine's honest "nothing to train" outcome (cold vault / no
  // records) — it never reached the golden gate, so it did NOT "fail to beat
  // the goldens" (LF-fix G). Report it as such instead of a DISCARD.
  if (report.decision === 'NOOP') {
    return 'Nothing to adopt yet — no training records, so no router was trained (run some tasks first).'
  }
  return "Not adopted — the newly trained router didn't beat the goldens, so the current router stays live."
}
