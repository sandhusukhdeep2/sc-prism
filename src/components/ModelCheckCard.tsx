// Settings → Your AIs: what the day's model check found, whether it may move
// an AI to a newer model, and a way to run it now. The rules for a move live
// in lib/modelCheck.ts; this card only shows them at work.
import { useState, type KeyboardEvent } from 'react'
import { isNative } from '../lib/nativeEngine'
import { modelCheckLine, type ModelCheckResult } from '../lib/modelCheck'
import { runModelCheck, useModelCheck } from '../lib/modelCheckRun'
import { modelCheckDeps } from '../lib/useDailyModelCheck'
import { useSettings } from '../lib/settings'
import './ModelCheckCard.css'

/** "today at 9:02" for a check made today, else "14 Nov at 9:02". */
export function checkedWhen(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay
    ? `today at ${time}`
    : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${time}`
}

/** What the last check came to, as one sentence. */
export function checkOutcome(last: ModelCheckResult | null, now: number): string {
  if (!last) return 'Not checked yet — it runs on the day’s first launch.'
  const line = modelCheckLine(last)
  return `Checked ${checkedWhen(last.at, now)} — ${line || 'every AI is on its newest model, and nothing new was listed'}.`
}

function onActivate(handler: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handler()
    }
  }
}

export default function ModelCheckCard() {
  const { settings, updateProvider, setAutoNewestModel } = useSettings()
  const { last } = useModelCheck()
  const [busy, setBusy] = useState(false)
  const auto = settings.autoNewestModel

  const checkNow = async () => {
    setBusy(true)
    try {
      await runModelCheck(modelCheckDeps(settings, updateProvider, Date.now()))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings__provider modelcheck">
      <div className="settings__prow">
        <span className="settings__kicker">Newest models</span>
        <span className="settings__spacer" />
        {isNative() && (
          <button type="button" className="modelcheck__now" disabled={busy} onClick={() => void checkNow()}>
            {busy ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>
      <p className="modelcheck__outcome" aria-live="polite">
        {checkOutcome(last, Date.now())}
      </p>
      <div className="settings__prow settings__extrow">
        <span
          className={'settings__toggle ' + (auto ? 'settings__toggle--on' : 'settings__toggle--off')}
          role="switch"
          aria-checked={auto}
          aria-label="Move each AI to its newest model"
          tabIndex={0}
          onClick={() => setAutoNewestModel(!auto)}
          onKeyDown={onActivate(() => setAutoNewestModel(!auto))}
        >
          <span className={'settings__knob' + (auto ? '' : ' settings__knob--off')} />
        </span>
        <div className="settings__extinfo">
          <span className="settings__pname">Move each AI to its newest model</span>
          <span className="settings__clihint">
            Once a day each connected AI is asked what it offers. A key moves only to a newer
            version of the same model — never to a dearer one. Your primary on a subscription moves
            to its plan’s top model, once that model has answered. The AI on this Mac is never
            moved: new models there are listed for you to pick.
          </span>
        </div>
      </div>
    </div>
  )
}
