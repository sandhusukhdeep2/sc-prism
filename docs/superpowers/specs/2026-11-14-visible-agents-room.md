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

## Not built here

- "Live" stays in the rail (the owner asked for that page on 11-12); the
  mockup's rail lists five places.
- The mockup's "switch room" menu: the rooms stay in the rail.
- A seat's tools as chips on its Agents card (built-in seats declare none).
- `narrationLines` in `lib/narrate.ts` is still unused.
