import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * F1, client half — a refine loop's attempt history has to reach the surfaces a
 * user actually looks at.
 *
 * The engine keeps every attempt as its own verdict and links them through
 * `extras.attempt` (+ the group's ledger). None of that is worth anything if the
 * client drops the number on the floor: two attempts then render identically,
 * and "did refining fix it?" stays unanswerable in the product itself.
 *
 * The other half is what must NOT happen: an untracked run has no attempt
 * number, and inventing "attempt 1" for it would be a guess dressed as history.
 */
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { runNativeProject } from './nativeEngine'
import type { EngineProviders } from './nativeEngine'

const providers: EngineProviders = { baseUrl: '', apiKey: '' }

function goNative() {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
}

function raw(extras: Record<string, unknown>): string {
  return JSON.stringify({
    task_id: 'build-a-small-node-cli-called-vault-dige-ff759f1b',
    tier1: { ran: true, passed: false, commands: ['npm test'], log: '4 of 6 failed' },
    tier2: { ran: false },
    tokens_spent: 14318,
    model_route: ['cloud', 'local'],
    hooks_fired: ['tier1'],
    artifacts: [],
    passed: false,
    outcome: 'failed',
    timestamp: '2026-08-17T01:01:31Z',
    extras,
  })
}

describe('mapVerdict — refine attempt lineage', () => {
  beforeEach(() => {
    goNative()
    invokeMock.mockReset()
  })

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('carries the attempt number, group and the attempt it is fixing', async () => {
    invokeMock.mockResolvedValue(
      raw({
        project: { files_written: ['digest.js'] },
        attempt: {
          number: 2,
          group: 'p1:step-0',
          previous_task_id: 'build-a-small-node-cli-called-vault-dige-aaaa1111',
          is_refine: true,
          index: 'verdicts/attempts/p1-step-0-1234abcd.json',
        },
      }),
    )
    const v = await runNativeProject('build a CLI', '/p', '/v', providers)
    expect(v!.attempt).toEqual({
      number: 2,
      group: 'p1:step-0',
      isRefine: true,
      previousTaskId: 'build-a-small-node-cli-called-vault-dige-aaaa1111',
    })
  })

  it('leaves attempt UNDEFINED for an untracked run — never a synthesised "attempt 1"', async () => {
    invokeMock.mockResolvedValue(raw({ project: { files_written: ['digest.js'] } }))
    const v = await runNativeProject('build a CLI', '/p', '/v', providers)
    expect(v!.attempt).toBeUndefined()
  })

  it('ignores a malformed/zero attempt number rather than trusting it', async () => {
    invokeMock.mockResolvedValue(raw({ attempt: { number: 0, group: 'p1:step-0' } }))
    const v = await runNativeProject('build a CLI', '/p', '/v', providers)
    expect(v!.attempt).toBeUndefined()
  })

  it('forwards attempt/group/previous-verdict to the bridge, and omits them when untracked', async () => {
    invokeMock.mockResolvedValue(raw({}))
    await runNativeProject('build a CLI', '/p', '/v', providers, {
      refineFeedback: '4 of 6 tests failed',
      attempt: 2,
      attemptGroup: 'p1:step-0',
      previousVerdict: '/v/verdicts/prev.json',
    })
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      attempt: 2,
      attemptGroup: 'p1:step-0',
      previousVerdict: '/v/verdicts/prev.json',
    })

    invokeMock.mockReset()
    invokeMock.mockResolvedValue(raw({}))
    await runNativeProject('build a CLI', '/p', '/v', providers)
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      attempt: 0,
      attemptGroup: '',
      previousVerdict: '',
    })
  })
})
