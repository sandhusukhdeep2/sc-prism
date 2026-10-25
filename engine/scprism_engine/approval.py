"""Engine-level approval gate (MCP follow-ons) — hold a tool call for sign-off.

The tool-use loop already runs TWO gates before any bytes egress: the allowlist
(an unlisted tool is blocked) and the sensitivity gate (arguments carrying a
secret are blocked). This adds a THIRD, human/policy gate on TOP of those: some
tool calls are **held** for explicit approval before they run — the multi-user /
stricter-governance primitive.

Two small pieces, both stdlib-only:

  * ``ToolApprovalPolicy(require, granted)`` — the decision. ``require`` is a set
    of server-or-tool names (or the sentinel ``"all"``); ``granted`` is the set
    already approved for this run. ``.decide(server, tool, args, provider)``
    returns ``"allow"`` or ``"hold"``: a call is HELD when it (or its server, or
    ``"all"``) is required and NOT granted. Empty ``require`` (the default) →
    everything ``"allow"`` → byte-identical to no policy at all.

    Since 2026-08-17 ``granted`` may carry ``toolrisk.READ_ONLY_GRANT``
    (``"read-only"``), meaning "let the RISK CLASSIFICATION decide": a call
    ``toolrisk.classify`` proves READ_ONLY (a first-party observing tool —
    vault reads, web reads) runs without a prompt, while everything else,
    including every unknown third-party MCP tool, is held exactly as before.
    See ``toolrisk.py`` for the classification and why its default is
    conservative. Without the sentinel nothing changes: byte-identical.

  * ``ApprovalGate(source, policy)`` — a duck-typed tool source WRAPPING another
    (an ``MCPClient``, a ``WebToolProvider``, or a ``CompositeToolClient``).
    ``list_tools`` / ``parent_span_id`` pass through untouched; ``call_tool``
    FIRST consults the policy:

      - ``"hold"`` → emit a ``tool_exec`` span with ``held=True`` (provider from
        the inner source, the tool name, NO egress) and return an HONEST held
        result (``isError``-shaped, ``held=True``): the model sees a truthful
        "needs approval — not run" observation, the loop continues, and NOTHING
        egresses. The inner source's ``call_tool`` is NEVER invoked.
      - ``"allow"`` → delegate to the inner ``call_tool``, which STILL runs the
        allowlist + sensitivity gates before egress. Approval is on top of,
        never instead of, those.

    The held path runs BEFORE the inner source can touch a socket — that is the
    security boundary. A held call never egresses and never fabricates success.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Set

from .mcp import MCPError
from . import toolrisk

# Sentinel name meaning "match every server / every tool".
ALL = "all"


def _normalize(value: Any) -> Set[str]:
    """Coerce a policy field (None / str / iterable of str) into a name set.

    ``None`` → empty. A bare string (e.g. ``"all"`` or ``"echo,add"``) is split
    on commas. An iterable yields its stripped, non-empty members. Whitespace is
    trimmed and empties dropped so ``"a, ,b"`` → ``{"a", "b"}``.
    """
    if value is None:
        return set()
    if isinstance(value, str):
        return {part.strip() for part in value.split(",") if part.strip()}
    out: Set[str] = set()
    for item in value:
        for part in str(item).split(","):
            part = part.strip()
            if part:
                out.add(part)
    return out


class ToolApprovalPolicy:
    """Decide whether a tool call is allowed or must be HELD for approval.

    A call is HELD when it (or its server, or ``"all"``) is in ``require`` and
    NOT covered by ``granted``. Empty ``require`` → everything allowed (the
    default, byte-identical to no policy). ``require`` may be the literal string
    ``"all"`` (hold everything ungranted) or a set of server/tool names.

    ``granted`` may additionally carry ``toolrisk.READ_ONLY_GRANT`` — the
    class-level grant. It frees exactly the calls ``toolrisk.classify`` proves
    read-only and nothing else; it is NOT a wildcard, and in particular it never
    frees an MCP tool (see ``toolrisk``: an unknown MCP tool is ACTING).
    """

    def __init__(self, require: Any = None, granted: Any = None) -> None:
        self.require: Set[str] = _normalize(require)
        self.granted: Set[str] = _normalize(granted)

    def is_active(self) -> bool:
        """True when the policy can hold anything (a non-empty ``require``).

        When False, the caller skips the wrapper entirely → byte-identical."""
        return bool(self.require)

    def _required(self, server: str, tool: str) -> bool:
        r = self.require
        return ALL in r or tool in r or server in r

    def _granted(self, server: str, tool: str) -> bool:
        g = self.granted
        return ALL in g or tool in g or server in g

    def reads_run_free(self) -> bool:
        """True when the read-only CLASS may run unheld.

        ``granted`` must carry the class name AND ``require`` must not demand it
        back: ``require`` containing ``"read-only"`` reads literally as "require
        approval for the read-only class", which is a user who deliberately
        chose hold-everything. REQUIRE WINS — a user tightening up must never
        lose to a grant left behind in the file."""
        return (
            toolrisk.READ_ONLY_GRANT in self.granted
            and toolrisk.READ_ONLY_GRANT not in self.require
        )

    def decide(
        self,
        server: str,
        tool: str,
        arguments: Any = None,
        provider: Optional[str] = None,
    ) -> str:
        """``"allow"`` or ``"hold"`` for one tool call. THE ENFORCEMENT POINT.

        Order: not required → allow. Named in ``granted`` (tool / server /
        ``"all"``) → allow. Otherwise, if the user granted the read-only CLASS
        and ``toolrisk`` proves THIS call read-only → allow. Everything else →
        hold, unchanged.

        ``provider`` is the calling source's audit tag, passed by
        ``ApprovalGate.call_tool``. It is the ONLY input the classification
        trusts to identify a first-party source; omitted/unknown → ``ACTING`` →
        held, so a caller that forgets it fails safe.

        ``arguments`` is accepted for a future argument-aware policy but is
        unused today (the allowlist + sensitivity gates already inspect args on
        the allowed path)."""
        if not self._required(server, tool):
            return "allow"
        if self._granted(server, tool):
            return "allow"
        if self.reads_run_free() and toolrisk.is_read_only(provider, tool):
            return "allow"
        return "hold"


def _held_result(tool: str) -> Dict[str, Any]:
    """The honest observation for a HELD call — ``isError``-shaped, ``held``.

    Never a fabricated success: the model reads a truthful "needs approval — not
    run" note and the loop treats it as ``ok:false``."""
    return {
        "isError": True,
        "held": True,
        "content": [
            {
                "type": "text",
                "text": "held: tool '%s' needs approval — not run" % tool,
            }
        ],
    }


