"""Pure model tool-use loop core (MCP v2b, ADR-035).

ADR-035 stance: the model REQUESTS a tool; this DETERMINISTIC loop GRANTS or
denies it. The model never steers orchestration (ADR-007 holds): it only asks
for tools within its own turn, through a loop that is **bounded** (at most
``max_iters`` tool executions and ``max_iters + 1`` model calls), **gated**
(``tool_exec`` is the governed ``MCPClient.call_tool`` — allowlist +
sensitivity gates run before any bytes egress; a blocked call becomes an honest
``ok: false`` observation, never a fabricated success), and **telemetered by
the caller** (the injected ``model_fn`` / ``tool_exec`` own their
``model_call`` / ``tool_exec`` spans — this module imports no telemetry).

Protocol: a portable text convention, identical across every provider and the
offline stub. When tools exist, a manifest is appended to the system message.
The model calls a tool by replying with a fenced block::

    ```tool_call
    {"tool": "<name>", "arguments": { ... }}
    ```

The loop parses the LAST such block, executes the tool, and feeds back an
observation as the next user turn::

    ```tool_result
    {"tool": "<name>", "ok": true|false, "content": <result-or-error>}
    ```

A reply without a ``tool_call`` block is the final answer. With no tools
configured the loop is byte-identical to a single model call.

Dependency notes: ``model_fn``'s return value is duck-typed — any object with
``.text`` (str), ``.tokens_in`` / ``.tokens_out`` (int), and ``.is_real``
(bool) attributes works (the gateway's ``ModelCallResult`` fits; the gateway
is deliberately NOT imported, avoiding an import cycle).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .mcp import MCPBlockedError, MCPError, MCPTool

# Cap for ToolCallTrace.detail — a short human-readable result/error summary.
_DETAIL_CAP = 200

# The OPENING of a fenced tool_call block. Tolerates trailing spaces after the
# fence word and \r\n line endings. The JSON object that follows is parsed by
# BALANCED-BRACE scanning (see ``_parse_last_tool_call``) rather than by a
# non-greedy ``.*?```` regex, so a ``` code fence inside a JSON string argument
# no longer truncates the body (F2). The LAST opener in a reply wins (models
# sometimes think aloud before the block).
_TOOL_CALL_OPEN_RE = re.compile(r"```tool_call[ \t]*\r?\n")

# The SAME fence, detected PERMISSIVELY (no newline required) — used only by the
# honesty guard below, which must recognise a fence the FIRING parser would
# reject (a truncated `​```tool_call` with nothing after it is not executable, but
# it is still a protocol artefact and must never be shown to a user).
_TOOL_CALL_ANY_RE = re.compile(r"```tool_call")


# ---------------------------------------------------------------------------
# HONESTY GUARD — a tool_call fence must NEVER reach the user as an answer.
#
# The loop's own bound (max_iters) and the F9 "block-only" rule both END a turn
# on a completion that can still CONTAIN a ```tool_call fence: the loop is out
# of turns, or the model wrapped its request in prose so F9 (correctly) refused
# to fire it. Either way the model was still mid-investigation — that text is a
# TOOL REQUEST, not an answer, and rendering it verbatim in chat (as happened
# on 2026-08-17: "The HTTPS fetcher hit a local issue, so I'll search for this
# instead. ```tool_call {...}```") presents an unfinished protocol artefact as
# the assistant's reply.
#
# So: every text this module returns goes through ONE guard that strips the
# fence and, when it stripped one, prefixes an honest INCOMPLETE marker naming
# what really happened. `[incomplete: …]` deliberately does NOT join the
# `[offline:` / `[stub:` / `[rejected:` family (which the clients gate OUT of
# chat entirely) — this text IS real model work, just unfinished, so it must
# still be shown; the marker exists so the UI can present it as an incomplete
# investigation rather than as an answer.
# ---------------------------------------------------------------------------

#: Prefix that marks an unfinished investigation. Stable — clients match on it.
INCOMPLETE_PREFIX = "[incomplete:"

#: Reason text when the loop spent its whole tool-turn budget.
TOOL_TURNS_REASON = (
    "I ran out of tool turns (%d used) while still researching — this is what "
    "I had, not a finished answer."
)
#: Reason text when the run's token budget stopped the loop mid-investigation.
TOKEN_BUDGET_REASON = (
    "I reached this run's token budget after %d tool turns while still "
    "researching — this is what I had, not a finished answer."
)
#: Reason text when a turn ENDED carrying a tool request nothing executed
#: (F9: prose wrapped around the block, or a malformed/truncated fence).
UNEXECUTED_REASON = (
    "I ended my turn still asking to run a tool%s, so nothing more ran — this "
    "is what I had, not a finished answer."
)


def has_tool_call_fence(text: Any) -> bool:
    """True when ``text`` carries a ``tool_call`` fence in any form.

    Deliberately broader than the FIRING parser: a fence the loop would refuse
    to execute is still protocol noise that must not be shown to a user.
    """
    return isinstance(text, str) and _TOOL_CALL_ANY_RE.search(text) is not None


def _block_end(text: str, after_fence: int, names: List[str]) -> int:
    """Index just past the tool_call block whose fence ends at ``after_fence``.

    Reuses the balanced-brace scan so a ``` fence inside a JSON string argument
    cannot end the block early, records the requested tool name when the JSON
    parses, and falls back to the next ```` ``` ```` (or end of text, for an
    unterminated fence) when the payload is malformed. NEVER raises.
    """
    search_from = after_fence
    brace = text.find("{", after_fence)
    if brace != -1:
        obj_str, obj_end = _scan_balanced_object(text, brace)
        if obj_str is not None:
            search_from = obj_end
            try:
                obj = json.loads(obj_str)
            except (json.JSONDecodeError, ValueError):
                obj = None
            if isinstance(obj, dict) and isinstance(obj.get("tool"), str):
                if obj["tool"]:
                    names.append(obj["tool"])
    close = text.find("```", search_from)
    # An UNTERMINATED fence owns the rest of the reply: the model was cut off
    # mid-request, so nothing after the opener is answer text.
    return len(text) if close == -1 else close + 3


def strip_tool_call_blocks(text: str) -> Tuple[str, List[str]]:
    """Remove EVERY ``tool_call`` block; return ``(clean_text, tool_names)``.

    ``tool_names`` are the tools the stripped blocks asked for, in order (empty
    for a malformed block whose JSON never parsed). Whitespace left behind by a
    removed block is tidied (runs of blank lines collapse, ends are stripped).
    A text with no fence comes back byte-identical. NEVER raises.
    """
    if not isinstance(text, str) or not has_tool_call_fence(text):
        return (text if isinstance(text, str) else "", [])
    names: List[str] = []
    out = text
    while True:
        m = _TOOL_CALL_ANY_RE.search(out)
        if m is None:
            break
        out = out[: m.start()] + out[_block_end(out, m.end(), names) :]
    return re.sub(r"\n{3,}", "\n\n", out).strip(), names


_GAP_FENCE_RE = re.compile(r"```capability_gap\b")


def _parse_gap(text: str):
    """The gap a reply reported, or None. Imported late so this module keeps no
    import-time dependency on toolgen."""
    try:
        from .toolgen import parse_gap_block

        return parse_gap_block(text or "")
    except Exception:
        return None


def strip_gap_block(text: str) -> str:
    """Remove a ``capability_gap`` block from answer text.

    It is a protocol artefact, not prose — the same reason a ``tool_call``
    fence is stripped. The model's own words around it survive.
    """
    if not isinstance(text, str):
        return ""
    m = _GAP_FENCE_RE.search(text)
    if m is None:
        return text
    close = text.find("```", m.end())
    end = len(text) if close == -1 else close + 3
    return re.sub(r"\n{3,}", "\n\n", text[: m.start()] + text[end:]).strip()


def mark_incomplete(body: str, reason: str) -> str:
    """Prefix ``body`` with the honest ``[incomplete: <reason>]`` marker.

    ``body`` is text the fences have ALREADY been stripped from. An already
    marked body is returned untouched (the marker is applied exactly once, no
    matter how many guarded paths a string travels through).
    """
    body = (body or "").strip()
    if body.startswith(INCOMPLETE_PREFIX):
        return body
    head = "%s %s]" % (INCOMPLETE_PREFIX, reason)
    return "%s\n\n%s" % (head, body) if body else head


def incomplete_answer(text: str, reason: str) -> str:
    """Strip any tool_call block from ``text`` and mark it incomplete."""
    body, _ = strip_tool_call_blocks(text)
    return mark_incomplete(body, reason)




def guard_answer(text: str) -> str:
    """THE shared guard: make ``text`` safe to show a user as an answer.

    No fence -> returned byte-identical (the overwhelming majority of replies).
    A fence -> stripped, and the remainder marked as an unfinished investigation
    naming the tool that was still being asked for. Every ``run_tool_loop``
    return path goes through this or ``incomplete_answer``, so no completion can
    leave this module carrying an unexecuted tool request.
    """
    # A capability_gap block is protocol too. It is carried out of the loop as
    # a structured field, so it must not ALSO appear as prose in the answer.
    text = strip_gap_block(text)
    if not has_tool_call_fence(text):
        return text
    body, names = strip_tool_call_blocks(text)
    named = " (%s)" % names[-1] if names else ""
    return mark_incomplete(body, UNEXECUTED_REASON % named)


# ---------------------------------------------------------------------------
# Tool-turn budget (FIX 2, 2026-08-18)
#
# The old default was 4, chosen when the only tool source was a toy MCP echo
# server. Real research does not fit in 4: the run that exposed this bug spent
# one turn on a failed web_fetch and three on searches, and was cut off before
# it could re-try the URL — the judge scored it 0.15 and NAMED the tool budget
# as the cause. 12 is the smallest number that fits the shape of a real
# research turn: fetch the named URL, fall back to a search, read the top three
# results, correct the query and read three more — that is 9, and 12 leaves
# headroom for the failed calls every real session has.
#
# It stays BOUNDED, three ways: 12 turns is 13 model calls, each already capped
# at DEFAULT_MAX_TOKENS (4096) output; the loop's own token accounting stops it
# at the run's `token_budget` (the heartbeat wake's 20k binds long before turn
# 12); and MAX_MAX_ITERS is a hard ceiling no env var or caller can exceed.
# ---------------------------------------------------------------------------

#: Tool executions allowed in one model turn when no caller/env says otherwise.
DEFAULT_MAX_ITERS = 12
#: Absolute ceiling — a typo'd env var or a wild caller can never unbound this.
MAX_MAX_ITERS = 32
#: Floor: a loop with tools must be allowed at least one of them.
MIN_MAX_ITERS = 1
#: Env override, e.g. `SCPRISM_TOOL_TURNS=20`. Unset/invalid -> the default.
ENV_TOOL_TURNS = "SCPRISM_TOOL_TURNS"


def default_max_iters() -> int:
    """The tool-turn budget from the environment, clamped, else the default."""
    raw = os.environ.get(ENV_TOOL_TURNS, "").strip()
    if not raw:
        return DEFAULT_MAX_ITERS
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MAX_ITERS
    return max(MIN_MAX_ITERS, min(MAX_MAX_ITERS, value))


def resolve_max_iters(value: Optional[int]) -> int:
    """Resolve a per-run tool-turn budget: explicit > env > default, clamped.

    ``None`` or a non-positive value means "no per-run choice" and defers to
    ``default_max_iters()`` — the same omit-means-default discipline
    ``--token-budget`` uses, so an unset flag changes nothing.
    """
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default_max_iters()
    if n <= 0:
        return default_max_iters()
    return max(MIN_MAX_ITERS, min(MAX_MAX_ITERS, n))


@dataclass
class ToolCallTrace:
    """One executed (or blocked) tool call, for the caller's audit trail."""

    tool: str
    ok: bool
    blocked: bool
    detail: str  # error message, or a short result summary (<= ~200 chars)
    # F1: the result carried sensitive data on a cloud route, so the observation
    # fed back to the model was redacted — the secret never reached the POST.
    withheld: bool = False


