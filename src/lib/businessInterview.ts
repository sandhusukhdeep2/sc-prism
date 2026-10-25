// SC Prism — the companion INTERVIEWS the user to earn his business leg
// (2026-08-15 spec §4).
//
// THE RULE, stated once because everything below depends on it: he cannot do
// business work from "software consultancy, 2-5 people". So when the business
// context note is missing or thin AND nothing higher on the ladder has real
// work, one wake may ask up to THREE one-line questions. They are posted as a
// "Needs you" item on the Work desk — never as a chat interruption — and each
// is answerable inline.
//
// HONESTY, which is the whole point:
//   • A question is a question. An UNANSWERED question is never written to the
//     note, never shown as knowledge, and never reaches a later wake's prompt.
//     The only thing that lands in the note is an answer the user typed.
//   • The note SAYS which parts came from him and which are the companion's own
//     reading of the vault, in two separate, labelled sections.
//   • The note is the ONLY memory. Nothing about the business is remembered
//     anywhere else — this store holds questions, never facts.
//   • Asking is rate-limited: at most ONE open set at a time, and a question
//     that was ever asked is never asked again (answered or not).
//
// Storage mirrors the vault-artifact idiom of agentProposals.ts: a synchronous
// localStorage-backed store for the UI, plus a durable JSON copy vault-side so a
// dismissal survives a restart. `resolveVaultDir` ALWAYS runs first — a `~` path
// must never reach the Rust side unresolved.

import { useSyncExternalStore } from 'react'
import { isNative, readVaultFile, resolveVaultDir, writeVaultNote } from './nativeEngine'

const KEY = 'scprism.businessInterview'

/** The note he reads on later wakes — the source of truth for business context. */
export const BUSINESS_CONTEXT_PATH = 'business/context.md'

/** The durable copy of the question ledger (questions + their status, never
 *  facts). Separate from the note on purpose: the note is for the human and for
 *  the wake prompt; this is plumbing that stops a dismissed question returning. */
export const BUSINESS_QUESTIONS_PATH = 'business/questions.json'

/** Never more than three questions in one set — a wake asks a little, once. */
export const MAX_QUESTIONS = 3

/** How many answers count as "he has told me enough to work from". Below this
 *  the business leg is THIN and rung 4 stays closed; at or above it he stops
 *  being asked and starts being worked for. Three because that is the size of
 *  one question set: one honest round of questions earns the leg. */
export const MIN_ANSWERS = 3

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** One set of questions posted to the desk. It holds QUESTIONS ONLY — the
 *  answers live in the vault note, never here. */
export interface QuestionSet {
  id: string
  at: number
  /** One line each, at most MAX_QUESTIONS. */
  questions: string[]
  /** 'open' until the user answers or dismisses it; exactly one human action
   *  moves it, and either way its questions are never asked again. */
  status: 'open' | 'answered' | 'dismissed'
  decidedAt?: number
  /** How many of the questions he actually answered (0 for a dismissal). A
   *  count, not content — the content is in the note. */
  answeredCount?: number
}

/** A question the user really answered, in his own words. */
export interface AnsweredQuestion {
  q: string
  a: string
}

// ---------------------------------------------------------------------------
// The block format — ONE definition, shared by the prompt and the parser
// ---------------------------------------------------------------------------

export const ASK_FENCE = 'ASK_BUSINESS'

/** The exact skeleton a wake is shown (and the parser enforces). */
export const ASK_BLOCK_TEMPLATE = [
  '```' + ASK_FENCE,
  'q: <one line question>',
  'q: <one line question>',
  'q: <one line question>',
  '```',
].join('\n')

/**
 * The paragraph appended to a wake's prompt when — and only when — asking is
 * allowed. It says plainly that these are questions, that they go to the desk
 * (not to a chat), and that he must not write as if he already knew the answers.
 *
 * `alreadyAsked` are the questions he has ALREADY put to the user (answered,
 * dismissed, or still open). They are listed so the model does not spend the set
 * re-asking them; the store refuses a repeat anyway.
 */
