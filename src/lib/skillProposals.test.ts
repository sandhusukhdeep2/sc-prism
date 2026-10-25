import { describe, expect, it } from 'vitest'
import { proposeSkills, taskSignature } from './skillProposals'

// ---------------------------------------------------------------------------
// Sukhdeep, 2026-09-03: "System's supposed to create new skills also … how are
// we handling this?"
//
// It wasn't. `provenance: 'captured'` — "captured from a repeated workflow" —
// has existed as a LABEL since the store was written, with nothing anywhere
// that captures one.
//
// The obvious build is "ask the model to write skills". The evidence is against
// it: in a paired skills benchmark, self-generated skills produced negligible
// or negative gains while human-curated ones carried the entire improvement.
// A model writing its own playbooks writes plausible ones and then follows them
// off a cliff.
//
// So the NOTICING is deterministic — real repetition in the recorded run
// history — and the WRITING stays human. The app proposes; the user approves,
// edits or dismisses. Nothing is ever created without them.
// ---------------------------------------------------------------------------

const run = (task: string, passed = true) => ({ task, passed })

describe('taskSignature — what counts as "the same job again"', () => {
  it('ignores wording, ordering and case', () => {
    expect(taskSignature('Update the CHANGELOG for the release')).toBe(
      taskSignature('update changelog for THE release'),
    )
  })

  it('ignores dates, numbers and ids, which differ every time', () => {
    expect(taskSignature('deploy build 1841 to staging')).toBe(
      taskSignature('deploy build 2207 to staging'),
    )
  })

  it('does not collapse genuinely different jobs', () => {
    expect(taskSignature('write release notes')).not.toBe(taskSignature('fix the login bug'))
  })

  it('is empty for a task too short to mean anything', () => {
    expect(taskSignature('hi')).toBe('')
    expect(taskSignature('')).toBe('')
  })
})

describe('proposeSkills', () => {
  it('proposes nothing until a job has actually repeated enough', () => {
    expect(proposeSkills([run('write the release notes'), run('write the release notes')])).toEqual([])
  })

  it('proposes a skill for a job done three times', () => {
    const out = proposeSkills([
      run('write the release notes for v2'),
      run('write the release notes for v3'),
      run('write the release notes for v4'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].timesSeen).toBe(3)
    expect(out[0].name).toMatch(/release|notes/i)
  })

  it('carries the real examples, so the user can see WHY', () => {
    // A proposal with no evidence is a guess wearing a suggestion's clothes.
    const out = proposeSkills([
      run('deploy build 1 to staging'),
      run('deploy build 2 to staging'),
      run('deploy build 3 to staging'),
    ])
    expect(out[0].examples.length).toBeGreaterThanOrEqual(2)
    expect(out[0].examples[0]).toContain('deploy')
  })

  it('never proposes a skill for work that keeps FAILING', () => {
    // Capturing a procedure that does not work would teach the crew to repeat
    // a mistake faster.
    const out = proposeSkills([
      run('deploy to staging', false),
      run('deploy to staging', false),
      run('deploy to staging', false),
    ])
    expect(out).toEqual([])
  })

  it('never proposes one that duplicates a skill you already have', () => {
    const runs = [
      run('write the release notes for v2'),
      run('write the release notes for v3'),
      run('write the release notes for v4'),
    ]
    const out = proposeSkills(runs, { existing: ['write the release notes'] })
    expect(out).toEqual([])
  })

  it('never re-proposes something already dismissed', () => {
    const runs = [run('deploy to staging'), run('deploy to staging'), run('deploy to staging')]
    const sig = taskSignature('deploy to staging')
    expect(proposeSkills(runs, { dismissed: [sig] })).toEqual([])
  })

  it('ranks the most-repeated job first', () => {
    const out = proposeSkills([
      ...Array(3).fill(0).map(() => run('write the release notes')),
      ...Array(6).fill(0).map(() => run('run the database migration')),
    ])
    expect(out[0].timesSeen).toBe(6)
    expect(out[0].name).toMatch(/migration|database/i)
  })

  it('returns at most a few, so it never becomes a nag', () => {
    const runs = []
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 3; j++) runs.push(run(`distinct repeated job number ${i} alpha bravo`))
    }
    expect(proposeSkills(runs).length).toBeLessThanOrEqual(3)
  })
})
