import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// WHERE HIS COWORKERS LIVE. The library was localStorage ONLY, while managers,
// projects, settings and schedules each had a file in the app's store
// directory — so the seven agents Sukhdeep built the product around were the
// one thing a cleared webview would take with it, and the one thing absent
// from a backup of his app data.
const native = vi.hoisted(() => ({
  isNative: vi.fn(() => true),
  storeGet: vi.fn(async () => null as string | null),
  storeSet: vi.fn(async () => {}),
}))
vi.mock('./nativeEngine', async (importActual) => {
  const actual = await importActual<typeof import('./nativeEngine')>()
  return { ...actual, ...native }
})

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
  native.isNative.mockReturnValue(true)
  native.storeGet.mockResolvedValue(null)
  native.storeSet.mockClear()
})
afterEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

/** A stored agent's full required shape — isAgent rejects a partial one, and a
 *  fixture that fails validation would test the validator, not the disk. */
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

const wrote = (): string[] =>
  (native.storeSet.mock.calls as unknown as [string, string][])
    .filter((c) => c[0] === 'agents')
    .map((c) => c[1])

describe('the agent library is durable, not just cached', () => {
  it('writes every change to the app store, not only to localStorage', async () => {
    const mod = await import('./agents')
    // Let the hydration promise settle so writes are no longer held back.
    await vi.waitFor(() => expect(native.storeGet).toHaveBeenCalledWith('agents'))
    await Promise.resolve()

    const a = mod.create({ name: 'durable-one', role: 'tester', model: 'local', skills: [] })
    const payloads = wrote()
    expect(payloads.length, 'nothing reached the app store').toBeGreaterThan(0)
    const last = JSON.parse(payloads[payloads.length - 1]) as { id: string }[]
    expect(last.some((x) => x.id === a.id)).toBe(true)
  })

  it('a DISK copy wins over localStorage — a cleared webview comes back with the library', async () => {
    localStorage.setItem('scprism.agents', JSON.stringify([]))
    native.storeGet.mockResolvedValue(
      JSON.stringify([stored({ id: 'from-disk', name: 'archivist' })]),
    )
    const mod = await import('./agents')
    await vi.waitFor(() => expect(mod.list().some((a) => a.id === 'from-disk')).toBe(true))
  })

  it('a MALFORMED disk file is ignored — a bad write cannot delete a working library', async () => {
    localStorage.setItem(
      'scprism.agents',
      JSON.stringify([stored({ id: 'kept', name: 'auditor' })]),
    )
    native.storeGet.mockResolvedValue('{ not json at all')
    const mod = await import('./agents')
    await vi.waitFor(() => expect(native.storeGet).toHaveBeenCalled())
    expect(mod.list().some((a) => a.id === 'kept')).toBe(true)
  })

  it('in the browser it stays localStorage-only, with no disk call at all', async () => {
    native.isNative.mockReturnValue(false)
    const mod = await import('./agents')
    mod.create({ name: 'browser-only', role: 'r', model: 'local', skills: [] })
    expect(wrote()).toHaveLength(0)
  })
})
