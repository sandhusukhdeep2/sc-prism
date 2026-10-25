// Global AI-health indicator for the top bar. Renders NOTHING while healthy
// (no new chrome in the good state); when a connected service is down it
// shows a danger/warn dot + the service name and links to /providers.
import { Link } from 'react-router-dom'
import {
  downLabel,
  isEffectivelyDown,
  probeTargets,
  type ConnectivityValue,
  type HealthStatus,
} from '../lib/connectivity'
import { useSettings } from '../lib/settings'

export default function ConnectivityDot({ conn }: { conn: ConnectivityValue }) {
  const { settings } = useSettings()
  if (!conn.anyDown) return null
  // Scope to current probe targets: a stale health entry for a provider the
  // user has since disabled/disconnected must not appear in the count/tooltip.
  const down = probeTargets(settings).filter((p) => isEffectivelyDown(conn.health[p.id]))
  if (down.length === 0) return null
  // While a Retry sweep is in flight, fall back to the last settled status so
  // the danger/warn styling and copy don't wobble mid-probe.
  const statusOf = (id: string): HealthStatus | undefined => {
    const h = conn.health[id]
    return h?.status === 'checking' ? h.prev : h?.status
  }
  const worstIsUnreachable = down.some((p) => statusOf(p.id) === 'unreachable')
  const checkedAt = (id: string): string => {
    const t = conn.health[id]?.lastChecked
    if (!t) return ''
    const d = new Date(t)
    const pad = (n: number) => String(n).padStart(2, '0')
    return ` · checked ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const title = down
    .map((p) => `${p.name} — ${downLabel(p, statusOf(p.id))}${checkedAt(p.id)}`)
    .join(' · ')
  return (
    <Link to="/providers" className="status mono" title={title} data-testid="conn-dot">
      <i className={'dot ' + (worstIsUnreachable ? 'dot--danger' : 'dot--warn')} />
      {down.length === 1 ? down[0].name : `${down.length} AIs down`}
    </Link>
  )
}
