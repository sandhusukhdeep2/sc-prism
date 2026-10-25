// SC Prism — pure chat-attachment composition (Slice A: files).
//
// A dropped-in text/code/doc file has to reach the AI as plain context so it
// works with ANY connected model — no multimodal wiring needed (that's Slice
// B, images). This module owns exactly that prepend logic: it takes no store
// singletons, no native bridge, no React — Workspace.tsx wires the picker +
// chips, this just shapes the string that gets sent.

/** One file attached to the composer: its display name + its UTF-8 text. */
export interface ChatAttachment {
  name: string
  text: string
}

/**
 * Prepend each attachment as a clearly-delimited block ahead of the user's
 * typed text, in attach order (first chip → first block). The combined
 * string then travels through the existing intent/`SCPRISM_CONTEXT` path
 * unchanged, so any connected model (cloud or local) can read it — it's just
 * text.
 *
 * No attachments → `text` returned unchanged (byte-identical, no trailing
 * whitespace added) so the non-attachment send path is untouched.
 */
export function composeWithAttachments(text: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return text
  const blocks = attachments
    .map((a) => `[Attached file: ${a.name}]\n${a.text}\n[end of file]\n\n`)
    .join('')
  return blocks + text
}

/**
 * The COMPACT form for the visible chat transcript and the persisted vault
 * chat-log — the counterpart to `composeWithAttachments` (which is what the
 * ENGINE/AI sees). Never includes the raw file body: each attachment becomes
 * a short `📎 <name> (<N> chars)` reference so a 50 KB file shows as one line
 * in the user's bubble instead of a wall of text saved forever. Refs are
 * joined with ` · ` on a single line (the `.msg--user` bubble and the
 * markdown log both collapse newlines, so a single line stays compact), then
 * the user's typed text follows. No attachments → `text` unchanged.
 */
export function displayLine(attachments: ChatAttachment[], text: string): string {
  if (attachments.length === 0) return text
  const refs = attachments.map((a) => `📎 ${a.name} (${a.text.length} chars)`).join(' · ')
  return text ? `${refs}\n${text}` : refs
}
