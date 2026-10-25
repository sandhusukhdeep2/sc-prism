# SC Prism — Architecture Overview

> **2026-07-03 (ADR-029):** the solo build ships as a **single application** embedding all components below (per ADR-027); the three-app split remains the enterprise target shape. Reconciliation tracked in `09` (ADR-033, proposed). See `12-solo-app-spec.md`.

## 1. The shape

Three applications over one substrate. The Orchestrator is the only component that talks to models; the Workbench and Console are surfaces onto it.

```
 Developer                          Admin / Leadership
    │                                      │
    ▼                                      ▼
┌────────────┐                       ┌────────────┐
│ Workbench  │                       │  Console   │
│ (VS Code   │   governance events   │  (web)     │
│  fork)     │──────────────┐        │            │
└─────┬──────┘              │        └─────▲──────┘
      │ agent requests      │              │ reads spans, audit, evals
      ▼                     ▼              │
┌──────────────────────────────────────────┴───────────┐
│                    ORCHESTRATOR                        │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │  Loop   │  │ Harness  │  │ Evidence │  │ Learn  │  │
│  │ engine  │  │ (6 layer)│  │ & Control│  │ /train │  │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │
│       └────────────┴─────────────┴────────────┘       │
│                        │                              │
│                   ┌────▼─────┐                        │
│                   │ Bifrost  │  router/gateway        │
│                   │ (Go, MCP)│  + semantic cache       │
│                   └────┬─────┘                        │
└────────────────────────┼─────────────────────────────┘
                         ▼
        Local models  •  Claude  •  Gemini  •  …
                         ▲
              ┌──────────┴───────────┐
              │  Shared substrate:   │
              │  markdown vault +    │
              │  GraphRAG index      │
              └──────────────────────┘
```

## 2. Data flow (developer request)

1. Developer issues intent in the Workbench (chat, slash command, or agent task).
2. Workbench packages it as a **Task Contract** (see loop-engine doc) and sends it to the Orchestrator over the MCP server.
3. Harness layers fire: relevant memory/context is loaded (progressive disclosure), permissions are checked, pre-action hooks run.
4. Loop engine plans, dispatches work, and calls models **through Bifrost**, which applies routing rules (sensitive → local, research → Gemini, reasoning → Claude), semantic cache, and prompt cache.
5. Output is verified — deterministic checks first, then LLM/eval — and written back. Every step emits a span (OTel-shaped; see `07-observability.md` for what is built versus intended).
6. Verdicts, spans, and audit records flow to the Console.

## 3. Component boundaries (what lives where)

**Workbench (the surface, thin):** editor UX, the reskinned governance-aware UI, vault browsing, slash commands/skills, surfacing approvals and token burn inline. It does **not** route, cache, or verify — it asks the Orchestrator to.

**Orchestrator (all the real work):**
- *Loop engine* — plan/dispatch/execute/verify/write-back.
- *Harness* — the six layers (memory, tools, permissions, hooks, observability, context routing).
- *Evidence & Control* — audit trail, confirmation gates, compliance artifacts.
- *Learning/training* — local-model training on accepted verdicts and handover.
- *Bifrost* — the router/gateway: model selection, semantic cache, prompt cache, MCP-native tool access.

**Console (read-mostly):** dashboards over spans/audit/evals; admin config of routing rules and RBAC; drift alerting. Writes config; reads everything else.

**Substrate:** the markdown vault (single source of truth) + GraphRAG index. All three components read it; only governed, verified writes mutate it.

## 4. Why these boundaries

- One engine, two shells: the same Orchestrator core runs as a **local desktop service** (solo / on-prem) and a **server service** (enterprise). Surfaces differ; the engine doesn't.
- Keeping routing/caching/verification out of the Workbench means the editor fork stays thin and easy to keep upstream-synced.
- The Console reading spans rather than hooking into the loop keeps governance observation **non-intrusive** — it cannot slow or break execution.

## 5. External protocol posture

- **MCP** for tool access (external integrations: Jira, Confluence, GitHub, etc.) — but see the harness doc on the MCP-vs-SDK split for the hot path.
- **A2A** (agent-to-agent) is the standard to adopt for inter-agent handoffs once multi-agent orchestration is live; design the loop's handoff artifacts to be A2A-compatible from the start.