class BlockingApprovalBroker:
    """A vault-file handshake that PAUSES a held tool call until the user decides.

    The engine runs headless and the app polls the vault, so the pause is a file
    handshake — no new socket/streaming infra:

      1. ``await_decision`` writes ``<vault>/approvals/pending/<id>.json`` (the
         request dict) ATOMICALLY (temp file + ``os.replace``), then BLOCKS.
      2. It polls ``<vault>/approvals/decided/<id>.json`` every ``poll`` seconds,
         up to ``timeout`` seconds.
      3. The app surfaces the pending request, the user clicks Approve/Deny, and
         the app writes ``decided/<id>.json`` = ``{"decision": "allow"|"deny"}``.
      4. The broker reads it → ``"allow"``/``"deny"``; the bound elapsing →
         ``"timeout"``. Either way it best-effort removes BOTH files and returns.

    The pause is REAL (the subprocess blocks polling) but BOUNDED (``timeout``) —
    a run can NEVER hang forever. The broker NEVER raises out: any OSError / JSON
    error resolves to ``"timeout"`` so the run continues honestly (the caller
    returns the honest ``_held_result`` — the tool is truthfully NOT run, never
    fabricated). ``sleep`` / ``now`` are injectable so unit tests use NO real
    sleep (a fake ``sleep`` that advances a fake ``now`` drives the timeout).
    """

    def __init__(
        self,
        vault: str,
        timeout: float = 300.0,
        poll: float = 0.5,
        sleep: Any = time.sleep,
        now: Any = time.time,
        monotonic: Any = time.monotonic,
    ) -> None:
        self.vault = vault
        # Clamp a non-finite (inf/nan) or non-positive timeout to the default:
        # ``--approval-timeout inf`` would make the deadline loop's ``now - start
        # < inf`` always true → an infinite hang, defeating the headline "a run
        # can NEVER hang forever". nan/≤0 are clamped too for clarity/safety.
        self.timeout = timeout if (math.isfinite(timeout) and timeout > 0) else 300.0
        self.poll = poll
        self._sleep = sleep
        self._now = now
        # The DEADLINE is measured on a MONOTONIC clock so a backward wall-clock
        # step (NTP / manual set) during the pause cannot stretch the bound past
        # ``timeout``. ``_now`` (wall clock) stays only for the human-readable
        # ``"at"`` timestamp the app shows.
        self._monotonic = monotonic

    # -- request minting ------------------------------------------------

    def make_request(
        self, server: str, tool: str, arguments: Any, run_id: str
    ) -> Dict[str, Any]:
        """Mint the request dict the app reads (fresh ``uuid4`` id, trimmed args).

        ``args_summary`` is a best-effort ``json.dumps`` trimmed to ~200 chars so
        the app can show WHAT is being approved without leaking a huge payload."""
        try:
            summary = json.dumps(arguments, ensure_ascii=False, sort_keys=True)
        except (TypeError, ValueError):
            summary = repr(arguments)
        if len(summary) > 200:
            summary = summary[:197] + "..."
        return {
            "id": uuid.uuid4().hex,
            "run_id": run_id or "",
            "server": server,
            "tool": tool,
            "args_summary": summary,
            "at": self._now(),
        }

    # -- the bounded wait ----------------------------------------------

    def await_decision(self, request: Dict[str, Any]) -> str:
        """Write the pending request, poll for a decision, return the outcome.

        Returns ``"allow"`` / ``"deny"`` / ``"timeout"``. NEVER raises: a write
        failure or the bound elapsing → ``"timeout"``; a decided file that parses
        to anything other than ``{"decision": "allow"}`` → ``"deny"``; a decided
        file that fails to parse (a partial write) is treated as not-yet-decided
        and polling continues (a permanently-bad file → ``"timeout"``). Best-effort
        removes BOTH the pending and decided files on the way out."""
        try:
            request_id = str(request["id"])
        except (KeyError, TypeError):
            return "timeout"
        pending_dir = os.path.join(self.vault, "approvals", "pending")
        decided_dir = os.path.join(self.vault, "approvals", "decided")
        pending_path = os.path.join(pending_dir, "%s.json" % request_id)
        decided_path = os.path.join(decided_dir, "%s.json" % request_id)
        try:
            try:
                os.makedirs(pending_dir, exist_ok=True)
                os.makedirs(decided_dir, exist_ok=True)
                _atomic_write_json(pending_path, request)
            except (OSError, TypeError, ValueError):
                # Cannot even publish the request → nothing to approve; the run
                # continues honestly (the held tool is not run).
                return "timeout"
            # Deadline on the MONOTONIC clock (never wall-clock): a backward NTP
            # or manual clock step during the wait cannot extend the bound.
            start = self._monotonic()
            while self._monotonic() - start < self.timeout:
                decision = self._read_decision(decided_path)
                if decision is not None:
                    return decision
                self._sleep(self.poll)
            return "timeout"
        finally:
            _best_effort_remove(pending_path)
            _best_effort_remove(decided_path)

    def _read_decision(self, decided_path: str) -> Optional[str]:
        """``"allow"`` / ``"deny"`` when the decided file is present and parses;
        ``None`` when it is absent OR fails to parse (treated as not-yet-decided,
        so a partial write self-heals on the next poll)."""
        if not os.path.exists(decided_path):
            return None
        try:
            with open(decided_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return None  # partial/unreadable write → keep polling
        decision = data.get("decision") if isinstance(data, dict) else None
        return "allow" if decision == "allow" else "deny"


def _atomic_write_json(path: str, obj: Any) -> None:
    """Write ``obj`` as JSON to ``path`` atomically (temp file + ``os.replace``).

    The temp file lives in the SAME directory so ``os.replace`` is atomic (same
    filesystem). Cleans up the temp file if the write or rename fails."""
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)  # atomic on POSIX
    finally:
        if os.path.exists(tmp):
            _best_effort_remove(tmp)


