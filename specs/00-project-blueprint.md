# SC Prism — Project Blueprint

> **Single source of truth.** Every other file in this set elaborates one slice of what is summarised here. If two documents disagree, this one wins until reconciled.

> **Provenance.** This set was reconstructed on 2026-06-25 from (a) the architecture and decisions locked in the June 21 design session and (b) follow-up research on 2026–27 harness, retrieval, eval, and observability practice. **Updated 2026-07-03:** product renamed **Belay → SC Prism** (ADR-028); merged the 2026-07-02 session ADRs (022–027) into `09`; added ADRs 028–033, the solo-first strategy (ADR-029), `12-solo-app-spec.md`, and a root `CLAUDE.md` for Claude Code.

---

## 1. What SC Prism is

SC Prism is an enterprise AI governance and orchestration platform. It lets an organisation run many AI coding/knowledge agents across many models, while keeping spend, behaviour, and output **provably governed, auditable, and on-prem-capable**.

The one-line bet: **the harness — not the model — decides whether you can depend on what ships.** SC Prism is a productised harness.

It is a rearchitecture and rebrand of the earlier **OpenLux** project (lineage: OpenLux → Belay → SC Prism). The dead end OpenLux hit was "a primary AI controls other AIs." SC Prism inverts that: a deterministic **Orchestrator** controls the *models*, never a model controlling models.

**Go-to-market sequencing (ADR-029):** SC Prism ships first as a **single application for a solo developer** — the founder is user #1 and uses it daily to build SC Prism itself (dogfooding). The enterprise multi-app split comes after the solo core is proven.

## 2. The three components + shared substrate

| Component | What it is | Who uses it |
|---|---|---|
| **Workbench** | A fork of VS Code with agent routing, the vault, and governance baked into the editor surface (not a webview bolt-on) | Developers |
| **Orchestrator** | Python core + **Bifrost** as router/gateway. Owns routing, the loop engine, memory, verification, learning | The system itself |
| **Console** | Web governance dashboard: spend, routing, audit, eval scores, drift | Admins / leadership |

**Shared substrate (all three read it):** a markdown vault as the single source of truth, indexed by a full **GraphRAG** knowledge layer.

> **Solo-phase note (ADR-027/029):** in the solo build all of the above ships inside **one application** with a chat-first surface; the table is the enterprise target shape. See `12-solo-app-spec.md` and ADR-033 (proposed reconciliation).

Why own the editor instead of intercepting other tools at the network layer: intercepting Claude Code / Cursor / Gemini at the API or proxy level always loses their native slash commands, plugins, and skills. Owning the developer surface keeps those intact and routes everything underneath.

## 3. Core design principles (locked)

1. **Harness over model capability.** Effort goes into scaffold, not model selection.
2. **Deterministic verification before LLM review.** Tests / lint / build (zero token cost) gate first; only then spend tokens on LLM/eval review.
3. **Serial execution by default; parallelise read-only work only.** Writes stay serial.
4. **Single agent by default.** Fan-out is a justified exception, not the baseline.
5. **Markdown-native vault is the single source of truth.** Everything else is derived and regenerable.

## 4. The six locked decisions

1. **Name:** SC Prism (ADR-028; lineage OpenLux → Belay → SC Prism).
2. **Router:** Bifrost (Go-based, MCP-native, built-in semantic cache) — embedded in-app per ADR-026.
3. **Workbench delivery:** fork VS Code, stay upstream-synced (deferred to the enterprise phase per ADR-029).
4. **Knowledge depth:** full GraphRAG (implemented via LightRAG per ADR-025; GraphRAG is the fallback ceiling).
5. **Compliance posture:** compliance-ready architecture now; SOC 2 Type II after 6+ months of real operations.
6. **Semantic cache backend:** Bifrost built-in (not GPTCache).

## 5. The moat

Claude Code, Cursor, and others now ship their own fan-out workflows, so "most agents" is commoditising. SC Prism's defensible position is the **verifier + audit + local routing + training on the verdicts**: *provably done, on-prem, at falling cost.* Build for trustworthy, not for breadth.

## 6. What was added on top of the base product

Seven additions, each detailed in later files: full GraphRAG knowledge layer, agentic RAG, semantic caching (Bifrost), prompt caching, parallel agent orchestration, local-model training and handover, and an **Evidence & Control Layer** for enterprise trust. Today's research adds a formal **six-layer harness spec**, an **eval/CI** discipline, and an **observability** spec — the three areas the base plan under-specified.

## 7. File index

| File | Purpose | State |
|---|---|---|
| `00-project-blueprint.md` | This file | updated 2026-07-03 |
| `01-architecture-overview.md` | Components + data flow | updated (solo banner) |
| `02-orchestrator-loop-engine.md` | The loop + two-tier verifier | updated (Conductor note) |
| `03-harness-spec.md` | The six harness layers | renamed |
| `04-knowledge-layer.md` | Vault + GraphRAG + retrieval + caching | updated (LightRAG note) |
| `05-governance-security.md` | RBAC/ABAC, evidence layer, compliance | renamed |
| `06-evaluation-and-ci.md` | Golden datasets, evals, CI gates | updated (ADR-022 note) |
| `07-observability.md` | OTel spans, Console dashboards | updated (cache warmth) |
| `08-roadmap-tranches.md` | T0–T6 dependency-ordered build | updated (solo addendum) |
| `09-decision-log-adrs.md` | All ADRs (001–033) | merged + extended |
| `10-learning-and-training.md` | GRPO flywheel: training local models on Verdicts | renamed |
| `11-interoperability.md` | Open standards: MCP + A2A + OKF + SKILL.md | renamed |
| `12-solo-app-spec.md` | Solo application: onboarding + chat surface | **new** |
| `CLAUDE.md` (repo root) | Claude Code context file | **new** |
