// The vault validator's report, as the page reads it.
//
// The engine (engine/scprism_engine/okf.py) reports each problem as
// {path, code, detail, level}. Until 2026-11-11 the client read `message`,
// which the engine never sends, so the Memory page said "the validator
// returned no detail" 81 times over a report that held every reason.
// `normalizeOkfReport` reads what is sent; `okfGroups` turns a long list of
// files into a short list of causes, each with a count and where it sits.

export interface OkfIssue {
  path: string
  code: string
  message: string
}

export interface OkfReport {
  ok: boolean
  issues: OkfIssue[]
  warnings: OkfIssue[]
  doc_count: number
}

function issueList(raw: unknown): OkfIssue[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .map((i) => ({
      path: String(i.path ?? ''),
      code: String(i.code ?? ''),
      message: String(i.message ?? i.detail ?? ''),
    }))
}

/** The engine's JSON as a report, or null when it carries no verdict. */
export function normalizeOkfReport(raw: unknown): OkfReport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.ok !== 'boolean') return null
  return {
    ok: r.ok,
    issues: issueList(r.issues),
    warnings: issueList(r.warnings),
    doc_count: typeof r.doc_count === 'number' ? r.doc_count : 0,
  }
}

export interface OkfGroup {
  code: string
  /** The cause as a sentence with its count: "3 notes have no frontmatter block". */
  title: string
  count: number
  /** Top folders holding the problem, largest first. */
  where: { folder: string; count: number }[]
  items: { path: string; message: string }[]
  /** A file's own reason adds to the title: the cause is not a fixed one (a
   * link names its target), or the files gave different reasons. */
  showReasons: boolean
}

// What each validator code means, as the predicate of "<n> note(s) …".
// [singular, plural]; a code that is not here is shown by its own message.
const NOTE_CAUSES: Record<string, [string, string]> = {
  'no-frontmatter': ['has no frontmatter block', 'have no frontmatter block'],
  'missing-type': ['has frontmatter without a type', 'have frontmatter without a type'],
  'empty-doc': ['has no body', 'have no body'],
  'log-not-iso': ['is a log with no dated entries', 'are logs with no dated entries'],
}

function titleFor(code: string, count: number, firstMessage: string): string {
  const one = count === 1
  if (code === 'broken-link') return `${count} ${one ? 'link does' : 'links do'} not resolve`
  if (code === 'not-a-directory') return 'The vault folder was not found'
  if (code === 'empty-bundle') return 'The vault has no notes'
  const cause = NOTE_CAUSES[code]
  const noun = one ? 'note' : 'notes'
  if (cause) return `${count} ${noun} ${one ? cause[0] : cause[1]}`
  return `${count} ${noun}: ${firstMessage || code}`
}

/** Problems grouped by cause, the most common first (ties keep report order). */
export function okfGroups(issues: readonly OkfIssue[]): OkfGroup[] {
  const order: string[] = []
  const byCode = new Map<string, OkfIssue[]>()
  for (const i of issues) {
    if (!byCode.has(i.code)) {
      byCode.set(i.code, [])
      order.push(i.code)
    }
    byCode.get(i.code)!.push(i)
  }
  const groups = order.map((code) => {
    const list = byCode.get(code)!
    const folders = new Map<string, number>()
    for (const i of list) {
      const cut = i.path.indexOf('/')
      const folder = cut > 0 ? i.path.slice(0, cut) : 'top level'
      folders.set(folder, (folders.get(folder) ?? 0) + 1)
    }
    const where = [...folders.entries()]
      .map(([folder, count]) => ({ folder, count }))
      .sort((a, b) => b.count - a.count)
    return {
      code,
      title: titleFor(code, list.length, list[0].message),
      count: list.length,
      where,
      items: list.map((i) => ({ path: i.path, message: i.message })),
      showReasons: !(code in NOTE_CAUSES) || list.some((i) => i.message !== list[0].message),
    }
  })
  return groups.sort((a, b) => b.count - a.count)
}

/** "projects 30 · reports 4 · 2 elsewhere" — where a cause sits, in one line. */
export function whereLine(group: Pick<OkfGroup, 'where'>, max = 3): string {
  const shown = group.where.slice(0, max).map((w) => `${w.folder} ${w.count}`)
  const rest = group.where.slice(max).reduce((n, w) => n + w.count, 0)
  if (rest > 0) shown.push(`${rest} elsewhere`)
  return shown.join(' · ')
}
