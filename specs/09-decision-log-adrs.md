# SC Prism — Decision Log (ADRs)

ADRs record what was decided, when, and why. You don't edit an ADR — you supersede it with a new one. Status: **Accepted** unless noted.

> **Naming note (2026-07-03):** the product was renamed **Belay → SC Prism** (ADR-028). Historical ADR text below is preserved **verbatim** and still says "Belay" — records are superseded, never edited.

---

### ADR-001 — Product name: Belay
**Context:** rebrand of OpenLux after the architecture was reworked.
**Decision:** the product is **Belay**.
**Consequences:** OpenLux is the historical precursor; all new artifacts use Belay.
*(Superseded by ADR-028.)*

### ADR-002 — Router: Bifrost
**Context:** need a model router/gateway for many models + caching + tool access.
**Decision:** **Bifrost** (Go-based, MCP-native, built-in semantic cache).
**Consequences:** routing, semantic cache, and MCP access concentrate in one component; the Orchestrator calls models only through it.

### ADR-003 — Workbench delivery: fork VS Code, stay upstream-synced
**Context:** intercepting other tools at network/API level loses their native slash commands, plugins, skills. Extension APIs can't reach deep system-level AI integration.
**Decision:** **fork VS Code** for the Workbench and keep it upstream-synced.
**Consequences:** own the developer surface; accept fork-maintenance cost; keep the fork thin (routing/verification live in the Orchestrator).

### ADR-004 — Knowledge depth: full GraphRAG
**Context:** governance reasoning can require relationships across many documents.
**Decision:** **full GraphRAG** as the knowledge ceiling.
**Consequences:** graph traversal is available but is the *last* cascade stage; most queries resolve at BM25+rerank (see ADR-008).

### ADR-005 — Compliance posture: ready now, SOC 2 Type II later
**Context:** enterprise trust needs compliance, but Type II audits an operating period and can't be rushed.
**Decision:** **compliance-ready architecture now; SOC 2 Type II after 6+ months** of operations.
**Consequences:** RBAC, encryption, immutable audit, evidence export are built from day one; certification is a later milestone; design with EU AI Act / NIST AI RMF mappings in mind.

### ADR-006 — Semantic cache backend: Bifrost built-in
**Context:** choice between Bifrost's built-in cache and GPTCache.
**Decision:** **Bifrost built-in.**
**Consequences:** one fewer dependency; cache lives with the router.

### ADR-007 — Orchestrator controls models (not "AI controls AIs")
**Context:** OpenLux's "primary AI controls other AIs" was the core dead end.
**Decision:** a **deterministic Orchestrator controls the models**; no model orchestrates other models.
**Consequences:** the loop engine + harness are deterministic scaffolding; models are inputs, never controllers.

---

## New ADRs (2026-06-25, from follow-up research)

### ADR-008 — Retrieval is a cascade; graph is last
**Context:** BM25 leads on exact-match recall/precision; GraphRAG wins only for multi-hop relationship queries, at higher cost.
**Decision:** retrieve via **grep+BM25 → dense rerank → graph traversal**, escalating only when metrics demand it.
**Consequences:** ADR-004 stands, but graph traversal is gated to relationship/multi-hop queries; cheaper and faster for the common case.

### ADR-009 — Tools: MCP for external, SDK for the internal hot path
**Context:** heavy MCP setups burn 55–100k tokens on tool definitions (27–50% of a 200k window); internal tools you control gain nothing from MCP overhead.
**Decision:** **mcpvault/MCP for external integrations; direct SDK function calls for internal governance operations.**
**Consequences:** lower token floor; tighter control on the hot path; MCP reserved for where a third party consumes the server.

### ADR-010 — Enforcement via deterministic hooks, not instructions
**Context:** rule files in prose are followed "most of the time" — not good enough for destructive/irreversible actions.
**Decision:** enforce with **hooks** (PreToolUse/PostToolUse/Stop/HTTP/prompt) that the model cannot override; version them like code.
**Consequences:** policy becomes fact; a hook layer is a first-class part of the Workbench/Orchestrator config.

### ADR-011 — Access control: RBAC + ABAC, least privilege, at the Orchestrator
**Context:** autonomous agents need distinct identities and minimal, context-bound permissions to cap blast radius.
**Decision:** **RBAC + ABAC** enforced at the Orchestrator; time-bound least-privilege grants.
**Consequences:** an attribute store maps `agent_id:task_type → allowed ops`; permissions are auditable and revocable.

