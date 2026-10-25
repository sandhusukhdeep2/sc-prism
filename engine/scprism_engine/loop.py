"""Orchestrator loop — the deterministic heart of SC Prism.

`run` drives ONE task end to end: contract -> plan -> dispatch -> verify
(Tier-1 then Tier-2, short-circuiting) -> writeback. A model never steers this
loop; it is straight-line deterministic Python (ADR-007).

Every model call goes through the Gateway (ADR-002/026); every step emits a
typed OTel-style span (ADR-012) so the whole run is reconstructable from
`<vault>/spans.jsonl`. Reads may parallelize inside dispatch; writes are
strictly serial. Tier-1 is deterministic and zero-token; a Tier-1 failure
short-circuits — the Tier-2 model judge is never called.
"""

from __future__ import annotations

import os
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple, TYPE_CHECKING

from .contract import TaskContract, parse
from .planner import plan
from . import conductor
from .dispatcher import dispatch, ModelCall, ModelResult
from .verifier import tier1, tier2, CommandResult, Tier1Result, Tier2Result
from .writeback import Verdict
from .gateway import Gateway, guard_cloud_tool_result
from .companion import companion_messages
from .bifrost_client import make_gateway
from .telemetry import Telemetry
from . import evals
from .evals import Envelope
from .permissions import PermissionEngine, AccessContext, WRITE, READ
from .hooks import HookEngine, ToolRequest, Approval, HookDecision
from .memory import (
    MemoryStore,
    MemoryItem,
    VaultWrite,
    RuleSet,
    select_context,
    injected_tokens,
    L3,
)
from .context import (
    CatalogEntry,
    DisclosedSkill,
    VaultStructure,
    disclose,
    reformulate,
)
from .agentic_retrieval import RetrievalAgent
from .writeback import persist_vault_write
from .evidence import EvidenceStore
from .training import RewardWeights
from .finalize import finalize_run, run_tier2
from .mcp import MCPError
from .toolloop import run_tool_loop

if TYPE_CHECKING:  # avoid a cycle: ci_gate -> goldens -> loop
    from .ci_gate import CIGate


# A Tier-2 judge scores the dispatch trace and returns a Tier2Result. It is the
# only model-backed step in verification, so Tier-1 gates it (specs/02 §2).
Judge = Callable[[object], Tier2Result]


# --- Progressive-disclosure injection (roadmap #5, Task S2) -----------------
# Disclosure was decorative: `disclose()` recorded which skills matched but
# their instruction bodies were discarded. These make it real — the matched
# skills' full instructions are prepended to every dispatch prompt so the model
# actually follows them. Bounds keep a fat skill body from blowing up the
# prompt (or the run cost): only the top few most-specific matches survive, and
# the whole block is hard-capped in characters. This cap is SEPARATE from — and
# is never counted against — the memory-injection token budget.
SKILLS_BLOCK_HEADER = "Relevant saved skills — follow the matching procedure:"
MAX_DISCLOSED_SKILLS = 3
MAX_SKILLS_BLOCK_CHARS = 4000


# --- Vault egress floor (2026-08-05 audit) ----------------------------------
# The product's promise is "your private work stays on your machine". The vault
# tool source hands the model the user's OWN notes, and the only thing standing
# between those notes and a cloud POST was ``guard_cloud_tool_result`` — an
# 18-word keyword denylist. An adversarial audit walked realistic private notes
# (a diagnosis + dosage, mortgage figures, salaries by name, settlement terms, a
# home address, a live API key) straight past it onto a cloud request. A
# denylist cannot read prose, so it is the wrong shape of defence here.
#
# The rule that IS the right shape is categorical, not lexical: **reading the
# vault forces the rest of the run local.** Once a vault tool returns content,
# every remaining model turn of that run routes LOCAL — recorded honestly in the
# route reason, so the model chip, the run stream and the Console all say what
# really happened rather than showing the original cloud pick.
VAULT_LOCAL_REASON = "vault content read -> kept local (no egress)"

# When there is no local model to route to, the content is NOT quietly sent to
# the cloud instead: it is withheld, and the model is told so honestly (it knows
# the note exists and that it could not be shown, rather than seeing a silent
# empty result it might paper over).
_WITHHELD_VAULT_RESULT = (
    "[withheld: this is your vault content and this run is on a cloud model "
    "with no local model configured to read it — the content exists but was "
    "not sent]"
)


def _is_vault_content(mcp_client: Any, tool: str, result: Any) -> bool:
    """True when ``tool`` was served by the VAULT source and really returned
    content.

    All four vault tools are content-bearing: a listing is the user's filenames,
    a search is their note excerpts, a status is their project names — none of
    that belongs on a cloud POST any more than a note body does. The only
    exclusions are results that carry no vault bytes at all: an honest
    ``isError`` refusal, and an ApprovalGate hold (also ``isError``), where
    nothing was read.
    """
    if not isinstance(result, dict) or result.get("isError"):
        return False
    return getattr(_tool_source(mcp_client, tool), "provider", "") == "vault"


class VaultEgressFloor:
    """ONE run's vault egress floor (see ``VAULT_LOCAL_REASON``).

    Both tool-loop consumers use this same object — the orchestrator's dispatch
    doer and the team board — so the rule the product's promise rests on has
    exactly one implementation and cannot drift between the two paths.

    Wire it into ``run_tool_loop`` as::

        tool_exec=floor.exec_tool,
        guard_observation=floor.guard(decision),

    and read ``floor.route(decision)`` for EACH model turn (and once more at the
    end, for the honest verdict). ``decision`` stays the gateway's own per-step
    choice; the floor only ever overrides a CLOUD one, so an already-local step
    keeps its own honest route reason.

    State is per RUN, not per step: once the companion holds the user's notes,
    the whole rest of the run is local. ``vault_now`` is thread-local because
    reads dispatch concurrently and it describes the ONE observation being
    guarded on this thread right now.
    """

    def __init__(
        self,
        gateway: Any,
        mcp_client: Any,
        models_used: Optional[List[str]] = None,
    ) -> None:
        self._gateway = gateway
        self._client = mcp_client
        self._models_used = models_used
        self._forced: Optional[Any] = None
        self._withhold = False
        self._lock = threading.Lock()
        self._local = threading.local()
        # The user's own SCPRISM_SENSITIVE words apply to tool results through
        # the gateway method; a gateway without it (the Bifrost supervisor) falls
        # back to the built-in keyword list alone.
        self._result_guard = getattr(
            gateway, "guard_tool_result", guard_cloud_tool_result
        )

    def route(self, decision: Any) -> Any:
        """The route a turn of ``decision``'s step actually uses."""
        forced = self._forced
        return forced if forced is not None and not decision.is_local else decision

    def exec_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """The governed tool call, plus the floor.

        The call itself is untouched — ``call_tool`` still owns the allowlist,
        sensitivity and approval gates and its own span, and a block still raises
        through to the loop. What is added: when the result is real vault
        CONTENT, the rest of the run is re-routed LOCAL before the content can be
        fed back. With no local model to route to, nothing is re-routed and
        nothing is sent; ``guard`` then hands the model an honest withheld note.
        """
        self._local.vault_now = False
        result = self._client.call_tool(name, arguments)
        if not _is_vault_content(self._client, name, result):
            return result
        self._local.vault_now = True
        with self._lock:
            if self._forced is not None or self._withhold:
                return result  # the run already flipped / already withholds
            local_route_for = getattr(self._gateway, "local_route_for", None)
            forced = local_route_for(VAULT_LOCAL_REASON) if local_route_for else None
            if forced is None:
                # No local model, and no local seam on this gateway. The ONLY
                # safe answer is to not send it — never a silent cloud fallback.
                self._withhold = True
                return result
            self._forced = forced
            # The verdict's model chip must name the model that actually read the
            # notes, not only the one the run started on.
            if self._models_used is not None:
                label = "%s · %s" % (forced.provider, forced.model)
                if label not in self._models_used:
                    self._models_used.append(label)
        return result

    def guard(self, decision: Any) -> Optional[Callable[[str], Tuple[str, bool]]]:
        """The tool-RESULT guard for a step the gateway routed to ``decision``,
        or None when that step is already local (zero egress, nothing to guard —
        byte-identical to the ungated feed-back)."""
        if decision.is_local:
            return None

        def _guard(content: str) -> Tuple[str, bool]:
            if self._withhold and getattr(self._local, "vault_now", False):
                return _WITHHELD_VAULT_RESULT, True
            if self.route(decision).is_local:
                # The flip already made this turn local: the content is going
                # nowhere, so there is nothing to redact.
                return content, False
            return self._result_guard(content)

        return _guard


