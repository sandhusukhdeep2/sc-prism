# SC Prism — Harness Specification (Six Layers)

> **Agent = Model + Harness.** A raw model is not an agent. It becomes one when scaffolding gives it state, tools, feedback loops, and enforceable constraints — and *all of that is SC Prism's surface area, not the model provider's.* When an agent misbehaves, the reflex to blame the model is usually wrong: most agent failures are configuration failures. On Terminal Bench 2.0, teams moved an agent from outside the top 30 into the top 5 by changing only the harness, no model swap.

This file is the layer-by-layer spec for SC Prism's harness. Each layer has a purpose, a design, and acceptance criteria.

---

## Layer 1 — Memory

**Design:** three tiers (already in place): **L1** profile, **L2** native agent memory, **L3** git-synced markdown vault (the single source of truth).

**What's missing and must be added:**
- **Validation gate on writes.** Agents can hallucinate; persisting hallucinated governance content creates a feedback loop. Before any vault write commits, dry-run it against the rule files / schema. Contradiction → reject before it persists. This runs locally before L3 syncs.
- **Session isolation.** Working memory is strictly per-task. Two agents governing different policies concurrently must not cross-contaminate context.
- **Token-budget management.** Never inject the whole vault. Allocate a fixed token budget to memory and select the highest-value items that fit.

**Acceptance:** a write that contradicts a rule file is rejected with a reason; two concurrent tasks cannot read each other's working memory; memory injection never exceeds its configured token budget.

---

## Layer 2 — Tools

**Design:** MCP for **external** integrations (Jira, Confluence, GitHub) via the mcpvault server; **SDK function calling** for the **internal hot path** (verify code, check rule compliance, audit writes).

**Why the split:** heavy MCP setups can burn 55–100k tokens loading tool definitions before the agent does anything — 27–50% of a 200k window gone on metadata. Internal tools you control on both ends get type safety, no network round-trip, sub-millisecond latency, and tighter control as direct SDK calls. MCP earns its overhead only where a third party will consume the server.

**Acceptance:** internal governance operations make zero MCP round-trips; tool-definition tokens loaded at session start stay under a set ceiling (measurable from spans).

---

## Layer 3 — Permissions

**Design:** RBAC + ABAC at the Orchestrator. Every agent has a distinct identity (separate from human users). `agent.role` + task context (env prod/dev, scope, declared purpose) bind to a minimal, temporary set of allowed tools/paths/actions — least privilege, to cap blast radius.

- **Confirmation gates** for irreversible actions: writing new governance rules, deleting audit trails, modifying agent permissions. Hard stops, not advice in a prompt. Pattern: agent plans → hooks check permission → human signs off on high-risk → hooks log outcome.

**Acceptance:** an agent cannot touch a path outside its scope; an irreversible action cannot execute without an explicit approval record; permission decisions are auditable and revocable.

---

## Layer 4 — Hooks (the enforcement layer)

**Design:** hooks are deterministic code that fires at fixed lifecycle points and physically intercepts tool calls — the model does not get to override them. Configure in `.claude/settings.json` with matcher regex; **version them like code, review them in PRs.** SC Prism needs all five types:

| Type | When | Use |
|---|---|---|
| **PreToolUse** (command) | before a tool runs | block destructive patterns (`rm -rf`), reject restricted APIs, validate schema. Exit code 2 = block. Sub-millisecond. |
| **PostToolUse** (agent) | after a write | a small read-only agent verifies the change matched intent / rule. ~60s. |
| **Stop** | when the agent claims done | run the full ratchet (lint/test/compliance) at the only moment that matters. |
| **HTTP** | any point, remote | one server enforces team-wide policy across every agent in the Orchestrator. |
| **prompt** | fuzzy checks | "does this look destructive?" — fast yes/no LLM call, no code. |

**Anti-patterns to avoid:** firing PostToolUse constantly mid-task (noisy, slow, fires while code is legitimately half-finished); deferring everything to CI (catches it only after the agent declared victory). Also: a Stop hook that forces continuation sets a flag — check it or you get an infinite "fix → stop → blocked → fix" loop.

**Acceptance:** a destructive command is blocked before execution every time regardless of prompt phrasing; the Stop ratchet runs exactly once per completed task; hook config changes go through review.

---

## Layer 5 — Observability

**Design:** OpenTelemetry spans for every model call, tool execution, agent handoff, retrieval, hook trigger, and verifier verdict. (Full detail in `07-observability.md`.) The point at the harness level: if you can't observe it, you can't debug or scale it — and the Console reads these spans rather than hooking the loop.

**Acceptance:** every loop step produces a typed span with token count and outcome; a failed run can be reconstructed end-to-end from spans alone.

---

## Layer 6 — Context Routing & Compression (the layer nobody admits matters)

The overnight loop burns tokens catastrophically without this.

- **Progressive disclosure.** Agent sees rule/skill *names* at startup, loads full instructions only when a task matches, pulls heavy reference material only on demand. One agent can carry dozens of skills and pay only for the one in use.
- **Compression triggers.** Trim old tool outputs, summarise long history, deduplicate repeated context — at three points: after N turns, at ~80% of window, at explicit checkpoint.
- **Query reformulation before retrieval.** Don't pass raw user intent to grep+BM25; let a small fast model rewrite the query first, bound to the knowledge structure. Cuts noise.
- **Model routing as a financial lever.** Hard reasoning → big model; routine work (test generation, code review, CI checks) → small cheap model. Bifrost is where this rule lives.
- **Prompt caching.** Treat the prompt as a *layered document*: stable foundation at the bottom (system prompt, rule files, vault context, tool definitions), live state on top. Cache the stable prefix so repeated calls pay only for the delta — cached input runs ~90% cheaper on Anthropic, ~50% on OpenAI, with a meaningful time-to-first-token win. This is the single highest-leverage cost lever for the overnight loop, where re-sent context is otherwise the majority of the bill. **Hard constraint:** compression and context-routing must not reorder or mutate cached content mid-task — breaking the cache boundary forces a full recompute and erases the saving. Bifrost owns the cache-boundary decision per task type (Anthropic = explicit boundary control; OpenAI = automatic prefix caching, so stable content must come first).

**Acceptance:** full skill instructions are absent from context until the matching task runs; context is compressed at the defined triggers; routine sub-tasks demonstrably route to the cheap model; the cached prefix is byte-stable across a task's calls and cache hit-rate is tracked per session.

---

## Note on instruction files

Generated, bloated instruction files measurably *reduce* agent performance and inflate cost (agents follow them faithfully, broadening exploration). Keep rule/`AGENTS.md`-style files lean: only what differs from defaults, the counter-intuitive patterns, the "never touch" list. WHAT/WHY/HOW, instruction budgets, progressive disclosure. Curate by hand; review like code.
