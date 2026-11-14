// The work, in the chat (spec 2026-11-14 "Visible agents").
//
// The mockup the owner called "perfect example what I want" writes a run into
// the chat as SEAT-ATTRIBUTED LINES — who · on which AI · what it did, "each
// from a span" — and closes it with ONE outcome strip. This file is those
// lines and that strip, as data:
//
//   runLines(spans)      a live (or just-finished) run, one line per stretch
//                        of one seat's work, then the checks, the review, and
//                        what the run did with the user's notes;
//   turnLine(turn)       a seat's recorded turn from the saved board, as the
//                        same kind of line (the whole turn opens from it);
//   verdictOutcome(v)    a run's Verdict, as the strip;
//   teamOutcome(text,…)  a team run's own notice, as the strip.
//
// NOTHING HERE IS INVENTED. A line exists because spans (or the saved board)
// say so; a number is one a span carried; "thinking" is said only of an open
// call on a run that is executing; a check that did not run is never "passed".
import type { EngineSpan } from './nativeEngine'
import type { ChatMessage } from '../store/AppStore'
import type { Verdict } from '../engine/types'
import { seatLabel } from './teamBoard'
import { verdictTone } from './verdictOutcome'
import { webHost } from './webSpan'

export type LineTone = 'plain' | 'live' | 'warn'
export interface LineChip {
  text: string
  kind: 'plain' | 'local' | 'warn'
}
export interface RunLine {
  key: string
  /** The seat ('Manager', 'Researcher'), or 'Checks' / 'Review' / 'Privacy'. */
  who: string
  /** `provider · model` that did it; '' when no AI did. */
  ai: string
  local: boolean
  text: string
  tone: LineTone
  chips: LineChip[]
}

type Attrs = Record<string, unknown> | undefined
const str = (a: Attrs, k: string): string => (typeof a?.[k] === 'string' ? (a[k] as string) : '')
const isCall = (s: EngineSpan) => s.type === 'model_call' || s.name === 'model_call'
const isWork = (s: EngineSpan) => isCall(s) && s.name !== 'eval'
const isTool = (s: EngineSpan) =>
  (s.type === 'tool_exec' || s.name === 'tool_exec') && s.name !== 'tier1' && s.name !== 'tier2'
