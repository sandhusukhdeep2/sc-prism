// FloatingPulse — the companion's honest presence orb (2026-07-29 spec).
// History note: an earlier floating orb was REMOVED for reading as
// disconnected — it had no real state. This one renders ONLY genuine state:
// it pulses ONLY while a heartbeat wake run is live right now
// (state.heartbeatLive, set/cleared by the manager driver around the real
// run) and sits static when idle. Every line in the popover is a REAL Beat
// record from the managers store — the resting/next-check line, the last
// beat, and the beat log. NEVER animates while idle.
import { useState } from 'react'
import { useApp, useWakeNow } from '../store/AppStore'
import {
  COMPANION_MANAGER_ID,
  managerDisplayName,
  updateHeartbeat,
  useManagers,
} from '../lib/managers'
import { useSettings } from '../lib/settings'
import { isNative } from '../lib/nativeEngine'
import './FloatingPulse.css'

// Relative time for beat rows — mirrors the Agents page's ago().
function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / (60 * 24))}d ago`
}

// The real next-due segment from lastBeat + cadence. An OVERDUE beat renders
// as waiting-for-the-engine, never "due now": the driver fires a due beat
// within one 30s tick whenever the engine is free, so a beat that STAYS
// overdue is honestly queued behind a busy engine slot (which can be days
// while a project sits 'awaiting' the user) — "due now" forever would be a
// lie about what is actually happening.
function nextCheck(lastBeat: number, everyMinutes: number): string {
  const msLeft = lastBeat + everyMinutes * 60_000 - Date.now()
  if (msLeft <= 0) return 'waiting for a free engine slot'
  const m = Math.ceil(msLeft / 60_000)
  return m < 60 ? `next check in ${m}m` : `next check in ${Math.round(m / 60)}h`
}

export default function FloatingPulse() {
  const { state } = useApp()
  const ms = useManagers()
  const { settings } = useSettings()
  // "Wake now" (2026-08-05 §Part 3) — the SAME binding the Agents card uses,
  // so the two surfaces can never disagree about whether a wake can run.
  // Hooks run before the non-native early return (rules of hooks).
  const wake = useWakeNow()
  const [open, setOpen] = useState(false)
  if (!isNative()) return null

  const companion = ms.managers.find((m) => m.id === COMPANION_MANAGER_ID)
  const hb = companion?.heartbeat
  const name = companion ? managerDisplayName(companion, settings) : 'Companion'
  const live = state.heartbeatLive
  const last = hb?.beats[0]

  // The headline is always honest state: the live wake line while one runs,
  // else resting + (when enabled) the real next-due + last beat record.
  const restingLine = hb?.enabled
    ? `resting — ${nextCheck(hb.lastBeat, hb.everyMinutes)} · last: ${
        last ? `${last.line} (${ago(last.at)})` : 'no beats yet'
      }`
    : 'resting — heartbeat off · enable on the Agents page'
  const headline = live ?? restingLine

  // Pause is available while enabled; resume only where a pause could have
  // happened (beats exist = the user consented once). A never-enabled
  // heartbeat offers no orb toggle — the FIRST enable is an explicit consent
  // on the Agents card, not a side door here.
  const toggle =
    companion && hb && (hb.enabled || hb.beats.length > 0)
      ? { label: hb.enabled ? 'pause heartbeat' : 'resume heartbeat', next: !hb.enabled }
      : null

  return (
    <div className="fpulse">
      {open && (
        <div className="fpulse__pop" role="dialog" aria-label={`${name} heartbeat`}>
          <div className="fpulse__title">
            {name}
            <span className="fpulse__spacer" />
            {/* One immediate REAL beat: same governed run, same 20k budget,
                same beat record as a scheduled wake. Disabled with the honest
                reason (below) whenever it cannot run — never a dead button. */}
            <button
              type="button"
              className="fpulse__wake"
              disabled={wake.disabled}
              title={wake.reason ?? 'run one governed check now'}
              onClick={() => void wake.fire()}
            >
              {wake.busy ? 'waking…' : 'Wake now'}
            </button>
            {toggle && (
              <button
                type="button"
                className="fpulse__toggle"
                onClick={() => updateHeartbeat(companion!.id, { enabled: toggle.next })}
              >
                {toggle.label}
              </button>
            )}
          </div>
          <div className="fpulse__line mono">{headline}</div>
          {wake.reason && !wake.busy && (
            <div className="fpulse__why mono">can’t wake now — {wake.reason}</div>
          )}
          {hb && hb.beats.length > 0 && (
            <ul className="fpulse__beats">
              {hb.beats.slice(0, 8).map((b) => (
                <li key={b.at} className="fpulse__beat">
                  <span
                    className={
                      'fpulse__glyph' +
                      (b.action === 'worked' ? ' fpulse__glyph--worked' : '') +
                      (b.ok ? '' : ' fpulse__glyph--err')
                    }
                  >
                    {b.action === 'worked' ? '✓' : '·'}
                  </span>
                  <span className="fpulse__beatline">{b.line}</span>
                  <span className="fpulse__when mono">{ago(b.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <button
        type="button"
        className={'fpulse__orb' + (live !== null ? ' is-live' : '')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${name} heartbeat — ${headline}`}
        title={headline}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="fpulse__core" />
      </button>
    </div>
  )
}
