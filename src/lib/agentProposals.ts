// SC Prism — agent PROPOSALS (2026-08-11 spec: "the manager proposes new agents").
//
// THE RULE, stated once here because everything below depends on it: the
// companion PROPOSES, the human CREATES. A proposal is a parked suggestion — it
// is NOT an agent. It never enters the agent library (src/lib/agents.ts), never
// counts in any roster/stat, and only becomes real when the user taps Create on
// the desk. And a proposal must cite REAL evidence: either run ids the app can
// verify against its own verdict history, or the user's own request, quoted.
// A block that cites nothing, or cites an id we cannot verify, is REFUSED with
// an honest note — never coerced into a proposal with invented motivation.
//
// Storage mirrors the vault-artifact idiom used elsewhere (skills.ts): a
// synchronous localStorage-backed store for the UI, plus a durable, auditable
// JSON copy written vault-side at `proposals/agent-proposals.json` via
// `resolveVaultDir` + `writeVaultNote`. `resolveVaultDir` ALWAYS runs first —
// a `~` path must never reach the Rust side unresolved.

import { useSyncExternalStore } from 'react'
import {
  agentNameKey,
  agentNamed,
  create as createAgent,
  list as listAgents,
  uniqueAgentName,
  type AgentModel,
  type StoredAgent,
} from './agents'
import { isNative, readVaultFile, resolveVaultDir, writeVaultNote } from './nativeEngine'

const KEY = 'scprism.agentProposals'

/** Where the durable, auditable copy lives inside the vault. */
export const PROPOSALS_VAULT_PATH = 'proposals/agent-proposals.json'

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * The REAL evidence a proposal cites. Two honest kinds and no others:
 *   'runs'  — run ids the app verified against its own verdict history
 *             (`refs`), plus the pattern the proposer saw (`quote`, optional).
 *   'asked' — the user asked for it on Work; `quote` is their own message,
 *             verbatim. `refs` is empty (there is nothing to cite but them).
 * There is deliberately no "the model said so" kind.
 */
export interface ProposalEvidence {
  kind: 'runs' | 'asked'
  refs: string[]
  quote: string
}

/** A parked proposal. `status` is the whole lifecycle: it starts 'open', and
 *  exactly one human action moves it to 'created' or 'dismissed'. */
export interface AgentProposal {
  id: string
  /** The role name the agent would carry. */
  name: string
  /** One line: what it would do (becomes the agent's `role`). */
  purpose: string
  model: AgentModel
  /** One line: why that model. */
  modelWhy: string
  /** The skills/roles it would carry. */
  skills: string[]
  evidence: ProposalEvidence
  /** Which of the two allowed sources produced it. */
  source: 'heartbeat' | 'asked'
  at: number
  status: 'open' | 'created' | 'dismissed'
  /** When the human decided (created/dismissed). */
  decidedAt?: number
  /** The library id Create produced — the audit link from proposal to agent. */
  createdAgentId?: string
}

/** What a parser / caller supplies to `propose`. */
export interface NewProposalInput {
  name: string
  purpose: string
  model: AgentModel
  modelWhy: string
  skills: string[]
  evidence: ProposalEvidence
  source: 'heartbeat' | 'asked'
}

/** The values the human actually reviewed — what Create writes, verbatim.
 *  "Edit first" hands back an edited copy of these; nothing else is used. */
export interface ReviewedValues {
  name: string
  purpose: string
  model: AgentModel
  skills: string[]
}

// ---------------------------------------------------------------------------
// The block format — ONE definition, shared by the prompt and the parser
// ---------------------------------------------------------------------------

/** The literal fence tag a proposal block must open with. */
export const PROPOSE_FENCE = 'PROPOSE_AGENT'

const REQUIRED_FIELDS = ['name', 'purpose', 'model', 'model_why'] as const
const KNOWN_FIELDS = new Set<string>([...REQUIRED_FIELDS, 'skills', 'evidence', 'evidence_note'])

const CORE_TEMPLATE_LINES = [
  'name: <short-role-name>',
  'purpose: <one line — what this agent would do>',
  'model: claude|gemini|local',
  'model_why: <one line — why that model>',
  'skills: <comma-separated, optional>',
]

