import { describe, expect, it } from 'vitest'
import { mcpSaveArgv, mcpTestKeysToClear } from './mcpForm'

// S2: editing then saving a hand-authored command with a space-containing
// argument must NOT corrupt it via the join(' ')/split round-trip.
describe('mcpSaveArgv (S2 — non-lossy MCP command edit)', () => {
  it('reuses the original argv verbatim when the command field is unchanged', () => {
    const orig = ['node', '/Users/me/My Servers/x.js']
    // The field is populated with orig.join(' '); an untouched field must NOT be
    // re-split (that would split the space-containing path into two args).
    expect(mcpSaveArgv(orig.join(' '), orig)).toEqual(orig)
  })

  it('re-splits only when the user actually edited the command field', () => {
    const orig = ['node', '/Users/me/My Servers/x.js']
    expect(mcpSaveArgv('node other.js', orig)).toEqual(['node', 'other.js'])
  })

  it('splits a fresh (non-edit) command on whitespace', () => {
    expect(mcpSaveArgv('npx -y server /path', null)).toEqual(['npx', '-y', 'server', '/path'])
  })
})

// S1: a saved (possibly renamed) command must invalidate its stale handshake
// result so an untested command never shows an old green "N tools".
describe('mcpTestKeysToClear (S1 — invalidate stale handshake result on save)', () => {
  it('clears just the saved name when not renamed (or a fresh add)', () => {
    expect(mcpTestKeysToClear('files', 'files')).toEqual(['files'])
    expect(mcpTestKeysToClear('files', null)).toEqual(['files'])
  })

  it('clears BOTH the new and the renamed-from name on a rename', () => {
    expect(mcpTestKeysToClear('files2', 'files')).toEqual(['files2', 'files'])
  })
})
