// SC Prism — Sukh decides who does the work, and says why (2026-08-15 spec).
//
// Sukhdeep's ask, verbatim: "I want one manager — Sukh — that handles all the
// co-founder tasks… My manager will be the main one interacting with the other
// AI, deciding which is going to do what. I need that coworker to do real work
// for me, not just showing something."
//
// This module is the DECIDING half. It is pure (no I/O, no React) so every
// honesty rule below is unit-testable:
//
//  1. NEVER A SILENT PICK. `decideRouting` always returns a `reason`, and the
//     reason is the real one — the thing that actually decided it, not a
//     plausible sentence written afterwards.
//  2. THE FLOOR WINS. When the job touches the user's own sensitive words, or
//     is derived from the vault, it is kept LOCAL and the reason shown is the
//     ENGINE'S OWN. We do not invent a second routing vocabulary: the floor
//     reasons here are byte-identical to the strings the engine records on its
//     `RouteDecision.reason` (gateway.py's sensitive branch and loop.py's
//     `VAULT_LOCAL_REASON`), and they are rendered through the SAME
//     `routeReasonLabel` the verdict card already uses. One machinery, one
//     wording, from the pre-run plan to the post-run verdict.
//  3. NEVER AN UNUSABLE PROVIDER. Who may take a seat is not decided here —
//     it is `roster.ts`'s `seatReason` (f2766c6), reused, and an excluded seat
//     is REPORTED with its reason rather than quietly dropped.
//  4. ONE AI IS NOT A TEAM. When only one provider can really answer, the
//     choice says so in plain words instead of performing a roster.
//
// The DELEGATION half (`delegationSteps`) derives what to show from REAL engine
// spans only — the same discipline as narrate.ts: every field of every step is
// entailed by a span attribute the engine actually wrote. Nothing is
// interpolated from what we hoped the run was doing.

import type { EngineSpan } from './nativeEngine'
import { routeReasonLabel } from './nativeEngine'
import {
  emptyRosterRefusal,
  seatReason,
  type ProviderHealthMap,
  type SitOut,
} from './roster'
import type { CliProbe, Settings } from './settings'

// ---------------------------------------------------------------------------
// Capabilities — the app-side MIRROR of the engine's grant vocabulary
// ---------------------------------------------------------------------------

/**
 * The four things a sub-agent can be given. This list is a MIRROR of
 * `engine/scprism_engine/capabilities.py :: CAPABILITIES`, and deliberately
 * contains nothing the engine cannot enforce — a capability that exists only
 * as a label in this file would be exactly the sin the spec forbids.
 *
 * Enforcement does NOT happen here. `vault`/`web`/`tools` are enforced by
 * `capabilities.AgentCapabilityGate.call_tool` (the inner tool source is never
 * touched for an ungranted call); `writes` is enforced by
 * `project.apply_file_ops`. Everything below is for SHOWING the user the truth
 * before they approve it.
 */
export const CAPABILITIES = ['vault', 'web', 'computer', 'terminal', 'tools', 'writes'] as const

export type Capability = (typeof CAPABILITIES)[number]

/** Plain words for a capability — what the desk row reads. */
export function capabilityLabel(cap: Capability): string {
  switch (cap) {
    case 'vault':
      return 'read your vault'
    case 'web':
      return 'search the web'
    case 'tools':
      return 'use your tools'
    case 'writes':
      return 'write project files'
    default:
      return cap
  }
}

/** `true` when `x` is one of the four real capabilities. */
export function isCapability(x: unknown): x is Capability {
  return typeof x === 'string' && (CAPABILITIES as readonly string[]).includes(x)
}

/** Clean a free-text list into real capabilities (unknown names DROPPED, never
 *  carried as decoration). Order follows CAPABILITIES so two equal sets read
 *  identically wherever they are shown. */
/**
 * The capabilities ONE agent really holds, from its own definition.
 *
 * An agent file's `tools:` line IS its capability request (agent-standard
 * design); `skills:` are procedures it knows. Reading only `skills` meant a
 * file that plainly said `tools: [web]` was silently denied the web — found
 * live 2026-08-31: the seeded Researcher could never research, and the crew
 * honestly reported "permission not granted" for a grant nothing had read.
 * Both lists are honoured (skills stay valid for back-compat), and the
 * engine's own per-agent gate still intersects with the user's ceiling.
 */
