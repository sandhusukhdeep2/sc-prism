# SC Prism

**Control over the AI you run. Not a promise — a record.**

[![verify](https://github.com/sandhusukhdeep2/sc-prism/actions/workflows/verify.yml/badge.svg)](https://github.com/sandhusukhdeep2/sc-prism/actions/workflows/verify.yml)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/sandhusukhdeep2/sc-prism?label=release)](https://github.com/sandhusukhdeep2/sc-prism/releases/latest)
![macOS 14+ on Apple Silicon](https://img.shields.io/badge/macOS-14%2B%20·%20Apple%20Silicon-lightgrey)

**[Download for macOS](https://github.com/sandhusukhdeep2/sc-prism/releases/latest)** ·
**[Build from source](BUILDING.md)** ·
**[Website](https://sandhusukhdeep2.github.io/sc-prism/)** ·
**[Design docs](specs/00-project-blueprint.md)**

SC Prism is a governance and orchestration platform for people who want to run
many AI agents and still know exactly what they did. Multiple models work one
shared board, deterministic code decides who acts, every action lands on an
auditable record, and your own tests — not the model that did the work — decide
whether it counts as done.

It is **open source under Apache-2.0** and ships today as a single macOS app
for one person. That is the first step of a deliberate sequence, not the shape
of the thing.

![SC Prism at a glance: you describe one job; a deterministic orchestrator staffs a board with a seat on each AI you have; every call passes your grant, the agent's own definition, a destructive-command denylist and a privacy floor; your own tests decide the verdict and everything lands on a hash-chained record — shown with four screenshots of the running app](assets/hero.png)

<sup>The four panels above are real captures of this build in ordinary use —
see [Look inside](#look-inside).</sup>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-it-works-dark.svg">
  <img alt="How one run works: you ask; a deterministic orchestrator staffs a crew with each seat on its own AI; every tool call passes your grant, the agent's own definition and a destructive-command denylist; the work is verified by your own tests at zero tokens before any AI judge; the result is a verdict with replayable hash-chained evidence. A privacy floor evaluated before every routing decision pins credential-bearing text to the local model." src="assets/how-it-works-light.svg">
</picture>

---

## The bet

**The harness — not the model — decides whether you can depend on what ships.**

Every serious tool now fans work out across agents, so "many agents" is
commoditising fast. What is not commoditising is being able to prove what they
did: a verifier that runs your own checks first, an audit trail you can replay,
routing that keeps sensitive work on your machine, and routing that gets
cheaper as it learns from verdicts rather than from vibes.

*Provably done, on-prem, at falling cost.*

## Where this came from

SC Prism is the third form of an idea. The first, **OpenLux**, hit a dead end
worth naming: a primary AI controlling other AIs. It fails because the thing
you most need to trust — who decides, in what order, with what permission — is
delegated to the least predictable component in the system.

SC Prism inverts it. A deterministic orchestrator controls the models; a model
never controls models. Everything else follows from that one decision.

## What "control" actually means here

Six things, each enforced rather than promised:

- **You decide what each agent may touch.** Capabilities are granted per agent,
  declared in the agent's own file, and gated at the moment of the call — not
  configured once and forgotten.
- **Sensitive work cannot leave.** A routing floor pins credential-bearing text
  to your local model, and it is evaluated *before* any routing decision, so no
  budget, preference or convenience can override it.
- **Every action is on the record.** Which agent, on which model, ran which
  command, read which file, with what result — hash-chained, replayable, and
  written whether or not anyone is watching.
- **Done is decided by your tests.** A deterministic gate runs first at zero
  token cost. Only work that survives it reaches an AI judge.
- **Many models, one board.** Claude, Gemini and models on your own hardware
  take different seats on the same task, and the record shows who did what.
- **Your knowledge is yours.** Agents, skills, projects and verdicts are plain
  markdown in one folder. Readable in Obsidian, diffable in git, portable to
  any machine — and to other tools, because the formats are open standards.

## Open standards, one per layer

Vendor-neutral by construction, which is the direct answer to lock-in:

| Layer | Standard | What it connects |
|---|---|---|
| Tools | **MCP** | agents to external tools and services |
| Agents | **A2A** | agents to each other |
| Knowledge | **OKF** | your vault to any consumer |
| Capabilities | **Agent Skills** | reusable procedures to any agent |

A skill written elsewhere works here; one written here works elsewhere. Your
knowledge and capabilities are portable on day one, not after an export.

## Who it is for

**Solo builders** who want a crew without giving up oversight — and who would
rather see a refusal than a plausible answer.

**Teams and enterprises** who need AI work to be attributable, permissioned and
auditable before it can be adopted at all. The governance model — distinct
identity per agent, role and attribute based access, least privilege bound to
the moment and expired after — is the product, not a setting inside it.

The solo app is first because it is the honest way to prove the core: the
founder is user number one, and SC Prism builds SC Prism.

---

## Why this exists

AI tools ask you to trust a black box. SC Prism is built on the opposite bet:

- **A model never orchestrates models.** Deterministic code chairs every
  multi-agent run. Agents contribute; the machinery decides whose turn it is.
- **Done is proven where there is something to prove.** When a run is bound to
  a project, a deterministic gate runs first — your tests, lint and build, at
  zero tokens — and a failure there short-circuits before any judge spends a
  token. When there is nothing to compile, the gate says so out loud
  (*"skipped — nothing was checked"*) instead of showing a tick it did not
  earn. A failed check is shown as a failure, in red, with the reason.
- **Privacy has a floor.** A keyword gate scans every message and every tool
  result before it can leave the machine. Text carrying `password`,
  `credential`, `api-key`, `token`, `secret` and the terms you add yourself is
  pinned to your local model and cannot go to the cloud — even when you
  explicitly ask for cloud. It is a word-level gate, not a content classifier:
  on its own it will not recognise an unlabelled API key, an account number or
  a home address. For work that must never leave the machine, set the
  dependency dial to **Local first**.
- **Everything is a file you own.** Agents, skills, projects, verdicts, and
  reports are plain markdown in one vault folder — readable in Obsidian,
  diffable in git, portable anywhere. Nothing is locked inside the app.

## What you can watch it do

Every room opens on its team, and when you send a job you watch that team do
it — live, attributed, and real:

- **The team is on a board, always.** Each seat shows its name, the AI it runs
  on, what it is doing right now and the tokens it has used. The seat at work
  breathes; the handoff in flight is drawn between the two seats it joins.
- **The run is written out as it happens.** One line per stretch of one seat's
  work — who, on which AI, what it searched, read and answered, and who it
  handed to — each line from a recorded step. The full step log opens beside
  the chat on request.
- **Every seat's turn is kept.** When the run ends, each turn is one line that
  opens the whole contribution exactly as it was written, with the manager's
  synthesis standing on its own under them.
- **One strip says how it ended.** Whether it passed, what your checks and the
  reviewer said, how much stayed on your Mac, what it cost — and a run that
  did not pass says why, in the engine's own words.
- **Governance is part of the story.** A blocked call is marked on the line of
  the seat that tried it. Notes read on a local seat are marked as having
  stayed local, and results withheld from the cloud are counted.
- **You can stop it.** A team run or a build stops from the board, and a
  stopped build resumes from the step it was on.

## Look inside

Captures of the build you can download, in ordinary use — not mockups. Each
frame is the working area of the window; the sidebar is left out because on
the Work page it lists the author's own projects by name. Nothing inside a
frame was retouched and no figure was altered: every number is what the app
measured on the runs behind it.

### The room: your team on a board, and the run written out

The Manager, on a Claude subscription, has answered and handed to the
Researcher on the local model, which searched the web, read two pages and
handed on; the Critic is thinking. The same three facts are on the board
(who is working, on which AI, with how many tokens) and in the lines under the
question (what each one did) — and the head of the room counts them.

![The Manager's room mid-run. A team board shows three seats — Manager, Researcher and Critic — each with the AI it runs on, its state and its tokens; packets travel the handoff from Researcher to Critic, whose ring is breathing. Under the question in the chat, three lines read: Manager answered and handed to Researcher; Researcher searched the web, read two sites, answered and handed to Critic; Critic is thinking.](assets/shots/01-work.png)

### Your crew, and where each seat really runs

Agents are markdown files in your vault, not rows in a database. Each card
shows the AI its seat really runs on — here one setting puts planning and
checking on Claude and the work itself on the local model — and whether the
agent is proven: by a one-call proof, or by turns it has really answered.

![The agents page: five built-in agents — Planner, Implementer, Reviewer / Verifier, Researcher, Retrieval — each card carrying a badge reading Claude or local, the line "proven in real runs", its skills by name, and its own count of turns and tokens.](assets/shots/02-agents.png)

### Skills the crew can use — and tools it builds when none fit

Skills are the open `SKILL.md` format, so one written for Claude Code, Codex,
Cursor or Gemini CLI works here unchanged, and each card says how the skill has
actually scored — a skill that keeps failing is marked as underperforming.
When the crew hits a job no tool covers, it writes one, and that tool stays
inert until it passes four gates. The two at the top show the system refusing
itself: one is scope-approved but unproven, the other is quarantined for asking
for access it never declared.

![The skill library: two crew-built tools held at the gates — one scope-approved and not yet proven, one quarantined — above four portable skills, each with its uses and pass rate, three of them marked underperforming.](assets/shots/03-skills.png)

### Your AIs, on your terms

Bring a subscription, an API key, a local server, or all three — each switched
on separately. A local model is measured where it runs: its speed, its judged
quality, and which kinds of work it is the best choice for on this machine.
Keys go to the gateway and are never rendered back into the interface. Nothing
is configured for you and nothing phones home.

![The Your AIs settings: a local model connected at an address on this Mac, with a panel of measurements taken here — tokens per second, mean judged quality, and the kinds of work it is the best measured choice for.](assets/shots/04-ais.png)

### The governance console — yours, single-machine

Burn by provider, hook latency and fire-rate, drift across runs, the eval
scores behind the verdicts, and the record of recent runs — with the whole
hash-chained record exportable as a compliance report. On the day of this
capture the drift monitor was raising an alert, because the judged score had
fallen, and the page says so.

![The governance console: token burn split between the local model and Claude with 67% of tokens on this Mac, hook latency and fire-rate with no blocks and no hook errors, a drift alert reporting that the eval score fell, eval scores with a compliance export button, and a table of recent runs with their outcomes.](assets/shots/05-console.png)

### Where the money and the checks actually went

Not a promise about local-first — a measurement of it, taken from the runs you
have already done: here 67% of tokens stayed on the machine and three dollars
were attributed to cloud calls. The dark card counts the failures that free,
deterministic checks stopped before any AI judge was paid for — and says, in
the same breath, how many runs could not be checked at all.

![The stats page: 55 failures blocked by deterministic checks across 126 checked runs, with the runs that could not be verified stated beside it; token share by route at 67% local; a cache card; the eval score trend; and cost over time.](assets/shots/06-stats.png)

## The capability system — real power, three locks each

Agents can research the web, control the computer (screenshots, opening
apps), and run terminal commands — for real jobs: builds, 3D pipelines,
whatever a terminal can do. Every capability sits behind three locks:

1. **Your grant** — computer and terminal access never default on.
2. **The agent's own definition** — a seat only holds a tool its own file
   declares.
3. **The approval gate** — every acting tool stops for your yes the first
   time. Approve it once and it stays granted until you revoke it in
   `<vault>/mcp-approvals.json`. What ran is what is recorded: command,
   folder, exit code.

## One vault, everything in it

Your chosen folder (an Obsidian vault works) holds the whole company: agent
definitions, skills, every project and its files, every verdict with its
hash-chained evidence, every report. Open it in any editor. Take it to any
machine.

The app includes its own project workspace too — a file tree per project,
edit-and-save with a diff gutter, one-click preview of any HTML page or image
in your default apps.

## Cost, honestly

A dependency dial (Local first · Balanced · Online first) sets how much work
leaves your Mac. The ledger derives every number from recorded runs — the
local-share percentage and today's cloud spend come from the same records the
run history shows, structurally incapable of disagreeing with it.

## Safety, described exactly

Three independent layers stand between a model and your machine. Each is
described here as what it is, not as what would sound best.

**1. Grants.** Computer and terminal access are off until you turn them on,
and an agent only holds a tool its own definition file declares. Both must
agree.

**2. A destructive-command denylist.** Every shell command is scanned before
it executes. `rm -rf ~`, `mkfs`, `dd of=/dev/…`, fork bombs, `git reset
--hard`, `curl … | sh` and their relatives are refused outright, and the
refusal is recorded. The list is deliberately narrow: `rm -f build/tmp.o`,
`git push --force-with-lease` and `grep -r reboot .` all run normally, because
a guard that blocks ordinary work teaches you to switch it off.

**3. Containment — a deny-list, not a sandbox.** Commands run through macOS
`sandbox-exec` with two things closed: your saved credentials are unreadable
(the app's own key store, `~/.ssh`, `~/.aws`, keychains), and SC Prism's own
approval file is unwritable, so a command cannot approve itself for future
tools.

**What containment does not do**, stated plainly: the command still runs as
your user. It can read and write your ordinary files, reach the network, and
use your installed tools. Verification commands you configure run outside the
containment. If `sandbox-exec` is unavailable, the command runs uncontained
and the record says `contained: false` — the trace never claims a protection
that was not applied.

## Proven, not claimed

Every subsystem is probed against a shipped bundle — not mocked, not
described. The most recent probe pass was run against the 0.1.1 bundle:

```
PASS  denylist refuses rm -rf ~          destructive command blocked pre-exec
PASS  containment hides API keys         unreadable
PASS  containment blocks self-approval   approvals intact
PASS  ordinary commands run              unaffected
PASS  web search returns results         real results
PASS  vault tools work                   readable
PASS  skills catalog loads               4 skills
PASS  vault recall (BM25)                3 docs in 44ms
PASS  skill allowed-tools narrows        narrowed, source untouched
PASS  manifest refuses wildcards         refused
PASS  confidential forces local          pinned to this machine
PASS  scope approval is inert            approving scope grants nothing
PASS  audit catches aliased eval         AST, not regex
PASS  sandbox-exec available             Gate 2 enforceable
```

These passes are the product of finding real failures, not of avoiding them.
A partial list of defects this discipline caught and fixed: an agent whose
definition asked for the web was silently denied it; keyless web search
returned nothing while looking functional; two concurrent runs could fork the
audit chain; a subscription bridge pasted the app's own system prompt into the
user turn, so the model refused it as an injection attempt; a timeout claimed
to kill a command's children and did not; a five-minute cap discarded
everything a run had accomplished instead of reporting it; and the eval gate
returned success whether or not it had blocked.

Each one is now covered by a test that fails without the fix.

Version 0.2.0 has not been put through that probe again, and this page will
not pretend it has. What gates it is the suite every commit must pass before
it lands: 3,423 client tests, 57 in the Rust shell and 1,536 in the engine,
all green on the tagged source — and the release notes list what was checked
by hand in the installed app and what was not.

## What it learns from its own work

This is the part of "at falling cost" that already runs, and it is worth being
exact about what is and is not learned.

Every run that passes emits one training record to `<vault>/training/records.jsonl`
— the task, the trajectory, the tools used, the verdict, and a reward computed
from three measured things: whether your own Tier-1 checks passed, how the
trajectory scored, and how much of the token envelope was left. A run that fails
emits nothing, so the corpus is verified outcomes only.

Those records train a **route policy**: per task-kind weights over where work
should go. The artefact is small and readable — `training/models/v1/weights.json`
holds logits per kind (general, retrieval, reasoning, …) over the actions
`local` and `cloud`. Nothing about it is a black box; you can open it.

**A newly trained policy is never adopted on faith — and it is worth being
exact about what the gate does and does not check.** The candidate is scored
against an *untrained* 50/50 prior, not against whichever policy is currently
adopted, so the comparison answers "is this better than no opinion", not "is
this better than what I have". The goldens are four fixtures shipped with the
app, not tasks from your vault, and they are scored by a routing heuristic
rather than replayed through the loop. What is strict is the regression veto:
one golden going backwards discards the candidate outright, whatever the
average says. The promotion manifest keeps the lift, the baseline and candidate
means, and a per-golden delta with a `regressed` flag on each. Running the
learning step is a dry-run preview; adopting the result is a separate, explicit
action.

**What is learned is which model should do which kind of work — never the
models' weights.** The app says so on the page itself: *route policy · never the
models' weights.*

**Its limits, stated plainly.** An adopted policy applies in Auto-route mode. If
you have pinned a provider, or the Go router is doing the routing, it is not
consulted, and the interface says which of those is true rather than implying
the policy is live. The reward in every training record is *computed, not
applied*: it is the objective a future fine-tuning pass would optimise, and that
pass is not built. Records accumulate against the day it is.

## Agent Skills — the open standard

A skill is a folder with a `SKILL.md` describing a procedure, and SC Prism
reads and writes the open [Agent Skills](https://agentskills.io) format. A
skill written for another tool works here; one written here works elsewhere.

Skills load progressively, in three tiers: the name and description at
startup, the full procedure when a task matches it, and bundled reference
files only when the procedure actually cites them — so a skill can carry a
large reference that costs nothing until it is needed.

A skill may also declare `allowed-tools`. That declaration can only ever
*narrow* what an agent may do on a turn, never widen it: importing a skill can
never grant a capability you did not.

## Memory that reads whole documents

Recall ranks your vault with Okapi BM25 over the full text of every note, then
reranks the shortlist. A decision recorded in a note's third paragraph is
findable; it does not have to be in the title. The probe below is the only figure published for
it: three documents back in 44 ms, entirely on your machine, with no embedding
service and no vector database.

## Where this is going

Stated as a direction, not a promise, and separated from what ships today.

**This release** is the solo application: one person, one machine, a full crew,
on macOS.

**Designed for and not yet built:** cross-platform desktop; a team mode where
colleagues connect to a gateway you host and run under your governance without
ever holding your keys; an editor surface with routing and the vault built in
rather than bolted on; the same governance console widened across a team,
rather than the single-machine one that ships today; and weight-level training
of a local model from recorded verdicts. Route-policy learning from those
verdicts already ships and is described above; what is deferred is the
fine-tuning pass that would change a model rather than the routing.

The architecture already assumes all of it. The engine is Python, the router is
Go, the surface is web technology, agent-to-agent seams are in place, and the
vault is a portable open-format bundle. None of that is load-bearing on macOS.

What separates this from a roadmap is the rule the whole product runs on: a
thing is described as built only when it can be demonstrated. Everything above
is honestly labelled as not yet there.

## Status: solo alpha

One person, one Mac, full crew. Built by a solo founder, and it dogfoods
itself — parts of SC Prism's own tooling were built by SC Prism's crew, on the
record.

## Install

1. Download `SC.Prism.dmg` from the [latest release](https://github.com/sandhusukhdeep2/sc-prism/releases/latest).
2. Open it, drag **SC Prism** to Applications, launch.
3. **First launch only:** v0.2.0 is signed with a Developer ID but not yet
   notarised by Apple, so macOS will say it can't verify the app. Open
   **System Settings → Privacy & Security**, scroll to *Security*, and click
   **Open Anyway** next to SC Prism. (Or run
   `xattr -dr com.apple.quarantine "/Applications/SC Prism.app"`.) A notarised
   build replaces this one as soon as it's ready.
4. The setup wizard walks you through providers (your own Claude/Gemini
   accounts or API keys, and/or a local model server), your vault folder, and
   the grants you choose to give.

Or build it yourself — the whole app, engine and router are in this repository:
see [BUILDING.md](BUILDING.md) for the steps from `git clone` to a running app.

**Website:** [sandhusukhdeep2.github.io/sc-prism](https://sandhusukhdeep2.github.io/sc-prism/)

**Requirements today:** macOS 14+ (Apple Silicon). macOS is where this starts, not where it stops — the engine is Python, the router is Go, and the surface is web technology, so nothing in the architecture is tied to one platform. Cross-platform follows the solo core being proven. Bring your own AI: a Claude or
ChatGPT subscription CLI, API keys, and/or a local OpenAI-compatible model
server (e.g. an MLX host). The app ships with no keys and phones home to no
one.

## Privacy

No telemetry, no analytics, no accounts. Keys are held by the app's gateway
and never rendered. Network traffic goes only where you send it: the AI
providers you connect; web search and page fetches, when you grant web
research; and integrations you switch on (Telegram approvals, GitHub sync, MCP
servers). The record shows every call. What the app can do on your machine, and
the limits of its safeguards, are set out in [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md)
first. The bar is the project's own: a fix comes with a test that fails without
it, nothing on screen is invented, and no gate gets weaker. Security problems go
through [SECURITY.md](SECURITY.md), never a public issue.

If this is the kind of tool you think should exist, a star helps other people
find it.

## Licence

SC Prism is licensed under the [Apache License 2.0](LICENSE). Copyright 2026
Sukhdeep Singh Sandhu. Third-party components and their licences are listed in
[NOTICE](NOTICE).

---

*SC Prism is independent software. It is not affiliated with Anthropic,
Google, OpenAI, or the Obsidian project.*
