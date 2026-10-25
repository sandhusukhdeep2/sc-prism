"""Team runs — multiple agents, each on its OWN provider, coordinated by the
deterministic Orchestrator (ADR-007: a model NEVER orchestrates models).

Agent-to-agent communication is ORCHESTRATOR-MEDIATED: agents cannot call each
other. Each agent sees the shared board (messages relayed by this code), adds
one message per round, and the lead agent synthesizes at the end. Every agent
gets its own Gateway configured with its own primary — so the lead can run on
Claude while a researcher runs on the local model and a critic on Gemini.
Sensitivity routing still applies PER AGENT (a sensitive intent forces local
regardless of the agent's assigned provider).

The full board is persisted to ``<vault>/agents/board-<runid>.jsonl`` so the
conversation between agents is auditable evidence, not vapor.

TG-2: a team run is now GOVERNED exactly like a single task, reusing the same
standalone spine `loop.run` uses (`Telemetry`, the verifier, `finalize.py`'s
`run_tier2` + `finalize_run`, `EvidenceStore`) rather than reinventing it:

  * A real `TaskContract` is built (`mode="read"` — teams are READ-mode
    advisory; they never write project/vault files beyond the board and the
    governed verdict/spans/evidence/training).
  * The whole run is wrapped in a `run:<task_id>` span; every agent
    `model_call` + the lead's synthesis each get their own `model_call` span.
  * A token budget is enforced BEFORE every agent call and the synthesis —
    breaching it stops the run early (`over_budget=True`) and forces the
    Tier-2 envelope to fail (`passed=False`).
  * Tier-1 is a synthetic, always-passing, HONESTLY recorded advisory pass
    (there is no deterministic code gate for a team conversation) — never
    fail-closed.
  * Tier-2 runs for real (`finalize.run_tier2`) over a small trace adapter
    (`_TeamTrace`/`_TeamStep`) built from the board.
  * `finalize.finalize_run` builds + persists the Verdict and emits the GRPO
    training-record seam; `EvidenceStore.append_verdict` runs AFTER the run
    span has closed (mirroring `loop.run`'s exact post-span position),
    best-effort (an audit write must never break a team run).
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from .a2a import team_bundle
from .capabilities import skill_narrowing
from .companion import COMPANION_SYSTEM
from . import evals
from .context import CatalogEntry, disclose
from .contract import parse as parse_contract
from .dispatcher import ModelCall, ModelResult
from .evidence import EvidenceStore
from .finalize import finalize_run, run_tier2
from .gateway import Gateway, ModelCallResult
from .mcp import MCPError, MCPTool
from .telemetry import Telemetry
from .toolloop import run_tool_loop
from .verifier import Tier1Result


def _adopt_route_policy(gateways: List[Gateway], vault: str) -> None:
    """Adopt ``vault``'s promoted route-SELECTION policy (LF-2) on each gateway.

    Loads the vault's currently-adopted route policy ONCE and sets it on every
    per-agent gateway so a team/board run routes its default lane by the
    golden-gated policy, exactly like a single run does. A no-op when there is no
    vault in scope, no adopted policy (``load_current_route_policy`` → None), or a
    gateway predates ``set_route_policy`` — routing then stays on the built-in
    rules. Route selection only; never the model "learning". Never raises.
    """
    if not vault:
        return
    from .grpo import load_current_route_policy

    adopted = load_current_route_policy(vault)
    if adopted is None:
        return
    for gw in gateways:
        if hasattr(gw, "set_route_policy"):
            gw.set_route_policy(*adopted)


@dataclass
class AgentSpec:
    """One agent: a name, a role brief, and the provider it runs on."""

    name: str
    role: str
    primary: str  # 'local' | 'openai' | 'claude' | 'gemini' | '<x>-cli'


@dataclass
class RoleBoardResult:
    """The role board's output as an INJECTABLE doer (P1-1): one completion
    STRING (carrying ``===FILE:===`` blocks when the lead was instructed to
    emit them), the total tokens the board spent, the distinct
    ``provider · model`` labels that spoke (agents + the lead), and the path to
    the persisted board (audit trail). Deliberately NO governance/verdict — a
    later project step wraps this in `loop.run`'s finalize (one Verdict per
    step, no double spans/tokens/verdicts)."""

    completion: str
    tokens: int
    models_used: List[str] = field(default_factory=list)
    board_path: str = ""
    # The UNION of skill names disclosed across the board's per-agent prompts
    # (P3-1) — global skills (every agent) + each role's own skills, deduped in
    # first-seen order. Empty when no ``skill_catalog`` was threaded in. Flows
    # out through `team_model_adapter`'s ModelResult so the wrapping `loop.run`
    # can attribute honestly on `Verdict.disclosed`.
    disclosed: List[str] = field(default_factory=list)


@dataclass
class BoardMessage:
    sender: str
    provider: str
    model: str
    content: str
    is_real: bool
    round: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "from": self.sender,
            "provider": self.provider,
            "model": self.model,
            "content": self.content,
            "is_real": self.is_real,
            "round": self.round,
        }


@dataclass
class TeamResult:
    run_id: str
    board: List[BoardMessage] = field(default_factory=list)
    synthesis: str = ""
    board_path: str = ""
    tokens: int = 0
    # TG-2 governance fields — see the module docstring.
    passed: bool = False
    over_budget: bool = False
    token_budget: int = 0
    reason: str = ""
    task_id: str = ""
    spans_path: str = ""
    # Path to the persisted Verdict (<vault>/verdicts/<task_id>.json) — the
    # spec's verdict line names "a link to the saved Verdict"; empty until
    # `finalize_run` has actually written it.
    verdict_path: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "board": [m.to_dict() for m in self.board],
            "synthesis": self.synthesis,
            "board_path": self.board_path,
            "tokens": self.tokens,
            "passed": self.passed,
            "over_budget": self.over_budget,
            "token_budget": self.token_budget,
            "reason": self.reason,
            "task_id": self.task_id,
            "spans_path": self.spans_path,
            "verdict_path": self.verdict_path,
        }


def parse_agents(spec: str) -> List[AgentSpec]:
    """Parse ``name:provider,name:provider`` (roles derived from the name)."""
    ROLE_HINTS = {
        "lead": "Lead the task: set direction, then synthesize the team's final answer.",
        "researcher": "Research the task: gather the key facts, unknowns and options.",
        "critic": "Criticize the drafts: find flaws, risks and missing pieces. Be specific.",
        "implementer": "Draft the concrete work product the task asks for.",
    }
    agents: List[AgentSpec] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        name, _, provider = part.partition(":")
        name = name.strip() or "agent"
        provider = provider.strip() or "local"
        role = ROLE_HINTS.get(name, f"Act as the team's {name}.")
        agents.append(AgentSpec(name=name, role=role, primary=provider))
    return agents


def _board_text(board: List[BoardMessage]) -> str:
    if not board:
        return "(the board is empty — you are first)"
    return "\n\n".join(f"[{m.sender} · {m.provider}] {m.content}" for m in board)


def _agent_messages(
    spec: AgentSpec, intent: str, board: List[BoardMessage], skill_block: str = ""
) -> List[Dict[str, Any]]:
    system = (
        COMPANION_SYSTEM
        + f"\n\nYou are agent “{spec.name}” on a team. {spec.role}"
        + "\nYou communicate ONLY via the shared board relayed by the Orchestrator —"
        " address the team, be brief (under 150 words), and never pretend to run"
        " anything yourself."
    )
    user = (
        f"Task: {intent}\n\nShared board so far:\n{_board_text(board)}\n\n"
        f"Reply with your {spec.name} contribution."
    )
    # Role-scoped skills (P3-1): a non-empty block (this agent's disclosed
    # skills) is prepended to the user message. Empty ⇒ byte-identical to the
    # pre-P3-1 prompt (run_team never passes one).
    if skill_block:
        user = skill_block + "\n\n" + user
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _board_rounds(
    intent: str,
    agents: List[AgentSpec],
    gateways: Dict[str, Gateway],
    *,
    budget: int,
    rounds: int,
    call: Callable[[str, Any, Gateway, List[Dict[str, Any]]], Tuple[Any, Any]],
    skill_block_for: Optional[Callable[[AgentSpec], str]] = None,
) -> Tuple[List[BoardMessage], int, bool]:
    """The SHARED serial board loop (ADR-007: deterministic Python owns the
    rounds/roster/budget — a model NEVER orchestrates this).

    Each round, every agent reads the board so far and contributes ONE message,
    budget-gated BEFORE each call (a breach stops the run before the next call
    and sets ``over_budget``). ``call(spec_name, rnd, gateway, messages) ->
    (route, res)`` makes the actual model call and owns its own telemetry /
    models_used bookkeeping — the loop owns ONLY control flow + board assembly,
    so `run_team` (governed, span-wrapped) and `run_role_board` (bare doer)
    share ONE loop with different ``call``s. Returns (board, tokens,
    over_budget).

    ``skill_block_for`` (P3-1) is an optional ``spec -> skills-block`` hook: when
    given, each agent's prompt is prepended with ITS role-disclosed skills. When
    ``None`` (run_team, and the no-catalog role board) the prompt is byte-
    identical to before.
    """
    board: List[BoardMessage] = []
    tokens = 0
    over_budget = False
    for rnd in range(1, max(1, rounds) + 1):
        if over_budget:
            break
        for spec in agents:
            if tokens >= budget:
                over_budget = True
                break
            gw = gateways[spec.name]
            block = skill_block_for(spec) if skill_block_for is not None else ""
            messages = _agent_messages(spec, intent, board, skill_block=block)
            route, res = call(spec.name, rnd, gw, messages)
            tokens += res.tokens
            board.append(
                BoardMessage(
                    sender=spec.name,
                    provider=route.provider,
                    model=route.model,
                    content=res.text,
                    is_real=res.is_real,
                    round=rnd,
                )
            )
        if over_budget:
            break
    return board, tokens, over_budget


class _TeamStep:
    """A board-message-shaped step-result stand-in: `evals.observe_trace` /
    `heuristic_metrics` read `output`/`route`/`kind`/`index` via getattr, so
    this minimal shape is enough to score a team conversation non-opaquely."""

    def __init__(self, index: int, output: str, route: str, kind: str = "read"):
        self.index = index
        self.output = output
        self.route = route
        self.kind = kind


class _TeamTrace:
    """The Tier-2 adapter: a team run has no `DispatchResult`, so this exposes
    only the two attributes `evals.evaluate`/`observe_trace` actually read —
    `tokens_spent` (the real accumulated total, so the envelope check is real)
    and `step_results` (mapped from the board, one per contribution)."""

    def __init__(self, tokens_spent: int, step_results: List[_TeamStep]):
        self.tokens_spent = tokens_spent
        self.step_results = step_results


def budget_synthesis(board, spent: int, budget: int) -> str:
    """The manager's report when a run stopped at its token budget.

    Assembled DETERMINISTICALLY from the board, at zero token cost. The budget
    was breached precisely to stop spending, so calling a model to explain that
    would be absurd — and returning nothing wastes every token already spent.

    Found live 2026-09-03: a real three-agent board did genuine work (web
    research on Claude, ten tool turns on a local model), breached 100,000
    tokens, and reported an EMPTY synthesis. The user asked a question, three
    agents worked, and the answer was blank.

    Labelled for exactly what it is: partial work, never a finished answer.
    """
    head = (
        f"[stopped at the token budget — {spent:,} of {budget:,} spent. "
        f"This is the work the crew completed before it stopped, not a "
        f"finished answer. Raise the budget in Settings to let a run go "
        f"further.]"
    )
    if not board:
        return head + "\n\nNo agent finished a contribution before the budget ran out."

    def _field(m, name):
        # The board is dicts on the JSON path and dataclass rows in-process.
        # Read both rather than assuming one — this runs on a FAILING run, and
        # a crash here would replace a partial answer with no answer at all.
        if isinstance(m, dict):
            return m.get(name)
        return getattr(m, name, None)

    parts = [head, "", "What each seat contributed:"]
    for m in board:
        who = str(_field(m, "from") or _field(m, "agent") or "agent")
        provider = str(_field(m, "provider") or "?")
        content = str(_field(m, "content") or "").strip()
        parts.append("")
        parts.append(f"## {who} (on {provider})")
        parts.append(content if content else "(no contribution recorded)")
    return "\n".join(parts)


def run_team(
    intent: str,
    vault: str,
    agents: List[AgentSpec],
    rounds: int = 1,
    env: Optional[Dict[str, str]] = None,
    token_budget: int = 0,
    mode: str = "",
    model: Optional[Callable[[List[Dict[str, Any]], Any], Any]] = None,
    mcp_client: Optional[Any] = None,
    mcp_max_iters: Optional[int] = None,
    telemetry: Optional[Telemetry] = None,
) -> TeamResult:
    """Run a GOVERNED team: each round, every agent (its own Gateway/provider)
    reads the board and contributes once; the FIRST agent synthesizes at the
    end. Serial by design — writes are serial, and the relay is the audit
    trail. The whole run is wrapped in a `TaskContract` (read-mode advisory),
    a `run:<task_id>` telemetry span, a token budget enforced before every
    model call, a synthetic (honest) Tier-1 pass, a real Tier-2 judge, and a
    persisted Verdict + best-effort evidence/training records — reusing
    `finalize.py`'s exact spine (see the module docstring).

    `model`, when given, replaces the per-agent `gw.model_call` for every
    agent contribution AND the lead synthesis (test injection, exactly like
    `project.run_project`'s `model` parameter) — routing (`gw.route`) still
    runs for real per agent, so provider assignment/sensitivity stay honest;
    only the network call is swapped for a deterministic double.

    MCP tool-use (v2b, ADR-035): with an ``mcp_client`` (duck-typed:
    ``list_tools()`` + ``call_tool(name, args)`` — the governed ``MCPClient``
    fits), every agent contribution AND the lead synthesis run the bounded,
    gated tool-use loop (at most ``mcp_max_iters`` tool executions per turn —
    None/0 means the engine default, ``SCPRISM_TOOL_TURNS`` or
    ``toolloop.DEFAULT_MAX_ITERS``, clamped to ``toolloop.MAX_MAX_ITERS``)
    instead of one bare completion: the model requests a tool, the
    deterministic loop grants or denies it through the client's own
    allowlist + sensitivity gates, and each model turn / tool exec is a real
    span — a model still never steers this loop (ADR-007 holds). Default
    ``None`` is the unchanged one-span, one-call path per contribution.

    ``telemetry`` (F3): when the caller opened the ``mcp_client`` on a
    ``Telemetry``, it MUST pass that SAME instance here so the client's
    ``tool_exec`` spans and this run's spans share ONE ``run_id`` — a second
    internally-built ``Telemetry`` would give the tool spans a foreign
    ``run_id`` and conjure a phantom run in the dashboard. Default None keeps
    building one internally (back-compatible, single-path).
    """
    env_map = dict(os.environ if env is None else env)
    # Mode: teams default to the read frame; a CONVERSATIONAL team (a question
    # put to the board) is judged as a conversation — same third mode solo chat
    # earned (bc6c193). Live case this fixes: a genuinely good two-seat
    # discussion scored ~0.275 under the read frame and failed.
    contract = parse_contract(intent, mode=(mode or "read"))
    # `token_budget or contract.token_budget` would treat a NEGATIVE budget as
    # truthy and use it as-is (e.g. -5 flows straight through), so the very
    # first `result.tokens (0) >= budget` check fires `over_budget=True` at
    # zero spend — an invariant hole, since the forced-breach envelope
    # (`Envelope(token_budget=0)`) then does NOT actually breach at 0 spent
    # (`0 > 0` is False), silently dropping pass/fail to the judge alone. Only
    # a STRICTLY POSITIVE budget overrides the contract default; 0 and every
    # negative value fall back to it, exactly like the CLI's documented "0 ->
    # default" semantics.
    budget = token_budget if token_budget > 0 else contract.token_budget

    # The contract MUST carry this run's REAL configuration before any
    # envelope/finalize use — otherwise `evals.build_envelope(contract)` and
    # the training record read the parse-time DEFAULTS (token_budget=100_000,
    # max_turns=8), decoupled from the budget/step count the loop actually
    # enforces. That silently FAILS a legitimate run (e.g. a 1M-budget run
    # spending 300k breaches the phantom 100k cap; a 3-round×3-agent run's 9
    # board steps breach the phantom 8-turn cap) and corrupts the reward's
    # envelope_efficiency term. TaskContract is a plain (non-frozen) dataclass,
    # so both fields are writable. One board contribution per agent per round
    # + 1 for the lead synthesis; floored at the contract default so a small
    # team never gets a tighter step cap than a single task would.
    contract.token_budget = budget
    contract.max_turns = max(max(1, rounds) * len(agents) + 1, contract.max_turns)

    result = TeamResult(run_id=contract.task_id, task_id=contract.task_id)

    gateways: Dict[str, Gateway] = {}
    for spec in agents:
        agent_env = dict(env_map)
        agent_env["SCPRISM_PRIMARY"] = spec.primary
        gateways[spec.name] = Gateway(env=agent_env)
    lead_gw = gateways[agents[0].name] if agents else Gateway(env=env_map)
    # LF-2: this run's vault is in scope (the `vault` arg) — adopt its promoted
    # route policy on every per-agent gateway so a team run routes its default
    # lane by the golden-gated policy too. No adopted policy → no-op.
    _adopt_route_policy([*gateways.values(), lead_gw], vault)

    # MCP tool-use (v2b): list the advertised tools ONCE for the whole run. An
    # unreachable/broken server must not kill the run — with no tools every
    # turn degrades to today's single completion (no manifest, one call), and
    # the client's own handshake/tool_exec spans already recorded the truth.
    mcp_tools: List[MCPTool] = []
    if mcp_client is not None:
        try:
            mcp_tools = mcp_client.list_tools()
        except MCPError:
            mcp_tools = []

    spans_path = os.path.join(vault, "spans.jsonl")
    # F3: reuse the caller's Telemetry when given (so the mcp_client's tool_exec
    # spans and this run's spans share ONE run_id — no phantom run); otherwise
    # build one, exactly as before.
    if telemetry is None:
        telemetry = Telemetry(spans_path)

    hooks_fired: List[str] = ["team"]
    model_routes: List[str] = []
    models_used: List[str] = []
    over_budget = False

    with telemetry.span(
        f"run:{contract.task_id}",
        span_type="run",
        task_id=contract.task_id,
        intent=contract.intent,
        mode=contract.mode,
    ) as run_span:
        run_span_id = run_span.span_id
        # F4: parent the client's tool_exec spans under THIS run span so they
        # nest with the per-turn model_call spans instead of dangling at
        # parent=null.
        if mcp_client is not None:
            mcp_client.parent_span_id = run_span_id

        # The VAULT EGRESS FLOOR for this team run — the SAME object the
        # orchestrator loop uses, so the rule the product's promise rests on has
        # one implementation and cannot drift between the two tool-loop paths. A
        # team run is offered the vault tools exactly like a solo run, so a
        # cloud-routed agent that reads a note must flip the run local (or
        # withhold) here too. Inert until a vault tool really returns content.
        # Deferred import, like the module's other loop imports (loop.py is the
        # heavier module and this file is imported from the CLI's fast path).
        # `lead_gw` supplies the run-level seams (a local route to fall back to,
        # and the user's own sensitive words) — the same gateway this run already
        # verdicts and judges through; the local endpoint and SCPRISM_SENSITIVE
        # are user-level, identical across the per-agent gateways.
        from .loop import VaultEgressFloor, _emit_withheld_spans

        floor = VaultEgressFloor(lead_gw, mcp_client, models_used)

        def _call_model(spec_name: str, rnd: Any, agent_gw: Gateway, messages):
            route = agent_gw.route(intent)  # sensitivity may force local per agent
            call = model or agent_gw.model_call
            # Per-agent capabilities (2026-08-15): name whose turn it is BEFORE
            # any tool is listed or called. One shared tool source, N grants —
            # without this the board would enforce whichever agent went last.
            set_agent = getattr(mcp_client, "set_agent", None)
            turn_tools = mcp_tools
            if callable(set_agent):
                set_agent(spec_name)
                # AFTER set_agent, never before: set_agent clears the previous
                # turn's narrowing unconditionally, so installing first would
                # be wiped. The lead's synthesis turn reuses the same agent
                # name and discloses no skills, which is exactly the leak that
                # unconditional reset prevents.
                install = getattr(mcp_client, "set_skill_narrowing", None)
                if callable(install):
                    caps, decls = skill_narrowing_for.get(spec_name, (None, ()))
                    install(caps, decls)
                # Re-list under THIS agent's grant: the run-level listing above
                # happened before anyone was named, so it cannot be what this
                # agent is shown. An agent granted nothing sees no manifest and
                # degrades to the plain one-completion path — honestly.
                try:
                    turn_tools = mcp_client.list_tools()
                except MCPError:
                    turn_tools = []

            def _one(msgs):
                # ONE completion, ONE span — with MCP tools this runs once per
                # model TURN, so the trace shows each turn interleaved with the
                # client's tool_exec spans; without tools it runs exactly once
                # (the unchanged pre-v2b shape). The route is read PER TURN, so a
                # turn the vault floor forced local is spanned as local.
                turn = floor.route(route)
                with telemetry.span(
                    "model_call",
                    span_type="model_call",
                    parent=run_span_id,
                    provider=turn.provider,
                    model=turn.model,
                    route=turn.target,
                    is_local=turn.is_local,
                    reason=turn.reason,
                    agent=spec_name,
                    round=rnd,
                ) as sp:
                    r = call(msgs, turn)
                    sp.set(
                        tokens_in=getattr(r, "tokens_in", 0),
                        tokens_out=getattr(r, "tokens_out", 0),
                        cache=getattr(r, "cache", "miss"),
                        is_real=r.is_real,
                    )
                return r

            if not turn_tools:
                res = _one(messages)
            else:
                # MCP tool-use (v2b): the bounded, gated loop. F1: on a CLOUD
                # route, gate every tool RESULT before it egresses back to the
                # cloud model — a secret must never reach the next POST; a LOCAL
                # route is zero-egress, so the floor returns no guard. F7: cap
                # the loop by this run's token budget. F8: tl.cache is honest —
                # the tool-less degrade path (one call, zero tools) carries the
                # real cache, a genuine multi-turn loop stays "miss".
                tl = run_tool_loop(
                    messages=messages,
                    tools=turn_tools,
                    model_fn=_one,
                    tool_exec=floor.exec_tool,
                    max_iters=mcp_max_iters,
                    guard_observation=floor.guard(route),
                    token_budget=budget if budget > 0 else None,
                )
                # M3: surface each F1 result-withhold as its own governance span
                # (the tool CALL already spanned; this is the separate "result
                # withheld from cloud" win the Manager View shows honestly).
                _emit_withheld_spans(
                    telemetry, run_span_id, mcp_client, tl.tool_calls
                )
                # The route this agent ENDED on: `route`, unless the vault floor
                # flipped it — then the board must report local, not the lane the
                # agent merely started in.
                route = floor.route(route)
                res = ModelCallResult(
                    text=tl.text,
                    tokens_in=tl.tokens_in,
                    tokens_out=tl.tokens_out,
                    cache=tl.cache,
                    provider=route.provider,
                    model=route.model,
                    is_real=tl.is_real,
                )
            model_routes.append(route.provider)
            label = f"{route.provider} · {route.model}"
            if label not in models_used:
                models_used.append(label)
            return route, res

        t0 = time.time()

        # The serial board loop, SHARED with run_role_board (ADR-007: Python
        # owns rounds/roster/budget). `_call_model` carries the per-call
        # telemetry span + models_used/model_routes bookkeeping this governed
        # path needs; the loop mechanics (rounds, budget gating, board order,
        # token accounting) are byte-identical to the inline version this
        # replaced — result.board/result.tokens are 0/empty here, so seeding
        # the loop from scratch is equivalent.
        result.board, result.tokens, over_budget = _board_rounds(
            intent, agents, gateways, budget=budget, rounds=rounds, call=_call_model,
        )

        # Lead synthesis (first agent) over the finished board — gated by the
        # SAME budget check, before the call is made.
        if agents and not over_budget:
            if result.tokens >= budget:
                # The board finished inside the budget but the synthesis call
                # would breach it. Same outcome as a mid-board breach, so take
                # the same honest exit rather than falling through to nothing.
                over_budget = True
                result.synthesis = budget_synthesis(
                    result.board, result.tokens, budget
                )
            else:
                lead = agents[0]
                messages = [
                    {"role": "system", "content": COMPANION_SYSTEM},
                    {
                        "role": "user",
                        "content": (
                            f"Task: {intent}\n\nTeam board:\n{_board_text(result.board)}\n\n"
                            "Synthesize the team's final answer in under 200 words."
                        ),
                    },
                ]
                route, res = _call_model(lead.name, "synthesis", lead_gw, messages)
                result.tokens += res.tokens
                result.synthesis = res.text

        elif agents:
            # BREACHED. The board is right there in memory; refusing to
            # summarise it is the one outcome that wastes everything already
            # spent. Deterministic, zero-token, and labelled as partial work.
            result.synthesis = budget_synthesis(
                result.board, result.tokens, budget
            )
        latency_ms = (time.time() - t0) * 1000.0

        # Persist the board — agent-to-agent traffic is auditable evidence.
        # Unchanged mechanics: one atomic overwrite per run, keyed on the
        # contract's task_id (was a random uuid before TG-2).
        agents_dir = os.path.join(vault, "agents")
        os.makedirs(agents_dir, exist_ok=True)
        path = os.path.join(agents_dir, f"board-{result.run_id}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for m in result.board:
                f.write(json.dumps(m.to_dict(), ensure_ascii=False) + "\n")
            f.write(
                json.dumps({"synthesis": result.synthesis, "tokens": result.tokens})
                + "\n"
            )
        result.board_path = path

        # A2A seam (ADR-015): the same run as one portable A2A v1.0 document
        # (agent cards + task + messages + synthesis artifact) next to the board.
        a2a_path = os.path.join(agents_dir, f"board-{result.run_id}.a2a.json")
        with open(a2a_path, "w", encoding="utf-8") as f:
            json.dump(
                team_bundle(result, agents, intent), f, ensure_ascii=False, indent=1
            )

        # Tier-1 — a team conversation has no deterministic code gate. This is
        # a SYNTHETIC, always-passing pass, recorded HONESTLY (advisory, never
        # fail-closed) — not a real check.
        t1 = Tier1Result(
            passed=True,
            commands=[],
            tokens=0,
            skipped=True,
            skip_reason=(
                "skipped — a team conversation has no codebase to check, so the "
                "deterministic gate had nothing to run. Nothing was verified: "
                "this is not a pass."
            ),
        )

        # Tier-2 adapter: map the board into step-shaped results so the judge
        # scores real (non-opaque) content; `tokens_spent` is the real total
        # so the envelope check is real, not a formality.
        team_steps = [
            _TeamStep(
                index=i,
                output=m.content,
                route="local" if m.provider == "local" else "cloud",
                kind="read",
            )
            for i, m in enumerate(result.board)
        ]
        team_trace = _TeamTrace(tokens_spent=result.tokens, step_results=team_steps)

        if over_budget:
            # Force the Tier-2 envelope breach: an already-exceeded cap, so
            # `evals.evaluate` fails Tier-2 (and the Verdict) regardless of
            # the eval score — the runaway-but-plausible-looking case.
            envelope = evals.Envelope(token_budget=0, max_steps=None, latency_ms=None)
        else:
            envelope = evals.build_envelope(contract, latency_ms=latency_ms)

        t2 = run_tier2(
            contract,
            team_trace,
            tier1_passed=t1.passed,
            gateway=lead_gw,
            telemetry=telemetry,
            parent_id=run_span_id,
            envelope=envelope,
            threshold=evals.DEFAULT_THRESHOLD,
            latency_ms=latency_ms,
            hooks_fired=hooks_fired,
            # Same evidence discipline as loop.run. A team conversation writes
            # NO project files and its Tier-1 is the synthetic skip above, so
            # this block tells the judge exactly that — "no files, and the gate
            # was skipped, so nothing was verified" — instead of leaving it to
            # infer either fact from a trace. An honest empty is still evidence.
            run_evidence=evals.build_evidence(tier1_result=t1, files_written=[]),
        )

        verdict = finalize_run(
            contract=contract,
            tier1_result=t1,
            tier2_result=t2,
            vault=vault,
            telemetry=telemetry,
            run_id=run_span_id,
            spans_path=spans_path,
            tokens_spent=result.tokens,
            model_route=model_routes,
            models_used=models_used,
            response=result.synthesis,
            artifacts=[result.board_path],
            steps=result.board,
            stop_compliant=not over_budget,
            record_training=True,
            hooks_fired=hooks_fired,
        )

        run_span.set(
            passed=verdict.passed,
            tokens=verdict.tokens_spent,
            over_budget=over_budget,
            spans_path=spans_path,
        )

    # Evidence append — AFTER the run span has closed/flushed (mirrors
    # loop.run's exact post-span position), best-effort: an audit write must
    # never break a team run.
    try:
        EvidenceStore(vault).append_verdict(
            verdict,
            agent_id="team",
            role="team",
            intent=contract.intent,
            diff={"writes": [], "scope": list(contract.scope)},
        )
    except Exception:
        pass

    result.passed = verdict.passed
    result.over_budget = over_budget
    result.token_budget = budget
    result.spans_path = spans_path
    # `finalize_run` appends the just-written verdict path as the LAST
    # artifact (after `write_verdict(verdict, vault)`); read it back rather
    # than re-deriving `<vault>/verdicts/<task_id>.json` so this can never
    # drift from what actually got written to disk.
    result.verdict_path = verdict.artifacts[-1] if verdict.artifacts else ""
    if over_budget:
        result.reason = f"over budget: spent {result.tokens} tokens >= budget {budget}"
    elif t2 is not None:
        result.reason = t2.judge_notes or t2.rationale
    else:
        # Unreachable by construction: `run_tier2` only returns None when
        # Tier-1 FAILED, but a team run's Tier-1 is a synthetic always-pass
        # (see `t1` above), so `t2` is never None on this branch. Kept as a
        # defensive, honest fallback rather than an assert.
        result.reason = "tier1 failed"

    return result


def _persist_board(
    env_map: Dict[str, str],
    board: List[BoardMessage],
    completion: str,
    tokens: int,
) -> str:
    """Persist the role board (auditable evidence, not vapor) and return its
    path. Lands in ``<SCPRISM_VAULT>/agents/`` when the env names a vault (so a
    project step can point boards at its own vault), else a fresh temp dir —
    self-contained for tests / callers that pass no vault."""
    vault = (env_map.get("SCPRISM_VAULT") or "").strip()
    agents_dir = os.path.join(vault, "agents") if vault else tempfile.mkdtemp(
        prefix="scprism-board-"
    )
    os.makedirs(agents_dir, exist_ok=True)
    run_id = uuid.uuid4().hex[:12]
    path = os.path.join(agents_dir, f"board-{run_id}.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        for m in board:
            f.write(json.dumps(m.to_dict(), ensure_ascii=False) + "\n")
        f.write(json.dumps({"completion": completion, "tokens": tokens}) + "\n")
    return path


def run_role_board(
    prompt: str,
    route: str,
    agents: List[AgentSpec],
    *,
    env: Dict[str, str],
    token_budget: int = 0,
    file_block_instructions: str = "",
    skill_catalog: Optional[List[CatalogEntry]] = None,
    telemetry: Optional[Telemetry] = None,
    parent_span_id: Optional[str] = None,
    # The PHASE this board is working — a project's plan step, in the user's
    # own words. It replaces the bare round number as the span's `round`, which
    # is what the crew board groups its columns by: without it a four-step plan
    # draws four columns all called "Round 1". Empty keeps the round number,
    # byte-identical to before.
    stage: str = "",
) -> RoleBoardResult:
    """Run the per-agent role board as an INJECTABLE doer and return ONE
    completion STRING (P1-1).

    Same serial board `run_team` runs — each ``AgentSpec`` gets its OWN Gateway
    via ``SCPRISM_PRIMARY=spec.primary`` (so the lead can be Claude, the planner
    Gemini, the developer local; sensitivity routing still force-locals per
    agent), ONE round, then the FIRST agent (the lead/implementer) synthesizes
    over the finished board. The synthesis prompt APPENDS
    ``file_block_instructions`` (project.py's ``===FILE:===`` format) so
    ``completion`` carries FILE blocks a later project step can write — and,
    unlike `run_team`'s ~200-word ADVISORY synthesis, it is NOT capped: the lead
    emits the full work product.

    Budget is enforced BEFORE each agent call (a breach stops the board before
    the next call). On breach the lead STILL synthesizes over the partial board
    (honest) rather than raising — a project step must always get a completion
    back; the wrapping `loop.run` then fails the step via its OWN budget
    machinery. No governance/verdict happens here (one Verdict per step lives in
    `loop.run`, never doubled). ``route`` mirrors the `ModelCall` signature and
    is echoed by `team_model_adapter`; the per-agent Gateway stays authoritative
    for real routing (exactly like `loop._gateway_model`'s ignored route hint).

    ``skill_catalog`` (P3-1): when given, each board agent's prompt is prepended
    with the skills disclosed for THAT agent's role — global skills reach every
    agent, a role-tagged skill reaches only its role. The role identifier is the
    agent's ``name`` (``planner`` / ``developer`` / ``lead`` — what a skill's
    ``roles:`` frontmatter names), NOT ``AgentSpec.role`` (a descriptive brief
    sentence). ``None`` (the default, and every pre-P3-1 caller) is a strict
    no-op: prompts stay byte-identical and the board is unaffected. The lead's
    final SYNTHESIS prompt is left unscoped (it is the whole-team work product,
    not a single role's turn).

    ``telemetry`` / ``parent_span_id`` (MV1 — Manager View data foundation):
    when a ``Telemetry`` is offered, each agent turn AND the lead synthesis emit
    ONE ``model_call`` span (agent · model · route · tokens · pass/fail),
    parented to ``parent_span_id`` — mirroring `run_team`'s per-agent spans
    (`_call_model`) EXACTLY so the Console reads the standalone and role-board
    paths uniformly. This only READS execution truth into spans; it never
    changes routing, budget, board order, synthesis, persistence or the returned
    `RoleBoardResult` (ADR-007). ``None`` (the default, and every pre-MV1 caller
    — the loop offers it via `_RoleBoardDoer.set_telemetry`) is a strict no-op:
    ZERO spans, byte-identical to the pre-telemetry board.
    """
    env_map = dict(env)
    # Only a STRICTLY POSITIVE budget caps the board; 0 / absent / negative ->
    # NO cap here (the wrapping `loop.run` enforces the real per-step budget).
    # A large sentinel keeps the shared `tokens >= budget` gate a plain compare.
    budget = token_budget if token_budget > 0 else (1 << 62)

    gateways: Dict[str, Gateway] = {}
    for spec in agents:
        agent_env = dict(env_map)
        agent_env["SCPRISM_PRIMARY"] = spec.primary
        gateways[spec.name] = Gateway(env=agent_env)
    lead_gw = gateways[agents[0].name] if agents else Gateway(env=env_map)
    # LF-2: the role board takes no `vault` arg, but (like `_persist_board`) it
    # gets the run's vault from SCPRISM_VAULT — adopt its promoted route policy on
    # every per-agent gateway when that env names one. Absent it → no-op (a bare
    # test board with no vault stays on the built-in rules).
    _adopt_route_policy(
        [*gateways.values(), lead_gw], (env_map.get("SCPRISM_VAULT") or "").strip()
    )

    models_used: List[str] = []

    def _call(spec_name: str, rnd: Any, agent_gw: Gateway, messages):
        rt = agent_gw.route(prompt)  # per-agent routing; sensitivity force-locals
        # MV1: when telemetry is offered, wrap the call in a per-agent
        # `model_call` span (same shape run_team emits, team.py `_call_model`) so
        # the Console can show which model did what, live. Without it the body is
        # BYTE-IDENTICAL to the pre-telemetry board (ADR-007: reads truth into a
        # span, never changes the call).
        if telemetry is not None:
            with telemetry.span(
                "model_call",
                span_type="model_call",
                parent=parent_span_id,
                provider=rt.provider,
                model=rt.model,
                route=rt.target,
                is_local=rt.is_local,
                reason=rt.reason,
                agent=spec_name,
                # The plan step when the caller named one; otherwise the round.
                round=stage or rnd,
            ) as sp:
                res = agent_gw.model_call(messages, rt)
                sp.set(
                    tokens_in=getattr(res, "tokens_in", 0),
                    tokens_out=getattr(res, "tokens_out", 0),
                    cache=getattr(res, "cache", "miss"),
                    is_real=res.is_real,
                )
        else:
            res = agent_gw.model_call(messages, rt)
        label = f"{rt.provider} · {rt.model}"
        if label not in models_used:
            models_used.append(label)
        return rt, res

    # Per-agent role scoping (P3-1): disclose skills for each agent's ROLE
    # (spec.name) and inject them into that agent's board prompt via the SAME
    # skills-block builder the single-doer loop uses (`loop._build_skill_context`
    # — bounds/ranking stay consistent). `_build_skill_context` lives in the
    # heavy `loop` module, so it is imported lazily and only when a catalog is
    # actually threaded through (no cost, no import cycle, for every other
    # caller). No catalog ⇒ hook stays None ⇒ prompts byte-identical.
    disclosed_union: List[str] = []
    #: agent name -> (narrowing, declarations), filled by skill_block_for.
    skill_narrowing_for: dict = {}
    skill_block_for = None
    if skill_catalog:
        from .loop import _build_skill_context

        def skill_block_for(spec: AgentSpec) -> str:  # noqa: F811
            disclosed = disclose(prompt, skill_catalog, role=spec.name)
            block, names = _build_skill_context(disclosed)
            # Accumulate the honest union (only what actually landed in a block,
            # after `_build_skill_context`'s cap), deduped in first-seen order.
            for n in names:
                if n not in disclosed_union:
                    disclosed_union.append(n)
            # The narrowing must come from the skills that LANDED, not the ones
            # that merely matched: a skill dropped by the disclosure cap never
            # reached the model and must not decide the grant. Recorded here and
            # applied in `_call_model` AFTER set_agent, which resets it.
            landed = [d for d in disclosed if d.name in set(names)]
            skill_narrowing_for[spec.name] = (
                skill_narrowing([d.allowed_tools for d in landed]),
                tuple((d.name, d.allowed_tools_raw) for d in landed if d.allowed_tools_raw),
            )
            return block

    board, tokens, _over_budget = _board_rounds(
        prompt, agents, gateways, budget=budget, rounds=1, call=_call,
        skill_block_for=skill_block_for,
    )

    # Lead/implementer synthesis over the (possibly partial) board — ALWAYS run
    # so a completion is returned even after a budget breach (don't raise). No
    # word cap; append the FILE-block instructions so `completion` can carry
    # ===FILE:=== blocks.
    completion = ""
    if agents:
        lead = agents[0]
        user = (
            f"Task: {prompt}\n\nTeam board:\n{_board_text(board)}\n\n"
            "Synthesize the team's final answer as the complete work product."
        )
        if file_block_instructions:
            user += "\n\n" + file_block_instructions
        messages = [
            {"role": "system", "content": COMPANION_SYSTEM},
            {"role": "user", "content": user},
        ]
        _rt, res = _call(lead.name, "synthesis", lead_gw, messages)
        tokens += res.tokens
        completion = res.text

    board_path = _persist_board(env_map, board, completion, tokens)
    return RoleBoardResult(
        completion=completion,
        tokens=tokens,
        models_used=models_used,
        board_path=board_path,
        disclosed=disclosed_union,
    )


class _RoleBoardDoer:
    """The role board as an injectable `dispatcher.ModelCall` doer (``(prompt,
    route) -> ModelResult``).

    A tiny callable object instead of a bare closure so `loop.run` can hand it
    telemetry AFTER the loop's own `Telemetry` + dispatch span exist: it offers
    them via ``set_telemetry()`` and the board then emits per-agent `model_call`
    spans parented to the step's dispatch span (MV1 — Manager View data
    foundation). Without that offer the board runs silently — BYTE-IDENTICAL to
    the pre-telemetry closure adapter (telemetry stays ``None`` -> `run_role_board`
    emits zero spans, same `ModelResult`)."""

    def __init__(
        self,
        agents: List[AgentSpec],
        *,
        env: Dict[str, str],
        token_budget: int,
        file_block_instructions: str,
        skill_catalog: Optional[List[CatalogEntry]],
        stage: str = "",
    ) -> None:
        self.agents = agents
        self.env = env
        self.token_budget = token_budget
        self.file_block_instructions = file_block_instructions
        self.skill_catalog = skill_catalog
        self.stage = stage
        self._telemetry: Optional[Telemetry] = None
        self._parent: Optional[str] = None

    def set_telemetry(
        self, telemetry: Optional[Telemetry], parent_span_id: Optional[str]
    ) -> None:
        """`loop.run`'s offer: route the board's per-agent spans into this step's
        trace under ``parent_span_id``. Purely additive — never changes the
        completion or Verdict (ADR-007)."""
        self._telemetry = telemetry
        self._parent = parent_span_id

    def __call__(self, prompt: str, route: str) -> ModelResult:
        result = run_role_board(
            prompt,
            route,
            self.agents,
            env=self.env,
            token_budget=self.token_budget,
            file_block_instructions=self.file_block_instructions,
            skill_catalog=self.skill_catalog,
            telemetry=self._telemetry,
            parent_span_id=self._parent,
            stage=self.stage,
        )
        return ModelResult(
            text=result.completion,
            tokens=result.tokens,
            route=route,
            models_used=result.models_used,
            # Per-agent disclosed skills ride out for honest attribution (None
            # when the board disclosed nothing -> the merge is a no-op).
            disclosed=result.disclosed or None,
        )


def team_model_adapter(
    agents: List[AgentSpec],
    *,
    env: Dict[str, str],
    token_budget: int = 0,
    file_block_instructions: str = "",
    skill_catalog: Optional[List[CatalogEntry]] = None,
    stage: str = "",
) -> ModelCall:
    """Wrap `run_role_board` as a `dispatcher.ModelCall` (``(prompt, route) ->
    ModelResult``) so a project step can drop the role board in as its per-step
    "doer" (P1-2 consumes this). The board's completion becomes
    ``ModelResult.text`` (carrying the FILE blocks), its token total
    ``ModelResult.tokens``, and the step's ``route`` is echoed straight back.

    The board's distinct ``provider · model`` labels ride out on
    ``ModelResult.models_used`` so the wrapping `loop.run`'s finalize records the
    BOARD's models on the step Verdict (>1) — not this adapter's single echoed
    route. `dispatch`/`loop.run` merge that field only when it is non-None, so a
    plain single-model doer stays byte-identical.

    ``skill_catalog`` (P3-1): forwarded straight through to `run_role_board` for
    per-agent role disclosure. Default ``None`` is a no-op, so every current
    caller is byte-identical. NOTE (seam left open on purpose): `run_project`
    does NOT yet pass its catalog here — `loop.run` already discloses that same
    catalog GLOBALLY (role="") into the doer's prompt, so passing it here too
    would double-inject the global skills. Threading it end-to-end wants
    per-agent disclosure to REPLACE the loop-level global block for the
    role-board doer, which is a separate change; this param is the ready seam
    for it.

    Returns a telemetry-aware `_RoleBoardDoer` (MV1): `loop.run` offers it
    telemetry via ``set_telemetry`` so the board emits per-agent `model_call`
    spans in the step's trace. Its behavior when telemetry is never offered is
    byte-identical to the old closure."""
    return _RoleBoardDoer(
        agents,
        env=env,
        token_budget=token_budget,
        file_block_instructions=file_block_instructions,
        skill_catalog=skill_catalog,
        stage=stage,
    )
