# The split room — chat on the left, the work on the right (2026-11-12)

The owner, comparing SC Prism with the desktop coworker app he uses every day:
*"I need a chat feed represented like that… very well organized compared to my
software, including the sidebar… it can open a browser or artifacts and other
stuff in the right half, and the left represents the information. I need one
page just showing the animation when it's working. If a user wants to explore
through the chat, put the chat on the left side and put the animated agents
working with each other on the right side."*

He sent eight screenshots of that app as the reference. What they show, and
what this spec takes from each:

| in the reference | here |
| --- | --- |
| one sidebar: a few actions, a pinned list, sessions grouped under collapsible headings, the account at the bottom | the room list joins the app's rail: actions, the Manager, projects grouped by state, settings at the bottom (slice 3) |
| a narrow, readable chat column; tool activity folded to one line that opens into step rows; results as cards with an Open button | the same: a run is one folded line in the chat, its steps open in place, and a file it wrote is a card that opens on the right (slice 2) |
| panes that open beside the chat — an artifact, a browser, files — each with its own header, closable, expandable | **the room pane**: Stage, Steps, Files, Details (slice 1) |
| a settings dialog: searchable categories on the left, label / description / control rows | Settings split into categories (slice 4) |

## Slice 1 — the room pane

The Work room's main row becomes **rooms · chat · pane**.

- **The chat is always the chat.** It no longer swaps places with the stage:
  the `Stage | Chat` tabs go. The conversation, the composer and the lane line
  stay exactly where they are, in a column that keeps a readable measure.
- **The pane holds what the work produces**, one tab at a time:
  - **Stage** — the run drawn to be watched (`RunStage`), who is speaking, and
    anything parked on the user. Offered whenever there is a crew to draw.
  - **Steps** — the engine's own record of the run (the terminal side).
  - **Files** — the project's folder: a filterable tree and a reader. Project
    rooms only.
  - **Details** — the project's plan, last result, team, loops and verdicts
    (today's drawer). Project rooms only.
- **It opens by itself when there is something to watch.** A run starting
  opens the pane on Stage. A choice made by hand — another tab, or closing the
  pane — holds until the next run starts. When the run ends the stage stays
  where it is, as a still picture, unless the project now needs the user —
  then its details come back, because they hold that button.
- **Each fact still appears once.** The crew is drawn in the pane, so the
  board above the chat and the live cards leave the chat column; the run's
  timer and Stop sit in the pane's header.
- **A header like a pane's**: its tabs, an expand button and a close button.
  Expand opens the Live page. While the pane is closed the chat's own header
  offers what the room can open; while it is open the pane's tabs say what is
  showing, and the chat's header does not repeat them.
- **One AI answering a chat message does not open the pane.** Team work — a
  team run or a project build — takes it by itself; a single answer only
  offers the stage. A run parked on the user opens it too: the board's "Your
  call" card is where it says what it is waiting for.
- **Small windows**: at 1180 points and wider the pane is a column beside the
  chat. Below that it opens over the chat from the same buttons, and closing
  it returns to the chat.

## The Live page

`/live`, and a sixth place in the rail — the stage alone, as large as the window allows, for the run that is
executing now (or the last crew run when nothing is). Under it, one line of
who is speaking. A link back to the room. Nothing else. It is the pane's
Stage tab, expanded — the same component fed the same spans.

## Slice 2 — a run's own turns fold under its answer

A team run posted every seat's board turn as a full bubble, so the answer sat
under a screen of working-out. Two or more consecutive seat turns now render
as one line — how many turns, from which seats — that opens in place to every
turn exactly as written (`lib/chatFold.ts`). It is a view fold, like repeated
notices: the stored thread is untouched, nothing is summarised by a model, and
nothing is dropped. One seat's single turn stays a bubble.

## Slice 3 — one sidebar

Work drew a second 186-point column of rooms beside the app's rail. The rooms
are now drawn **in** the rail, under the places (`lib/railSlot.ts`: the rail
owns a slot, the Work page draws into it), and the room gets that width back
for the chat and the pane. A room's name has the rail's width; its state is a
small mark in the state's colour, with the word still in the markup and on
hover, and a finished project carries no mark. Leaving Work empties the slot.
In the icon rail of a small window there is no room for them, so the Rooms
menu stays.

## What does not change

- No new data: every mark is still a span or a store field.
- Motion is still a claim: nothing travels unless an engine process is doing
  that work now.
- The folder lane, the routing line and the privacy floor are untouched.

## Not in this slice

- A live browser in the pane (it needs a browser plugin server).
- Pages an agent fetched, shown as readable snapshots (slice 5).
