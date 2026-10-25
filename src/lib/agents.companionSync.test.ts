// syncCompanionFile — slice D cycle 2: the Companion's definition becomes a
// real vault file with the same source-of-truth contract agents got in
// slice A:
//   • MIGRATION: no file yet → write agents/companion.md from the store's
//     charter (first native visit makes the Companion portable).
//   • DISCOVERY: a file the user edited wins — its body is the charter the
//     store adopts (capped; empty body = the default ladder, never blank).
//   • The reserved slug is NOT a roster agent: syncVaultAgents must skip
//     agents/companion.md — the Companion never becomes a seat row.
// Harness copied from agents.sync.test.ts (fake vault map + spied bridge).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
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

vi.mock('./nativeEngine', async (orig) => {
  const actual = await orig<typeof import('./nativeEngine')>()
  return {
    ...actual,
    isNative: native.isNative,
    storeGet: native.storeGet,
    storeSet: native.storeSet,
    resolveVaultDir: native.resolveVaultDir,
    listVaultTree: native.listVaultTree,
    readVaultFile: native.readVaultFile,
    writeVaultNote: native.writeVaultNote,
    deleteVaultFile: native.deleteVaultFile,
  }
})

import { SEED, persistCompanionCharter, syncCompanionFile, syncManagerFiles, syncVaultAgents, list } from './agents'
import { STARTER_CHARTER } from './managers'