def _build_skill_context(
    disclosed: List[DisclosedSkill],
) -> Tuple[str, List[str]]:
    """Turn the disclosed skills into (model-facing block, injected names).

    Ranking is by SPECIFICITY: the number of words in the trigger the skill
    matched on (desc) — a two-word trigger is a tighter, more intentional hit
    than a one-word one — with ties broken by catalog order (Python's stable
    sort preserves ``disclose()``'s catalog-order output). Only the top
    ``MAX_DISCLOSED_SKILLS`` survive.

    The block is the header followed by one ``## <name>\\n<instructions>``
    section per skill, grown under a hard ``MAX_SKILLS_BLOCK_CHARS`` cap: the
    first section that would overflow is truncated to exactly fill the cap and
    every later skill is dropped, so the block can never exceed the cap no
    matter how large a body is. The returned name list is exactly the skills
    whose (possibly truncated) body actually landed in the block — that is what
    ``Verdict.disclosed`` must honestly attribute, not every match.
    """
    if not disclosed:
        return "", []
    ranked = sorted(
        disclosed,
        key=lambda d: -len(re.findall(r"[a-z0-9]+", d.matched_on.lower())),
    )[:MAX_DISCLOSED_SKILLS]

    block = SKILLS_BLOCK_HEADER
    injected: List[str] = []
    for d in ranked:
        # Tier 3: append only the references this skill's own body NAMES. A
        # skill carrying ten references and citing one must cost one, or the
        # folder shape becomes a token tax instead of a saving. The text is
        # already in memory (read at load time under the containment guards),
        # so this stays a pure function.
        cited = "".join(
            f"\n\n### {rel}\n{body}"
            for rel, body in sorted(d.resources.items())
            if rel in d.instructions
        )
        # The cited reference is part of the BODY, not an optional extra — the
        # instructions told the model to follow it. Truncating instructions
        # alone dropped it whole and left thousands of characters of room
        # unused (found end-to-end, 2026-08-31).
        body = f"{d.instructions}{cited}"
        section = f"\n\n## {d.name}\n{body}"
        room = MAX_SKILLS_BLOCK_CHARS - len(block)
        if len(section) <= room:
            block += section
            injected.append(d.name)
            continue
        # This section overflows: keep its heading + as much of the body as
        # still fits, then STOP — every later skill would only overflow too.
        head = f"\n\n## {d.name}\n"
        if len(head) < room:
            block += head + body[: room - len(head)]
            injected.append(d.name)
        break
    return block, injected


def _emit_withheld_spans(
    telemetry: Telemetry,
    parent_id: str,
    mcp_client: Any,
    tool_calls: List[Any],
) -> None:
    """Emit one ``tool_exec`` span with ``withheld=True`` per tool RESULT the F1
    egress gate redacted from a cloud POST (M3).

    The tool CALL already emitted its own ``tool_exec`` span; this records the
    SEPARATE governance win — a sensitive result never reached the cloud model —
    so the Manager View can surface it honestly. The span is parented under the
    dispatch/run span, like the client's own tool_exec spans. No withholding ->
    nothing emitted (byte-identical to before).

    The ``provider``/``server`` are derived from the SOURCE that actually served
    the tool (a ``CompositeToolClient`` routes each name to its owner), so a
    withheld WEB result is audited ``provider="web"`` and a withheld MCP result
    ``provider="mcp"`` — the span must not lie about who ran the tool.
    """
    for tr in tool_calls:
        if getattr(tr, "withheld", False):
            tool = getattr(tr, "tool", "?")
            source = _tool_source(mcp_client, tool)
            with telemetry.span(
                "tool_exec",
                span_type="tool_exec",
                parent=parent_id,
                provider=getattr(source, "provider", "mcp"),
                server=getattr(source, "server_name", "mcp"),
                tool=tool,
                withheld=True,
            ) as sp:
                sp.set(reason="tool result withheld from cloud (sensitive)")


def _tool_source(mcp_client: Any, tool: str) -> Any:
    """The tool SOURCE that actually served ``tool``. A ``CompositeToolClient``
    routes by name via its ``_owner`` map, so return the owning source; any other
    (single) client served the tool itself. Used to attribute a withheld-result
    span to the truthful provider (web vs mcp)."""
    owner_map = getattr(mcp_client, "_owner", None)
    if isinstance(owner_map, dict):
        owner = owner_map.get(tool)
        if owner is not None:
            return owner
    return mcp_client


def _who(agent: str, stage: str) -> Dict[str, Any]:
    """The optional who/which-phase attrs for a span.

    Returned as a dict to splat so an UNNAMED run writes neither key — an
    absent attr and an empty one are different claims, and every reader of
    these spans (the crew board, the dossier, delegationSteps) treats a present
    `agent` as "this run had a named worker".
    """
    out: Dict[str, Any] = {}
    if agent.strip():
        out["agent"] = agent.strip()
    if stage.strip():
        out["round"] = stage.strip()
    return out