### ADR-012 — Observability via OpenTelemetry
**Context:** the industry has converged on OTel; the Console must observe without hooking the loop.
**Decision:** emit **OTel spans** for every loop step; the Console reads them.
**Status (2026-08-31):** partially implemented. The instrumentation points all
exist and the schema is OTel-shaped, but the transport is a local JSONL writer —
the engine imports no OTel SDK and exports no OTLP. The decision is not
superseded; it is not yet met.
**Consequences:** vendor-neutral, async, per-trace cost attribution; failed runs reconstructable from spans.

### ADR-013 — Verification: tests (Tier 1) + evals/CI gates (Tier 2)
**Context:** verification is the real separator; envelopes catch expensive "successful" runs.
**Decision:** **deterministic tests first, then DeepEval against golden datasets + operating envelopes; score-based CI gates block sub-threshold merges/writes.**
**Consequences:** no task is "done" without a passing eval recorded in its Verdict; every escaped failure becomes a new golden.

### ADR-014 — Memory writes are validated before persisting
**Context:** persisting hallucinated content into the source-of-truth vault poisons all downstream retrieval.
**Decision:** **dry-run every vault write against rule files; reject contradictions before L3 sync.**
**Consequences:** the vault stays trustworthy; a bad write fails closed with a reason.

---

## New ADRs (2026-06-28, from landscape sweep)

### ADR-015 — A2A handoff artifacts, design-forward
**Context:** A2A (Agent-to-Agent) is a stable open standard (v1.0, April 2026; 150+ orgs; native in LangGraph/CrewAI/Google ADK). MCP connects agents to tools; A2A connects agents to agents.
**Decision:** make Orchestrator handoff artifacts **A2A-serialisable from the start** — the Verdict maps to an A2A Artifact, an agent's advertised capabilities to an Agent Card — even while single-agent remains the default.
**Consequences:** supersedes the old "A2A timing" open item; build the seam now (cheap, one-way gate), activate multi-agent later. Transport: HTTPS + JSON-RPC 2.0.

### ADR-016 — Prompt caching is mandatory
**Context:** cached input is ~90% cheaper (Anthropic) / ~50% (OpenAI); re-sent context is otherwise the majority of an agent's bill.
**Decision:** **prompt caching is required** for the overnight loop. Bifrost owns the cache boundary per task type; the prompt is a layered document (stable prefix / live state).
**Consequences:** compression and context-routing must not break the cache boundary; Task Contract and system prompts split stable vs dynamic from T1.

### ADR-017 — Local models train on Verdicts via GRPO
**Context:** the "falling cost" moat requires the local model to improve from Belay's own verified outcomes; Verdicts are training data.
**Decision:** emit a training record on each Stop-hook pass; periodically fine-tune the local model with **GRPO** on a reward of (verified pass + envelope efficiency). See `10`.
**Consequences:** every fine-tune is **gated on measured eval lift** (magnitude unknown until run — do not assume a number); training data is encrypted and versioned; a regression blocks new weights.

### ADR-018 — Retrieval is agentic
**Context:** a fixed cascade can't adapt per query; retrieval is the dominant RAG failure point.
**Decision:** a fast **retrieval sub-agent** autonomously escalates the cascade (BM25 → rerank → graph) and decides when evidence is sufficient.
**Consequences:** isolated from the main reasoning loop; reduces escalations and context bloat; ADR-008's cascade stands but becomes adaptive.

### ADR-019 — Execution sandbox; Docker alone is insufficient
**Context:** AI-generated code needs stronger isolation than runc.
**Decision:** run execution in defense-in-depth — **gVisor on-prem now, Firecracker/E2B for multi-tenant.** Least-privilege grants; no egress by default; documented threat model.
**Consequences:** a subverted agent's blast radius is contained; escape attempts logged as incidents (see `05` §6).

### ADR-020 — Skills via SKILL.md, published in the vault
**Context:** SKILL.md is a cross-agent open standard (works across Claude Code, Codex, Cursor, Gemini CLI, 20+).
**Decision:** users publish **SKILL.md** files in the vault; the Orchestrator auto-discovers and exposes them; they run across Belay and other compatible agents.
**Consequences:** positions Belay as a governance + skills hub, not a walled garden (see `11`).

### ADR-021 — Vault conforms to OKF v0.1
**Context:** Google Cloud's OKF (2026-06-12) standardises exactly Belay's markdown-vault pattern.
**Decision:** the vault emits **OKF-v0.1-conformant bundles**; Belay is the producer.
**Consequences:** knowledge becomes portable to any OKF consumer; GraphRAG stays the authoritative engine on top; OKF is the container, not the engine (see `04` §9).

