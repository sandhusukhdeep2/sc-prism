# The manager proposes new agents (2026-08-11)

Sukhdeep: "my manager agent can build new agents. There is some agents that
already exist, but I supposed to give a task in a work page…" — he wants Sukh
to grow the team, not just use it.

## The rule (from his own governance)

Sukh PROPOSES; the human CREATES. A proposal parks in "Needs you" on the Work
desk and becomes a real agent only on an explicit tap. The manager reads and
suggests, never self-authorizes new capability (ADR-007 lineage: the Manager
reads, never controls).

## Flow

1. **Where a proposal comes from.** Two honest sources, no others:
   - a heartbeat wake or manager job whose work surfaces a recurring gap
     ("three runs needed a compliance check; no agent covers it"), or
   - the user asking directly on Work ("we need someone for X").
   A proposal must cite the REAL evidence that motivated it (span/run ids or
   the user's own request) — never an invented need.
2. **The proposal record** (vault-side, so it survives and is auditable):
   role name, one-line purpose, suggested model + why, the skills/roles it
   would carry, and the evidence. Written to the vault like other artifacts.
3. **Review on the desk.** A "Needs you" item: what the agent would do, which
   model, what it may touch — plus **Create**, **Edit first**, **Dismiss**.
   Nothing is created until Create is tapped.
4. **Creation** writes a real entry to the agent library (src/lib/agents.ts)
   with the reviewed values, and the new agent appears on Agents like any
   other — with genuinely empty stats until it has run (never seeded).

## Honesty rules (binding)

A proposal shows real evidence or it is not made. A proposed agent is visibly
a PROPOSAL until created — it must never appear in the library, in counts, or
in stats beforehand. A created agent starts with no history and says so.
Dismissing is remembered so the same proposal does not nag.

## Tests

A proposal without evidence is refused; the desk item renders the real
evidence; Create writes exactly the reviewed values and the agent appears with
empty stats; nothing exists in the library before Create; dismiss is sticky.
