# Pages tell the truth (2026-08-09)

Sukhdeep: "I am not able to see anything on a automation page… stat page…
Memory page is also broken. Console page is also not working. I need to see
the real time data and whatever it's supposed to represent real data."

A read-only diagnosis against his live vault (691 spans / 51 runs / 51
verdicts / 2 managers / 3 jobs) found every complaint justified, plus a
product-level bug behind two of them.

## Finding 0 — the verification spine is broken (fix FIRST, highest leverage)

Tier-1 runs the user's verify command (`npm test`) in a subprocess whose PATH
lacks npm: `/bin/sh: npm: command not found` (15x), `npm error ENOENT` (21x).
**0 of 51 runs have ever passed Tier-1.** Same root cause class as the CLI
discovery bug: a GUI-launched app inherits a minimal PATH. Consequences: every
run fails its gate, Stats' hero stat and Memory's saves card are pinned at 0.
FIX: give the engine subprocess a real PATH (mirror `_CLI_SEARCH_DIRS` /
`check_cli` discipline — prepend the common install dirs incl. nvm's
`~/.nvm/versions/node/*/bin`), and when a verify command genuinely cannot be
found, FAIL HONESTLY with "verify command not found: npm" rather than a raw
shell error.

## Finding 1 — Automations is a demo simulator (worst offender)

`/loop` renders a build-loop simulator: `buildPlan` generates 5-12 steps from
a seeded RNG over a canned `STEP_POOL` ("scaffold repo", "router module") with
NO relation to what the user typed = fabricated output, forbidden. Its state
is deliberately never persisted, so the page is blank on every launch BY
CONSTRUCTION. The user's REAL recurring work (3 manager jobs with
everyMinutes / lastRun / history, plus schedules) renders on /agents instead.
FIX: `/loop` shows real recurring work — manager jobs + schedules + anything
live from `state.liveRuns` (title, cadence, last run, next due, ok/fail).
DELETE `buildPlan`/`STEP_POOL` and the mock prefilled input; a demo, if kept
at all, must be behind an explicit "demo" label.

## Finding 2 — Memory states the opposite of the truth

Memory never calls `nativeDashboard`. It renders "local now handles 0% of
routine work" from session verdict routing; the engine says **75%**
(209,340/279,173 tokens local). The budget gauge compares cumulative session
tokens to a per-injection cap so it reads "over cap!" permanently. Four of
five ramp bars are hardcoded (w1-w4 = 14/22/32/42).
FIX: source local share from the dashboard's per-model split, the gauge from
the real `memory` span's budget/injected_tokens attrs, Tier-1 saves from
engine data; delete the hardcoded ramp or replace with the real series.

## Finding 3 — Console misreports

(a) `provider === 'claude'` / `'gemini'` never match — the engine emits
`claude-cli` / `gemini-cli`, so both bars are 0 (claude-cli really burned
69,833 tok = 25%) and render as a 6% floor stub. (b) Hook latency averages the
`dispatch` hook, which wraps the whole model call -> "170039.5ms avg".
(c) 36 hook errors exist in the data but the badge reads "healthy" (it only
sums fires/blocks). (d) The "execution graph" is a static hardcoded SVG.
FIX: bucket by the provider keys the dashboard actually returns (prefix match
at minimum); exclude/label dispatch in latency; surface `errors` in the badge;
replace or honestly label the static graph.

## Finding 4 — Stats' hero is structurally zero

Hero `tier1Saves` comes from session verdicts (0 pass, see Finding 0) and
`caught` reads 13 session verdicts not the 51 real ones; a $0 local run makes
the cost trend claim "down 100% - cost floor falling".
FIX: derive the hero + caught from engine/verdict data; gate the trend claim
so a $0 terminal sample cannot produce a victory line.

## Finding 5 — nothing refreshes

All four snapshot on mount. `useSpanTail` (engineConsole.ts:74, 1200ms) and
`state.liveRuns` already exist and are already shared.
FIX: refetch the dashboard (60-90ms) while `activeRuns(state.liveRuns)` is
non-empty; drive Automations' live rows off liveRuns + job lastRun.

## Honesty rules (binding)

No page may render a number it did not measure. An empty page says WHY it is
empty and where the data would come from. No fabricated plans, ramps, graphs
or victory claims. Where session-scoped and engine-scoped numbers differ, the
page says which it is showing.