export function agentCapabilityNames(
  agent: { tools?: readonly string[]; skills?: readonly string[] } | undefined,
): Capability[] {
  if (!agent) return []
  return normalizeCapabilities([...(agent.tools ?? []), ...(agent.skills ?? [])])
}

export function normalizeCapabilities(raw: readonly string[] | string): Capability[] {
  const parts = typeof raw === 'string' ? raw.split(/[,\n]/) : raw
  const seen = new Set<Capability>()
  for (const part of parts) {
    const name = String(part ?? '').trim().toLowerCase()
    if (isCapability(name)) seen.add(name)
  }
  return CAPABILITIES.filter((c) => seen.has(c))
}

/**
 * What the USER themselves holds — the ceiling on every grant.
 *
 * Derived from real state, never assumed: `web` is the Settings web-research
 * opt-in, `writes` is the project-writes companion grant, `vault` is the vault
 * tool server being in the vault's own approval policy, and `tools` means at
 * least one MCP server is actually registered. A capability the user does not
 * hold cannot be granted to anybody (and the engine enforces that
 * independently — see `AgentGrants.__init__`).
 */
export interface UserGrantState {
  settings: Pick<Settings, 'webResearch' | 'projectWrites' | 'computerControl' | 'terminalControl'>
  /** The `vault` tool server is in the vault's mcp-approvals `granted` list. */
  vaultToolsGranted: boolean
  /** How many MCP servers are registered in `<vault>/mcp-servers.json`. */
  mcpServers: number
}

/**
 * The user's own capabilities FOR AN APP-LAUNCHED RUN — the ceiling every agent
 * grant is clamped to, stated from facts about the run rather than guesses:
 *
 *   • `vault`  — the vault tool source is built for every run the app starts
 *                (the Rust bridge never passes `--no-vault-tools`), so the
 *                capability genuinely exists on this run;
 *   • `tools`  — the bridge passes no `--mcp-server` at all, so an app-launched
 *                run has NO MCP tools and the ceiling is honestly zero;
 *   • `web`    — the Settings opt-in that decides whether `--web` is passed. Off
 *                means the web tools are not built, so the ceiling matches;
 *   • `writes` — the project-writes companion grant.
 *
 * ONE definition, used by both the desk (what a roster row may be given) and
 * the launcher (what is threaded to the engine), so the two can never disagree.
 * It requires NO vault I/O, which matters: the desk's single deduped span-tail
 * poll is the only native read that page is allowed to make.
 */
export function appRunCapabilities(
  settings: Pick<Settings, 'webResearch' | 'projectWrites' | 'computerControl' | 'terminalControl'>,
): Capability[] {
  return userCapabilities({ settings, vaultToolsGranted: true, mcpServers: 0 })
}

export function userCapabilities(state: UserGrantState): Capability[] {
  const held: Capability[] = []
  if (state.vaultToolsGranted) held.push('vault')
  if (state.settings.webResearch) held.push('web')
  // Computer control NEVER defaults on: only the explicit grant adds it, and
  // the engine's per-agent gate (an agent's own tools: [computer]) still
  // intersects on top — both doors must be open.
  if (state.settings.computerControl) held.push('computer')
  if (state.settings.terminalControl) held.push('terminal')
  if (state.mcpServers > 0) held.push('tools')
  if (state.settings.projectWrites) held.push('writes')
  return held
}

/** One capability that was asked for and could not be given, with the reason. */
export interface CapabilityRefusal {
  capability: Capability
  reason: string
}

/**
 * The no-escalation rule, MIRRORED for display: a grant is at most the user's
 * own grant. This exists so a roster row can show the truth BEFORE the tap —
 * it is NOT the security boundary. The boundary is
 * `capabilities.AgentGrants.__init__`, which takes the same intersection
 * engine-side no matter what this file computed, so a bug here can only ever
 * mis-DISPLAY, never over-grant.
 */
export function grantSubset(
  user: readonly Capability[],
  requested: readonly Capability[],
): { granted: Capability[]; refused: CapabilityRefusal[] } {
  const held = new Set(normalizeCapabilities(user as string[]))
  const asked = normalizeCapabilities(requested as string[])
  const granted: Capability[] = []
  const refused: CapabilityRefusal[] = []
  for (const cap of asked) {
    if (held.has(cap)) granted.push(cap)
    else
      refused.push({
        capability: cap,
        reason: `you have not granted "${capabilityLabel(cap)}" yourself, so no agent can be given it`,
      })
  }
  return { granted, refused }
}