def _best_effort_remove(path: str) -> None:
    """Remove ``path`` if present; swallow any OSError (cleanup must not raise)."""
    try:
        os.remove(path)
    except OSError:
        pass


class ApprovalGate:
    """A tool source that HOLDS required-but-ungranted calls for sign-off.

    Wraps another duck-typed source (``MCPClient`` / ``WebToolProvider`` /
    ``CompositeToolClient``). ``list_tools`` and ``parent_span_id`` pass through;
    ``call_tool`` consults ``policy`` first and either holds (honest result +
    ``held=True`` span, no egress, inner never called) or delegates to the inner
    source (which still runs its own gates). Any attribute the gate does not
    define is delegated to the wrapped source, so the loop's span-attribution
    reads (``_owner`` / ``provider`` / ``server_name``) stay transparent.
    """

    def __init__(
        self,
        source: Any,
        policy: ToolApprovalPolicy,
        broker: Optional["BlockingApprovalBroker"] = None,
    ) -> None:
        self.source = source
        self.policy = policy
        # Optional mid-run blocking broker. None (the default) → the held call is
        # observed and the loop continues (today's behavior, byte-identical). Set
        # → a held call PAUSES for the user's Approve/Deny (bounded) and, on
        # "allow", the tool actually runs.
        self.broker = broker

    # -- transparency ---------------------------------------------------

    def __getattr__(self, name: str) -> Any:
        # Only reached for attributes NOT set on the gate itself. Delegate to the
        # wrapped source so provider/server_name/_owner/telemetry/sources used by
        # the loop's attribution keep working through the wrapper.
        try:
            source = self.__dict__["source"]
        except KeyError:  # during __init__, before source is bound
            raise AttributeError(name)
        return getattr(source, name)

    @property
    def parent_span_id(self) -> Optional[str]:
        return getattr(self.source, "parent_span_id", None)

    @parent_span_id.setter
    def parent_span_id(self, value: Optional[str]) -> None:
        try:
            self.source.parent_span_id = value
        except Exception:  # noqa: BLE001 — a source without the attr is fine
            pass

    def list_tools(self) -> List[Any]:
        return self.source.list_tools()

    # -- the gated call -------------------------------------------------

    def _owning_source(self, name: str) -> Any:
        """The concrete source that would serve ``name`` (for attribution).

        A ``CompositeToolClient`` routes by name via its ``_owner`` map, so the
        held span is attributed to the real owning provider (mcp vs web). Any
        other (single) source serves the tool itself."""
        owner_map = getattr(self.source, "_owner", None)
        if isinstance(owner_map, dict):
            if not owner_map:
                # The loop lists before calling, but be robust if a direct caller
                # did not — build the ownership map so routing is correct.
                try:
                    self.source.list_tools()
                except Exception:  # noqa: BLE001 — a broken source must not crash the gate
                    pass
                owner_map = getattr(self.source, "_owner", {})
            owner = owner_map.get(name)
            if owner is not None:
                return owner
        return self.source

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        arguments = arguments or {}
        owner = self._owning_source(name)
        server = getattr(owner, "server_name", getattr(self.source, "server_name", "mcp"))
        # The audit tag of the source that will actually serve this call. It is
        # resolved HERE, before the decision, because the risk classification
        # keys on it (toolrisk.classify) — a source we could not route to yields
        # "mcp", which classifies ACTING, so an unroutable call stays held.
        provider = toolrisk.provider_of(owner, self.source)
        decision = self.policy.decide(server, name, arguments, provider=provider)
        if decision == "hold":
            # HELD: emit a held=True tool_exec span (provider from the inner
            # source), return an honest held result, and NEVER touch the inner
            # source — nothing egresses. This is the security boundary.
            telemetry = getattr(owner, "telemetry", None) or _find_telemetry(self.source)
            if self.broker is None:
                if telemetry is not None:
                    with telemetry.span(
                        "tool_exec",
                        span_type="tool_exec",
                        parent=self.parent_span_id,
                        provider=provider,
                        server=server,
                        tool=name,
                        held=True,
                    ) as sp:
                        # `risk` records how the classification saw THIS call, so
                        # the audit and the app can say why it waited: "acting"
                        # (it could change something) vs "read-only" (it only
                        # looks — held because the user chose hold-everything).
                        sp.set(
                            reason="held: tool needs approval — not run",
                            risk=toolrisk.classify(provider, name),
                        )
                        sp.set_status("error")
                return _held_result(name)
            # BLOCKING (opt-in): PAUSE this held call for the user's Approve/Deny
            # via the vault handshake. The wait is REAL but BOUNDED (the broker's
            # timeout) — never a forever-hang. Nothing has egressed: the inner
            # source is only ever touched on "allow", below.
            run_id = getattr(telemetry, "run_id", None) or self.parent_span_id or ""
            request = self.broker.make_request(server, name, arguments, run_id)
            self._emit_await_span(
                telemetry, provider, server, name, request, resolved=None
            )
            outcome = self.broker.await_decision(request)
            self._emit_await_span(
                telemetry, provider, server, name, request, resolved=outcome
            )
            if outcome == "allow":
                # DELEGATE: the inner source now runs its OWN allowlist +
                # sensitivity gates before any egress — the security boundary is
                # unchanged; approval is on top of, never instead of, those.
                return self.source.call_tool(name, arguments)
            # "deny" / "timeout" → the honest held observation (tool NOT run).
            return _held_result(name)
        # ALLOWED: delegate to the inner source, which STILL runs the allowlist +
        # sensitivity gates before any egress (approval is additive, not a
        # replacement).
        return self.source.call_tool(name, arguments)

    def _emit_await_span(
        self,
        telemetry: Any,
        provider: str,
        server: str,
        tool: str,
        request: Dict[str, Any],
        resolved: Optional[str],
    ) -> None:
        """Emit the blocking path's ``awaiting``/``resolved`` tool_exec span.

        ``resolved is None`` → the pause STARTED (``awaiting=True``, status ok);
        ``resolved`` set → the outcome (``resolved="allow"|"deny"|"timeout"``,
        status ok only for ``"allow"``). Both carry ``held=True`` so the Manager
        View can show the pause honestly. No telemetry → a silent no-op."""
        if telemetry is None:
            return
        if resolved is None:
            reason = "awaiting approval — run paused"
            status = "ok"
        elif resolved == "allow":
            reason = "approved — running"
            status = "ok"
        else:
            reason = "%s — tool not run" % (
                "denied" if resolved == "deny" else "timed out"
            )
            status = "error"
        with telemetry.span(
            "tool_exec",
            span_type="tool_exec",
            parent=self.parent_span_id,
            provider=provider,
            server=server,
            tool=tool,
            held=True,
            awaiting=True,
        ) as sp:
            sp.set(reason=reason, request_id=request.get("id"))
            if resolved is not None:
                sp.set(resolved=resolved)
            sp.set_status(status)


