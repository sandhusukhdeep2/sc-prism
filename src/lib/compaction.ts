// SC Prism — chat compaction, PURE core (Phase 2 / P2-2).
//
// Splits an over-long thread into a "recent" tail (kept verbatim) and an
// "older" head (fodder for compaction), renders that head for a model prompt
// and a non-lossy vault archive, and builds the single divider message that
// replaces the older head in the thread. No model calls, no Date, no
// randomness, no I/O — the driver (P2-3) supplies `nowIso` and does the
// actual model call + vault write.

import type { ChatMessage } from '../store/AppStore'

// Most-recent messages always retained verbatim when a thread is compacted.
export const KEEP_RECENT = 6

// Split a thread for compaction: keep the last `keepRecent` verbatim; the
// head ("older") is what gets summarized away. A thread at or under the
// threshold has nothing to compact — `older` is [] and `recent` is the whole
// thread (the COMPACT_THREAD reducer treats an empty `older` as a no-op).
export function splitForCompaction(
  messages: ChatMessage[],
  keepRecent: number = KEEP_RECENT,
): { older: ChatMessage[]; recent: ChatMessage[] } {
  if (messages.length <= keepRecent) return { older: [], recent: messages }
  return {
    older: messages.slice(0, messages.length - keepRecent),
    recent: messages.slice(messages.length - keepRecent),
  }
}

// Convergence guard: is there anything worth compacting in `older`? False when
// `older` is empty OR consists solely of compaction summary dividers — because
// re-summarizing summaries gains nothing and, when the retained tail alone stays
// over the auto threshold, would re-fire the auto-compaction forever (a new
// divider id → new state.threads → re-fire). A normal compaction leaves
// `older = [divider]` next time, which this skips, so the loop cannot recur.
export function canCompact(older: ChatMessage[]): boolean {
  return older.length > 0 && !older.every((m) => m.kind === 'divider')
}

// A verdict's outcome as one word. THREE-valued, because two words cannot say
// what the engine measured: ATTENTION is the run whose deterministic Tier-1
// checks ran over real written files and PASSED while the Tier-2 LLM reviewer
// dissented. Compacting that to "FAIL" is how a summarised thread told the
// model — and the user — that work which builds and tests clean had failed.
// Verdicts written before the engine recorded `outcome` fall back to `passed`.
export function verdictLabel(v: { passed: boolean; outcome?: string }): string {
  if (v.outcome === 'attention') return 'ATTENTION'
  return v.passed ? 'PASS' : 'FAIL'
}

// Render one message as a plain "kind: text" line, used by the summary
// prompt, the archive markdown, and the deterministic structural summary.
// A verdict renders as its pass/fail outcome (not its full Verdict payload);
// every other kind renders its `text` verbatim.
export function renderMessageLine(m: ChatMessage): string {
  switch (m.kind) {
    case 'verdict':
      return `verdict ${m.verdict.taskId} ${verdictLabel(m.verdict)}`
    case 'user':
    case 'assistant':
    case 'error':
    case 'divider':
    case 'notice':
      return `${m.kind}: ${m.text}`
    case 'seat':
      return `${m.agent} (${m.provider}): ${m.text}`
    default: {
      const exhaustive: never = m
      return exhaustive
    }
  }
}

// Truncate a user ask for the structural summary — long asks would otherwise
// blow up the recap; 100 chars is enough to recognize the ask.
function truncateAsk(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// Deterministic fallback recap (no model) — used when a model summary call
// isn't available/fails. Structured so it's still useful without an LLM: a
// count, every user ask (truncated), and every verdict outcome.
export function structuralSummary(older: ChatMessage[]): string {
  const userMsgs = older.filter((m): m is ChatMessage & { kind: 'user' } => m.kind === 'user')
  const verdictMsgs = older.filter((m): m is ChatMessage & { kind: 'verdict' } => m.kind === 'verdict')

  const asks = userMsgs.length
    ? userMsgs.map((m) => `  • ${truncateAsk(m.text)}`).join('\n')
    : '  • (none)'
  const outcomes = verdictMsgs.length
    ? verdictMsgs.map((m) => `  • verdict ${m.verdict.taskId} ${verdictLabel(m.verdict)}`).join('\n')
    : '  • (none)'

  return (
    `Earlier context (${older.length} messages):\n` +
    `- You asked:\n${asks}` +
    `\n- Outcomes:\n${outcomes}`
  )
}

// The prompt asking a model to summarize `older` into Plan / Tasks done /
// Decisions bullets. Faithfulness is load-bearing here: this replaces the
// real transcript in context, so an invented fact would silently corrupt
// everything downstream.
export function summaryPromptFor(older: ChatMessage[]): string {
  const transcript = older.map((m) => renderMessageLine(m)).join('\n')
  return (
    'Summarize the earlier conversation below into three short bullet sections: ' +
    'Plan, Tasks done, Decisions.\n' +
    'Be faithful to the transcript — do not invent facts, tasks, or outcomes that ' +
    "are not present in it. Keep the summary compact.\n\n" +
    `Transcript:\n${transcript}`
  )
}

// The markdown block appended to the vault archive — non-lossy: it carries
// BOTH the (possibly lossy) summary and every older message's rendered line
// verbatim, so nothing is ever actually lost, only moved out of the live
// thread. `nowIso` is passed in by the caller (this module never reads the
// clock).
export function compactionArchiveMarkdown(
  threadKey: string,
  older: ChatMessage[],
  summary: string,
  nowIso: string,
): string {
  return (
    `## Compacted ${nowIso} — thread ${threadKey}\n\n` +
    `### Summary\n${summary}\n\n` +
    `### Full transcript (${older.length} messages)\n` +
    older.map((m) => `- ${renderMessageLine(m)}`).join('\n') +
    '\n'
  )
}

// The single message that REPLACES `older` in the thread — a divider
// carrying the recap so the conversation still reads coherently.
export function summaryMessage(id: string, summary: string): ChatMessage {
  return { id, kind: 'divider', text: `— compacted earlier context —\n${summary}` }
}

// Whether it's safe to DROP the older turns from the live thread after a compaction attempt.
// Native: only after a successful vault archive. Non-native (browser demo, no vault): allowed
// (the demo thread is ephemeral). This is the non-lossy guarantee in one place.
export function shouldDrop(archived: boolean, native: boolean): boolean {
  return native ? archived : true
}
