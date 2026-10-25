import { describe, expect, it, vi } from 'vitest'
import {
  isVaultSkillFile,
  mergeVaultSkill,
  parseVaultSkill,
  persistSkillToVault,
  removeSkillFromVault,
  serializeSkillMd,
  skillSlug,
  skillVaultPath,
  skillWritePath,
  type NewSkillInput,
  type StoredSkill,
} from './skills'

describe('parseVaultSkill', () => {
  it('prefers frontmatter name/description/when_to_use', () => {
    const raw = `---
name: release-checklist
description: walks a release out the door
when-to-use: cutting any release
---
# Procedure
1. Tag.
`
    const s = parseVaultSkill('skills/release.md', raw)
    expect(s.name).toBe('release-checklist')
    expect(s.description).toBe('walks a release out the door')
    expect(s.whenToUse).toBe('cutting any release')
    expect(s.provenance).toBe('vault')
    expect(s.body).not.toContain('---') // frontmatter stripped
  })

  it('falls back to the first heading and paragraph', () => {
    const raw = `# vault-linter

Checks notes for broken links.

1. Scan.
`
    const s = parseVaultSkill('skills/lint.md', raw)
    expect(s.name).toBe('vault-linter')
    expect(s.description).toBe('Checks notes for broken links.')
  })

  it('falls back to the filename, skipping skills/ and SKILL segments', () => {
    const s = parseVaultSkill('projects/deploy/SKILL.md', '1. Just steps.')
    expect(s.name).toBe('deploy')
    const s2 = parseVaultSkill('skills/triage.md', '1. Steps only.')
    expect(s2.name).toBe('triage')
  })
})

// P3-3: the client mirrors the engine's `roles:`/`agents:` frontmatter parsing
// (engine/scprism_engine/skills.py's `_split_roles`, ~L165) so a skill authored
// or edited in the UI round-trips identically on the engine side. No
// roles/agents key ⇒ `roles` stays undefined ⇒ the skill renders as GLOBAL,
// byte-identical to a pre-P3-3 skill (back-compat).
describe('parseVaultSkill roles (P3-3: per-role skill disclosure surfaced client-side)', () => {
  it('parses a `roles:` frontmatter list, comma-separated', () => {
    const raw = `---
name: plan-sprint
roles: planner, developer
---
# Procedure
1. Plan.
`
    const s = parseVaultSkill('skills/plan.md', raw)
    expect(s.roles).toEqual(['planner', 'developer'])
  })

  it('parses a `roles:` frontmatter list, whitespace-separated', () => {
    const raw = `---
name: plan-sprint
roles: planner developer
---
# Procedure
1. Plan.
`
    const s = parseVaultSkill('skills/plan.md', raw)
    expect(s.roles).toEqual(['planner', 'developer'])
  })

  it('accepts `agents:` as an alias for `roles:` (mirrors the engine loader)', () => {
    const raw = `---
name: plan-sprint
agents: planner, developer
---
# Procedure
1. Plan.
`
    const s = parseVaultSkill('skills/plan.md', raw)
    expect(s.roles).toEqual(['planner', 'developer'])
  })

  it('omits roles entirely when absent — back-compat, renders as global', () => {
    const s = parseVaultSkill('skills/plain.md', '# plain\nno roles here.\n')
    expect(s.roles).toBeUndefined()
  })

  it('omits roles when the frontmatter has no roles/agents key at all', () => {
    const raw = `---
name: release-checklist
description: walks a release out the door
---
# Procedure
1. Tag.
`
    const s = parseVaultSkill('skills/release.md', raw)
    expect(s.roles).toBeUndefined()
  })
})

describe('skillSlug', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(skillSlug('Release Checklist')).toBe('release-checklist')
  })

  it('collapses punctuation runs and trims leading/trailing junk', () => {
    expect(skillSlug('  --Release, Checklist!! v2.0--  ')).toBe('release-checklist-v2-0')
    expect(skillSlug('!!!Multi Word!!!')).toBe('multi-word')
    expect(skillSlug('___leading_and_trailing___')).toBe('leading-and-trailing')
  })

  it('treats unicode/non-ascii characters as punctuation (ascii-only slug)', () => {
    expect(skillSlug('Café Déjà-vu')).toBe('caf-d-j-vu')
  })

  it('all-punctuation names fall back to a deterministic hash slug — never the empty string', () => {
    const a = skillSlug('!!!')
    const b = skillSlug('###')
    expect(a).toMatch(/^skill-[0-9a-f]+$/)
    expect(b).toMatch(/^skill-[0-9a-f]+$/)
    expect(a).not.toBe(b) // distinct punctuation names must not collide
    expect(skillSlug('!!!')).toBe(a) // same input → same slug (stable)
  })

  it('whitespace-only input also gets the hash fallback', () => {
    expect(skillSlug('   ')).toMatch(/^skill-[0-9a-f]+$/)
  })

  it('the hash fallback never changes normal names', () => {
    expect(skillSlug('Release Checklist')).toBe('release-checklist')
    expect(skillSlug('a')).toBe('a')
  })
})

