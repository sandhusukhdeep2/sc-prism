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

### "no answer — KeyError: 'content'" (engine)

Seen on the released build, in the resumed build: a seat on the local
reasoning model showed `no answer — KeyError: 'content'`, a hundred seconds
after it was asked.

The local server's own log for those hundred seconds: the same request three
times, each ending `finish_reason=length` at the 4,096-token allowance. The
model had spent the whole allowance thinking. An OpenAI-compatible server
leaves `content` out of the message when there is no answer text (the
thinking travels in `reasoning_content`, a tool request in `tool_calls`), so:

- the Python gateway's `message["content"]` raised `KeyError`, which it files
  under "the body was not a completion" and retries — the same question at
  temperature 0, twice more, then a programming error printed as the cause;
- the Go daemon read the missing field as `""` and returned it as a **real**
  completion — an empty answer marked genuine;
- the Messages reader had the same fault in another spelling: it read
  `content[0]["text"]`, and with thinking on the first block is the thinking,
  so every such reply was `KeyError: 'text'` after three paid calls.

A reply with no answer text is the model's own ending, not a broken pipe. It
is now asked for once and named from what the reply says
(`gateway.NoAnswer`, `no_answer_cause`; `noAnswerCause` in `provider.go`,
same sentences):

| the reply | the seat says |
|---|---|
| cut off at the allowance, with thinking | the model spent its whole answer allowance (4,096 tokens) thinking and wrote no answer |
| cut off at the allowance, no thinking reported | the model reached its answer allowance (4,096 tokens) before writing an answer |
| only `tool_calls` | the model answered with a tool request only, in a form this app does not read, and wrote no text |
| finished, nothing in it | the model returned an empty answer |

It keeps the token counts the server measured (a stand-in for a call that
never came back still reports 0). A Messages reply's answer is its text
blocks, wherever they sit. A body with no `choices` is still retried.

Not changed: the allowance itself, and what a build does after a seat gives
no answer. Not checked against a live server — the fixtures are the shapes
the local server's source and log show.

### A first run, on an empty home folder

