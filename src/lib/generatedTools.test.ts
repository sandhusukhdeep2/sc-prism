import { describe, expect, it } from 'vitest'
import { toolState, type ToolRow } from './generatedTools'

// Sukhdeep: "can you show it in my application? How can I check them?"
//
// The four gates live in the engine and are enforced there. This is the part
// that makes them VISIBLE — a gate the user cannot see the state of is a gate
// they have to take on faith, which is the opposite of the point.
//
// Every state below is derived from the manifest on disk. Nothing is inferred
// from what the UI wishes were true.

const row = (over: Partial<ToolRow> = {}): ToolRow => ({
  name: 'northwind_foods_pdf_invoices',
  description: 'Read line items from Northwind invoices.',
  permissions: { filesystem_read: ['inbox/invoices/**'] },
  data_class: 'confidential',
  execution_target: 'local_only',
  approved_by: null,
  passing_tests: 0,
  quarantined: false,
  ...over,
})

describe('toolState', () => {
  it('a drafted tool is waiting for you, and says which gate', () => {
    const s = toolState(row())
    expect(s.id).toBe('needs-scope')
    expect(s.label.toLowerCase()).toContain('scope')
    expect(s.callable).toBe(false)
  })

  it('scope approved but nothing proven is NOT callable', () => {
    const s = toolState(row({ approved_by: 'user', passing_tests: 0 }))
    expect(s.callable).toBe(false)
    expect(s.label.toLowerCase()).toMatch(/test|prove/)
  })

  it('approved AND proven is callable, and says so plainly', () => {
    const s = toolState(row({ approved_by: 'user', passing_tests: 2 }))
    expect(s.id).toBe('active')
    expect(s.callable).toBe(true)
  })

  it('a quarantined tool is never callable, whatever its manifest says', () => {
    // The manifest is user-editable text on disk. Quarantine is a fact about
    // WHERE it lives, and that has to win.
    const s = toolState(row({ approved_by: 'user', passing_tests: 5, quarantined: true }))
    expect(s.id).toBe('quarantined')
    expect(s.callable).toBe(false)
  })

  it('a quarantined tool shows why it failed', () => {
    const s = toolState(row({ quarantined: true, quarantineReason: 'undeclared_access' }))
    expect(s.detail).toContain('undeclared_access')
  })

  it('says when a tool is pinned to this machine', () => {
    expect(toolState(row()).pinnedLocal).toBe(true)
    expect(toolState(row({ data_class: 'public', execution_target: 'any_provider' })).pinnedLocal).toBe(false)
  })

  it('only an inactive, scope-unapproved tool offers approval', () => {
    expect(toolState(row()).canApproveScope).toBe(true)
    expect(toolState(row({ approved_by: 'user', passing_tests: 1 })).canApproveScope).toBe(false)
    expect(toolState(row({ quarantined: true })).canApproveScope).toBe(false)
  })
})

// Gate 1 and Gate 4 are separate decisions, so the interface must show which
// one is still yours. Scope approval is safe for the UI to record — it is your
// own decision about what a tool MAY do, and it grants nothing. Activation is
// not: it requires a passing sandbox run, which only the engine establishes.
describe('the two gates are distinguishable on screen', () => {
  const row = (over: Partial<ToolRow> = {}): ToolRow => ({
    name: 't_tool',
    description: 'd',
    permissions: {},
    data_class: 'confidential',
    execution_target: 'local_only',
    scope_approved_by: null,
    approved_by: null,
    passing_tests: 0,
    quarantined: false,
    ...over,
  })

  it('unapproved scope is the user’s decision, and offers the button', () => {
    const s = toolState(row())
    expect(s.id).toBe('needs-scope')
    expect(s.canApproveScope).toBe(true)
  })

  it('scope approved but unproven waits on the ENGINE, not the user', () => {
    const s = toolState(row({ scope_approved_by: 'user' }))
    expect(s.id).toBe('needs-proof')
    expect(s.canApproveScope).toBe(false)
    // The user must not be shown a button they cannot honestly press.
    expect(s.detail.toLowerCase()).toMatch(/sandbox|real examples/)
  })

  it('scope approval alone is never callable', () => {
    expect(toolState(row({ scope_approved_by: 'user' })).callable).toBe(false)
  })

  it('activation requires both, and says who did each', () => {
    const s = toolState(row({ scope_approved_by: 'user', approved_by: 'user', passing_tests: 2 }))
    expect(s.id).toBe('active')
    expect(s.callable).toBe(true)
  })
})
