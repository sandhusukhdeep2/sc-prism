/**
 * THE shared guard for model text that a human will read.
 *
 * A ```tool_call fence is PROTOCOL, not prose: it is how a model asks the
 * engine's tool loop to run something. On 2026-08-17 one reached the user's
 * chat verbatim —
 *
 *   The HTTPS fetcher hit a local issue, so I'll search for this instead.
 *   ```tool_call
 *   {"tool": "web_search", "arguments": {"query": "themeforest.net slashcreative"}}
 *   ```
 *
 * — rendered as if it were the assistant's answer. It was not an answer: the
 * model was mid-investigation and that request never ran.
 *
 * The engine now strips fences at the source (`toolloop.guard_answer`), so in
 * practice nothing should arrive here carrying one. This module is the client's
 * BACKSTOP and the reason a future path cannot quietly reintroduce the bug:
 * every surface that shows raw model text — the chat turn, the desk's finished-
 * run row, project/team answers, the manager report, the heartbeat beat line —
 * routes through `guardAnswerText`, and a test asserts each one does.
 *
 * Same discipline as the `[offline:` / `[rejected:` markers gated out of chat
 * content in `loop.py` and `projectRun.ts` — with one deliberate difference:
 * `[incomplete: …]` text is still SHOWN. It is real model work, just unfinished,
 * so hiding it would be its own dishonesty; the marker exists so the UI can
 * present it as an incomplete investigation rather than as an answer.
 *
 * Leaf module: imports nothing, so any layer (store, lib, component) can use it.
 */

/** Marker prefix the engine and this guard both write. Clients match on it. */
export const INCOMPLETE_PREFIX = '[incomplete:'

/** The fence opener, matched permissively — a fence the engine's parser would
 *  refuse to execute is still protocol noise that must not reach a user. */
const FENCE = '```tool_call'

/** Reason used when the CLIENT has to strip a fence, i.e. text reached a user-
 *  visible surface still carrying an unexecuted request. */
const CLIENT_REASON =
  'the reply still contained an unexecuted tool request, so this is what there was, not a finished answer.'

/** Whether `text` carries a tool_call fence in any form. */
export function hasToolCallFence(text: unknown): boolean {
  return typeof text === 'string' && text.includes(FENCE)
}

/** Whether `text` is already marked as an unfinished investigation. */
export function isIncompleteInvestigation(text: unknown): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(INCOMPLETE_PREFIX)
}

/**
 * The reason inside an `[incomplete: <reason>]` marker — the one honest line a
 * run row can show for an investigation that stopped short ('' when `text`
 * carries no marker). Trailing sentence punctuation is kept: the reason is a
 * sentence the engine wrote, not a label.
 */
export function incompleteReason(text: unknown): string {
  if (!isIncompleteInvestigation(text)) return ''
  const inner = (text as string).trimStart().slice(INCOMPLETE_PREFIX.length)
  const end = inner.indexOf(']')
  return (end === -1 ? inner : inner.slice(0, end)).trim()
}

/**
 * Remove every tool_call block from `text`.
 *
 * Each block runs from its ``` fence to the next ``` that closes it; a fence
 * with no closer owns the rest of the string (the model was cut off
 * mid-request, so nothing after the opener is answer text). Whitespace the
 * removal leaves behind is tidied. Text with no fence comes back unchanged.
 */
export function stripToolCallBlocks(text: string): string {
  if (!hasToolCallFence(text)) return text
  let out = text
  for (;;) {
    const start = out.indexOf(FENCE)
    if (start === -1) break
    const close = out.indexOf('```', start + FENCE.length)
    out = out.slice(0, start) + (close === -1 ? '' : out.slice(close + 3))
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Make `text` safe to show a human as an answer.
 *
 * No fence -> returned byte-identical (every normal reply). A fence -> stripped,
 * and what remains is marked `[incomplete: …]` so the surface can present it as
 * an unfinished investigation. Already-marked text is never marked twice.
 * Non-strings pass straight through so callers can guard a `string | undefined`
 * without type gymnastics.
 */
export function guardAnswerText<T>(text: T): T {
  if (typeof text !== 'string' || !hasToolCallFence(text)) return text
  const body = stripToolCallBlocks(text)
  if (isIncompleteInvestigation(body)) return body as unknown as T
  const head = `${INCOMPLETE_PREFIX} ${CLIENT_REASON}]`
  return (body ? `${head}\n\n${body}` : head) as unknown as T
}