/** The `--user-capabilities` argv value for the engine. */
export function userCapabilitiesArg(user: readonly Capability[]): string {
  return normalizeCapabilities(user as string[]).join(',')
}

/**
 * The `--agent-capabilities` argv value: a JSON object of agent name -> grants.
 * The engine intersects each one with `--user-capabilities` again, so this is a
 * REQUEST, not a decision.
 */
export function agentCapabilitiesArg(
  roster: readonly { name: string; capabilities: readonly Capability[] }[],
): string {
  const out: Record<string, Capability[]> = {}
  for (const row of roster) {
    const name = row.name.trim()
    if (!name) continue
    out[name] = normalizeCapabilities(row.capabilities as string[])
  }
  return JSON.stringify(out)
}

/**
 * The two argv values for a team run whose seats were STAFFED with capabilities
 * (`projectRoster.createFromRoster` stores each agent's granted capabilities on
 * its `skills`), or `null` when no seat on this roster carries any.
 *
 * `null` is the important half: with no per-agent grant on the roster the app
 * sends NO capability flags at all, the engine builds no grant table, and the
 * run is byte-identical to every run before this landed. A gate is switched on
 * only when there is a real, human-approved grant for it to enforce.
 *
 * `roles` is `role:token` pairs (the roster string the engine receives) matched
 * to library agents by name, so the JSON keys are exactly the agent names the
 * engine's board will call `set_agent` with.
 */
export function teamCapabilityArgs(
  roles: readonly { name: string; capabilities: readonly Capability[] }[],
  user: readonly Capability[],
): { userCapabilities: string; agentCapabilities: string } | null {
  const staffed = roles.filter((r) => normalizeCapabilities(r.capabilities as string[]).length > 0)
  if (staffed.length === 0) return null
  return {
    userCapabilities: userCapabilitiesArg(user),
    agentCapabilities: agentCapabilitiesArg(roles),
  }
}

// ---------------------------------------------------------------------------
// Who is on this install — the measured team
// ---------------------------------------------------------------------------

/** One AI Sukh could hand work to. */
export interface Teammate {
  /** The roster token / agent model brand: 'claude' | 'gemini' | 'local'. */
  token: string
  /** What to show a person. */
  label: string
  local: boolean
  /** Measured wall-clock for a typical turn on THIS install, in seconds. */
  typicalSeconds: number
  /** The strongest reasoner available here. At most one is true. */
  strongestReasoner: boolean
}

/**
 * The measured profile of each AI on this Mac (2026-08-15 measurements, cited
 * rather than guessed): Claude Code on the subscription CLI answers in ~10s and
 * is the strongest reasoner available; the local gemma-4-26b answers in ~15s,
 * is genuinely capable, and is the only zero-egress option — which makes it
 * mandatory for anything vault-derived.
 *
 * These numbers are used ONLY to write an honest reason. They never decide
 * whether a provider may take a seat — `roster.seatReason` does that, from the
 * live provider state.
 */
const AI_PROFILE: Record<string, Omit<Teammate, 'token'>> = {
  claude: {
    label: 'Claude',
    local: false,
    typicalSeconds: 10,
    strongestReasoner: true,
  },
  local: {
    label: 'your local model',
    local: true,
    typicalSeconds: 15,
    strongestReasoner: false,
  },
  gemini: {
    label: 'Gemini',
    local: false,
    typicalSeconds: 12,
    strongestReasoner: false,
  },
}

/** The brands Sukh may consider, in the order a tie is broken. */
export const TEAM_TOKENS = ['claude', 'local', 'gemini'] as const

/**
 * The team that can REALLY answer right now, plus everyone who sits out and
 * why. `seatReason` (roster.ts, f2766c6) is the single definition of usable —
 * agent-enabled and provider-connected are different facts, and this is the
 * second one.
 */
