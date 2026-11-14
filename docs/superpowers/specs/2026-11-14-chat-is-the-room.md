# The chat is the room (2026-11-14)

> Superseded in part the same day by `2026-11-14-visible-agents-room.md`: the
> slim strip became the room's Team board, and a run is written into the chat as
> seat lines and one outcome strip. The "said once" rules below stand.

## What the owner said

Looking at a team run in a project's room: "data representation on the stage
mode is not good. Chat mode is better, but stage mode is very complicated.
Either remove the stage mode or utilize the chat mode. There is an upper
animation part that I like, where you can show the agents communicating with
each other with animation. But repetitive information is a lot… It's happened
with all the pages. Information is not totally connected with each other, and
it's a bit cluttered."

## What was wrong

One run was described five times on one screen: the header's count line, the
"what is running" card above the chat, the board's count line, the stage's
seats with their state and token lines, and the stage caption. A run that
belonged to another room (a heartbeat) was drawn in whatever room was open.
And watching a run meant leaving the conversation for a second surface with
its own tabs.

## The design

**There is no Stage mode and no Stage tab. The chat is the room.**

1. **The run strip.** While a run of THIS room is executing — or parked on the
   user — one slim band sits at the top of the chat card:
   - one line for the run: what it is and how long it has been going (and,
     while it is live, a way to the full-window drawing);
   - the seats in a single row, with a link for each handoff and packets
     travelling the link that is carrying work right now (the animation he
     likes, at a quarter of the height);
   - one sentence: who is speaking, on which AI, and what it is doing.
   Nothing else on the page restates any of those three facts. When the run
   ends the strip goes; the answer, the folded turns and the verdict in the
   chat are the record. The full-window drawing stays on `/live`.
2. **A run belongs to one room.** A project build or interview belongs to its
   project; a message belongs to the room it was sent from; the heartbeat, a
   manager's job and a standing job belong to the Manager's room. A room draws
   only its own run. If the engine is busy in ANOTHER room, this room says so
   in one quiet line that links there — because a message sent now would wait.
3. **Beside the chat, on request.** Steps, Files and Details open in the
   pane. Steps holds the board — the rounds the engine reported, each opening
   its own engine detail, the count, the vault lock, anything parked on the
   user — and the whole run's log; it draws no seats. Nothing opens by itself
   except a project's Details in a wide, quiet room, as before.
4. **One statement per fact** in the room's head: while this room's run is
   live the subtitle is silent — the strip is speaking.

## Rules kept

- Motion is a claim: packets travel only where work is in flight; a parked run
  does not pulse; reduced motion marks the live link and moves nothing.
- With two runs in flight the engine's spans cannot be told apart, so no crew
  is drawn — each run still gets its line, timer and Stop.
- A parked run's question stays on screen: the strip says it is waiting on the
  user and the "Needs you" row above the chat holds the answer buttons.

## Said once

- A project's name is the room's heading; Details no longer repeats it.
- With the team taking a message, the fixed line "your manager staffs the
  team…" is gone: the line beneath names the seats really being sent.
- The four-line narration in the chat is gone: the strip says who is speaking,
  the chat's live stream lists the crew's real actions, Steps holds the log.
- The session's finished-run rows above the chat are gone: the answer and
  verdict in the chat, and Recent runs, are the record.

## Found in the real app the same day, and fixed

Driving the installed build through a real hello, a real two-seat job and a
real project build showed five more repeats and one contradiction:

- One AI answering a message put up the strip above a bubble already saying
  "… is thinking", over a composer placeholder saying it a third time. A plain
  chat answer is no longer a run to draw, and the placeholder only invites the
  next message.
- A seat using a tool between model calls ("searching the web") did not move:
  it now counts as working, and the handoff into it is in flight.
- With two seats at work, the sentence named one and the packets pointed at
  the other. Who is speaking is now the seat the latest handoff went to.
