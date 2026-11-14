# The room is its Team board and its chat (2026-11-14)

## What the owner said

Of the three mockups drawn on 2026-11-08 ("Visible agents" — the Work room
with the Team board, the Agents ceremony, the five-place rail): "the artifact
you created was a perfect example of what I want… did you adopt this thing or
not?"

## The honest answer

Partly. The look, the rail, the one local number and the agent ceremony that
ends in proof were built from those mockups between 8 and 11 November (design:
`2026-11-08-visible-agents-design.md`). The Team board, the seat-attributed
lines and the outcome line were built then too — and then replaced: the
animated stage took the seats (11-11), and the slim strip of
`2026-11-14-chat-is-the-room.md` reduced them to a ring and a name, shown only
while a run was live. This spec puts the mockup's room back, keeping what the
strip got right (each fact once; packets only where work is in flight).

`2026-11-14-chat-is-the-room.md` is superseded where it describes the strip;
its "said once" rules stand.

## The room

    name · [Steps] [Files] [Details] [Desk] [New session]      3 agents · 2 have worked · 1 working now
    ┌ Team board ───────────────────────────────────────────────────────────┐
    │ TEAM  intent…                                      0:42  Stop   ⤢     │
    │ (M) │ (R) ─ research ─▶ (C)                                           │
    │ Manager  Researcher     Critic                                        │
    │ claude…  🔒 local…      gemini…                                       │
    │ answered thinking…                                                    │
    │ 140 tok                                                               │
    └────────────────────────────────────────────────────────────────────────┘
    ┌ chat ──────────────────────────────────────────────────────────────────┐
    │ who · which AI · what it did            (one line per stretch / turn) │
    │ ✓ routed → verified → written  [checks] [review] [local]  cost        │
    │ the answer                                                             │
    │ [attach] [words………………………………………………] who takes this ▸ [Send]              │
    └────────────────────────────────────────────────────────────────────────┘

### The Team board (`lib/teamBoard.ts`, `components/TeamBoard`)

- **Who is on it** is the roster this room would send: the project's own build
  team, or the default team as the workload slider seats it. It is on screen
  whether or not anything runs.
- **What a seat did** comes from spans only. A seat with no span is idle and
  says nothing. The AI under a seat is the roster's setting until a span names
  the AI that really answered.
- Seats never change places (roster order). The lead seat is called the
  Manager and is set apart. A role is shown as a name (`researcher` →
  Researcher); a library agent's seat carries the name it was given.
- The companion speaking under its own name (a wake) is the lead's seat.
- One AI answering a message lights the Manager's ring and adds no words — the
  chat's own bubble says it is thinking.
- A handoff is a link; neighbours are joined by a straight run, a handoff past
  a seat goes over it. Only the latest handoff is labelled. Packets travel
  only the handoff in flight, and not at all with reduced motion.
- The board also says what is running and for how long (with Stop and the
  full-window link), and — for a room with no run of its own — where the
  engine is busy.
- The head count is read off the board. A number the board cannot see is not
  zero: a room at rest, a run whose steps cannot be told apart, and the gap
  between two turns say no "working now".
- At rest in the Manager's room the board keeps the last run this room itself
  drew, for this visit only. Another room's crew is never borrowed.

### The chat (`lib/runLines.ts`, `components/RunLines`)

- **A live run** is written as lines: one per stretch of one seat's work (what
  it read, searched, used; answered / thinking / no answer with the engine's
  cause; who it handed to), then the checks, the review, and what the run did
  with the user's notes. More than eight fold the earlier ones.
- **A saved turn** (from the board file) is one line — who, which AI, the first
  thing it wrote — that opens the whole turn exactly as written. More than six
  fold the earlier ones, so working-out never buries the answer.
- **How a run ended** is one strip: the outcome in words, what each check said
  (a gate that did not run is never "passed"), the local share, the cost, and
  the way to the full record. It replaces the six-row verdict card in the chat
  and the raw "team run passed · … tok" line.

### What left the page, and where it went

