# Heartbeat Manager + orb presence (2026-07-29)

Sukhdeep's ask (verbatim intent): an ALWAYS-RUNNING manager — "always doing
something for my company… living floating… informing me what he is doing right
now, what he thinks." Scope picked: Heartbeat Manager + orb presence.
(Adaptive live-primary interview: roadmap, next.)

## Honest physics

True 24/7 inference burns tokens for mostly nothing. The always-alive
EXPERIENCE is delivered as a HEARTBEAT: wake on a cadence, look at real state,
do ONE useful governed piece of work or honestly rest, then sleep. The cost of
each beat is real and shown. History note: an earlier floating orb was REMOVED
for reading as disconnected — because it had no real state. This one renders
ONLY genuine state: pulsing = a wake run is live right now; idle = "resting —
next check <t> · last: <line>". Default OFF; enabling is an explicit consent
on the Agents card (a grant, like the wizard's).

## Data (managers store)

`Manager` gains optional `heartbeat`: { enabled, charter, everyMinutes,
lastBeat, beats: Beat[] (trimmed ~40) }. Beat = { at, action:'worked'|'rested',
line, ok, tokens }. v1: one heartbeat on the companion manager (id
'mgr-companion', name = companionName, providerId = primary). Seeded disabled
with a starter charter.

## Wake (driver)

Extends the existing 30s manager tick (same busy-ref serialization):
due when enabled && now-lastBeat >= everyMinutes. Each wake:
1. Gather REAL state cheaply: project statuses (store), needs-you counts
   (held/pending readers), recent beat lines (avoid repeating), charter.
2. One governed run (runNativeTask): charter + state + instruction — do ONE
   small useful piece of work within the existing grants and reply with a
   first-line summary, OR reply exactly `NOTHING_NEEDED — <one honest line>`.
3. Outcome → Beat record; 'worked' appends the full reply to
   `reports/<manager>/heartbeat.md` (trimmed) + notifyManagerReport
   (outcome-only, as always); 'rested' records the honest line only.
4. Tokens from the verdict accrue to the beat → per-day sum on the card.
All under the standing gates: sensitive→local, ask-first tools hold, blocking
pauses, spans in Console. No new egress.

## Surfaces

- FloatingPulse (AppShell, bottom-right, small): live line during a wake
  (real run state), static when idle; click → popover with resting/next-due
  line, last beats log, pause/resume; charter edits live on the Agents card.
  NEVER animates while idle.
- Agents page, companion manager card: heartbeat toggle (consent), charter
  textarea, cadence select (15m/30m/1h/3h), today's beats + token/cost line,
  beat log.

## Tests

Pure helpers pinned: beat-due logic, NOTHING_NEEDED parsing (rested vs
worked), beat trim, per-day token sum. Component: orb has no pulse class when
idle; popover shows real lastBeat line. Driver: a due heartbeat records a beat
and updates lastBeat (mocked runNativeTask); disabled → no run ever.

## Honesty rules (binding)

Orb line == beat record == what actually ran (spans prove it). Rested beats
say why. Costs are real sums. OFF by default; one explicit enable.