export function askCharter(alreadyAsked: readonly string[] = []): string {
  const asked = alreadyAsked.length
    ? `You have already asked these — do NOT ask them again:\n${alreadyAsked.map((q) => `- ${q}`).join('\n')}`
    : 'You have not asked them anything yet.'
  return [
    `You may ALSO ask the user up to ${MAX_QUESTIONS} questions about their business, because you have not been told enough to do business work honestly.`,
    'Ask only what you genuinely need in order to be useful, one line each, answerable in a sentence.',
    asked,
    'If you ask, END your reply with exactly this block (field names verbatim, one question per line) — nothing at all may follow it:',
    ASK_BLOCK_TEMPLATE,
    'The questions go to their desk as a "Needs you" item; they do not interrupt the user. Until they answer, you know nothing more than you know now — never write as if a question had been answered.',
  ].join('\n\n')
}

export type AskParse =
  | { status: 'none' }
  | { status: 'refused'; reason: string }
  | { status: 'ok'; questions: string[]; dropped: number }

const OPEN_RE = new RegExp(`^[ \\t]*\`\`\`[ \\t]*${ASK_FENCE}[ \\t]*$`, 'gm')
const CLOSE_RE = /^[ \t]*```[ \t]*$/
const ANY_FENCE_RE = /^[ \t]*```/
const MAX_QUESTION_CHARS = 200

/**
 * Parse a reply for ONE `ASK_BUSINESS` block. Strict, for the same reason the
 * proposal parser is strict — a malformed block is ignored with an honest
 * reason, never repaired into questions the user is then asked:
 *   • the fence is opened but never closed
 *   • more than one block
 *   • a body line that is not `q: <text>`
 *   • no question at all
 *   • the block is not the LAST thing in the reply (a quoted example, or a
 *     block the model retracts on the next line, must not reach the desk)
 * More than MAX_QUESTIONS are CAPPED, not refused, and `dropped` says how many
 * were cut so the beat line can report it rather than hiding it.
 */
export function parseAskBlock(text: string): AskParse {
  const opens: number[] = []
  OPEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = OPEN_RE.exec(text)) !== null) opens.push(m.index + m[0].length)
  if (opens.length === 0) return { status: 'none' }
  if (opens.length > 1) {
    return { status: 'refused', reason: `more than one ${ASK_FENCE} block — none used` }
  }
  const rest = text.slice(opens[0]).replace(/^\n/, '')
  const lines = rest.split('\n')
  const closeAt = lines.findIndex((l) => CLOSE_RE.test(l))
  if (closeAt === -1) {
    return { status: 'refused', reason: `the ${ASK_FENCE} block was never closed` }
  }
  const trailing = lines.slice(closeAt + 1).find((l) => l.trim() !== '')
  if (trailing !== undefined) {
    const what = ANY_FENCE_RE.test(trailing) ? 'another code fence' : `"${trailing.trim().slice(0, 40)}"`
    return {
      status: 'refused',
      reason: `the ${ASK_FENCE} block was not the last thing in the reply (${what} follows it)`,
    }
  }
  const questions: string[] = []
  for (const raw of lines.slice(0, closeAt)) {
    const line = raw.trim()
    if (!line) continue
    const kv = /^q[ \t]*:[ \t]*(.*)$/i.exec(line)
    if (!kv) {
      return { status: 'refused', reason: `unreadable line in the block: "${line.slice(0, 60)}"` }
    }
    const q = kv[1].trim()
    if (q) questions.push(q.slice(0, MAX_QUESTION_CHARS))
  }
  if (questions.length === 0) return { status: 'refused', reason: 'the block asked nothing' }
  return {
    status: 'ok',
    questions: questions.slice(0, MAX_QUESTIONS),
    dropped: Math.max(0, questions.length - MAX_QUESTIONS),
  }
}

/** The reply with its `ASK_BUSINESS` block cut out — the PROSE, and the only
 *  thing a wake's rest/work classification may judge. Same discipline as
 *  stripProposalBlock: asking a question is not doing work, so a block must
 *  never turn an honest `NOTHING_NEEDED` into a fabricated 'worked' beat. */
