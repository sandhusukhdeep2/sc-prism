// SC Prism — Gate 1, scope approval, in plain language.
//
// The spec calls this "the single most important gate — everything downstream
// is constrained by what is approved here." So the summary has to be readable
// by someone who is not going to read JSON, and it must not soften anything.
//
// The one thing this screen could do that would be genuinely dangerous is
// repeat a hostname back as though it were enforced. `sandbox-exec` cannot
// filter network access by host: a manifest naming `api.example.com` gets
// all-or-nothing. Showing "may reach api.example.com" would describe a
// restriction that does not exist, and the user would approve on that basis.
// So a tool with any network declaration is described as reaching ANY site.

export interface DraftManifest {
  name: string
  description: string
  permissions: Record<string, string[]>
  data_class: string
  execution_target: string
}

export interface ScopeSummary {
  what: string
  reads: string
  writes: string
  network: string
  data: string
  /** What deserves the hardest look, or null when the tool can reach nothing. */
  riskiest: 'network' | 'writes' | 'reads' | null
}

const list = (paths: string[]) => paths.filter(Boolean).join(', ')

export function scopeSummary(m: DraftManifest): ScopeSummary {
  const p = m.permissions || {}
  const reads = [...(p.filesystem_read ?? []), ...(p.vault_read ?? [])]
  const writes = [...(p.filesystem_write ?? []), ...(p.vault_write ?? [])]
  const net = p.network ?? []

  const riskiest: ScopeSummary['riskiest'] = net.length
    ? 'network'
    : writes.length
      ? 'writes'
      : reads.length
        ? 'reads'
        : null

  return {
    what: m.description,
    reads: reads.length ? `Can read: ${list(reads)}` : 'Can read nothing on your machine.',
    writes: writes.length
      ? `Can write to: ${list(writes)}`
      : 'Cannot write anything, anywhere.',
    // Deliberately does NOT name the host. See the note at the top.
    network: net.length
      ? 'Can reach the internet — ANY site, not just the one it names. ' +
        'Host-level filtering is not something the sandbox can enforce, so ' +
        'granting this grants all of it.'
      : 'No internet access at all.',
    data:
      m.data_class === 'confidential'
        ? 'Handles confidential data, so it runs on this machine only — its ' +
          'inputs cannot be sent to a cloud provider.'
        : 'Handles data marked public, so it may run on any provider you have ' +
          'connected.',
    riskiest,
  }
}