function template(extra: string[]): string {
  return ['```' + PROPOSE_FENCE, ...CORE_TEMPLATE_LINES, ...extra, '```'].join('\n')
}

/** The exact skeleton a heartbeat wake is shown (and the parser enforces). */
export const PROPOSAL_BLOCK_TEMPLATE = template([
  'evidence: <comma-separated run ids from the list below>',
  'evidence_note: <one line — the pattern you actually saw, optional>',
])

/** The same block for a Work ask, where the user's request IS the evidence and
 *  the app attaches it verbatim — so the block carries no evidence fields. */
export const PROPOSAL_BLOCK_TEMPLATE_ASKED = template([])

/**
 * The charter paragraph appended to a heartbeat wake's prompt, so the model
 * knows the format exists AND that evidence is mandatory. Pure: the verifiable
 * run ids are passed in, never read from a store here.
 *
 * With an EMPTY pool the paragraph says plainly that no proposal is possible
 * this beat — the model is never invited to cite ids that do not exist.
 */
export function proposalCharter(
  knownRunIds: readonly string[],
  /** The agents that ALREADY exist (enabled library names). The charter asks
   *  the model to certify no existing agent covers the gap, so it has to be
   *  told what exists — otherwise that certification is guesswork. A name in
   *  this list is refused by the store anyway (see `blockedReason`). */
  existingAgents: readonly string[] = [],
): string {
  const head =
    'You may also PROPOSE ONE new agent. You never create it — the user does, ' +
    'from their desk. Propose only when the real state above shows a recurring ' +
    'gap that no existing agent covers.'
  const roster = existingAgents.length
    ? `Agents that already exist: ${existingAgents.join(', ')}. Do NOT propose any of these — a duplicate name is refused.`
    : 'There are no agents in the library yet.'
  if (knownRunIds.length === 0) {
    return `${head} ${roster} There are NO verifiable run ids available this beat, so do NOT propose an agent now.`
  }
  return [
    head,
    roster,
    'If you do propose, END your reply with exactly this block (field names verbatim, one per line) — nothing at all may follow it:',
    PROPOSAL_BLOCK_TEMPLATE,
    `The ONLY run ids that count as evidence are: ${knownRunIds.join(', ')}.`,
    'Cite at least one of them. An id outside that list, or a block with no evidence, is DISCARDED — no proposal is made.',
  ].join('\n\n')
}

/** The brief a Work "propose an agent" ask sends: the user's own words plus the
 *  same strict format. Their request IS the evidence, so the block carries no
 *  `evidence:` field here — the app attaches the message itself. */
export function proposeAgentBrief(request: string): string {
  return [
    '[PROPOSE AN AGENT] The user is asking for a new agent on the Work page. Their request:',
    request.trim(),
    'Do NOT create anything — you propose, the user creates. Reply with one short paragraph ' +
      'on what this agent should be, then END with exactly this block (field names verbatim):',
    PROPOSAL_BLOCK_TEMPLATE_ASKED,
    'Do not add an `evidence:` field — their request above is the evidence, and the app attaches it verbatim.',
  ].join('\n\n')
}

// ---------------------------------------------------------------------------
// The parser — STRICT. A malformed or evidence-free block yields a refusal
// with an honest reason; it is never repaired into a proposal.
// ---------------------------------------------------------------------------

export type ProposalParse =
  /** No block at all — an ordinary reply. Nothing to note, nothing to record. */
  | { status: 'none' }
  /** A block was present but unusable. `reason` is the honest note to surface. */
  | { status: 'refused'; reason: string }
  | { status: 'ok'; input: NewProposalInput }

export type ProposalContext =
  | { source: 'heartbeat'; knownRunIds: readonly string[] }
  | { source: 'asked'; request: string }

const OPEN_RE = new RegExp(`^[ \\t]*\`\`\`[ \\t]*${PROPOSE_FENCE}[ \\t]*$`, 'gm')
const CLOSE_RE = /^[ \t]*```[ \t]*$/
/** Any fence line at all — used to enforce that the block is TERMINAL. */
const ANY_FENCE_RE = /^[ \t]*```/

/** Hard caps on the free-text values a block may carry. A 20,000-char "skill"
 *  is not a skill; a wall of ids is not evidence. */
