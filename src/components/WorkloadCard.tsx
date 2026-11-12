// THE WORKLOAD SLIDER (2026-11-12).
//
// The owner: "one slider that changes the dependency… if the user wants the
// primary AI to just give the instruction and check the work, it can do only
// that, and all the workload is on local… fix by your measurement first, but
// give the slider to the user. If the user wants to go all in with local, he
// can."
//
// One control for who plans, who does the work and who checks it, on the
// DEFAULT team. It starts on the stop the app's own measurement points to,
// shows the seats that stop produces before anything runs, and says plainly
// what it does not touch. The rule itself is lib/workload.ts — this file only
// draws it.
import { useEffect, useMemo } from 'react'
import type { Verdict } from '../engine/types'
import { agentRoster, systemAgents, useAgents } from '../lib/agents'
import { brandOf } from '../lib/providerBudget'
import { allowAllProviders } from '../lib/roster'
import { useSettings, type Settings } from '../lib/settings'
import {
  WORKLOAD_STOPS,
  effectiveWorkload,
  workloadCopy,
  workloadTable,
  type SeatKind,
  type WorkloadRow,
  type WorkloadStop,
} from '../lib/workload'
import { measureWorkload } from '../lib/workloadMeasure'
import { workloadAIs } from '../lib/workloadSeats'
import { baseTeamRoster, persistedVerdicts } from '../store/AppStore'
import './WorkloadCard.css'

const KIND_WORD: Record<SeatKind, string> = { plan: 'plans', do: 'does the work', check: 'checks' }

/** An AI by its own name — never the companion's pet name: the slider is about
 *  which AI does what, and "Claude checks" is the fact. */
function aiName(settings: Settings, token: string): string {
  if (!token) return 'nobody'
  const brand = brandOf(token)
  if (brand === 'local') return 'Local model'
  if (brand === 'claude') return 'Claude'
  if (brand === 'gemini') return 'Gemini'
  if (brand === 'openai') return 'OpenAI'
  return settings.providers.find((p) => p.id === token)?.name ?? token
}

function SeatRows({
  title,
  rows,
  settings,
}: {
  title: string
  rows: WorkloadRow[]
  settings: Settings
}) {
  if (rows.length === 0) return null
  return (
    <tbody>
      <tr className="workload__group">
        <th colSpan={3} scope="colgroup">
          {title}
        </th>
      </tr>
      {rows.map((r) => {
        const now = aiName(settings, r.now)
        const local = brandOf(r.now) === 'local'
        return (
          <tr key={`${title}-${r.role}`} aria-label={`${r.role}, ${KIND_WORD[r.kind]}, on ${now}`}>
            <th scope="row" className="workload__role">
              {r.role}
            </th>
            <td className="workload__kind">{KIND_WORD[r.kind]}</td>
            <td className="workload__ai">
              <span className={'workload__chip' + (local ? ' is-local' : ' is-cloud')}>{now}</span>
              {r.moved && <span className="workload__was">was {aiName(settings, r.was)}</span>}
              {r.private && <span className="workload__was">reads your notes — stays on this Mac</span>}
            </td>
          </tr>
        )
      })}
    </tbody>
  )
}