---

## New ADRs (2026-07-02, from research + review session)

### ADR-022 — Evaluation runs at two gates
**Context:** `06` specced score-based CI gates but left open whether evals also run post-deploy. Drift (model updates, index staleness, usage-distribution shift) is invisible to pre-deploy goldens.
**Decision:** evals run **pre-deploy** (CI gate, blocks sub-threshold merges/writes) **and continuously post-deploy** on strategically sampled production traces — not every trace.
**Consequences:** extends ADR-013. The Verdict feeds both gates; the same golden datasets score in both contexts. Post-deploy dashboarding lands with the Console (T6), but the data is emitted from day one.

### ADR-023 — Cache namespaces are locked per task type
**Context:** swapping the embedding model mid-task silently breaks semantic-cache matching (dimension mismatch → missed hits → the cost floor erodes without anyone noticing).
**Decision:** the embedding model is **locked per task type at task start**. An embedding-model upgrade forces a **fresh cache namespace**; old cached vectors go read-only and age out. A dimension mismatch is treated as **explicit cache invalidation**, never a silent miss.
**Consequences:** partially resolves the "cache-boundary strategy" open item. Namespace resets are logged and visible in the Console.

### ADR-024 — Fork Microsoft Conductor as the Orchestrator base
**Context:** Conductor ships YAML-first deterministic workflows with policy-as-code and pre-execution routing graphs — roughly 80% overlap with the planned from-scratch Python Orchestrator core.
**Decision:** **fork Conductor** as the Orchestrator foundation; layer Belay's harness (hooks, memory, verification, governance) on top as extensions.
**Consequences:** estimated 4–6 weeks saved on T1–T2; effort moves to the verifier and audit spine (the moat). **License must be verified on first pull and recorded here** — expected MIT/Apache 2.0, but this is unconfirmed until checked. If a short spike shows the fork fights the harness design, fall back to from-scratch.
*(License verified 2026-07-03 — see ADR-031. Delivery mechanism under review — see ADR-032, proposed.)*

### ADR-025 — Fork-first build strategy
**Context:** proven foundations exist for the editor, orchestration, and graph retrieval. The moat is the verifier + audit + cost floor — not reinvented infrastructure.
**Decision:**
- **Fork:** VS Code (Workbench — reaffirms ADR-003), Conductor (Orchestrator base — ADR-024), **LightRAG** (knowledge layer).
- **Integrate, don't fork:** Bifrost, DeepEval, OpenTelemetry, MCP.
**Consequences:** **modifies ADR-004** — LightRAG's lighter graph replaces Microsoft GraphRAG as the implementation. The retrieval cascade and "graph is last" routing (ADR-008/018) are unchanged. Benchmark LightRAG vs full GraphRAG on multi-hop goldens early; full GraphRAG remains the fallback if LightRAG under-performs on relationship queries.

### ADR-026 — Bifrost is embedded, not a sidecar service
**Context:** the product must ship as one application. A separately deployed router adds an operational seam and an HTTP hop.
**Decision:** Bifrost runs **inside the single Belay application** — no standalone router service, no network round-trip between Orchestrator and router.
**Consequences:** modifies ADR-002's *deployment shape only* — Bifrost remains the router, semantic cache, and MCP gateway. **Open engineering question for T1:** Bifrost is Go; packaging it inside one distributable means either an in-process binding or a bundled, supervised subprocess inside a single installer. Either satisfies this ADR; pick on performance + maintenance cost.

### ADR-027 — Monolithic application, chat-first surface
**Context:** target experience — install one thing; talk to a primary AI about the project, progress, and status; watch agents spawn, work, and hand off in a live side panel (Claude-Code-style), with stats visible.
**Decision:** ship Belay as a **single application** embedding the Orchestrator (Conductor fork), Bifrost, LightRAG, DeepEval, OTel instrumentation, all six harness layers, and the Evidence & Control spine. The surface is **chat-driven**: the user declares intent to a primary interface; agents are spawned for specialised work; a **live agent panel** shows each agent's status, A2A handoffs (who called who, why), token burn, tasks completed, and eval scores. New agents deployable from chat.
**Consequences:** deploy-once, no external services, simpler audit story. **ADR-007 still holds and must not be diluted:** the "primary AI" the user chats with is a *front-end to the deterministic Orchestrator* — intent capture and reporting only. Decomposition, routing, and agent control stay deterministic. A model never orchestrates models; that was the OpenLux dead end. **Open item:** reconcile with the three-app structure in `00`/`01` — whether the Console folds into the app's panel and whether the Workbench fork is the shell for this UI or a separate surface. Single-process resource budgeting (memory/CPU per module) is a T1 concern.
*(Reconciliation proposed — see ADR-033.)*