@dataclass
class ToolLoopResult:
    """Aggregate outcome of a tool-use loop (drop-in superset of one call)."""

    text: str
    tokens_in: int
    tokens_out: int
    is_real: bool
    iterations: int  # number of tool executions performed
    tool_calls: List[ToolCallTrace]
    # F8: the REAL cache outcome of the final/only model call when the loop made
    # exactly one call and zero tool calls (the tool-less degrade path); "miss"
    # for a genuine multi-turn loop (each turn's real cache is on its own span).
    cache: str = "miss"
    # A capability gap the model reported instead of inventing an answer. None
    # is the ordinary case. Carried OUT of the loop because a gap the user
    # never sees is exactly the silent failure it exists to replace.
    capability_gap: Any = None
    # The FINAL completion was cut off at the provider's output cap, so `text`
    # is incomplete (see ModelCallResult.truncated). Default False = complete.
    truncated: bool = False


def build_tool_manifest(tools: Sequence[MCPTool]) -> str:
    """Render the tool list + protocol instructions for the system message.

    One ``- name: description`` line per tool, each followed by its input
    schema (compact JSON) when the schema is non-empty, then the text
    convention the model must follow.
    """
    lines: List[str] = ["You have access to these external tools:", ""]
    for tool in tools:
        lines.append("- %s: %s" % (tool.name, tool.description))
        if tool.input_schema:
            lines.append(
                "  arguments schema: %s"
                % json.dumps(tool.input_schema, ensure_ascii=False)
            )
    lines += [
        "",
        "To call a tool, reply with ONLY this fenced tool_call block and no "
        "other text (one tool call per reply):",
        "",
        "```tool_call",
        '{"tool": "<name>", "arguments": { ... }}',
        "```",
        "",
        "The result comes back in a ```tool_result``` block on the next user",
        "turn. A reply that is not exactly one tool_call block is your final answer.",
        "",
        # ACT, DON'T NARRATE (2026-08-31). Found live: with the web tools
        # genuinely available, models answered "I cannot search the live web"
        # or "here is my plan — confirm and I will execute", and the run
        # recorded ZERO tool calls. The manifest listed the tools but never
        # said to use them, so a cautious model treated its plan as the final
        # answer. These three lines are the difference between a tool that is
        # offered and a tool that is used.
        "You are ALREADY authorized to use these tools — they were granted for "
        "this task. Do not ask for confirmation and do not describe what you "
        "would do: if a tool can get the answer, call it NOW.",
        "Never claim you cannot search the web, read files, or run commands "
        "when a tool above provides it — you can, through these blocks.",
        "Answer from tool results, not from memory, whenever a tool can supply "
        "the fact. Only give a final answer once you have what you need, or "
        "once you have genuinely tried and the tool could not help.",

        # THE LAST RESORT, and only that. When no tool can do the job, the
        # honest move is to say which tool is missing — not to apologise
        # vaguely, and never to invent an answer. This is the never-fabricate
        # rule given somewhere to go.
        "If NO tool above can do what was asked, do not invent an answer and "
        "do not guess: end your reply with a ```capability_gap block naming "
        "`task:`, `missing:` and `input_shape:`, so the user can decide whether "
        "to have the tool built. Use this only when the tools above genuinely "
        "cannot help — it is a last resort, never a way out of using them.",    ]
    return "\n".join(lines)


