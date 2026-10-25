# SC Prism Engine — T0–T2 skeleton

A standalone, **dependency-free** (Python 3 stdlib + `unittest` only) skeleton
of the SC Prism **Orchestrator loop** and **two-tier Verifier**.

> **A model NEVER orchestrates.** The Orchestrator is deterministic Python.
> Models are only ever *dispatched to* for individual steps.

## What this is (and isn't)

This implements the **T0–T2 slice** of the SC Prism spec:

- **T0 — Contract**: a deterministic `TaskContract` (intent, acceptance
  criteria, scope, mode, budgets).
- **T1 — Plan + Dispatch**: deterministic decomposition into read/write
  steps; sensitivity-aware routing (local vs cloud); read-only steps run
  concurrently, write steps strictly serial.
- **T2 — Verify + Writeback**: Tier-1 deterministic checks (zero tokens, via
  subprocess), short-circuiting into a Tier-2 LLM-eval **stub**, then an
  atomic Verdict written to a vault.

**Honest scope note.** This is a *skeleton*. It is **NOT** the Conductor fork
and it is **NOT** wired to Bifrost (model gateway), DeepEval (Tier-2 judge),
or LightRAG (retrieval). The `model_call` and `tier2` functions are
deterministic **stubs** — no network calls, no real tokens spent. The seams
where those integrations plug in are marked in the code:

- `dispatcher.model_call` — where a Bifrost / OpenAI-compatible call goes
  (honored via `OPENAI_BASE_URL`, but kept stubbed on purpose).
- `verifier.tier2` — where the DeepEval / LLM-judge metric goes.

## Layout

```
engine/
  README.md
  scprism_engine/
    __init__.py       # public API re-exports
    contract.py       # TaskContract + parse/validate
    planner.py        # plan(contract) -> [Step]; route(step) local/cloud
    dispatcher.py     # dispatch: reads concurrent, writes serial; model_call stub
    verifier.py       # tier1 (subprocess, 0 tokens) -> tier2 (eval stub)
    writeback.py      # build + atomically persist a Verdict
    loop.py           # run(): contract -> plan -> dispatch -> verify -> writeback
    __main__.py       # CLI
  tests/              # unittest suite
```

## Run the tests

From the repository root:

```
python3 -m unittest discover -s engine/tests
```

## Run the CLI

```
cd engine
python3 -m scprism_engine run "add a rate-limit guard" --vault /tmp/scprism-vault
```

Optionally supply deterministic Tier-1 checks (repeatable):

```
python3 -m scprism_engine run "add a rate-limit guard" \
    --vault /tmp/scprism-vault \
    --tier1 "python3 -m pytest -q" --tier1 "ruff check ."
```

The command prints the Verdict JSON and writes:

- `<vault>/verdicts/<task_id>.json` — the full Verdict (atomic write).
- `<vault>/log.md` — an appended one-line audit entry.

Exit code is `0` when the Verdict passed, `1` otherwise.

## The loop, in one breath

`contract → plan → dispatch → tier1 → (tier2 iff tier1 passed) → writeback`

If **Tier-1 fails, Tier-2 never runs** (short-circuit) and the Verdict records
the short-circuit reason.