| Was on Work | Now |
| --- | --- |
| Greeting line, "runs recorded" pill, Stats link | gone (the rail's meter opens Stats) |
| Coworker desk band | the Desk tab beside the chat, in the Manager's room |
| Chat / Editor tab row, "last result ›" | gone; the outcome strip links to the record |
| Recent runs + This week | Console |
| "memory N% full" at any size | shown from 60% (with Compress now) |
| Details open by default in a project room | opens by itself only when the project waits on the user; a pane the rule opened stays open |
| "Enter to send", two-row composer | one row; the target and route pills still open outside the row |

### Agents cards

- A seat whose own turns were answered in real runs is proven by that work,
  and Prove is not offered. A proof on record says what it says.
- Prove names, and proves, the AI the seat really runs on.
- A skill chip is the skill's name; how it has scored is its hover.

## Found by driving the installed app

The room was run in the packaged app with a real team job (Manager on the
subscription CLI, Researcher on the local model, Critic on the CLI). The
board, the head count, the labelled handoff with packets, the seat lines and
the outcome strip all read as drawn above. Four things did not, and are fixed:

- **The chat did not follow the run.** The run's lines were written under the
  last message and stayed below the fold. The chat now follows them.
- **A table was printed as pipes.** A team asked for "a short table" answered
  with one; the chat renderer had no tables. Pipe tables render as tables
  (header, alignment, inline formatting in cells; a line with a pipe and no
  separator row stays text).
- **The reviewer's raw line was printed whole** — "[llm-judge] … | score=0.51
  vs threshold=0.7 -> BELOW | envelope ok". Its sentence is the reason; the
  score and its bar are a chip ("review: 0.51 — needs 0.70").
- **A stand-in was printed as the Manager's answer.** With the local server
  down, the lead's final turn came back as the gateway's "[offline:…]"
  stand-in and went into an answer bubble. The app now says, in its own voice,
  that no final answer was written, with the engine's cause.

## The reviewer is told what was left unchanged (engine)

A step asked to "Rewrite hello.md" once wrote a new `hello.md` in the wrong
place; the reviewer, shown only the new file, scored it 1.00 and the project
was marked done. The write-path cause was fixed earlier. The general half:
every project step now measures, before and after its write, which written
files are NEW and which files the step's own words name that existed and were
NOT written. Both go into the measured evidence the reviewer reads ("FILES THE
TASK NAMES THAT THIS RUN DID NOT CHANGE", and a note when a new file wears a
named file's name). Only the step's text counts — not the project goal above
it. The engine still never edits its reviewer's marks.

## Each count says what it counts

Console said "stable across 625 runs" beside "415 verdicts"; Stats said "126
checked runs"; Work's pill said "115 runs recorded". They count different
things. The pill is gone with the rest of Work's head; Console now says
"engine runs" and "judged runs", the words Stats uses for the same figures.

## The once-only pass, continued

- **Automations:** one sentence under the title, in body type (there were two,
  in monospace); the "Running now" card only while something runs; a manager
  is named once, as the heading of its jobs, not again on every row.
- **Skills:** the chip on each card is "portable"; the sentence it stood for
  is its hover.
- **Memory:** the page is about memory — the vault check, the three tiers, the
  injection budget. The share bar (also the rail's meter, Stats and Console),
  Tier-1 saves (Stats), the cost line (Stats), a run count and two cards that
  only pointed at the Training tab are gone from it.
- **Training:** what is learned is said once, and the panel heads itself.

## After the 0.2.0 tag (not in that release)

Found on the released build, in a project's room with the pane open:

- **One seat, two names.** The board said "Reviewer / Verifier"; the lines
  under it said "Reviewer-verifier". Whoever prints a seat's name now asks the
  room's roster (`rosterNameOf`), in the live lines, in "handed to …" and in
  the saved turns.
- **A sentence across the rings.** A build hands over with its whole step as
  the handoff's label. A label longer than a stage name (24 characters) is
  not printed on the board; the run line and the chat already say the step.
- **An AI cut at both ends.** In a narrow column the AI under a seat was
  centred in a flex row and clipped left and right ("l · Qwen3.6-35B-A3E").
  It is cut at its end, with an ellipsis.
- **A stray brace** left in `ProjectRunStage.css` had been dropping that
  file's reduced-motion rule; a test now reads every stylesheet's braces.

Checked on the released build after the tag: Stop on a project build (the
engine stops, the project waits with "Stopped by you at step 4 of 4", its
Details open by themselves) and Resume from the Needs-you row.

## Not built here

- "Live" stays in the rail (the owner asked for that page on 11-12); the
  mockup's rail lists five places.
- The mockup's "switch room" menu: the rooms stay in the rail.
- A seat's tools as chips on its Agents card (built-in seats declare none).
- `narrationLines` in `lib/narrate.ts` is still unused.
