// SC Prism — persisted settings (providers, vault, theme).
// A tiny React Context store backed by localStorage under `scprism.settings`.
// Written as a .ts module (no JSX) so it uses createElement directly.

import { clampBudget } from './budget'
import { clampBrandBudget } from './providerBudget'
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { checkCli, isNative, nativePingProvider, probeCli, storeGet, storeSet } from './nativeEngine'

// ---------- shape ----------

export type ThemeId = 'amber' | 'prism' | 'obsidian'
export type VaultMode = 'local' | 'github' | 'both'
/**
 * Manager View §5 build-approval gate: 'approve' (default for new users) —
 * before a project build runs, the Manager proposes the resolved team and
 * `runProject` is only called after an explicit "Approve & build"
 * (ProjectContextPanel). 'auto' — builds run directly, today's behavior.
 * ADR-007 intact either way: the user (or this auto policy) authorizes,
 * the deterministic engine runs.
 */
export type ApprovalMode = 'approve' | 'auto'

/**
 * How the default routing lane is decided (R1):
 *   'pinned' — your primary provider always answers the default lane (current
 *              behavior, the safe default).
 *   'auto'   — SC Prism routes local↔cloud itself, governed by your ADOPTED
 *              route policy (SCPRISM_PRIMARY is left unset so the engine's
 *              adopted-policy lane is actually reachable). Sensitivity still
 *              forces local; a reasoning intent still prefers cloud when one is
 *              configured. This is the ONLY mode in which an adopted router is
 *              live — see LearningPanel's honesty copy.
 */
export type RoutingMode = 'pinned' | 'auto'

/** The dependency dial (Sukhdeep, 2026-08-29: "is there any drag button where
 *  we can increase the dependency on online AI or local AI?"). Three honest
 *  positions for the DEFAULT lane of chat sends: 'local' fills the per-message
 *  route hint with local, 'cloud' with cloud, 'auto' leaves today's behavior
 *  untouched. It is a DEFAULT, nothing more — a per-message choice outranks
 *  it, and the privacy floor (sensitive work pins local) outranks everything. */
export type RouteBias = 'local' | 'auto' | 'cloud'

export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  enabled: boolean
  primary: boolean
  // Optional model id sent to the OpenAI-compatible endpoint. When absent a
  // sensible per-provider default is used (see providerModel).
  model?: string
  /** Thinking/effort level for this provider ('' = provider default). */
  effort?: string
  /**
   * A successful Connect happened and the credential is saved — the provider
   * stays "connected" across restarts until the user explicitly Disconnects
   * (which also clears the credential). Editing the key/URL clears it too.
   */
  connected?: boolean
}

/** Optional engine extensions (opt-in flags forwarded to native runs). */
export interface EngineFlags {
  deepeval: boolean
  lightrag: boolean
  bifrost: boolean
}

export interface Settings {
  providers: ProviderConfig[]
  vaultPath: string
  vaultMode: VaultMode
  /** GitHub repo the vault syncs to, as `owner/repository`. Empty = not set. */
  githubRepo: string
  /** GitHub personal access token used to verify + push. Empty = not set. */
  githubToken: string
  engineFlags: EngineFlags
  /** True once the user has manually touched an engine-flag toggle. Until
   * then the flags default ON (extensions auto-enable where available). */
  engineFlagsTouched: boolean
  /** The name the user gave their co-founder agent ('' = not named yet). */
  companionName: string
  /** What SC Prism calls YOU (the human). '' = not set. */
  yourName: string
  theme: ThemeId
  /** Manager View §5 build-approval gate. Default 'approve' (safe for new
   *  users) — see {@link ApprovalMode}. */
  approvalMode: ApprovalMode
  /** Default-lane routing mode. Default 'pinned' (your primary always answers);
   *  'auto' hands the default lane to your adopted router — see
   *  {@link RoutingMode}. */
  routingMode: RoutingMode
  /** Default-lane dependency dial — see {@link RouteBias}. */
  routeBias: RouteBias
  /** Max tokens one run may spend. 0 = the engine's own default (100,000).
   *  Made settable 2026-09-03 after a real three-agent board breached the
   *  invisible default, lost its third agent, and returned an empty answer. */
  tokenBudget: number
  /** A token ALERT per AI brand, keyed 'claude' | 'gemini' | 'openai' |
   *  'local'. Absent or 0 = no alert for that AI. One number per AI the user
   *  has connected, because one shared number could not express "ten million
   *  on Claude, half a million on Gemini" (Sukhdeep, 2026-09-03). */
  brandBudgets: Record<string, number>
  /** Web research (web design, 2026-07-23). When true, app-launched runs pass
   *  `--web` so the companion can fetch pages + search the web mid-run through
   *  the governed v2b tool loop. Default FALSE — the product egresses only on
   *  explicit opt-in; every web call is gated + shown in the run stream. */
  webResearch: boolean
  /** Agents may control THIS computer (screenshot/open/click/type) — strict
   *  opt-in; every action is one recorded span; macOS's own permission
   *  prompts (Screen Recording, Accessibility) still apply on top. */
  computerControl: boolean
  /** Agents may run terminal commands — strict opt-in; every command rides
   *  the approval gate and lands as one recorded span (command, cwd, exit). */
  terminalControl: boolean
  /** Company mode (phase A): 'solo' (default, today's app) or 'host' — this
   *  machine runs the company gateway teammates will join. */
  companyMode: 'solo' | 'host'
  /** The join code members present to the host gateway. Generated once when
   *  host mode is chosen; shown only on the host's own Hosting card. */
  companyCode: string
  /** Optional web_search API key (→ SCPRISM_SEARCH_API_KEY, held by the bridge,
   *  never rendered back as plaintext beyond a masked field — same discipline as
   *  a provider key). Empty = the keyless default backend. */
  searchApiKey: string
  /** Optional web_search API endpoint (→ SCPRISM_SEARCH_ENDPOINT). Paired with a
   *  key it selects a keyed backend; empty = the keyless default. */
  searchEndpoint: string
  /** Companion grant (onboarding): may the companion write real files under
   *  ~/SC Projects? Deny ⇒ project builds stay off until granted in Settings. */
  projectWrites: boolean
  /** Companion grant: MCP tool posture. 'ask' (default) ⇒ app-launched runs
   *  pass `--require-approval all` so held tool calls park on the Work desk;
   *  'auto' ⇒ tools run inside the engine's own allowlist + sensitivity gates. */
  mcpApproval: 'ask' | 'auto'
  /** Companion grant: mid-run BLOCKING approval. On ⇒ runs pass
   *  `--approval-blocking` (bounded `--approval-timeout 300`) — the run pauses
   *  at a held tool call until Approve/Deny, silent = honestly not run. */
  approvalBlocking: boolean
  /** Telegram reports (one-way, v1): bot token — held like a provider key,
   *  never rendered after save. Sends happen ONLY through the Rust bridge. */
  telegramBotToken: string
  /** Telegram chat id the reports go to. */
  telegramChatId: string
  /** Master switch for Telegram reports (run finished / needs-you). Confirmed
   *  by a REAL delivered test message in the grant flow — never assumed. */
  telegramReports: boolean
}