export function stripAskBlock(text: string): string {
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
// The note — the only memory
// ---------------------------------------------------------------------------

const NOTE_TITLE = '# Business context'
const FROM_USER_HEAD = '## What the user told me (their own words)'
const FROM_VAULT_HEAD = '## What I read in the vault myself (my reading, not something I was told)'
const PREAMBLE = [
  'Everything under the first heading is an answer the user typed themselves, quoted as they wrote it.',
  'Everything under the second is my own reading of files in this vault — inference, not testimony.',
  'This note is the only memory: nothing about the business is remembered anywhere else in the app,',
  'and a question they have not answered is not written here at all.',
].join('\n')

/** 'YYYY-MM-DD' in LOCAL time — the same local-day discipline the beat log uses. */
function dayKey(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** One Q/A entry, in the note's format. */
function entry(pair: AnsweredQuestion, at: number): string {
  const q = pair.q.trim().replace(/\s+/g, ' ')
  const a = pair.a.trim()
  return `- **Q:** ${q}\n  **A:** ${a}\n  _answered ${dayKey(at)}_\n`
}

/**
 * The note's new content: the existing note with these answers appended to the
 * "what he told me" section. PURE — the caller writes the result.
 *
 * A missing/blank note is created with both headings and the preamble that
 * states the provenance rule. An existing note keeps everything it already has
 * (including any reading section the companion wrote himself); the new entries
 * are spliced in just before the reading heading, so testimony and inference
 * never end up mixed in one list. Answers with empty text are DROPPED here as
 * well as by the caller — an unanswered question must not reach this file by
 * any route.
 */
export function renderContextNote(
  existing: string | null,
  answers: readonly AnsweredQuestion[],
  at: number,
): string {
  const real = answers.filter((p) => p.q.trim() && p.a.trim())
  const block = real.map((p) => entry(p, at)).join('')
  const base = (existing ?? '').trim()
  if (!base) {
    return [
      NOTE_TITLE,
      '',
      PREAMBLE,
      '',
      FROM_USER_HEAD,
      '',
      block || '_nothing yet — no question has been answered._\n',
      FROM_VAULT_HEAD,
      '',
      '_nothing recorded here yet._',
      '',
    ].join('\n')
  }
  if (!block) return `${base}\n`
  const idx = base.indexOf(FROM_VAULT_HEAD)
  if (idx === -1) return `${base}\n${block}`
  const head = base.slice(0, idx).replace(/\s+$/, '')
  const tail = base.slice(idx)
  return `${head}\n\n${block}\n${tail}\n`
}

const Q_LINE_RE = /^[ \t]*-?[ \t]*\*\*Q:\*\*[ \t]*(.+)$/gm
const A_LINE_RE = /^[ \t]*\*\*A:\*\*[ \t]*(.+)$/gm

/** The questions this note records as ANSWERED, in his words. Read from the
 *  note because the note outlives this store (a cleared webview cache must not
 *  make him re-ask what he was already told). */
export function answeredQuestions(note: string | null): string[] {
  if (!note) return []
  const out: string[] = []
  Q_LINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = Q_LINE_RE.exec(note)) !== null) out.push(m[1].trim())
  return out
}

/** How many real answers the note holds — a Q with an A under it. */
export function answeredCount(note: string | null): number {
  if (!note) return 0
  A_LINE_RE.lastIndex = 0
  let n = 0
  while (A_LINE_RE.exec(note) !== null) n++
  return Math.min(n, answeredQuestions(note).length)
}

/** Is the business leg still unearned? Missing note, or fewer than MIN_ANSWERS
 *  real answers in it. Thin means: do not do business work, ask instead. */
export function contextThin(note: string | null): boolean {
  return answeredCount(note) < MIN_ANSWERS
}

// ---------------------------------------------------------------------------
// State + persistence
// ---------------------------------------------------------------------------

function isSet(x: unknown): x is QuestionSet {
  if (typeof x !== 'object' || x === null) return false
  const s = x as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    typeof s.at === 'number' &&
    Array.isArray(s.questions) &&
    s.questions.every((q) => typeof q === 'string') &&
    (s.status === 'open' || s.status === 'answered' || s.status === 'dismissed')
  )
}

function load(): QuestionSet[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every(isSet)) return parsed
    }
  } catch {
    // corrupt / unavailable — start empty. NEVER seeded: a question he was
    // never asked must not appear as one he was.
  }
  return []
}