const MAX_SKILL_CHARS = 40
const MAX_SKILLS = 12
const MAX_REFS = 8

function isModel(x: string): x is AgentModel {
  return x === 'claude' || x === 'gemini' || x === 'local'
}

/** Split a comma/newline separated field into clean, non-empty tokens. */
function tokens(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Parse a reply for ONE `PROPOSE_AGENT` block.
 *
 * Strictness (all of these REFUSE — no proposal is recorded):
 *   • the fence is opened but never closed
 *   • more than one block in the reply (which one did it mean?)
 *   • a body line that is not `key: value`
 *   • a duplicate or unknown field name
 *   • a missing/empty required field (name, purpose, model, model_why)
 *   • a model outside claude|gemini|local
 *   • heartbeat source: no evidence, or ANY cited id that is not in the
 *     caller's verified pool — an unverifiable id is exactly the invented
 *     evidence this whole feature exists to refuse
 *   • asked source: an empty request (there is then nothing real to cite)
 *   • the block is NOT the last thing in the reply. The charter says "END your
 *     reply with exactly this block", and that is enforced, not just asked for:
 *     anything after the closing fence refuses the block. This is what stops a
 *     block QUOTED as an example ("what would a proposal look like?" → the
 *     model illustrates one inside a code sample, whose outer fence then
 *     follows) and a block the model retracts on the next line ("Actually,
 *     ignore that.") from landing on the desk as a real proposal.
 *
 * Values are also CAPPED (a field is truncated, never used to smuggle a wall of
 * text): each skill 40 chars / 12 skills, and evidence refs deduped, normalized
 * to the pool's own casing, and capped at 8.
 */
export function parseProposalBlock(text: string, ctx: ProposalContext): ProposalParse {
  const opens: number[] = []
  OPEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = OPEN_RE.exec(text)) !== null) opens.push(m.index + m[0].length)
  if (opens.length === 0) return { status: 'none' }
  if (opens.length > 1) {
    return { status: 'refused', reason: `more than one ${PROPOSE_FENCE} block — none used` }
  }

  const rest = text.slice(opens[0]).replace(/^\n/, '')
  const lines = rest.split('\n')
  const closeAt = lines.findIndex((l) => CLOSE_RE.test(l))
  if (closeAt === -1) {
    return { status: 'refused', reason: `the ${PROPOSE_FENCE} block was never closed` }
  }
  // TERMINAL or nothing: the charter says the block ENDS the reply. Prose or a
  // second fence after it means the block is an example, a retraction, or a
  // quote — never a decision the user should be shown as a real proposal.
  const after = lines.slice(closeAt + 1)
  const trailing = after.find((l) => l.trim() !== '')
  if (trailing !== undefined) {
    const what = ANY_FENCE_RE.test(trailing) ? 'another code fence' : `"${trailing.trim().slice(0, 40)}"`
    return {
      status: 'refused',
      reason: `the ${PROPOSE_FENCE} block was not the last thing in the reply (${what} follows it)`,
    }
  }

  const fields = new Map<string, string>()
  for (const raw of lines.slice(0, closeAt)) {
    const line = raw.trim()
    if (!line) continue
    const kv = /^([A-Za-z_]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!kv) {
      return { status: 'refused', reason: `unreadable line in the block: "${line.slice(0, 60)}"` }
    }
    const key = kv[1].toLowerCase()
    if (!KNOWN_FIELDS.has(key)) return { status: 'refused', reason: `unknown field "${key}"` }
    if (fields.has(key)) return { status: 'refused', reason: `duplicate field "${key}"` }
    fields.set(key, kv[2].trim())
  }

  for (const f of REQUIRED_FIELDS) {
    if (!(fields.get(f) ?? '').trim()) return { status: 'refused', reason: `missing "${f}"` }
  }
  const model = (fields.get('model') ?? '').toLowerCase()
  if (!isModel(model)) {
    return { status: 'refused', reason: `"${model}" is not one of claude, gemini or local` }
  }

  let evidence: ProposalEvidence
  if (ctx.source === 'asked') {
    // The user's own message is the evidence, attached by the app verbatim. Any
    // `evidence:` the model wrote is IGNORED here rather than trusted: in a chat
    // there is no verified pool to check it against, and an unverifiable id must
    // never end up on the desk dressed as a citation.
    const request = ctx.request.trim()
    if (!request) return { status: 'refused', reason: 'no request text to cite as evidence' }
    evidence = { kind: 'asked', refs: [], quote: request.slice(0, 400) }
  } else {
    const cited = tokens(fields.get('evidence') ?? '')
    if (cited.length === 0) return { status: 'refused', reason: 'no evidence cited' }
    // The pool keyed by its own casing: a model that echoes `RUN-ALPHA` cites a
    // real run, but the id it wrote matches nothing when the desk looks it up
    // later. Store the POOL's spelling, so a printed ref always resolves.
    const known = new Map<string, string>()
    for (const r of ctx.knownRunIds) {
      const id = r.trim()
      if (id) known.set(id.toLowerCase(), id)
    }
    const unverifiable = cited.filter((r) => !known.has(r.toLowerCase()))
    if (unverifiable.length > 0) {
      return {
        status: 'refused',
        reason: `cited evidence I can't verify: ${unverifiable.slice(0, 3).join(', ')}`,
      }
    }
    const refs: string[] = []
    for (const r of cited) {
      const id = known.get(r.toLowerCase()) as string
      if (!refs.includes(id)) refs.push(id)
      if (refs.length >= MAX_REFS) break
    }
    evidence = { kind: 'runs', refs, quote: (fields.get('evidence_note') ?? '').slice(0, 400) }
  }

  return {
    status: 'ok',
    input: {
      name: (fields.get('name') ?? '').slice(0, 60),
      purpose: (fields.get('purpose') ?? '').slice(0, 200),
      model,
      modelWhy: (fields.get('model_why') ?? '').slice(0, 200),
      skills: tokens(fields.get('skills') ?? '')
        .map((s) => s.slice(0, MAX_SKILL_CHARS))
        .slice(0, MAX_SKILLS),
      evidence,
      source: ctx.source,
    },
  }
}