export function availableTeam(
  settings: Settings,
  opts?: { health?: ProviderHealthMap; probe?: (id: string) => CliProbe | undefined },
): { team: Teammate[]; sitOut: SitOut[] } {
  const team: Teammate[] = []
  const sitOut: SitOut[] = []
  for (const token of TEAM_TOKENS) {
    const profile = AI_PROFILE[token]
    if (!profile) continue
    const reason = seatReason(settings, token, opts)
    if (reason) {
      sitOut.push({ role: profile.label, token, reason })
      continue
    }
    team.push({ token, ...profile })
  }
  return { team, sitOut }
}

/**
 * The brand Sukh HIMSELF runs on — the user's primary provider, reduced to the
 * roster token. When the job lands here, the choice is "he does it himself"
 * rather than "he delegates", and the line says so.
 */
export function managerToken(settings: Settings): string {
  const primary = settings.providers.find((p) => p.primary)
  const id = primary?.id ?? 'local'
  if (id.startsWith('claude')) return 'claude'
  if (id.startsWith('gemini')) return 'gemini'
  return 'local'
}

// ---------------------------------------------------------------------------
// The routing decision
// ---------------------------------------------------------------------------

/**
 * The engine's OWN route reason for the sensitivity floor — byte-identical to
 * `gateway.py`'s `sensitive keyword '<hit>' -> keep local (no egress)`. We
 * write the engine's sentence rather than a second one of our own so the
 * pre-run plan and the post-run verdict cannot drift apart.
 */
export function sensitiveFloorReason(hit: string): string {
  return `sensitive keyword '${hit}' -> keep local (no egress)`
}

/**
 * The engine's OWN route reason for the vault egress floor — byte-identical to
 * `loop.py`'s `VAULT_LOCAL_REASON` (12ba45c).
 */
export const VAULT_FLOOR_REASON = 'vault content read -> kept local (no egress)'

/** The user's own sensitive word this job trips, or '' — the same list the app
 *  threads to the engine as `SCPRISM_SENSITIVE`, so a hit here is a hit there. */
export function sensitiveHit(intent: string, words: readonly string[]): string {
  const low = intent.toLowerCase()
  for (const raw of words) {
    const word = raw.trim().toLowerCase()
    if (word && low.includes(word)) return raw.trim()
  }
  return ''
}

export type RouteMode = 'self' | 'delegate' | 'team' | 'refused'

export interface RoutingInput {
  /** What the user actually asked for. */
  intent: string
  /** The user's own sensitive words (interview → `SCPRISM_SENSITIVE`). */
  sensitiveWords?: readonly string[]
  /** This job reads the user's vault, so the egress floor applies. */
  vaultDerived?: boolean
  /** Everyone who can really answer (see `availableTeam`). */
  team: readonly Teammate[]
  /** Everyone who cannot, with the honest reason. */
  sitOut?: readonly SitOut[]
  /** The user explicitly asked for a team, or the job names several jobs. */
  wantsTeam?: boolean
  /** Sukh himself runs on this token; he does it HIMSELF when he is the pick. */
  managerToken?: string
}

export interface RoutingChoice {
  mode: RouteMode
  /** Who will do it, in order. [] when refused. */
  assigned: Teammate[]
  /** THE reason — always present, always the real one. */
  reason: string
  /**
   * The gateway-shaped `RouteDecision.reason` this choice rests on, or '' when
   * no floor fired. Carried so the app shows the engine's own words and a test
   * can prove the two are the same string.
   */
  engineReason: string
  /** A floor (sensitivity / vault egress) decided this; nothing overrides it. */
  floor: boolean
  /** Honest note when the "team" is one AI. '' when there are two or more. */
  soloNote: string
  /** Seats that could not be used, with their reasons — never dropped quietly. */
  sitOut: SitOut[]
}

/** Keywords that mean "this needs the strongest reasoner we have". */
const HEAVY = [
  'architect',
  'design',
  'debug',
  'refactor',
  'plan',
  'strategy',
  'why',
  'analyse',
  'analyze',
  'decide',
  'trade-off',
  'tradeoff',
]

/** Keywords that mean "bulk / mechanical" — cheap, local is the right answer. */
const BULK = ['summarize', 'summarise', 'list', 'rename', 'format', 'extract', 'tidy', 'sort']

function matched(intent: string, words: readonly string[]): string {
  const low = intent.toLowerCase()
  return words.find((w) => low.includes(w)) ?? ''
}

