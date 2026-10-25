// Subscription-CLI health — the THREE states (2026-08-12).
//
// The bug: the check only ever asked "is the binary there?" and reported a
// green "installed". Reproduced live — `gemini --version` printed 0.53.0 while
// `gemini -p "…"` answered "IneligibleTierError: This client is no longer
// supported for Gemini Code Assist for individuals", because Google closed that
// OAuth path for individual accounts. The card stayed green, the agent on it
// kept its seat on every team run, and it contributed a 13-token offline stub.
//
// So: installed is not usable, and these pin the three answers apart — plus the
// cheapness rule, because a probe that ran on every render or every roster
// build would be its own bug.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  checkCli: vi.fn<(bin: string) => Promise<string | null>>(),
  probeCli: vi.fn<(bin: string) => Promise<{ ok: boolean; reply: string; error: string }>>(),
}))

vi.mock('./nativeEngine', async (orig) => {
  const actual = await orig<typeof import('./nativeEngine')>()
  return { ...actual, checkCli: h.checkCli, probeCli: h.probeCli }
})

import {
  CLI_PROBE_TTL_MS,
  cachedCliProbe,
  clearCliProbes,
  cliStatusLabel,
  pingProvider,
  probeCliProvider,
} from './settings'

const INELIGIBLE =
  'IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals'

beforeEach(() => {
  clearCliProbes()
  h.checkCli.mockReset()
  h.probeCli.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the three CLI states are told apart', () => {
  it('NOT INSTALLED — the binary is missing', async () => {
    h.checkCli.mockResolvedValue(null)
    const probe = await probeCliProvider('gemini-cli')
    expect(probe.status).toBe('unreachable')
    expect(cliStatusLabel(probe.status)).toBe('not installed')
    // Nothing was run: there was nothing to run.
    expect(h.probeCli).not.toHaveBeenCalled()
  })

  it('INSTALLED BUT CANNOT ANSWER — carries the CLI’s OWN error text', async () => {
    h.checkCli.mockResolvedValue('/opt/homebrew/bin/gemini')
    h.probeCli.mockResolvedValue({ ok: false, reply: '', error: INELIGIBLE })
    const probe = await probeCliProvider('gemini-cli')
    expect(probe.status).toBe('auth')
    expect(probe.detail).toBe(INELIGIBLE)
    expect(cliStatusLabel(probe.status)).toBe("can't answer")
    // The installed-ness was proved AND the answer was demanded.
    expect(h.probeCli).toHaveBeenCalledWith('gemini')
  })

  it('WORKING — it actually replied', async () => {
    h.checkCli.mockResolvedValue('/opt/homebrew/bin/claude')
    h.probeCli.mockResolvedValue({ ok: true, reply: 'ok', error: '' })
    const probe = await probeCliProvider('claude-cli')
    expect(probe.status).toBe('ok')
    expect(probe.detail).toBe('')
    expect(cliStatusLabel(probe.status)).toBe('working')
  })

  it('an installed CLI that cannot answer is NOT reported as ok by pingProvider', async () => {
    h.checkCli.mockResolvedValue('/opt/homebrew/bin/gemini')
    h.probeCli.mockResolvedValue({ ok: false, reply: '', error: INELIGIBLE })
    // The old behaviour returned 'ok' here purely because the file existed.
    expect(await pingProvider('', '', 'gemini-cli')).toBe('auth')
  })
})

describe('the probe stays cheap', () => {
  it('caches: a second ask inside the TTL runs nothing', async () => {
    h.checkCli.mockResolvedValue('/bin/gemini')
    h.probeCli.mockResolvedValue({ ok: true, reply: 'ok', error: '' })
    await probeCliProvider('gemini-cli')
    await probeCliProvider('gemini-cli')
    await pingProvider('', '', 'gemini-cli')
    expect(h.probeCli).toHaveBeenCalledTimes(1)
    expect(cachedCliProbe('gemini-cli')?.status).toBe('ok')
  })

  it('coalesces concurrent asks into ONE probe', async () => {
    h.checkCli.mockResolvedValue('/bin/gemini')
    h.probeCli.mockResolvedValue({ ok: true, reply: 'ok', error: '' })
    await Promise.all([
      probeCliProvider('gemini-cli'),
      probeCliProvider('gemini-cli'),
      probeCliProvider('gemini-cli'),
    ])
    expect(h.probeCli).toHaveBeenCalledTimes(1)
  })

  it('re-runs when the cache is stale (TTL) or when a Connect/Retry click forces it', async () => {
    h.checkCli.mockResolvedValue('/bin/gemini')
    h.probeCli.mockResolvedValue({ ok: true, reply: 'ok', error: '' })
    const first = await probeCliProvider('gemini-cli')
    // Stale: asked as if it were long after the first probe settled.
    await probeCliProvider('gemini-cli', { now: first.at + CLI_PROBE_TTL_MS + 1 })
    expect(h.probeCli).toHaveBeenCalledTimes(2)
    // An explicit click never trusts the cache.
    await pingProvider('', '', 'gemini-cli', { force: true })
    expect(h.probeCli).toHaveBeenCalledTimes(3)
  })

  it('a working CLI that STOPS working is re-reported honestly on the next forced check', async () => {
    h.checkCli.mockResolvedValue('/bin/gemini')
    h.probeCli.mockResolvedValue({ ok: true, reply: 'ok', error: '' })
    expect((await probeCliProvider('gemini-cli')).status).toBe('ok')
    h.probeCli.mockResolvedValue({ ok: false, reply: '', error: INELIGIBLE })
    const again = await probeCliProvider('gemini-cli', { force: true })
    expect(again.status).toBe('auth')
    expect(again.detail).toBe(INELIGIBLE)
  })
})
