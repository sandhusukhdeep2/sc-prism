// useNow — the app's ONE live wall clock for elapsed-time labels.
//
// Extracted from LiveRunCards (2026-08-16) so every surface that shows "how
// long has this been running" ticks the same way instead of growing its own
// copy: the Live-run cards and the Work page's Live agent card now share it.
//
// HONESTY: it ticks ONLY while something is genuinely live (`active`) — an
// idle page ticks nothing, so no surface can animate a clock over a run that
// isn't happening. `fixed` short-circuits it entirely so tests inject time.
import { useEffect, useState } from 'react'

export function useNow(active: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (fixed !== undefined || !active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active, fixed])
  return fixed ?? now
}

/**
 * useSilenceClock — a slow clock for watching for the ABSENCE of something.
 *
 * `useNow` above ticks every second and only while something is genuinely
 * live, because it labels elapsed time on real work. This one exists for the
 * opposite case, and needs the opposite rule: a thing that has STOPPED emits
 * no events, changes no state and re-renders nothing, so a surface that
 * reports it has no other way to look again. Left to the store alone, the
 * notice that the manager died could only appear if something else happened —
 * and by definition nothing else is happening.
 *
 * Ticks slowly (30s by default) and only while `active`. `fixed` short-circuits
 * it entirely so tests inject time.
 */
export function useSilenceClock(active: boolean, everyMs = 30_000, fixed?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (fixed !== undefined || !active) return
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [active, everyMs, fixed])
  return fixed ?? now
}
