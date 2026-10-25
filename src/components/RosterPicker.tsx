// RosterPicker — choose the crew for a team run FROM YOUR OWN LIBRARY.
//
// Before this, both team launchers offered a bare text box seeded with a
// generic lead/researcher/critic derived from the connected providers. An agent
// you had created could only join a run if you knew to type `archivist:local`
// by hand, and nothing checked the name — so a typo produced a seat for a
// coworker who does not exist and a run that looked completely normal.
//
// Everything here is real: the seats come from the library through the same
// `agentRosterSeats` the launch path uses, and an agent that CANNOT run is
// shown disabled WITH ITS REASON rather than quietly missing. That is the
// no-silent-shrinking rule (lib/roster.ts) applied at the point of choosing.
import { useMemo } from 'react'
import {
  agentRosterSeats,
  rosterFromSeats,
  seatsFromRoster,
  unknownRosterNames,
  type StoredAgent,
} from '../lib/agents'
import './RosterPicker.css'

export default function RosterPicker({
  agents,
  gate,
  value,
  onChange,
}: {
  /** The whole library — those that cannot play are shown, not filtered out. */
  agents: StoredAgent[]
  /** Provider check: '' when a token can really answer, else the reason. */
  gate: (token: string) => string
  /** The roster string being edited (`slug:token`, comma separated). */
  value: string
  onChange: (roster: string) => void
}) {
  const seats = useMemo(() => agentRosterSeats(agents, gate), [agents, gate])
  const chosen = useMemo(() => seatsFromRoster(value, seats), [value, seats])
  const unknown = useMemo(() => unknownRosterNames(value, seats), [value, seats])
  const playable = seats.filter((s) => !s.sitsOut)

  const toggle = (role: string) => {
    const next = new Set(chosen)
    if (next.has(role)) next.delete(role)
    else next.add(role)
    onChange(rosterFromSeats(seats, next))
  }

  if (seats.length === 0) {
    return (
      <div className="rpick rpick--empty mono">
        your library is empty — create an agent on this page and it can take a seat here
      </div>
    )
  }

  return (
    <div className="rpick">
      <div className="rpick__head mono">
        <span>Who is on this team</span>
        <span className="rpick__count">
          {chosen.size === 0
            ? `nobody picked — ${playable.length} available`
            : `${chosen.size} of ${playable.length}`}
        </span>
      </div>

      <ul className="rpick__list">
        {seats.map((s) => {
          const out = Boolean(s.sitsOut)
          return (
            <li key={s.agent.id} className={'rpick__seat' + (out ? ' rpick__seat--out' : '')}>
              <label className="rpick__label">
                <input
                  type="checkbox"
                  className="rpick__box"
                  checked={chosen.has(s.role)}
                  disabled={out}
                  onChange={() => toggle(s.role)}
                />
                <span className="rpick__name">{s.agent.name}</span>
                <span className="rpick__token mono">{s.token}</span>
                {/* An agent that cannot play says WHY, here, before the launch —
                    it is never simply absent from the list. */}
                {out && <span className="rpick__why mono">sits out — {s.sitsOut}</span>}
              </label>
            </li>
          )
        })}
      </ul>

      {unknown.length > 0 && (
        <div className="rpick__unknown mono">
          {unknown.length === 1 ? 'no agent named' : 'no agents named'}{' '}
          {unknown.map((n) => `“${n}”`).join(', ')} — the engine will role-play the name anyway,
          so check the spelling
        </div>
      )}
    </div>
  )
}
