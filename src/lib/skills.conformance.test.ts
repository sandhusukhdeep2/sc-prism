import { describe, expect, it } from 'vitest'
import { parseVaultSkill, serializeSkillMd } from './skills'

// ---------------------------------------------------------------------------
// Agent Skills conformance — the pin on what SC Prism WRITES.
//
// The spec's normative surface is small and entirely about the frontmatter:
//   name         required, 1-64 chars, lowercase alphanumerics and hyphens
//                only, no leading/trailing hyphen, no consecutive hyphens
//   description  required, 1-1024 chars
//   metadata     optional, a map of string keys to string values — the
//                spec-sanctioned escape hatch for properties it does not define
//
// Everything SC Prism needs beyond the two required keys therefore rides in
// `metadata`, and the top-level key set is exactly {name, description,
// metadata}. `allowed-tools` is READ leniently (that is how foreign skills
// reach us) and never WRITTEN — emitting our own capability words into an
// experimental spec field would be non-conformant in the other direction.
//
// This test lives in TypeScript because the writer does. A Python fixture
// would be exactly the hand-mirrored contract that has already silently
// diverged once. It deliberately takes no dependency on the reference
// validator, which self-describes as demonstration-only.
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** The frontmatter block, or '' when the emission is not even shaped right. */
function frontmatter(md: string): string {
  return /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? ''
}

/** Top-level (unindented) keys of an emitted frontmatter block. */
function topLevelKeys(md: string): string[] {
  return frontmatter(md)
    .split('\n')
    .filter((l) => l.trim() && !/^\s/.test(l))
    .map((l) => l.split(':')[0].trim())
}

/**
 * A deliberately small YAML reader — enough to prove the emission parses as a
 * mapping with string scalars and one nested string map, which is the whole
 * shape the spec permits. Throws on anything it cannot read, which is the
 * point: an unreadable block is a failed assertion.
 */
function parseYamlish(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let current: Record<string, string> | null = null
  for (const raw of block.split('\n')) {
    if (!raw.trim()) continue
    const indented = /^\s/.test(raw)
    const line = raw.trim()
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) throw new Error(`unreadable frontmatter line: ${raw}`)
    const [, key, rest] = m
    if (indented) {
      if (!current) throw new Error(`indented key with no parent: ${raw}`)
      current[key] = unquote(rest)
      continue
    }
    if (rest === '') {
      current = {}
      out[key] = current
    } else {
      out[key] = unquote(rest)
      current = null
    }
  }
  return out
}

function unquote(v: string): string {
  if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) {
    return v[0] === '"' ? v.slice(1, -1).replace(/\\"/g, '"') : v.slice(1, -1)
  }
  return v
}

const ADVERSARIAL = [
  {
    label: 'a description containing ": " — ordinary prose, illegal bare YAML',
    skill: {
      name: 'code-review',
      description: 'Reviews diffs: correctness and style. Use before Tier-2.',
      whenToUse: 'any diff over 5 lines',
      body: '# Procedure\n1. Read the diff.',
    },
  },
  {
    label: 'a value starting with a YAML indicator character',
    skill: {
      name: 'planner',
      description: '[draft] plans the work',
      whenToUse: '> when asked to plan',
      body: '# P',
    },
  },
  {
    label: 'a value containing a comment marker',
    skill: {
      name: 'tagger',
      description: 'tags issues #urgent and #later',
      whenToUse: 'triage',
      body: '# P',
    },
  },
  {
    label: 'an over-long name and description',
    skill: {
      name: 'a'.repeat(200),
      description: 'x'.repeat(2000),
      whenToUse: 'always',
      body: '# P',
    },
  },
  {
    label: 'unicode and mixed case',
    skill: {
      name: 'Café Review — Ünicode',
      description: 'Reviews café menus — naïvely.',
      whenToUse: 'menus',
      body: '# P',
    },
  },
  {
    label: 'a name that is only punctuation',
    skill: { name: '!!!', description: 'd', whenToUse: 'w', body: '# P' },
  },
]

describe('serializeSkillMd — emits spec-conformant frontmatter', () => {
  for (const { label, skill } of ADVERSARIAL) {
    describe(label, () => {
      const md = serializeSkillMd(skill)

      it('emits only the three permitted top-level keys', () => {
        expect(topLevelKeys(md).sort()).toEqual(['description', 'metadata', 'name'])
      })

      it('emits a spec-legal name', () => {
        const fm = parseYamlish(frontmatter(md))
        const name = String(fm.name)
        expect(name.length).toBeGreaterThan(0)
        expect(name.length).toBeLessThanOrEqual(64)
        expect(name).toMatch(NAME_RE)
      })

      it('emits a non-empty description within 1024 chars', () => {
        const fm = parseYamlish(frontmatter(md))
        const description = String(fm.description)
        expect(description.length).toBeGreaterThan(0)
        expect(description.length).toBeLessThanOrEqual(1024)
      })

      it('emits frontmatter that parses as a mapping', () => {
        expect(() => parseYamlish(frontmatter(md))).not.toThrow()
      })

      it('round-trips: our own parser reads back what we wrote', () => {
        const back = parseVaultSkill('skills/x/SKILL.md', md)
        const fm = parseYamlish(frontmatter(md))
        const meta = (fm.metadata ?? {}) as Record<string, string>
        // The human title wins when it had to be slugged for the spec's
        // charset — otherwise the slug IS the name.
        expect(back.name).toBe(meta.scprism_display_name ?? String(fm.name))
        expect(back.description).toBe(String(fm.description))
      })
    })
  }
})

describe('serializeSkillMd — SC Prism properties ride in metadata', () => {
  it('puts when_to_use under metadata, never at top level', () => {
    const md = serializeSkillMd({
      name: 'code-review',
      description: 'reviews diffs',
      whenToUse: 'any diff over 5 lines',
      body: '# P',
    })
    expect(topLevelKeys(md)).not.toContain('when_to_use')
    const fm = parseYamlish(frontmatter(md))
    expect((fm.metadata as Record<string, string>).when_to_use).toBe('any diff over 5 lines')
  })

  it('emits roles under metadata as scprism_roles — and does not drop them', () => {
    // Live data-loss bug this closes: the writer dropped `roles` entirely, so
    // every UI save silently degraded a role-scoped skill to global while the
    // engine went dark for every non-matching seat.
    const md = serializeSkillMd({
      name: 'code-review',
      description: 'reviews diffs',
      whenToUse: 'any diff',
      body: '# P',
      roles: ['reviewer', 'planner'],
    })
    const meta = parseYamlish(frontmatter(md)).metadata as Record<string, string>
    expect(meta.scprism_roles).toBe('reviewer, planner')
    const back = parseVaultSkill('skills/code-review/SKILL.md', md)
    expect(back.roles?.sort()).toEqual(['planner', 'reviewer'])
  })

  it('omits scprism_roles entirely when a skill is global', () => {
    const md = serializeSkillMd({
      name: 'x',
      description: 'd',
      whenToUse: 'w',
      body: '# P',
      roles: [],
    })
    const meta = parseYamlish(frontmatter(md)).metadata as Record<string, string>
    expect(meta.scprism_roles).toBeUndefined()
    // …but the block itself is never empty — an empty `metadata:` parses as
    // null and crashes a conformant consumer's `.items()`.
    expect(meta.when_to_use).toBeTruthy()
  })

  it('never writes allowed-tools', () => {
    const md = serializeSkillMd({
      name: 'x',
      description: 'd',
      whenToUse: 'w',
      body: '# P',
      roles: ['reviewer'],
    })
    expect(md).not.toContain('allowed-tools')
  })
})
