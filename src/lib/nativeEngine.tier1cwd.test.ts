import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import libRs from '../../src-tauri/src/lib.rs?raw'

// Finding 1a — the second half of the Tier-1 failure.
//
// The first fix gave the engine subprocess a real PATH, so `npm` could be FOUND.
// It never gave Tier-1 a working directory: `run_engine_task` pushed
// `--tier1 <cmd>` and stopped there, so the verify command inherited the engine
// process's own cwd, which `engine_command` pins to `rt.engine_dir`. Inside the
// installed app that is
// `/Applications/SC Prism.app/Contents/Resources/resources/engine` — no
// package.json in it or in ANY ancestor — so every run died with
// `npm error ENOENT`, and Stats then sold those 53 non-verifications as 53
// "saves". The dev repo could never catch it: npm walks UP and finds the repo's
// own package.json, so the gate "passed" in development.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { runNativeTask } from './nativeEngine'
import type { EngineProviders } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

const OK = JSON.stringify({ task_id: 't-cwd' })

function lastArgs(): Record<string, unknown> {
  return invokeMock.mock.calls[invokeMock.mock.calls.length - 1][1] as Record<string, unknown>
}

describe('native run — the Tier-1 working directory reaches the bridge', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(OK)
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('forwards the project directory the verify command must run in', async () => {
    await runNativeTask('do a thing', '/vault', {
      tier1: 'npm test',
      tier1Cwd: '/Users/me/repo',
    } as EngineProviders)
    expect(lastArgs().tier1Cwd).toBe('/Users/me/repo')
  })

  it('forwards an EMPTY cwd rather than omitting it — the engine must be told', async () => {
    // Omitting it is what caused the bug: the engine then silently used its own
    // directory. An empty value is a real message ("no project directory
    // configured"), which the engine fails honestly on.
    await runNativeTask('do a thing', '/vault', { tier1: 'npm test' } as EngineProviders)
    expect(lastArgs().tier1Cwd).toBe('')
  })

  it('sends it even with no providers object at all', async () => {
    await runNativeTask('do a thing', '/vault')
    expect(lastArgs().tier1Cwd).toBe('')
  })
})

// The Rust half of the same wire. A TS test cannot execute the bridge, but it
// can read it: the pairing of `--tier1` with `--tier1-cwd` is the whole fix, and
// nothing else pins it.
describe('the Rust bridge pairs --tier1 with --tier1-cwd', () => {
  function runEngineTaskBody(): string {
    const start = libRs.indexOf('async fn run_engine_task(')
    expect(start).toBeGreaterThan(-1)
    const end = libRs.indexOf('async fn run_engine_verify(')
    expect(end).toBeGreaterThan(start)
    return libRs.slice(start, end)
  }

  it('run_engine_task accepts a tier1_cwd parameter', () => {
    expect(runEngineTaskBody()).toMatch(/tier1_cwd:\s*Option<String>/)
  })

  it('run_engine_task pushes --tier1-cwd wherever it pushes --tier1', () => {
    const body = runEngineTaskBody()
    const tier1Pushes = body.match(/args\.push\("--tier1"\)/g) ?? []
    const cwdPushes = body.match(/args\.push\("--tier1-cwd"\)/g) ?? []
    expect(tier1Pushes.length).toBeGreaterThan(0)
    expect(cwdPushes.length).toBe(tier1Pushes.length)
  })

  it('run_engine_verify still passes the project dir it always did', () => {
    const start = libRs.indexOf('async fn run_engine_verify(')
    const body = libRs.slice(start, start + 4000)
    expect(body).toMatch(/args\.push\("--tier1-cwd"\)/)
  })
})
