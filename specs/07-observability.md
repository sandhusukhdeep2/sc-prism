# SC Prism — Observability

> If you can't observe it, you can't debug it or scale it. Structured tracing, not logs. The Console is a *reader* of this data; it never hooks the loop.

## 1. Standard: OpenTelemetry

> **As built (2026-08-31):** this section describes the intended destination,
> not the current state. Spans are emitted by `engine/scprism_engine/telemetry.py`
> — a synchronous JSONL writer using an OTel-*shaped* schema. There is no
> `import opentelemetry` in the engine and nothing exports OTLP. The gap to
> close is the exporter, not the instrumentation points, which already exist
> for every model call, tool execution, retrieval and verdict.

Use **OpenTelemetry (OTel)** as the transport and schema — the industry has converged on it, so it prevents vendor lock-in and interoperates across frameworks. Emit GenAI-flavoured spans and metrics (provider, model name, operation, token counts, error info) rather than inventing a custom format. Tracing is **asynchronous** — it adds no latency to the loop, so it can run at full volume in production.

## 2. The session is the unit of analysis

Unlike model monitoring (which treats each call as a discrete event), agent observability treats the **whole session/run** as the primary unit, then stitches spans into a trace. A SC Prism run = one task's full trajectory.

## 3. Span types to emit

Every step of the loop emits a typed span:

| Span | Captures |
|---|---|
| `model_call` | provider, model, prompt/completion tokens, latency, cost, cache hit/miss |
| `tool_exec` | tool name, args (sanitised), result status, latency |
| `agent_handoff` | from→to agent, reason, shared state ref |
| `retrieval` | query (reformulated), cascade stage reached (BM25 / rerank / graph), hit count |
| `hook` | hook type, lifecycle point, allow/block, reason |
| `verdict` | Tier-1 results, Tier-2 eval scores, pass/fail |

Child spans nest under the run; attributes carry metadata; events mark significant occurrences. A failed run must be fully reconstructable from spans alone — that is the test of whether instrumentation is sufficient.

## 4. Cost attribution

Agents autonomously chain many model/tool calls, so cost is unpredictable without **per-trace, per-operation cost attribution.** Track token burn by operation (which step/agent/model spent what). This is what turns "the loop cost $14 last night" into "test-generation on the cheap model cost $2, reasoning on the big model cost $11, and one runaway retrieval cost $1." Without it you can't tune routing.

## 5. Console dashboards (what leadership sees)

The Console reads spans and renders:
- **Agent execution graph** — which agent called which, in what order, with timing.
- **Token burn** — by operation, model, task, and time; the "CEO sees the burn" view.
- **Hook latency + fire rate** — is the enforcement layer healthy or thrashing.
- **Eval scores over time** — quality trend on goldens.
- **Drift alerts** — a sudden drop in eval score or cache hit-rate, or a spike in cost, fires an alert. A drop often means index degradation or a schema mismatch after a deploy.
- **Cache warmth** (per ADR-023) — after an embedding-model upgrade forces a namespace reset, the cache is cold; show warmth so the post-upgrade cost spike is *explainable*, not an incident.

## 6. Operational metrics (not just behaviour)

Emit operational health alongside behaviour: latency, error rates, index growth, retrieval hit-rate, memory reuse across agents. Alarm on anomalies.

## 7. Acceptance criteria

- Every loop step emits a typed span with token count and outcome.
- A failed overnight run can be diagnosed end-to-end from the trace with no extra logging.
- Cost is attributable to operation and model for any run.
- A regression in eval score or a cost spike raises a Console alert without manual polling.
- Tracing adds no measurable latency to task execution.