---

## New ADRs (2026-07-03, rename + solo-first + Conductor verification session)

### ADR-028 — Product name: SC Prism
**Context:** founder decision, 2026-07-03. Second rename in the lineage.
**Decision:** the product is **SC Prism** (repo slug `sc-prism`). Lineage: OpenLux → Belay → SC Prism.
**Consequences:** supersedes ADR-001. Living spec files are renamed throughout; historical ADR text (001–027) is preserved verbatim per the supersession discipline and still reads "Belay."

### ADR-029 — Solo-first build: one application, founder as first user
**Context:** the enterprise three-app split is heavy for a solo developer; the fastest path to proof is dogfooding. The governance category is crowding fast (hyperscalers + funded startups shipping weekly; EU AI Act enforcement Aug 2026) — the risk is staying a blueprint, not the design.
**Decision:** ship SC Prism first as a **single desktop application for one solo developer — the founder — who uses it daily to build SC Prism itself.** The enterprise split (Workbench fork + server Orchestrator + separate Console) comes after the solo core is proven.
**Consequences:** aligns with ADR-027's monolith. The VS Code fork (ADR-003/025) is **deferred to the enterprise phase** — reaffirmed as target, not blocking the solo alpha. Roadmap delivery shape changes (see `08` solo-first addendum): a minimal chat surface lands with the engine instead of at T6. "One engine, two shells" (01 §4) still holds — the same core later runs as a server. The credibility artifact is "built with itself."

### ADR-030 — Onboarding: AI-guided setup
**Context:** setup must configure providers, the vault, GitHub, and governance to the user's *actual business* — not generic defaults. Flow specified by the founder, 2026-07-03.
**Decision:** first-run wizard:
1. **Welcome** — SC Prism animation/branding.
2. **Provider panel** — toggles for: local model (endpoint URL input, on by default), Claude, OpenAI, Gemini, plus "add custom service." A single **primary** selector marks which provider leads.
3. **Connection check** on the primary. On success, **the primary AI takes over as the setup agent** for every remaining step — the rest of onboarding is conversational, with the agent presenting option cards so it still *feels* like setup, not a dashboard.
4. **Vault location** — local folder anywhere on disk, a GitHub repo, or both (local + git-synced). The setup agent validates the choice.
5. **GitHub auth** — grant access for commits and PRs; the setup agent confirms it works.
6. **Business interview** — the setup agent asks about the business, departments/roles, risk and governance priorities (compliance vs speed vs cost), approval workflows, and the "never touch" list. From the answers it **drafts** the initial RBAC/ABAC role map, hook set, confirmation gates, and Bifrost routing rules.
**Consequences:** generated governance config is written to the vault as **reviewable files and confirmed by the user before activation** — the ADR-014 validation gate applies, so a hallucinated rule cannot silently become policy. **ADR-007 guard:** the setup agent captures intent and drafts config; the deterministic Orchestrator + hooks enforce. During setup, routing may use multiple providers per their strengths (e.g. brainstorming vs governance reasoning vs local routine checks) via Bifrost per Harness Layer 6.

### ADR-031 — Conductor repo pinned; license verified (MIT)
**Context:** ADR-024 required license verification. Additionally, at least four unrelated projects share the name "Conductor" (Netflix-lineage `conductor-oss`, Java; `conductor.build`, a Mac app; a Rust markdown-board tool) — the audit table saying just "Conductor" was an ambiguity bug.
**Decision:** the Orchestrator base is **`github.com/microsoft/conductor`** — Microsoft's open-source Python CLI for YAML-first deterministic multi-agent workflows. **License: MIT, verified 2026-07-03** (Microsoft OSS blog 2026-05-14 + repo).
**Consequences:** closes the license line in the audit (⚠️ → ✅). Facts on record: launched mid-May 2026 (~6 weeks old at pin time); ships checkpoints/resume, HITL gates, static/dynamic parallel groups, workflow validation, a web dashboard, and native providers for the GitHub Copilot SDK and the Anthropic Claude Agent SDK. The ADR-024 harness-fit spike stands, with its **first question now defined:** is the provider layer pluggable enough to route *all* model calls through Bifrost?

