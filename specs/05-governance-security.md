# SC Prism — Governance, Security & Compliance

This is SC Prism's product, not a side feature. The whole pitch is *provably governed*. The Evidence & Control Layer is the enterprise-trust spine.

## 1. Access control (RBAC + ABAC)

- **Every agent has a distinct identity**, separate from any human user, so it can be uniquely tracked and constrained.
- **RBAC:** agents are assigned roles (`implementer`, `reviewer`, `data-reader`, …); each role carries predefined permissions.
- **ABAC on top:** access decisions also use attributes — environment (prod vs dev), declared task purpose, target scope. This is what makes permissions context-aware rather than static.
- **Least privilege, time-bound:** bind the agent's declared purpose + current context + verified identity to a *minimal, temporary* set of allowed actions on specific tools and data. Narrow the grant to the moment; expire it after.

Implement at the Orchestrator (not the Workbench) so it holds regardless of surface. A tiny attribute store (JSON is fine to start) maps `agent_id : task_type → allowed operations`.

## 2. Confirmation gates

Irreversible or high-stakes actions require explicit human approval before execution: sending a message, modifying a production record, writing new governance rules, deleting audit history, changing agent permissions. The agent prepares everything and summarises the intended change ("Update rule X from A to B"); a human makes the final call. Enforced by hooks (Layer 4), not by instructions the model can ignore.

## 3. The Evidence & Control Layer

The audit spine. For every governed action it records, immutably: who (agent identity + requester role), what (the action + diff), why (task intent), the **Verdict** (Tier-1 + Tier-2 results), tokens spent, model route, hooks fired, and timestamp. This is the same Verdict object the loop emits — governance is a *read* of execution truth, not a parallel system that can drift from it.

Properties:
- **Append-only / immutable.** Audit records are never edited, only added.
- **Reconstructable.** Any decision can be replayed end-to-end from evidence.
- **Exportable.** Compliance artifacts generate from the evidence store on demand.

## 4. Security hardening

- **Schema enforcement** on agent inputs *and* outputs — validate structure before it reaches the model or triggers a downstream action.
- **Prompt-injection defence.** Treat retrieved content and tool output as untrusted; indirect prompt injection via the context window is a primary new failure mode for autonomous agents.
- **Secret handling.** Credentials live in one place behind the gateway; agents never touch backend credentials directly. Deny-list + secret-detection regex as a sub-millisecond PreToolUse hook.
- **Blast-radius limits.** Scope every agent to a directory/project/domain; rate-limit to prevent runaway loops; the most effective guardrail is limiting what the agent can do at all.

## 5. Compliance posture (locked)

- **Now:** compliance-*ready* architecture — RBAC, encryption, immutable audit trails, evidence export built in from the ground up.
- **Later:** **SOC 2 Type II after 6+ months** of real operating history (Type II audits an operating period, so it cannot be rushed).
- **Awareness, not yet certification:** design with EU AI Act and NIST AI RMF mappings in mind so the evidence layer can later demonstrate compliance against them. An orchestration-led governance layer is what makes scaling AI safely tractable — without governance, orchestration just multiplies unmanaged risk.

## 6. Execution isolation & threat model

An agent that runs code, mutates the vault, runs tests, and commits has large blast radius. The 2026 consensus is explicit: **Docker/runc alone is not enough** for AI-generated or AI-directed code. Run agent execution inside a defense-in-depth sandbox.

**Isolation tiers (pick by tenancy):**
- **bwrap / namespaces** — light, shares the host kernel. Acceptable for a personal / single-tenant on-prem agent; *not* for strangers' agents on shared hardware.
- **gVisor** — user-space kernel intercepts syscalls; attack surface collapses, ~10–30% I/O overhead. The multi-tenant / CI sweet spot.
- **Firecracker microVM** (or a provider like E2B) — each sandbox gets its own kernel, ~125ms boot, hardware-grade isolation. For multi-tenant SaaS.

**Sandbox grants (least privilege):** read-only vault, write-only output dir, **no network egress by default** (whitelist only), command deny-list (also enforced at the PreToolUse hook — defense in depth).

**Threat model:** assume an agent can be subverted by indirect prompt injection via retrieved content/tool output, or by an escalating hallucination. The design goal is that a subverted agent can do as little as possible — write to a temp dir, never the vault or source tree directly. The most effective guardrail is limiting what the agent can do at all. Sandbox-escape attempts are logged as security incidents.

**Posture:** gVisor for solo / on-prem now; Firecracker or E2B when SC Prism runs multi-tenant.

## 7. Acceptance criteria

- No agent can act outside its role+attribute grant; attempts are logged and denied.
- No irreversible action executes without a recorded human approval.
- The audit store is append-only and any governed action is fully reconstructable from it.
- A compliance export can be generated for an arbitrary date range without bespoke work.
- Secrets never appear in agent context or spans.