describe('skillVaultPath', () => {
  it('nests the slug under skills/ with a .md extension', () => {
    expect(skillVaultPath('Release Checklist')).toBe('skills/release-checklist.md')
  })

  it('all-punctuation names get distinct stable paths — never "skills/.md"', () => {
    const a = skillVaultPath('!!!')
    const b = skillVaultPath('###')
    expect(a).not.toBe('skills/.md')
    expect(b).not.toBe('skills/.md')
    expect(a).not.toBe(b)
    expect(skillVaultPath('!!!')).toBe(a)
  })
})

describe('serializeSkillMd', () => {
  const skill = {
    name: 'release-checklist',
    description: 'walks a release out the door',
    whenToUse: 'cutting any release',
    body: '# Procedure\n\n1. Tag.\n2. Ship.',
  }

  it('emits the Agent-Skills conformant frontmatter format', () => {
    // Changed 2026-08-31 adopting the open Agent Skills standard. Top-level
    // keys are exactly the spec's two required fields plus its sanctioned
    // `metadata` escape hatch; `when_to_use` moved inside it. Both parsers
    // flatten an indented child back to a top-level key, so nothing that read
    // this file before stops reading it now.
    const md = serializeSkillMd(skill)
    expect(md).toBe(
      '---\nname: release-checklist\ndescription: walks a release out the door\n' +
        'metadata:\n  when_to_use: cutting any release\n---\n\n# Procedure\n\n1. Tag.\n2. Ship.\n',
    )
  })

  it('sanitizes newlines in name/description/whenToUse to single spaces', () => {
    const md = serializeSkillMd({
      name: 'multi\nline\nname',
      description: 'first line\nsecond line',
      whenToUse: 'when a\nmulti-line\ntrigger fires',
      body: 'body text',
    })
    expect(md).toContain('scprism_display_name: multi line name\n')
    expect(md).toContain('description: first line second line\n')
    expect(md).toContain('  when_to_use: when a multi-line trigger fires\n')
    // exactly one frontmatter block — sanitization must not introduce a stray '---' line
    expect(md.match(/^---$/gm)?.length).toBe(2)
  })

  it('round-trips through the real parseVaultSkill: name/description/whenToUse/body survive', () => {
    const parsed = parseVaultSkill(skillVaultPath(skill.name), serializeSkillMd(skill))
    expect(parsed.name).toBe(skill.name)
    expect(parsed.description).toBe(skill.description)
    expect(parsed.whenToUse).toBe(skill.whenToUse)
    expect(parsed.body).toBe(skill.body)
  })

  it('round-trips a skill with punctuation in the name (used to build its own vault path)', () => {
    const punctuated = {
      name: 'Deploy: Staging -> Prod!!',
      description: 'promotes staging to prod',
      whenToUse: 'staging is green',
      body: '1. Verify.\n2. Promote.',
    }
    const parsed = parseVaultSkill(skillVaultPath(punctuated.name), serializeSkillMd(punctuated))
    expect(parsed.name).toBe(punctuated.name)
    expect(parsed.description).toBe(punctuated.description)
    expect(parsed.whenToUse).toBe(punctuated.whenToUse)
    expect(parsed.body).toBe(punctuated.body)
  })

  it('never emits an empty frontmatter value — empty fields get stable defaults', () => {
    const md = serializeSkillMd({
      name: '',
      description: '   ',
      whenToUse: '\n',
      body: 'First body paragraph.\n\nSecond.',
    })
    expect(md).toContain('name: untitled-skill\n')
    expect(md).toContain('description: a saved skill\n')
    expect(md).toContain('  when_to_use: when the procedure matches the task\n')
    // No key with an empty value — and `metadata:` specifically is never
    // emitted childless, since an empty block parses as null and crashes a
    // conformant consumer's .items().
    // No key with an empty value. `metadata:` is exempt — it is a block
    // header, and the following assertion proves it always has a child.
    expect(md.replace(/^metadata:$/m, '')).not.toMatch(/^[a-z_]+: *$/m)
    expect(md).toMatch(/metadata:\n {2}\w/)
  })

  it('empty description never gets contaminated by the body on round-trip', () => {
    const skill = {
      name: 'body-leak-check',
      description: '',
      whenToUse: '',
      body: 'This paragraph must NOT become the description.\n\n1. Step.',
    }
    const parsed = parseVaultSkill(skillVaultPath(skill.name), serializeSkillMd(skill))
    expect(parsed.description).toBe('a saved skill')
    expect(parsed.whenToUse).toBe('when the procedure matches the task')
    expect(parsed.body).toBe(skill.body)
  })

  it('round-trip is a fixed point: re-serializing the parse result parses identically', () => {
    const skill = {
      name: 'fixed-point',
      description: '',
      whenToUse: '  ',
      body: 'Body paragraph.\n\n1. Step.',
    }
    const once = parseVaultSkill(skillVaultPath(skill.name), serializeSkillMd(skill))
    const twice = parseVaultSkill(
      skillVaultPath(once.name),
      serializeSkillMd({
        name: once.name,
        description: once.description ?? '',
        whenToUse: once.whenToUse ?? '',
        body: once.body ?? '',
      }),
    )
    expect(twice).toEqual(once)
  })
})