The setup wizard had only ever been covered by tests. The signed 0.2.1 build
was started with `HOME` and `CFFIXED_USER_HOME` pointed at an empty folder,
which gives it no settings, no vault and no AI — what a download sees — and
the whole wizard was walked to "Activate & write to vault" and into the room.
It works end to end. With nothing installed it says so ("Claude · not
installed — see the link below"; "Local model is unreachable — is the server
running?"; each seat "sits out" with its reason) and offers a way in without
an AI. What was wrong, and is fixed:

- **A tick nobody earned.** A step in a folder with no tests ended "Verified:
  Tier-1 tests and the Tier-2 review passed". Tier-1 had been skipped. The
  line now reads "Your checks had nothing to run here, so this rests on the
  Tier-2 review alone — it passed (eval 0.75)." The same rule for the other
  tier: "the review passed" is said only of a review that ran and passed; a
  step no tier checked says "Nothing checked this step". (`narrateRun`)
- **An invented business.** Before one question was answered, the draft
  beside the interview read "Solo consultancy — I build data pipelines…" — a
  mock answer left in as the default, and the default is what the Manager is
  told about the business if the wizard is closed early. A fresh install now
  has no business description. The cautious policy defaults (sign-off gates,
  never-touch, two hats) stay, and the panel is titled "Your governance
  draft" rather than "Drafting from your answers".
- **"v0.1 · solo alpha"** on the first screen of a 0.2.1 build. The label is
  read from the package now.
- **Two answers not shown back.** The grants summary left out computer
  control and terminal access, both asked two screens earlier.
- **The step marked was the wrong one.** On Review the steps along the top
  still marked Interview.
- **Buttons over the content.** The interview page runs edge to edge, so its
  first bubble and the draft sat under Back and Close.

Left as it is, for the owner to decide: the Companion step says "Nothing runs
on its own", and the first screen after setup says the Companion's heartbeat
is now on (every two hours, a real AI run) with "Turn it off / Keep it on".
With no AI connected the Companion is called "Your local model" throughout.

## A job for two, in a project's room (after 0.2.1)

Seen on the 0.2.1 build: "Add a fourth line to hello.md", typed in a
project's room, took fifteen minutes and 32 model calls — every job typed
there went to the whole five-seat build team. The Manager's room already
sizes a message (talk — one AI; a job — two seats; a big job — every seat).

A job typed in a project's room is now sized by the same rule
(`lib/stepTeam.ts`, `messageLevel`):

- **One piece of work → two seats**: the seat that does the work, and the one
  that plans — on the primary when the primary is on the team (`jobRoster`).
  The writer still leads (`buildWriter` settles the cut the same way it
  settles the team).
- **Several parts, a long brief, or a call for more eyes** ("review…",
  "…with the whole team") → every seat.
- **Never sized**: a step of the plan (it was approved with its team), and a
  team the user chose for the project — its own agents or a roster typed by
  hand (`usesDefaultTeam`).

Said before the send ("Implementer + Planner make this change in … — one
piece of work, so two seats · say “whole team” for every AI"), on the
composer's who-button, and in the room's notice after it ("Step 5 of 5 —
Implementer + Planner are working in … now"). All three and the run read the
same function, so the words cannot name more hands than the run gets. The
board still shows the project's whole team; two seats light.

A rule, never a model's choice.

**A cut never moves a grant.** Who may write is settled once, for the whole
team (`buildWriter`). The first version settled it again on the two seats,
which could hand `writes` to a seat the team's settlement had not given it to
(the user gives Writes to the Reviewer; a cut of "Implementer + Planner",
settled afresh, asked the Implementer for it), and could turn a gated team
into an ungated pair. A cut is now two seats OF that settlement — the seat
that writes for the team and one other — each holding exactly what it held
there; and if a cut ever came back with no grant table while its team has
one, the team's is sent.

## Why the background jobs were failing (found 2026-11-15)

Read from the recorded runs of the last three days (46 runs).

- **Manager report jobs — four of the last five failed, every one the same
  way.** Reply: "[incomplete: I ran out of tool turns (6 used)…]". Verdict:
  "token_budget: 207245 > 60000" (123,507; 177,141; 80,132). A report job was
  given the wake's token budget and its tool-turn cap, and not the one bound
  that made the wake work: one step. The engine therefore planned it as
  understand → locate → produce — three tool loops of six turns each, inside
  a budget sized for one. It now asks for one step (`WAKE_STEPS`), as the
  comment above the call always said it did.
- **A "hello" typed in a project's room was recorded as a failed run**
  ("tier-1 failed; tier-2 did not run; 1 governance block"). A chat turn in a
  project's room is launched with the user's verify command and that
  project's folder, and the loop ran the command over the chat turn: `npm
  test`, in a folder with no package.json, on a greeting. A conversation
  changes no files, so the engine now skips Tier-1 for a converse turn — out
  loud, with the commands it did not run (`verifier.CONVERSATION_MESSAGE`).
  A task in the same folder is still checked.
- **Heartbeats — twelve of twenty-four failed, for two reasons that are not
  faults of the app.** Seven: "claude exited 1: You've hit your session
  limit" — the subscription the primary runs on was used up; the run is
  recorded as unanswered, which is what happened. Five: the reviewer scored
  the wake below 0.70, with reasons that hold — a wake that said it had read
  and written vault notes on a wake that is given no vault tools, and one
  that ended still asking for a tool.

Not changed, and worth a decision: while the primary's session limit is
spent the heartbeat still wakes every hour and records another unanswered
run; and when the reviewer's own model cannot be reached, Tier-2 falls back
to a heuristic that scored those no-answer wakes 0.86 "ok" (the verdict still
failed, on the no-answer rule).

## Stop, for every run the app makes (2026-11-15)

0.2.0 could stop a team run and a build. The other four kinds of run could
only be watched. Each now stops the same way: the engine's own process is
cancelled (`cancel_engine_run`), and the run is recorded as **stopped by
you** — never as a failure, never as a provider that went away, never as our
own wall.

| the run | where Stop is | what is recorded |
|---|---|---|
| one AI answering | the composer: while it answers, Send is Stop ("Stopping…" once pressed) | the thinking bubble goes; the room says "Stopped by you — no answer was written."; the provider is **not** marked unreachable |
| a heartbeat wake | the board, in the Manager's room | the beat "stopped by you — no check was made"; the cadence advances |
| a manager job (one AI, or a team) | the board, in the Manager's room | the job's run line "stopped by you — no report was written"; nothing is appended to its report file |
| a standing task | the board, in the Manager's room | the schedule's run "stopped by you"; no "provider offline?" notice |
| a standing check | the board, in the project's room | the schedule's run "stopped by you"; no "verify failed" notice |
| a project's interview turn | the board, in the project's room | the room says "Stopped by you — no question was asked."; nothing is recorded as said by the AI |

Two runs needed plumbing to be cancellable at all. The wake's card has a
fixed id, so the card is mapped to the wake's engine run before it is
launched. The verify-only run was launched with a blocking `cmd.output()` and
no id; `run_engine_verify` now takes a run id and retains its child like every
other engine command (blank id: uncancellable, as before).

Stop is offered only where it is real: the simulator and a send with no AI
connected launch no engine, so a chat there has no Stop.

## An interview turn is a conversation (2026-11-15)

Found by creating a project in the installed app: each interview question
took about fifty seconds and ten thousand tokens, and every one was recorded
as a failed run ("tier-1 failed; no files were produced; tier-2 did not run;
1 governance block" — five recorded, none passed).

The turn was launched as a plain task. Its own instructions say "Write
PROJECT.md…", so the contract inferred a WRITE job: a four-step plan
(understand, locate, implement, self-check), the project's verify command run
over a question, and the stop ratchet's "task not done". It is one reply. It
is now launched as `converse` and not judged — the same two facts the chat
path states about a message — so it plans one reply step, the checks are not
run over it (a conversation changes no files), and no judge call is spent
grading a question.

**While a project is being interviewed, the room's sends are the
interview's.** An interview answer that happened to name work ("placeholder
text is fine — please write the plan now") was read as a job and sent to the
Manager's team: a board ran, "the team's final plan" came back as prose, and
the project still had no plan. An unpicked message in a project that has no
plan yet is the interview's, whatever words are in it; the composer says so
before the send ("this answers the interview for «…» — the plan comes after
its questions"), and a lane picked by hand still wins.

The new-project form was drawn for a page and is shown in the 186px project
list, where its two-across row and its toggle ran past the edge. In the list
it stacks.

## A message's id is its own, across restarts (2026-11-15)

Seen in the installed app: an old answer in the Manager's room had two later
answers appended to it — answers that had been given in another room, on
later days.

Message ids were `m1`, `m2`, … counted from zero by every app session, while
the threads they sit in are saved and restored. After a restart a new reply
was handed an id an old message already had, and every id-scoped update is
applied to every thread holding that id: a line appended to the answer, its
model, and — worse — the removal of a thinking bubble, which could take an
old message with it. Each session now stamps its ids (`m<stamp>-<n>`), so
they cannot meet an id from any other session, whenever the saved threads
arrive. What the collisions already did to saved threads is not undone.

## Not built here

- "Live" stays in the rail (the owner asked for that page on 11-12); the
  mockup's rail lists five places.
- The mockup's "switch room" menu: the rooms stay in the rail.
- A seat's tools as chips on its Agents card (built-in seats declare none).
- `narrationLines` in `lib/narrate.ts` is still unused.