def _gateway_model(
    gateway: Gateway,
    telemetry: Telemetry,
    parent_id: str,
    models_used: Optional[List[str]] = None,
    mcp_client: Optional[Any] = None,
    mcp_max_iters: Optional[int] = None,
    token_budget: Optional[int] = None,
    context_prefix: str = "",
    route_hint: Optional[str] = None,
    image: Optional[Dict[str, Any]] = None,
    agent: str = "",
    stage: str = "",
) -> ModelCall:
    """Build the dispatch model callable — every call goes through the gateway
    and emits a `model_call` span nested under the dispatch phase.

    ``image`` (optional) is a provider-neutral image block (from
    ``gateway.load_image_block``) attached to the user turn: a vision route sends
    it as a real image, a non-vision/local/stub route gets the honest 'image
    attached — not sent' note (the gateway decides). Default ``None`` -> the user
    content stays a plain ``str``, byte-identical to before image attach.

    ``route_hint`` is the OPTIONAL per-message route request (``"local"`` |
    ``"cloud"`` | ``None``) threaded from ``run()``. It is passed to
    ``gateway.route(prompt, route_hint)`` so the user's composer choice is
    honored WITHIN the sensitivity floor (the gateway keeps a secret local even
    under ``"cloud"``). Default ``None`` -> the gateway's normal rules, so every
    existing call site is byte-identical.

    Routing + policy bucketing run on the CLEAN task text (the raw step). The
    optional ``context_prefix`` (disclosed skills + LF-1 memory) is prepended to
    the MODEL input only — AFTER the route decision — so injected skills/vault
    content still reaches the model verbatim but never leaks into the
    SENSITIVE/REASONING keyword scans or the learned-policy task bucket (which
    must reflect the training-time intent = the task). Empty prefix (the default)
    is byte-identical to no prefix at all (LF-fix B).

    With an ``mcp_client`` (MCP v2b, ADR-035) each dispatch step runs the
    bounded, gated tool-use loop instead of one bare completion: the server's
    advertised tools are listed ONCE at build time, and every model TURN emits
    its own ``model_call`` span (same shape as the plain path) so the trace
    shows the real interleaving with the client's ``tool_exec`` spans.
    ``mcp_client`` is duck-typed — ``parent_span_id`` + ``list_tools()`` +
    ``call_tool(name, args)`` — so it is really a TOOL SOURCE: the governed
    ``MCPClient``, the ``WebToolProvider`` (web research), or a
    ``CompositeToolClient`` fanning both all fit unchanged. Default ``None`` is
    the unchanged single-span, single-call path — byte-identical to before v2b.

    Inside that loop the VAULT EGRESS FLOOR applies (see ``VAULT_LOCAL_REASON``):
    once a tool from the ``vault`` source returns content, every remaining model
    turn routes LOCAL, and if there is no local model the content is withheld
    from the cloud turn rather than sent. A run that touches no vault tool is
    unaffected — same route, same guard, same spans.
    """

    def _model_input(prompt: str) -> str:
        # Route decides on the clean prompt; the model sees prefix + prompt.
        return f"{context_prefix}\n\n{prompt}" if context_prefix else prompt

    if mcp_client is None:

        def _call(prompt: str, step_route: str) -> ModelResult:
            # `route_hint` (the per-message hint) is the enclosing param; the
            # positional `step_route` is the dispatcher's read/write route and is
            # intentionally unused for provider selection (the gateway routes on
            # the clean prompt + hint).
            decision = gateway.route(prompt, route_hint)  # clean task (LF-fix B)
            # Record the REAL provider:model for the verdict (UI shows it honestly).
            if models_used is not None:
                label = f"{decision.provider} · {decision.model}"
                if label not in models_used:
                    models_used.append(label)
            # Every dispatch carries the Companion charter (+ interview context) —
            # the primary model is a governed co-founder, never a bare chatbot.
            # The context prefix (skills + memory) is applied to the model input
            # AFTER routing, so it reaches the model without steering the route.
            # ``image`` (when present) attaches to the user turn as a block list;
            # None keeps the content a plain str (byte-identical).
            messages = companion_messages(_model_input(prompt), image=image)
            with telemetry.span(
                "model_call",
                span_type="model_call",
                parent=parent_id,
                provider=decision.provider,
                model=decision.model,
                route=decision.target,
                is_local=decision.is_local,
                reason=decision.reason,
                # WHO did this, and WHICH phase of the job it was. A team run
                # has always written these; a solo run wrote neither, so nothing
                # downstream could say who answered a chat, a wake or a project
                # step, or which step it belonged to. Empty when the caller named
                # nobody, and an empty attr is omitted — an unnamed run is
                # byte-identical to before.
                **_who(agent, stage),
            ) as sp:
                res = gateway.model_call(messages, decision)
                sp.set(
                    tokens_in=res.tokens_in,
                    tokens_out=res.tokens_out,
                    cache=res.cache,
                    is_real=res.is_real,
                    # HONESTY: the provider cut this reply off at the cap. The
                    # trace says so, and it rides out to the judge (below).
                    truncated=res.truncated,
                )
            return ModelResult(
                text=res.text,
                tokens=res.tokens,
                route=decision.target,
                cache=res.cache,
                tokens_in=res.tokens_in,
                tokens_out=res.tokens_out,
                reason=decision.reason,
                truncated=res.truncated,
            )

        return _call

    # MCP tool-use path (v2b). F4: parent the client's ``tool_exec`` spans under
    # THIS dispatch span (``parent_id`` == ``dsp.span_id``) so they nest with the
    # per-turn ``model_call`` spans instead of dangling at ``parent=null`` (a
    # phantom-parentless span the dashboard can't attribute).
    mcp_client.parent_span_id = parent_id

    # List the advertised tools once for the whole dispatch phase; an
    # unreachable/broken server must not kill the run — with no tools the loop
    # degrades to today's single-shot completion, and the handshake/tool_exec
    # spans already recorded the truth (nothing to log, nothing to fabricate).
    try:
        tools = mcp_client.list_tools()
    except MCPError:
        tools = []

    # The VAULT EGRESS FLOOR, built once for the whole dispatch (the doer is
    # built once per run) because the floor is a property of the RUN: once the
    # companion has the user's notes in hand, the rest of the run is local — not
    # just the step that asked. Same object the team board uses.
    floor = VaultEgressFloor(gateway, mcp_client, models_used)

    def _mcp_call(prompt: str, step_route: str) -> ModelResult:
        # `route_hint` (per-message hint) is captured from the enclosing scope;
        # `step_route` (the dispatcher's read/write route) is unused here.
        decision = gateway.route(prompt, route_hint)  # clean task (LF-fix B)
        # Record the REAL provider:model for the verdict (UI shows it honestly).
        if models_used is not None:
            label = f"{decision.provider} · {decision.model}"
            if label not in models_used:
                models_used.append(label)

        def _model_fn(msgs: List[Dict[str, Any]]):
            # ONE completion, ONE span per model turn — the same span shape as
            # the plain path, so the trace shows each turn interleaved with the
            # client's tool_exec spans. The route is read PER TURN so a
            # forced-local turn is spanned as local, with the honest reason.
            route = floor.route(decision)
            with telemetry.span(
                "model_call",
                span_type="model_call",
                parent=parent_id,
                provider=route.provider,
                model=route.model,
                route=route.target,
                is_local=route.is_local,
                reason=route.reason,
                **_who(agent, stage),
            ) as sp:
                res = gateway.model_call(msgs, route)
                sp.set(
                    tokens_in=res.tokens_in,
                    tokens_out=res.tokens_out,
                    cache=res.cache,
                    is_real=res.is_real,
                    truncated=res.truncated,  # HONESTY: cut off at the cap.
                )
            return res

        # F1: on a CLOUD route, gate every tool RESULT before it can egress back
        # to the cloud model — a secret in a file the tool read must never reach
        # the next POST. A LOCAL route stays zero-egress, so the floor returns no
        # guard at all (byte-identical to the ungated feed-back).
        tl = run_tool_loop(
            # Prefix (skills + memory) reaches the model AFTER routing, so the
            # tool loop still sees LF-1 memory + disclosed skills verbatim while
            # the route was decided on the clean task (LF-fix B).
            messages=companion_messages(_model_input(prompt), image=image),
            tools=tools,
            model_fn=_model_fn,
            tool_exec=floor.exec_tool,
            max_iters=mcp_max_iters,
            guard_observation=floor.guard(decision),
            token_budget=token_budget,
        )
        # M3: the F1 egress gate fired — a tool RESULT carrying a secret was
        # withheld from the cloud POST. The tool CALL already emitted its own
        # tool_exec span; this records the separate governance WIN (result
        # withheld) so the Manager View can SURFACE it, honestly, to the user.
        _emit_withheld_spans(telemetry, parent_id, mcp_client, tl.tool_calls)
        # The route this step ENDED on — the same value as `decision` unless the
        # vault floor flipped it, in which case the Verdict must say local (and
        # say why), not the lane the step merely started in.
        final = floor.route(decision)
        # F8: a genuine multi-turn loop is "miss" (each turn's real cache is on
        # its model_call span); the tool-less degrade path (exactly one call,
        # zero tool calls) carries that call's REAL cache — honest attribution.
        return ModelResult(
            text=tl.text,
            tokens=tl.tokens_in + tl.tokens_out,
            route=final.target,
            cache=tl.cache,
            tokens_in=tl.tokens_in,
            tokens_out=tl.tokens_out,
            reason=final.reason,
            truncated=tl.truncated,
        )

    return _mcp_call