describe('skillWritePath', () => {
  // The delete/persist target for a skill's durable vault copy. Vault-
  // discovered skills can live at ANY `skills/*.md` filename or a nested
  // `**/SKILL.md` — deleting/writing at the canonical name-slug path when the
  // real file lives elsewhere silently resurrects deleted skills on the next
  // sync (the review defect). sourcePath, when recorded, must win.
  it('targets the recorded sourcePath when present', () => {
    expect(
      skillWritePath({ name: 'Release Checklist', sourcePath: 'projects/deploy/SKILL.md' }),
    ).toBe('projects/deploy/SKILL.md')
    expect(skillWritePath({ name: 'deploy', sourcePath: 'skills/my-oddly-named-file.md' })).toBe(
      'skills/my-oddly-named-file.md',
    )
  })

  it('falls back to the canonical slug path when sourcePath is absent or empty', () => {
    expect(skillWritePath({ name: 'Release Checklist' })).toBe('skills/release-checklist.md')
    expect(skillWritePath({ name: 'Release Checklist', sourcePath: undefined })).toBe(
      'skills/release-checklist.md',
    )
    expect(skillWritePath({ name: 'Release Checklist', sourcePath: '' })).toBe(
      'skills/release-checklist.md',
    )
  })
})

describe('isSkill back-compat — sourcePath is optional', () => {
  const base = {
    name: 'legacy',
    description: 'd',
    whenToUse: 'w',
    provenance: 'hand-written',
    agents: [],
    portable: true,
    body: 'b',
    usage: '',
  }

  it('loads persisted arrays without sourcePath, and preserves sourcePath through load/persist', async () => {
    // A fresh module instance re-runs load() against the seeded localStorage.
    vi.resetModules()
    localStorage.setItem(
      'scprism.skills',
      JSON.stringify([
        { ...base, id: 'skill-legacy' },
        {
          ...base,
          id: 'skill-vaultish',
          name: 'vaultish',
          provenance: 'vault',
          sourcePath: 'projects/deploy/SKILL.md',
        },
      ]),
    )
    try {
      const mod = await import('./skills')
      const loaded = mod.list()
      // Both entries valid (no fallback to the seed catalog): the legacy
      // entry without sourcePath must NOT be rejected by the guard.
      expect(loaded.map((s) => s.name)).toEqual(['legacy', 'vaultish'])
      expect(loaded[0].sourcePath).toBeUndefined()
      expect(loaded[1].sourcePath).toBe('projects/deploy/SKILL.md')

      // A mutation re-persists the whole array — sourcePath must survive.
      mod.update('skill-vaultish', { description: 'd2' })
      const raw = JSON.parse(localStorage.getItem('scprism.skills') ?? '[]') as {
        id: string
        sourcePath?: string
      }[]
      expect(raw.find((s) => s.id === 'skill-vaultish')?.sourcePath).toBe(
        'projects/deploy/SKILL.md',
      )
    } finally {
      localStorage.removeItem('scprism.skills')
      vi.resetModules()
    }
  })

  it('rejects a non-string sourcePath (corrupt entry falls back to the seed catalog)', async () => {
    vi.resetModules()
    localStorage.setItem(
      'scprism.skills',
      JSON.stringify([{ ...base, id: 'skill-bad', sourcePath: 42 }]),
    )
    try {
      const mod = await import('./skills')
      // The corrupt array is discarded wholesale — load() re-seeds.
      expect(mod.list().some((s) => s.id === 'skill-bad')).toBe(false)
    } finally {
      localStorage.removeItem('scprism.skills')
      vi.resetModules()
    }
  })
})