### ADR-032 — Integration posture: depend + extend; fork only when blocked — **Status: Proposed**
**Context:** ADR-024/025 chose forking Conductor and LightRAG. Conductor is weeks old and moving fast — forking an infant codebase maximises divergence pain. Three forks (VS Code + Conductor + LightRAG) is triple upstream-sync duty, permanently, for a solo developer. ADR-025's own logic already prefers "integrate, don't fork" for Bifrost/DeepEval/OTel.
**Decision (proposed):** treat **Conductor and LightRAG as dependencies with extension points; fork only if the harness-fit spike proves blockage.** The VS Code fork stands (ADR-003 rationale) but is deferred per ADR-029.
**Consequences:** would modify ADR-024/025's *delivery mechanism*, not the component choices. **Integration pattern for the loop:** the **planner emits Conductor YAML per Task Contract**, then execution is deterministic — a diffable, inspectable routing graph exists *before anything runs*. This resolves the topology mismatch (Conductor fixes structure at definition time; SC Prism plans per task) and strengthens ADR-007 and the audit story.

### ADR-033 — One binary, two surfaces — **Status: Proposed**
**Context:** ADR-027's open item — reconcile the monolith with the three-app structure in `00`/`01`. Leadership will not open a developer tool; the "CEO sees the burn" story dies if governance dashboards live only inside a dev app.
**Decision (proposed):** a single process embeds the engine and serves **two surfaces**: (a) the chat-first app UI for the developer, and (b) the **Console as a web UI served from the same binary** — localhost in the solo build, network-exposed in enterprise deploys.
**Consequences:** deploy-once preserved; the audience split from `00`/`01` preserved. The Workbench question narrows to: the chat app is the shell now; the VS Code fork arrives in the enterprise phase (per ADR-029).

---

## New ADRs (2026-07-20, OpenCode-vs-own-engine decision)

### ADR-034 — Keep the SC Prism engine; do NOT adopt OpenCode as substrate; add MCP surgically — **Status: Proposed**
**Context:** a design brief (2026-07-20) proposed adopting **OpenCode / OpenWork** (different-ai) as the orchestration substrate — "stand on their engine, build the moat on top." This re-opens the ADR-024/031/032 question (which had chosen to fork/depend-on Microsoft Conductor). **Ground truth from the codebase:** the Conductor fork was never taken — the engine is hand-built stdlib Python (`engine/scprism_engine/`, ~14.5k lines, 509 tests). `loop.run()` is straight-line deterministic ("a model never steers this loop", ADR-007 honored in code); the verifier (Tier-1/Tier-2), Verdicts, hash-chained evidence, sensitive→local routing (Bifrost + Python), the multi-model role board, and the training-record seam are all real and working. MCP is **design-only** (no client/server code exists); A2A serialization is real.
**Decision (proposed):** **keep the hand-built engine.** Do NOT swap the substrate to OpenCode. Add the one real capability gap — **MCP** — as a governed client on our own spine, and add the richer **per-agent telemetry** the Manager View needs, both surgically. Take OpenCode's *ideas* (MCP-native tools, a live per-agent event stream), not its engine.
**Rationale:** (1) the "save the plumbing hours" premise is largely spent — the plumbing exists and is tested; a wholesale swap is a weeks-long migration with uncertain payoff; (2) OpenCode's native model-bosses-models pattern risks the ADR-007 guarantee, which our loop enforces in code today — do not gamble the founding principle on an unproven "govern from above"; (3) depending on a fast-moving external engine is permanent upstream-sync tax for a solo dev (the exact ADR-032 concern); (4) the genuine gap (MCP) is addable without the swap.
**Reconsider trigger:** revisit only if we hit a scale wall the stdlib loop genuinely cannot pass (massive parallel fan-out, or a tool/plugin ecosystem we cannot keep pace with).
**Consequences:** supersedes the *direction* of the OpenCode brief's §1 (adopt-as-substrate) while adopting its §4a/4b/4c goals (vault import, validated-memory gate, training seam — mostly already built) and its Manager View brief (a presentation layer over spans/Verdicts, ADR-007-guarded). ADR-024/031 (Conductor) remain historically on record but were never executed; ADR-032's "depend + extend; fork only if blocked" stance is affirmed and extended to "build our own where we already have; integrate externally only for genuine gaps (MCP)."

---

## License audit (2026-07-02, updated 2026-07-03)