def _scan_balanced_object(text: str, start: int) -> Tuple[Optional[str], int]:
    """From ``text[start] == '{'`` return ``(object_substring, index_after)``.

    Balanced-brace scan that respects JSON strings and escapes, so braces (and
    ``` code fences) inside a string value never miscount. Returns
    ``(None, start)`` when the object never closes (unbalanced). NEVER raises.
    """
    depth = 0
    in_str = False
    escaped = False
    n = len(text)
    i = start
    while i < n:
        ch = text[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1], i + 1
        i += 1
    return None, start


def _parse_last_tool_call(
    text: str,
) -> Optional[Tuple[Dict[str, Any], int, int]]:
    """Parse the LAST ``tool_call`` fence's JSON object (F2).

    Locate the last ````tool_call``` opener, then parse the JSON object by
    balanced-brace scanning from the first ``{`` after the fence (a trailing
    ```` ``` ```` fence, and any braces inside JSON strings, are ignored).
    Returns ``(call, fence_start, block_end)`` — ``call`` is the validated
    ``{"tool", "arguments"}`` dict, ``fence_start`` the index of the opening
    ````tool_call``` , ``block_end`` the index just past the closing ```` ``` ````
    (or past the JSON object when no closing fence follows). Returns None on any
    malformed shape. NEVER raises.
    """
    if not isinstance(text, str) or not text:
        return None
    opener = None
    for m in _TOOL_CALL_OPEN_RE.finditer(text):
        opener = m
    if opener is None:
        return None
    brace = text.find("{", opener.end())
    if brace == -1:
        return None
    obj_str, obj_end = _scan_balanced_object(text, brace)
    if obj_str is None:
        return None
    try:
        obj = json.loads(obj_str)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    # The manifest documents ONE shape; models emit several. Being strict cost
    # real turns — a run fired `web_search` twice and executed it with `{}`
    # because the model wrote "parameters" (2026-08-31). Accept the aliases the
    # models actually use; a call already using "tool"/"arguments" is unaffected.
    tool = obj.get("tool")
    if not isinstance(tool, str) or not tool:
        tool = obj.get("name")
    if not isinstance(tool, str) or not tool:
        return None
    arguments = None
    for key in ("arguments", "parameters", "input", "args"):
        if key in obj:
            arguments = obj[key]
            break
    if arguments is None:
        # No wrapper at all: the parameters sit beside the tool name, which is
        # the commonest miss of the four.
        arguments = {k: v for k, v in obj.items() if k not in ("tool", "name")}
    if not isinstance(arguments, dict):
        return None
    # Extend the block past an optional trailing ```` ``` ```` fence (allowing
    # whitespace between the JSON object and the fence) so the caller can strip
    # the WHOLE block when deciding block-only firing.
    j = obj_end
    n = len(text)
    while j < n and text[j] in " \t\r\n":
        j += 1
    block_end = j + 3 if text[j : j + 3] == "```" else obj_end
    return {"tool": tool, "arguments": arguments}, opener.start(), block_end