describe('mergeVaultSkill — sourcePath/provenance gating on name collisions', () => {
  const parsed: NewSkillInput = {
    name: 'code-review',
    description: 'from the vault file',
    whenToUse: 'from the vault file',
    provenance: 'vault',
    body: 'vault body',
  }
  const rel = 'projects/foo/SKILL.md' // a non-canonical, unrelated path

  const base: Omit<StoredSkill, 'provenance'> = {
    id: 'skill-code-review',
    name: 'code-review',
    description: 'reviews diffs',
    whenToUse: 'any diff',
    agents: [],
    portable: true,
    body: 'local body',
    usage: '',
  }

  it('a name-colliding HAND-WRITTEN skill keeps its provenance AND does NOT adopt the vault path', () => {
    // The defect: an ordinary hand-written skill silently inherits an
    // unrelated vault file's path, which becomes a Delete target → data loss.
    const existing: StoredSkill = { ...base, provenance: 'hand-written' }
    const merged = mergeVaultSkill(existing, parsed, rel)
    expect(merged.provenance).toBe('hand-written')
    expect(merged.sourcePath).toBeUndefined() // NOT rel
  })

  it('a name-colliding SEED/imported skill with a prior sourcePath keeps its own path', () => {
    const existing: StoredSkill = {
      ...base,
      provenance: 'imported',
      sourcePath: 'skills/its-own-file.md',
    }
    const merged = mergeVaultSkill(existing, parsed, rel)
    expect(merged.provenance).toBe('imported')
    expect(merged.sourcePath).toBe('skills/its-own-file.md') // unchanged, not rel
  })

  it('a genuinely VAULT-owned skill adopts the discovered path (back-fills a pre-sourcePath entry)', () => {
    const existing: StoredSkill = { ...base, provenance: 'vault' } // no sourcePath yet
    const merged = mergeVaultSkill(existing, parsed, rel)
    expect(merged.provenance).toBe('vault')
    expect(merged.sourcePath).toBe(rel)
  })

  it('still merges the parsed content fields regardless of provenance', () => {
    const existing: StoredSkill = { ...base, provenance: 'hand-written' }
    const merged = mergeVaultSkill(existing, parsed, rel)
    expect(merged.description).toBe('from the vault file')
    expect(merged.whenToUse).toBe('from the vault file')
    expect(merged.body).toBe('vault body')
  })

  // P3-3: roles are vault-frontmatter content, gated the SAME way as
  // sourcePath/provenance above — a non-vault name collision must never
  // inherit an unrelated file's roles.
  it('a VAULT-owned skill adopts the resync\'s roles (vault content wins, including reverting to global)', () => {
    const existing: StoredSkill = { ...base, provenance: 'vault', roles: ['planner'] }
    const resynced: NewSkillInput = { ...parsed, roles: ['developer'] }
    const merged = mergeVaultSkill(existing, resynced, rel)
    expect(merged.roles).toEqual(['developer'])

    // the frontmatter later drops `roles:` entirely — resync honestly reverts to global
    const mergedGlobal = mergeVaultSkill(existing, parsed, rel)
    expect(mergedGlobal.roles).toBeUndefined()
  })

  it('a name-colliding HAND-WRITTEN skill keeps its own roles, never the vault file\'s', () => {
    const existing: StoredSkill = { ...base, provenance: 'hand-written', roles: ['reviewer'] }
    const resynced: NewSkillInput = { ...parsed, roles: ['developer'] }
    const merged = mergeVaultSkill(existing, resynced, rel)
    expect(merged.roles).toEqual(['reviewer'])
  })
})

