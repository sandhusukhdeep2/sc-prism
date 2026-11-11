import { describe, expect, it } from 'vitest'
import { normalizeOkfReport, okfGroups, whereLine } from './okfReport'

// The engine's validator (engine/scprism_engine/okf.py) reports each problem as
// {path, code, detail, level}. The page read `message`, which the engine never
// sends, so every row said "the validator returned no detail" (2026-11-11).
describe('normalizeOkfReport — the reason the engine gave is the reason shown', () => {
  it("reads the engine's `detail` as the message", () => {
    const r = normalizeOkfReport({
      ok: false,
      issues: [{ path: 'projects/a/plan.md', code: 'no-frontmatter', detail: 'no YAML frontmatter block', level: 'error' }],
      warnings: [{ path: 'notes/b.md', code: 'broken-link', detail: "unresolved cross-link 'c'", level: 'warning' }],
      doc_count: 2,
    })
    expect(r?.issues[0]).toEqual({ path: 'projects/a/plan.md', code: 'no-frontmatter', message: 'no YAML frontmatter block' })
    expect(r?.warnings[0].message).toBe("unresolved cross-link 'c'")
    expect(r?.doc_count).toBe(2)
  })

  it('keeps a `message` when one is sent, and tolerates missing lists', () => {
    const r = normalizeOkfReport({ ok: true, issues: [{ path: 'a.md', code: 'x', message: 'said so' }] })
    expect(r?.issues[0].message).toBe('said so')
    expect(r?.warnings).toEqual([])
    expect(r?.doc_count).toBe(0)
  })

  it('carries the count of project files that were counted and not checked', () => {
    expect(normalizeOkfReport({ ok: true, issues: [], warnings: [], doc_count: 45, work_products: 35 })?.workProducts).toBe(35)
    // An older engine sends none: zero, not undefined.
    expect(normalizeOkfReport({ ok: true, issues: [], warnings: [], doc_count: 3 })?.workProducts).toBe(0)
  })

  it('is null when the engine sent no verdict', () => {
    expect(normalizeOkfReport({ issues: [] })).toBeNull()
    expect(normalizeOkfReport(null)).toBeNull()
    expect(normalizeOkfReport('nope')).toBeNull()
  })
})

describe('okfGroups — problems by cause, largest first', () => {
  const issues = [
    { path: 'projects/a/plan.md', code: 'no-frontmatter', message: 'no YAML frontmatter block' },
    { path: 'projects/b/result.md', code: 'no-frontmatter', message: 'no YAML frontmatter block' },
    { path: 'reports/r1.md', code: 'no-frontmatter', message: 'no YAML frontmatter block' },
    { path: 'agents/planner.md', code: 'missing-type', message: "required frontmatter 'type' missing/empty" },
    { path: 'readme.md', code: 'empty-doc', message: 'concept has no body' },
  ]

  it('makes one group per cause with a sentence, a count and its files', () => {
    const g = okfGroups(issues)
    expect(g.map((x) => [x.code, x.count])).toEqual([
      ['no-frontmatter', 3],
      ['missing-type', 1],
      ['empty-doc', 1],
    ])
    expect(g[0].title).toBe('3 notes have no frontmatter block')
    expect(g[1].title).toBe('1 note has frontmatter without a type')
    expect(g[2].title).toBe('1 note has no body')
    expect(g[0].items.map((i) => i.path)).toEqual(['projects/a/plan.md', 'projects/b/result.md', 'reports/r1.md'])
  })

  it('says where they are, by top folder', () => {
    const g = okfGroups(issues)
    expect(g[0].where).toEqual([
      { folder: 'projects', count: 2 },
      { folder: 'reports', count: 1 },
    ])
    expect(whereLine(g[0])).toBe('projects 2 · reports 1')
    // A file at the top of the vault has no folder to name.
    expect(whereLine(g[2])).toBe('top level 1')
  })

  it('folds the long tail of folders into one count', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((f) => ({ path: `${f}/x.md`, code: 'empty-doc', message: 'concept has no body' }))
    expect(whereLine(okfGroups(many)[0], 3)).toBe('a 1 · b 1 · c 1 · 2 elsewhere')
  })

  it('shows a file\'s own reason only when it adds to the title', () => {
    // Every file in a known cause gave the same reason: the title already says it.
    expect(okfGroups(issues)[0].showReasons).toBe(false)
    // A link's reason names its target, so it is always shown — even a single one.
    const links = okfGroups([{ path: 'notes/a.md', code: 'broken-link', message: "unresolved cross-link 'x'" }])
    expect(links[0].title).toBe('1 link does not resolve')
    expect(links[0].showReasons).toBe(true)
    // A known cause whose files gave different reasons keeps each one.
    const mixed = okfGroups([
      { path: 'a.md', code: 'empty-doc', message: 'concept has no body' },
      { path: 'b.md', code: 'empty-doc', message: 'unreadable: permission denied' },
    ])
    expect(mixed[0].showReasons).toBe(true)
  })

  it('never invents a sentence for a cause it does not know', () => {
    const g = okfGroups([{ path: 'a.md', code: 'new-rule', message: 'something specific' }])
    expect(g[0].title).toBe('1 note: something specific')
    expect(okfGroups([{ path: 'a.md', code: 'new-rule', message: '' }])[0].title).toBe('1 note: new-rule')
  })
})