/**
 * Sukh's decision: do it himself, hand it to the better-suited AI, or assemble
 * a team — with the reason that actually decided it.
 *
 * Order is the honesty order, and the first rule that fires wins:
 *   1. nobody can answer      -> refused, naming every excluded seat's reason
 *   2. the FLOOR (sensitive words / vault-derived) -> local, engine's own reason
 *   3. an explicit team ask with 2+ usable AI      -> team, who does what
 *   4. exactly one usable AI  -> that one, and it SAYS it is not a team
 *   5. otherwise              -> the best-suited AI for the shape of the job
 */
export function decideRouting(input: RoutingInput): RoutingChoice {
  const sitOut = [...(input.sitOut ?? [])]
  const team = [...input.team]
  const solo = team.length === 1
  const soloNote = solo
    ? `only one AI can answer right now (${team[0].label}) — this is one worker, not a team`
    : ''

  // 1. Nobody. Never a fabricated run; roster.ts already writes this sentence.
  if (team.length === 0) {
    return {
      mode: 'refused',
      assigned: [],
      reason: emptyRosterRefusal(sitOut),
      engineReason: '',
      floor: false,
      soloNote: '',
      sitOut,
    }
  }

  // 2. THE FLOOR. Sensitivity and vault-derived content are not negotiable and
  //    not overridable by anything below — so they are tested before anything
  //    below runs, and the reason shown is the ENGINE'S.
  const hit = sensitiveHit(input.intent, input.sensitiveWords ?? [])
  if (hit || input.vaultDerived) {
    const engineReason = hit ? sensitiveFloorReason(hit) : VAULT_FLOOR_REASON
    const localSeat = team.find((t) => t.local)
    if (!localSeat) {
      // No local model to route to = no honest way to do this job. The engine
      // withholds rather than falling back to cloud; so does the plan.
      return {
        mode: 'refused',
        assigned: [],
        reason: `${routeReasonLabel(false, [engineReason])} — but no local model is connected, so there is nowhere to run it without egress. Connect a local model in Settings.`,
        engineReason,
        floor: true,
        soloNote,
        sitOut,
      }
    }
    return {
      mode: localSeat.token === input.managerToken ? 'self' : 'delegate',
      assigned: [localSeat],
      // routeReasonLabel is the EXISTING mapper the verdict card uses — the
      // words the user reads here are the words they read afterwards.
      reason: `${localSeat.label} takes it — ${routeReasonLabel(false, [engineReason])}`,
      engineReason,
      floor: true,
      soloNote,
      sitOut,
    }
  }

  // 4 (checked before 3): one AI is not a team, and saying otherwise is the
  // performance the spec forbids — even when the user asked for a team.
  if (solo) {
    const only = team[0]
    return {
      mode: only.token === input.managerToken ? 'self' : 'delegate',
      assigned: [only],
      reason: input.wantsTeam
        ? `${only.label} does all of it — ${soloNote}`
        : `${only.label} does it — it is the only AI connected right now`,
      engineReason: '',
      floor: false,
      soloNote,
      sitOut,
    }
  }

  // 3. A real team: 2+ usable AI and a job that wants more than one pair of
  //    hands. Strongest reasoner leads; the rest follow in seat order.
  if (input.wantsTeam) {
    const lead = team.find((t) => t.strongestReasoner) ?? team[0]
    const rest = team.filter((t) => t !== lead)
    return {
      mode: 'team',
      assigned: [lead, ...rest],
      reason: `${lead.label} leads (the strongest reasoner here, ~${lead.typicalSeconds}s a turn) and ${rest
        .map((t) => t.label)
        .join(', ')} ${rest.length === 1 ? 'works' : 'work'} alongside — you asked for more than one pair of hands`,
      engineReason: '',
      floor: false,
      soloNote: '',
      sitOut,
    }
  }

  // 5. Best suited for the shape of the job — and the reason names the shape.
  const heavy = matched(input.intent, HEAVY)
  const bulk = matched(input.intent, BULK)
  if (heavy) {
    const pick = team.find((t) => t.strongestReasoner) ?? team[0]
    return {
      mode: pick.token === input.managerToken ? 'self' : 'delegate',
      assigned: [pick],
      reason: `${pick.label} takes it — "${heavy}" is reasoning work and ${pick.label} is the strongest reasoner here (~${pick.typicalSeconds}s a turn)`,
      engineReason: '',
      floor: false,
      soloNote,
      sitOut,
    }
  }
  const localSeat = team.find((t) => t.local)
  if (bulk && localSeat) {
    return {
      mode: localSeat.token === input.managerToken ? 'self' : 'delegate',
      assigned: [localSeat],
      reason: `${localSeat.label} takes it — "${bulk}" is bulk work, and running it locally costs nothing and leaves your machine untouched by egress (~${localSeat.typicalSeconds}s a turn)`,
      engineReason: '',
      floor: false,
      soloNote,
      sitOut,
    }
  }
  const pick = team.find((t) => t.strongestReasoner) ?? team[0]
  return {
    mode: pick.token === input.managerToken ? 'self' : 'delegate',
    assigned: [pick],
    reason: `${pick.label} takes it — nothing about this job forces a lane, so it goes to the strongest reasoner connected (~${pick.typicalSeconds}s a turn)`,
    engineReason: '',
    floor: false,
    soloNote,
    sitOut,
  }
}