describe('create — slug-collision vault-file clobber guard', () => {
  // Two DISTINCT library skills whose names differ only by punctuation/spacing
  // ("code-review" vs "Code Review") pass the name-dedupe yet both canonicalize
  // to skills/code-review.md. Without a guard, persisting the second overwrites
  // the first's durable vault file and removing either deletes the other's file
  // — silent loss of the portable copy. create() must hand a colliding new
  // skill a distinct sourcePath so their write paths never coincide.
  const seedSkill = (over: Partial<StoredSkill> & { id: string; name: string }): StoredSkill => ({
    description: 'd',
    whenToUse: 'w',
    provenance: 'hand-written',
    agents: [],
    portable: true,
    body: 'b',
    usage: '',
    ...over,
  })

  it('two names differing only by punctuation get distinct write paths; the first is unchanged', async () => {
    vi.resetModules()
    localStorage.setItem('scprism.skills', JSON.stringify([]))
    try {
      const mod = await import('./skills')
      const a = mod.create({ name: 'code-review', description: 'd', whenToUse: 'w' })
      const b = mod.create({ name: 'Code Review', description: 'd', whenToUse: 'w' })
      // distinct skills (name-dedupe did NOT collapse them)
      expect(a.id).not.toBe(b.id)
      // distinct durable targets — neither can clobber the other
      expect(mod.skillWritePath(a)).not.toBe(mod.skillWritePath(b))
      // the first keeps the canonical path (byte-identical to pre-guard behavior)
      expect(a.sourcePath).toBeUndefined()
      expect(mod.skillWritePath(a)).toBe('skills/code-review.md')
      // the second is disambiguated, never the canonical path
      expect(b.sourcePath).toBeDefined()
      expect(mod.skillWritePath(b)).not.toBe('skills/code-review.md')
    } finally {
      localStorage.removeItem('scprism.skills')
      vi.resetModules()
    }
  })

  it('a new local skill cannot overwrite an existing vault skill whose sourcePath is the canonical path', async () => {
    vi.resetModules()
    // An imported/vault skill "Meeting Notes" already lives at skills/notes.md.
    localStorage.setItem(
      'scprism.skills',
      JSON.stringify([
        seedSkill({
          id: 'skill-meeting-notes',
          name: 'Meeting Notes',
          provenance: 'vault',
          sourcePath: 'skills/notes.md',
        }),
      ]),
    )
    try {
      const mod = await import('./skills')
      const created = mod.create({ name: 'notes', description: 'd', whenToUse: 'w' })
      // "notes" canonicalizes to skills/notes.md — which the seeded skill owns.
      expect(created.sourcePath).toBeDefined()
      expect(mod.skillWritePath(created)).not.toBe('skills/notes.md')
    } finally {
      localStorage.removeItem('scprism.skills')
      vi.resetModules()
    }
  })

  it('a non-colliding create stays byte-identical to today — no sourcePath, canonical path', async () => {
    vi.resetModules()
    localStorage.setItem('scprism.skills', JSON.stringify([]))
    try {
      const mod = await import('./skills')
      const s = mod.create({ name: 'Deploy Runbook', description: 'd', whenToUse: 'w' })
      expect(s.sourcePath).toBeUndefined()
      expect(mod.skillWritePath(s)).toBe('skills/deploy-runbook.md')
    } finally {
      localStorage.removeItem('scprism.skills')
      vi.resetModules()
    }
  })
})

describe('persistSkillToVault / removeSkillFromVault — browser mode', () => {
  // jsdom has no __TAURI_INTERNALS__, so isNative() is false here — these
  // must resolve false without throwing, never reach resolveVaultDir/invoke.
  it('persistSkillToVault resolves false without throwing when not running natively', async () => {
    await expect(
      persistSkillToVault({
        name: 'a-skill',
        description: 'd',
        whenToUse: 'w',
        body: 'b',
      }),
    ).resolves.toBe(false)
  })

  it('removeSkillFromVault resolves false without throwing when not running natively', async () => {
    await expect(removeSkillFromVault({ name: 'a-skill' })).resolves.toBe(false)
  })

  it('both accept a sourcePath-carrying skill without throwing (browser no-op)', async () => {
    await expect(
      persistSkillToVault({
        name: 'a-skill',
        description: 'd',
        whenToUse: 'w',
        body: 'b',
        sourcePath: 'projects/deploy/SKILL.md',
      }),
    ).resolves.toBe(false)
    await expect(
      removeSkillFromVault({ name: 'a-skill', sourcePath: 'projects/deploy/SKILL.md' }),
    ).resolves.toBe(false)
  })
})


