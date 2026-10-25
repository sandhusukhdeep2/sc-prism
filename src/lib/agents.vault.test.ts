// Agent-standard slice A (2026-08-29 spec §1): an agent becomes a portable
// markdown definition at `agents/<slug>.md` — frontmatter (name, description,
// model, tools, skills, memory) + the charter as the body — and the store
// becomes the index/cache with write-through to that file. The skill library
// proved this pattern AND its data-loss traps (skills.vault.test.ts); every
// trap caught there is covered again here for agents:
//   • delete-resurrection: a file at a non-canonical name must be deleted at
//     its REAL path (sourcePath), or the file survives and re-syncs;
//   • sourcePath contamination: a row that doesn't own a vault file must never
//     adopt an unrelated file's path (that path is a delete target);
//   • create-time slug-collision: two live names canonicalizing to one path
//     must get distinct write paths, or one file silently clobbers the other.
import { describe, expect, it, vi } from 'vitest'
import {
  agentFileSlug,
  agentSlug,
  agentVaultPath,
  agentWritePath,
  mergeVaultAgent,
  parseAgentMd,
  persistAgentToVault,
  removeAgentFromVault,
  serializeAgentMd,
  syncVaultAgents,
  type ParsedAgentFile,
  type StoredAgent,
} from './agents'

describe('agentFileSlug — canonical file naming, distinct from the roster slug', () => {
  it('lowercases and hyphenates like the roster slug for normal names', () => {
    expect(agentFileSlug('Release Bot')).toBe('release-bot')
    expect(agentFileSlug('  --PR, Reviewer!! v2.0--  ')).toBe('pr-reviewer-v2-0')
  })

  it('unsluggable names fall back to a deterministic hash — never a shared name', () => {
    // The roster slug's fallback is the SHARED token 'agent' (fine for a seat
    // label, fatal for a filename: two all-punctuation agents would both live
    // at agents/agent.md and delete each other's file).
    const a = agentFileSlug('!!!')
    const b = agentFileSlug('###')
    expect(a).toMatch(/^agent-[0-9a-f]+$/)
    expect(b).toMatch(/^agent-[0-9a-f]+$/)
    expect(a).not.toBe(b) // distinct names must not collide
    expect(agentFileSlug('!!!')).toBe(a) // stable: same input, same slug
  })

  it('the roster slug is untouched — seats keep their shared fallback (no run change)', () => {
    // Slice A must not move a single roster seat: agentSlug still answers
    // 'agent' for unsluggable names, exactly as every roster today expects.
    expect(agentSlug('!!!')).toBe('agent')
    expect(agentSlug('Release Bot')).toBe('release-bot')
  })
})

describe('agentVaultPath', () => {
  it('nests the file slug under agents/ with a .md extension', () => {
    expect(agentVaultPath('Release Bot')).toBe('agents/release-bot.md')
  })

  it('all-punctuation names get distinct stable paths — never "agents/agent.md" twice', () => {
    const a = agentVaultPath('!!!')
    const b = agentVaultPath('###')
    expect(a).not.toBe(b)
    expect(agentVaultPath('!!!')).toBe(a)
  })
})

describe('agentWritePath — the one answer to "where does this agent\'s file live"', () => {
  // Persist and delete must share this answer. A discovered file can sit at
  // ANY agents/*.md name — deleting at the canonical slug path while the real
  // file lives elsewhere leaves the real file behind, and the next sync
  // silently resurrects the agent the user just deleted (the skill library's
  // review defect, re-armed here on purpose so it can never come back).
  it('targets the recorded sourcePath when present', () => {
    expect(agentWritePath({ name: 'Researcher', sourcePath: 'agents/my-old-helper.md' })).toBe(
      'agents/my-old-helper.md',
    )
  })

  it('falls back to the canonical slug path when sourcePath is absent or empty', () => {
    expect(agentWritePath({ name: 'Release Bot' })).toBe('agents/release-bot.md')
    expect(agentWritePath({ name: 'Release Bot', sourcePath: undefined })).toBe(
      'agents/release-bot.md',
    )
    expect(agentWritePath({ name: 'Release Bot', sourcePath: '' })).toBe('agents/release-bot.md')
  })
})

