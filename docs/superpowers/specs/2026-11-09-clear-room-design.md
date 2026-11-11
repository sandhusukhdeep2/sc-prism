# The clear room — one hierarchy, each fact once (2026-11-09)

Sukhdeep, looking at the Work page during a live team run (screenshots,
2026-11-09): *"things are very confusing and cluttered. It's working, but the
representation of data is not good. The mockup is very clear compared to what
I see on screen. It should be clear on all screens — big and small windows."*

He is right, and the cause is structural, not cosmetic. The same run was
shown four times on one screen: the TEAM card with its "on it now" chips, the
crew board's seats, a list of per-seat rows under the board, and the chat's
own status lines — plus a black "engine steps" console block and a right-hand
panel set almost entirely in monospace. Every one of those blocks was honest.
Together they are noise.

This spec holds the project-room standard (2026-08-29) as given — a separate
room, the work in the chat, three-part attribution, the privacy line, every
file reachable — and adds the rule that was missing:

> **Each fact appears once, in the place a reader expects it, in the type that
> fits it.** Prose and labels are proportional; monospace is for paths, ids,
> commands and numbers that line up. Nothing scrolls sideways.

## What exists today, honestly

- `Workspace.tsx` (1,600 lines) composes the room: a "Coworker desk" toggle
  with a horizontally scrolling strip of status cards, the needs-you list, the
  main row (chat list · stage · chat · side panel), and the evidence row.
- The stage stacks `LiveRunCards` (the TEAM card), `CrewBoard` (seats +
  handoffs + a per-seat column list + a per-stage "engine steps" console) and
  `ProjectRunStage`. The chat then repeats "lead replied on claude-cli · opus".
- The side panel (`ws__side--project`) sets the project's description in
  monospace, then `ProjectContextPanel` (Agents, Team, Loops, Plan, Verdicts)
  and `LiveActivity`, then two large black buttons (Reveal folder, Delete
  project), then the last result's raw markdown.
- Breakpoints exist for the rail and the chat list only; the side panel stays
  340px wide at every width.

## The design

### A. The room, top to bottom (one column plus a drawer)

1. **Room header**, one wrapping line: name · status pill · the count line
   ("3 agents · 2 worked · 1 working now", from spans and verdicts) · actions:
   `Reveal folder`, `Files`, `Details`. No description here.
2. **Needs you** — unchanged, bounded.
3. **The board** — the one place a seat is drawn. `CrewBoard` keeps its seats,
   handoffs, count line and dossier; it loses the per-seat column list (the
   chat carries those facts as action lines) and its always-open console
   block. While the board is on screen, `LiveRunCards` does not render in the
   room — its "on it now" chips were the board's seats a second time.
4. **The chat** — the work, as seat-attributed lines (name · brand · action)
   with the privacy line and the verdict summary row. Its header gains one
   disclosure, `details`, which opens the run's engine steps inline (the
   former black block) and closes them again. The composer stays.
5. **Details drawer** (the former side panel), readable: *About* (description
   in body type, folder path in mono with Reveal), *Files* (count, opens the
   Files view), *Team* (seat chips: name · brand, from the roster), *Loops*
   (each loop a row with its toggle; the add actions are quiet links), *Plan*
   (numbered steps), *Last result* (rendered markdown, clamped to five lines
   with "show all"), and at the very bottom, small, *Delete project*. Open by
   default at ≥ 1180px as a 320px column; below that it is closed and opens
   over the chat from the `Details` action.
6. **Coworker desk** — a single summary line in the header area ("2 managers
   on duty · 5 loops · heartbeat 3 min ago") that expands to a wrapping grid
   of its cards. The horizontal strip goes.

### B. Type and surfaces

- Body and labels: the UI face. Mono (`.mono`): paths, ids, commands, token
  and cost figures. A sentence is never mono.
- Section kickers (small caps) only where a section truly starts; no kicker
  for a one-line fact.
- Surfaces: the board on `--v2-board` glass, the chat on `--v2-card`, the
  drawer on `--v2-paper-2`; radii and shadows from the tokens; motion from the
  motion tokens (2026-11-09).
- Buttons: one primary per screen (Send). Reveal/Files/Details are quiet
  pills; Delete is a text button in coral at the end of the drawer.

### C. Small windows

| width | what changes |
| --- | --- |
| ≥ 1180 | drawer open as a column; board seats in one row |
| 980–1180 | drawer closed by default (`Details` opens it over the chat); chat list narrows |
| 820–980 | board seats wrap two per row; handoff arrows become short vertical ticks between rows |
| < 820 | icon rail (exists); chat list becomes a `Rooms ▾` menu in the header; needs-you cards stack |

Nothing on the page scrolls horizontally at any width; tables and code
blocks scroll inside their own container.

## Non-goals

- No new data. Every line keeps deriving from spans and store fields; a block
  that cannot be backed stays out.
- No palette change. The amber/light system and its dark counterpart stay.
- The Agents page, Library, Console and Settings get the same type rules in a
  later pass; this spec is the room.

## Order of work (each slice TDD, gated, mirrored, rebuilt, looked at twice)

1. Drawer: side panel → readable Details with the sections above; header
   actions; description out of mono; last result rendered and clamped.
2. One board: TEAM card and per-seat rows leave the room; engine steps behind
   the chat's `details` disclosure.
3. Desk: summary line + wrapping grid.
4. Small windows: the table above, verified in the installed app at 1440,
   1100 and 900 points wide.

Each slice ends with two screenshots from the installed app (wide and
narrow) and a line in the ledger saying what was seen.

## Addendum — the sidebar folds (2026-11-11)

Sukhdeep, looking at the Details drawer after slices 1–5: *"Sidebar is totally
cluttered. It's not working good. It's not looks good."* Readable type was not
enough: the drawer still showed every block at full height — description,
path, files, agents, a team paragraph, an override link, a hint, loops with
three buttons and a row, the plan, a reveal button, the last result, verdicts.

The sidebar is now three zones:

1. **The folder.** Name, status, description (three lines, full text on
   hover), and the path — which is itself the reveal action.
2. **What needs you**, never folded: merge, Start build / Approve, Resume,
   the running note, a waiting question, the run stage.
3. **The facts**, one line each, open on demand (`DrawerSection`): Plan (open
   until the project is done), Last result (open), Team, Files, Loops,
   Verdicts. Each line carries a summary read from the stores
   (`lib/drawerSummary.ts`): *default team · 5 seats*, *1 loop · off*,
   *1 step · done*. A folded line never hides a problem: a seat that sits out
   or a team nobody can staff shows in the Team line itself, in coral.

Folded means not rendered. The second "Team" block at the bottom of the
drawer (five rows repeating one model-wide number) is removed; the roster
line inside Team is the one statement of who will run. Delete stays last and
small.