| Component | License | Commercial use |
|---|---|---|
| Bifrost | Apache 2.0 | ✅ |
| Conductor (`github.com/microsoft/conductor`) | **MIT — verified 2026-07-03** | ✅ |
| LightRAG | MIT | ✅ |
| GraphRAG (fallback) | MIT | ✅ |
| DeepEval | Apache 2.0 (framework) | ✅ — Confident AI cloud is paid, optional |
| LangGraph / LlamaIndex / AutoGen | MIT | ✅ |
| OpenTelemetry | Apache 2.0 (CNCF) | ✅ |
| MCP | MIT spec / Apache 2.0 servers | ✅ |
| A2A | Apache 2.0 (Linux Foundation) | ✅ |
| SKILL.md / OKF | Apache 2.0 | ✅ |
| VS Code (fork base) | MIT (code-oss; **not** the branded binary) | ✅ — fork code-oss, own branding. **Note:** code-oss forks cannot use Microsoft's extension marketplace — plan on **Open VSX** (relevant when ADR-003 activates). |
| HippoRAG (research option) | verify | ⚠️ if ever used |

**Verdict:** no GPL, no copyleft anywhere in the stack. SC Prism itself can be licensed commercially without contamination. Remaining verification: HippoRAG, only if ever adopted.

---

## Effect on existing ADRs

| Existing | Status after latest sessions |
|---|---|
| ADR-001 (name: Belay) | **Superseded** by ADR-028 (SC Prism) |
| ADR-002 (Bifrost router) | **Modified** by ADR-026 — same component, embedded deployment |
| ADR-003 (VS Code fork) | **Reaffirmed** by ADR-025; **deferred** to enterprise phase by ADR-029 |
| ADR-004 (full GraphRAG) | **Modified** by ADR-025 — LightRAG implements; full GraphRAG is the fallback ceiling |
| ADR-007 (Orchestrator controls models) | **Reaffirmed + guarded** by ADR-027/030 — chat/setup AI is a front-end, never a controller |
| ADR-013 (tests + evals) | **Extended** by ADR-022 — second, continuous gate added |
| ADR-014 (validated vault writes) | **Applied** by ADR-030 — interview-generated governance config passes the gate + explicit user confirmation |
| ADR-024 (fork Conductor) | License item **closed** by ADR-031; delivery mechanism under **proposal** ADR-032 |
| ADR-025 (fork-first) | Delivery mechanism for Conductor/LightRAG under **proposal** ADR-032 |
| ADR-027 (monolith, chat-first) | Reconciliation under **proposal** ADR-033 |

---

## Session review notes (2026-07-03) — smaller findings on record

- **ADR-026 packaging recommendation:** bundled **supervised subprocess over a Unix domain socket**; skip in-process Go bindings (FFI cost outweighs negligible UDS latency; process isolation is a reliability feature). Decide at T1 — do not let it become a research project.
- **ADR-023 follow-ups:** confirm Bifrost's semantic cache actually supports **namespace keys/versioning** (T1 spike item); surface **cache warmth** after a namespace reset in the Console so post-upgrade cost spikes are explainable, not alerts (now noted in `07` §5).
- **ADR-022 follow-up:** write the production **sampling strategy** down (oversample high-risk intents) so "strategically sampled" doesn't rot into a random 1% (now noted in `06`).

---

## Open items (updated 2026-07-03)

1. **Conductor harness-fit spike** — license **CLOSED** (MIT, ADR-031). First question: **provider-layer pluggability** → can all model calls route through Bifrost? Second: can the **planner-emits-YAML** pattern (ADR-032) express the full loop, including verify/repair edges?
2. **Go-Bifrost packaging** inside a single distributable — recommendation on record (subprocess/UDS); confirm at T1. Also: does Bifrost's semantic cache support namespaces (ADR-023)?
3. **ADR-032 (depend vs fork)** — accept or reject after the spike.
4. **ADR-033 (one binary, two surfaces)** — accept or reject.
5. **LightRAG vs full GraphRAG benchmark** on multi-hop goldens (decides whether ADR-025's swap sticks).
6. Eval thresholds per task type — calibrate from early production runs (per ADR-022, now at both gates).
7. Checkpoint granularity for the overnight loop — unchanged, still open.
8. Prompt-cache boundary per *provider* — ADR-023 covers embedding/namespace discipline; per-provider boundary strategy still waits on the populated Bifrost routing table.
9. Sandbox tier for the first enterprise tenant — unchanged; deferred past the solo alpha per ADR-029.
10. **Solo-alpha acceptance + first dogfood task** — define per `12-solo-app-spec.md` and start.