- A long local model name ran off the sentence: it is shortened, whole on hover.
- The head said "nothing running right now" directly above "Busy in Manager".
  It says that only when no engine is at work anywhere.
- During a build, Details said RUNNING, then "running — step 2 of 2", then
  "step 2 of 2 — …" over a bar, then a live narration console. It is now the
  step and the bar; the strip draws who is working and Steps holds the log.

## A parked question is asked once, and its buttons work

Seen in the installed app after a restart: a build waiting on "one more try?"
asked it in three places at once — the Needs-you row (Yes / No / Resume), a
banner in Details (Yes / No, beside "Resume build"), and a pop-up card over
the pane (Yes / No). The driver that had been waiting was gone with the
restart, so in all three Yes and No did nothing; only Resume worked, and then
Yes had to be pressed again. The pop-up also hid the rest of the page from
assistive technology, and installed a window-wide Escape key that answered No.

- The question lives in the Needs-you row only, worded as a question even
  when the live ask is gone ("Stuck on a step — give it one more try? Last
  result: …"), with two buttons: "Yes, one more try" and "No, stop here".
- Both always work. With no driver waiting, Yes starts the build again with
  the answer already given (it is not asked a second time) and No leaves the
  project needing attention, its reason kept — where a declined ask ends.
- Details says where the project stands ("awaiting your answer"), not the
  question again. "Resume build" there is for a step that needs attention.

### Reviewed the same day: an answer belongs to one project and one run

The first version kept a Yes in shared state and kept one waiting-answer slot
for the whole app. Two leaks followed, both caught by review and pinned by
tests: a Yes whose build was refused before it started stayed behind and would
have answered a LATER question unasked; and with one project's build parked
live, an answer pressed on another project's row was taken by the first. The
waiting answer is now keyed by project, and a Yes travels with the one run it
starts and is spent on the first question that run meets.

## Figures that agree

Seen on the Work and Settings pages: "38% of runs on your Mac" in the head
beside "67% local" in the rail, and "3,573,470 tokens today, across 108 runs".

- The rail's local meter (a share of tokens) is on every page, so the Work
  head states no share of its own: "113 runs recorded all time", leading to
  Stats, where both shares sit side by side and named.
- "Today" in Settings is counted from the runs stamped today. The store's
  running token total was never reset by day, and the run count beside it was
  every run on record.
- The split under it says what it is a share of: runs.

## Stop

A team run can take five minutes and a build far longer; the room had no way
to stop either. The strip now carries Stop on a run that can really be
stopped.

- **What Stop does.** The engine's own subprocess for that run is cancelled.
  The run ends as "stopped by you" — never as a failure, never as "the engine
  gave no reply" — and what its board had got done is reported.
- **A team run** is told in the room as "Stopped — you stopped this team run."
- **A build** cancels the step in hand, starts no further step, returns an
  attached repo to the user's own branch, and is left needing attention at the
  step it was on: "Stopped by you at step 2 of 3 — Resume build carries on
  from this step."
- **Only where it works.** A run is offered Stop only when its runner honours
  it (`LiveRun.stoppable`): team runs and project builds. A run parked on the
  user has nothing executing and offers none — its answer buttons end it. The
  heartbeat, a manager's job, a standing job and one AI answering a message
  have no Stop yet; one that did nothing would be worse than none.
- A build's card id is not the engine's run id (one engine run per step), so
  the store keeps which engine run is executing for each card.

## The Agents page: a card shows where its seat runs

Every built-in card said "Claude" under a note reading "a seat runs where the
slider puts it, whatever its card says below" — the page told its reader not
to believe its own cards. A built-in agent's badge now shows the AI its seat
really runs on under the workload stop in force (`agentRunsOn`, the same
helper Settings counts seats with), and says on hover what it is set to when
that differs. The note shrinks to the stop and where to change it.

## Not built here

- The same once-only pass on the other pages (Agents, Automations, Settings,
  Library, Console), and the two "local share" figures on the Manager page
  that read as one fact with two values.