describe('parseAgentMd — one definition file in, one agent shape out', () => {
  it('reads the full spec frontmatter and the charter body', () => {
    const raw = `---
name: researcher
description: gathers sources and cites them
model: claude
tools: [vault, web]
skills: [web-digest]
memory: [reports/, notes/]
---
The charter: what this coworker is for, in plain words.
`
    const p = parseAgentMd('agents/researcher.md', raw)
    expect(p.name).toBe('researcher')
    expect(p.role).toBe('gathers sources and cites them')
    expect(p.model).toBe('claude')
    expect(p.tools).toEqual(['vault', 'web'])
    expect(p.skills).toEqual(['web-digest'])
    expect(p.memory).toEqual(['reports/', 'notes/'])
    expect(p.charter).toBe('The charter: what this coworker is for, in plain words.')
    expect(p.charter).not.toContain('---') // frontmatter stripped
  })

  it('tolerates an inline YAML comment after model — the spec example carries one', () => {
    const raw = `---
name: researcher
model: claude            # brand preference; the roster gate still binds the real provider
tools: [vault, web]  # capability grants
---
Charter.
`
    const p = parseAgentMd('agents/researcher.md', raw)
    expect(p.model).toBe('claude')
    expect(p.tools).toEqual(['vault', 'web'])
  })

  it('accepts bare comma- or whitespace-separated lists (no brackets required)', () => {
    const raw = `---
name: helper
model: local
tools: vault web
skills: web-digest, code-review
---
`
    const p = parseAgentMd('agents/helper.md', raw)
    expect(p.tools).toEqual(['vault', 'web'])
    expect(p.skills).toEqual(['web-digest', 'code-review'])
  })

  it('a bracketed list splits on commas only, so multi-word skill names survive', () => {
    const p = parseAgentMd(
      'agents/helper.md',
      '---\nname: helper\nskills: [task contract, decompose]\n---\n',
    )
    expect(p.skills).toEqual(['task contract', 'decompose'])
  })

  it('an unknown or missing model falls back to claude — the portable-world default', () => {
    // A file written by another runtime says `model: sonnet` — a brand this
    // store doesn't distinguish. The roster gate still binds the real
    // provider, so a wrong badge is visible, never a wrong run.
    expect(parseAgentMd('agents/x.md', '---\nname: x\nmodel: sonnet\n---\n').model).toBe('claude')
    expect(parseAgentMd('agents/x.md', '---\nname: x\n---\n').model).toBe('claude')
    expect(parseAgentMd('agents/x.md', '---\nname: x\nmodel: GEMINI\n---\n').model).toBe('gemini')
    expect(parseAgentMd('agents/x.md', '---\nname: x\nmodel: local\n---\n').model).toBe('local')
  })

  it('falls back to the first heading, then the filename (skipping the agents/ segment)', () => {
    const withHeading = parseAgentMd('agents/odd.md', '# vault-scribe\n\nWrites notes down.\n')
    expect(withHeading.name).toBe('vault-scribe')
    const bare = parseAgentMd('agents/triage.md', 'Just a charter line.')
    expect(bare.name).toBe('triage')
  })

  it('missing description falls back to the charter first paragraph, then a stable default', () => {
    const p = parseAgentMd('agents/scribe.md', '---\nname: scribe\n---\nKeeps the minutes.\n')
    expect(p.role).toBe('Keeps the minutes.')
    const empty = parseAgentMd('agents/scribe.md', '---\nname: scribe\n---\n')
    expect(empty.role).toBe('a vault-defined agent')
  })

  it('absent list keys read as empty skills and NO tools/memory (nothing invented)', () => {
    const p = parseAgentMd('agents/plain.md', '---\nname: plain\nmodel: local\n---\nCharter.\n')
    expect(p.skills).toEqual([])
    expect(p.tools).toBeUndefined()
    expect(p.memory).toBeUndefined()
  })
})

