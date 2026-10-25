# SC Prism — Claude Code Context

SC Prism is an AI governance and orchestration platform: a productised harness that makes agent output **provably done, on-prem, at falling cost**. Lineage: OpenLux → Belay → SC Prism (ADR-028). "Belay" appears only in historical ADR text in `specs/09` — never in new code or docs.

## Never touch / invariants

- **A model never orchestrates models.** The chat/setup AI is a front-end to the deterministic Orchestrator — intent capture and reporting only (ADR-007, ADR-027, ADR-030). This was the OpenLux dead end; do not reintroduce it.
- **Writes are serial.** Only read-only steps parallelise.
- **Tier-1 before Tier-2.** Deterministic checks (tests/lint/build) run first at zero token cost; a Tier-1 fail never spends LLM tokens.
- **The markdown vault is the single source of truth.** Every vault write passes the validation gate (ADR-014); indexes are derived and regenerable.
- **ADRs are never edited — only superseded** (`specs/09`).
- **Hooks enforce policy; instructions do not** (ADR-010).
- All model calls go **through Bifrost** — no direct provider SDK calls from the loop.

## Current focus

Solo alpha (ADR-029): one desktop application, founder as first user, dogfooding SC Prism to build SC Prism. Build order = `specs/08` (T0 → T2 first; the loop + two-tier verifier is the core). Immediate spike: Conductor provider-layer pluggability → Bifrost routing (open item 1 in `specs/09`).

## Key components

- **Conductor** — `github.com/microsoft/conductor` (MIT, verified 2026-07-03) as the loop base. Depend-vs-fork pending ADR-032; intended pattern: planner emits Conductor YAML per Task Contract.
- **Bifrost** (Apache 2.0) — embedded router + semantic/prompt cache + MCP gateway (ADR-026).
- **LightRAG** (MIT) — knowledge layer; full GraphRAG is the fallback ceiling (ADR-025).
- **DeepEval** (Apache 2.0) — Tier-2 verifier.
- **Spans** — every loop step emits one. As built this is `telemetry.py`, a
  synchronous JSONL writer with an OTel-*shaped* schema; there is no
  `import opentelemetry` anywhere in the engine. ADR-012 still stands as the
  intended destination (see `specs/07`), but nothing exports OTLP today. Do not
  describe SC Prism as OpenTelemetry-instrumented until it is.

## Conventions

- Specs live in `specs/` (files `00`–`12`). Read `specs/00-project-blueprint.md` first; if two documents disagree, `00` wins until reconciled.
- The roadmap is **build order, not a calendar**.
- Keep instruction/rule files lean — only what differs from defaults, counter-intuitive patterns, and the never-touch list (`specs/03`, final note). This file follows its own rule.
