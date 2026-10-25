// syncVaultAgents — the vault side of "agents are files" (slice A).
//
// One pass, three jobs, mirrored from the skill library's proven sync:
//   • DISCOVERY: every `agents/*.md` joins or updates the library — the file
//     is the source of truth for the definition; the store keeps the app-side
//     index state (enabled, assignedTo, usage) the file doesn't carry.
//   • REMOVAL: an agent whose own file the user deleted is gone — that is
//     what "a real file you can open, diff, and delete" means. System agents
//     keep their store row (the store's own never-removed contract), and a
//     listing that came back EMPTY removes nothing: an empty tree is a brand
//     new vault or a failed read, and neither is licence to drop the seven
//     coworkers the product was built around.
//   • MIGRATION: every agent still without a file gets one written — the
//     seed/system agents and every pre-slice-A business agent become portable
//     on the first native load — WITHOUT ever clobbering a file the user
//     already authored at that path (listed or not: the write path re-probes
//     the disk before it can overwrite anything the listing missed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  // A tiny fake vault: rel path -> file content. listVaultTree serves `tree`
  // (set per test), NOT the map's keys, so a test can model a listing that
  // lies (transient failure) while the files are really on disk.
  const files = new Map<string, string>()
  return {
    files,
    tree: [] as string[],
    isNative: vi.fn(() => true),
    storeGet: vi.fn(async () => null as string | null),
    storeSet: vi.fn(async () => {}),
    resolveVaultDir: vi.fn(async () => '/vault'),
    listVaultTree: vi.fn(async () => native.tree),
    readVaultFile: vi.fn(async (_v: string, rel: string) => files.get(rel) ?? null),
    writeVaultNote: vi.fn(async (_v: string, rel: string, content: string) => {
      files.set(rel, content)
      return `/vault/${rel}`
    }),
    deleteVaultFile: vi.fn(async (_v: string, rel: string) => {
      files.delete(rel)
      return null
    }),
  }
})
vi.mock('./nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('./nativeEngine')>()
  return { ...actual, ...native }
})

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
  native.files.clear()
  native.tree = []
  native.isNative.mockReturnValue(true)
  native.storeGet.mockResolvedValue(null)
  vi.clearAllMocks()
})
afterEach(() => {
  localStorage.clear()
})

/** A stored row in full — isAgent rejects a partial one. */
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

const seedLibrary = (rows: unknown[]) =>
  localStorage.setItem('scprism.agents', JSON.stringify(rows))

const agentsMod = () => import('./agents')

/** The paths writeVaultNote was asked to write. */
const wrotePaths = () =>
  (native.writeVaultNote.mock.calls as unknown as [string, string, string][]).map((c) => c[1])

describe('discovery — a hand-dropped agents/*.md joins the library', () => {
  it('creates a full row from the file: definition from frontmatter, sourcePath recorded', async () => {
    seedLibrary([])
    native.files.set(
      'agents/odd-name.md',
      '---\nname: Scribe\ndescription: keeps the minutes\nmodel: gemini\nskills: [web-digest]\ntools: [vault]\n---\nWrites everything down.\n',
    )
    native.tree = ['agents/odd-name.md', 'notes/x.md']
    const mod = await agentsMod()
    const count = await mod.syncVaultAgents()
    expect(count).toBe(1)
    const scribe = mod.list().find((a) => a.name === 'Scribe')
    expect(scribe).toBeDefined()
    expect(scribe?.role).toBe('keeps the minutes')
    expect(scribe?.model).toBe('gemini')
    expect(scribe?.skills).toEqual(['web-digest'])
    expect(scribe?.tools).toEqual(['vault'])
    expect(scribe?.charter).toBe('Writes everything down.')
    // The row's file is the one it came from — delete must target it.
    expect(scribe?.sourcePath).toBe('agents/odd-name.md')
    expect(scribe && mod.agentWritePath(scribe)).toBe('agents/odd-name.md')
    // Discovered, not created: enabled and unassigned, with NO fabricated
    // creation timestamp (the store's createdAt contract).
    expect(scribe?.enabled).toBe(true)
    expect(scribe?.system).toBe(false)
    expect(scribe?.createdAt).toBeUndefined()
  })

  it('re-sync: the file content wins for the definition; the index state survives', async () => {
    seedLibrary([
      stored({
        id: 'a-scribe',
        name: 'Scribe',
        role: 'old words',
        sourcePath: 'agents/scribe.md',
        enabled: false,
        assignedTo: 'proj-1',
        usage: 9,
      }),
    ])
    native.files.set('agents/scribe.md', '---\nname: Scribe\ndescription: new words\nmodel: local\n---\n')
    native.tree = ['agents/scribe.md']
    const mod = await agentsMod()
    await mod.syncVaultAgents()
    const scribe = mod.list().find((a) => a.id === 'a-scribe')
    expect(scribe?.role).toBe('new words')
    expect(scribe?.enabled).toBe(false) // still switched off
    expect(scribe?.assignedTo).toBe('proj-1') // still on its team
    expect(scribe?.usage).toBe(9)
  })
})