def run(
    contract: TaskContract,
    *,
    vault: str,
    tier1_commands: Optional[List[str]] = None,
    model: Optional[ModelCall] = None,
    tier1_cwd: Optional[str] = None,
    post_dispatch: Optional[Callable[[str], Dict[str, Any]]] = None,
    gateway: Optional[Gateway] = None,
    use_bifrost: Optional[bool] = None,
    telemetry: Optional[Telemetry] = None,
    judge: Optional[Judge] = None,
    eval_threshold: float = evals.DEFAULT_THRESHOLD,
    envelope: Optional[Envelope] = None,
    agent_id: str = "orchestrator",
    # WHO the user sees as doing this run, and WHICH phase of a larger job it
    # is. Distinct from `agent_id`, which is the PERMISSIONS identity: this is
    # the display name the crew board and the coworker panel read off the span.
    # Empty (the default) writes neither attr — byte-identical to before.
    agent_name: str = "",
    stage: str = "",
    role: Optional[str] = None,
    env: str = "dev",
    task_type: Optional[str] = None,
    tool_requests: Optional[List[ToolRequest]] = None,
    approvals: Optional[List[Approval]] = None,
    permissions: Optional[PermissionEngine] = None,
    hooks: Optional[HookEngine] = None,
    memory: Optional[MemoryStore] = None,
    session_id: Optional[str] = None,
    memory_budget: int = 2000,
    skill_catalog: Optional[List[CatalogEntry]] = None,
    vault_writes: Optional[List[VaultWrite]] = None,
    vault_rules: Optional[RuleSet] = None,
    retriever: Optional[RetrievalAgent] = None,
    requester_role: str = "",
    evidence: Optional[EvidenceStore] = None,
    record_evidence: bool = True,
    ci_gate: Optional[CIGate] = None,
    record_training: bool = True,
    training_weights: Optional[RewardWeights] = None,
    emit_workflow: bool = False,
    mcp_client: Optional[Any] = None,
    mcp_max_iters: Optional[int] = None,
    route_hint: Optional[str] = None,
    image: Optional[Dict[str, Any]] = None,
    verdict_extras: Optional[Dict[str, Any]] = None,
    dispatch_wrapper: Optional[Callable[[ModelCall], ModelCall]] = None,
) -> Verdict:
    """Orchestrate a single task and return its Verdict.

    Steps:
      1. Plan the contract into read/write steps (deterministic).
      2. Dispatch: reads concurrent, writes serial — all model calls via the
         gateway, each emitting a `model_call` span.
      2b. Optional `post_dispatch` seam (project mode, `project_writes`
          span): if supplied, called exactly once with the model's raw
          completion text, AFTER dispatch and BEFORE Tier-1. A raised
          `ProjectStepError` fails the run Tier-1-style (reason recorded,
          Tier-2 short-circuited) — default None is a no-op, byte-identical
          to every run that predates this seam.
      3. Tier-1 verify (zero tokens, `tool_exec` span). If it FAILS, the
         Tier-2 judge (a model call) is never invoked.
      4. Tier-2 judge only when Tier-1 passed.
      5. Build, validate, and persist the Verdict (`verdict` span).

    MCP tool-use (v2b, ADR-035): with an ``mcp_client``, each dispatch step
    runs the bounded, gated tool-use loop (`toolloop.run_tool_loop`, at most
    ``mcp_max_iters`` tool executions per step — None/0 means the engine
    default, ``SCPRISM_TOOL_TURNS`` or ``toolloop.DEFAULT_MAX_ITERS``, and any
    value is clamped to ``toolloop.MAX_MAX_ITERS``) instead of one bare
    completion — the model REQUESTS a tool, the deterministic loop GRANTS or
    denies it through the client's own allowlist + sensitivity gates, and
    every model turn / tool exec is a real span. The ADR-035 stance stays
    true: a model never steers this loop. When the caller injects its own
    ``model``, the mcp params are ignored — composite doers own their calls.
    Default ``None`` changes nothing (byte-identical span shape).

    ``route_hint`` (``"local"`` | ``"cloud"`` | ``None``) is the user's optional
    per-message route request, threaded to ``gateway.route``: the gateway grants
    it only WITHIN the zero-egress floor (a secret stays local even under
    ``"cloud"``) and stays authoritative. Default ``None`` -> the gateway's
    normal rules, byte-identical.

    ``verdict_extras`` are caller payloads merged onto ``Verdict.extras`` BEFORE
    the verdict is written and logged (project.py's refine-attempt record). The
    ``"project"`` key is reserved for the ``post_dispatch`` seam and is never
    overwritten from here. Default ``None`` -> extras unchanged.
    """
    contract.validate()

    # Gateway selection (ADR-002/026). By default this is the in-process Python
    # Gateway; when Bifrost is enabled (use_bifrost / $SCPRISM_BIFROST) AND the
    # bifrostd binary is available, it is the REAL supervised Go daemon over a
    # UDS. If we create it here we also own its lifecycle and shut it down.
    owns_gateway = gateway is None
    gateway = gateway or make_gateway(use_bifrost=use_bifrost)
    # LF-2: adopt this vault's promoted route-SELECTION policy on a gateway we
    # built (an injected gateway is the caller's — team.py sets its own). No
    # adopted policy → set_route_policy is never called → built-in routing,
    # byte-identical. The Bifrost supervisor has no set_route_policy (it routes
    # in the Go daemon) — hasattr keeps this a safe no-op there.
    if owns_gateway and hasattr(gateway, "set_route_policy"):
        from .grpo import load_current_route_policy

        _adopted = load_current_route_policy(vault)
        if _adopted is not None:
            gateway.set_route_policy(*_adopted)
    spans_path = os.path.join(vault, "spans.jsonl")
    telemetry = telemetry or Telemetry(spans_path)
    # `judge` stays None by default so the real gateway-routed judge
    # (evals.evaluate) runs; a caller may inject a judge as a test double.

    # Governance (Layer 3 permissions + Layer 4 hooks). Defaults are real,
    # deterministic, stdlib-only engines; a caller may inject configured ones.
    permissions = permissions or PermissionEngine()
    hooks = hooks or HookEngine()
    # The Stop ratchet. When a CI gate is wired in (ADR-022 pre-deploy gate),
    # the ratchet also runs the golden suite: below threshold → not compliant →
    # the write is blocked and the task routes to repair (specs/06 §4). The gate
    # runs its goldens in an isolated scratch vault, so it never recurses.
    stop_hook = hooks.new_stop_hook(ci_gate.ratchet() if ci_gate is not None else None)
    # The grant is bound to the task's declared purpose + scope, least
    # privilege, and expires with the run. Role defaults to the mode's least
    # privileged fit (write -> implementer, read -> data-reader).
    grant_role = role or ("implementer" if contract.mode == WRITE else "data-reader")
    access = AccessContext(
        role=grant_role,
        purpose=contract.intent,
        scope=list(contract.scope) if contract.scope else ["**"],
        env=env,
        task_type=task_type or contract.mode,
        issued_at=time.time(),
    )

    hooks_fired: List[str] = []
    hook_decisions: List[dict] = []
    blocks: List[dict] = []
    consumed_approvals: List[dict] = []

    def _record(decision: HookDecision) -> None:
        hook_decisions.append(decision.to_dict())
        if decision.blocked:
            blocks.append(decision.to_dict())

    with telemetry.span(
        f"run:{contract.task_id}",
        span_type="run",
        task_id=contract.task_id,
        intent=contract.intent,
        mode=contract.mode,
    ) as run_span:
        run_id = run_span.span_id

        # 1. Plan --------------------------------------------------------
        with telemetry.span("plan", span_type="hook", parent=run_id) as ps:
            hooks_fired.append("plan")
            steps = plan(contract)
            ps.set(steps=len(steps))

        # 1-workflow. Conductor integration (ADR-032). When enabled, EMIT the
        #     deterministic routing graph from THIS contract + THIS plan and
        #     persist it to <vault>/workflows/<task_id>.yaml BEFORE anything
        #     runs — a diffable, inspectable DAG exists ahead of execution. The
        #     plan the loop then executes IS the plan the workflow was built
        #     from, so graph and execution can never diverge. Off by default:
        #     no file is written and workflow_path stays "" (byte-identical).
        workflow_path = ""
        if emit_workflow:
            with telemetry.span(
                "workflow", span_type="hook", parent=run_id
            ) as ws0:
                hooks_fired.append("workflow")
                wf_dir = os.path.join(vault, "workflows")
                os.makedirs(wf_dir, exist_ok=True)
                workflow_path = os.path.join(wf_dir, f"{contract.task_id}.yaml")
                yaml_text = conductor.emit_workflow(contract, steps)
                with open(workflow_path, "w", encoding="utf-8") as fh:
                    fh.write(yaml_text)
                wf_check = conductor.validate_workflow(
                    conductor.parse_workflow(yaml_text)
                )
                ws0.set(
                    workflow_path=workflow_path,
                    tasks=len(steps) + 3,
                    valid=wf_check["ok"],
                    conductor_backend=conductor.conductor_available(),
                )

        # 1a. Memory + context routing (Harness Layer 1 + 6, specs/03) -----
        #     Query reformulation (bind raw intent to the vault's structure) ->
        #     progressive disclosure (load only the skills this task matches) ->
        #     memory injection UNDER a fixed token budget (never the whole
        #     vault). All recorded for the Verdict; injection provably fits the
        #     budget. Session isolation: working memory keys on the task id so two
        #     concurrent tasks cannot cross-contaminate.
        sid = session_id or contract.task_id
        memory_injected: List[dict] = []
        # The REAL MemoryItems select_context chose (LF-1). memory_injected
        # (dicts) is the attribution record and carries NO body text; this holds
        # the selected items so their verbatim content can feed the doer prompt's
        # memory block below. Empty whenever nothing was selected.
        memory_items: List[MemoryItem] = []
        disclosed_names: List[str] = []
        # The disclosed-skill instruction block prepended to every dispatch
        # prompt (built below). "" whenever nothing matched — an empty block
        # leaves the prompt, and therefore every skill-less run, byte-identical.
        skills_block = ""
        with telemetry.span("memory", span_type="retrieval", parent=run_id) as mem_s:
            hooks_fired.append("memory")
            vault_structure = VaultStructure.from_vault(vault)
            query = reformulate(contract.intent, vault_structure)
            disclosed = disclose(contract.intent, skill_catalog or [])
            # Real disclosure (S2): build the model-facing instruction block and
            # record ONLY the skills actually injected. disclosed_names must be
            # honest — it flows to the Verdict, the training records, and the
            # evidence chain as "what the model was told", not "what matched".
            skills_block, disclosed_names = _build_skill_context(disclosed)

            candidates: List[MemoryItem] = []
            if memory is not None:
                candidates.extend(memory.candidates(sid, contract.intent))

            # 1a-i. Knowledge layer (E4) — the retrieval CASCADE, run through the
            #     agentic sub-agent (ADR-018). The main loop sees ONLY the
            #     assembled context (the hits) — never the routing/escalation
            #     logic. Retrieved docs join the candidate pool and are packed
            #     under the SAME token budget, so injection still provably fits.
            if retriever is not None:
                with telemetry.span(
                    "retrieval", span_type="retrieval", parent=mem_s.span_id,
                ) as rs:
                    hooks_fired.append("retrieval")
                    ar = retriever.retrieve(query.text or contract.intent)
                    for h in ar.hits:
                        candidates.append(
                            MemoryItem(
                                id=f"L3:{h.doc_id}",
                                tier=L3,
                                content=f"[{h.doc_id}] {h.title}",
                                priority=1.5 + float(h.score),
                                source=h.doc_id,
                            )
                        )
                    rs.set(
                        stage_reached=ar.stage_reached,
                        stages_run=list(ar.stages_run),
                        reached_graph=ar.reached_graph,
                        hits=ar.hit_count,
                        doc_ids=ar.doc_ids(),
                        cache=ar.cache,
                        hit_rate=round(retriever.hit_rate, 3),
                        route=ar.route,
                    )
                    if ar.hit_count == 0 and not ar.reached_graph:
                        pass  # nothing found is a valid, cheap outcome

            # Dedupe candidates by id (vault_items + retrieval may overlap),
            # keeping the higher-priority copy.
            if candidates:
                best: dict = {}
                for it in candidates:
                    prev = best.get(it.id)
                    if prev is None or it.priority > prev.priority:
                        best[it.id] = it
                injected = select_context(list(best.values()), memory_budget)
                memory_items = injected
                memory_injected = [i.to_dict() for i in injected]
                inj_tokens = injected_tokens(injected)
            else:
                inj_tokens = 0
            # Invariant guard: injection never exceeds its budget.
            assert inj_tokens <= memory_budget, "memory injection exceeded budget"
            mem_s.set(
                session_id=sid,
                budget=memory_budget,
                injected=len(memory_injected),
                injected_tokens=inj_tokens,
                disclosed=disclosed_names,
                query=query.to_dict(),
            )

        # 1b. Governance gate — Layer 3 (RBAC/ABAC) + Layer 4 (PreToolUse +
        #     ConfirmationGate) fire BEFORE any tool/write executes. A block is
        #     recorded and the step is refused pre-exec, so no model tokens are
        #     spent on a blocked destructive action. This is the audit spine.
        executed_requests: List[ToolRequest] = []
        for i, req in enumerate(tool_requests or []):
            with telemetry.span(
                f"gate:{req.tool}", span_type="hook", parent=run_id,
                tool=req.tool, action=req.action, target=req.path,
            ) as gs:
                hooks_fired.append("pre_tool_use")
                # (a) PreToolUse: destructive / secret / restricted APIs.
                gate = hooks.pre_tool_use(req, approvals)
                for d in gate.decisions:
                    _record(d)
                    if d.hook == "ConfirmationGate":
                        hooks_fired.append("confirmation_gate")
                if not gate.allowed:
                    gs.set(allowed=False, blocked_by=gate.block.hook,
                           reason=gate.block.reason)
                    gs.set_status("error")
                    continue
                # (b) Permission check: RBAC + ABAC least-privilege scope.
                pdec = permissions.check(req.agent_id, req.action, req.path, access)
                perm_hook = HookDecision(
                    "PermissionCheck", "allow" if pdec.allow else "block",
                    pdec.reason, exit_code=0 if pdec.allow else 2,
                    tool=req.tool, target=req.path,
                )
                _record(perm_hook)
                hooks_fired.append("permission_check")
                if not pdec.allow:
                    gs.set(allowed=False, blocked_by="PermissionCheck",
                           reason=pdec.reason)
                    gs.set_status("error")
                    continue
                # Allowed: an irreversible action that cleared the gate consumed
                # a recorded approval — capture it for the evidence layer.
                for appr in approvals or []:
                    if hooks.confirm.is_irreversible(req) and appr.matches(req):
                        consumed_approvals.append(appr.to_dict())
                        break
                # (c) PostToolUse: read-only intent/secret check on the result.
                post = hooks.post_tool_use(
                    req, output=req.output, allowed_scope=access.scope
                )
                _record(post)
                hooks_fired.append("post_tool_use")
                if post.blocked:
                    gs.set(allowed=False, blocked_by="PostToolUse",
                           reason=post.reason)
                    gs.set_status("error")
                    continue
                executed_requests.append(req)
                gs.set(allowed=True)

        # 2. Dispatch (reads parallel / writes serial) -------------------
        models_used: List[str] = []
        with telemetry.span("dispatch", span_type="hook", parent=run_id) as dsp:
            hooks_fired.append("dispatch")
            # Real disclosure (S2) + memory injection (LF-1): the disclosed-skill
            # instructions, then the REAL memory selection, form the CONTEXT
            # PREFIX the model sees before the task. The skills block tells the
            # model which matched procedures to follow; the memory block gives it
            # the vault context select_context actually chose — its verbatim item
            # text under a labelled header (no re-summarization, no invention). The
            # memory block is already bounded by memory_budget because
            # select_context packed it under that budget, so there is no
            # double-budgeting. The span/Verdict `memory_injected` attribution
            # already recorded this selection — with this wiring the recorded
            # claim is finally true. prefix = skills_block + "\n\n" + memory_block,
            # each part included ONLY when non-empty; a run with neither (no
            # matched skills, nothing selected) applies no prefix at all, so its
            # prompt is byte-identical to before this landed.
            memory_block = ""
            if memory_items:
                memory_block = "\n".join(
                    ["Working context (from your vault):"]
                    + [it.content for it in memory_items]
                )
            prefix = "\n\n".join(part for part in (skills_block, memory_block) if part)
            # LF-fix B: the gateway doer routes + buckets on the CLEAN task, then
            # prepends this prefix to the MODEL input INSIDE _gateway_model — so
            # skills/vault text still reach the model verbatim but never leak into
            # routing (keyword scans + learned-policy bucket see the task only).
            active_model = model or _gateway_model(
                gateway,
                telemetry,
                dsp.span_id,
                models_used,
                mcp_client=mcp_client,
                mcp_max_iters=mcp_max_iters,
                # F7: cap each step's tool loop by the run's token budget so a
                # multi-turn loop can't silently outspend it between the
                # dispatcher's per-step checks. >0 only (0/None = no per-loop cap).
                token_budget=(
                    contract.token_budget if contract.token_budget and contract.token_budget > 0 else None
                ),
                context_prefix=prefix,
                # Per-message route hint (composer local/cloud/auto). None ->
                # the gateway's normal rules, byte-identical to before.
                route_hint=route_hint,
                # Attached image block (None -> plain-text user turn,
                # byte-identical). Vision route sends it; else honest note.
                image=image,
                agent=agent_name,
                stage=stage,
            )
            # A telemetry-aware injected doer (the role board) gets the same
            # telemetry + parent span the single-doer path gets, so its per-agent
            # model_call spans land in this step's trace (MV1 — Manager View data
            # foundation). Any other injected model has no set_telemetry and is
            # untouched. Additive only: this reads execution truth into spans and
            # never changes the completion/Verdict (ADR-007).
            if model is not None and hasattr(model, "set_telemetry"):
                model.set_telemetry(telemetry, dsp.span_id)
            # An INJECTED model (a role board) owns its own routing, so
            # _gateway_model never runs for it — apply the same context prefix by
            # wrapping its prompt (the gateway path applies it internally instead).
            # Empty prefix -> no wrapper -> byte-identical to before this landed.
            if model is not None and prefix:
                _dispatch_model = active_model

                def active_model(prompt: str, route: str) -> ModelResult:
                    return _dispatch_model(f"{prefix}\n\n{prompt}", route)

            # OUTPUT-CONTRACT seam (project mode). The caller may wrap the
            # fully-built doer — gateway-backed OR injected, prefix already
            # applied — so it can inspect a completion and, if the completion
            # misses the caller's output contract, ask ONCE more. project.py
            # uses it for the ===FILE:=== contract: a doer that answers a build
            # step with analysis and no file blocks writes nothing, and used to
            # do so silently. The wrapper owns its own bound; this seam only
            # hands it the doer. Default None -> byte-identical dispatch.
            if dispatch_wrapper is not None:
                active_model = dispatch_wrapper(active_model)

            _t0 = time.time()
            dispatch_result = dispatch(
                steps,
                model=active_model,
                token_budget=contract.token_budget,
            )
            dispatch_latency_ms = (time.time() - _t0) * 1000.0
            dsp.set(
                steps=len(steps),
                tokens=dispatch_result.tokens_spent,
                cache_hits=dispatch_result.cache_hits,
                cache_misses=dispatch_result.cache_misses,
                write_order=list(dispatch_result.write_order),
                latency_ms=round(dispatch_latency_ms, 3),
            )
            # Composite-doer sub-models (P1-2 role board): an injected `model`
            # bypasses `_gateway_model`, so the loop's own models_used never sees
            # the board's providers. Merge what the doer reported through the
            # ModelResult/dispatch pipe (deduped, preserving order) so the
            # Verdict lists the board's models, not the single adapter route.
            # Empty for every ordinary run -> byte-identical.
            for label in dispatch_result.models_used:
                if label not in models_used:
                    models_used.append(label)
            # Composite-doer per-agent disclosure (P3-1 role board): when the
            # doer is the role board, `run_project` passes the catalog to the
            # BOARD (per-agent) and None here, so the loop's own `disclosed_names`
            # is empty; the board's honest union rides out on the same pipe as
            # models_used. Merge it (deduped, preserving order) so the Verdict
            # attributes what the board actually injected. Empty for every
            # ordinary run -> `disclosed_names` (and the Verdict) byte-identical.
            for name in dispatch_result.disclosed:
                if name not in disclosed_names:
                    disclosed_names.append(name)

        # The assistant text the Workspace chat surfaces: the FIRST real model
        # completion (plan steps are near-rephrases of one chat intent, so
        # joining them doubles the answer; offline-stub lines are diagnostics,
        # never chat text). If no step got a real completion, fall back to the
        # first stub so the client can detect it and use its simulation. This
        # is computed here (rather than after Tier-1/2, its original spot)
        # because the post_dispatch seam below needs the same raw completion
        # text and must run BEFORE Tier-1 — the value itself is unchanged, so
        # every existing run stays byte-identical.
        real_outputs = [
            (sr.output or "").strip()
            for sr in dispatch_result.step_results
            if (sr.output or "").strip()
            # "[rejected:" joins the diagnostic markers: the provider REFUSED
            # our request, so that line names the cause — it is never an answer,
            # and must never be presented (or written to a file) as one.
            and not (sr.output or "").lstrip().startswith(
                ("[offline:", "[stub:", "[rejected:")
            )
        ]
        stub_outputs = [
            (sr.output or "").strip()
            for sr in dispatch_result.step_results
            if (sr.output or "").lstrip().startswith(
                ("[offline:", "[stub:", "[rejected:")
            )
        ]
        response_text = (
            real_outputs[0] if real_outputs else (stub_outputs[0] if stub_outputs else "")
        )

        # 2b. Project-mode seam (post_dispatch, ADR pending) --------------
        #     Optional hook for a project-mode runner (project.py's
        #     run_project): handed the model's raw completion text exactly
        #     once, AFTER dispatch and BEFORE Tier-1, so any FILE blocks it
        #     writes are on disk before a --verify-command Tier-1 check runs
        #     against them. Default None: this block is inert and nothing
        #     downstream changes for any existing caller.
        #
        #     Deliberately NOT `response_text`: that value falls back to the
        #     first offline-stub line so the CLIENT can detect a simulated
        #     run, but a stub is a diagnostic echo of the prompt, never real
        #     content (see the comment above) — and because a project step's
        #     own prompt embeds the FILE-block format example, an offline
        #     stub echoing it back would look like a syntactically valid
        #     (but fake) file block. A stub must never reach a file writer,
        #     so post_dispatch only ever sees a REAL completion, or "" (which
        #     correctly fails closed as "no file blocks").
        project_completion = real_outputs[0] if real_outputs else ""
        project_result: Optional[Dict[str, Any]] = None
        project_error: Optional[str] = None
        if post_dispatch is not None:
            # Lazy import: project.py imports `loop.run` at module level, so a
            # top-level `from .project import ProjectStepError` here would be
            # circular. By the time post_dispatch is ever non-None, the
            # caller (project.py) has already fully imported both modules.
            from .project import ProjectStepError

            with telemetry.span(
                "project_writes", span_type="tool_exec", parent=run_id
            ) as pw:
                hooks_fired.append("project_writes")
                try:
                    project_result = post_dispatch(project_completion)
                    pw.set(ok=True)
                    # NO BLACK BOX (2026-08-31, the founder's one remaining
                    # concern: "which file you added, which file you updated —
                    # show me everything in the chat"): one span PER FILE the
                    # step really wrote, with the honest action word. The live
                    # chat stream renders these as they land.
                    overwrote = set(project_result.get("overwrote") or [])
                    for _rel in project_result.get("files_written") or []:
                        with telemetry.span(
                            "file_write", span_type="tool_exec", parent=run_id
                        ) as fw:
                            fw.set(
                                provider="files",
                                path=_rel,
                                action="updated" if _rel in overwrote else "added",
                            )
                except ProjectStepError as exc:
                    project_error = str(exc)
                    pw.set(ok=False, reason=project_error)
                    pw.set_status("error")

        # 3. Tier-1 — deterministic, zero tokens -------------------------
        with telemetry.span("tier1", span_type="tool_exec", parent=run_id) as t1s:
            hooks_fired.append("tier1")
            if project_error is not None:
                # A failed project write short-circuits EXACTLY like a failed
                # Tier-1 command: passed=False, the reason recorded in the
                # (synthetic) command log, Tier-2 skipped below via the same
                # `if t1.passed:` guard a real Tier-1 failure already uses.
                t1 = Tier1Result(
                    passed=False,
                    commands=[
                        CommandResult(
                            command="project:post_dispatch",
                            returncode=1,
                            stdout="",
                            stderr=project_error,
                        )
                    ],
                    tokens=0,
                )
            else:
                t1 = tier1(tier1_commands or [], cwd=tier1_cwd)
            t1s.set(
                passed=t1.passed,
                skipped=t1.skipped,
                tokens=0,
                commands=[c.command for c in t1.commands],
                # WHICH commands failed, and which could not be found at all.
                # observability.tier1_stats reads these so the Stats hero can
                # attribute a save to tests/lint/build instead of guessing, and
                # so "not configured" never renders as "your tests failed".
                failed_commands=t1.failed_commands,
                not_found=t1.missing_commands,
                # Which directory the gate ran in, and which absolute binary it
                # resolved to. Both are invisible otherwise, and both change what
                # `npm test` MEANS: an app-bundle cwd fails with ENOENT, and a
                # ~/.local/bin npm is a different node than an nvm shim.
                cwd=tier1_cwd if tier1_cwd is not None else "",
                resolved=t1.resolved_binaries,
                # WHY the gate was skipped, and which configured commands it did
                # not run. A skip is not a pass: without these the UI can only
                # render a tick over a gate that never executed, and
                # observability.tier1_stats cannot tell "the user configured no
                # verify command" from "this run had no codebase to check".
                skip_reason=t1.skip_reason,
                skipped_commands=t1.skipped_commands,
            )
            if not t1.passed:
                t1s.set_status("error")

        # 4. Tier-2 — only if Tier-1 passed (short-circuit). Run it HERE, at its
        #    original position (before the Stop ratchet), so "tier2" is appended
        #    to hooks_fired before "stop" and its span starts before the stop
        #    span — the persisted Verdict.hooks_fired, the training trajectory,
        #    and the spans.jsonl start-order all stay byte-identical. run_tier2
        #    lives in finalize.py so the team path can reuse the exact judge step.
        #    The judge is handed the MEASURED record of what this run produced —
        #    the files on disk (path + size + a bounded excerpt read back) and
        #    the real Tier-1 outcome — not just a trace summary. Without it the
        #    judge is asked "did it implement the thing?" while shown a 500-char
        #    slice of the completion, which is how a run that wrote 6 files and
        #    passed `npm test` was scored 0.5 for "the produced artifact is
        #    truncated ... failing to provide the actual implementation". Built
        #    HERE because Tier-1 has just run: the files are on disk and t1 is
        #    the real result, both zero-token reads.
        run_evidence = evals.build_evidence(
            tier1_result=t1,
            files_written=list((project_result or {}).get("files_written") or []),
            root=tier1_cwd or "",
        )
        t2 = run_tier2(
            contract,
            dispatch_result,
            tier1_passed=t1.passed,
            gateway=gateway,
            telemetry=telemetry,
            parent_id=run_id,
            envelope=envelope,
            threshold=eval_threshold,
            latency_ms=dispatch_latency_ms,
            judge=judge,
            hooks_fired=hooks_fired,
            run_evidence=run_evidence,
        )

        # 4b. Stop hook — the ratchet. Runs the Tier-1/compliance check at the
        #     "done" moment, exactly once, guarded against the infinite
        #     continue loop. Zero tokens (a read of execution truth).
        with telemetry.span("stop", span_type="hook", parent=run_id) as ss:
            hooks_fired.append("stop")
            stop_decision = stop_hook.run(
                {"tier1_passed": t1.passed, "blocks": blocks}
            )
            _record(stop_decision)
            ss.set(
                ratchet_runs=stop_hook.runs,
                compliant=not stop_decision.blocked,
                reason=stop_decision.reason,
            )
            if stop_decision.blocked:
                ss.set_status("error")

        # 4c. Vault writes through the validation gate (ADR-014). Every markdown
        #     write dry-runs against the rule files BEFORE persisting; a
        #     contradiction / hallucination is rejected with a reason and never
        #     touches L3 (fails closed). Rejections are recorded in the Verdict
        #     and fail the task closed.
        rejected_writes: List[dict] = []
        if vault_writes:
            rules = vault_rules if vault_rules is not None else RuleSet.from_vault(vault)
            for vw in vault_writes:
                with telemetry.span(
                    f"vault_write:{vw.path}", span_type="retrieval", parent=run_id,
                    path=vw.path,
                ) as ws:
                    hooks_fired.append("vault_write")
                    res = persist_vault_write(vault, vw.path, vw.content, rules)
                    ws.set(ok=res["ok"], reason=res["reason"])
                    if not res["ok"]:
                        rejected_writes.append({"path": vw.path, "reason": res["reason"]})
                        ws.set_status("error")

        # 5-5b. Finalize — build/write the Verdict + emit the GRPO training
        #     record, via the reusable finalize.finalize_run. It is handed the
        #     already-computed Tier-2 result (t2) plus the loop's accumulated
        #     locals, and emits the same verdict/training spans the inline block
        #     did. Evidence is deliberately NOT part of this call — the audit
        #     append runs after the run span flushes (§6 below).
        verdict = finalize_run(
            contract=contract,
            tier1_result=t1,
            tier2_result=t2,
            vault=vault,
            telemetry=telemetry,
            run_id=run_id,
            spans_path=spans_path,
            tokens_spent=dispatch_result.tokens_spent,
            model_route=dispatch_result.model_routes,
            models_used=models_used,
            model_route_reasons=dispatch_result.model_route_reasons,
            response=response_text,
            artifacts=[s.description for s in steps if s.is_write],
            cache_hits=dispatch_result.cache_hits,
            cache_misses=dispatch_result.cache_misses,
            steps=steps,
            stop_compliant=not stop_decision.blocked,
            record_training=record_training,
            training_weights=training_weights,
            hooks_fired=hooks_fired,
            hook_decisions=hook_decisions,
            blocks=blocks,
            approvals=consumed_approvals,
            memory_injected=memory_injected,
            disclosed=disclosed_names,
            rejected_writes=rejected_writes,
            workflow_path=workflow_path,
            project_result=project_result,
            extras=verdict_extras,
        )

        run_span.set(
            passed=verdict.passed,
            tokens=verdict.tokens_spent,
            cache_hits=verdict.cache_hits,
            cache_misses=verdict.cache_misses,
            spans_path=spans_path,
        )

    # 6. Evidence & Control — append the Verdict to the immutable, hash-chained
    #    audit spine (specs/05 §3). Governance is a READ of execution truth: the
    #    same Verdict object is the audit record, so evidence can never drift
    #    from what actually ran. who = agent identity + requester role; why =
    #    task intent; what = the action + diff/artifacts. Runs AFTER the run span
    #    has exited/flushed (its original position), preserving order exactly.
    #    Best-effort: an audit write must never break task execution.
    if record_evidence:
        try:
            store = evidence or EvidenceStore(vault)
            diff = {
                "writes": [vw.path for vw in (vault_writes or [])],
                "scope": list(contract.scope),
            }
            store.append_verdict(
                verdict,
                agent_id=agent_id,
                role=grant_role,
                requester_role=requester_role,
                intent=contract.intent,
                diff=diff,
            )
        except Exception:
            # The audit spine is important but must not take the loop down.
            pass

    # Shut down a gateway we own (a supervised Bifrost subprocess, if any) so no
    # child is orphaned. Injected gateways are the caller's to manage.
    if owns_gateway and hasattr(gateway, "close"):
        gateway.close()

    return verdict


def run_intent(
    intent: str,
    *,
    vault: str,
    tier1_commands=None,
    model=None,
    gateway: Optional[Gateway] = None,
    use_bifrost: Optional[bool] = None,
) -> Verdict:
    """Convenience: parse a raw intent into a contract, then run it."""
    contract = parse(intent)
    return run(
        contract,
        vault=vault,
        tier1_commands=tier1_commands,
        model=model,
        gateway=gateway,
        use_bifrost=use_bifrost,
    )