export default function WorkloadCard({
  verdicts,
  localTokensPerSec,
}: {
  /** The judged runs to measure from. Omitted → the app's own saved history. */
  verdicts?: readonly Verdict[]
  /** The local model's measured output speed, when the run record has one. */
  localTokensPerSec?: number | null
}) {
  const { settings, setWorkload, setWorkloadMeasured, setWorkloadSecondOpinion } = useSettings()
  const agents = useAgents()
  const runs = useMemo(() => verdicts ?? persistedVerdicts(), [verdicts])
  const measurement = useMemo(() => measureWorkload(settings, runs), [settings, runs])
  const measured: WorkloadStop | '' = measurement.stop ?? ''
  // Cache the measurement where a launch can read it without the run history.
  useEffect(() => {
    setWorkloadMeasured(measured)
  }, [measured, setWorkloadMeasured])

  const ai = workloadAIs(settings)
  const stop = effectiveWorkload(settings.workload, measured)
  const primary = aiName(settings, ai.primary)
  const copy = workloadCopy(stop, primary)
  const opts = { secondOpinion: settings.workloadSecondOpinion }
  const following = settings.workload === 'measured'
  const off = stop === 'agents'
  const index = off ? 1 : WORKLOAD_STOPS.indexOf(stop)

  const teamRows = workloadTable(baseTeamRoster(settings), stop, ai, opts)
  const buildRows = workloadTable(agentRoster(systemAgents(agents), allowAllProviders), stop, ai, opts)
  const second = ai.second ? aiName(settings, ai.second) : ''
  // What leaning on the local model costs: time. Said only when a stop gives
  // it a seat it did not already have AND its speed has really been measured.
  const localTakesMore = [...teamRows, ...buildRows].some(
    (r) => r.moved && brandOf(r.now) === 'local',
  )
  const speed =
    typeof localTokensPerSec === 'number' && localTokensPerSec > 0 ? localTokensPerSec : null

  return (
    <div className="settings__provider workload">
      <div className="settings__prow">
        <span className="settings__kicker">Workload</span>
        <span className="settings__spacer" />
        <span className="settings__instant">who plans, who does the work, who checks</span>
      </div>

      <div className="workload__modes" role="group" aria-label="How the stop is chosen">
        <button
          type="button"
          className={'workload__mode' + (following ? ' is-on' : '')}
          aria-pressed={following}
          onClick={() => setWorkload('measured')}
        >
          Follow my measured runs
        </button>
        <button
          type="button"
          className={'workload__mode' + (settings.workload === 'agents' ? ' is-on' : '')}
          aria-pressed={settings.workload === 'agents'}
          onClick={() => setWorkload('agents')}
        >
          Each agent’s own AI
        </button>
      </div>

      <div className={'workload__slider' + (off ? ' is-off' : '')}>
        <span className="workload__end">All {primary}</span>
        <input
          className="workload__range"
          type="range"
          min={0}
          max={WORKLOAD_STOPS.length - 1}
          step={1}
          value={index}
          disabled={settings.workload === 'agents'}
          aria-label="Workload — from all on your primary to all on this Mac"
          aria-valuetext={copy.word}
          onChange={(e) => setWorkload(WORKLOAD_STOPS[Number(e.target.value)] ?? 'primary-leads')}
        />
        <span className="workload__end">All local</span>
      </div>

      <p className="workload__now">
        <strong>{copy.word}</strong> — {copy.desc}
      </p>
      <p className={'workload__evidence' + (following && measured ? ' is-inforce' : '')}>
        {measurement.stop ? (
          <>
            Measured: {measurement.why} → <b>{workloadCopy(measurement.stop, primary).word}</b>
            {following ? ' · in force' : ' · not in force — you chose your own stop'}
          </>
        ) : (
          <>Measured: {measurement.why}.</>
        )}
      </p>

      {speed !== null && localTakesMore && (
        <p className="workload__evidence">
          Your local model has been answering at about {Math.round(speed)} tokens a second, so
          the more seats it holds, the longer a run takes — and the fewer cloud tokens it spends.
        </p>
      )}

      <table className="workload__seats">
        <caption className="workload__caption">The default team at this stop</caption>
        <SeatRows title="A team run from the composer" rows={teamRows} settings={settings} />
        <SeatRows title="A project build" rows={buildRows} settings={settings} />
      </table>

      <label className={'workload__second' + (second ? '' : ' is-disabled')}>
        <input
          type="checkbox"
          checked={settings.workloadSecondOpinion && !!second}
          disabled={!second || stop === 'agents' || stop === 'local-all'}
          onChange={(e) => setWorkloadSecondOpinion(e.target.checked)}
        />
        <span>
          A different AI double-checks
          {second ? ` (${second})` : ' — connect a second cloud AI to use this'}
        </span>
      </label>

      <p className="workload__limits">
        This re-seats the default team only. A team you staffed by hand keeps its own seats, a
        seat that reads your notes stays on this Mac, and the privacy floor outranks every stop.
        To lean on a different AI, pick a different primary under Providers.
      </p>
    </div>
  )
}
