# SC Prism — Evaluation & CI

> The single biggest separator between vibe coding and agentic engineering is how output gets verified. Tests cover the deterministic part; **evals** cover the non-deterministic part. Without both, it's vibe coding no matter how good the prompts look. This file specs the eval/CI discipline the base plan under-specified.

> **2026-07-03 note:** ADR-022 extends this — evals run at **two gates**: pre-deploy (CI, blocking) and continuously post-deploy on strategically sampled production traces. Write the sampling strategy down (oversample high-risk intents) so "strategically sampled" doesn't rot into a random 1%.

## 1. Tests vs evals

- **Tests** — deterministic. "This input yields that output." Belong in Tier 1 of the loop verifier. Zero token cost.
- **Evals** — non-deterministic. Did the agent take a sensible trajectory, pick the right tools, satisfy acceptance criteria, meet the quality bar? This is Tier 2 (DeepEval). Agent evaluation operates on the **full execution trace**, not a single response — tool-call accuracy, plan adherence, step efficiency, end-to-end success.

## 2. Golden datasets

Goldens are the foundation: trusted inputs paired with ideal outputs (or ideal *trajectories*), decoupled from any single run. Because they're run-independent, you can re-run the same goldens across model versions and SC Prism iterations, generating fresh outputs each time — that's what makes regression testing work.

- Seed goldens from real production spans (annotate good runs).
- Cover the breadth of tasks SC Prism will meet, with explicit ground-truth steps and final answers.
- Version goldens like code.

## 3. Operating envelopes

Beyond "did it get the right answer," gate on **envelopes**: token budget, step/turn limits, latency timeouts. These catch the runaway agent that technically succeeds but burns 10× the tokens or loops 40 times. An eval suite without envelopes misses the most expensive failures.

## 4. CI gates (score-based, not binary)

Replace binary pass/fail assertions with **score-based deployment gates**. Every change — prompt, rule file, model, harness config — triggers an offline eval run against goldens. A build that scores below threshold is **blocked from merging**. This prevents regressions systematically instead of relying on a human noticing.

Concretely for SC Prism's overnight loop: before the agent's Stop hook lets it declare a task done, run evals against the relevant goldens + envelopes. Below threshold → block the write, route to repair.

## 5. Where evaluation runs (the four stages)

| Stage | What runs | Cadence |
|---|---|---|
| **Local / CI** | automated metrics on goldens + envelopes | every meaningful change — the default gate |
| **Pre-release** | humans review a fixed sample of traces, especially high-risk intents; calibrate judges if scores drift from reviewer consensus | after prompt/tool/model changes |
| **Production** | monitor traces + user signals; audit flagged sessions (errors, sudden metric drops) — sample with intent, don't read everything | continuous |
| **Close the loop** | every disagreement / incident / "weird pass" becomes a new golden | ongoing |

## 6. LLM-as-judge calibration

LLM judges exhibit biases (e.g. favouring certain writing styles) and can be unreliable. So: compare judge labels against human annotations on a benchmark slice, identify systematic biases, and re-calibrate when production scores drift from reviewer consensus. The judge is itself something you evaluate, not an oracle.

## 7. Close-the-loop rule

The through-line for the whole system: **automate the repetitive scoring, humanise the ambiguous slice, and never let a production learning die in a chat log.** Every bug that escapes becomes a named golden so the same bug can't sneak back unnamed.

## 8. Tooling

DeepEval is the chosen framework (it already backs the loop's Tier-2 verifier). Use its dataset/goldens + evals iterator; wrap loop functions so each golden becomes one agent run and metrics score the resulting trace. CI integration is custom GitHub Actions invoking the eval run as a gate.

## 9. Acceptance criteria

- No task is marked done without a passing eval run recorded in its Verdict.
- A regression introduced by a config change is caught by a blocked CI gate, not in production.
- Every production failure has a corresponding new golden within the close-the-loop cycle.
- Judge scores are periodically reconciled against human review.