describe('serializeAgentMd — the file the store writes back', () => {
  const agent = {
    name: 'researcher',
    role: 'gathers sources and cites them',
    model: 'claude' as const,
    skills: ['web-digest'],
    tools: ['vault', 'web'],
    memory: ['reports/', 'notes/'],
    charter: 'The charter: what this coworker is for, in plain words.',
  }

  it('emits the spec §1 frontmatter format, charter as the body', () => {
    expect(serializeAgentMd(agent)).toBe(
      '---\n' +
        'name: researcher\n' +
        'description: gathers sources and cites them\n' +
        'model: claude\n' +
        'tools: [vault, web]\n' +
        'skills: [web-digest]\n' +
        'memory: [reports/, notes/]\n' +
        '---\n\n' +
        'The charter: what this coworker is for, in plain words.\n',
    )
  })

  it('omits empty list keys and an empty charter — no noise in a portable file', () => {
    const md = serializeAgentMd({
      name: 'plain',
      role: 'does one thing',
      model: 'local',
      skills: [],
    })
    expect(md).toBe('---\nname: plain\ndescription: does one thing\nmodel: local\n---\n')
    expect(md).not.toContain('tools:')
    expect(md).not.toContain('memory:')
    expect(md).not.toContain('skills:')
  })

  it('sanitizes newlines in name/description to single spaces — one frontmatter block only', () => {
    const md = serializeAgentMd({
      name: 'multi\nline',
      role: 'first\nsecond',
      model: 'local',
      skills: [],
    })
    expect(md).toContain('name: multi line\n')
    expect(md).toContain('description: first second\n')
    expect(md.match(/^---$/gm)?.length).toBe(2)
  })

  it('never emits an empty frontmatter value — empty fields get stable defaults', () => {
    // parseAgentMd's `key: value` regex skips a valueless key, and a skipped
    // description would fall back to the CHARTER's first paragraph on the next
    // read — the body-contamination defect the skill serializer already fixed.
    const md = serializeAgentMd({ name: '', role: '  ', model: 'local', skills: [] })
    expect(md).toContain('name: untitled-agent\n')
    expect(md).toContain('description: a business agent\n')
    expect(md).not.toMatch(/^[a-z_]+: *$/m)
  })

  it('round-trips through the real parseAgentMd: every field survives', () => {
    const p = parseAgentMd(agentVaultPath(agent.name), serializeAgentMd(agent))
    expect(p.name).toBe(agent.name)
    expect(p.role).toBe(agent.role)
    expect(p.model).toBe(agent.model)
    expect(p.skills).toEqual(agent.skills)
    expect(p.tools).toEqual(agent.tools)
    expect(p.memory).toEqual(agent.memory)
    expect(p.charter).toBe(agent.charter)
  })

  it('an empty description never gets contaminated by the charter on round-trip', () => {
    const p = parseAgentMd(
      'agents/leak-check.md',
      serializeAgentMd({
        name: 'leak-check',
        role: '',
        model: 'local',
        skills: [],
        charter: 'This paragraph must NOT become the description.',
      }),
    )
    expect(p.role).toBe('a business agent')
    expect(p.charter).toBe('This paragraph must NOT become the description.')
  })

  it('multi-word skill names survive the round-trip (comma-only split on bracketed lists)', () => {
    const p = parseAgentMd(
      'agents/wordy.md',
      serializeAgentMd({ name: 'wordy', role: 'r', model: 'local', skills: ['task contract'] }),
    )
    expect(p.skills).toEqual(['task contract'])
  })

  it('round-trip is a fixed point: re-serializing the parse result parses identically', () => {
    const once = parseAgentMd(
      agentVaultPath('fixed point'),
      serializeAgentMd({ name: 'fixed point', role: '', model: 'gemini', skills: [] }),
    )
    const twice = parseAgentMd(agentVaultPath(once.name), serializeAgentMd(once))
    expect(twice).toEqual(once)
  })
})

describe('isAgent back-compat — the file fields are optional, validated when present', () => {
  // The full required row shape: isAgent rejects a partial one, and a fixture
  // failing validation would test the validator, not the load path.
  const stored = (over: Record<string, unknown>) => ({
    id: 'x',
    name: 'x',
    role: 'r',
    model: 'local',
    skills: [],
    enabled: true,
    usage: 0,
    evalScore: 0,
    system: false,
    orb: 'a',
    ...over,
  })

  it('loads rows without the new fields, and preserves them through load + re-persist', async () => {
    vi.resetModules()
    localStorage.setItem(
      'scprism.agents',
      JSON.stringify([
        stored({ id: 'legacy', name: 'legacy' }),
        stored({
          id: 'filed',
          name: 'filed',
          sourcePath: 'agents/odd-name.md',
          charter: 'Keeps the vault tidy.',
          tools: ['vault'],
          memory: ['notes/'],
        }),
      ]),
    )
    try {
      const mod = await import('./agents')
      const loaded = mod.list()
      // Both rows valid — the legacy one must NOT be rejected for lacking
      // fields it predates (rejection re-seeds the whole library).
      expect(loaded.map((a) => a.id)).toEqual(['legacy', 'filed'])
      expect(loaded[0].sourcePath).toBeUndefined()
      expect(loaded[1].sourcePath).toBe('agents/odd-name.md')
      expect(loaded[1].tools).toEqual(['vault'])

      // A mutation re-persists the whole array — the file fields must ride
      // along, or a toggle would orphan every agent from its file.
      mod.update('filed', { enabled: false })
      const raw = JSON.parse(localStorage.getItem('scprism.agents') ?? '[]') as {
        id: string
        sourcePath?: string
        charter?: string
      }[]
      const filed = raw.find((a) => a.id === 'filed')
      expect(filed?.sourcePath).toBe('agents/odd-name.md')
      expect(filed?.charter).toBe('Keeps the vault tidy.')
    } finally {
      localStorage.removeItem('scprism.agents')
      vi.resetModules()
    }
  })

  it('rejects malformed file fields — a corrupt array falls back to the seed library', async () => {
    vi.resetModules()
    localStorage.setItem(
      'scprism.agents',
      JSON.stringify([stored({ id: 'bad', name: 'bad', sourcePath: 42 })]),
    )
    try {
      const mod = await import('./agents')
      expect(mod.list().some((a) => a.id === 'bad')).toBe(false)
    } finally {
      localStorage.removeItem('scprism.agents')
      vi.resetModules()
    }
  })
})

