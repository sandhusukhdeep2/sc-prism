# SC Prism — Build Roadmap (T0–T6)

> **Not phased delivery over months.** The intent is a loop agent running overnight on local models that builds the enterprise-complete product in one dependency-ordered run. So this is **build order**, not a release calendar — T_n depends on T_(n−1) being real before it can be built or verified.

> **The unlock:** build a single-agent loop with deterministic verification + write-back **first** (lands in T2). That is worth more than a flashy multi-agent fan-out with no verifier. Breadth comes last.

---

## T0 — Substrate & spec

Everything downstream reads this, so it's first.

- Markdown vault structure; the vault as single source of truth.
- This spec set committed into the repo (specs are buildable artifacts).
- `AGENTS.md`-style rule files — lean, only what differs from defaults, the "never touch" list.
- ADR log seeded (file `09`).
- **Depends on:** nothing. **Done when:** an agent can read the vault + rules + acceptance criteria for any task.

## T1 — Orchestrator skeleton + Bifrost + schemas

The spine that everything plugs into.

- Bifrost wired as router/gateway (model selection, MCP-native).
- MCP server the Workbench will talk to.
- **Task Contract** and **Verdict** schemas as real starter code.
- Empty loop modules (`contract/planner/dispatcher/verifier/writeback`).
- **Depends on:** T0. **Done when:** a Task Contract round-trips and a stub Verdict is emitted and persisted.

## T2 — The loop engine (single-agent + two-tier verifier)  ← the core

- Planner (decompose, tag read/write), dispatcher (serial writes), execute via Bifrost.
- **Tier-1 deterministic verifier** (tests/lint/build, zero token) → **Tier-2 DeepEval**.
- Write-back: emit Verdict, mutate vault, checkpoint.
- Long-running mechanics: fresh context per task, atomic checkpoint, max-turns, timeout, idempotency.
- **Depends on:** T1. **Done when:** a failing-test task never reaches Tier 2; a killed run resumes with no duplicate writes; every task emits one persisted Verdict.

## T3 — Harness layers (memory, tools, permissions, hooks, context routing)

The reliability layer wrapped around the working loop.

- L1 memory + **write validation gate** + session isolation + token budget.
- L2 tools: mcpvault (MCP, external) + SDK calls (internal hot path).
- L3 permissions: RBAC/ABAC store + confirmation gates.
- L4 hooks: PreToolUse / PostToolUse / Stop / HTTP / prompt, in `.claude/settings.json`, versioned.
- L6 context routing: progressive disclosure, compression triggers, query reformulation, model routing rules in Bifrost.
- **Depends on:** T2. **Done when:** each layer's acceptance criteria in `03` pass.

## T4 — Knowledge layer (GraphRAG + retrieval cascade + caching)

- Retrieval cascade: grep+BM25 → dense rerank → graph traversal (multi-hop only).
- GraphRAG construction + incremental re-index.
- Agentic RAG + query reformulation.
- Semantic cache + prompt cache (Bifrost).
- **Depends on:** T0 (vault) + T3 (routing/memory). **Done when:** single-doc queries never hit the graph; vault is fully rebuildable; cache hit-rate tracked.

## T5 — Observability + Evidence & Control + Evals/CI

The trust + governance spine made real. (Grouped because they share the Verdict/span data.)

- OTel spans for all loop steps (file `07`).
- Evidence & Control Layer: immutable audit, confirmation-gate records, compliance export (file `05`).
- Golden datasets, eval suites, score-based CI gates wired into the Stop hook (file `06`).
- **Depends on:** T2 (Verdicts), T3 (hooks). **Done when:** a failed run is reconstructable from spans; a regression is caught by a blocked gate; an audit export generates for any date range.

## T6 — Surfaces (Workbench fork + Console) + learning/training

The shells over the finished engine, plus the falling-cost flywheel.

- Workbench: VS Code fork, upstream-synced, reskinned governance-aware UI, vault browsing, inline approvals + token burn, slash commands/skills intact.
- Console: dashboards over spans/audit/evals; routing + RBAC config; drift alerts.
- Local-model training on accepted Verdicts + handover (the "at falling cost" moat).
- **Depends on:** T1–T5. **Done when:** a developer can drive the whole engine from the fork and an admin sees full governance in the Console.

---

## Why this order

The verifier and audit spine (T2/T5) are the moat — fan-out mechanics are commoditising, so they come *after* the thing that makes SC Prism trustworthy. Surfaces (T6) are last because a beautiful editor over an unverified engine is worth nothing; an unglamorous CLI over a *provably-done* engine is the product.

---

## Additions (v2 — folded in)

New work from the 2026–27 landscape sweep, mapped to the tranches above:

- **T3 (harness):** prompt-caching boundary in Bifrost (stable prefix vs live state); execution **sandbox** (gVisor on-prem); **A2A-serialisable handoff artifacts** — build the *seam* only, don't activate multi-agent yet.
- **T4 (knowledge):** **agentic retrieval sub-agent** (adaptive cascade); **OKF-conformant bundle** emission from the vault.
- **T5 (governance/evals/obs):** threat-model doc + sandbox-escape logging as security incidents.
- **T6 (surfaces/learning):** **GRPO training loop** on accepted Verdicts (gated on measured lift — see `10`); **SKILL.md** discovery in the vault; activate **A2A** multi-agent only if a task genuinely needs it.

**Honest prioritisation — not everything is pre-launch.** Worth doing before launch: **prompt caching, the execution sandbox, and OKF emission** — each is low-cost, high-leverage, and hard to retrofit. Design-forward but safe to defer implementation: the **GRPO training flywheel** and **full A2A multi-agent**. Build the seams now (cheap), turn them on later (when the foundation — loop + evals + observability — is solid). Resist bolting every trend onto the launch; the moat is still the verifier + audit, not breadth.

---

## Solo-first addendum (2026-07-03, ADR-029)

Build order T0–T5 is unchanged. What changes is **delivery shape**:

- The first surface is the **single chat-first application** (ADR-027/029), shipping alongside the engine rather than at T6. A minimal version of it (chat + live agent panel + Verdict view) lands as soon as T2 produces Verdicts, and grows with each tranche.
- The founder is the first user (dogfooding): SC Prism is used daily to build SC Prism itself. Solo-alpha definition and acceptance: see `12-solo-app-spec.md`.
- The **VS Code fork Workbench** and a **separately deployed Console** move to the enterprise phase (post-solo-alpha). ADR-003 stands as the enterprise target; ADR-033 (proposed) has the Console ship as a web surface served from the same binary in the meantime.
- Multi-tenant sandbox tiers, GRPO flywheel, and A2A activation remain post-alpha, as already stated above.