const STORAGE_KEY = 'scprism.settings'

// ---------- defaults ----------

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'local',
    name: 'Local model',
    baseUrl: 'http://localhost:1234',
    apiKey: '',
    enabled: true,
    primary: true,
    model: 'local-model',
  },
  {
    id: 'claude',
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    enabled: false,
    primary: false,
    model: 'claude-sonnet-5',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    apiKey: '',
    enabled: false,
    primary: false,
    model: 'gpt-5',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: '',
    enabled: false,
    primary: false,
    // Alias, not a pinned version (2026-08-31): Google retired
    // gemini-2.5-flash for new keys — a fresh user's very first Gemini call
    // returned HTTP 404 "no longer available to new users". The -latest
    // aliases keep pointing at a live model as Google rotates them.
    model: 'gemini-flash-latest',
  },
  // CLI-bridge providers: chats route through a locally installed agent CLI
  // signed in with the user's SUBSCRIPTION — no API key, no per-token billing.
  {
    id: 'claude-cli',
    name: 'Claude Code (Pro/Max plan)',
    baseUrl: '',
    apiKey: '',
    enabled: false,
    primary: false,
    model: '', // '' = the CLI's default; user can set opus / fable / sonnet
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI (Google login)',
    baseUrl: '',
    apiKey: '',
    enabled: false,
    primary: false,
    model: 'gemini-cli-account',
  },
  {
    id: 'codex-cli',
    name: 'Codex (ChatGPT plan)',
    baseUrl: '',
    apiKey: '',
    enabled: false,
    primary: false,
    model: 'codex-chatgpt-plan',
  },
]

/** CLI-bridge provider metadata: binary to detect, install page, sign-in hint. */
export const CLI_PROVIDERS: Record<
  string,
  { bin: string; install: string; hint: string }
> = {
  'claude-cli': {
    bin: 'claude',
    install: 'https://claude.com/claude-code',
    hint: 'npm install -g @anthropic-ai/claude-code, then run `claude` once to sign in with your Claude Pro/Max account.',
  },
  'gemini-cli': {
    bin: 'gemini',
    install: 'https://github.com/google-gemini/gemini-cli',
    hint: 'npm install -g @google/gemini-cli, then run `gemini` once to sign in with your Google account (free tier).',
  },
  'codex-cli': {
    bin: 'codex',
    install: 'https://developers.openai.com/codex/cli',
    hint: 'npm install -g @openai/codex, then run `codex` once to sign in with your ChatGPT account.',
  },
}

/**
 * Curated model aliases for subscription CLIs. CLIs expose no listing API, so
 * this is a hand-kept list of aliases the CLI itself resolves — newest/most
 * capable marked `recommended` and pinned to the top of the picker. The
 * picker always offers "custom…" so any other id the CLI accepts still works.
 */
export const CLI_MODEL_CHOICES: Record<
  string,
  { value: string; label: string; recommended?: boolean }[]
