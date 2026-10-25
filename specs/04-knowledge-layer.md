# SC Prism — Knowledge Layer

> **2026-07-03 note:** ADR-025 makes **LightRAG** the graph implementation (full GraphRAG remains the fallback ceiling, pending the multi-hop benchmark). "GraphRAG" below refers to the graph-retrieval capability, whichever engine implements it.

## 1. The vault is the source of truth

A markdown vault is the single source of truth for the whole product. Everything else — indexes, embeddings, graph — is **derived and regenerable** from it. This is a locked principle: if the index and the vault disagree, the vault wins and the index is rebuilt.

## 2. What belongs in the repo (freshness discipline)

Agents walk the repo with grep/find/cat and treat every text file as equally authoritative; they have no intuition that "this note is three months stale." So control what's there:

- **Executable artifacts** belong in the repo: code, tests, linter/type configs, schema definitions, CI configs. These are mechanically decidable as right/wrong and break loudly if they rot.
- **Architecture Decision Records (ADRs)** belong in the repo: "at this time we decided X, for these reasons." You don't edit an ADR — you supersede it.
- Ad-hoc prose notes that can silently go stale do **not** belong where an agent will treat them as truth.

## 3. Retrieval is a cascade, not a single method

SC Prism's decision is **full GraphRAG** — but graph traversal is the *last* stage, not the default. Most queries are answered more cheaply and precisely without it. The cascade:

```
1. grep + BM25            ── lexical recall; humans-understandable signals
        │   (BM25 leads on Recall@k / Precision@k for exact-match retrieval)
        ▼
2. dense vector rerank    ── precision pass over the BM25 candidate set
        │
        ▼
3. graph traversal        ── ONLY for multi-hop / relationship queries:
   1-hop candidate nodes → neighbour subgraph → rerank → LLM
```

**Routing rule:** simple fact in one doc → stop at BM25 (+reranker). Facts across 2–3 docs → hybrid + rerank + query transform. Reasoning across many docs with **relationships** → GraphRAG. Multi-step reasoning → agentic RAG. Start with the simplest stage that works; only escalate when retrieval metrics prove it's needed.

## 4. Agentic RAG + query reformulation

Before retrieval, a small fast model rewrites the raw intent into a query bound to the vault's structure (entity names, section conventions). This is the single cheapest precision win — it stops the retriever drowning in noise. Agentic RAG then lets the loop issue follow-up retrievals when the first pass is insufficient, rather than stuffing everything up front.

## 5. Caching (two kinds, both via Bifrost)

- **Semantic cache** (Bifrost built-in, locked decision — not GPTCache): near-duplicate prompts hit cache instead of the model. Big lever on the overnight loop where many tasks rephrase similar requests.
- **Prompt cache:** cache the stable prefix (system prompt, rule files, vault context) so repeated calls only pay for the delta.

Both are financial levers, not just speed: you cannot pass a 100k-token repo into every prompt and expect it to scale.

## 6. Memory-write validation (tie-in to Harness Layer 1)

Every vault commit triggers a dry-run validation against the rule files before it syncs to L3. Hallucinated or self-contradictory governance content is rejected at the door — because the vault is the source of truth, a bad write poisons every downstream retrieval and every future agent.

## 7. The GraphRAG build

- Construct the graph from the vault by entity/relationship extraction; re-index incrementally on vault change with TTL/timestamps for freshness.
- Keep candidate sets tractable (high-recall 1-hop traversal, then rerank) so it scales to a large enterprise vault.
- Dynamic graphs that update from agent interactions blur the line between RAG and memory — that's the direction of travel for 2026–27; design the index so memory and knowledge can converge later rather than fighting it.

## 8. Agentic RAG (the cascade is adaptive, not fixed)

The cascade in §3 must not run as a rigid pipeline. A small, fast **retrieval sub-agent** decides, per query, whether the current stage's results are sufficient and escalates only when they aren't — and decides when enough evidence has been gathered to stop. This is the real distinction from naive RAG: naive RAG runs a fixed linear pipeline; agentic RAG lets the agent adapt the workflow to the task, choose its strategy, and re-retrieve in a loop.

- Keep it a **sub-agent isolated from the main reasoning loop** — the main agent never sees the routing logic, only the assembled context.
- It earns its place on cost: stop early when context is sufficient (no escalation to graph), and never dump "just-in-case" documents.
- Worth the investment because retrieval — not generation — is the failure point the majority of the time. Fix retrieval and the system moves from "sometimes useful" to production-grade.

## 9. OKF conformance (v0.1)

SC Prism's vault targets the **Open Knowledge Format (OKF) v0.1**, the vendor-neutral spec Google Cloud published 2026-06-12. This is nearly free for SC Prism because the vault is already markdown — it's mostly adopting naming conventions — and it makes the knowledge portable to any OKF consumer.

- **Bundle = directory of markdown files**, one concept per file, the file path is the concept's identity.
- **YAML frontmatter:** required `type`; optional `title`, `description`, `resource`, `tags`, `timestamp`.
- **Cross-links** are plain markdown links; the directory becomes a graph.
- **Reserved files:** `index.md` (progressive disclosure as agents navigate) and `log.md` (chronological change history, ISO 8601).
- SC Prism is the **producer**; any OKF consumer (another agent, a viewer, a search index) can read the bundle without a custom integration.

**Boundaries:** OKF is the interchange *container*, not the knowledge *engine* — keep GraphRAG and the retrieval cascade as the richer layer on top. OKF standardises structure, not semantics, so SC Prism still owns its `type` vocabulary and field meanings. v0.1 is a draft and will evolve; conform, but keep SC Prism's own layer authoritative. Note `log.md` doubles as part of the Evidence Layer's change history (see `05`).

## 10. Acceptance criteria

- A single-doc factual query never triggers graph traversal (verifiable from spans).
- The vault can be deleted and fully rebuilt from markdown with no loss of governed state.
- A contradictory write is rejected before it reaches L3.
- Cache hit-rate is tracked per session and visible in the Console.
