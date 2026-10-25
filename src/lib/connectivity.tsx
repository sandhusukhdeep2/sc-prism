// Live AI connectivity. Probes every *connected* service once at cold start
// and on demand (Retry / the chat send guard). In-memory only — a persisted
// status would be the same staleness bug (the sticky `connected` flag) this
// store exists to fix. Deliberately NO timers and NO focus listeners.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  cliStatusLabel,
  isCliProvider,
  pingProvider,
  useSettings,
  type ProviderConfig,
  type ProviderStatus,
  type Settings,
} from './settings'

/** 'checking' while a probe is in flight; otherwise the last probe result. */
export type HealthStatus = 'checking' | ProviderStatus

export interface ServiceHealth {
  status: HealthStatus
  /** Epoch ms of the last settled probe (0 while the first is in flight). */
  lastChecked: number
  /** The last SETTLED status, carried through a 'checking' phase only — lets
   *  a re-probe be told apart from a genuine first check. Meaningless once
   *  status has settled again (may be left stale or cleared on settle). */
  prev?: ProviderStatus
}

/** 'auth' and 'unreachable' are down; 'checking' is not (no red flash at boot). */
export function isDown(status: HealthStatus | undefined): boolean {
  return status === 'auth' || status === 'unreachable'
}

/** Down now, or mid-probe and down at the last settled check — keeps the
 *  dot/banner visible (with their busy affordance) through a Retry sweep
 *  instead of blinking out. Cold start stays flash-free: no prev yet. */
export function isEffectivelyDown(h: ServiceHealth | undefined): boolean {
  if (!h) return false
  if (h.status === 'checking') return isDown(h.prev)
  return isDown(h.status)
}

/** Short state label matching the Providers-page vocabulary. For a CLI bridge
 *  the two failures are DIFFERENT problems — not installed at all, versus
 *  installed and unable to answer (signed out, or a login the vendor closed) —
 *  and collapsing them into one green "installed" is what let a dead CLI keep
 *  taking work. `cliStatusLabel` owns those words. */
export function downLabel(p: ProviderConfig, status: HealthStatus | undefined): string {
  if (isCliProvider(p.id)) {
    return status === 'auth' ? `installed, ${cliStatusLabel('auth')}` : cliStatusLabel('unreachable')
  }
  return status === 'auth' ? 'needs a key' : 'unreachable'
}

/** The services worth probing: everything the user connected, plus the primary. */
export function probeTargets(settings: Settings): ProviderConfig[] {
  return settings.providers.filter((p) => p.enabled && (p.connected || p.primary))
}

export interface ConnectivityValue {
  /** Keyed by provider id; only probe targets appear. */
  health: Record<string, ServiceHealth>
  anyDown: boolean
  primaryDown: boolean
  /** Banner dismissal: lasts until the next healthy→down transition or cold start. */
  bannerDismissed: boolean
  dismissBanner: () => void
  /** One coalesced sweep over all targets; concurrent calls share the promise. */
  probeAll: () => Promise<void>
  /** Fresh probe of one service (the chat send guard uses this). */
  probeOne: (id: string) => Promise<ProviderStatus>
  /** A real call failed mid-flight: record it without re-probing. */
  markUnreachable: (id: string) => void
}

