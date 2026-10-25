# SC Prism — Learning & Training

> The moat is "provably done, on-prem, **at falling cost**." The falling cost only happens if the local model improves from SC Prism's own verified outcomes over time. Every Verdict is training data. This file specs the flywheel — and is honest that it is the *last* thing to build, not the first.

## 1. The flywheel

```
 task runs ──► Stop hook passes (Tier-1 + Tier-2 evals pass)
                       │
                       ▼
          emit training record:
          { inputs, task intent, tools used, trajectory,
            final Verdict, tokens spent, steps }
                       │
                       ▼
        accumulate (encrypted, versioned)
                       │
            periodically (N records / monthly)
                       ▼
         GRPO fine-tune of the local model
                       │
                       ▼
        eval gate on goldens — lift proven?
            │ yes                    │ no
            ▼                        ▼
     promote new weights        discard, keep old
                       │
                       ▼
   route more routine work to the cheaper local model
                       │
                       └────────── cost floor falls ──────────┐
                                                              ▼
                                              (loop repeats, gets cheaper)
```

## 2. Why GRPO (not just supervised fine-tuning)

- **SFT** is right for *behaviour/format* (tone, structure, "respond like this"). Use it for surface conformance.
- **GRPO** (Group Relative Policy Optimization) is right for *"what made this work"* — it optimises against a **reward**, not next-token likelihood. SC Prism already produces the reward signal: a Verdict that passed Tier-1 + Tier-2, weighted by **envelope efficiency** (fewer tokens / steps / lower latency → higher reward). That means the model learns not just to be correct but to be *cheap and direct*, which is exactly the cost-floor goal.
- GRPO needs no hand-labelled dataset and no hand-written reward function beyond the Verdict + envelope you already log. It runs locally on modest VRAM (Unsloth-class tooling), which fits the on-prem / solo posture.

## 3. The reward function (sketch)

```
reward = w1 * tier1_pass           # tests/lint/build green
       + w2 * tier2_eval_score     # trajectory / tool-use / criteria
       + w3 * envelope_efficiency  # (budget - tokens_used)/budget, steps, latency
       - penalty * hook_blocks     # tried something the harness had to stop
```
Start conservative; tune weights from data. The envelope term is what turns "correct" into "cheap."

## 4. What to route to the trained local model

Only the **high-volume, stable, commodity** lane — the same lane the routing rule (Harness Layer 6) already sends to the cheap model: test generation, code review, compliance checks, routine retrieval reformulation. **Reasoning and planning stay on frontier models.** The local model earns more of the routine lane as it proves lift; it never silently takes over judgement-heavy work.

## 5. Gating (non-negotiable)

- **Never deploy a fine-tune without an eval gate** proving lift on the golden datasets (file `06`). Treat the magnitude of improvement as **unknown until measured** — do not hardcode an assumed percentage; run it on your goldens and let the number decide.
- A fine-tune that *regresses* any golden threshold is discarded; the previous weights stay.
- Training records and model versions are **encrypted and versioned like code**; a promoted model is tied to the eval run that justified it (reproducible).

## 6. Sequencing — build this last

This is the highest-effort, most speculative tranche (T6). It depends on the loop (T2), evals (T5/`06`), and observability (T5/`07`) all being solid, because the training signal *is* the Verdict + spans those produce. Build the seam — emit training records from the Stop hook — early and cheaply; defer the actual fine-tuning pipeline until the foundation is proven. The flywheel is the payoff, not the foundation.

## 7. Acceptance criteria

- Every passing task can emit a complete training record (provable from spans).
- A fine-tune is promoted only with a recorded eval run showing non-regression + lift.
- The local model's share of the routine lane rises over time with no drop in eval scores.
- Any promoted model version can be traced back to its justifying eval run and training set.
