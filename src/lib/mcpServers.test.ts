import { describe, expect, it } from 'vitest'
import { mcpServerNames, mcpServersArg } from './mcpServers'

// 2026-11-11 audit: plugin (MCP) servers could be registered and tested in
// Settings, but no app-launched run ever received one — the bridge passed no
// `--mcp-server` and the capability ceiling hard-coded zero servers. The list
// of registered names is the one thing every layer now reads.
describe('mcpServerNames — the registered servers, as names a run can be given', () => {
  it('takes names from the registrations, in order, once each', () => {
    expect(mcpServerNames([{ name: 'files' }, { name: 'github' }, { name: 'files' }])).toEqual(['files', 'github'])
  })
  it('accepts a plain list of names too (the cached copy in settings)', () => {
    expect(mcpServerNames(['files', 'github'])).toEqual(['files', 'github'])
  })
  it('drops anything that is not a safe single name — it becomes a command-line value', () => {
    expect(mcpServerNames(['ok-1', 'a,b', 'has space', '--flag', '', 'x.y_z', 42, null, { name: '../up' }])).toEqual(['ok-1', 'x.y_z'])
  })
  it('is empty for garbage', () => {
    expect(mcpServerNames(undefined)).toEqual([])
    expect(mcpServerNames('files')).toEqual([])
  })
})

describe('mcpServersArg — the value handed to the engine', () => {
  it('is a comma list, or empty when nothing is registered', () => {
    expect(mcpServersArg(['files', 'github'])).toBe('files,github')
    expect(mcpServersArg([])).toBe('')
  })
})
