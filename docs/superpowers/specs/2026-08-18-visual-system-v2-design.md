# Visual system v2, and Work rebuilt in it (2026-08-18)

Sukhdeep supplied a reference (a SugarCRM "Customer Journeys" screen) and
approved a mockup of Work rebuilt in its language. This spec fixes the system,
then applies it to Work. Every later page inherits the system.

## The palette (from his reference)

    ink        #10141A   near-black — text, and the ACTIVE/primary accent
    paper      #E9E9EE   pale ground, gradient toward
    paper2     #DFE3EF   a cool lavender
    card       #FFFFFF   surfaces
    blue       #83A2DB   semantic: working / passed
    coral      #CE6969   semantic: needs attention / failed
    local      #6E9A83   private-model green (ours — the reference had none)

Black is the accent: the active nav pill, the primary button, and the ONE most
important card on a screen (an approval waiting on the user). Blue and coral
are states, never decoration.

Dark theme is first-class: ink/paper invert, blue and coral keep their meaning
and their contrast (>=4.5:1 on both grounds). The existing theme-guard test
stands and must be extended to the new tokens.

## The form language

Generous radii (22px cards, 15px inner, 99px pills) · white cards on the pale
ground with soft low shadows · a circular icon rail on the left · pill top-nav
with a solid black active pill · column stacks with their LABEL BENEATH ·
overlapping avatar cluster with count badges · status pills · arc charts.

## Agents are not people

The reference uses stock human photos. Our coworkers are AI: each is a MONOGRAM
tinted by ITS OWN MODEL (Claude coral-red, local green, Gemini violet, grey =
idle or not connected), never a face. A photo would make the prettiest element
on the page the only dishonest one.

## Type

Outfit Variable (body) + JetBrains Mono Variable (models, paths, measurements,
durations) — both now bundled (01ad531).

## Work, rebuilt

One column of conversation. A run renders as a PIPELINE of column stacks —
Planning · Research · Drafting · Your call — each holding the agents at that
stage: monogram, name, `provider · model` in mono, what it is doing now, and a
thin progress line. Above the pipeline: the crew cluster + the 🔒 badge.
Below: recent runs (real rows) and this week's arcs. The composer is one line
with the attachment buttons, a sentence naming who Sukh will give it to, and a
black send button.

## Honesty rules (BINDING — each needs a test)

1. A monogram pulses ONLY while that run is genuinely live (`activeRuns`;
   a paused run does not glow).
2. Name + model come from REAL span attrs; missing attr -> honest generic.
3. Stages/steps map 1:1 to real spans. No crew, no pipeline.
4. The 🔒 badge appears only when a vault read really happened on that run.
5. Counts ("4 working") are real states, never a plan.
6. 2+ concurrent runs must not cross-attribute (`currentRunSpans` rule stands).
7. Every number in "recent runs" and the arcs is measured; an empty week says
   so rather than drawing an empty arc.

## Scope

This build: the token system + Work. Other pages keep working (they inherit the
tokens and may look transitional) and are converted one at a time afterwards.
