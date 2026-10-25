// SC Prism — Sukh STAFFS a project (2026-08-15 spec, "he staffs a project").
//
// This extends the propose→create flow of `agentProposals.ts` (577506c) from
// ONE agent to a PROJECT ROSTER, and keeps every rule that made the single-agent
// version honest:
//
//   • THE MANAGER PROPOSES, THE HUMAN CREATES. A roster proposal is not a team.
//     It never enters the agent library, never counts in a roster or a stat, and
//     becomes real only when the user taps Create — ONCE, for the whole roster.
//   • EVIDENCE OR NOTHING. The single-agent flow made a proposal cite run ids it
//     could verify. A roster cites THE PROJECT'S OWN NEEDS, verified against the
//     project's real requirement lines. An invented need is the same sin as a
//     fabricated activity, so a `need:` outside the verified pool REFUSES the
//     whole block — it is never repaired into a plausible one.
//   • CAPABILITIES ARE REAL. Every row carries the capabilities that role would
//     get, and they are clamped to what the USER holds before the row is ever
//     shown (`delegation.grantSubset`). The engine clamps again at
//     `capabilities.AgentGrants.__init__` and refuses at the tool gate, so this
//     file can only ever mis-display, never over-grant.
//   • NEVER AN UNUSABLE PROVIDER. A row whose AI cannot answer on this install
//     is not created — it SITS OUT with the reason (roster.ts, f2766c6).
//   • EDITED VALUES WIN. Create writes exactly the rows the human reviewed. The
//     originals are never used once a row has been edited.
//
// Storage mirrors `agentProposals.ts` exactly: a synchronous localStorage store
// for the UI plus a durable, auditable JSON copy vault-side, written through
// `resolveVaultDir` FIRST so a `~` path never reaches the Rust side.

import { useSyncExternalStore } from 'react'
import {
  agentNameKey,
  create as createAgent,
  list as listAgents,
  uniqueAgentName,
  type AgentModel,
  type StoredAgent,
} from './agents'
import {
  CAPABILITIES,
  capabilityLabel,
  grantSubset,
  isCapability,
  normalizeCapabilities,
  type Capability,
} from './delegation'
import { isNative, readVaultFile, resolveVaultDir, writeVaultNote } from './nativeEngine'
import type { RosterGate, SitOut } from './roster'

const KEY = 'scprism.projectRosters'

/** Where the durable, auditable copy lives inside the vault. */
export const ROSTER_VAULT_PATH = 'proposals/project-rosters.json'

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** One proposed seat: who, on which AI, with which capabilities, and WHY. */
export interface RosterRole {
  /** The role name the agent would carry. */
  name: string
  /** One line: what this role would do (becomes the agent's `role`). */
  purpose: string
  /** Which AI it runs on. */
  model: AgentModel
  /** One line: why that AI. */
  modelWhy: string
  /** What it would be allowed to do — already clamped to the user's grants. */
  capabilities: Capability[]
  /** The project's own requirement line this role exists for, VERBATIM. */
  need: string
}

/** The evidence a roster rests on: the project's real, verified needs. */
export interface RosterEvidence {
  projectId: string
  projectName: string
  /** The project's requirement lines, verbatim — the ONLY citable pool. */
  needs: string[]
}

export interface RosterProposal {
  id: string
  roles: RosterRole[]
  evidence: RosterEvidence
  at: number
  status: 'open' | 'created' | 'dismissed'
  decidedAt?: number
  /** The library ids Create produced — the audit link from roster to agents. */
  createdAgentIds?: string[]
}

export interface NewRosterInput {
  roles: RosterRole[]
  evidence: RosterEvidence
}

/**
 * The project's REAL needs — its own recorded plan steps, verbatim.
 *
 * This is the citable pool, and it is deliberately the plan rather than the
 * goal sentence: a plan step is a requirement the app itself recorded from the
 * project interview, so a role that cites one is arguing from a fact the user
 * can check. An un-planned project has NO needs, and `rosterCharter` then tells
 * the manager not to propose at all — the roster equivalent of the empty
 * evidence pool in `proposalCharter` (577506c).
 */
export function projectNeeds(project: { plan?: readonly string[] }): string[] {
  const out: string[] = []
  for (const step of project.plan ?? []) {
    const line = String(step ?? '').replace(/\s+/g, ' ').trim()
    if (line && !out.includes(line)) out.push(line)
  }
  return out
}