> = {
  'claude-cli': [
    { value: 'fable', label: 'fable — Fable 5 · newest, most capable', recommended: true },
    { value: 'opus', label: 'opus — Opus 5 · deep reasoning', recommended: true },
    { value: 'sonnet', label: 'sonnet — Sonnet 5 · fast + balanced' },
    { value: 'haiku', label: 'haiku — Haiku 4.5 · fastest' },
  ],
  'gemini-cli': [
    { value: 'gemini-flash-latest', label: 'gemini-flash-latest · fast, always current', recommended: true },
    { value: 'gemini-pro-latest', label: 'gemini-pro-latest · deepest reasoning, always current', recommended: true },
    { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro · pinned (older keys only)' },
    { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash · pinned (older keys only)' },
  ],
  // codex-cli: no safe curated list yet — the picker falls back to free text.
}

/** True when the provider routes through a local subscription CLI. */
export function isCliProvider(id: string): boolean {
  return id in CLI_PROVIDERS
}

/** True for user-added custom services (any OpenAI-compatible endpoint). */
export function isCustomProvider(id: string): boolean {
  return id.startsWith('custom-')
}

/**
 * "REAL + CONFIGURED" for ONE provider — the app's single definition of a
 * provider that can actually do work: it is switched on AND carries the
 * credential its kind needs (a base URL for the local server / a custom
 * OpenAI-compatible service, an API key for a cloud API, its own subscription
 * sign-in for a CLI bridge).
 *
 * This IS the test `buildEngineProviders` applies to the primary to decide
 * `primaryReal` (store/AppStore.tsx); it was lifted out here so every other
 * "can this provider work?" question in the app — above all which agents get a
 * seat on a team — asks the same question instead of inventing a second, looser
 * one. Before that, `agentRoster` filtered on the AGENT's `enabled` flag alone,
 * so an agent whose model mapped to a switched-OFF provider kept its seat on
 * every run and quietly contributed an offline stub.
 *
 * NOTE what this deliberately does NOT know: whether the provider is reachable,
 * or whether its subscription CLI can really answer right now. That is live
 * health (`pingProvider` + lib/connectivity), and `rosterGate` in lib/roster.ts
 * is where the two are combined.
 */
export function providerUsable(p: ProviderConfig | undefined): boolean {
  if (!p?.enabled) return false
  // A subscription CLI authenticates itself, so there is no credential to
  // check here; whether it can actually ANSWER is `probeCliProvider`'s job.
  if (isCliProvider(p.id)) return true
  if (p.id === 'local' || isCustomProvider(p.id)) return !!normalizeProviderBase(p.baseUrl)
  return !!p.apiKey?.trim()
}

/** Cloud providers whose flagship models can SEE an image (image attach). This
 * MIRRORS the engine's VISION_PROVIDERS set exactly: openai / claude / gemini.
 * Local, the CLI bridges, and custom OpenAI-compat endpoints are conservatively
 * treated as non-vision (a non-vision route is told honestly an image was
 * attached but not sent — never shown a fabricated "I can see it"). */
const VISION_PROVIDER_IDS = new Set(['openai', 'claude', 'gemini'])

/**
 * Whether the currently-enabled primary provider can actually see an attached
 * image. Used ONLY for the composer's honest hint ("this model can't see
 * images — it'll be told an image was attached"); the engine gateway remains
 * authoritative and re-decides per message.
 */
export function primarySupportsVision(settings: Settings): boolean {
  const p = settings.providers.find((x) => x.primary && x.enabled)
  return p ? VISION_PROVIDER_IDS.has(p.id) : false
}

/**
 * Display name of the enabled primary provider for Companion copy —
 * "Claude Code", "Gemini", "Your local model"… (plan suffixes stripped).
 */
export function primaryDisplayName(settings: Settings): string {
  // The user-given agent name always wins ("convert my primary AI to one
  // agent and give that agent one name").
  if (settings.companionName.trim()) return settings.companionName.trim()
  const p = settings.providers.find((x) => x.primary && x.enabled)
  if (!p) return 'Your Companion'
  if (p.id === 'local') return 'Your local model'
  return p.name.replace(/\s*\(.*\)\s*$/, '')
}

/** The underlying model label of the primary (independent of the pet name). */
export function primaryModelLabel(settings: Settings): string {
  const p = settings.providers.find((x) => x.primary && x.enabled)
  if (!p) return 'no primary'
  if (p.id === 'local') return 'local model'
  return p.name.replace(/\s*\(.*\)\s*$/, '')
}

/**
 * Known OpenAI-compatible services for the custom-card preset picker. Picking
 * one pre-fills URL + a sensible default model — the user only pastes a key.
 * Model ids drift over time; the field stays editable.
 */
export const CUSTOM_PRESETS: {
  name: string
  baseUrl: string
  model: string
  keyUrl?: string
}[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.ai', model: 'kimi-latest', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { name: 'Grok (xAI)', baseUrl: 'https://api.x.ai', model: 'grok-4', keyUrl: 'https://console.x.ai' },
  { name: 'Mistral', baseUrl: 'https://api.mistral.ai', model: 'mistral-large-latest', keyUrl: 'https://console.mistral.ai/api-keys' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys' },
  { name: 'OpenRouter (100+ models)', baseUrl: 'https://openrouter.ai/api', model: 'openrouter/auto', keyUrl: 'https://openrouter.ai/keys' },
  { name: 'Together AI', baseUrl: 'https://api.together.xyz', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', keyUrl: 'https://app.fireworks.ai/settings/users/api-keys' },
  { name: 'Qwen (Alibaba)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode', model: 'qwen-plus', keyUrl: 'https://bailian.console.alibabacloud.com' },
  { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai', model: 'llama-3.3-70b', keyUrl: 'https://cloud.cerebras.ai' },
  { name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com', model: 'meta/llama-3.3-70b-instruct', keyUrl: 'https://build.nvidia.com' },
]

// ---------- brand pairing ----------
// Each cloud brand exposes ONE visible card with a mode switch: connect via an
// API key (pay-per-token) OR via the subscription CLI (Pro/Max, ChatGPT plan,
// free Google login). Exactly one of the pair is enabled at a time.

export interface BrandView {
  brand: 'claude' | 'openai' | 'gemini'
  /** Display name of the brand card. */
  name: string
  api: ProviderConfig
  cli: ProviderConfig
  /** The provider the card currently operates on (mode-selected). */
  active: ProviderConfig
  mode: 'api' | 'cli'
  /** True when either half of the pair is enabled. */
  enabled: boolean
  /** Label for the subscription segment, e.g. "Pro/Max plan". */
  cliLabel: string
}

const BRAND_DEFS = [
  { brand: 'claude', name: 'Claude', api: 'claude', cli: 'claude-cli', cliLabel: 'Pro/Max plan' },
  { brand: 'openai', name: 'OpenAI', api: 'openai', cli: 'codex-cli', cliLabel: 'ChatGPT plan' },
  { brand: 'gemini', name: 'Gemini', api: 'gemini', cli: 'gemini-cli', cliLabel: 'Google login' },
] as const

/** The three brand cards derived from the flat provider list. */
export function brandViews(settings: Settings): BrandView[] {
  const byId = (id: string) => settings.providers.find((p) => p.id === id)
  const views: BrandView[] = []
  for (const def of BRAND_DEFS) {
    const api = byId(def.api)
    const cli = byId(def.cli)
    if (!api || !cli) continue
    const mode: 'api' | 'cli' = cli.enabled ? 'cli' : 'api'
    views.push({
      brand: def.brand,
      name: def.name,
      api,
      cli,
      active: mode === 'cli' ? cli : api,
      mode,
      enabled: api.enabled || cli.enabled,
      cliLabel: def.cliLabel,
    })
  }
  return views
}

/** Read a persisted per-brand alert map, clamping every value. A hand-edited
 *  store must not be able to set an alert that fires on ordinary work. */
function coerceBrandBudgets(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = clampBrandBudget(Number(v))
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

export const DEFAULT_SETTINGS: Settings = {
  providers: DEFAULT_PROVIDERS,
  vaultPath: '~/sc-vault',
  vaultMode: 'local', // GitHub sync is optional — local-only by default
  githubRepo: '',
  githubToken: '',
  engineFlags: { deepeval: true, lightrag: true, bifrost: true },
  engineFlagsTouched: false,
  companionName: '',
  yourName: '',
  theme: 'amber',
  approvalMode: 'approve',
  routingMode: 'pinned',
  routeBias: 'auto',
  tokenBudget: 0,
  brandBudgets: {},
  // Sprint D (2026-08-31, his order: 'agents are not able to search the
  // internet — I need that'). Web research is ON by default; every fetch still
  // rides the governed tool loop (allow-list, sensitivity withholding, spans).
  webResearch: true,
  computerControl: false, // strict opt-in — controlling the PC never defaults on
  terminalControl: false, // strict opt-in — running commands never defaults on
  companyMode: 'solo',
  companyCode: '',
  searchApiKey: '',
  searchEndpoint: '',
  projectWrites: true,
  mcpApproval: 'ask', // held tool calls park on the desk until you approve
  approvalBlocking: false,
  telegramBotToken: '',
  telegramChatId: '',
  telegramReports: false,
}

// The model string actually sent to the endpoint for a given provider.
export function providerModel(p: ProviderConfig): string {
  return p.model && p.model.trim() ? p.model.trim() : 'local-model'
}

// ---------- persistence ----------

export function mergeProviders(stored: unknown): ProviderConfig[] {
  const base = DEFAULT_PROVIDERS.map((p) => ({ ...p }))
  if (!Array.isArray(stored)) return base
  const merged = base.map((def) => {
    const found = (stored as ProviderConfig[]).find((p) => p && p.id === def.id)
    return found ? { ...def, ...found } : def
  })
  // Migration: stores written before "real model labels" (0d4475d) persisted
  // the provider-card LABEL as the claude-cli model; forwarded to the engine
  // it becomes a literal `--model claude-code-subscription` and every CLI
  // call dies to the offline stub. '' = the CLI's default (current seed).
  for (const p of merged) {
    if (p.id === 'claude-cli' && p.model === 'claude-code-subscription') p.model = ''
  }
  // User-added custom services survive reloads (they have no default entry).
  const customs = (stored as ProviderConfig[])
    .filter((p) => p && typeof p.id === 'string' && isCustomProvider(p.id))
    .map((p) => ({
      ...p,
      name: p.name || 'Custom service',
      baseUrl: p.baseUrl || '',
      apiKey: p.apiKey || '',
      enabled: Boolean(p.enabled),
      primary: Boolean(p.primary),
    }))
  return [...merged, ...customs]
}

/** Normalize a stored (possibly partial/stale) settings object. */
export function normalizeSettings(parsed: Partial<Settings> | null | undefined): Settings {
  if (!parsed) return { ...DEFAULT_SETTINGS, providers: mergeProviders(undefined) }
  return {
    providers: mergeProviders(parsed.providers),
    vaultPath: typeof parsed.vaultPath === 'string' ? parsed.vaultPath : DEFAULT_SETTINGS.vaultPath,
    vaultMode: parsed.vaultMode ?? DEFAULT_SETTINGS.vaultMode,
    githubRepo: typeof parsed.githubRepo === 'string' ? parsed.githubRepo : '',
    githubToken: typeof parsed.githubToken === 'string' ? parsed.githubToken : '',
    // Extensions default ON until the user explicitly toggles one (migration:
    // stores written before this existed get upgraded to on-by-default).
    engineFlags: parsed.engineFlagsTouched
      ? {
          deepeval: Boolean(parsed.engineFlags?.deepeval),
          lightrag: Boolean(parsed.engineFlags?.lightrag),
          bifrost: Boolean(parsed.engineFlags?.bifrost),
        }
      : { ...DEFAULT_SETTINGS.engineFlags },
    engineFlagsTouched: Boolean(parsed.engineFlagsTouched),
    companionName: typeof parsed.companionName === 'string' ? parsed.companionName : '',
    yourName: typeof parsed.yourName === 'string' ? parsed.yourName : '',
    theme: parsed.theme ?? DEFAULT_SETTINGS.theme,
    // Garbage/missing/anything but the literal 'auto' loads as the safe
    // default 'approve' — never silently upgrade a stale store to auto-run.
    approvalMode: parsed.approvalMode === 'auto' ? 'auto' : 'approve',
    // Anything but the literal 'auto' loads as 'pinned' — a stale store never
    // silently unsets the user's primary and hands routing to a learned policy.
    routingMode: parsed.routingMode === 'auto' ? 'auto' : 'pinned',
    // The dial loads only its three literal positions; garbage means 'auto'
    // (today's behavior), never a silent lean toward either side.
    routeBias:
      parsed.routeBias === 'local' || parsed.routeBias === 'cloud' ? parsed.routeBias : 'auto',
    // Clamped on read as well as on write: a hand-edited store must not be able
    // to set a budget that breaches before the first agent answers.
    tokenBudget: clampBudget(Number(parsed.tokenBudget)),
    brandBudgets: coerceBrandBudgets(parsed.brandBudgets),
    // Web research is opt-in: only the literal `true` turns it on. A stale /
    // garbage / missing value loads OFF — a run never egresses to the web
    // unless the user explicitly enabled it.
    // Only the literal false keeps it off — the governed default is on.
    webResearch: parsed.webResearch !== false,
    // Only the literal true grants PC control — garbage/missing stays OFF.
    computerControl: parsed.computerControl === true,
    terminalControl: parsed.terminalControl === true,
    // Only the literal 'host' hosts; anything else is solo (today's app).
    companyMode: parsed.companyMode === 'host' ? 'host' : 'solo',
    companyCode: typeof parsed.companyCode === 'string' ? parsed.companyCode : '',
    searchApiKey: typeof parsed.searchApiKey === 'string' ? parsed.searchApiKey : '',
    searchEndpoint: typeof parsed.searchEndpoint === 'string' ? parsed.searchEndpoint : '',
    projectWrites: parsed.projectWrites !== false, // default granted
    mcpApproval: parsed.mcpApproval === 'auto' ? 'auto' : 'ask',
    approvalBlocking: parsed.approvalBlocking === true,
    telegramBotToken: typeof parsed.telegramBotToken === 'string' ? parsed.telegramBotToken : '',
    telegramChatId: typeof parsed.telegramChatId === 'string' ? parsed.telegramChatId : '',
    telegramReports: parsed.telegramReports === true,
  }
}


/**
 * Resolve the route hint one send actually carries: the person's explicit
 * per-message choice always wins; otherwise the dependency dial fills the
 * blank; a dial at 'auto' returns undefined so today's path stays
 * byte-identical. The privacy floor is engine-side and outranks whatever
 * this returns.
 */
export function effectiveRoute(
  bias: RouteBias,
  hint: 'local' | 'cloud' | 'auto' | undefined,
): 'local' | 'cloud' | undefined {
  if (hint === 'local' || hint === 'cloud') return hint
  return bias === 'auto' ? undefined : bias
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return normalizeSettings(raw ? (JSON.parse(raw) as Partial<Settings>) : undefined)
  } catch {
    return normalizeSettings(undefined)
  }
}

// ---------- connectivity probe ----------

/**
 * Result of a provider health probe:
 *   'ok'          — a 2xx from /v1/models or /models (reachable; key, if any,
 *                   was accepted).
 *   'auth'        — a 401/403 (server IS reachable, but an API key is
 *                   needed/invalid). NOT the same as unreachable.
 *   'unreachable' — every candidate threw / timed out (nothing listening).
 */
export type ProviderStatus = 'ok' | 'auth' | 'unreachable'

/**
 * Normalize an OpenAI-compatible base URL for probing/forwarding: strip
 * trailing slashes AND a trailing `/v1` segment, so a URL that already ends in
 * `/v1` doesn't double-append when we probe `/v1/models` (or when the engine
 * appends `/v1/chat/completions`).
 */
export function normalizeProviderBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed.replace(/\/v1$/i, '').replace(/\/+$/, '')
}

// The auth scheme a provider's models endpoint expects: OpenAI-compatible
// providers (local / OpenAI / Gemini) use `Authorization: Bearer`; Anthropic's
// API uses `x-api-key` (+ `anthropic-version`).
type AuthStyle = 'bearer' | 'x-api-key'

// One probe GET returning the HTTP status code, or null on a network
// throw/timeout. Under Tauri the request goes through the Rust `ping_provider`
// command (avoids webview CORS + gives it TLS for https); in the browser it
// uses `fetch`.
async function probeStatus(
  url: string,
  apiKey: string,
  auth: AuthStyle,
): Promise<number | null> {
  if (isNative()) return nativePingProvider(url, apiKey, auth)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try {
    const headers: Record<string, string> = {}
    if (apiKey) {
      if (auth === 'x-api-key') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else {
        headers.Authorization = `Bearer ${apiKey}`
      }
    }
    const res = await fetch(url, { signal: controller.signal, headers })
    clearTimeout(timer)
    return res.status
  } catch {
    clearTimeout(timer)
    return null
  }
}

// The per-provider models probe: which path(s) to GET and which auth scheme to
// use. Cloud providers have a fixed, known probe URL; local (or an unknown id)
// falls back to trying both `/v1/models` and `/models`.
function probePlan(providerId: string | undefined): { paths: string[]; auth: AuthStyle } {
  switch (providerId) {
    case 'claude':
      return { paths: ['/v1/models'], auth: 'x-api-key' }
    case 'gemini':
      return { paths: ['/v1beta/openai/models'], auth: 'bearer' }
    case 'openai':
      return { paths: ['/v1/models'], auth: 'bearer' }
    default:
      return { paths: ['/v1/models', '/models'], auth: 'bearer' }
  }
}

/**
 * Fetch the provider's REAL available models (no hardcoded lists). Uses the
 * same per-provider models endpoint + auth scheme as the health probe.
 * Returns [] when unreachable / non-native / CLI providers (no listing API).
 */
export async function listProviderModels(p: ProviderConfig): Promise<string[]> {
  if (isCliProvider(p.id)) return [] // CLIs expose no listing API
  const base = normalizeProviderBase(
    p.baseUrl ||
      (p.id === 'claude'
        ? 'https://api.anthropic.com'
        : p.id === 'openai'
          ? 'https://api.openai.com'
          : p.id === 'gemini'
            ? 'https://generativelanguage.googleapis.com'
            : ''),
  )
  if (!base) return []
  const { paths, auth } = probePlan(p.id)
  const { invoke } = await import('@tauri-apps/api/core')
  for (const path of paths) {
    try {
      const models = await invoke<string[]>('list_models', {
        url: base + path,
        apiKey: p.apiKey ?? '',
        authHeader: auth,
      })
      if (models.length) return models
    } catch {
      // try the next candidate path
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Subscription-CLI health — THREE states, because "installed" was being shown
// as if it meant "usable" (2026-08-12).
//
// The old check asked one question: is the binary on this machine? A `gemini`
// that is installed and current still fails EVERY call once Google closes that
// account's OAuth tier ("IneligibleTierError: This client is no longer
// supported for Gemini Code Assist for individuals") — and the card said
// "installed" in green while the agent on it kept its seat on every team run
// and contributed a 13-token offline stub to real work.
//
// So the probe now makes the CLI answer once, and the three outcomes are told
// apart and named: NOT INSTALLED ('unreachable'), INSTALLED BUT CANNOT ANSWER
// ('auth', carrying the CLI's own error line — signed out, or a closed tier),
// and WORKING ('ok'). Cheapness is a requirement: the result is CACHED, so a
// render, a roster build or a team launch never triggers a probe. It is
// re-run only when the cache is stale (TTL) or a Connect/Retry click forces it.
// ---------------------------------------------------------------------------

/** One settled CLI probe: what it proved, in the CLI's own words. */
export interface CliProbe {
  /** 'ok' answered · 'auth' installed but cannot answer · 'unreachable' not installed. */
  status: ProviderStatus
  /** The CLI's own error line (''-when-fine) — never our paraphrase. */
  detail: string
  /** Epoch ms this probe settled. */
  at: number
}

/** How long a settled CLI probe is trusted before it is worth re-running. */
export const CLI_PROBE_TTL_MS = 30 * 60_000

const cliProbes = new Map<string, CliProbe>()
const cliProbesInFlight = new Map<string, Promise<CliProbe>>()

/** The last settled probe for a CLI provider, or undefined if never probed.
 *  Synchronous and side-effect free — safe to read during a render. */
export function cachedCliProbe(providerId: string): CliProbe | undefined {
  return cliProbes.get(providerId)
}

/** Drop cached probes (a Disconnect, and test isolation). */
export function clearCliProbes(providerId?: string): void {
  if (providerId) cliProbes.delete(providerId)
  else cliProbes.clear()
}

/**
 * Prove a CLI bridge can answer — cached, coalesced, and bounded.
 * `force` (an explicit Connect/Retry click) ignores the cache; otherwise a
 * probe younger than {@link CLI_PROBE_TTL_MS} is reused as-is.
 */
export async function probeCliProvider(
  providerId: string,
  opts?: { force?: boolean; now?: number },
): Promise<CliProbe> {
  const meta = CLI_PROVIDERS[providerId]
  if (!meta) return { status: 'unreachable', detail: 'not a CLI provider', at: 0 }
  const now = opts?.now ?? Date.now()
  const cached = cliProbes.get(providerId)
  if (!opts?.force && cached && now - cached.at < CLI_PROBE_TTL_MS) return cached
  const running = cliProbesInFlight.get(providerId)
  if (running) return running

  const run = (async (): Promise<CliProbe> => {
    // Not installed and cannot-answer are DIFFERENT facts, so they are asked
    // as different questions and reported as different states.
    const path = await checkCli(meta.bin)
    if (!path) {
      return { status: 'unreachable', detail: `${meta.bin} is not installed`, at: Date.now() }
    }
    const res = await probeCli(meta.bin)
    return res.ok
      ? { status: 'ok', detail: '', at: Date.now() }
      : { status: 'auth', detail: res.error, at: Date.now() }
  })()
    .then((probe) => {
      cliProbes.set(providerId, probe)
      return probe
    })
    .finally(() => {
      cliProbesInFlight.delete(providerId)
    })

  cliProbesInFlight.set(providerId, run)
  return run
}

/** The short state word for a CLI provider, matching the three real states.
 *  Never "installed" for a CLI that has not been shown to answer. */
export function cliStatusLabel(status: ProviderStatus): string {
  return status === 'ok' ? 'working' : status === 'auth' ? "can't answer" : 'not installed'
}

/**
 * Ping a provider's models endpoint. Normalizes the base URL, then probes the
 * provider-appropriate path(s) with the right auth header (Bearer for
 * OpenAI-compatible local/OpenAI/Gemini; `x-api-key` for Claude). Classifies
 * the outcome as 'ok' | 'auth' | 'unreachable' (see {@link ProviderStatus}).
 * `providerId` selects the probe plan; omit it for a generic local probe.
 */
export async function pingProvider(
  baseUrl: string,
  apiKey?: string,
  providerId?: string,
  opts?: { force?: boolean },
): Promise<ProviderStatus> {
  // CLI-bridge providers have no endpoint. "Installed" is NOT an answer here
  // (see the note above `CliProbe`) — the CLI has to actually reply.
  if (providerId && isCliProvider(providerId)) {
    return (await probeCliProvider(providerId, { force: opts?.force })).status
  }
  const base = normalizeProviderBase(baseUrl)
  if (!base) return 'unreachable'
  const key = apiKey?.trim() ?? ''
  const { paths, auth } = probePlan(providerId)
  let sawAuth = false
  for (const path of paths) {
    const status = await probeStatus(base + path, key, auth)
    if (status === null) continue // network failure on this candidate
    if (status >= 200 && status < 300) return 'ok'
    if (status === 401 || status === 403) sawAuth = true
  }
  return sawAuth ? 'auth' : 'unreachable'
}

// ---------- context ----------

export interface SettingsContextValue {
  settings: Settings
  /** True once the native disk copy has been read (always true in the browser). */
  hydrated: boolean
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void
  setPrimary: (id: string) => void
  setTheme: (theme: ThemeId) => void
  setVault: (path: string, mode: VaultMode) => void
  setGithub: (repo: string, token: string) => void
  setEngineFlag: (flag: keyof EngineFlags, on: boolean) => void
  setCompanionName: (name: string) => void
  setYourName: (name: string) => void
  setApprovalMode: (mode: ApprovalMode) => void
  setRoutingMode: (mode: RoutingMode) => void
  setRouteBias: (bias: RouteBias) => void
  setTokenBudget: (n: number) => void
  setBrandBudget: (brand: string, n: number) => void
  /** Toggle web research (opt-in; default off). */
  setWebResearch: (on: boolean) => void
  setComputerControl: (on: boolean) => void
  setTerminalControl: (on: boolean) => void
  /** Choose solo or host. Choosing 'host' the first time generates the join
   *  code (crypto-random, stored once, never regenerated silently). */
  setCompanyMode: (mode: 'solo' | 'host') => void
  /** Set the optional web_search API key (held by the bridge, never rendered). */
  setSearchApiKey: (key: string) => void
  /** Set the optional web_search API endpoint. */
  setSearchEndpoint: (endpoint: string) => void
  /** Companion grant: allow real file writes under ~/SC Projects. */
  setProjectWrites: (on: boolean) => void
  /** Companion grant: MCP tool posture — 'ask' parks held calls on the desk. */
  setMcpApproval: (mode: 'ask' | 'auto') => void
  /** Companion grant: mid-run blocking approval on app-launched runs. */
  setApprovalBlocking: (on: boolean) => void
  /** Telegram reports: save bot token + chat id (held, never rendered). */
  setTelegramConfig: (token: string, chatId: string) => void
  /** Master switch for Telegram reports. */
  setTelegramReports: (on: boolean) => void
  /** Add a user-defined OpenAI-compatible service; returns nothing (row appears). */
  addCustomProvider: () => void
  /** Remove a custom service (no-op for built-in providers). */
  removeProvider: (id: string) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  // Disk hydration gate: don't write the durable store until we've read it,
  // or a stale localStorage copy could clobber the on-disk truth.
  const [hydrated, setHydrated] = useState(!isNative())

  // On startup, the DISK copy wins — localStorage flushes lazily and loses
  // the last writes when the app is force-quit (the "vault choice vanished"
  // bug). The store file is written synchronously on every change below.
  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    void storeGet('settings').then((raw) => {
      if (cancelled) return
      if (raw) {
        try {
          setSettings(normalizeSettings(JSON.parse(raw) as Partial<Settings>))
        } catch {
          // corrupt disk copy: keep localStorage state
        }
      }
      setHydrated(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // storage may be unavailable (private mode); non-fatal.
    }
    if (hydrated) void storeSet('settings', JSON.stringify(settings))
  }, [settings, hydrated])

  // Apply the persisted theme on mount and whenever it changes, so a reload
  // keeps the chosen theme. tokens.css reads [data-theme] for its overrides.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      hydrated,
      updateProvider: (id, patch) =>
        setSettings((s) => ({
          ...s,
          providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),
      setPrimary: (id) =>
        setSettings((s) => ({
          ...s,
          providers: s.providers.map((p) => ({
            ...p,
            primary: p.id === id,
            // choosing a provider as primary implies it is enabled
            enabled: p.id === id ? true : p.enabled,
          })),
        })),
      setTheme: (theme) => setSettings((s) => ({ ...s, theme })),
      setVault: (vaultPath, vaultMode) => setSettings((s) => ({ ...s, vaultPath, vaultMode })),
      setGithub: (githubRepo, githubToken) =>
        setSettings((s) => ({ ...s, githubRepo, githubToken })),
      setEngineFlag: (flag, on) =>
        setSettings((s) => ({
          ...s,
          engineFlags: { ...s.engineFlags, [flag]: on },
          engineFlagsTouched: true,
        })),
      setCompanionName: (companionName) => setSettings((s) => ({ ...s, companionName })),
      setYourName: (yourName) => setSettings((s) => ({ ...s, yourName })),
      setApprovalMode: (approvalMode) => setSettings((s) => ({ ...s, approvalMode })),
      setRoutingMode: (routingMode) => setSettings((s) => ({ ...s, routingMode })),
      setRouteBias: (routeBias) => setSettings((s) => ({ ...s, routeBias })),
      setTokenBudget: (tokenBudget: number) =>
        setSettings((s) => ({ ...s, tokenBudget: clampBudget(tokenBudget) })),
      setBrandBudget: (brand: string, n: number) =>
        setSettings((s) => ({
          ...s,
          brandBudgets: { ...s.brandBudgets, [brand]: clampBrandBudget(n) },
        })),
      setWebResearch: (webResearch) => setSettings((s) => ({ ...s, webResearch })),
      setComputerControl: (computerControl) => setSettings((s) => ({ ...s, computerControl })),
      setTerminalControl: (terminalControl) => setSettings((s) => ({ ...s, terminalControl })),
      setCompanyMode: (companyMode) =>
        setSettings((s) => ({
          ...s,
          companyMode,
          // First host choice mints the join code; it never silently changes.
          companyCode:
            companyMode === 'host' && !s.companyCode
              ? Array.from(crypto.getRandomValues(new Uint8Array(6)))
                  .map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32])
                  .join('')
              : s.companyCode,
        })),
      setSearchApiKey: (searchApiKey) => setSettings((s) => ({ ...s, searchApiKey })),
      setSearchEndpoint: (searchEndpoint) => setSettings((s) => ({ ...s, searchEndpoint })),
      setProjectWrites: (projectWrites) => setSettings((s) => ({ ...s, projectWrites })),
      setMcpApproval: (mcpApproval) => setSettings((s) => ({ ...s, mcpApproval })),
      setApprovalBlocking: (approvalBlocking) => setSettings((s) => ({ ...s, approvalBlocking })),
      setTelegramConfig: (telegramBotToken, telegramChatId) =>
        setSettings((s) => ({ ...s, telegramBotToken, telegramChatId })),
      setTelegramReports: (telegramReports) => setSettings((s) => ({ ...s, telegramReports })),
      addCustomProvider: () =>
        setSettings((s) => {
          const n = s.providers.filter((p) => isCustomProvider(p.id)).length + 1
          const custom: ProviderConfig = {
            id: `custom-${Date.now()}`,
            name: `Custom service ${n}`,
            baseUrl: '',
            apiKey: '',
            enabled: true,
            primary: false,
          }
          return { ...s, providers: [...s.providers, custom] }
        }),
      removeProvider: (id) =>
        setSettings((s) => {
          if (!isCustomProvider(id)) return s
          const removed = s.providers.find((p) => p.id === id)
          let providers = s.providers.filter((p) => p.id !== id)
          // Removing the primary falls back to the local server.
          if (removed?.primary) {
            providers = providers.map((p) => ({ ...p, primary: p.id === 'local' }))
          }
          return { ...s, providers }
        }),
    }),
    [settings, hydrated],
  )

  return createElement(SettingsContext.Provider, { value }, children)
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>')
  return ctx
}