/** One line for the Work page / the chat: the choice and its reason, together.
 *  Never returns just the choice — a pick with no reason is the silent pick. */
export function routingLine(choice: RoutingChoice): string {
  const who =
    choice.mode === 'refused'
      ? 'nobody'
      : choice.mode === 'self'
        ? 'the manager itself'
        : choice.assigned.map((t) => t.label).join(' + ')
  // Refused mode is a pre-send STRIP, not the refusal record: one actionable
  // line (the full reason still lands in-thread if a launch is truly
  // attempted — sendTeam's notice path). A paragraph above a still-full
  // composer reads as breakage, not guidance (UI pass, 2026-08-29).
  if (choice.mode === 'refused') return 'nobody can take this yet — connect a provider in Settings'
  return `${who} · ${choice.reason}`
}

// ---------------------------------------------------------------------------
// Delegation — what to SHOW, derived from real spans only
// ---------------------------------------------------------------------------

/**
 * One delegated step, as the user's stated ask requires it: which agent, which
 * AI, what it was asked to do, and how it came out.
 *
 * Every field is entailed by a span attribute the engine actually wrote. There
 * is no field here that we synthesize when the span is silent — an unknown
 * outcome reads "still working", never a guessed pass.
 */
export interface DelegationStep {
  /** The agent's name, from the span's `agent` attr. */
  agent: string
  /** `provider · model` — the AI that really answered. */
  ai: string
  /** What it was asked to do, from the span's `round` attr. */
  asked: string
  /** How it came out. '' while it is still going. */
  outcome: string
  state: 'working' | 'done' | 'unreachable' | 'refused'
  /** Span start (seconds, engine clock) — the order they really happened in. */
  at: number
  /**
   * The engine's own `round` attr, VERBATIM ('' when the span carried none;
   * 'refused' for an engine-refused tool call). Added for the v2 Work pipeline,
   * which groups steps into column stacks: the columns have to be the rounds
   * the engine really reported, so this carries the raw attr rather than a
   * label anyone invented. Nothing is synthesised — a span with no `round`
   * yields '', and the pipeline draws that as one honest "Working" column.
   */
  stage: string
}

