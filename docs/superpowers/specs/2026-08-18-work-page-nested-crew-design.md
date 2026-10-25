# Work, redesigned: the crew lives in the thread (2026-08-18)

Sukhdeep picked variation A after seeing three: "I need our functionality, but
design like a Claude co-agent — easy to understand, easy to control… if he's
using agents, how many are working, what those agents are doing, what they are
responding, on a universal chat where our manager is controlling. I need each
and everything visible."

## The shape

ONE column. The conversation is the app.

A manager turn owns its crew. Sukh replies, and the agents he put on the work
appear as INDENTED STEPS beneath his message, streaming as they run:

    ● Sukh · claude-cli · opus
      I've put three of the crew on this.
      │ ● researcher · local · Qwen3.6-35B
      │   🔎 searched "…" — 8 results · 📓 read 4 vault notes
      │ ● writer · claude-cli · opus
      │   drafting section 2 of 4
      │ ○ reviewer · waiting — nothing to review yet
      [3 working · 1 waiting] [🔒 vault reads stayed local] [2m 14s]

## What moves

- **Right rail goes.** Live Agent, Up next and Your setup leave the main
  surface. Live Agent is REPLACED by the nested steps (same data, better
  place). Up next and Your setup move behind the More menu / Automations and
  Settings, which already render them honestly.
- **The engine console** stops being a black box below the chat and becomes
  the expandable detail of a step (`▸` on any step opens its real spans).
- **The header's six KPI chips** collapse to one honest status line, with the
  numbers still reachable (Stats already owns them).
- **Composer simplifies**: Sukh's routing decision is the default and is shown
  as a sentence; the local/cloud override and the target selector move behind
  one small control rather than seven always-visible pills.
- **Projects rail** becomes a slim switcher.

## Honesty rules (BINDING — these are the whole point)

Every one of these must be asserted by a test:
1. A step's orb animates ONLY while that run is genuinely live (reuse
   `activeRuns`/`liveRuns` — the same source b6ac702/16182f2 established; a
   paused run does not glow).
2. An agent name and its model come from REAL span attrs. No attr, no name —
   render the honest generic instead of guessing.
3. Steps map 1:1 to real spans. Nothing is synthesised to make a turn look
   busy, and a turn with no crew shows no crew.
4. The 🔒 line appears only when a vault read really happened on that run.
5. "N working · M waiting" counts real states, never a plan.
6. With 2+ concurrent runs the thread must not attribute one run's steps to
   another (the `currentRunSpans` rule from 16182f2 stands).

## Non-goals

Changing the engine, routing, gates or any measurement. This is presentation
only: the same facts, in a better place.

## Tests

Orb glow bound to real live state; names/models only from attrs; no steps when
no spans; the 🔒 line only on a real vault read; counts match real states;
multi-run non-attribution; the removed panels' data still reachable where they
moved; both dark themes legible (the theme guard stands).