describe('create — slug-collision vault-file clobber guard', () => {
  // Two live agents whose names differ only by punctuation ('code-review' vs
  // 'Code Review') both canonicalize to agents/code-review.md. Unlike the
  // skill store, this store has NO create-time name dedupe (uniqueAgentName is
  // the CALLERS' guard), so even two identical names can coexist. Without a
  // path guard, persisting the second overwrites the first's durable file and
  // deleting either erases the other's — silent loss of the portable copy.
  const freshLibrary = async (seed: unknown[] = []) => {
    vi.resetModules()
    localStorage.setItem('scprism.agents', JSON.stringify(seed))
    return import('./agents')
  }
  const cleanup = () => {
    localStorage.removeItem('scprism.agents')
    vi.resetModules()
  }

  it('names differing only by punctuation get distinct write paths; the first is unchanged', async () => {
    try {
      const mod = await freshLibrary()
      const a = mod.create({ name: 'code-review', role: 'r', model: 'local' })
      const b = mod.create({ name: 'Code Review', role: 'r', model: 'local' })
      expect(a.id).not.toBe(b.id)
      expect(mod.agentWritePath(a)).not.toBe(mod.agentWritePath(b))
      // the first keeps the canonical path (byte-identical to pre-guard rows)
      expect(a.sourcePath).toBeUndefined()
      expect(mod.agentWritePath(a)).toBe('agents/code-review.md')
      // the second is disambiguated, never the canonical path
      expect(b.sourcePath).toBeDefined()
      expect(mod.agentWritePath(b)).not.toBe('agents/code-review.md')
    } finally {
      cleanup()
    }
  })

  it('even IDENTICAL names — legal here — each get their own file, three deep', async () => {
    try {
      const mod = await freshLibrary()
      const paths = ['Researcher', 'Researcher', 'Researcher'].map((name) =>
        mod.agentWritePath(mod.create({ name, role: 'r', model: 'local' })),
      )
      expect(new Set(paths).size).toBe(3)
    } finally {
      cleanup()
    }
  })

  it('a new agent cannot claim a file an existing agent was discovered from', async () => {
    try {
      // A vault-discovered agent 'Meeting Scribe' already lives at the very
      // path the new name 'notes' canonicalizes to.
      const mod = await freshLibrary([
        {
          id: 'agent-vault-meeting-scribe',
          name: 'Meeting Scribe',
          role: 'r',
          model: 'local',
          skills: [],
          enabled: true,
          usage: 0,
          evalScore: 0,
          system: false,
          orb: 'a',
          sourcePath: 'agents/notes.md',
        },
      ])
      const created = mod.create({ name: 'notes', role: 'r', model: 'local' })
      expect(created.sourcePath).toBeDefined()
      expect(mod.agentWritePath(created)).not.toBe('agents/notes.md')
    } finally {
      cleanup()
    }
  })

  it('a non-colliding create stays byte-identical to today — no sourcePath, canonical path', async () => {
    try {
      const mod = await freshLibrary()
      const a = mod.create({ name: 'Deploy Runbook', role: 'r', model: 'local' })
      expect(a.sourcePath).toBeUndefined()
      expect(mod.agentWritePath(a)).toBe('agents/deploy-runbook.md')
    } finally {
      cleanup()
    }
  })
})

