# SC Prism — Solo Application Spec

> The first shipped SC Prism is **one desktop application for one user: the founder** (ADR-029). It embeds the full engine (ADR-027) and is used daily to build SC Prism itself. This file specs the app's shape, the first-run flow (ADR-030), and the main surface. The enterprise split comes later; the engine is identical either way.

## 1. What ships in the box

Single install, no external services:

- **Orchestrator core** — loop engine on the Conductor base (`github.com/microsoft/conductor`, MIT — ADR-031; depend-vs-fork per ADR-032).
- **Bifrost embedded** — router, semantic + prompt cache, MCP gateway (ADR-026; packaging: supervised subprocess over UDS, pending T1 confirmation).
- **LightRAG** knowledge layer over the markdown vault (ADR-025; GraphRAG fallback pending benchmark).
- **DeepEval** Tier-2 verifier; **OTel** instrumentation; all **six harness layers**; the **Evidence & Control** spine.
- **Console surface** served from the same binary on localhost (ADR-033, proposed).

## 2. Deferred beyond the solo alpha

- VS Code fork Workbench (enterprise phase; ADR-003 stands, deferred by ADR-029).
- Separately deployed Console app (served surface instead — ADR-033).
- Multi-tenant sandbox tiers (gVisor-class isolation still applies to local execution per ADR-019).
- GRPO fine-tuning pipeline (T6) — but the **seam ships now**: training records emitted from the Stop hook per ADR-017.
- A2A multi-agent activation — seam only, per ADR-015.

## 3. First run (ADR-030)

Every step below is still visibly *setup* — the user should never feel dropped into a dashboard mid-onboarding.

**Step 1 — Welcome.** SC Prism animation/branding. One action: begin.

**Step 2 — Provider panel.** Toggle list:
- **Local model** — on by default, endpoint URL input (e.g. `http://localhost:1234`).
- **Claude** / **OpenAI** / **Gemini** — toggle + API key input each.
- **Add custom service** — name + base URL + key.
- A single **Primary** selector marks which provider leads.

**Step 3 — Connection check → the AI takes over.** SC Prism tests the primary connection. On success, **the primary AI becomes the setup agent**: from here, onboarding is conversational, with the agent generating option cards for each remaining choice. (ADR-007 guard: the setup agent captures intent and drafts config; the deterministic Orchestrator and hooks do all enforcement.)

**Step 4 — Vault location.** Local folder anywhere on disk, a GitHub repo, or **both** (local + git-synced). The setup agent creates or connects it and validates.

**Step 5 — GitHub auth.** Grant access for commits and PRs; the setup agent confirms the connection works.

**Step 6 — Business interview.** The setup agent interviews the user:
- What the business does; products and clients.
- Departments / roles (even a solo founder has hats: developer, reviewer, admin).
- Governance priorities — compliance vs speed vs cost; risk appetite.
- Approval workflows: what always needs a human sign-off.
- The **"never touch" list**: paths, systems, and actions that are off-limits.

From the answers, the agent **drafts**: the RBAC/ABAC role map (Layer 3), the hook set (Layer 4), confirmation gates, and Bifrost routing rules (Layer 6 — e.g. brainstorming to one provider, governance reasoning to another, routine checks to the local model).

**Step 7 — Review + activate.** The drafts land in the vault as **plain reviewable files**. Nothing activates until the user confirms, and every draft passes the ADR-014 validation gate first — a hallucinated rule cannot silently become policy. Then the app transitions to the main surface.

## 4. Main surface (after setup)

Chat-first per ADR-027:

- **Primary chat** — intent capture, project status, progress reporting. It is a *front-end to the Orchestrator* (ADR-007): the chat AI never decomposes, routes, or controls agents; it converts intent into Task Contracts and narrates results.
- **Live agent panel** — an animated orb per active agent; state shows at a glance (planning / executing / verifying / blocked / done). Per-agent: current task, token burn, handoffs (who → who, why — A2A-shaped per ADR-015), eval scores. New agents deployable from chat.
- **Verdicts are the hero, not agent count.** Principle 4 says single-agent default — the panel must not become fan-out theater. The visual payoff is: what got *verified*, what the hooks *blocked*, what each step *cost*.
- **Vault browser** — read and edit the vault; edits pass the write-validation gate.
- **Stats view** — burn by model/task/operation, cache hit-rate and cache warmth (ADR-023), Tier-1 saves ("blocked N failures before spending eval tokens"), eval-score trend.
- **Console surface** — the governance dashboards from `07` §5, served from the same binary (ADR-033, proposed).

## 5. The dogfood loop

The founder uses SC Prism daily to build SC Prism:

1. Declare the next module as intent in chat → Task Contract → loop runs → Verdict.
2. Every escaped failure becomes a named golden (`06` §7) — the eval suite grows from real work.
3. Training records accumulate from every Stop-hook pass (ADR-017 seam), even though fine-tuning waits for T6.
4. Weekly: read the stats view; tune routing rules from real burn data.

## 6. Acceptance criteria (solo alpha)

- Fresh install → completed onboarding → first task executed end-to-end with a persisted Verdict, in **under 15 minutes**.
- Business-interview output lands as reviewable vault files; **nothing activates without explicit confirmation**; a contradictory draft is rejected with a reason (ADR-014).
- The chat surface cannot trigger any action except via a Task Contract to the Orchestrator (ADR-007 — provable from spans).
- A Tier-1 failure never spends Tier-2 tokens (restating `02` acceptance at the app level).
- The founder has used the app daily for **≥1 week of real SC Prism development**, with Verdicts + spans on record for that work.