def parse_tool_call(text: str) -> Optional[Dict[str, Any]]:
    """Extract ``{"tool": ..., "arguments": ...}`` from a model reply, or None.

    The LAST fenced ``tool_call`` block wins, parsed robustly (F2 — balanced
    braces, so a ``` fence inside a JSON string arg no longer truncates it).
    Strict on shape — the JSON must be an object with a non-empty string
    ``"tool"`` and an object (or absent, meaning ``{}``) ``"arguments"``.
    Anything malformed returns None (the reply is then a final answer). NEVER
    raises. (Parsing is location-agnostic; the LOOP additionally requires the
    block to be the whole reply before firing — see ``_tool_call_if_block_only``.)
    """
    res = _parse_last_tool_call(text)
    return None if res is None else res[0]


def _tool_call_if_block_only(text: str) -> Optional[Dict[str, Any]]:
    """The parsed tool call ONLY when the fenced block IS the entire reply (F9).

    A tool fires only when, after removing the matched ````tool_call``` block,
    the remaining text is empty/whitespace — the protocol's "reply with ONLY
    the tool_call block". This kills both the offline-stub echoing the prompt
    (prose around a block) and a real model quoting the block in prose: those
    are treated as final answers, never a phantom tool execution.
    """
    res = _parse_last_tool_call(text)
    if res is None:
        return None
    call, fence_start, block_end = res
    if (text[:fence_start] + text[block_end:]).strip():
        return None
    return call


