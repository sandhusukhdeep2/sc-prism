import { afterEach, describe, expect, it } from 'vitest'
import { create, list, read, remove, validate, write } from './vault'

// jsdom provides a real localStorage. The vault keeps a module-level in-memory
// `state` that is the source of truth, so these tests use unique, non-seed paths
// to avoid colliding with the seeded content or with each other.
afterEach(() => {
  localStorage.clear()
})

describe('validate (the validated-write gate)', () => {
  it('rejects empty content', () => {
    const result = validate('notes/x.md', '')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/empty/i)
  })

  it('rejects whitespace-only content', () => {
    const result = validate('notes/x.md', '   \n\t  ')
    expect(result.ok).toBe(false)
  })

  it('rejects a policies/* file that lacks a max_ key', () => {
    const result = validate('policies/limit.md', '# Limit\n\nscope: uploader\n')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/max_/)
  })

  it('accepts a valid policy that defines a max_ key', () => {
    const result = validate('policies/limit.md', '# Limit\n\nmax_rpm: 30\n')
    expect(result.ok).toBe(true)
  })

  it('accepts ordinary non-policy content', () => {
    const result = validate('notes/x.md', 'hello')
    expect(result.ok).toBe(true)
  })
})

describe('create → read → write → remove roundtrip', () => {
  const path = 'notes/roundtrip-spec.md'

  it('creates, reads, overwrites, and removes a file', () => {
    // Ensure a clean slate for this unique path.
    remove(path)

    const created = create(path, 'first version')
    expect(created.ok).toBe(true)
    expect(read(path)).toBe('first version')
    expect(list()).toContain(path)

    // create fails when the path already exists.
    const dup = create(path, 'again')
    expect(dup.ok).toBe(false)

    // write overwrites in place.
    const written = write(path, 'second version')
    expect(written.ok).toBe(true)
    expect(read(path)).toBe('second version')

    // remove deletes; read then returns null and the path leaves the listing.
    remove(path)
    expect(read(path)).toBeNull()
    expect(list()).not.toContain(path)
  })

  it('write rejects invalid content through the gate and does not persist', () => {
    remove(path)
    const bad = write(path, '   ')
    expect(bad.ok).toBe(false)
    expect(read(path)).toBeNull()
  })

  it('create rejects an empty path', () => {
    const result = create('   ')
    expect(result.ok).toBe(false)
  })
})