// ---------------------------------------------------------------------------
// Agent Skills conformance, phase A — the two guards that prevent real damage
// before any folder-shaped skill can exist on disk (design 2026-08-31).
// ---------------------------------------------------------------------------

describe('isVaultSkillFile — what counts as a skill file', () => {
  it('accepts a flat skill and a folder SKILL.md', () => {
    expect(isVaultSkillFile('skills/code-review.md')).toBe(true)
    expect(isVaultSkillFile('skills/code-review/SKILL.md')).toBe(true)
    expect(isVaultSkillFile('skills/code-review/skill.md')).toBe(true)
  })

  it('REFUSES files nested under a skill folder', () => {
    // The old filter was /^skills\/.+\.md$/i — `.+` crosses slashes, so a
    // reference doc became a `provenance: 'vault'` library skill. Its Delete
    // button then erased the real reference file, and an AI-improve Apply
    // overwrote it with model-written frontmatter. This must never match.
    expect(isVaultSkillFile('skills/code-review/references/api.md')).toBe(false)
    expect(isVaultSkillFile('skills/code-review/assets/template.md')).toBe(false)
    expect(isVaultSkillFile('skills/code-review/scripts/run.md')).toBe(false)
    expect(isVaultSkillFile('skills/a/b/c/SKILL.md')).toBe(false)
  })

  it('refuses anything outside skills/', () => {
    expect(isVaultSkillFile('agents/planner.md')).toBe(false)
    expect(isVaultSkillFile('notes/skills/x.md')).toBe(false)
    expect(isVaultSkillFile('skills/README.txt')).toBe(false)
  })
})

describe('skillSlug — capability words are not usable as skill names', () => {
  // `agentCapabilityNames` unions an agent's `skills` list into its capability
  // REQUEST (delegation.ts). In a folder-shaped ecosystem `skills/web/SKILL.md`
  // is an ordinary import — and importing it would hand that agent the `web`
  // capability by name alone. Refuse the six words outright.
  const CAPS = ['vault', 'web', 'computer', 'terminal', 'tools', 'writes']

  it('never returns a bare capability word', () => {
    for (const w of CAPS) {
      expect(skillSlug(w)).not.toBe(w)
      expect(skillSlug(w.toUpperCase())).not.toBe(w)
      expect(skillSlug(` ${w} `)).not.toBe(w)
    }
  })

  it('keeps the word recognisable rather than hashing it away', () => {
    expect(skillSlug('web')).toContain('web')
  })

  it('leaves names that merely CONTAIN a capability word alone', () => {
    expect(skillSlug('web-research')).toBe('web-research')
    expect(skillSlug('vault search')).toBe('vault-search')
  })
})

describe('parseVaultSkill — mirrors the engine parser exactly', () => {
  // engine/scprism_engine/skills.py says it "deliberately mirrors" this
  // function. Every rule added there lands here in the same commit, or a skill
  // authored in the UI parses differently at run time — the exact divergence
  // this whole migration exists to close.
  it('flattens metadata children to top level', () => {
    const s = parseVaultSkill(
      'skills/x/SKILL.md',
      '---\nname: code-review\ndescription: d\nmetadata:\n  when_to_use: any diff\n---\n# P\n',
    )
    expect(s.name).toBe('code-review')
    expect(s.whenToUse).toBe('any diff')
  })

  it('an indented line can never set a reserved key', () => {
    const s = parseVaultSkill(
      'skills/x/SKILL.md',
      '---\nname: real\ndescription: real desc\nmetadata:\n  name: HIJACKED\n  description: HIJACKED\n---\n# P\n',
    )
    expect(s.name).toBe('real')
    expect(s.description).toBe('real desc')
  })

  it('unquotes a matched surrounding quote pair', () => {
    const s = parseVaultSkill('skills/x.md', '---\nname: "code-review"\ndescription: \'d\'\n---\n# P\n')
    expect(s.name).toBe('code-review')
    expect(s.description).toBe('d')
  })

  it('reads scprism_roles as well as the legacy keys', () => {
    const s = parseVaultSkill(
      'skills/x.md',
      '---\nname: n\nmetadata:\n  scprism_roles: reviewer, planner\n---\n# P\n',
    )
    expect(s.roles?.sort()).toEqual(['planner', 'reviewer'])
  })
})