// ---------------------------------------------------------------------------
// The block format — ONE definition, shared by the prompt and the parser
// ---------------------------------------------------------------------------

export const ROSTER_FENCE = 'PROPOSE_ROSTER'

/** The separator between two roles inside one block. */
const ROLE_SEP = /^[ \t]*---[ \t]*$/

const REQUIRED_FIELDS = ['role', 'purpose', 'model', 'model_why', 'need'] as const
const KNOWN_FIELDS = new Set<string>([...REQUIRED_FIELDS, 'capabilities'])

/** Caps. A roster is a team, not a phone book; a 20,000-char purpose is not a
 *  purpose. */
export const MAX_ROLES = 6
const MAX_NAME = 60
const MAX_LINE = 200

function roleTemplate(usableAI: readonly string[]): string[] {
  return [
    'role: <short role name>',
    'purpose: <one line — what this role does on THIS project>',
    // The model line lists ONLY the AI that can really answer on this Mac. An
    // unusable brand is not offered even as an example: a seat proposed on a
    // provider that would answer with a stub is exactly the bug f2766c6 killed.
    `model: ${usableAI.join('|')}`,
    'model_why: <one line — why that AI for this role>',
    'capabilities: <comma-separated, from the list above; omit for none>',
    'need: <one of the project needs listed above, copied verbatim>',
  ]
}

/** The block skeleton the manager is shown, for the AI that can really run. */
export function rosterBlockTemplate(usableAI: readonly string[]): string {
  const role = roleTemplate(usableAI)
  return ['```' + ROSTER_FENCE, ...role, '---', ...role, '```'].join('\n')
}

/**
 * The brief Sukh is given when a project needs staffing.
 *
 * Everything the model is allowed to choose from is passed IN — never read from
 * a store here, and never left to the model's imagination:
 *   • `needs` is the project's real requirement lines; the model may cite these
 *     and nothing else, and the parser enforces it.
 *   • `usableAI` is the providers that can actually answer on this Mac (the
 *     roster gate, f2766c6) — an unusable AI is not offered as an option, so a
 *     seat is never proposed on a provider that would answer with a stub.
 *   • `userGrants` is the capabilities the USER holds. The manager cannot grant
 *     beyond them, so it is not invited to ask.
 *
 * With no needs, no staffing is possible and the brief says so plainly rather
 * than inviting an invented roster.
 */
export function rosterCharter(opts: {
  projectName: string
  needs: readonly string[]
  usableAI: readonly string[]
  userGrants: readonly Capability[]
  existingAgents?: readonly string[]
}): string {
  const head =
    `You are staffing the project "${opts.projectName}". Propose the roles this ` +
    'project actually needs — no more. You never create them: the user does, ' +
    'from their desk, with one approval.'
  if (opts.needs.length === 0) {
    return `${head} This project has NO recorded requirements yet, so there is nothing to staff against — do NOT propose a roster.`
  }
  if (opts.usableAI.length === 0) {
    return `${head} No AI provider is connected on this Mac right now, so no role could actually run — do NOT propose a roster.`
  }
  const grants = opts.userGrants.length
    ? `Capabilities you may give a role: ${opts.userGrants.join(', ')} (${opts.userGrants
        .map(capabilityLabel)
        .join('; ')}). Ask for NOTHING outside this list — the user has not granted it, so it cannot be given.`
    : 'The user has granted NO capabilities, so every role must be proposed with `capabilities:` empty.'
  const existing = opts.existingAgents?.length
    ? `Agents that already exist: ${opts.existingAgents.join(', ')}. Do not propose any of these again.`
    : 'This project has no agents yet.'
  return [
    head,
    `The project's real needs, and the ONLY things you may cite:\n${opts.needs
      .map((n) => `- ${n}`)
      .join('\n')}`,
    `AI you may put a role on: ${opts.usableAI.join(', ')}. Anything else is not connected and cannot run.`,
    grants,
    existing,
    `Reply with one short paragraph, then END your reply with exactly this block (field names verbatim, roles separated by a line of exactly ---, at most ${MAX_ROLES} roles) — nothing at all may follow it:`,
    rosterBlockTemplate(opts.usableAI),
    'Every `need:` must be copied verbatim from the list above. A need I cannot verify DISCARDS the whole roster — no team is proposed.',
  ].join('\n\n')
}

