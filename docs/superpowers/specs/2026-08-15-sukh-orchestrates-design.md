# Sukh runs the work (2026-08-15)

Sukhdeep, verbatim intent: "I want that AI coworker have one manager — Sukh —
that handles all the co-founder tasks for me. If we are working on any project
he can build a sub agent, give them capabilities, all those stuff. My manager
will be the main one interacting with the other AI, deciding which is going to
do what… I need that coworker to do real work for me, not just showing
something."

Today the pieces exist but nobody is in charge: the user picks the target, the
roster is assembled from settings, and Sukh only wakes on a cadence.

## What changes

**One front door.** Give a job to Sukh; he decides how it gets done. He may:
 (a) do it himself, (b) route it to the AI best suited (Claude for reasoning,
 local for private/bulk — measured: Claude opus ~10s, gemma-4-26b ~15s, Gemini
 currently unavailable), or (c) assemble a team, saying who does what and why.
His choice and its REASON are shown — never a silent pick.

**He staffs a project.** On a new project he proposes the roles that project
actually needs, each with: role name, which AI, and the CAPABILITIES it gets
(vault read, web, tools, project writes). One approval creates them all; the
user can edit any row first. This extends the existing propose→create flow
(577506c) from one agent to a project roster, and reuses its evidence rules.

**Capabilities are real, per agent.** A sub-agent's grants are a SUBSET of the
user's own grants — a manager can never grant what the user did not (no
privilege escalation), and the engine must enforce it, not just display it.
An agent without web cannot fetch; without vault cannot read notes.

**Delegation is visible.** Every delegated step shows: which agent, which AI,
what it was asked to do, and the outcome — on the Work page live, and in the
verdict afterwards. "Which AI is doing what" is the user's stated ask.

## Honesty rules (binding)

The reason for a routing choice is the real one. A capability shown is one the
engine actually enforces. A proposed roster cites the project's real needs, not
invented ones. Nothing is delegated to an unusable provider (f2766c6), and if
only one AI is available, say so rather than performing a team.

## Non-goals (this build)

Sub-agents spawning sub-agents; cross-project staffing; anything that spends
without the single approval.

## Tests

Routing choice + reason recorded and shown; a roster proposal lists capabilities
and creates exactly what was approved (edited values win); a capability the user
lacks can never be granted; an agent without a capability is refused it BY THE
ENGINE; delegation renders per-step with agent+AI+outcome; single-AI case is
stated honestly.