const ConnectivityContext = createContext<ConnectivityValue | null>(null)

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const { settings, hydrated } = useSettings()
  const [health, setHealth] = useState<Record<string, ServiceHealth>>({})
  const [bannerDismissed, setBannerDismissed] = useState(false)

  // Async closures read settings fresh via a ref (AppStore's settingsRef
  // pattern) so a sweep started before a settings edit pings current URLs.
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Tracks the previous "down" aggregate so a healthy→down transition can
  // reopen a dismissed banner.
  const anyDownRef = useRef(false)

  const applyResults = useCallback((patch: Record<string, ServiceHealth>) => {
    setHealth((prev) => ({ ...prev, ...patch }))
  }, [])

  // Healthy→down transition detection. Runs as an effect — not inside the
  // setHealth updater — so state updaters stay pure (StrictMode double-invokes
  // them). Scoped to CURRENT probe targets so a stale entry for a since-
  // disabled provider can't trigger (or suppress) a transition.
  useEffect(() => {
    const targetIds = new Set(probeTargets(settings).map((p) => p.id))
    const statuses = [...targetIds].map((id) => health[id]?.status)
    // A probe in flight is neither up nor down — wait for it to settle, or a
    // re-probe's 'checking' phase would register as healthy and make the
    // settled still-down result look like a fresh healthy→down transition
    // (wrongly reopening a dismissed banner).
    if (statuses.some((s) => s === 'checking')) return
    const downNow = statuses.some((s) => isDown(s))
    if (downNow && !anyDownRef.current) setBannerDismissed(false)
    anyDownRef.current = downNow
  }, [health, settings])

  // Prune health entries for providers that have left the target set (disabled
  // or disconnected). Otherwise a stale 'unreachable'/'auth' entry would make
  // the provider count as down again the instant it's re-enabled, before any
  // re-probe — it should start unknown instead.
  useEffect(() => {
    const ids = new Set(probeTargets(settings).map((p) => p.id))
    setHealth((prev) => {
      const stale = Object.keys(prev).filter((id) => !ids.has(id))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const id of stale) delete next[id]
      return next
    })
  }, [settings])

  const sweepRef = useRef<Promise<void> | null>(null)
  const probeAll = useCallback((): Promise<void> => {
    if (sweepRef.current) return sweepRef.current
    const sweep = (async () => {
      const targets = probeTargets(settingsRef.current)
      if (targets.length === 0) return
      setHealth((prev) => {
        const marks: Record<string, ServiceHealth> = {}
        for (const p of targets) {
          const prior = prev[p.id]
          marks[p.id] = {
            status: 'checking',
            lastChecked: prior?.lastChecked ?? 0,
            prev: prior?.status === 'checking' ? prior.prev : (prior?.status as ProviderStatus | undefined),
          }
        }
        return { ...prev, ...marks }
      })
      const results = await Promise.all(
        targets.map(
          async (p) =>
            [
              p.id,
              await pingProvider(p.baseUrl, p.apiKey, p.id).catch(
                (): ProviderStatus => 'unreachable',
              ),
            ] as const,
        ),
      )
      const patch: Record<string, ServiceHealth> = {}
      for (const [id, status] of results) patch[id] = { status, lastChecked: Date.now() }
      applyResults(patch)
    })().finally(() => {
      sweepRef.current = null
    })
    sweepRef.current = sweep
    return sweep
  }, [applyResults])

  const probeOne = useCallback(
    async (id: string): Promise<ProviderStatus> => {
      const p = settingsRef.current.providers.find((x) => x.id === id)
      if (!p) return 'unreachable'
      setHealth((prev) => {
        const prior = prev[id]
        return {
          ...prev,
          [id]: {
            status: 'checking',
            lastChecked: prior?.lastChecked ?? 0,
            prev: prior?.status === 'checking' ? prior.prev : (prior?.status as ProviderStatus | undefined),
          },
        }
      })
      const status = await pingProvider(p.baseUrl, p.apiKey, p.id).catch(
        (): ProviderStatus => 'unreachable',
      )
      applyResults({ [id]: { status, lastChecked: Date.now() } })
      return status
    },
    [applyResults],
  )

  const markUnreachable = useCallback(
    (id: string) => {
      applyResults({ [id]: { status: 'unreachable', lastChecked: Date.now() } })
    },
    [applyResults],
  )

  // Cold-start probe: once, after the settings disk copy has been read.
  // In the browser `hydrated` starts true, so this runs on mount.
  const coldStarted = useRef(false)
  useEffect(() => {
    if (!hydrated || coldStarted.current) return
    coldStarted.current = true
    void probeAll()
  }, [hydrated, probeAll])

  const value = useMemo<ConnectivityValue>(() => {
    const primary = settings.providers.find((p) => p.primary && p.enabled)
    // Aggregates count only CURRENT probe targets: a stale health entry for a
    // provider the user has since disabled/disconnected must not pin anyDown.
    const targetIds = new Set(probeTargets(settings).map((p) => p.id))
    return {
      health,
      anyDown: Object.entries(health).some(
        ([id, h]) => targetIds.has(id) && isEffectivelyDown(h),
      ),
      primaryDown: isEffectivelyDown(primary ? health[primary.id] : undefined),
      bannerDismissed,
      dismissBanner: () => setBannerDismissed(true),
      probeAll,
      probeOne,
      markUnreachable,
    }
  }, [health, bannerDismissed, settings, probeAll, probeOne, markUnreachable])

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>
}

export function useConnectivity(): ConnectivityValue {
  const ctx = useContext(ConnectivityContext)
  if (!ctx) throw new Error('useConnectivity must be used within <ConnectivityProvider>')
  return ctx
}
