// A vault note's YAML frontmatter is metadata, not prose: split it off so a
// preview can show it as facts above the body instead of pouring it into the
// first paragraph. Display-only and deliberately shallow — `key: value` lines
// of a leading `---` block. An unterminated block is NOT frontmatter: nothing
// is hidden from the reader on a guess.

export interface SplitNote {
  /** The block's `key: value` pairs, in order. */
  meta: [string, string][]
  /** The note without its frontmatter (unchanged when it has none). */
  body: string
}

export function splitFrontmatter(md: string): SplitNote {
  if (!md.startsWith('---\n') && !md.startsWith('---\r\n')) return { meta: [], body: md }
  const lines = md.split('\n')
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (close < 0) return { meta: [], body: md }
  const meta: [string, string][] = []
  for (const line of lines.slice(1, close)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trimEnd())
    if (m) meta.push([m[1], m[2]])
  }
  const body = lines.slice(close + 1).join('\n').replace(/^\n+/, '')
  return { meta, body }
}

/**
 * An inline YAML list value (`[a, b, c]`) as its items, or null when the value
 * is not one — then it is shown exactly as written. Display-only and shallow,
 * like the split above: no nesting, no multi-line lists.
 */
export function metaList(value: string): string[] | null {
  const v = value.trim()
  if (!v.startsWith('[') || !v.endsWith(']')) return null
  return v
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .filter((item) => item !== '')
}
