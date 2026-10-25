# Mission Control + the Companion's eyes (2026-08-05)

Two findings from Sukhdeep's live week drive this build.

**Finding A — Sukh is blind.** The engine ships NO vault tool (grep: only
web_fetch/web_search in webtools.py + user MCP servers). His charter says
"look at the real project statuses and the knowledge vault"; he has no eyes
for either. His own beat log says it: "I can't inspect the vault through my
available tools (web_fetch only)". He rests honestly instead of working.

**Finding B — work is invisible.** A team run launched from Agents shows only
an amber "Team running…" line there; nothing on Work. Sukhdeep: "I want to
check what's happening with that task… show me on a work page… which agent is
doing what… in plain English."

## Part 1 — Eyes (engine)

New governed tool source `vault_tools.py`, mirroring webtools.py's shape
(same registration, approval-gate and span discipline):
- `vault_list(subdir?)` — names + sizes, never contents.
- `vault_read(path)` — one note, path-confined to the vault (traversal-safe,
  hidden paths refused, honest error otherwise). Size-capped at 8k chars —
  amended from ~40 KB, which is ~10-13k tokens and blew the heartbeat's own
  20k budget in a single call; the tool's cap has to fit its smallest consumer.
- `vault_search(query)` — filename + content matches, capped result set.
- `project_status()` — reads the app's projects store (read-only) so he can
  see real project state.
Rules: available to any run (same gates: approval posture, sensitivity); every
call is a real tool_exec span; no writes in v1 (write stays the engine's own
verified path).

**Amended 2026-08-05 (adversarial audit).** "A run that reads the vault and is
routed cloud must honor the existing sensitivity floor exactly as today" was
wrong: that floor is an 18-word keyword denylist, and an audit walked a
diagnosis, salaries, settlement terms and a home address straight past it onto a
cloud POST on the DEFAULT route. The rule is now categorical, not lexical —
**reading the vault forces the rest of the run LOCAL** (`loop.VaultEgressFloor`,
shared by the solo and team tool loops), and where no local model exists the
content is withheld from the cloud turn with an honest observation rather than
sent. The keyword guard stays as a backstop for web/MCP results only. The four
vault tools are also pre-granted in `mcp-approvals.json`: read-only + zero-egress
means holding them only blinded the companion.

## Part 2 — Mission Control (app, Work page)

- **Live task cards**: every in-flight run (chat, team, manager job,
  heartbeat) renders a card on Work: intent, kind, elapsed, the agents/models
  actually on it, and a status. A card glows ONLY while its run is genuinely
  live (same honesty law as the orb). Finished → collapses to an outcome row
  with a click-through to the trace.
- **Plain-English narration**: a translator over the real span tail — "Sukh
  asked the researcher (local Qwen) to gather sources · critic reviewing ·
  verifying" — one line per real span, never invented. Renders in the chat
  column so the user follows without reading a trace.
- **Live terminal tail**: the black Engine Console box on Work follows the
  CURRENT run (it shows only the last finished run today).
- **Give a task from Work**: composer gains a target — Sukh (default), a
  team (roles preset), or an agent — so Agents is no longer the only launcher.
  Team launches from Work respect the busy protocol (Agents' TeamLauncher
  currently bypasses it — fix as part of this).

**Amended 2026-08-06 (adversarial audit of the shipped Part 2).** Six ways the
observe half claimed activity it could not prove, now closed:
- **Glow ≠ registered.** A build parked on the "one more refine?" gate polls a
  ref every 140ms with its subprocess already gone; the card glowed, the console
  read "live" and the orb pulsed for as long as the human took. A live run now
  carries `paused`, the park sets it, and every "something is happening" signal
  derives from `activeRuns` (registered minus parked). A parked card stays, and
  says "waiting on you".
- **Narration must be entailed by the span.** A STUBBED model_call (`is_real:
  false` — no key / unreachable host / unsigned-in CLI) narrated as a reply on a
  named model while the chat said "nothing was sent"; an approval the user had
  already answered kept reading "waiting for your OK" (the broker emits two
  held spans — the pause, then the outcome carrying `resolved`); route / gate /
  training / vault_write read as in-progress even though telemetry appends a
  span only when it CLOSES; and an unknown vault tool was claimed as a *read*.
- **Attribution needs one run.** `currentRunSpans` keyed off the OLDEST live
  run, so a FINISHED run's spans sat under the `live` header while a different
  run was going. It now mirrors `runSpans` exactly: 2+ live → nothing shown, and
  both the console and the chat strip say why.
- **A timeout must kill the child.** The Agents team launcher and the project
  interview raced a bare timeout with no run id, leaving a draining engine that
  kept appending to the ONE spans.jsonl — attributed to whatever registered
  next. Both mint a run id and cancel for real; the team launcher also claims
  the shared engine slot (`claimEngine`) instead of overlapping the drivers.
- **Rows report results, not permissions.** An interview turn's outcome came
  from "was it allowed to run", so a timeout reported a green "passed"; it now
  comes from whether a real completion was actually seen.
- **Every real run registers.** The loop driver's per-step run, standing
  task/test schedules and the compaction summariser registered nothing, so Work
  said "last run" over a live one. Each registers under an honest kind
  (`loop` / `task` / `test` / `compaction`) — a scheduled check is not a chat.

## Part 3 — Always-on manager

Heartbeat defaults ON once setup completes (no toggle nagging), with the
existing consent copy shown at the moment it flips; Wake-now button on the
orb + card for an immediate real beat. Park (rest) stays the honest idle
state. Sprint mode NOT in this build (needs its own cost design).

## Honesty rules (binding)

Glow == a live run. Narration lines map 1:1 to real spans. Costs stay real
sums. A vault tool that fails says so. Nothing fabricated anywhere.

## Tests

Vault tools: traversal refusal, size cap, honest missing-file error, span
emitted, list-never-leaks-contents. Narration: span→sentence mapping table,
unknown span kind → generic honest line (never invented detail). Cards: no
glow when not live; finished card shows real outcome. Composer targets route
to the right runner. Heartbeat default-on transition writes consent copy once.