// ---------------------------------------------------------------------------
// The parser — STRICT. A malformed block yields a refusal with an honest reason.
// ---------------------------------------------------------------------------

export type RosterParse =
  | { status: 'none' }
  | { status: 'refused'; reason: string }
  | { status: 'ok'; input: NewRosterInput }

const OPEN_RE = new RegExp(`^[ \\t]*\`\`\`[ \\t]*${ROSTER_FENCE}[ \\t]*$`, 'gm')
const CLOSE_RE = /^[ \t]*```[ \t]*$/
const ANY_FENCE_RE = /^[ \t]*```/

function isModel(x: string): x is AgentModel {
  return x === 'claude' || x === 'gemini' || x === 'local'
}

/** A comparison key for a need: whitespace- and case-insensitive, so a model
 *  that re-wraps a requirement line still cites a REAL one. */
function needKey(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Parse a reply for ONE `PROPOSE_ROSTER` block.
 *
 * Every one of these REFUSES the whole roster (a partial team is a team the
 * user did not review):
 *   • the fence is opened and never closed, or there is more than one block
 *   • the block is not the LAST thing in the reply (a quoted example, or a
 *     roster the model retracts on the next line, must never reach the desk)
 *   • a body line that is not `key: value`, an unknown/duplicate field, or a
 *     missing required field
 *   • a model outside claude|gemini|local
 *   • a `capabilities:` entry that is not one of the four real capabilities —
 *     REFUSED rather than dropped, because laundering an invented capability
 *     into a shorter list is how a shown-but-unenforced grant would be born
 *   • a `need:` that is not in the project's verified pool — the invented-need
 *     rule, the roster equivalent of a fabricated run id
 *   • zero roles, or more than MAX_ROLES
 */
export function parseRosterBlock(text: string, evidence: RosterEvidence): RosterParse {
  const opens: number[] = []
  OPEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = OPEN_RE.exec(text)) !== null) opens.push(m.index + m[0].length)
  if (opens.length === 0) return { status: 'none' }
  if (opens.length > 1) {
    return { status: 'refused', reason: `more than one ${ROSTER_FENCE} block — none used` }
  }

  const rest = text.slice(opens[0]).replace(/^\n/, '')
  const lines = rest.split('\n')
  const closeAt = lines.findIndex((l) => CLOSE_RE.test(l))
  if (closeAt === -1) {
    return { status: 'refused', reason: `the ${ROSTER_FENCE} block was never closed` }
  }
  const trailing = lines.slice(closeAt + 1).find((l) => l.trim() !== '')
  if (trailing !== undefined) {
    const what = ANY_FENCE_RE.test(trailing)
      ? 'another code fence'
      : `"${trailing.trim().slice(0, 40)}"`
    return {
      status: 'refused',
      reason: `the ${ROSTER_FENCE} block was not the last thing in the reply (${what} follows it)`,
    }
  }

  // Split the body into role chunks on the `---` separator.
  const body = lines.slice(0, closeAt)
  const chunks: string[][] = [[]]
  for (const line of body) {
    if (ROLE_SEP.test(line)) chunks.push([])
    else chunks[chunks.length - 1].push(line)
  }
  const filled = chunks.filter((c) => c.some((l) => l.trim() !== ''))
  if (filled.length === 0) return { status: 'refused', reason: 'the roster block is empty' }
  if (filled.length > MAX_ROLES) {
    return {
      status: 'refused',
      reason: `${filled.length} roles proposed — at most ${MAX_ROLES} may be staffed at once`,
    }
  }

  const known = new Map<string, string>()
  for (const n of evidence.needs) {
    const key = needKey(n)
    if (key) known.set(key, n.trim())
  }
  if (known.size === 0) {
    return { status: 'refused', reason: 'this project has no recorded needs to cite' }
  }

  const roles: RosterRole[] = []
  const seenNames = new Set<string>()
  for (const chunk of filled) {
    const fields = new Map<string, string>()
    for (const raw of chunk) {
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
    const rawCaps = (fields.get('capabilities') ?? '')
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    const bogus = rawCaps.find((c) => !isCapability(c.toLowerCase()))
    if (bogus) {
      return {
        status: 'refused',
        reason: `"${bogus}" is not a capability this app can enforce (${CAPABILITIES.join(', ')})`,
      }
    }
    const need = fields.get('need') ?? ''
    const resolved = known.get(needKey(need))
    if (!resolved) {
      return {
        status: 'refused',
        reason: `cited a need I can't verify against this project: "${need.slice(0, 60)}"`,
      }
    }
    const name = (fields.get('role') ?? '').slice(0, MAX_NAME).trim()
    const nameKey = agentNameKey(name)
    if (seenNames.has(nameKey)) {
      return { status: 'refused', reason: `two roles named "${name}" — the roster is ambiguous` }
    }
    seenNames.add(nameKey)
    roles.push({
      name,
      purpose: (fields.get('purpose') ?? '').slice(0, MAX_LINE),
      model,
      modelWhy: (fields.get('model_why') ?? '').slice(0, MAX_LINE),
      capabilities: normalizeCapabilities(rawCaps),
      need: resolved,
    })
  }

  return { status: 'ok', input: { roles, evidence } }
}

