import { describe, expect, it } from 'vitest'
import { listenNative } from '../lib/nativeEngine'

// THE MANAGER'S CLOCK MOVED OUT OF THE PAGE. Both drivers were
// `window.setInterval`, and macOS throttles timers hard in a hidden or occluded
// WKWebView — a minimised app can go minutes between ticks, and a manager that
// only wakes while someone is looking at it is not a manager.
//
// The real clock is now an OS thread in the Rust process emitting
// `scprism://manager-tick`. The page's interval stays as a fallback, and the
// driver's existing busy guard makes an overlapping tick a no-op.
describe('listenNative — how the OS tick reaches the driver', () => {
  it('is a no-op unsubscribe in the browser, so callers can register blind', async () => {
    const off = await listenNative('scprism://manager-tick', () => {})
    expect(typeof off).toBe('function')
    // Calling it must not throw — there was nothing to unsubscribe.
    expect(() => off()).not.toThrow()
  })

  it('never throws when the event API is unavailable', async () => {
    // An older shell, or a failed dynamic import: the caller's fallback
    // interval is still running, so this degrades to exactly what it was.
    await expect(listenNative('anything', () => {})).resolves.toBeTypeOf('function')
  })
})

// The two clocks are safe to overlap BY CONSTRUCTION, which is what makes
// running both acceptable rather than a double-run hazard.
describe('two clocks, one driver', () => {
  it('the busy guard is what makes an overlapping tick free', async () => {
    const { engineBusy } = await import('./AppStore')
    // A tick that arrives while the manager is mid-run returns immediately.
    expect(engineBusy(false, true, [])).toBe(true)
    // …and one that arrives while a project run holds the engine slot, too.
    expect(engineBusy(false, false, [{ status: 'running' } as never])).toBe(true)
    // Idle: the tick proceeds, which is the only case that should do work.
    expect(engineBusy(false, false, [])).toBe(false)
  })
})