function attrString(attrs: Record<string, unknown> | undefined, key: string): string {
  const v = attrs?.[key]
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

/** What a board round was asked for, in plain words. Only the `round` attr is
 *  read — the engine writes either a round number or the literal 'synthesis'. */
function askedFor(round: string): string {
  if (!round) return 'take a turn on this job'
  if (round === 'synthesis') return "pull the team's work into one answer"
  return `contribute to the board (round ${round})`
}

/**
 * The delegated steps of a run, from its REAL spans.
 *
 * Two span kinds are read and no others:
 *  • `model_call` carrying an `agent` attr — a delegated turn. The AI is the
 *    span's own provider/model, so a turn the vault floor forced local reads
 *    local. `is_real === false` means the gateway never reached that provider,
 *    which is reported as UNREACHABLE, never as a completed turn (H2, 16182f2).
 *  • `tool_exec` carrying `refused: true` — a capability the ENGINE refused.
 *    Shown because a refusal is the enforcement working, and hiding it would
 *    make an enforced capability look like a decorative one.
 *
 * A `model_call` span with no `agent` attr is a solo run, not a delegation, and
 * is deliberately not turned into a fake "delegated" row.
 */
export function delegationSteps(spans: readonly EngineSpan[]): DelegationStep[] {
  const out: DelegationStep[] = []
  for (const span of spans) {
    const attrs = span.attrs ?? {}
    const agent = attrString(attrs, 'agent')
    if (!agent) continue
    const at = typeof span.start === 'number' ? span.start : 0
    if (span.type === 'tool_exec' && attrs.refused === true) {
      out.push({
        agent,
        ai: attrString(attrs, 'provider') || 'the engine',
        asked: `use ${attrString(attrs, 'tool') || 'a tool'}`,
        outcome: attrString(attrs, 'reason') || 'refused by the engine',
        state: 'refused',
        at,
        stage: 'refused',
      })
      continue
    }
    if (span.type !== 'model_call') continue
    const provider = attrString(attrs, 'provider')
    const model = attrString(attrs, 'model')
    const ai = [provider, model].filter(Boolean).join(' · ') || 'an AI'
    const round = attrString(attrs, 'round')
    const asked = askedFor(round)
    // Still open: the engine writes tokens/is_real when the turn CLOSES, so an
    // in-flight span has neither. "still working" is the honest reading.
    const closed = 'is_real' in attrs
    if (!closed) {
      out.push({ agent, ai, asked, outcome: '', state: 'working', at, stage: round })
      continue
    }
    if (attrs.is_real === false) {
      out.push({
        agent,
        ai,
        asked,
        outcome: `could not reach ${provider || 'that provider'} — nothing was sent`,
        state: 'unreachable',
        at,
        stage: round,
      })
      continue
    }
    const tokensOut = Number(attrs.tokens_out ?? 0)
    out.push({
      agent,
      ai,
      asked,
      outcome: tokensOut > 0 ? `answered (${tokensOut.toLocaleString()} tokens back)` : 'answered',
      state: 'done',
      at,
      stage: round,
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * The spans belonging to ONE recorded run, found by its task id.
 *
 * The engine writes a `run:<task_id>` span carrying `task_id`, and every span
 * of that run descends from it by `parent_id`. Walking that parentage is the
 * only honest way to say "these steps were THIS run's": the span tail holds
 * many runs, and attributing by position or recency is exactly how a step gets
 * pinned on the wrong verdict.
 *
 * Returns [] when the run span is not in the tail — the trace has aged out, and
 * the caller must show nothing rather than the newest run's steps under an old
 * verdict.
 */
export function spansForTask(spans: readonly EngineSpan[], taskId: string): EngineSpan[] {
  const id = (taskId ?? '').trim()
  if (!id) return []
  const root = spans.find(
    (s) => s.type === 'run' && attrString(s.attrs, 'task_id') === id && !!s.span_id,
  )
  if (!root?.span_id) return []
  const family = new Set<string>([root.span_id])
  // One forward pass is enough: telemetry appends a span when it CLOSES, but a
  // parent always exists before its children are written, and we only need
  // membership, so re-scanning until the set stops growing is exact and cheap.
  let grew = true
  while (grew) {
    grew = false
    for (const s of spans) {
      if (!s.span_id || family.has(s.span_id)) continue
      if (s.parent_id && family.has(s.parent_id)) {
        family.add(s.span_id)
        grew = true
      }
    }
  }
  return spans.filter((s) => !!s.span_id && family.has(s.span_id) && s.span_id !== root.span_id)
}

/** One readable line per delegated step: agent + AI + ask + outcome. */
export function delegationLine(step: DelegationStep): string {
  const head = `${step.agent} · ${step.ai} — asked to ${step.asked}`
  return step.outcome ? `${head} → ${step.outcome}` : `${head} → still working`
}

/** The honest headline for a delegation trail. '' when nothing was delegated —
 *  never "0 agents working", which reads like activity. */
export function delegationSummary(steps: readonly DelegationStep[]): string {
  if (steps.length === 0) return ''
  const agents = new Set(steps.map((s) => s.agent))
  const ais = new Set(steps.map((s) => s.ai))
  const refused = steps.filter((s) => s.state === 'refused').length
  const head = `${agents.size} agent${agents.size === 1 ? '' : 's'} on ${ais.size} AI${ais.size === 1 ? '' : 's'}`
  return refused > 0
    ? `${head} · ${refused} tool call${refused === 1 ? '' : 's'} refused by the engine`
    : head
}