describe('mergeVaultAgent — sourcePath gating on name collisions', () => {
  const parsed: ParsedAgentFile = {
    name: 'researcher',
    role: 'from the vault file',
    model: 'gemini',
    skills: ['web-digest'],
    tools: ['web'],
    memory: ['reports/'],
    charter: 'Gathers sources and cites them.',
  }
  const rel = 'agents/my-old-helper.md' // a non-canonical, unrelated path

  const base: StoredAgent = {
    id: 'a-researcher',
    name: 'researcher',
    role: 'library words',
    model: 'local',
    skills: ['vault-search'],
    enabled: false,
    usage: 7,
    evalScore: 0.5,
    system: false,
    orb: 'orb',
    assignedTo: 'proj-1',
    createdAt: 123,
  }

  it('the definition fields always merge — the file is the source of truth for WHAT the agent is', () => {
    const merged = mergeVaultAgent({ ...base, sourcePath: 'agents/researcher.md' }, parsed, rel)
    expect(merged.role).toBe('from the vault file')
    expect(merged.model).toBe('gemini')
    expect(merged.skills).toEqual(['web-digest'])
    expect(merged.charter).toBe('Gathers sources and cites them.')
    expect(merged.tools).toEqual(['web'])
    expect(merged.memory).toEqual(['reports/'])
  })

  it('the app-side index state never merges — the file does not carry it', () => {
    // enabled/assignedTo/usage/orb/createdAt are the STORE's half of the
    // bargain (the index/cache); a resync must not reset a switched-off agent
    // or pull one off its project team.
    const merged = mergeVaultAgent({ ...base, sourcePath: rel }, parsed, rel)
    expect(merged.id).toBe('a-researcher')
    expect(merged.enabled).toBe(false)
    expect(merged.assignedTo).toBe('proj-1')
    expect(merged.usage).toBe(7)
    expect(merged.orb).toBe('orb')
    expect(merged.createdAt).toBe(123)
    expect(merged.system).toBe(false)
  })

  it('a row that owns NO file yet does NOT adopt the discovered path (the contamination trap)', () => {
    // The defect the skill review caught, re-armed: a fresh app-created row
    // name-colliding with an unrelated file must not inherit that file's path
    // — the path is a delete target, and Delete would erase a file the row
    // never owned. Its own write path stays canonical.
    const merged = mergeVaultAgent(base, parsed, rel)
    expect(merged.sourcePath).toBeUndefined()
  })

  it('a row that already owns a file follows it — rename on disk keeps continuity', () => {
    const merged = mergeVaultAgent({ ...base, sourcePath: 'agents/researcher.md' }, parsed, rel)
    expect(merged.sourcePath).toBe(rel)
  })

  it('tools/memory are gated like the path — a non-owned row never inherits capability asks', () => {
    // `tools` is what slice B will turn into per-seat capability grants; an
    // unrelated file must not be able to inject grants into a row it doesn't
    // own, exactly as an unrelated SKILL.md can't inject `roles`.
    const merged = mergeVaultAgent({ ...base, tools: ['vault'] }, parsed, rel)
    expect(merged.tools).toEqual(['vault'])
    expect(merged.memory).toBeUndefined()
  })

  it('an owned row adopts the file\'s tools/memory — including honestly reverting to absent', () => {
    const owned = { ...base, sourcePath: rel, tools: ['vault'], memory: ['notes/'] }
    const bare: ParsedAgentFile = { ...parsed, tools: undefined, memory: undefined }
    const merged = mergeVaultAgent(owned, bare, rel)
    expect(merged.tools).toBeUndefined()
    expect(merged.memory).toBeUndefined()
  })
})

describe('persistAgentToVault / removeAgentFromVault — browser mode', () => {
  // jsdom has no __TAURI_INTERNALS__, so isNative() is false here — both must
  // resolve false without throwing (the page fires them fire-and-forget after
  // the already-committed local mutation; a browser session simply has no
  // durable file to keep in step).
  it('persistAgentToVault resolves false without throwing when not running natively', async () => {
    await expect(
      persistAgentToVault({ name: 'a', role: 'r', model: 'local', skills: [] }),
    ).resolves.toBe(false)
  })

  it('removeAgentFromVault resolves false without throwing when not running natively', async () => {
    await expect(removeAgentFromVault({ name: 'a' })).resolves.toBe(false)
  })

  it('both accept a sourcePath-carrying agent without throwing (browser no-op)', async () => {
    await expect(
      persistAgentToVault({
        name: 'a',
        role: 'r',
        model: 'local',
        skills: [],
        sourcePath: 'agents/odd.md',
      }),
    ).resolves.toBe(false)
    await expect(removeAgentFromVault({ name: 'a', sourcePath: 'agents/odd.md' })).resolves.toBe(
      false,
    )
  })

  it('syncVaultAgents is likewise a browser no-op — zero files, zero commits', async () => {
    await expect(syncVaultAgents()).resolves.toBe(0)
  })
})