/**
 * The reply with its `PROPOSE_AGENT` block cut out — the PROSE the model wrote,
 * and the only thing a wake's rest/work classification may judge. Without this,
 * appending a proposal block (accepted OR refused) turns an honest
 * `NOTHING_NEEDED — everything is quiet` into a "worked" beat: a work entry in
 * the heartbeat report, a success line to the phone, and a fabricated piece of
 * activity in the beat log. Cuts from the opening fence to its closing fence
 * (to the end of the text when the fence was never closed) — the first block
 * only, which is all the parser would ever accept anyway.
 */
export function stripProposalBlock(text: string): string {
  OPEN_RE.lastIndex = 0
  const m = OPEN_RE.exec(text)
  if (!m) return text
  const head = text.slice(0, m.index)
  const rest = text.slice(m.index + m[0].length).replace(/^\n/, '')
  const lines = rest.split('\n')
  const closeAt = lines.findIndex((l) => CLOSE_RE.test(l))
  const tail = closeAt === -1 ? '' : lines.slice(closeAt + 1).join('\n')
  return `${head}${tail}`
}

/**
 * The verifiable evidence pool for a heartbeat wake: the REAL task ids of runs
 * this app actually recorded, newest first, deduped. Nothing synthetic — if
 * there are no runs, there is no pool, and `proposalCharter` then tells the
 * model not to propose at all.
 *
 * SIMULATED runs are excluded, exactly as `attributesTo` (lib/agents.ts)
 * excludes them from an agent's activity: a verdict the real engine never made
 * carries no `native.models_used`, and a demo-mode seed must never become
 * citable "evidence" for a real agent. Same rule, one sentence: only runs the
 * engine really performed can be cited.
 */