let state: QuestionSet[] = load()
const listeners = new Set<() => void>()

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function commit(next: QuestionSet[]): void {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage unavailable — keep the in-memory copy
  }
  for (const l of listeners) l()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function list(): QuestionSet[] {
  return state
}

/** The one set still awaiting the user, or null. PURE. */
export function openSet(sets: readonly QuestionSet[] = state): QuestionSet | null {
  return sets.find((s) => s.status === 'open') ?? null
}

/** Comparison key for a question: case- and punctuation-insensitive, so a
 *  reworded-but-identical question still counts as already asked. */
export function questionKey(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Every question he has EVER been put — from the ledger and from the note.
 *  The never-re-ask rule reads this; the note half is what makes the rule
 *  survive a cleared cache. */
export function askedKeys(sets: readonly QuestionSet[] = state, note: string | null = null): Set<string> {
  const keys = new Set<string>()
  for (const s of sets) for (const q of s.questions) keys.add(questionKey(q))
  for (const q of answeredQuestions(note)) keys.add(questionKey(q))
  return keys
}

/** Every question he has ever been put, in its original words (newest last) —
 *  what the prompt shows the model so it does not spend a set re-asking. */
export function askedQuestions(
  sets: readonly QuestionSet[] = state,
  note: string | null = null,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const q of [...sets.flatMap((s) => s.questions), ...answeredQuestions(note)]) {
    const key = questionKey(q)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(q)
  }
  return out
}

/**
 * Why this wake may NOT ask, or null when it may. Exported so the beat can say
 * the honest reason instead of a bare silence. The gates, in order:
 *   • something is genuinely waiting on the user — rung 1 outranks asking, and
 *     the spec is explicit that questions come only when nothing else does.
 *   • the context is NOT thin — he has already told us enough; asking again
 *     would be nagging for its own sake.
 *   • a set is already open — at most one open question set at a time.
 * Rung 2/3 ("has the vault or a project got real work?") is deliberately NOT a
 * gate here: only the wake, reading the real files, can answer that, and the
 * charter tells it to ask only when nothing above has genuinely new state.
 */
export function askBlockedReason(input: {
  needsYou: number
  contextThin: boolean
  sets?: readonly QuestionSet[]
}): string | null {
  if (input.needsYou > 0) return 'something is already waiting on you'
  if (!input.contextThin) return 'the business context note already has what I need'
  if (openSet(input.sets ?? state)) return 'a question set is already open on your desk'
  return null
}

let seq = 0

/**
 * Record a set of questions for the desk. Returns the stored set, or null when
 * nothing new was left to ask (every question had been asked before) — the
 * caller must treat null as "nothing was recorded" and say so.
 *
 * Questions already asked are dropped, not refused wholesale: two fresh
 * questions plus one repeat is still a legitimate, smaller set.
 */
export function ask(
  questions: readonly string[],
  now: number,
  note: string | null = null,
): QuestionSet | null {
  const seen = askedKeys(state, note)
  const fresh: string[] = []
  for (const q of questions) {
    const text = q.trim()
    const key = questionKey(text)
    if (!text || !key || seen.has(key)) continue
    seen.add(key)
    fresh.push(text)
    if (fresh.length >= MAX_QUESTIONS) break
  }
  if (fresh.length === 0) return null
  const set: QuestionSet = {
    id: `ask-${now.toString(36)}-${(seq++).toString(36)}`,
    at: now,
    questions: fresh,
    status: 'open',
  }
  commit([...state, set])
  return set
}

/**
 * The user's answers. Only NON-BLANK ones become content: a question he left
 * empty is closed without ever being written to the note, and is never asked
 * again either (that is what "one honest round" means). Returns the pairs that
 * will really be written, so the caller writes exactly what this recorded.
 */
export function recordAnswers(id: string, answers: readonly string[], now: number): AnsweredQuestion[] {
  const target = state.find((s) => s.id === id)
  if (!target || target.status !== 'open') return []
  const pairs: AnsweredQuestion[] = []
  target.questions.forEach((q, i) => {
    const a = (answers[i] ?? '').trim()
    if (a) pairs.push({ q, a })
  })
  commit(
    state.map((s) =>
      s.id === id
        ? { ...s, status: 'answered' as const, decidedAt: now, answeredCount: pairs.length }
        : s,
    ),
  )
  return pairs
}

