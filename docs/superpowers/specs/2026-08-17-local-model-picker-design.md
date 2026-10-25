# Choosing a local model, on evidence (2026-08-17)

Sukhdeep: "show local model capabilities in settings… which one is fast, which
one is more capable in thinking, suggest me when I'm selecting… how many
tokens, loading time, processing time."

Today the picker is a bare list of ids. He has three local models with wildly
different behaviour and no way to tell them apart — he ran the SLOWEST one for
days (115s p50) while a faster, stronger one sat unused (9.8s p50), and a
fourth failure mode (a model that cannot load at all) presented as "the
provider is unreachable".

## What each row shows — MEASURED ONLY

For every model the local server lists:
- **Speed** — tokens/sec and p50 latency, computed from that model's own
  `model_call` spans in the vault. Sleep-artifact outliers (>15 min, the Mac
  slept mid-call) are DROPPED, never averaged in — 4f95483 proved they exist.
- **Load** — first-call cost: the server's own size + load-rate estimate
  (`/v1/models/status` gives `load_seconds_per_gb_estimate`), stated as an
  estimate because it is one.
- **Memory + FIT** — its footprint against the server's ceiling, and plainly
  whether it fits RIGHT NOW given what is already resident. A model that
  cannot load must say so before it is chosen, not after (a 507 today reads as
  "unreachable" — see the companion fix).
- **Quality** — the average Tier-2 judge score of real runs on that model, with
  the run count. This is the only honest "more capable at thinking" signal the
  app owns: it is measured on his own work, not a vendor claim.
- **Never measured** → "no runs recorded yet" and NO speed/quality number. An
  unmeasured model is not ranked.

## The suggestion

One line per row, derived from that row's own numbers, naming the reason:
"fastest here (28 tok/s over 12 runs)", "highest judged quality (0.81 over 9
runs)", "won't load right now — 21 GB resident, 42 GB needed". A default
recommendation is offered ONLY when the evidence supports it, and says on what
basis. With no measurements the panel says so and recommends nothing.

## Honesty rules (binding)

No vendor claims, no parameter-count heuristics, no invented rankings. Every
number is traceable to a span, a verdict, or the server's own report, and the
row says which. "Fast" and "capable" mean the measured things above, stated in
those terms. A model the user has never run is never described as better or
worse than one he has.

## Tests

Rows render measured values from seeded spans/verdicts; an unrun model shows
the honest empty state and is unranked; sleep outliers are excluded; a model
that exceeds the live ceiling is marked won't-load BEFORE selection; the
recommendation names its basis and is absent when evidence is absent.