describe('removal — deleting the file deletes the agent, with two guards', () => {
  it('a file-backed business agent whose file vanished is dropped', async () => {
    seedLibrary([
      stored({ id: 'gone', name: 'Doomed', sourcePath: 'agents/doomed.md' }),
      stored({ id: 'kept', name: 'Alive', sourcePath: 'agents/alive.md' }),
    ])
    native.files.set('agents/alive.md', '---\nname: Alive\nmodel: local\n---\n')
    native.tree = ['agents/alive.md', 'notes/x.md'] // doomed.md is gone
    const mod = await agentsMod()
    await mod.syncVaultAgents()
    expect(mod.list().some((a) => a.id === 'gone')).toBe(false)
    expect(mod.list().some((a) => a.id === 'kept')).toBe(true)
  })

  it('a SYSTEM agent keeps its row when its file is deleted — and is not re-migrated', async () => {
    // The store's contract: system agents are never removed. Deleting the
    // seed file silences the FILE (the stamp stays, so migration doesn't
    // resurrect what the user deliberately deleted); the row stays.
    seedLibrary([
      stored({
        id: 'sys-planner',
        name: 'Planner',
        system: true,
        assignedTo: 'system',
        sourcePath: 'agents/planner.md',
      }),
    ])
    native.tree = ['notes/x.md'] // planner.md deleted on disk
    const mod = await agentsMod()
    await mod.syncVaultAgents()
    expect(mod.list().some((a) => a.id === 'sys-planner')).toBe(true)
    expect(wrotePaths()).not.toContain('agents/planner.md')
  })

  it('an EMPTY listing removes nothing — a failed read is not a deleted library', async () => {
    seedLibrary([stored({ id: 'kept', name: 'Alive', sourcePath: 'agents/alive.md' })])
    native.files.set('agents/alive.md', '---\nname: Alive\nmodel: local\n---\n')
    native.tree = [] // the listing came back empty; the file is really there
    const mod = await agentsMod()
    await mod.syncVaultAgents()
    expect(mod.list().some((a) => a.id === 'kept')).toBe(true)
  })
})