/** The reply with its roster block cut out — the PROSE the model wrote, and the
 *  only thing a wake's rest/work classification may judge (same rule as
 *  `stripProposalBlock`: appending a block must never turn a quiet beat into a
 *  "worked" one). */
export function stripRosterBlock(text: string): string {
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

// ---------------------------------------------------------------------------
// Review — what the desk shows BEFORE the tap
// ---------------------------------------------------------------------------

/** A row as the user will really see it, after both clamps. */
export interface ReviewedRow {
  role: RosterRole
  /** The capabilities this row would REALLY get (clamped to the user's). */
  granted: Capability[]
  /** Capabilities asked for and refused, with the reason. */
  refused: { capability: Capability; reason: string }[]
  /** '' when this row's AI can run; else why it cannot, and it will not be
   *  created. */
  sitOutReason: string
}

/**
 * The roster as it would REALLY be created: every row clamped to the user's own
 * grants, and every seat checked against the provider it would really run on.
 *
 * Nothing is dropped silently — a row that cannot run keeps its reason, and the
 * caller must show it (`rosterSitOutLine`).
 */
export function reviewRoster(
  roles: readonly RosterRole[],
  opts: { gate: RosterGate; userGrants: readonly Capability[] },
): { rows: ReviewedRow[]; sitOut: SitOut[] } {
  const rows: ReviewedRow[] = []
  const sitOut: SitOut[] = []
  for (const role of roles) {
    const { granted, refused } = grantSubset(opts.userGrants, role.capabilities)
    const sitOutReason = opts.gate(role.model)
    if (sitOutReason) sitOut.push({ role: role.name, token: role.model, reason: sitOutReason })
    rows.push({ role, granted, refused, sitOutReason })
  }
  return { rows, sitOut }
}

/** One line naming everyone in a roster who cannot run, and why. */
export function rosterSitOutLine(sitOut: readonly SitOut[]): string {
  if (sitOut.length === 0) return ''
  return sitOut.map((s) => `${s.role} can't be staffed: ${s.reason}`).join(' · ')
}

/** The plain-words line for one row: which AI, and what it may touch. */
export function rowCapabilityLine(row: ReviewedRow): string {
  if (row.granted.length === 0) return 'no capabilities — it can only think and write back to you'
  return row.granted.map(capabilityLabel).join(' · ')
}

// ---------------------------------------------------------------------------
// State + persistence
// ---------------------------------------------------------------------------

function isRole(x: unknown): x is RosterRole {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  return (
    typeof r.name === 'string' &&
    typeof r.purpose === 'string' &&
    (r.model === 'claude' || r.model === 'gemini' || r.model === 'local') &&
    typeof r.modelWhy === 'string' &&
    Array.isArray(r.capabilities) &&
    r.capabilities.every((c) => isCapability(c)) &&
    typeof r.need === 'string'
  )
}

export function isRosterProposal(x: unknown): x is RosterProposal {
  if (typeof x !== 'object' || x === null) return false
  const p = x as Record<string, unknown>
  const e = p.evidence as Record<string, unknown> | undefined
  return (
    typeof p.id === 'string' &&
    Array.isArray(p.roles) &&
    p.roles.every(isRole) &&
    typeof e === 'object' &&
    e !== null &&
    typeof e.projectId === 'string' &&
    typeof e.projectName === 'string' &&
    Array.isArray(e.needs) &&
    (e.needs as unknown[]).every((n) => typeof n === 'string') &&
    typeof p.at === 'number' &&
    (p.status === 'open' || p.status === 'created' || p.status === 'dismissed')
  )
}

function persist(next: RosterProposal[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage unavailable — keep the in-memory copy
  }
}

function load(): RosterProposal[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every(isRosterProposal)) return parsed
    }
  } catch {
    // corrupt / unavailable — start empty. NEVER seeded: a roster with no real
    // project behind it is exactly what this feature refuses to invent.
  }
  return []
}

