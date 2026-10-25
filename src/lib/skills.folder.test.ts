import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canUpgradeToFolder,
  skillFolderPath,
  upgradeSkillToFolder,
  type StoredSkill,
} from './skills'

// ---------------------------------------------------------------------------
// Agent Skills conformance, phase D — the explicit per-skill folder upgrade.
//
// The spec addresses a skill as a DIRECTORY whose name equals its `name`, so
// the flat `skills/<slug>.md` dialect can never be conformant. Both shapes are
// supported forever; the folder shape is reachable only by an explicit action
// on one skill at a time. There is deliberately NO sweep.
//
// The ordering below is the whole design, and it comes from an attack on the
// first draft: write → read-back verify → DELETE THE FLAT FILE → stamp
// sourcePath. Skipping the delete leaves both files on disk, where the engine's
// folder-wins rule hides the twin so nobody notices; Delete then targets the
// folder file, the flat one survives, and the next sync re-inserts the skill
// with its PRE-UPGRADE body. That resurrection is worse than never upgrading.
// ---------------------------------------------------------------------------

const native = vi.hoisted(() => ({
  writes: [] as { path: string; content: string }[],
  deletes: [] as string[],
  files: new Map<string, string>(),
  failWrite: false,
  failDelete: false,
  failAllDeletes: false,
  failReadBack: false,
}))

vi.mock('./nativeEngine', () => ({
  isNative: () => true,
  resolveVaultDir: async () => '/vault',
  writeVaultNote: async (_v: string, path: string, content: string) => {
    if (native.failWrite) return null
    native.writes.push({ path, content })
    native.files.set(path, content)
    return path
  },
  readVaultFile: async (_v: string, path: string) =>
    native.failReadBack ? null : (native.files.get(path) ?? null),
  deleteVaultFile: async (_v: string, path: string) => {
    // Fails only the FLAT path by default, so a rollback of the folder file
    // can still succeed — the realistic case. `failAllDeletes` models the
    // harsher one where even the rollback cannot run.
    if (native.failAllDeletes) return 'permission denied'
    if (native.failDelete && !path.endsWith('/SKILL.md')) return 'permission denied'
    native.deletes.push(path)
    native.files.delete(path)
    return null
  },
  listVaultTree: async () => [...native.files.keys()],
}))

const skill = (over: Partial<StoredSkill> = {}): StoredSkill => ({
  id: 's1',
  name: 'code-review',
  description: 'reviews diffs for correctness',
  whenToUse: 'any diff over 5 lines',
  provenance: 'vault',
  agents: [],
  portable: true,
  body: '# Procedure\n1. Read the diff.',
  usage: '',
  sourcePath: 'skills/code-review.md',
  ...over,
})

beforeEach(() => {
  native.writes = []
  native.deletes = []
  native.files = new Map([['skills/code-review.md', 'old flat content']])
  native.failWrite = false
  native.failDelete = false
  native.failAllDeletes = false
  native.failReadBack = false
})

describe('skillFolderPath', () => {
  it('is the conformant SKILL.md under a directory named for the skill', () => {
    expect(skillFolderPath(skill())).toBe('skills/code-review/SKILL.md')
  })
})

describe('canUpgradeToFolder', () => {
  it('allows a skill whose name is already its own slug', () => {
    expect(canUpgradeToFolder(skill({ name: 'code-review' }))).toBe(true)
  })

  it('REFUSES a skill whose name would have to change', () => {
    // The spec requires name === directory. Upgrading a skill called
    // "Deploy: Staging -> Prod" would rename it to deploy-staging-prod — and
    // the verdict→library join matches on the NAME STRING, so the rename
    // silently zeroes its usage stats and suppresses the underperforming →
    // AI-improve gate. Refuse rather than rename behind the user's back.
    expect(canUpgradeToFolder(skill({ name: 'Deploy: Staging -> Prod' }))).toBe(false)
    expect(canUpgradeToFolder(skill({ name: 'Code Review' }))).toBe(false)
  })

  it('refuses a skill already living in a folder', () => {
    expect(canUpgradeToFolder(skill({ sourcePath: 'skills/code-review/SKILL.md' }))).toBe(false)
  })
})

describe('upgradeSkillToFolder', () => {
  it('writes the folder SKILL.md and removes the flat original', async () => {
    const res = await upgradeSkillToFolder(skill())
    expect(res.ok).toBe(true)
    expect(native.writes.map((w) => w.path)).toContain('skills/code-review/SKILL.md')
    expect(native.deletes).toContain('skills/code-review.md')
    expect(native.files.has('skills/code-review.md')).toBe(false)
  })

  it('returns the new sourcePath so the caller can restamp the skill', async () => {
    const res = await upgradeSkillToFolder(skill())
    expect(res.sourcePath).toBe('skills/code-review/SKILL.md')
  })

  it('writes conformant frontmatter into the new file', async () => {
    await upgradeSkillToFolder(skill({ roles: ['reviewer'] }))
    const written = native.writes.find((w) => w.path === 'skills/code-review/SKILL.md')!
    expect(written.content).toContain('name: code-review')
    expect(written.content).toContain('metadata:')
    expect(written.content).toContain('scprism_roles: reviewer')
  })

  it('never clobbers an existing folder file', async () => {
    native.files.set('skills/code-review/SKILL.md', 'someone else wrote this')
    const res = await upgradeSkillToFolder(skill())
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/already exists/i)
    // and the flat original must survive an aborted upgrade
    expect(native.files.get('skills/code-review.md')).toBe('old flat content')
    expect(native.deletes).toHaveLength(0)
  })

  it('does not delete the flat file when the write fails', async () => {
    native.failWrite = true
    const res = await upgradeSkillToFolder(skill())
    expect(res.ok).toBe(false)
    expect(native.deletes).toHaveLength(0)
    expect(native.files.has('skills/code-review.md')).toBe(true)
  })

  it('does not delete the flat file when the read-back cannot confirm the write', async () => {
    native.failReadBack = true
    const res = await upgradeSkillToFolder(skill())
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/verify/i)
    expect(native.deletes).toHaveLength(0)
    expect(native.files.has('skills/code-review.md')).toBe(true)
  })

  it('rolls the folder file back when the flat delete fails', async () => {
    // If we cannot remove the flat twin, leaving the folder file behind is the
    // exact two-file state that resurrects the pre-upgrade body. Undo it and
    // report failure, so sourcePath keeps pointing at the flat file.
    native.failDelete = true
    const res = await upgradeSkillToFolder(skill())
    expect(res.ok).toBe(false)
    expect(res.sourcePath).toBeUndefined()
    expect(native.files.has('skills/code-review/SKILL.md')).toBe(false)
    expect(native.files.get('skills/code-review.md')).toBe('old flat content')
  })

  it('names the leftover file when even the rollback cannot run', async () => {
    // Nothing can be deleted at all. We cannot reach a clean state, so the one
    // useful thing is to say exactly which file the user must remove by hand —
    // never to report success, and never to stamp the new sourcePath.
    native.failAllDeletes = true
    const res = await upgradeSkillToFolder(skill())
    expect(res.ok).toBe(false)
    expect(res.sourcePath).toBeUndefined()
    expect(res.reason).toContain('skills/code-review.md')
    expect(res.reason).toContain('skills/code-review/SKILL.md')
  })

  it('refuses a skill that cannot be upgraded rather than renaming it', async () => {
    const res = await upgradeSkillToFolder(skill({ name: 'Deploy: Staging -> Prod' }))
    expect(res.ok).toBe(false)
    expect(native.writes).toHaveLength(0)
    expect(native.deletes).toHaveLength(0)
  })
})