const isOpen = (s: EngineSpan) => s.status !== 'ok' && s.status !== 'error'
const aiOf = (a: Attrs) => [str(a, 'provider'), str(a, 'model')].filter(Boolean).join(' · ')
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** `a`, `a and b`, `a, b +N` — the first two named, the rest counted. */
function named(items: string[]): string {
  const uniq = [...new Set(items)]
  if (uniq.length <= 1) return uniq[0] ?? ''
  if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`
  return `${uniq[0]}, ${uniq[1]} +${uniq.length - 2}`
}

/** What one stretch of one seat's work did, in plain words. */
function stretchLine(
  key: string,
  agent: string,
  spans: EngineSpan[],
  live: boolean,
  next: string,
): RunLine {
  const tools = spans.filter(isTool)
  const calls = spans.filter(isWork)
  const lastCall = calls[calls.length - 1]
  const a = lastCall?.attrs
  const local = str(a, 'provider') === 'local'
  const phrases: string[] = []
  const chips: LineChip[] = []

  const ok = (s: EngineSpan) =>
    s.attrs?.blocked !== true && s.attrs?.withheld !== true && s.attrs?.is_error !== true && s.status !== 'error'
  const notes = tools.filter((s) => str(s.attrs, 'provider') === 'vault' && s.attrs?.blocked !== true && s.status !== 'error')
  const read = notes.filter((s) => str(s.attrs, 'tool') === 'vault_read' && str(s.attrs, 'path'))
  if (read.length > 0) phrases.push(`read ${named(read.map((s) => str(s.attrs, 'path')))}`)
  else if (notes.length > 0) phrases.push('looked through your notes')
  const web = tools.filter((s) => str(s.attrs, 'provider') === 'web' && ok(s))
  const searches = web.filter((s) => str(s.attrs, 'tool') === 'web_search').length
  if (searches > 0) phrases.push(`searched the web${searches > 1 ? ` ×${searches}` : ''}`)
  const hosts = web.filter((s) => str(s.attrs, 'tool') !== 'web_search').map((s) => webHost(s.attrs ?? {}) || 'a page')
  if (hosts.length > 0) phrases.push(`read ${named(hosts)}`)
  const other = tools.filter((s) => !['vault', 'web'].includes(str(s.attrs, 'provider')) && ok(s))
  if (other.length > 0) {
    phrases.push(
      `used ${named(other.map((s) => [str(s.attrs, 'server'), str(s.attrs, 'tool')].filter(Boolean).join(' · ') || 'a tool'))}`,
    )
  }
  const failed = tools.filter(
    (s) => s.attrs?.blocked !== true && s.attrs?.withheld !== true && (s.attrs?.is_error === true || s.status === 'error'),
  ).length
  if (failed > 0) phrases.push(`${plural(failed, 'lookup')} failed`)
  const blocked = tools.filter((s) => s.attrs?.blocked === true || s.attrs?.refused === true).length
  if (blocked > 0) chips.push({ text: `${blocked} blocked by your rules`, kind: 'warn' })
  // The notes a LOCAL seat read never left this Mac — the claim the product
  // is about, made only where it is true.
  if (local && notes.length > 0) chips.push({ text: 'stayed local', kind: 'local' })

  let tone: LineTone = 'plain'
  if (lastCall) {
    if (isOpen(lastCall)) {
      // An open call on a run that is NOT executing is not thinking.
      if (live) {
        phrases.push('thinking')
        tone = 'live'
      }
    } else if (lastCall.attrs?.is_real === false || lastCall.status === 'error') {
      const cause = str(a, 'error')
      phrases.push(cause ? `no answer — ${cause}` : 'no answer')
      tone = 'warn'
    } else {
      phrases.push('answered')
      if (next) phrases.push(`handed to ${seatLabel(next)}`)
    }
  } else if (live && tools.some(isOpen)) {
    tone = 'live'
  }
  return { key, who: seatLabel(agent), ai: aiOf(a), local, text: phrases.join(' · '), tone, chips }
}

/**
 * A run, as lines. `live` — the run is genuinely executing (an open call on
 * any other run claims nothing).
 */
export function runLines(spans: readonly EngineSpan[], live: boolean): RunLine[] {
  const ordered = spans.slice().sort((x, y) => (x.start ?? 0) - (y.start ?? 0))
  // Stretches: consecutive work spans of one seat. A tool span that names no
  // agent belongs to the stretch it happened in.
  const stretches: { agent: string; spans: EngineSpan[] }[] = []
  const rest: EngineSpan[] = []
  for (const s of ordered) {
    if (isWork(s) || isTool(s)) {
      const agent = str(s.attrs, 'agent') || stretches[stretches.length - 1]?.agent || ''
      if (!agent) continue
      const cur = stretches[stretches.length - 1]
      if (cur && cur.agent === agent) cur.spans.push(s)
      else stretches.push({ agent, spans: [s] })
    } else {
      rest.push(s)
    }
  }
  const lines: RunLine[] = stretches.map((st, i) =>
    stretchLine(`${st.agent}-${i}`, st.agent, st.spans, live, stretches[i + 1]?.agent ?? ''),
  )

  // The deterministic checks, then the reviewer — in the words of what ran.
  const t1 = rest.filter((s) => s.name === 'tier1' && !isOpen(s)).pop()
  if (t1) {
    const skipped = t1.attrs?.skipped === true
    const passed = t1.attrs?.passed === true
    lines.push({
      key: 'checks',
      who: 'Checks',
      ai: '',
      local: false,
      text: skipped ? 'nothing to check on this run' : passed ? 'your checks passed' : 'your checks failed',
      tone: skipped || passed ? 'plain' : 'warn',
      chips: [],
    })
  }
  const t2 = rest.filter((s) => s.name === 'tier2' && !isOpen(s)).pop()
  if (t2) {
    const judge = rest.filter((s) => s.name === 'eval' && isCall(s)).pop()
    const score = typeof t2.attrs?.score === 'number' ? (t2.attrs.score as number).toFixed(2) : ''
    const passed = t2.attrs?.passed === true
    lines.push({
      key: 'review',
      who: 'Review',
      ai: aiOf(judge?.attrs),
      local: str(judge?.attrs, 'provider') === 'local',
      text: `${score ? `scored ${score} — ` : ''}${passed ? 'passed' : 'did not pass'}`,
      tone: passed ? 'plain' : 'warn',
      chips: [],
    })
  }

  // What the run did with the user's notes — once, for the whole room.
  const vault = ordered.filter((s) => isTool(s) && str(s.attrs, 'provider') === 'vault')
  const withheld = ordered.filter((s) => isTool(s) && s.attrs?.withheld === true).length
  const readHere = vault.filter((s) => s.attrs?.withheld !== true && s.attrs?.blocked !== true && s.status !== 'error').length
  if (readHere > 0 || withheld > 0) {
    const parts: string[] = []
    if (readHere > 0) parts.push(`${plural(readHere, 'note')} read on this Mac`)
    if (withheld > 0) parts.push(`${plural(withheld, 'result')} withheld from the cloud`)
    lines.push({ key: 'privacy', who: 'Privacy', ai: 'this room', local: true, text: parts.join(' · '), tone: 'plain', chips: [] })
  }
  return lines
}

export type SeatTurn = Extract<ChatMessage, { kind: 'seat' }>

const TURN_LEAD = 140

/** A seat's recorded turn (from the saved board), as one line: who, on which
 *  AI, and the first thing it wrote. The whole turn opens from the line. */
export function turnLine(turn: SeatTurn): RunLine {
  // The first two lines that say something; a heading's marks are not words.
  const said = turn.text
    .split('\n')
    .map((l) => l.replace(/^\s*(#{1,6}|[-*>]|\d+\.)\s+/, '').replace(/[*_`]/g, '').trim())
    .filter(Boolean)
  const lead = said.slice(0, 2).join(' — ')
  const text = lead.length > TURN_LEAD ? `${lead.slice(0, TURN_LEAD).trimEnd()}…` : lead
  return {
    key: turn.id,
    who: seatLabel(turn.agent),
    ai: [turn.provider, turn.model].filter(Boolean).join(' · '),
    local: turn.provider === 'local',
    text,
    tone: 'plain',
    chips: [],
  }
}

