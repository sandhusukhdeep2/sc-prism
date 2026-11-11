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
| Computer control | five tools exist (screenshot, open app, click, type, key) behind a strict opt-in | **the screenshot comes back as a file path and no model is shown the image**, so a seat acts blind; needs a see → act loop on a vision route, and the OS permissions are the owner's to grant |
| Browser control | **absent** — the web tools fetch and search; nothing drives a page (navigate, click, fill) | a governed browser tool source |
| Plugins (MCP servers) | can be registered and tested in Settings | **never reach a run**: the app's bridge passes no `--mcp-server`, and the capability ceiling hard-codes zero servers |

Order of work: (1) plugins reach real runs — wiring only, the engine side
exists; (2) computer use that can see — screenshot as an image block on a
vision route, one action per turn, every action through the approval gate;
(3) a browser tool source; (4) a per-agent runner for the composer's `agent`
target. Each needs a real run in the installed app as its proof.
