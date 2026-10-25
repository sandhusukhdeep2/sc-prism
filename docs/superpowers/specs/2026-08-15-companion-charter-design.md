# The companion earns his own context (2026-08-15)

Four decisions from Sukhdeep, in one build.

## 1. Don't work on a sleeping Mac

A maintenance DarkWake started a heartbeat that could never finish (4f95483
proved it from pmset). The cadence driver must not spend tokens on a machine
that is about to sleep again.
- Detect a darkwake / imminent-sleep state before starting a wake.
- Skip WITHOUT spending: record an honest beat ("skipped — the Mac was in a
  maintenance wake, nothing ran") so the gap is explained, never silent.
- Never hold a power assertion; the user chose defer, not keep-awake.

## 2. Cadence measured in hours

Default the companion heartbeat to 120 minutes (was 15). The Agents cadence
select gains hour options; existing users keep their chosen value except
Sukhdeep's install, which moves to 2h as decided. Rationale in code: a vault
changing a few times a day gives a 15-minute wake nothing new to act on — it
re-reads unchanged state and bills for it.

## 3. A charter that is a PRIORITY LADDER, not three jobs

He does ONE piece of work per wake, so the charter orders the work:
 1. Anything genuinely waiting on the user is surfaced first (never invented).
 2. Vault upkeep — the concrete list his own vault-health report produced:
    index verdicts, triage log.md, archive stale reports, flag broken links.
 3. Project prep — read real project state, draft the next step, flag blockers.
 4. Business work — only from context he has actually been given (below).
If nothing on the ladder has genuinely new state, he RESTS honestly. The
existing NOTHING_NEEDED protocol stays exactly as is.

## 4. He interviews the user to earn the business leg

He cannot do business work from "software consultancy, 2-5 people". So:
- When the business context note is missing/thin AND the ladder has nothing
  else, a wake may ask up to 3 questions — posted as a "Needs you" item on the
  Work desk (NOT a chat interruption), each question one line, answerable
  inline.
- Answers are written to the vault as a real note (`business/context.md` or
  similar), which he reads on later wakes. The note is the source of truth;
  nothing is remembered outside it.
- HONESTY: he must never present an unanswered question as an answer, never
  infer business facts he was not told, and must say plainly in the note which
  parts came from the user versus his own reading of the vault.
- Asking is rate-limited (at most one question set open at a time; no re-asking
  something already answered or dismissed).

## Honesty rules (binding)

A skipped wake says why. A question is a question, never a claim. Business
notes cite their source. Nothing on the ladder is invented to look busy —
resting honestly stays a first-class outcome.

## Tests

Darkwake → no engine call, honest skipped beat; a real wake still runs.
Cadence default + the existing-value migration. Ladder ordering picks the
highest available real work and rests when none. Interview: asks at most 3,
only when context is thin and nothing else is available; answers land in the
vault note; an unanswered set never becomes content; no duplicate asking.
