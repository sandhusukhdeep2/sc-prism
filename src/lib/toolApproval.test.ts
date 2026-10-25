import { describe, expect, it } from 'vitest'
import { scopeSummary, type DraftManifest } from './toolApproval'

// Gate 1 — scope approval. The spec calls this "the single most important gate
// — everything downstream is constrained by what is approved here."
//
// So the summary has to be readable by someone who is not going to read JSON,
// and it must not soften anything. Two hard cases it must get right:
//
//   * sandbox-exec CANNOT filter network by host. A manifest naming
//     api.example.com gets all-or-nothing access, so the summary must say
//     "any site", never repeat the hostname as though it were enforced.
//   * "no permissions" is the SAFE case and should read as reassuring, not as
//     an empty section the eye slides over.

const draft = (over: Partial<DraftManifest> = {}): DraftManifest => ({
  name: 'parse_supplier_invoice',
  description: 'Read line items from Northwind Foods PDF invoices.',
  permissions: {
    filesystem_read: [],
    filesystem_write: [],
    network: [],
    vault_read: [],
    vault_write: [],
  },
  data_class: 'confidential',
  execution_target: 'local_only',
  ...over,
})

describe('scopeSummary', () => {
  it('leads with what the tool is for, in the words it was given', () => {
    expect(scopeSummary(draft()).what).toContain('Northwind')
  })

  it('says plainly when a tool can reach nothing', () => {
    const s = scopeSummary(draft())
    expect(s.reads.toLowerCase()).toContain('nothing')
    expect(s.network.toLowerCase()).toContain('no')
  })

  it('lists the exact paths a tool may read', () => {
    const s = scopeSummary(
      draft({ permissions: { ...draft().permissions, filesystem_read: ['inbox/invoices/**'] } }),
    )
    expect(s.reads).toContain('inbox/invoices/**')
  })

  it('NEVER repeats a hostname as though it were enforced', () => {
    // The single most misleading thing this screen could do.
    const s = scopeSummary(
      draft({ permissions: { ...draft().permissions, network: ['api.example.com'] } }),
    )
    expect(s.network).not.toContain('api.example.com')
    expect(s.network.toLowerCase()).toMatch(/any site|any host|anywhere/)
  })

  it('says confidential work stays on this machine', () => {
    const s = scopeSummary(draft())
    expect(s.data.toLowerCase()).toContain('this machine')
  })

  it('does not claim local-only for public data', () => {
    const s = scopeSummary(draft({ data_class: 'public', execution_target: 'any_provider' }))
    expect(s.data.toLowerCase()).not.toContain('cannot leave')
  })

  it('flags writing as the thing to look hardest at', () => {
    const s = scopeSummary(
      draft({ permissions: { ...draft().permissions, filesystem_write: ['out/**'] } }),
    )
    expect(s.writes).toContain('out/**')
    expect(s.riskiest).toBe('writes')
  })

  it('calls network the riskiest when both are present', () => {
    const s = scopeSummary(
      draft({
        permissions: { ...draft().permissions, filesystem_write: ['out/**'], network: ['x'] },
      }),
    )
    expect(s.riskiest).toBe('network')
  })

  it('has no riskiest when the tool can reach nothing', () => {
    expect(scopeSummary(draft()).riskiest).toBeNull()
  })
})