let state: RosterProposal[] = load()

const listeners = new Set<() => void>()

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function commit(next: RosterProposal[]): void {
  state = next
  persist(next)
  for (const listener of listeners) listener()
}

/** Every roster proposal ever recorded, oldest first. */
export function list(): RosterProposal[] {
  return state
}

/** Only the ones still awaiting the human — what the desk shows. PURE. */
export function openRosters(proposals: readonly RosterProposal[]): RosterProposal[] {
  return proposals.filter((p) => p.status === 'open')
}

/**
 * Why this roster must NOT be recorded, or null when it may be.
 *
 *   • no roles → refuse (there is no roster)
 *   • a roster is ALREADY open for this project → refuse (it is already waiting)
 *   • this project was ALREADY staffed from a roster → refuse (staffing is a
 *     once-per-project act; growing the team later is the single-agent flow)
 *   • it was dismissed citing the SAME needs → refuse (that is nagging). A
 *     genuinely different set of needs is a new argument the user has not seen.
 */
export function blockedReason(input: NewRosterInput): string | null {
  if (input.roles.length === 0) return 'a roster needs at least one role'
  const pid = input.evidence.projectId
  if (!pid) return 'a roster needs a project'
  const mine = state.filter((p) => p.evidence.projectId === pid)
  if (mine.some((p) => p.status === 'open')) {
    return `a roster for "${input.evidence.projectName}" is already waiting on your desk`
  }
  if (mine.some((p) => p.status === 'created')) {
    return `"${input.evidence.projectName}" has already been staffed`
  }
  const key = needsKey(input.evidence.needs)
  if (mine.some((p) => p.status === 'dismissed' && needsKey(p.evidence.needs) === key)) {
    return `you dismissed a roster for "${input.evidence.projectName}" before, and this cites the same needs`
  }
  return null
}

function needsKey(needs: readonly string[]): string {
  return [...needs].map(needKey).sort().join('|')
}

let seq = 0

/**
 * Record a roster proposal, or `null` when `blockedReason` says it must not be
 * recorded. Callers must treat null as "nothing was recorded" and say so —
 * `blockedReason` gives them the sentence.
 */
export function propose(input: NewRosterInput, now: number): RosterProposal | null {
  if (blockedReason(input) !== null) return null
  const proposal: RosterProposal = {
    id: `roster-${now.toString(36)}-${(seq++).toString(36)}`,
    roles: input.roles.map((r) => ({
      ...r,
      name: r.name.trim(),
      purpose: r.purpose.trim(),
      modelWhy: r.modelWhy.trim(),
      capabilities: normalizeCapabilities(r.capabilities as string[]),
      need: r.need.trim(),
    })),
    evidence: {
      projectId: input.evidence.projectId,
      projectName: input.evidence.projectName,
      needs: [...input.evidence.needs],
    },
    at: now,
    status: 'open',
  }
  commit([...state, proposal])
  return proposal
}

/** Dismiss a roster — STICKY, so the same argument never nags again. */
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
 * CREATE — ONE approval, the whole roster. The one place a proposal becomes
 * real agents.
 *
 * `reviewed` is what the human ACTUALLY approved: the rows as edited, or the
 * untouched originals. Nothing else is used — an edited value wins over the
 * proposal's own value, always, including the AI and the capabilities.
 *
 * TWO clamps still apply at the moment of creation, because the world may have
 * moved since the proposal was made:
 *   • a row whose AI cannot answer is NOT created, and comes back in `sitOut`
 *     with the reason (never silently, never as a stub seat);
 *   • capabilities are intersected with the user's own grants, so a row can
 *     never be created holding more than the human has. (The engine intersects
 *     again at `AgentGrants.__init__` — this clamp is for what we store, that
 *     one is the security boundary.)
 *
 * A name already taken is SUFFIXED ('Researcher' → 'Researcher 2') rather than
 * shadowing an existing agent. Returns null when the proposal is missing or
 * already decided — a double-tap must never mint a second team.
 */
