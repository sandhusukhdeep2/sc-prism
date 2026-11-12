import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import libRs from '../../src-tauri/src/lib.rs?raw'

// Each provider's own thinking effort has to reach the engine on EVERY kind of
// run that can seat more than one AI — or a seat inherits the primary's level
// again (see lib/efforts.ts).
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { runNativeProject, runNativeTask, runNativeTeam } from './nativeEngine'
import type { EngineProviders } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

const last = () => invokeMock.mock.calls[invokeMock.mock.calls.length - 1][1] as Record<string, unknown>
const providers = { efforts: 'claude-cli=max,gemini=low' } as EngineProviders

describe('each provider’s own effort reaches the engine', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(JSON.stringify({ task_id: 't', run_id: 'r', board: [] }))
  })
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('on a chat or task run', async () => {
    await runNativeTask('x', '/vault', providers)
    expect(last().efforts).toBe('claude-cli=max,gemini=low')
  })

  it('on a team run', async () => {
    await runNativeTeam('x', '/vault', providers, 'lead:claude-cli,critic:gemini')
    expect(last().efforts).toBe('claude-cli=max,gemini=low')
  })

  it('on a project build step', async () => {
    await runNativeProject('x', '/Users/someone/site', '/vault', providers, {})
    expect(last().efforts).toBe('claude-cli=max,gemini=low')
  })

  it('a caller that has none sends an empty value, not a missing one', async () => {
    await runNativeTask('x', '/vault', {} as EngineProviders)
    expect(last().efforts).toBe('')
  })
})

describe('the Rust bridge sets SCPRISM_EFFORTS through one checked helper', () => {
  it('on task, project and team runs', () => {
    for (const from of ['async fn run_engine_task(', 'async fn run_engine_project(', 'async fn run_engine_team(']) {
      const start = libRs.indexOf(from)
      expect(start).toBeGreaterThan(-1)
      const end = libRs.indexOf('\n#[tauri::command]', start)
      expect(libRs.slice(start, end)).toContain('set_efforts_env(&mut cmd, efforts.as_deref())')
    }
  })
})
