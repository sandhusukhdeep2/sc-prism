# The chat is the room (2026-11-14)

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

## Not built here

- **Stop.** There is still no way to stop a run from the room. A chat send
  and a project build register under an id that is not the engine's run id, so
  a Stop that works for every kind needs that plumbing first. Next slice.
- The same once-only pass on the other pages (Agents, Automations, Settings,
  Library, Console), and the two "local share" figures on the Manager page
  that read as one fact with two values.
