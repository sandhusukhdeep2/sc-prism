// HeartbeatNotice — the visible half of the always-on manager (2026-08-05
// §Part 3). The heartbeat now turns itself ON once setup completes, and that
// is only defensible because this banner exists: a background loop that spends
// real tokens must never be something the user first learns about from a bill.
//
// Why THIS surface (a shell-level banner) rather than a line on the last
// onboarding screen:
//  - The final wizard screen cannot reach the installs that finished setup
//    weeks ago, and those users get default-on too. One banner covers both the
//    fresh finish and the back-fill, so there is exactly one implementation of
//    the disclosure and no user path that misses it.
//  - It lives in AppShell, so it is on whatever page he lands on, and it
//    persists across relaunches until he answers — closing the app right after
//    setup cannot swallow it (a wizard-screen line would be gone forever).
//  - It is not a modal: it does not block the workspace, it just refuses to go
//    away by itself. Nothing about the flip is hidden and nothing is forced.
//
// It renders ONLY while a real obligation exists (heartbeatNoticeDue: the app
// flipped it AND the user has not answered), and either button writes a real
// decision — which is also what stops the default-on from ever firing again.
import { Link } from 'react-router-dom'
import {
  COMPANION_MANAGER_ID,
  cadenceLabel,
  heartbeatConsentCopy,
  heartbeatNoticeDue,
  managerDisplayName,
  useManagerActions,
  useManagers,
} from '../lib/managers'
import { useSettings } from '../lib/settings'
import './HeartbeatNotice.css'

export default function HeartbeatNotice() {
  const ms = useManagers()
  const { settings } = useSettings()
  const { answerNotice } = useManagerActions()

  const companion = ms.managers.find((m) => m.id === COMPANION_MANAGER_ID)
  const hb = companion?.heartbeat
  if (!companion || !hb || !heartbeatNoticeDue(hb)) return null

  const name = managerDisplayName(companion, settings)
  return (
    <div className="hbnotice" role="status" aria-label={`${name}'s heartbeat is now on`}>
      <div className="hbnotice__body">
        <div className="hbnotice__title">
          {name}&rsquo;s heartbeat is now on — setup is complete, so it stands by for you.
        </div>
        <div className="hbnotice__copy">{heartbeatConsentCopy(name, hb.everyMinutes)}</div>
        <div className="hbnotice__copy mono">
          First check in one cadence ({cadenceLabel(hb.everyMinutes)}) — nothing has run yet.
        </div>
      </div>
      <div className="hbnotice__actions">
        <button
          type="button"
          className="hbnotice__btn hbnotice__btn--off"
          onClick={() => answerNotice(companion.id, false)}
        >
          Turn it off
        </button>
        <button
          type="button"
          className="hbnotice__btn hbnotice__btn--keep"
          onClick={() => answerNotice(companion.id, true)}
        >
          Keep it on
        </button>
        <Link className="hbnotice__link" to="/agents">
          settings
        </Link>
      </div>
    </div>
  )
}
