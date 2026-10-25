import { describe, expect, it, vi } from 'vitest'

// Mock the Tauri path plugin so defaultVaultDir()/expandUserPath() work without
// a real Tauri IPC bridge (jsdom has none) — this is what the brief calls out:
// resolveVaultDir's non-native path is native-gated in the plain nativeEngine
// tests (isNative() is false there so the real invoke() is never reached, but
// defaultVaultDir/expandUserPath call the Tauri path plugin directly, with no
// isNative() guard of their own). Mocking the plugin here lets this ONE
// regression exercise the real resolveVaultDir end to end.
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/fake/appdata',
  homeDir: async () => '/fake/home',
  join: async (...parts: string[]) => parts.filter(Boolean).join('/'),
}))

import { defaultVaultDir, resolveVaultDir } from './nativeEngine'

// Regression test for C3: resolveVaultDir('~foo') used to return the empty
// string straight from expandUserPath's "invalid ~ pattern" branch, and that
// '' reached the engine as the vault path. The fix falls back to
// defaultVaultDir() whenever expandUserPath signals "unusable" — same as the
// existing empty/relative fallback.
describe('resolveVaultDir — unusable ~ pattern falls back to the default vault dir', () => {
  it('"~foo" (invalid tilde pattern) falls back to defaultVaultDir(), never an empty string', async () => {
    const fallback = await defaultVaultDir()
    const resolved = await resolveVaultDir('~foo')
    expect(resolved).not.toBe('')
    expect(resolved).toBe(fallback)
  })

  it('a valid "~/notes" path still expands normally (unaffected by the fallback)', async () => {
    expect(await resolveVaultDir('~/notes')).toBe('/fake/home/notes')
  })

  it('a bare "~" still expands to home (unaffected by the fallback)', async () => {
    expect(await resolveVaultDir('~')).toBe('/fake/home')
  })

  it('an absolute path is used as-is', async () => {
    expect(await resolveVaultDir('/custom/vault')).toBe('/custom/vault')
  })

  it('empty/relative input falls back to the default vault dir (pre-existing behavior)', async () => {
    const fallback = await defaultVaultDir()
    expect(await resolveVaultDir('')).toBe(fallback)
    expect(await resolveVaultDir('relative/path')).toBe(fallback)
  })
})
