# Web Research (design)

**Date:** 2026-07-23 · **Status:** approved (Sukhdeep picked it as the next build) · **Builds on:**
MCP v2b (the governed, bounded, telemetered tool-use loop) + its gates (ADR-009/035).

## Goal
Let the companion **look things up on the internet** mid-run — fetch a URL and run a search — with
real sources, under the SAME governance as MCP tools. Opt-in (no surprise egress). Reuses the v2b
tool-use loop end to end; adds two built-in tools, no new loop machinery.

## Key insight — web research IS a governed tool source
The v2b loop consumes any object that is duck-typed `list_tools()` + `call_tool(name, args)` +
`parent_span_id` (loop.py:238-245 — the MCPClient fits). So web research is **just another tool
source** with that shape. Every v2b guarantee is inherited for free:
- **Arg gate:** the sensitivity gate (gateway.SENSITIVE_KEYWORDS, raising `MCPBlockedError`) runs on
  the query/URL BEFORE any bytes egress — a secret can never be searched or sent.
- **Result gate:** fetched content passes the F1 cloud-withhold guard — sensitive fetched text is
  withheld before a cloud POST.
- **Telemetry:** every call is a `tool_exec` span (provider='web', tool, blocked/withheld), nested
  under dispatch, interleaved with model_call spans → the Manager View shows it (M1–M3) for free.
- **Bounded:** max_iters + token budget already cap the loop.

## Decisions (honest defaults — no user block needed)
- **Opt-in, default OFF.** A run uses web tools only with an explicit `--web` flag / Settings toggle.
  The product's ethos is careful egress; web research egresses by nature, so it is always explicit.
- **Two tools:** `web_fetch(url)` (deterministic, keyless — the backbone) and `web_search(query)`.
- **Search backend is pluggable:** a keyless default (DuckDuckGo Instant-Answer / lite HTML) that
  always works offline-of-keys, and an OPTIONAL configured API key (Settings) for better results.
  Keyless failure/rate-limit → an honest `isError` result the model sees, never a fabricated hit.
- **stdlib only** (`urllib.request`, `html.parser`) — no third-party deps (engine hard rule).
- **Real HTTP only; cite real sources.** Results carry the actual source URLs; the run stream shows
  each web tool call with its URL. Network error → honest error result, never invented content.

## Architecture — two layers + wiring

### Layer 1 — `engine/scprism_engine/webtools.py` (the governed provider)
- `web_fetch(url, *, timeout, max_bytes=200_000) -> dict` — GET (http/https only; block
  localhost/file/other schemes + private IPs = SSRF guard), cap bytes, strip HTML→text
  (html.parser), return `{"content":[{"type":"text","text":...}], "url":..., "title":...}` or
  `{"isError":True,...}` on failure. No network in tests → point at a local `http.server` fixture.
- `WebSearchBackend` — `search(query) -> list[{title,url,snippet}]`: a `KeylessBackend`
  (DuckDuckGo) + an `ApiKeyBackend` (configured key/endpoint). Backend chosen by config; parse is
  defensive (bad/empty response → []).
- `WebToolProvider` — the MCPClient-shaped adapter: `list_tools()` → the two `MCPTool`s
  (name/description/inputSchema), `call_tool(name, args)` → gate (reuse the MCP `_blocked_reason`
  logic / raise `MCPBlockedError`), emit a `tool_exec` span (provider='web', server='web',
  tool=name, blocked), dispatch to web_fetch/web_search, return the MCP-style result dict. Carries
  `parent_span_id` + `telemetry` exactly like MCPClient. SSRF + sensitivity gates BEFORE egress.

### Layer 2 — compose with MCP (so a run can have web AND MCP tools)
- `CompositeToolClient(sources)` (in webtools.py or a small helper): duck-typed `list_tools()`
  (concatenated, de-duped by name), `call_tool(name, args)` (routed to the owning source),
  `parent_span_id` setter fans out to all sources. loop.run's existing `mcp_client` param accepts
  ANY tool source (MCP, web, or composite) — minimal loop change (rename the concept to
  "tool source" in comments; behavior identical when it's a single MCPClient).

### Wiring — `loop.py`, `team.py`, `__main__.py`
- `run`/`team` gain `--web` (default off). When set, build a `WebToolProvider` (with the run's
  Telemetry) and pass it as the tool source; if `--mcp-server` is ALSO set, wrap both in a
  `CompositeToolClient`. Nothing changes when `--web` is absent (byte-identical).
- Search config: `--search-api-key`/`--search-endpoint` optional (or from env
  `SCPRISM_SEARCH_*`); absent → keyless backend.

### Client
- Settings: a "Web research" opt-in toggle (`settings.webResearch`, default false) + an optional
  search API key field (held by the bridge, never rendered — same discipline as providers). When on,
  app-launched runs pass `--web` (Rust bridge threads it).
- UI citations: the run stream already renders tool_exec (M1); ensure web `web_fetch`/`web_search`
  calls show the URL/source legibly, and a blocked/withheld web call reads as governance (reuse
  M2/M3). No new surface required beyond honest labels.

## Tests
- `web_fetch`: against a local `http.server` fixture — parses HTML→text, caps bytes, rejects
  non-http(s) + localhost/private-IP (SSRF), returns honest isError on 404/timeout.
- `WebSearchBackend`: keyless parse of a canned response → results; empty/bad → []; (no live net).
- `WebToolProvider`: the sensitivity gate blocks a secret-bearing query/url (MCPBlockedError +
  blocked tool_exec span, no egress); a normal call emits a truthful tool_exec span; result shape.
- Loop integration: a fake model asks to `web_fetch` a fixture URL → the loop executes it (real
  provider, real span), feeds the page text back, the model answers with the source. Mirrors the
  MCP integration test.
- Composite: MCP + web merged; call routed to the right source; name de-dupe.
- Byte-identical: no `--web` → the run is unchanged (existing v2b tests stay green).

## Honesty invariants
- No fabricated results — content is the real fetched page / real search response; a failure is an
  honest isError the model sees.
- A secret never reaches a query/URL (arg gate); sensitive fetched content never reaches a cloud
  model (result gate).
- Opt-in only; every web call is a real `tool_exec` span; citations are real source URLs.

## Out of scope (follow-ons)
- JS-rendered pages (headless browser) — stdlib fetch gets static HTML/text only.
- Crawling/multi-hop autonomous browsing beyond the bounded loop.
- A managed search subscription — keyless + optional-key covers v1.