export function createFromRoster(
  id: string,
  reviewed: readonly RosterRole[],
  opts: { gate: RosterGate; userGrants: readonly Capability[] },
  now: number,
): { created: StoredAgent[]; sitOut: SitOut[] } | null {
  const target = state.find((p) => p.id === id)
  if (!target || target.status !== 'open') return null

  const created: StoredAgent[] = []
  const sitOut: SitOut[] = []
  const stored: RosterRole[] = []
  for (const row of reviewed) {
    const reason = opts.gate(row.model)
    if (reason) {
      sitOut.push({ role: row.name, token: row.model, reason })
      continue
    }
    const { granted } = grantSubset(opts.userGrants, row.capabilities)
    const name = uniqueAgentName(listAgents(), row.name)
    const agent = createAgent({
      name,
      role: row.purpose,
      model: row.model,
      // The capabilities travel as skills so the library, the roster string and
      // the engine argv all read the same grant — one record, not two.
      skills: granted,
      assignedTo: target.evidence.projectId,
    })
    created.push(agent)
    stored.push({ ...row, name, capabilities: granted })
  }

  commit(
    state.map((p) =>
      p.id === id
        ? {
            ...p,
            status: 'created' as const,
            decidedAt: now,
            createdAgentIds: created.map((a) => a.id),
            // The audit copy shows what was ACTUALLY created, not the original
            // suggestion — the edited values, clamped.
            roles: stored,
          }
        : p,
    ),
  )
  return { created, sitOut }
}

/** The names Create would REALLY write for these rows — the same suffixing
 *  `createFromRoster` applies, exposed so the desk can warn about a collision
 *  BEFORE the tap instead of surprising the user after it. */
export function plannedNames(roles: readonly RosterRole[], agents = listAgents()): string[] {
  const soFar = [...agents]
  const out: string[] = []
  for (const r of roles) {
    const name = uniqueAgentName(soFar, r.name)
    out.push(name)
    soFar.push({ ...soFar[0], id: `planned-${name}`, name } as StoredAgent)
  }
  return out
}

// ---------------------------------------------------------------------------
// Vault side — the durable, auditable copy (same discipline as agentProposals)
// ---------------------------------------------------------------------------

function newerOf(mine: RosterProposal, theirs: RosterProposal): RosterProposal {
  return (theirs.decidedAt ?? 0) > (mine.decidedAt ?? 0) ? theirs : mine
}

/** Write the roster ledger to `<vault>/proposals/project-rosters.json`.
 *  READ-MERGE-WRITE by id, never a blind overwrite. */
export async function persistRostersToVault(vaultPath?: string): Promise<boolean> {
  if (!isNative()) return false
  try {
    const vault = await resolveVaultDir(vaultPath)
    const merged = new Map<string, RosterProposal>()
    try {
      const raw = await readVaultFile(vault, ROSTER_VAULT_PATH)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (Array.isArray(parsed)) {
        for (const p of parsed) if (isRosterProposal(p)) merged.set(p.id, p)
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
      ROSTER_VAULT_PATH,
      JSON.stringify([...merged.values()], null, 2),
    )
    return written !== null
  } catch {
    return false
  }
}

/** Merge the vault ledger into the local store — the restart path. */
export async function hydrateRostersFromVault(vaultPath?: string): Promise<number> {
  if (!isNative()) return 0
  try {
    const vault = await resolveVaultDir(vaultPath)
    const raw = await readVaultFile(vault, ROSTER_VAULT_PATH)
    if (!raw) return 0
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return 0
    const fromVault = parsed.filter(isRosterProposal)
    const byId = new Map(fromVault.map((p) => [p.id, p]))
    let changed = 0
    const updated = state.map((mine) => {
      const theirs = byId.get(mine.id)
      if (!theirs) return mine
      const winner = newerOf(mine, theirs)
      if (winner !== mine) changed++
      return winner
    })
    const known = new Set(state.map((p) => p.id))
    const adopted = fromVault.filter((p) => !known.has(p.id))
    changed += adopted.length
    if (changed === 0) return 0
    commit([...updated, ...adopted])
    return changed
  } catch {
    return 0
  }
}

/** Test seam: drop every recorded roster (never called by the app). */
export function __resetForTests(): void {
  commit([])
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

export function useProjectRosters(): RosterProposal[] {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}