def _find_telemetry(source: Any) -> Optional[Any]:
    """The Telemetry a source (or one of a composite's sub-sources) writes to."""
    telemetry = getattr(source, "telemetry", None)
    if telemetry is not None:
        return telemetry
    for sub in getattr(source, "sources", None) or []:
        telemetry = getattr(sub, "telemetry", None)
        if telemetry is not None:
            return telemetry
    return None


def _string_names(value: Any, cfg: str, field: str) -> Set[str]:
    """Validate + normalize a policy-file field into a name set.

    Accepts ``None`` (→ empty), a string (``"all"`` / comma-list), or a list of
    strings. Anything else raises ``MCPError`` (honest error, no crash)."""
    if value is None:
        return set()
    if isinstance(value, str):
        return _normalize(value)
    if isinstance(value, list) and all(isinstance(part, str) for part in value):
        return _normalize(value)
    raise MCPError(
        "MCP approvals %r field %r must be a string or a list of strings"
        % (cfg, field)
    )


def load_approval_policy(
    vault: str,
    *,
    require: Any = None,
    approve: Any = None,
    path: Optional[str] = None,
) -> ToolApprovalPolicy:
    """Build the run's ``ToolApprovalPolicy`` from a vault file + CLI flags.

    Reads ``<vault>/mcp-approvals.json`` (``{"require":[...],"granted":[...]}``)
    when present, then UNIONs the CLI ``require`` / ``approve`` names on top.
    Absent file and empty flags → an empty (inactive) policy → byte-identical. A
    malformed file raises ``MCPError`` so the caller can report an honest error
    and exit cleanly (the run never crashes with a traceback)."""
    req: Set[str] = set()
    grant: Set[str] = set()
    cfg = path or os.path.join(vault, "mcp-approvals.json")
    if os.path.exists(cfg):
        try:
            with open(cfg, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            raise MCPError("failed to read MCP approvals %r: %r" % (cfg, exc))
        if not isinstance(data, dict):
            raise MCPError("MCP approvals %r must be a JSON object" % cfg)
        req |= _string_names(data.get("require"), cfg, "require")
        grant |= _string_names(data.get("granted"), cfg, "granted")
    req |= _normalize(require)
    grant |= _normalize(approve)
    return ToolApprovalPolicy(require=req, granted=grant)
