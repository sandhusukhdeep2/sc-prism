// SC Prism — proposing a skill from work you have actually repeated.
//
// `provenance: 'captured'` — "captured from a repeated workflow" — existed as a
// LABEL from the day the store was written, with nothing anywhere that captured
// one. This is the missing half.
//
// WHY THE NOTICING IS DETERMINISTIC AND THE WRITING IS NOT
//
// The obvious build is to ask a model to write skills. The evidence is against
// it: in a paired skills benchmark, self-generated skills produced negligible
// or negative gains, while human-curated ones carried the entire improvement.
// A model writing its own playbooks writes plausible ones and then follows them
// off a cliff — and because a skill is injected into future prompts, a bad one
// compounds silently.
//
// So this module only ever NOTICES, from the recorded run history — a fact, not
// an opinion. It proposes; the user writes, edits or dismisses. Nothing is
// created without them. That keeps the active ingredient (human curation) and
// skips the failure mode.

/** Words too common to identify a job. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'at', 'by',
  'with', 'from', 'into', 'this', 'that', 'it', 'is', 'be', 'do', 'my', 'me',
  'please', 'can', 'you', 'we', 'i', 'our', 'then', 'new', 'up', 'out',
])

/**
 * A stable signature for "the same job again".
 *
 * Case, wording order and the parts that differ every time (dates, versions,
 * build numbers, ids) are all discarded — otherwise "deploy build 1841" and
 * "deploy build 2207" would never be recognised as the same recurring job,
 * which is precisely the case worth capturing.
 *
 * Returns '' for anything too short to mean something, so a stray "hi" can
 * never accumulate into a proposal.
 */
export function taskSignature(task: string): string {
  const words = (task || '')
    .toLowerCase()
    // Drop anything containing a digit: versions, build numbers, dates, ids.
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
  const unique = Array.from(new Set(words)).sort()
  return unique.length >= 2 ? unique.join(' ') : ''
}

export interface RunLike {
  task: string
  passed?: boolean
}

export interface SkillProposal {
  signature: string
  /** A human name, taken from the wording the user actually used. */
  name: string
  timesSeen: number
  /** Real tasks this was drawn from — the evidence, quoted. */
  examples: string[]
}

/** A job must recur this often before it is worth a procedure. */
const MIN_REPEATS = 3

/** Never more than a few at once: a proposal list that nags gets ignored. */
const MAX_PROPOSALS = 3

export function proposeSkills(
  runs: readonly RunLike[],
  opts: { existing?: readonly string[]; dismissed?: readonly string[] } = {},
): SkillProposal[] {
  const existing = new Set((opts.existing ?? []).map(taskSignature).filter(Boolean))
  const dismissed = new Set(opts.dismissed ?? [])

  const groups = new Map<string, { tasks: string[]; passes: number }>()
  for (const r of runs) {
    const sig = taskSignature(r.task)
    if (!sig) continue
    const g = groups.get(sig) ?? { tasks: [], passes: 0 }
    g.tasks.push(r.task)
    // `passed` absent is treated as a pass: older records predate the field,
    // and refusing to propose because of a missing flag would be a silent no.
    if (r.passed !== false) g.passes += 1
    groups.set(sig, g)
  }

  const out: SkillProposal[] = []
  for (const [signature, g] of groups) {
    if (g.tasks.length < MIN_REPEATS) continue
    if (existing.has(signature) || dismissed.has(signature)) continue
    // Never capture a procedure that does not work — that would only teach the
    // crew to repeat a mistake faster.
    if (g.passes < MIN_REPEATS) continue
    out.push({
      signature,
      name: nameFor(g.tasks),
      timesSeen: g.tasks.length,
      examples: g.tasks.slice(0, 3),
    })
  }

  out.sort((a, b) => b.timesSeen - a.timesSeen || a.name.localeCompare(b.name))
  return out.slice(0, MAX_PROPOSALS)
}

/** A readable name, taken from the shortest real wording the user used. */
function nameFor(tasks: readonly string[]): string {
  const shortest = [...tasks].sort((a, b) => a.length - b.length)[0] ?? ''
  return shortest.trim().replace(/\s+/g, ' ').slice(0, 60) || 'a repeated job'
}