export function proposalEvidencePool(
  verdicts: readonly { taskId?: string; native?: { models_used?: readonly string[] } }[],
  max = 12,
): string[] {
  const out: string[] = []
  for (const v of verdicts) {
    const id = (v.taskId ?? '').trim()
    if (!id || out.includes(id)) continue
    if (!v.native?.models_used?.length) continue
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

// ---------------------------------------------------------------------------
// State + persistence (localStorage; the vault copy is written alongside)
// ---------------------------------------------------------------------------

function isEvidence(x: unknown): x is ProposalEvidence {
  if (typeof x !== 'object' || x === null) return false
  const e = x as Record<string, unknown>
  return (
    (e.kind === 'runs' || e.kind === 'asked') &&
    Array.isArray(e.refs) &&
    e.refs.every((r) => typeof r === 'string') &&
    typeof e.quote === 'string'
  )
}

export function isProposal(x: unknown): x is AgentProposal {
  if (typeof x !== 'object' || x === null) return false
  const p = x as Record<string, unknown>
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.purpose === 'string' &&
    (p.model === 'claude' || p.model === 'gemini' || p.model === 'local') &&
    typeof p.modelWhy === 'string' &&
    Array.isArray(p.skills) &&
    p.skills.every((s) => typeof s === 'string') &&
    isEvidence(p.evidence) &&
    (p.source === 'heartbeat' || p.source === 'asked') &&
    typeof p.at === 'number' &&
    (p.status === 'open' || p.status === 'created' || p.status === 'dismissed')
  )
}

function persist(next: AgentProposal[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage unavailable — keep the in-memory copy
  }
}

function load(): AgentProposal[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every(isProposal)) return parsed
    }
  } catch {
    // corrupt / unavailable — start empty. NEVER seeded: a proposal with no
    // real evidence behind it is exactly what this feature refuses to invent.
  }
  return []
}