/** Dismiss a set — STICKY: the record survives so those questions are never
 *  asked again, exactly like a dismissed agent proposal. */
export function dismissSet(id: string, now: number): void {
  let changed = false
  const next = state.map((s) => {
    if (s.id !== id || s.status !== 'open') return s
    changed = true
    return { ...s, status: 'dismissed' as const, decidedAt: now, answeredCount: 0 }
  })
  if (changed) commit(next)
}

// ---------------------------------------------------------------------------
// Vault side
// ---------------------------------------------------------------------------

/** The business context note as it stands, or null (missing / browser / any
 *  read failure). Null is honest: it means "I have not been told anything". */
export async function readBusinessContext(vaultPath?: string): Promise<string | null> {
  if (!isNative()) return null
  try {
    const vault = await resolveVaultDir(vaultPath)
    return await readVaultFile(vault, BUSINESS_CONTEXT_PATH)
  } catch {
    return null
  }
}

/**
 * Write his answers into the note (read-modify-write, so nothing already there
 * is lost) and return whether the write really landed. The caller must not
 * claim the answers were saved on a false return — the answers would then exist
 * nowhere, because this note is the only memory.
 */
export async function saveAnswersToVault(
  answers: readonly AnsweredQuestion[],
  vaultPath: string | undefined,
  now: number,
): Promise<boolean> {
  const real = answers.filter((p) => p.q.trim() && p.a.trim())
  if (real.length === 0) return false
  if (!isNative()) return false
  try {
    const vault = await resolveVaultDir(vaultPath)
    const existing = await readVaultFile(vault, BUSINESS_CONTEXT_PATH)
    const next = renderContextNote(existing, real, now)
    return (await writeVaultNote(vault, BUSINESS_CONTEXT_PATH, next)) !== null
  } catch {
    return false
  }
}

/** The newer of two records for the same id — a decision always beats an
 *  undecided copy, so a dismissal is never reverted to 'open' by a stale one. */
function newerOf(mine: QuestionSet, theirs: QuestionSet): QuestionSet {
  return (theirs.decidedAt ?? 0) > (mine.decidedAt ?? 0) ? theirs : mine
}

/** Write the question ledger vault-side (read-merge-write by id, never a blind
 *  overwrite — same discipline as the proposal ledger). */
export async function persistQuestionsToVault(vaultPath?: string): Promise<boolean> {
  if (!isNative()) return false
  try {
    const vault = await resolveVaultDir(vaultPath)
    const merged = new Map<string, QuestionSet>()
    try {
      const raw = await readVaultFile(vault, BUSINESS_QUESTIONS_PATH)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (Array.isArray(parsed)) for (const s of parsed) if (isSet(s)) merged.set(s.id, s)
    } catch {
      // unreadable ledger — write what we hold rather than lose it too
    }
    for (const s of state) {
      const theirs = merged.get(s.id)
      merged.set(s.id, theirs ? newerOf(s, theirs) : s)
    }
    const written = await writeVaultNote(
      vault,
      BUSINESS_QUESTIONS_PATH,
      JSON.stringify([...merged.values()], null, 2),
    )
    return written !== null
  } catch {
    return false
  }
}

/** Merge the vault ledger into the local store (the restart path). Returns how
 *  many records changed. Never throws. */
export async function hydrateQuestionsFromVault(vaultPath?: string): Promise<number> {
  if (!isNative()) return 0
  try {
    const vault = await resolveVaultDir(vaultPath)
    const raw = await readVaultFile(vault, BUSINESS_QUESTIONS_PATH)
    if (!raw) return 0
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return 0
    const fromVault = parsed.filter(isSet)
    const byId = new Map(fromVault.map((s) => [s.id, s]))
    let changed = 0
    const updated = state.map((mine) => {
      const theirs = byId.get(mine.id)
      if (!theirs) return mine
      const winner = newerOf(mine, theirs)
      if (winner !== mine) changed++
      return winner
    })
    const known = new Set(state.map((s) => s.id))
    const adopted = fromVault.filter((s) => !known.has(s.id))
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

export function useBusinessQuestions(): QuestionSet[] {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}
