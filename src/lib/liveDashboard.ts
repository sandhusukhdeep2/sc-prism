// The ONE shared live-refresh helper for the engine-observability pages
// (Finding 5, 2026-08-09 honesty pass).
//
// Stats / Console / Memory each snapshotted the engine dashboard once and then
// went stale: a run could finish while the user watched the page and nothing
// moved. They now share this hook, which:
//
//  - fetches once (mount, and whenever the vault or the caller's key changes);
//  - polls every DASH_POLL_MS *only* while a run is genuinely live (the caller
//    passes `activeRuns(state.liveRuns).length > 0`, the app's single source of
//    live-run truth). A dashboard read is 60-90ms, so a 2.5s poll during a run
//    is cheap;
//  - does NOT poll when idle — no timer exists at all in that case, so an idle
//    app spends nothing and a page can never animate over a dead engine.
//
// It reports a STATUS, not just a dashboard, because "no dashboard" had three
// different causes that the pages were narrating as one:
//
//  - 'loading'  the first read has not come back yet. The hook used to start at
//               `null`, which is the same value it uses for "no engine", so
//               every mount painted the session fallback (Memory: "local
//               handles 0% of this session's routed work") for one frame before
//               snapping to the measured 86%. A number the page has not read
//               yet is not a measurement, and it does not get rendered as one.
//  - 'none'     there is no engine to read (the browser).
//  - 'stale'    a read FAILED but an earlier one succeeded. The last good
//               measurement is kept and marked, so a transient failure cannot
//               rewrite a measured number to zero.
//  - 'failed'   a read failed and nothing was ever measured.

import { useEffect, useRef, useState } from 'react'
import type { Dashboard } from '../engine/types'
import { isNative, readNativeDashboard, resolveVaultDir } from './nativeEngine'

/** Poll period while a run is live. Idle = no polling at all. */
export const DASH_POLL_MS = 2500

export type DashStatus = 'loading' | 'ok' | 'stale' | 'failed' | 'none'

export interface LiveDashboard {
  /** The newest dashboard that was actually read. Null until one is. */
  dash: Dashboard | null
  status: DashStatus
  /** Why the last read failed ('stale' | 'failed'), else null. */
  error: string | null
  /** When the last read failed, epoch ms ('stale' | 'failed'), else null. */
  failedAt: number | null
}

/** "engine read failed at 14:32 — showing the last measurement", or null. */
export function staleNote(live: LiveDashboard): string | null {
  if (live.failedAt === null) return null
  const at = new Date(live.failedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
  return live.status === 'stale'
    ? `engine read failed at ${at} — showing the last measurement`
    : `engine read failed at ${at} — nothing measured yet`
}

export function useLiveDashboard(
  vaultPath: string,
  live: boolean,
  /** Any value that should force an immediate refetch (e.g. verdicts.length). */
  refetchKey: unknown = 0,
): LiveDashboard {
  const [result, setResult] = useState<LiveDashboard>(() => ({
    dash: null,
    status: isNative() ? 'loading' : 'none',
    error: null,
    failedAt: null,
  }))
  // Monotonic sequence: a slow fetch that started EARLIER must never overwrite
  // a newer one that already landed. With a 2.5s poll and a read that can spike
  // past it, out-of-order completion is not hypothetical, and the loser would
  // silently install an older dashboard as the current measurement.
  const seq = useRef(0)
  const latest = useRef(0)

  useEffect(() => {
    if (!isNative()) return
    let cancelled = false
    const fetchDash = async () => {
      const mine = ++seq.current
      const vault = await resolveVaultDir(vaultPath)
      const read = await readNativeDashboard(vault)
      if (cancelled || mine <= latest.current) return
      latest.current = mine
      setResult((prev) => {
        if (read.kind === 'ok') {
          return { dash: read.dash, status: 'ok', error: null, failedAt: null }
        }
        if (read.kind === 'no-engine') {
          return { dash: null, status: 'none', error: null, failedAt: null }
        }
        // A failed read never erases a measurement that was really taken.
        return {
          dash: prev.dash,
          status: prev.dash ? 'stale' : 'failed',
          error: read.error,
          failedAt: Date.now(),
        }
      })
    }
    void fetchDash()
    if (!live) {
      return () => {
        cancelled = true
      }
    }
    const timer = setInterval(() => void fetchDash(), DASH_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [vaultPath, live, refetchKey])

  return result
}