def _summarize(content: Any) -> str:
    """Compact one-line string of a tool result's content, capped for traces."""
    if isinstance(content, str):
        text = content
    else:
        try:
            text = json.dumps(content, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(content)
    text = " ".join(text.split())
    if len(text) > _DETAIL_CAP:
        text = text[: _DETAIL_CAP - 1] + "…"
    return text


def run_tool_loop(
    *,
    messages: List[Dict[str, Any]],
    tools: Optional[Sequence[MCPTool]],
    model_fn: Callable[[List[Dict[str, Any]]], Any],
    tool_exec: Callable[[str, Dict[str, Any]], Dict[str, Any]],
    max_iters: Optional[int] = None,
    guard_observation: Optional[Callable[[str], Tuple[str, bool]]] = None,
    token_budget: Optional[int] = None,
) -> ToolLoopResult:
    """Run the bounded model tool-use loop; return the final aggregate result.

    ``messages`` are the base OpenAI-style messages (never mutated). ``tools``
    are the advertised MCPTools; empty/None takes the byte-identical fast path
    (no manifest, exactly one ``model_fn`` call). ``model_fn`` performs ONE
    completion per invocation and owns its ``model_call`` span (its return is
    duck-typed on ``.text`` / ``.tokens_in`` / ``.tokens_out`` / ``.is_real``,
    plus an optional ``.cache`` read for the degrade path — F8). ``tool_exec``
    is the governed call (owns gates + its ``tool_exec`` span). A gate block
    raises ``MCPBlockedError`` → a truthful ``ok:false, blocked:true``
    observation; an infra fault (broken pipe / timeout / JSON-RPC error) raises
    plain ``MCPError`` → ``ok:false, blocked:false`` (a fault is not a
    governance block — F6). Any OTHER exception propagates: a protocol/infra
    bug is not the model's business to route around.

    ``guard_observation`` (F1) — the tool-RESULT egress gate. Before EACH
    ``tool_result`` observation is fed back, it is called on the observation's
    content (a JSON string) and returns ``(safe_content, withheld)``. On a
    cloud route the caller passes a guard that redacts sensitive content so the
    secret NEVER reaches the next POST; ``withheld`` is recorded truthfully on
    the ``ToolCallTrace``. Default None = identity (byte-identical).

    Bounds: at most ``max_iters`` tool executions and ``max_iters + 1`` model
    calls. ``max_iters`` defaults to ``None`` = ``resolve_max_iters(None)`` —
    the ``SCPRISM_TOOL_TURNS`` env value, else ``DEFAULT_MAX_ITERS``; any
    explicit value is clamped to ``[MIN_MAX_ITERS, MAX_MAX_ITERS]`` so no caller
    can unbound the loop. When the budget is exhausted and the model still asks
    for a tool, the reply comes back as an honest INCOMPLETE INVESTIGATION.
    ``token_budget`` (F7) — when set, before EACH model call after the first the
    accumulated (in+out) tokens are checked; at/over budget the loop stops and
    returns the last text marked incomplete for the token-budget reason
    (distinct from the tool-turn reason). None = off.

    HONESTY (2026-08-18): every returned ``text`` passes through
    ``guard_answer`` / ``incomplete_answer``, so a completion that still carries
    a ``tool_call`` fence NEVER leaves here as an answer — the fence is stripped
    and the remainder is prefixed with ``[incomplete: …]`` naming what stopped
    the investigation. A completion with no fence is byte-identical.
    """
    max_iters = resolve_max_iters(max_iters)
    if not tools:
        res = model_fn(messages)
        return ToolLoopResult(
            # A tool-less run should never produce a fence at all (no manifest
            # was sent), but a model that invents one must still not have it
            # rendered as chat — the guard is a no-op on every normal reply.
            text=guard_answer(res.text),
            tokens_in=int(res.tokens_in),
            tokens_out=int(res.tokens_out),
            is_real=bool(res.is_real),
            iterations=0,
            tool_calls=[],
            capability_gap=_parse_gap(res.text),
            # F8: exactly one call, zero tool calls — the FINAL/only call's real
            # cache outcome (the tool-less degrade path's honest attribution).
            cache=str(getattr(res, "cache", "miss")),
            truncated=bool(getattr(res, "truncated", False)),
        )

    # Copy (messages list + each dict) so the caller's messages never mutate.
    cur: List[Dict[str, Any]] = [dict(m) for m in messages]
    manifest = build_tool_manifest(tools)
    for msg in cur:
        if msg.get("role") == "system":
            msg["content"] = str(msg.get("content", "")) + "\n\n" + manifest
            break
    else:
        cur.insert(0, {"role": "system", "content": manifest})

    tokens_in = 0
    tokens_out = 0
    is_real = False
    traces: List[ToolCallTrace] = []
    iters = 0
    calls = 0
    res: Any = None
    while True:
        # F7: token budget is checked BEFORE each call after the first — the
        # first completion always runs; a tight budget then stops the loop with
        # an honest note distinct from the max-iters note. ``res`` is the last
        # completion (the tool request that would trigger the next call).
        if (
            calls > 0
            and token_budget is not None
            and (tokens_in + tokens_out) >= token_budget
        ):
            return ToolLoopResult(
                text=incomplete_answer(res.text, TOKEN_BUDGET_REASON % iters),
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                is_real=is_real,
                iterations=iters,
                tool_calls=traces,
                cache="miss",
                truncated=bool(getattr(res, "truncated", False)),
            )

        res = model_fn(cur)
        calls += 1
        tokens_in += int(res.tokens_in)
        tokens_out += int(res.tokens_out)
        # `is_real` DESCRIBES THE TEXT WE WILL RETURN, so it tracks the latest
        # completion rather than accumulating.
        #
        # It used to be `is_real or bool(res.is_real)` — sticky across the whole
        # loop. Every return site below pairs that accumulated flag with text
        # taken from the LAST `res`, so the two could describe different calls,
        # and on 2026-08-27 they did: a team lead answered its first turn for
        # real, read a vault note, and its second turn died with an
        # IncompleteRead. The loop returned the `[offline:…]` stand-in as its
        # text and `is_real=True` beside it, and the board printed a stand-in
        # labelled a genuine reply.
        #
        # Tokens still accumulate — every call really was paid for. Realness
        # cannot, because it is a claim about one particular piece of text.
        is_real = bool(res.is_real)

        # F9: a tool fires ONLY when the fenced block IS the whole reply; prose
        # around a block (stub echoing the prompt, or a model quoting the block)
        # is a final answer, never a phantom execution.
        call = _tool_call_if_block_only(res.text)
        if call is None:
            # No (block-only) tool_call — this is the final answer. F8: when it
            # is the FIRST and only call with zero tool calls, propagate that
            # call's REAL cache; a genuine multi-turn loop stays "miss".
            #
            # HONESTY: "no block-only tool_call" is NOT the same as "no tool
            # call". F9 lands prose-wrapped and malformed requests here on
            # purpose (they must never fire a phantom tool) — and that is
            # exactly how a raw ```tool_call fence reached the user's chat. The
            # guard strips it and says the turn ended mid-request; a genuine
            # final answer has no fence and passes through untouched.
            return ToolLoopResult(
                text=guard_answer(res.text),
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                is_real=is_real,
                iterations=iters,
                tool_calls=traces,
                capability_gap=_parse_gap(res.text),
                cache=(
                    str(getattr(res, "cache", "miss"))
                    if calls == 1 and iters == 0
                    else "miss"
                ),
                truncated=bool(getattr(res, "truncated", False)),
            )
        if iters >= max_iters:
            # Budget spent and the model wants another tool: stop honestly. The
            # request it just made is UNEXECUTED, so it is stripped rather than
            # shown — what the user gets is the prose plus the honest count.
            return ToolLoopResult(
                text=incomplete_answer(res.text, TOOL_TURNS_REASON % max_iters),
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                is_real=is_real,
                iterations=iters,
                tool_calls=traces,
                cache="miss",
                truncated=bool(getattr(res, "truncated", False)),
            )

        name = call["tool"]
        blocked = False
        observed: Any
        try:
            result = tool_exec(name, call["arguments"])
            ok = not bool(result.get("isError"))
            detail = _summarize(result.get("content"))
            # Success feeds back the server's REAL content; a failed call
            # feeds back the error text. Nothing is ever fabricated.
            observed = result.get("content") if ok else detail
        except MCPBlockedError as exc:
            # F6: a real GOVERNANCE block (allowlist / sensitivity gate).
            ok = False
            blocked = True
            detail = str(exc)
            observed = detail
        except MCPError as exc:
            # F6: an INFRA fault (broken pipe / timeout / JSON-RPC error) — an
            # honest failed observation, NOT a governance block (blocked=False),
            # so the trace agrees with the tool_exec span.
            ok = False
            blocked = False
            detail = str(exc)
            observed = detail

        # F1: gate the tool RESULT before it can egress to a cloud model. On a
        # cloud route ``guard_observation`` redacts sensitive content so the
        # secret NEVER reaches the next POST; the withholding is recorded
        # truthfully. None (local route / no guard) = identity, byte-identical.
        withheld = False
        if guard_observation is not None:
            raw = (
                observed
                if isinstance(observed, str)
                else json.dumps(observed, ensure_ascii=False)
            )
            safe, was_withheld = guard_observation(raw)
            if was_withheld:
                observed = safe
                withheld = True
        traces.append(
            ToolCallTrace(
                tool=name, ok=ok, blocked=blocked, detail=detail, withheld=withheld
            )
        )

        cur.append({"role": "assistant", "content": res.text})
        observation = json.dumps(
            {"tool": name, "ok": ok, "content": observed}, ensure_ascii=False
        )
        cur.append({"role": "user", "content": "```tool_result\n%s\n```" % observation})
        iters += 1
