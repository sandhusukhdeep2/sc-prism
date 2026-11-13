# Coworker-parity sprint — Sukhdeep's screenshot review, 2026-08-30

His words, consolidated (two screenshots: his Claude Code transcript = the
bar; SC Prism's repeated anonymous failure bubbles = the miss):

1. **Feed like a cloud coworker.** Each project strictly its own chat (never
   mixed); the feed shows WHICH agent does WHAT — terminal commands, file
   edits, agent↔agent and agent→manager communication, properly elaborated.
   Repeated identical app-voice bubbles (his screenshot: 3× the same step
   notice) are noise — collapse them honestly (one bubble, ×N, latest time).
2. **The "default initial chat" shouldn't exist as a peer.** The universal
   thread reads as a leftover. Decision: it becomes the MANAGER's chat —
   named for what it is (talk to your manager) — projects are rooms beside it.
3. **Sidebar is very complicated — simplify** (my plan, my call).
4. **Files must open IN the app.** File links that only reveal in Finder are
   not enough: a read-only viewer (markdown rendered, code in a pre, html as
   source) opens in-app; reveal in Finder stays as the secondary action.
5. **The target picker is too complicated.** Default = TEAM (different AIs,
   different agents — "by default Sukh is using a team"). Manager-managed is
   the alternative; agent/staff/propose fold behind "more". Two visible
   choices, not five.
6. **Real tool power for agents.** "They are not able to search the internet,
   control the browser, control the PC." Web research becomes actually usable
   (on by default within the governed allow-list/egress rules; seats with
   tools:[web] really browse), and the computer capability (engine slice
   landed 19261ca) gets its client grant surface. Verified with real runs,
   not claimed.

Order: (A) feed dedup+depth, (B) picker default team + manager rename,
(C) in-app file viewer, (D) real web/computer capability surfacing + live
verification, (E) sidebar simplification. Each slice TDD → gate → push;
rebuild after each batch.

## Addendum — a small message is not a job (2026-11-11)

Item 5 made the TEAM the default lane. The owner, after using it: *"Even on a
hello or go or any small message, it utilizes all three AIs. That's not a good
thing… Primary AI should do that."* The default lane stays the team; what
changes is what counts as a job for it.

- `lib/messageWeight.ts` — `smallMessage(text)` says, by rule, whether a
  message is a greeting, a short message or a short question (first rule that
  fires wins; one work word anywhere makes it a job). A rule, not a model: who
  takes a message is the orchestrator's decision (ADR-007, ADR-027).
- `decideRouting` rule 2b — after the sensitivity floor and before any team:
  a small message goes to the primary alone ("Claude answers it — a greeting,
  not a job, so no team is staffed"). If the primary cannot answer, the
  strongest reasoner connected does.
- The team picked BY HAND (the `team` control in the composer's Change panel)
  wins over the size of the message, for that one send. A file or image riding
  along makes any message a job.
- The composer says where the message really goes before the send
  (`effectiveTarget`): the sentence beside Send, the hint bar and the controls
  all read the same value the send uses.

## Parity audit — what an app-launched run can really do (2026-11-11)

Asked for: *"controlling PC, controlling browser… all the features [a cloud
coworker has]… skills, plugins, agents, all working properly."* Read from the
code, not from the docs:

| capability | state | what is missing |
| --- | --- | --- |
| Web research | works when the Settings opt-in is on: `web_fetch`, `web_search` | — |
| Vault tools | work: list / read / search / project status | — |
| Terminal | works behind its grant: bounded, kills the process group | — |
| Skills | work: matched skills are disclosed into the prompt; usage is counted | — |
| Team seats | real: each seat runs on its own model with its own grants | the composer's single-`agent` target is a brief on the primary, not a runner |
| Computer control | five tools behind a strict opt-in; since 2026-11-11 the screenshot is SHOWN to the model (resampled to screen points, so a click lands where it is seen) and obeys the vault's egress floor — it keeps the run local, is withheld when there is no local model, and reaches a cloud model only behind the owner's explicit switch. Settings has the three switches | a live proof: needs the owner's Screen Recording + Accessibility grants and a local model that can see |
| Browser control | **absent** — the web tools fetch and search; nothing drives a page (navigate, click, fill) | a governed browser tool source |
| Plugins (MCP servers) | registered in Settings; since 2026-11-11 the registered names ride the manager's run and team runs (`settings.mcpServers` → `--mcp-server`) and lift the capability ceiling to `tools` | project runs (the engine's `project` command takes no `--mcp-server`); a live proof with a registered server |

Order of work: (1) plugins reach real runs — done for the manager's run and
team runs; (2) computer use that can see — built, not yet proven live;
(3) a browser tool source; (4) a per-agent runner for the composer's `agent`
target. Each needs a real run in the installed app as its proof.

## The optional libraries ship with the app (2026-11-11)

The owner: *"use or install or include these libraries in the package, because
these are the main functionality of the application."* All three read "not
installed here" in the installed app.

- **Prism Gateway (the Go daemon)** had been in the bundle all along; the
  availability check only looked at a developer checkout.
- **LightRAG and DeepEval** are installed together, at pinned versions, into
  one environment built with the app's own portable Python
  (`scripts/build-extensions.sh` → `engine/.venv-ext`), and `prep-bundle.sh`
  stages its site-packages at `resources/ext/site-packages`. The bridge adds
  that folder to the engine's import path for a run that switches one on, so
  both can be on at once.
- Their data (LightRAG's graph index, DeepEval's cache) lives in
  `<vault>/.scprism/ext` (`SCPRISM_EXT_DATA`) — the engine folder is inside the
  signed bundle in an installed app.
- **LightRAG reads note text, so its model calls are local only.** They used
  to follow the gateway's normal routing (the cloud primary on most installs).
  With no local model the graph index is not built and the built-in recall
  answers. A real run now gets the graph retriever when the switch is on; the
  first such run indexes every note on the local model.

## A job is done in the folder it is about (2026-11-12)

Found by sending a real job from a finished project's room in the installed
app: *"Rewrite hello.md as a warmer two-line greeting to the crew, then say
what changed."* The team ran for three minutes, the verdict passed, and
nothing on disk changed — the lead reported that there was no `hello.md` to
rewrite. Two things were true:

1. **A conversation in a project's room was blind to the folder.** The team
   launch built its providers with no project at all; a chat turn was told the
   project's name and plan and nothing of what was on disk.
2. **Only a project's plan could ever write to its folder,** and the plan
   ended when the build did. A finished project — or an opened folder — could
   not be given another job.

The owner's ask: *"work on an already existing project. User needs to select
the directory… whatever other software offers with open project."*

### The rule

A project's room has two honest lanes for a job, and they are not
interchangeable:

| lane | what happens | when it is the default |
| --- | --- | --- |
| **the folder** | the job becomes the project's next step; the same governed build that ran the plan reads the folder, writes the files, runs the project's checks and records a verdict | the message opens by asking for a change |
| **a conversation** (the manager, or the team) | the turn is shown the folder read-only and answers about it; it writes nothing | a question, a remark, a request to look |

- **The lane is decided by rule, never by a model** (`lib/jobKind.ts`
  `asksForChange`: the first word after any lead-in — "please", "can you",
  "now" — is a change verb). It is shown above the composer **before the
  send**, with its reason, and one click flips it (`lib/roomLane.ts`).
- **Nothing new can write to a folder.** A folder job is appended to the plan
  (`lib/projects.ts` `addProjectStep`) and run by the existing build driver —
  same branch-per-run discipline in an attached repository, same never-touch
  list, same file-writes grant, same verdicts on the board. The build simply
  no longer ends with its plan.
- **A refusal is asked before the plan is touched** (`folderJobBlock`,
  `buildStartRefusal`): a build already running, a step that needs attention,
  file writes denied, no real provider. A refused job leaves no step behind,
  and the room never says work is under way when nothing started.
- **An opened folder is not interviewed.** A folder the user pointed the app
  at, with no goal given, already holds the work: it can be asked about and
  given a job straight away. A project that was given a goal, or only a name,
  is still planned first.
- **A step is shown the files it names** (`project.named_source_files`), read
  back from disk inside the refine budgets — on the first attempt, not only on
  a refine. A step that changes a file it was never shown does not change it;
  it replaces it with a guess. Naming is a lookup, so a step that names
  nothing still pays for nothing; a folder job (`--show-folder`) is also shown
  the most recently changed files.
- **A conversation is shown the folder read-only** (`run` / `team`
  `--project-dir` → `project.folder_context`): the file list and the current
  content of the files the message names. The section is appended to the
  **routed** text, so a sensitive word in a quoted file keeps the turn on the
  local model exactly as the same word typed by the user would. It says in its
  own heading that the conversation cannot change the files.
- **Attachments do not travel to the folder.** The folder lane takes words;
  with a file or an image attached the message stays a conversation, and the
  composer says so if the folder is picked by hand.

### Not built

- A job sent while a step **needs attention** is refused; it does not jump
  the queue or replace the failed step.
- A conversation cannot yet *propose* a folder job the user accepts with one
  click; it can only say what it would change.

## Each AI's thinking effort is its own (2026-11-12)

Settings holds a thinking-effort level **per provider**. Only the primary's was
forwarded (`SCPRISM_EFFORT`), and the gateway applied that one level to every
provider in the run. On the owner's machine the critic seat ran on Gemini with
the level chosen for Claude: about seventy output tokens took between 10 and
117 seconds, and three calls hit the 120-second bound and stalled whole team
runs.

- The client sends every enabled provider with its own level
  (`lib/efforts.ts` → `SCPRISM_EFFORTS`, `provider=level` pairs).
- The gateway gives a provider **its** level or none at all
  (`Gateway.effort_for`). A provider the list does not name runs at its own
  default — it never inherits another's.
- An engine told nothing (an older client) keeps the single run-wide level.
- The bridge passes only clean `name=level` pairs; a garbled list still counts
  as "a list was given", so it can never bring the run-wide level back.

Not yet proven against the live provider: the fix is the mechanism; whether it
ends the Gemini timeouts is to be read from the next real team run.

## The workload slider (2026-11-12)

The owner: *"one slider that changes the dependency… if the user wants the
primary AI to just give the instruction and check the work, it can do only
that, and all the workload is on local… fix by your measurement first, but give
the slider to the user. If the user wants to go all in with local, he can."*

He had asked for a version of this three times, and each answer was a
different control: a dial that only moved single chat messages (2026-08-29),
then buttons that rewrote every agent's model (2026-08-31, 2026-09-03). None of
them was about **who plans, who does the work and who checks** — which is what
he kept describing. The slider is that control, and it replaces the other two.

### The stops

A stop is a rule about seats, applied by code (`lib/workload.ts`). A seat's
kind is read from its role name: one that leads or plans, *plans*; one that
reviews or verifies, *checks*; every other seat *does the work*.

| stop | plans | does the work | checks |
| --- | --- | --- | --- |
| All primary | primary | primary | primary |
| Primary leads and checks | primary | local | primary |
| Primary checks only | local | local | primary |
| All local | local | local | local |

- **A seat that reads the user's notes stays local at every stop** — the
  privacy floor's instinct, applied before the run instead of in the middle
  of it.
- **A second opinion** (off by default): where the primary would have checked,
  the second connected cloud AI does. Never at All local.
- **An AI that is not connected is never seated.** The seat keeps the AI it
  had.
- **"Each agent's own AI"** switches the slider off.

### What it applies to

The **default team only**: the composer's team run and a project's system
agents. A project's own assigned agents and a hand-typed roster are explicit
choices, and a slider does not overrule an explicit choice. It is an overlay
resolved at launch — **no agent file is rewritten** — so switching it off gives
every seat back exactly as it was. All local also keeps single chat messages
on this Mac (the old dial's "Local first").

### Measured first

The slider starts on **Follow my measured runs**: the stop the Tier-2 judge's
mean score for the local model points to (`lib/workloadMeasure.ts`, the same
`qualityForModel` the local-model picker shows). Ten judged runs are needed
before anything is suggested; at 0.75 and above the local model plans as well
as does, at 0.5 and above it does the work under a primary that plans and
checks, below that the work stays on the primary. All local is never
suggested — it gives up the independent check, and that is the user's choice
to make. With nothing measured, "measured" changes nothing. The measurement is
cached in Settings at launch so a run can follow it without the Settings page
being opened.

### Shown before it is used

The Settings card lists the default team's seats at the stop in force — what
each is for, which AI it runs on, and what it moved from — and the per-AI seat
count and the Agents page say when the slider is re-seating.

### Not built

- A stop states the local model's measured speed, but not yet an expected
  run time or a cloud-token estimate for that stop.
- A manager's own team jobs are not re-seated by the slider.

## The graph build can be stopped and continued (2026-11-14)

Measured on the owner's vault: 81 notes on a local model took about ten
minutes a note — a thirteen-hour build. Every start wiped the folder, so
stopping it, or the app restarting, threw the hours away.

- **A build continues.** The library keeps a status row per note; a build run
  again hands it only the notes it has never seen and then runs its own
  processing step, which picks up everything unfinished — pending, failed, or
  cut off mid-way. (Handing it a note it already has does not retry that note:
  it files a second, failed "file name already exists" row. Found against the
  real library.)
- **Starting over is asked for by name** (`graph-index --fresh`; "Start over"
  and "Rebuild" in Settings).
- **Ready means every note.** A graph missing some notes is left unmarked and
  continuable; a run attaches only to a finished one. While a graph is being
  rebuilt it is not ready.
- **A stand-in reply fails its note.** During a build a model that did not
  really answer raises, so the library marks that note failed and retries it,
  instead of filing an empty extraction as a finished note.
- **Settings says how far it got**: "15 of 81 notes are in the graph", with
  Continue and Start over; while building it shows the library's own count.

Not built: an expected-time figure before a first build (the card says in
words that a large vault takes hours); picking up notes that CHANGED since
they were indexed without a full rebuild.

## Three levels: talk, a job for two, a job for everyone (2026-11-14)

The owner, watching his tokens: *"a normal hello, hi, or a normal thinking
question — only the primary AI can answer them, no token burn. If things get a
little complex, the primary and local; more complex, him, local and all the
other AIs. Even a normal hello takes lots of tokens and all three AIs."*

Two things were really wrong after the small-message rule of 2026-11-11:

- A message with **no words in it** — he had sent `?` — was not "small": the
  rule counted words and found none, so it staffed three AIs and spent 8,121
  tokens.
- An **ordinary question** longer than six words was a "job", so it staffed
  three as well.

### The rule (`lib/messageWeight.ts` `messageLevel`)

| level | what it is | who gets it |
| --- | --- | --- |
| **talk** | a greeting, a message with no words, a question that names nothing to make, "explain…", a short remark | one AI — the primary. No team, no judge, not counted as a run |
| **a job** | one piece of work, or a sentence that opens as a request | two seats: the one that does the work and one other (`lib/workload.ts` `jobRoster`) |
| **a big job** | work that asks for more than one pair of eyes (review, research, audit, compare, debate, "second opinion"), a list, work after work ("…then…"), a brief over 45 words, a file riding along, or the team picked by hand | every seat of the default team |

- **Still a rule, never a model's guess.** Asking an AI how many AIs a message
  needs would itself cost a call on every hello. The level is shown above the
  composer before the send, with its reason, and picking the team by hand
  always wins.
- **The second seat of a job follows the workload slider.** The two seats are
  taken from the default team as the slider seated it: the worker, plus a seat
  on the primary if there is one (the lead first, then the check — so "primary
  checks only" keeps the check), else the lead.
- **The line names the seats that are sent** (`lib/teamSend.ts`): "lead on
  Claude + researcher on your local model · one piece of work, so two seats".
  It used to come from a separate reading of who would lead, which could name
  an AI the slider had since moved off that seat.
- The sensitivity floor still comes before all of it.

## Deleting what a room holds (2026-11-14)

The owner: "give me option to delete project loop other stuff also." Audit of
what could and could not be removed:

| Thing | Before | Now |
|---|---|---|
| A project's standing loop | on/off only in the room (removable only from Automations) | ✕ on each loop row in the room |
| A plan step not yet started | not removable | ✕ on the step; steps that ran, or were tried and sent back, stay as the record |
| A project | removed the record only — its loops kept firing at nothing, its agents stayed assigned to nothing, its conversation stayed in the session store unseen | loops removed with it; agents kept and returned to the library; conversation archived to the vault (`conversations/<id>.md`) and then emptied — the same archive-before-drop contract as `New session` |
| Conversation, agents, skills, jobs, plugins, custom AIs, vault notes | already removable | unchanged |

Rules:

- The Delete confirm states everything that will happen in one sentence
  (`removalNote`), counted from the live stores (`removalScope`).
- Nothing is taken off a plan under a build that is running, waiting on the
  user, or stopped needing attention — the build holds the plan it started with.
- Removing the only step still ahead leaves the project `done`; removing every
  step leaves it with no plan (`new`).
- The marker for jobs typed in the room (`jobsFrom`) moves with the steps
  before it and is dropped when no such job remains.

## The day's model check (2026-11-14)

The owner: "every time when we start working for the day on this software,
check the new available AIs models and add to in our list and utilize the model
according to your need. Primary AI is the one who is deciding. Always prefer a
new one, the greatest one."

On the first launch of each calendar day — and, for an app left open overnight,
the first time its window is come back to — each connected AI is asked what
models it offers (its own models endpoint; no tokens are spent). The answer is
kept (`scprism.modelCheck`), so the next day's check can say what is new.

A check may also MOVE an AI to a newer model. Every move is decided by rules
(`lib/modelCheck.ts`), never by a model — the same invariant as routing:

| AI | What a move may be | Proof required |
|---|---|---|
| A metered key (Claude, OpenAI, Gemini, a custom service) | a newer version of the SAME model line (`claude-fable-5-1` → `claude-fable-5-2`). Never another tier, a preview or a mini — those change the bill or the behaviour | the model is on that AI's own list for this key |
| The primary on the Claude subscription CLI | the plan's top model (`opus` → `fable`). A tier move there costs limits, not money | the CLI answers once on that model (`probe_cli … --model`) |
| Any other subscription CLI | none — its runs are not passed a model, so a "move" would change a value nothing reads | — |
| The AI on this Mac | none. Its place on the workload slider was measured on the model it has; new local models are reported for the user to pick | — |

An always-current alias (`gemini-flash-latest`), the CLI's own default and a
hand-typed model id are never moved: each is a choice made on purpose.

What changed is said once, by the app, in the Manager's room, and kept in
Settings → Your AIs → Newest models, with a switch to stop the moving (the
looking and reporting continue) and a Check now. A model that should have been
moved to but did not answer is reported with the CLI's own reason.

## Who writes a build's files (2026-11-14)

Found by driving the installed app: a job sent to a project's folder ran its
board three times over ten minutes and changed nothing — "all file writes
rejected: planner was not granted the 'writes' capability".

Cause. The engine lets ONE seat of a build write: the board's lead, the first
seat of the roster, which synthesizes the FILE blocks. On 2026-11-09 the
built-in agents were given grants of their own (vault, web). From then on every
build on the default team sent a grant table — in which no seat held `writes` —
with the Planner in front. No project build on the default team could write a
file, and it only said so after the run. (A second fault hid in the same
lookup: a roster names a seat by its slug, and "Reviewer / Verifier" was looked
up by name only, so it entered the grant table holding nothing.)

Rule (`lib/buildWriter.ts`), applied before anything runs:

1. No seat carries any grant → nothing is gated; the roster is untouched.
2. A seat holds `writes` → it leads the build. It is the one that writes.
3. Every seat is a built-in agent → the seat that does the work (the
   Implementer) is asked for `writes` for this build, and leads. Whether writes
   are allowed at all is still the user's own project-writes grant, which the
   engine intersects again.
4. Otherwise — a team the user staffed with no seat approved to write — the
   build is refused before it runs, saying what to change. The app never hands
   `writes` to an agent the user configured without it.

The engine refuses the same case itself before its first model call
(`_writer_refusal`), so no client can pay for a board that cannot write.

Not done: the built-in Implementer's card on the Agents page still lists only
the vault grant, though a build asks it for writes.