describe('migration — every agent becomes a portable file, clobbering none', () => {
  it('writes a definition file for every row without one and stamps its path', async () => {
    // The default seed library: five system agents + two business agents,
    // none of which has ever had a file. First native load makes all seven
    // portable — the exact promise of slice A.
    const mod = await agentsMod() // empty localStorage -> load() seeds
    await mod.syncVaultAgents()
    expect(wrotePaths()).toContain('agents/planner.md')
    expect(wrotePaths()).toContain('agents/compliance-checker.md')
    expect(native.files.get('agents/planner.md')).toContain('name: Planner')
    expect(native.files.get('agents/planner.md')).toContain('model: claude')
    for (const a of mod.list()) expect(a.sourcePath).toBeDefined()
    // Stamped means settled: a second sync writes nothing again.
    native.writeVaultNote.mockClear()
    await mod.syncVaultAgents()
    expect(wrotePaths()).toHaveLength(0)
  })

  it('never clobbers a user file already at the canonical path — it merges instead', async () => {
    // The user authored agents/planner.md BEFORE the app migrated. Their
    // file survives byte-for-byte; the row adopts its content and its path.
    const theirs = '---\nname: Planner\ndescription: my own planner words\nmodel: local\n---\nMy charter.\n'
    native.files.set('agents/planner.md', theirs)
    native.tree = ['agents/planner.md']
    const mod = await agentsMod()
    await mod.syncVaultAgents()
    expect(native.files.get('agents/planner.md')).toBe(theirs) // untouched
    const planner = mod.list().find((a) => a.name === 'Planner')
    expect(planner?.system).toBe(true) // still the built-in row, not a duplicate
    expect(planner?.role).toBe('my own planner words')
    expect(planner?.sourcePath).toBe('agents/planner.md')
  })

  it('a FOREIGN file squatting the canonical path keeps it; the agent goes elsewhere', async () => {
    // agents/planner.md declares a different agent entirely. It joins the
    // library under its own name, keeps its path, and the system Planner's
    // file is written at a distinct path — nobody overwrites anybody.
    const theirs = '---\nname: My Own Planner\ndescription: mine\nmodel: local\n---\n'
    native.files.set('agents/planner.md', theirs)
    native.tree = ['agents/planner.md']
    const mod = await agentsMod()
    await mod.syncVaultAgents()
    expect(native.files.get('agents/planner.md')).toBe(theirs) // untouched
    expect(mod.list().some((a) => a.name === 'My Own Planner')).toBe(true)
    const planner = mod.list().find((a) => a.name === 'Planner')
    expect(planner?.sourcePath).toBeDefined()
    expect(planner?.sourcePath).not.toBe('agents/planner.md')
    expect(native.files.get(planner?.sourcePath ?? '')).toContain('name: Planner')
  })

  it('probes the disk before writing — a file the LISTING missed is still never clobbered', async () => {
    // The listing lied (transient failure lists no agent files) while the
    // user's planner.md is really on disk. The write path must re-check the
    // disk rather than trust the listing, or the migration would overwrite
    // the file it never saw.
    const theirs = '---\nname: Planner\ndescription: listed by nobody\nmodel: local\n---\n'
    native.files.set('agents/planner.md', theirs)
    native.tree = ['notes/x.md'] // non-empty, but no agent files listed
    const mod = await agentsMod()
    await mod.syncVaultAgents()
    expect(native.files.get('agents/planner.md')).toBe(theirs) // untouched
    const planner = mod.list().find((a) => a.name === 'Planner')
    expect(planner?.role).toBe('listed by nobody') // merged from the probe
    expect(planner?.sourcePath).toBe('agents/planner.md')
  })
})

describe('write-through targets the REAL file (the delete-resurrection trap)', () => {
  it('persist and remove both address a discovered agent at its recorded sourcePath', async () => {
    const mod = await agentsMod()
    const discovered = {
      name: 'Scribe',
      role: 'keeps the minutes',
      model: 'local' as const,
      skills: [],
      sourcePath: 'agents/odd-name.md',
    }
    await mod.persistAgentToVault(discovered)
    expect(native.writeVaultNote).toHaveBeenCalledWith(
      '/vault',
      'agents/odd-name.md',
      expect.stringContaining('name: Scribe'),
    )
    await mod.removeAgentFromVault(discovered)
    expect(native.deleteVaultFile).toHaveBeenCalledWith('/vault', 'agents/odd-name.md')
    // Neither call may fall back to the canonical slug path — that file (if
    // it existed) would survive a delete and resurrect the agent on re-sync.
    expect(wrotePaths()).not.toContain('agents/scribe.md')
  })
})