export interface OutcomeView {
  tone: 'passed' | 'replied' | 'attention' | 'failed'
  /** '✓ routed → verified → written', and its honest lesser forms. */
  head: string
  chips: LineChip[]
  /** What it cost: cloud dollars and tokens. */
  cost: string
  /** The engine's own sentence for why, when it wrote one. */
  why?: string
  /** A file the result names (a team run's saved board). */
  path?: string
}

function kTokens(n: number): string {
  if (n < 1000) return `${n} tokens`
  const k = n / 1000
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k tokens`
}

/** A run's Verdict, as the one strip that closes it in the chat. */
export function verdictOutcome(v: Verdict): OutcomeView {
  const t = verdictTone(v)
  const tone: OutcomeView['tone'] =
    t === 'passed' ? 'passed' : t === 'replied' ? 'replied' : t === 'attention' ? 'attention' : 'failed'
  const head =
    tone === 'passed'
      ? v.writeback.committed
        ? '✓ routed → verified → written'
        : '✓ routed → verified'
      : tone === 'replied'
        ? '✓ routed → answered'
        : tone === 'attention'
          ? '⚠ needs a look'
          : '✕ did not pass'
  const chips: LineChip[] = []
  // Tier 1 FIRST, and a gate that did not run is never drawn as a pass.
  if (v.tier1.skipped) chips.push({ text: 'checks: nothing to run', kind: 'plain' })
  else chips.push({ text: `checks: ${v.tier1.tests} tests passed`, kind: v.tier1.pass ? 'plain' : 'warn' })
  // Tier 2 only ran when Tier 1 passed; a failed run's review never happened.
  if (tone !== 'failed' && tone !== 'replied') {
    chips.push({ text: `review: ${v.tier2.evalScore.toFixed(2)}`, kind: v.tier2.passed ? 'plain' : 'warn' })
  }
  if (v.route.target === 'local') chips.push({ text: 'stayed local', kind: 'local' })
  if (v.hooks.blocked > 0) chips.push({ text: `${v.hooks.blocked} blocked by your rules`, kind: 'warn' })
  const dollars = v.cost > 0 ? `$${v.cost.toFixed(2)}` : '$0'
  return {
    tone,
    head,
    chips,
    cost: `${dollars} cloud · ${kTokens(v.tokensIn + v.tokensOut)}`,
    ...(v.outcomeReason ? { why: v.outcomeReason } : {}),
  }
}

/**
 * The reviewer's raw line, read apart. The engine writes
 * "[llm-judge] <sentence> | score=0.51 vs threshold=0.7 -> BELOW | envelope ok";
 * the sentence is the reason, and the score with its bar is a figure. A reason
 * that is already a plain sentence comes back untouched.
 */
function judgeLine(raw: string): { why: string; score?: number; bar?: number } {
  const m = /^(?:\[[\w-]+\]\s*)?(.*?)\s*\|\s*score=([\d.]+) vs threshold=([\d.]+)\s*(?:->|→)\s*\w+(?:\s*\|\s*envelope [\w ]+)?\s*$/s.exec(raw)
  if (!m) return { why: raw }
  return { why: m[1].trim(), score: Number(m[2]), bar: Number(m[3]) }
}

/**
 * A team run's result, read back from the line the app itself wrote for it
 * (`teamNoticeText`: "team run passed · 7,024/100,000 tok · board saved: …").
 * `turns` are the seat turns recorded just before it — the local share is
 * counted from them. Any other notice is not a team outcome: null.
 */
export function teamOutcome(text: string, turns: readonly SeatTurn[]): OutcomeView | null {
  const m = /^team run (passed|did not pass)(?: — (.*?))? · ([\d,]+)\/([\d,]+) tok( \(over budget\))?(?: · board saved: (.+))?$/s.exec(
    text.trim(),
  )
  if (!m) return null
  const passed = m[1] === 'passed'
  const chips: LineChip[] = []
  if (turns.length > 0) {
    const local = turns.filter((t) => t.provider === 'local').length
    chips.push({ text: `${local} of ${plural(turns.length, 'turn')} local`, kind: local > 0 ? 'local' : 'plain' })
  }
  const judge = m[2] ? judgeLine(m[2]) : undefined
  if (judge && judge.score !== undefined && judge.bar !== undefined) {
    chips.push({ text: `review: ${judge.score.toFixed(2)} — needs ${judge.bar.toFixed(2)}`, kind: 'warn' })
  }
  if (m[5]) chips.push({ text: 'over budget', kind: 'warn' })
  return {
    tone: passed ? 'passed' : 'failed',
    head: passed ? '✓ routed → verified → written' : '✕ did not pass',
    chips,
    cost: `${m[3]} of ${m[4]} tokens`,
    ...(judge?.why ? { why: judge.why } : {}),
    ...(m[6] ? { path: m[6].trim() } : {}),
  }
}
