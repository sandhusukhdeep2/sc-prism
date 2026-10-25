# SC Prism — Interoperability (Open Standards)

> SC Prism's enterprise positioning is **vendor-neutral, open-standards-native governance.** That directly answers the biggest enterprise objection — lock-in. Four open standards, one per layer.

## 1. The four layers

| Layer | Standard | What it connects | Status in SC Prism |
|---|---|---|---|
| Tools | **MCP** | agent → external tools/services | in use (external integrations) |
| Agents | **A2A** | agent → agent | design-forward (seam now) |
| Knowledge | **OKF** | knowledge → any consumer | adopt (vault = bundle) |
| Capabilities | **SKILL.md** | reusable procedures → any agent | adopt (vault-published) |

The pitch in one line: *SC Prism speaks MCP for tools, A2A for agents, OKF for knowledge, and SKILL.md for skills — your knowledge and capabilities are portable on day one.*

## 2. MCP — tools

Already covered in the harness tools layer (`03` §Layer 2). Reserve MCP for **external** integrations (Jira, Confluence, GitHub) where a third party consumes the server; keep the internal hot path on direct SDK calls to avoid the 55–100k-token tool-definition overhead. MCP connects agents to tools; A2A (below) connects agents to agents — they are complementary, not competing.

## 3. A2A — agents

The open Agent-to-Agent standard (originally Google, April 2025; **v1.0 stable April 2026**; 150+ orgs in production; donated to the Linux Foundation; native in Google ADK, LangGraph, CrewAI, LlamaIndex, AutoGen). Four primitives:

- **Agent Card** — a JSON advertisement of what an agent can do (capability discovery).
- **Task** — the unit of delegated work, with a lifecycle (can be long-running, status-synced).
- **Message** — context, replies, instructions, exchanged between agents; carries typed "parts."
- **Artifact** — the output of a Task.

**SC Prism mapping:** the **Verdict ≈ an A2A Artifact**; an agent's advertised capabilities ≈ an **Agent Card**; the Task Contract ≈ an A2A **Task**. Transport is HTTPS + JSON-RPC 2.0.

**Decision (ADR-015):** make handoff artifacts A2A-serialisable **now**, while single-agent stays the default. It's a one-way gate — cheap to design in, expensive to retrofit. Don't activate multi-agent orchestration until a task genuinely needs it; the moat is the verifier, not agent count.

## 4. OKF — knowledge

Covered in depth in `04` §9. The vault emits **OKF v0.1** bundles (markdown files + YAML frontmatter + markdown-link graph + reserved `index.md`/`log.md`). SC Prism is the **producer**; any OKF consumer can read it. OKF is the interchange container; GraphRAG remains the authoritative engine on top.

## 5. SKILL.md — capabilities

SKILL.md is now a **cross-agent open standard** — the same skill file runs across Claude Code, Codex, Cursor, Gemini CLI, and 20+ tools, and a marketplace ecosystem has formed around it (multiple registries, security-scanned skills). A skill is a reusable *procedure*; an OKF bundle is curated *knowledge* — together they are SC Prism's composability story.

**Decision (ADR-020):** users publish `SKILL.md` files inside the vault (e.g. `.../skills/`); the Orchestrator auto-discovers them and exposes them as slash commands / callable procedures. Because they follow the open standard, they work across SC Prism *and* other compatible agents — no lock-in.

## 6. Why this is a moat, not a giveaway

Standards-portability sounds like surrendering leverage, but SC Prism is the **producer and the governor**: the system that keeps the knowledge fresh, the skills verified, the handoffs audited, and the whole thing *provably done at falling cost*. Consumers depend on SC Prism maintaining the source of truth. Open standards remove the lock-in objection while the verifier + audit + training flywheel remain the defensible core.

## 7. Acceptance criteria

- Handoff artifacts validate against the A2A schema (Verdict serialises as an Artifact).
- The vault validates as an OKF v0.1 bundle.
- A `SKILL.md` dropped in the vault is auto-discovered and runnable, and the same file runs in at least one other compatible agent.
- External tool access goes through MCP; internal governance operations do not.
