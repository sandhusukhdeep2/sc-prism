// The check runs by itself on the day's first launch (the owner, 2026-11-14:
// "every time when we start working for the day"), once, and speaks only when
// there is something to say.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useDailyModelCheck } from './useDailyModelCheck'
import { saveModelCheck } from './modelCheckRun'
import type { ModelCheckResult } from './modelCheck'

const at = (d: number, h = 9) => new Date(2026, 10, d, h).getTime()
const quiet = (now: number): ModelCheckResult => ({ at: now, moves: [], fresh: [], skipped: [] })

function setup(over: { ready?: boolean; now?: number; result?: (now: number) => ModelCheckResult } = {}) {
  const now = over.now ?? at(14)
  const check = vi.fn(async (t: number) => {
    const r = (over.result ?? quiet)(t)
    saveModelCheck({ catalog: {}, last: r })
    return r
  })
  const notify = vi.fn()
  const view = renderHook(
    ({ ready }: { ready: boolean }) => useDailyModelCheck({ ready, check, notify, now: () => now }),
    { initialProps: { ready: over.ready ?? true } },
  )
  return { check, notify, view }
}

beforeEach(() => {
  localStorage.clear()
})

describe('useDailyModelCheck', () => {
  it('checks on the first launch of the day', async () => {
    const { check } = setup()
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1))
    expect(check).toHaveBeenCalledWith(at(14))
  })

  it('does not check again the same day', async () => {
    saveModelCheck({ catalog: {}, last: quiet(at(14, 7)) })
    const { check } = setup({ now: at(14, 18) })
    await new Promise((r) => setTimeout(r, 10))
    expect(check).not.toHaveBeenCalled()
  })

  it('waits until the app is ready (native, settings read from disk)', async () => {
    const { check, view } = setup({ ready: false })
    await new Promise((r) => setTimeout(r, 10))
    expect(check).not.toHaveBeenCalled()
    view.rerender({ ready: true })
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1))
  })

  it('an app left open overnight checks when you come back to it', async () => {
    saveModelCheck({ catalog: {}, last: quiet(at(13, 22)) })
    let now = at(13, 23)
    const check = vi.fn(async (t: number) => {
      saveModelCheck({ catalog: {}, last: quiet(t) })
      return quiet(t)
    })
    renderHook(() => useDailyModelCheck({ ready: true, check, notify: vi.fn(), now: () => now }))
    await new Promise((r) => setTimeout(r, 10))
    expect(check).not.toHaveBeenCalled()
    now = at(14, 8)
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1))
  })

  it('says nothing when nothing changed', async () => {
    const { check, notify } = setup()
    await waitFor(() => expect(check).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(notify).not.toHaveBeenCalled()
  })

  it('says what moved, in one line', async () => {
    const { notify } = setup({
      result: (now) => ({
        at: now,
        moves: [{ providerId: 'claude-cli', name: 'Claude Code', from: 'opus', to: 'fable', why: 'greatest' }],
        fresh: [],
        skipped: [],
      }),
    })
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Claude Code now runs on fable (was opus)'),
    )
  })
})