let state: AgentProposal[] = load()

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function commit(next: AgentProposal[]): void {
  state = next
  persist(next)
  for (const listener of listeners) listener()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Every proposal ever recorded, oldest first (including decided ones — the
 *  dismissed records are what stop a proposal from nagging again). */
export function list(): AgentProposal[] {
  return state
}

/** Only the proposals still awaiting the human — what the desk shows. PURE. */
export function openProposals(proposals: readonly AgentProposal[]): AgentProposal[] {
  return proposals.filter((p) => p.status === 'open')
}

function nameKey(name: string): string {
  return agentNameKey(name)
}

/**
 * The evidence a proposal rests on, as one comparable key: its kind plus the
 * ids it cites (or the user's own words for an 'asked' proposal). Used by the
 * dismissal rule below — the same gap cited again is nagging; a genuinely NEW
 * set of runs is a new argument the user has not seen.
 */
function evidenceKey(e: ProposalEvidence): string {
  if (e.kind === 'asked') return `asked:${e.quote.trim().toLowerCase()}`
  return `runs:${[...e.refs].map((r) => r.trim().toLowerCase()).sort().join(',')}`
}

/**
 * Why this proposal must NOT be recorded, or null when it may be. Exported so a
 * caller can say the honest reason out loud (the beat line, the chat notice)
 * instead of reporting a bare "nothing was recorded".
 *
 * Scoped deliberately — dismissal is sticky, not a life sentence:
 *   • an agent of that name ALREADY EXISTS → refuse (the charter asks the model
 *     to certify no existing agent covers the gap; this enforces it, and a
 *     second "Researcher" would only shadow the first).
 *   • it is OPEN on the desk right now → refuse (it is already waiting).
 *   • it was DISMISSED citing the SAME evidence → refuse (that is nagging). A
 *     dismissed name cited with a genuinely different evidence set is allowed
 *     through: new runs are a new argument, and there is otherwise no way back
 *     from a dismissal short of hand-editing the vault ledger.
 *   • a CREATED record whose agent has since been DELETED blocks nothing —
 *     the library check above is the real guard, so deleting an agent lets it
 *     be proposed again.
 */
export function blockedReason(input: NewProposalInput, agents = listAgents()): string | null {
  const key = nameKey(input.name)
  if (!key) return 'a proposal needs a name'
  if (agentNamed(agents, input.name)) return `an agent named "${input.name.trim()}" already exists`
  const sameName = state.filter((p) => nameKey(p.name) === key)
  if (sameName.some((p) => p.status === 'open')) {
    return `"${input.name.trim()}" is already waiting on your desk`
  }
  const evidence = evidenceKey(input.evidence)
  if (sameName.some((p) => p.status === 'dismissed' && evidenceKey(p.evidence) === evidence)) {
    return `you dismissed "${input.name.trim()}" before, and this cites the same evidence`
  }
  return null
}

let seq = 0

/**
 * Record a proposal. Returns the stored record, or `null` when `blockedReason`
 * (above) says it must not be recorded — the agent already exists, it is
 * already on the desk, or it is a dismissed proposal re-argued from the same
 * evidence. Callers must treat null as "nothing was recorded" and say so
 * honestly; `blockedReason` gives them the sentence.
 */
export function propose(input: NewProposalInput, now: number): AgentProposal | null {
  if (blockedReason(input) !== null) return null
  const proposal: AgentProposal = {
    id: `prop-${now.toString(36)}-${(seq++).toString(36)}`,
    name: input.name.trim(),
    purpose: input.purpose.trim(),
    model: input.model,
    modelWhy: input.modelWhy.trim(),
    skills: input.skills.map((s) => s.trim()).filter(Boolean),
    evidence: input.evidence,
    source: input.source,
    at: now,
    status: 'open',
  }
  commit([...state, proposal])
  return proposal
}

/** Dismiss a proposal — STICKY: the record survives so the same role is never
 *  proposed again (see `propose`'s duplicate rule). */
export function dismiss(id: string, now: number): void {
  let changed = false
  const next = state.map((p) => {
    if (p.id !== id || p.status !== 'open') return p
    changed = true
    return { ...p, status: 'dismissed' as const, decidedAt: now }
  })
  if (changed) commit(next)
}

/**
 * CREATE — the one place a proposal becomes a real agent. Writes exactly the
 * REVIEWED values (what "Edit first" produced, or the untouched originals) to
 * the agent library, and marks the proposal 'created' with the new agent's id.
 * The new agent is an ordinary business agent: `usage` 0, `evalScore` 0 — no
 * seeded history, and none inherited from anyone.
 *
 * Returns the created agent, or null when the proposal is missing / already
 * decided (a double-tap must never mint a second agent).
 *
 * NAME COLLISION: the library is checked here too, because "Edit first" can
 * type any name and an agent may have been added since the proposal was made.
 * A taken name is SUFFIXED ('Researcher' → 'Researcher 2') rather than silently
 * creating a second agent under an identical name — and the desk row shows the
 * name that will really be written before the tap (`plannedAgentName`).
 */
export function createFromProposal(
  id: string,
  values: ReviewedValues,
  now: number,
): StoredAgent | null {
  const target = state.find((p) => p.id === id)
  if (!target || target.status !== 'open') return null
  const name = uniqueAgentName(listAgents(), values.name)
  // RESEARCH-FIRST (2026-08-29): the proposal already carries the research —
  // the observed pattern (quote), the recorded run ids (refs), the model
  // reasoning (modelWhy). Compose them into the born-with charter so no
  // approved agent starts as a bare frontmatter file. Every line here is a
  // RECORDED fact from the proposal record, never invented at create time.
  const charterLines = [
    values.purpose.trim(),
    '',
    ...(target.evidence.quote.trim()
      ? [`Origin: proposed from live evidence — "${target.evidence.quote.trim()}".`]
      : []),
    ...(target.evidence.refs.length
      ? [`Evidence runs: ${target.evidence.refs.join(', ')}.`]
      : []),
    ...(target.modelWhy.trim()
      ? [`Model choice: ${values.model} — ${target.modelWhy.trim()}.`]
      : []),
  ]
  const agent = createAgent({
    name,
    role: values.purpose,
    model: values.model,
    skills: values.skills,
    charter: charterLines.join('\n'),
  })
  commit(
    state.map((p) =>
      p.id === id
        ? {
            ...p,
            status: 'created' as const,
            decidedAt: now,
            createdAgentId: agent.id,
            ...reviewed({ ...values, name }),
          }
        : p,
    ),
  )
  return agent
}

/** The name Create would REALLY write for these reviewed values — the same
 *  suffixing `createFromProposal` applies, exposed so the desk can warn about a
 *  collision BEFORE the tap instead of surprising the user after it. */
export function plannedAgentName(name: string, agents = listAgents()): string {
  return uniqueAgentName(agents, name)
}

/** The reviewed values folded back onto the record, so the audit copy shows
 *  what was ACTUALLY created rather than the original suggestion. */
function reviewed(v: ReviewedValues): Pick<AgentProposal, 'name' | 'purpose' | 'model' | 'skills'> {
  return {
    name: v.name.trim(),
    purpose: v.purpose.trim(),
    model: v.model,
    skills: v.skills.map((s) => s.trim()).filter(Boolean),
  }
}

// ---------------------------------------------------------------------------
// Vault side — the durable, auditable copy
// ---------------------------------------------------------------------------

/** The newer of two records for the same id: the one whose decision is more
 *  recent wins (a dismissal must never be overwritten back to 'open' by a stale
 *  copy). Undecided records carry no `decidedAt`, so a decided record always
 *  beats an undecided one; ties keep `mine`. */
function newerOf(mine: AgentProposal, theirs: AgentProposal): AgentProposal {
  return (theirs.decidedAt ?? 0) > (mine.decidedAt ?? 0) ? theirs : mine
}

/**
 * Write the proposal ledger to `<vault>/proposals/agent-proposals.json`.
 * `resolveVaultDir` runs FIRST so a `~` path is expanded before it reaches the
 * Rust bridge (a literal `~` must never cross that boundary). Native-only:
 * resolves false in the browser or on any failure — callers fire it after a
 * mutation and never need a try/catch.
 *
 * READ-MERGE-WRITE by id, never a blind overwrite: this store starts empty on a
 * fresh install / cleared webview storage, and hydration only happens on the
 * Work desk — so a mutation that lands before (or away from) hydration used to
 * truncate the file and destroy every past dismissal. Records already in the
 * file that this process has never seen are carried through untouched, and for
 * an id both sides know, the more recently DECIDED copy wins.
 */
export async function persistProposalsToVault(vaultPath?: string): Promise<boolean> {
  if (!isNative()) return false
  try {
    const vault = await resolveVaultDir(vaultPath)
    const merged = new Map<string, AgentProposal>()
    try {
      const raw = await readVaultFile(vault, PROPOSALS_VAULT_PATH)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (Array.isArray(parsed)) {
        for (const p of parsed) if (isProposal(p)) merged.set(p.id, p)
      }
    } catch {
      // unreadable/corrupt ledger — write what we hold rather than lose it too
    }
    for (const p of state) {
      const theirs = merged.get(p.id)
      merged.set(p.id, theirs ? newerOf(p, theirs) : p)
    }
    const written = await writeVaultNote(
      vault,
      PROPOSALS_VAULT_PATH,
      JSON.stringify([...merged.values()], null, 2),
    )
    return written !== null
  } catch {
    return false
  }
}

/**
 * Merge the vault ledger into the local store — the restart path. Vault-only
 * records (a fresh install pointed at an existing vault) are appended. For an
 * id BOTH sides know, the more recently DECIDED copy wins: two open windows
 * share this file, so a dismissal made in one must not be quietly reverted to
 * 'open' by the other's older copy. Returns how many records changed (adopted
 * or updated). Never throws.
 */
export async function hydrateProposalsFromVault(vaultPath?: string): Promise<number> {
  if (!isNative()) return 0
  try {
    const vault = await resolveVaultDir(vaultPath)
    const raw = await readVaultFile(vault, PROPOSALS_VAULT_PATH)
    if (!raw) return 0
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return 0
    const fromVault = parsed.filter(isProposal)
    const byId = new Map(fromVault.map((p) => [p.id, p]))
    const knownNames = new Set(state.map((p) => nameKey(p.name)))
    let changed = 0
    const updated = state.map((mine) => {
      const theirs = byId.get(mine.id)
      if (!theirs) return mine
      const winner = newerOf(mine, theirs)
      if (winner !== mine) changed++
      return winner
    })
    const known = new Set(state.map((p) => p.id))
    const adopted = fromVault.filter((p) => !known.has(p.id) && !knownNames.has(nameKey(p.name)))
    changed += adopted.length
    if (changed === 0) return 0
    commit([...updated, ...adopted])
    return changed
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

/** Subscribe a component to the proposals store; returns the current snapshot. */
export function useAgentProposals(): AgentProposal[] {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}
