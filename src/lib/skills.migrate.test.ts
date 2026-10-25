// MIGRATION (2026-08-29, Sukhdeep's dogfooding find: "in vault skill files
// are empty" — ~/sc-vault/skills/ never existed because syncVaultSkills only
// READ). Mirrors the agents sync: every store skill still without a file gets
// one written on the first native load, stamped with its sourcePath — without
// ever clobbering a file the user already authored at that path. Harness
// copied from agents.sync.test.ts (fake vault map + spied bridge).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    isNative: vi.fn(() => true),
    resolveVaultDir: vi.fn(async () => '/vault'),
    listVaultTree: vi.fn(async () => [...files.keys()]),
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
    resolveVaultDir: native.resolveVaultDir,
    listVaultTree: native.listVaultTree,
    readVaultFile: native.readVaultFile,
    writeVaultNote: native.writeVaultNote,
    deleteVaultFile: native.deleteVaultFile,
    storeGet: async () => null,
    storeSet: async () => {},
  }
})

import { create, list, skillSlug, syncVaultSkills } from './skills'

describe('syncVaultSkills migrates store skills to files', () => {
  beforeEach(() => {
    native.files.clear()
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('writes a file for a store-only skill and stamps sourcePath', async () => {
    const s = create({
      name: 'web-digest-mig',
      description: 'summarize pages',
      whenToUse: 'web research',
      body: 'Fetch, then cite.',
    })
    await syncVaultSkills()
    const rel = `skills/${skillSlug('web-digest-mig')}.md`
    expect(native.files.get(rel)).toContain('Fetch, then cite.')
    expect(list().find((x) => x.id === s.id)?.sourcePath).toBe(rel)
  })

  it('never clobbers a hand-authored file already at the path', async () => {
    create({ name: 'digest-two', description: 'd', whenToUse: 'w', body: 'store words' })
    const rel = `skills/${skillSlug('digest-two')}.md`
    native.files.set(rel, '# digest-two\nhand-authored words')
    await syncVaultSkills()
    expect(native.files.get(rel)).toContain('hand-authored words')
    expect(native.files.get(rel)).not.toContain('store words')
  })
})
