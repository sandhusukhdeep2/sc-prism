import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import libRs from '../../src-tauri/src/lib.rs?raw'

// The folder a turn is ABOUT has to reach the engine, or the answer is about
// nothing: a real team run in a project's room said there was no hello.md to
// rewrite, because it had been handed the words and nothing of the folder.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { runNativeProject, runNativeTask, runNativeTeam } from './nativeEngine'
import type { EngineProviders } from './nativeEngine'

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

function lastCall(): { cmd: string; args: Record<string, unknown> } {
  const c = invokeMock.mock.calls[invokeMock.mock.calls.length - 1]
  return { cmd: c[0] as string, args: c[1] as Record<string, unknown> }
}

describe('the project folder reaches the engine', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(JSON.stringify({ task_id: 't', run_id: 'r', board: [] }))
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('a chat turn carries the folder it is about', async () => {
    await runNativeTask('what does hello.md say?', '/vault', {
      projectDir: '~/vault/projects/hello-crew',
    } as EngineProviders)
    expect(lastCall().cmd).toBe('run_engine_task')
    expect(lastCall().args.projectDir).toBe('~/vault/projects/hello-crew')
  })

  it('a chat turn with no project carries an empty folder', async () => {
    await runNativeTask('hello', '/vault', {} as EngineProviders)
    expect(lastCall().args.projectDir).toBe('')
  })

  it('a team run carries the folder it is about', async () => {
    await runNativeTeam('what does hello.md say?', '/vault', {
      projectDir: '/Users/someone/site',
    } as EngineProviders, 'lead:claude')
    expect(lastCall().cmd).toBe('run_engine_team')
    expect(lastCall().args.projectDir).toBe('/Users/someone/site')
  })

  it('a job for the folder asks the build to show the folder', async () => {
    await runNativeProject('fix the footer', '/Users/someone/site', '/vault', {} as EngineProviders, {
      showFolder: true,
    })
    expect(lastCall().cmd).toBe('run_engine_project')
    expect(lastCall().args.showFolder).toBe(true)
  })

  it('a plan step does not ask for it', async () => {
    await runNativeProject('step 1', '/Users/someone/site', '/vault', {} as EngineProviders, {})
    expect(lastCall().args.showFolder).toBe(false)
  })
})

// The Rust half of the same wire, read rather than run.
describe('the Rust bridge passes the folder on', () => {
  function body(from: string, to: string): string {
    const start = libRs.indexOf(from)
    expect(start).toBeGreaterThan(-1)
    const end = libRs.indexOf(to, start + from.length)
    expect(end).toBeGreaterThan(start)
    return libRs.slice(start, end)
  }

  it('run and team both send --project-dir through the one checked helper', () => {
    for (const [from, to] of [
      ['async fn run_engine_task(', 'async fn run_engine_verify('],
      ['async fn run_engine_team(', '\n#[tauri::command]'],
    ] as const) {
      const src = body(from, to)
      expect(src).toContain('project_dir_arg(')
      expect(src).toContain('"--project-dir"')
    }
  })

  it('the project command sends --show-folder only when asked', () => {
    const src = body('async fn run_engine_project(', 'async fn run_engine_team(')
    expect(src).toMatch(/if show_folder\.unwrap_or\(false\) \{\s*args\.push\("--show-folder"\);/)
  })
})