describe('syncCompanionFile', () => {
  beforeEach(() => {
    native.files.clear()
    native.tree = []
    native.isNative.mockReturnValue(true)
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('first visit writes agents/companion.md from the store charter', async () => {
    const out = await syncCompanionFile('My standing orders.', 'claude')
    expect(out).toEqual({ charter: 'My standing orders.', wrote: true })
    const file = native.files.get('agents/companion.md')
    expect(file).toContain('name: companion')
    expect(file).toContain('My standing orders.')
  })

  it('an edited file wins — its body is the charter the store adopts', async () => {
    native.files.set(
      'agents/companion.md',
      '---\nname: companion\nmodel: claude\n---\n\nEdited in my editor.\n',
    )
    const out = await syncCompanionFile('Stale store text.', 'claude')
    expect(out).toEqual({ charter: 'Edited in my editor.', wrote: false })
  })

  it('an emptied file body adopts the default ladder, never blank', async () => {
    native.files.set('agents/companion.md', '---\nname: companion\nmodel: claude\n---\n')
    const out = await syncCompanionFile('Stale store text.', 'claude')
    expect(out?.charter).toBe(STARTER_CHARTER)
  })

  it('returns null in the browser', async () => {
    native.isNative.mockReturnValue(false)
    expect(await syncCompanionFile('x', 'claude')).toBeNull()
  })
})

describe('syncVaultAgents skips the reserved companion file', () => {
  beforeEach(() => {
    native.files.clear()
    native.tree = []
    native.isNative.mockReturnValue(true)
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('agents/companion.md never becomes a roster row', async () => {
    native.files.set(
      'agents/companion.md',
      '---\nname: companion\nmodel: claude\n---\n\nCharter text.\n',
    )
    native.tree = ['agents/companion.md']
    await syncVaultAgents()
    const names = list().map((a) => a.name.toLowerCase())
    expect(names).not.toContain('companion')
  })
})

describe('persistCompanionCharter — the app-edit half of write-through', () => {
  beforeEach(() => {
    native.files.clear()
    native.isNative.mockReturnValue(true)
  })

  it('overwrites the file with the edited charter (app edit wins)', async () => {
    native.files.set(
      'agents/companion.md',
      '---\nname: companion\nmodel: claude\n---\n\nOld words.\n',
    )
    const ok = await persistCompanionCharter('Fresh words from the app.', 'claude')
    expect(ok).toBe(true)
    expect(native.files.get('agents/companion.md')).toContain('Fresh words from the app.')
    expect(native.files.get('agents/companion.md')).not.toContain('Old words.')
  })

  it('resolves false in the browser, never throws', async () => {
    native.isNative.mockReturnValue(false)
    expect(await persistCompanionCharter('x', 'claude')).toBe(false)
  })
})

describe('syncManagerFiles — managers become definition files too', () => {
  beforeEach(() => {
    native.files.clear()
    native.isNative.mockReturnValue(true)
  })

  const managers = [
    { id: 'mgr-local', providerId: 'local', name: 'Local model manager', enabled: true },
    { id: 'mgr-companion', providerId: 'claude', name: 'Companion', enabled: true },
  ]
  const jobs = [
    {
      id: 'j1',
      managerId: 'mgr-local',
      title: 'Check the kitchen',
      department: 'operations',
      prompt: 'Check the knives are sharp.',
      everyMinutes: 1440,
      lastRun: 0,
      runs: [],
      kind: 'report' as const,
    },
  ]

  it('writes agents/managers/<slug>.md with tools stating what jobs may touch', async () => {
    const wrote = await syncManagerFiles(managers, jobs)
    expect(wrote).toBe(1)
    const file = native.files.get('agents/managers/local-model-manager.md')
    expect(file).toContain('name: Local model manager')
    expect(file).toContain('tools: [vault]')
    expect(file).toContain('Check the kitchen')
    expect(file).toContain('every 1440 min')
  })

  it('never writes the companion here (it owns agents/companion.md)', async () => {
    await syncManagerFiles(managers, jobs)
    const paths = [...native.files.keys()]
    expect(paths.some((p) => p.includes('companion'))).toBe(false)
  })

  it('is idempotent — an unchanged manager is not rewritten', async () => {
    await syncManagerFiles(managers, jobs)
    const writes = native.writeVaultNote.mock.calls.length
    await syncManagerFiles(managers, jobs)
    expect(native.writeVaultNote.mock.calls.length).toBe(writes)
  })

  it('returns 0 in the browser', async () => {
    native.isNative.mockReturnValue(false)
    expect(await syncManagerFiles(managers, jobs)).toBe(0)
  })
})

// NO BLANK FILES (Sukhdeep, 2026-08-29 evening: "agent files are empty in
// vault"). A frontmatter-only .md renders as a BLANK PAGE in Obsidian — his
// vault reader — so every built-in ships a real charter, and the sync repairs
// installs whose system files predate charters: empty store charter + empty
// file body adopts the seed charter and rewrites the file. Nothing
// user-authored is ever replaced — any non-empty body wins as before.
describe('system agents always have a charter on disk', () => {
  beforeEach(() => {
    native.files.clear()
    native.tree = []
    native.isNative.mockReturnValue(true)
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('every system seed carries a non-empty charter', () => {
    for (const a of SEED.filter((x) => x.system)) {
      expect(a.charter?.trim(), a.name).toBeTruthy()
    }
  })

  it('repairs a pre-charter install: empty file body adopts the seed charter and rewrites', async () => {
    native.files.set('agents/planner.md',
      '---\nname: Planner\ndescription: emits the YAML plan\nmodel: claude\nskills: [task-contract, decompose]\n---\n')
    native.tree = ['agents/planner.md']
    await syncVaultAgents()
    const row = list().find((a) => a.id === 'sys-planner')
    expect(row?.charter?.trim()).toBeTruthy()
    expect(native.files.get('agents/planner.md')).toContain(row!.charter!.slice(0, 30))
  })

  it('never replaces a user-authored charter body', async () => {
    native.files.set('agents/planner.md',
      '---\nname: Planner\ndescription: emits the YAML plan\nmodel: claude\n---\n\nMy own planner rules.\n')
    native.tree = ['agents/planner.md']
    await syncVaultAgents()
    const row = list().find((a) => a.id === 'sys-planner')
    expect(row?.charter).toBe('My own planner rules.')
    expect(native.files.get('agents/planner.md')).toContain('My own planner rules.')
  })
})
