# SC Prism — Orchestrator Loop Engine

This is the engine specced in the original OpenLux docs but never built. It is **not** a new app — it is ~5 Python modules inside the Orchestrator core, sitting between the MCP server and Bifrost.

> **2026-07-03 note:** ADR-024/031 base the Orchestrator on Microsoft Conductor (github.com/microsoft/conductor). The proposed integration pattern (ADR-032): the planner **emits Conductor YAML per Task Contract**, then execution is deterministic — the module layout below maps onto that.

## 1. The loop

```
 receive Task Contract
        │
        ▼
   PLAN ──► decompose into steps; mark each read-only or write
        │
        ▼
 DISPATCH ──► read-only steps may run in parallel; writes run serially
        │
        ▼
 EXECUTE ──► call model(s) via Bifrost; run tools
        │
        ▼
  VERIFY ──► Tier 1 deterministic (tests/lint/build)  ──fail──┐
        │           │ pass                                     │
        │           ▼                                          │
        │     Tier 2 LLM / DeepEval                  ──fail──► repair step
        │           │ pass                                     │
        ▼           ▼                                          │
 WRITE-BACK ◄───────┘  log verdict + artifacts; mutate vault ◄┘
```

## 2. The rule that makes it cheap (two-tier verifier)

**Tier 1 — deterministic, zero token cost.** Run the project's tests, linter, type-checker, and build. If any fail, do not spend a single LLM token — route straight to a repair step. This is the highest-leverage rule in the whole system.

**Tier 2 — LLM / eval, only on Tier-1 pass.** DeepEval (your chosen LLM verifier) scores the non-deterministic part: did the agent take a sensible trajectory, pick the right tools, meet the quality bar, satisfy the acceptance criteria? Tests cover the deterministic "this input → that output"; evals cover everything tests can't.

If you build nothing else flashy, build a **single-agent loop with deterministic verification + write-back first.** That is worth more than a 20-agent fan-out with no verifier.

## 3. Parallelisation rule

Parallelise **only read-only work** (search, read, analyse, retrieve). All writes — file edits, vault mutations, commits — are **serial**. This reconciles "run many agents" with the serial-execution principle: breadth is allowed for reads, never for writes.

## 4. Single-agent default

Default to one agent. Fan-out to specialists (researcher / implementer / reviewer) only when a task genuinely decomposes and the orchestration cost is justified. When fanning out, prefer the **orchestrator pattern** (route once, execute deterministically, synthesise once — ~2 LLM calls) over an open agentic loop (~7+ calls) for the same answer. A reviewer/verifier sub-agent checking another agent's output is the one fan-out that reliably pays for itself.

## 5. Core schemas (sketch — finalise as starter code in T1)

**Task Contract** (Workbench → Orchestrator):
```
task_id, intent, acceptance_criteria[], scope (paths/dirs allowed),
read_only|write, priority, token_budget, max_turns, requester_role
```

**Verdict** (Orchestrator → write-back + Console):
```
task_id, tier1 {tests, lint, build: pass|fail, logs},
tier2 {eval_scores{}, judge_notes, passed: bool},
artifacts[], tokens_spent, model_route[], hooks_fired[], timestamp
```

The Verdict is the audit spine — it connects loop, evidence layer, observability, and training.

## 6. Module layout (inside the core)

```
orchestrator/loop/
  contract.py     # Task Contract parsing + validation
  planner.py      # decompose into steps, tag read/write
  dispatcher.py   # parallel reads / serial writes, calls Bifrost
  verifier.py     # Tier 1 deterministic + Tier 2 DeepEval
  writeback.py    # emit Verdict, mutate vault, log
```
DeepEval backs `verifier.py`; a LangGraph bridge can back `dispatcher.py` if you want typed state edges.

## 7. Long-running / overnight loop mechanics

The overnight build loop is a server process, not a chat session. Required for reliability across many context windows:

- **Fresh context per task.** Kill and restart the session after each task. Each fresh window reads the vault + the one task file with no accumulated conversational noise. Shorter sessions enable *longer* total productive runs.
- **Checkpoint every task, atomically.** Write progress/state to disk before moving on. A crash at task 47 of 100 resumes at 47, not 0.
- **Idempotent steps.** Design each step so running it twice equals running it once; wrap side effects so they can be safely replayed.
- **Hard caps.** `--max-turns` per session, a `timeout` wrapper around each invocation to kill hung processes, restricted tool set per task.
- **Initialiser prompt.** The first context window uses a *different* prompt that sets up the environment and writes a comprehensive requirements/feature file, so later windows don't try to one-shot the whole product.
- **Rate-limit handling.** Detect 429s, exponential backoff, give up after N.

## 8. Acceptance criteria for the engine

- A task that fails its tests never reaches Tier 2 (provable from spans: no Tier-2 span emitted on Tier-1 fail).
- No two write steps ever execute concurrently.
- Every completed task emits exactly one Verdict, persisted before the next task starts.
- A killed run resumes from the last checkpoint with no duplicated writes.
