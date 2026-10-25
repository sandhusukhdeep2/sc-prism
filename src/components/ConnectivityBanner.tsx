// One dismissible Workspace banner naming the first down service. Dismissal
// lives in the connectivity store so it survives route changes and reopens
// on the next healthy→down transition (spec §2).
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { isEffectivelyDown, probeTargets, type ConnectivityValue } from '../lib/connectivity'
import { isCliProvider, useSettings } from '../lib/settings'
import './ConnectivityBanner.css'
import Icon from './Icon'

export default function ConnectivityBanner({ conn }: { conn: ConnectivityValue }) {
  const { settings } = useSettings()
  const [busy, setBusy] = useState(false)
  if (!conn.anyDown || conn.bannerDismissed) return null
  const down = probeTargets(settings).filter((p) => isEffectivelyDown(conn.health[p.id]))
  if (down.length === 0) return null
  const first = down[0]
  const h = conn.health[first.id]
  // While a Retry sweep is in flight, fall back to the last settled status so
  // the copy doesn't wobble to a generic/blank state mid-probe.
  const status = h?.status === 'checking' ? h.prev : h?.status
  // SAY ONLY WHAT WAS MEASURED. This banner used to collapse every failed CLI
  // probe into "isn't installed on this Mac" — so a CLI that is installed and
  // working, whose probe merely timed out or was refused, was reported as
  // missing. Sukhdeep had Claude Code 2.1.220 installed and answering in 7s
  // while the app told him to go install it, which is the most expensive kind
  // of lie this product can tell: it sends you to fix something that is not
  // broken, and it makes the whole crew look dead.
  //
  // The three CLI states are already distinguished everywhere else (see
  // `seatReason` in lib/roster.ts, and `cliStatusLabel`); this now matches
  // them. 'unreachable' is the only state that means the binary was not found.
  const text = isCliProvider(first.id)
    ? status === 'unreachable'
      ? `${first.name} isn't installed on this Mac.`
      : `${first.name} is installed but couldn't answer — check it is signed in.`
    : status === 'auth'
      ? `${first.name} rejected your API key.`
      : `${first.name} is unreachable — is the server running?`
  const suffix = down.length > 1 ? ` (+${down.length - 1} more)` : ''
  const retry = async () => {
    setBusy(true)
    try {
      await conn.probeAll()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="connbanner" role="alert" data-testid="conn-banner">
      <i className={'dot ' + (status === 'auth' ? 'dot--warn' : 'dot--danger')} />
      <span className="connbanner__text">
        {text}
        {suffix}
      </span>
      <button className="connbanner__btn" onClick={() => void retry()} disabled={busy}>
        {busy ? 'checking…' : 'Retry'}
      </button>
      <Link className="connbanner__btn" to="/providers">
        Open Providers
      </Link>
      <button className="connbanner__dismiss" aria-label="Dismiss" onClick={conn.dismissBanner}>
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
