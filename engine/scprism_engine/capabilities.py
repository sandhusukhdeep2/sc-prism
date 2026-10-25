"""Per-agent capabilities — the grant a sub-agent actually runs under.

Sukh (the manager) may staff a project with sub-agents and hand each one a set
of capabilities. This module is where that grant becomes REAL. Two rules, and
this file is the only place either is decided:

  1. **No privilege escalation.** A sub-agent's grant is the INTERSECTION of
     what the manager asked for with what the USER themselves has. The manager
     can never grant what the user did not — and because the intersection is
     taken in ``AgentGrants.__init__`` (not in a UI, not at a call site), there
     is no path through this engine on which an over-broad request survives.
     What the manager over-asked for is kept as ``escalations`` so the run can
     say so honestly instead of quietly shrinking the grant.

  2. **Shown means enforced.** A capability is refused by the ENGINE, not by a
     disabled button. ``AgentCapabilityGate`` wraps the run's tool source in the
     same duck-typed way ``approval.ApprovalGate`` does: an ungranted tool is
     never listed and, if called anyway, is REFUSED before the inner source is
     touched — no egress, no vault read, an honest ``isError`` observation the
     model can see, and a ``refused=True`` ``tool_exec`` span in the audit trail.

The vocabulary is exactly the four things the product offers and can enforce:

  ``vault``  — read the user's own notes (the ``vault`` tool provider)
  ``web``    — fetch/search the internet (the ``web`` tool provider)
  ``tools``  — the user's own MCP servers (every other tool provider)
  ``writes`` — write files into the bound project (``project.apply_file_ops``)

There is deliberately no capability this module cannot enforce. A name that is
not in ``CAPABILITIES`` is dropped by ``normalize`` rather than stored as a
decorative string, because a capability we only display is the cardinal sin.
"""

from __future__ import annotations

import os
import re
import json
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

# ---------------------------------------------------------------------------
# The vocabulary
# ---------------------------------------------------------------------------

VAULT = "vault"
WEB = "web"
COMPUTER = "computer"
TERMINAL = "terminal"
TOOLS = "tools"
WRITES = "writes"

CAPABILITIES = (VAULT, WEB, COMPUTER, TERMINAL, TOOLS, WRITES)

#: A tool source's ``provider`` tag -> the capability it needs. Anything else
#: (an MCP server, whose provider tag is its own name) needs ``tools``.
_PROVIDER_CAPABILITY = {VAULT: VAULT, WEB: WEB, COMPUTER: COMPUTER, TERMINAL: TERMINAL}

#: Plain words for a refusal sentence a person reads.
CAPABILITY_WORDS = {
    VAULT: "read your vault",
    WEB: "use the web",
    COMPUTER: "control this computer",
    TERMINAL: "run terminal commands",
    TOOLS: "use your tools",
    WRITES: "write project files",
}


class CapabilityDenied(RuntimeError):
    """An agent attempted something outside its grant. Carries the reason."""

    def __init__(self, reason: str, agent: str = "", capability: str = "") -> None:
        super().__init__(reason)
        self.reason = reason
        self.agent = agent
        self.capability = capability


def capability_for_provider(provider: str) -> str:
    """The capability a tool source's ``provider`` tag requires."""
    return _PROVIDER_CAPABILITY.get((provider or "").strip().lower(), TOOLS)


def normalize(caps: Optional[Iterable[str]]) -> frozenset:
    """A clean capability set: lowercased, trimmed, KNOWN names only.

    An unknown name is dropped, never kept: a capability this engine cannot
    enforce must not be carried around looking like one it can.
    """
    if not caps:
        return frozenset()
    if isinstance(caps, str):
        caps = caps.split(",")
    out = set()
    for cap in caps:
        name = str(cap or "").strip().lower()
        if name in CAPABILITIES:
            out.add(name)
    return frozenset(out)


# Split an `allowed-tools` value. The spec writes it space-separated
# ("Bash(git:*) Bash(jq:*) Read"); commas are accepted too because a user
# hand-editing frontmatter will reach for them.
_ALLOWED_TOOLS_SPLIT_RE = re.compile(r"[\s,]+")


def parse_allowed_tools(raw) -> Optional[frozenset]:
    """A skill's ``allowed-tools`` declaration, or ``None`` when it declares
    nothing this engine can enforce.

    ``None`` and the empty set mean DIFFERENT things and the distinction is
    load-bearing. ``None`` = "this skill said nothing I understand", which must
    leave the grant alone; the empty set would mean "this skill permits
    nothing", which would refuse every tool for the turn. An imported skill
    carrying the spec's own ``Bash(git:*) Read`` is the NORMAL case, and
    treating it as an empty declaration would kill the run.

    Deliberately NOT built on ``normalize``: that function splits on commas
    only, and its other callers are ``subset_of_user`` and
    ``AgentGrants.__init__`` — the no-escalation primitive. It must not be
    widened to satisfy a skill-parsing test.
    """
    if not raw:
        return None
    tokens = [t for t in _ALLOWED_TOOLS_SPLIT_RE.split(str(raw).strip()) if t]
    known = {t.lower() for t in tokens if t.lower() in CAPABILITIES}
    return frozenset(known) if known else None


def skill_narrowing(declared: Sequence[Optional[frozenset]]) -> Optional[frozenset]:
    """The narrowing implied by the skills that actually LANDED in the prompt.

    ``None`` (no narrowing) when nothing landed, or when ANY landed skill is
    silent — a skill that declares nothing may need the full grant to carry out
    its procedure, and one silent skill must not be narrowed by its neighbours.

    UNION, not intersection: up to three skills disclose at once, and
    intersecting three narrow declarations collapses to the empty set and kills
    the run.

    THE HARD RULE, and the reason this returns a value instead of mutating a
    grant: a skill's declaration is NEVER an argument to any ``AgentGrants``
    constructor. It is only ever the right operand of ``&`` against
    ``grants.granted(agent)``. Passing it as ``requested`` would clamp it to the
    USER's grant rather than the SEAT's — so a seat holding only ``vault``,
    reading a file that says ``vault web terminal``, would GAIN web and
    terminal, with an empty escalations list and nothing said out loud.
    """
    if not declared:
        return None
    out = set()
    for d in declared:
        if d is None:
            return None
        out |= set(d)
    return frozenset(out)


def subset_of_user(user: Iterable[str], requested: Iterable[str]) -> frozenset:
    """THE no-escalation rule: a grant is at most the user's own grant.

    Pure intersection of two normalized sets. Called from exactly one place
    (``AgentGrants.__init__``) so no caller can route around it.
    """
    return normalize(user) & normalize(requested)


# ---------------------------------------------------------------------------
# The grant table
# ---------------------------------------------------------------------------


class AgentGrants:
    """What each agent on this run may do — already clamped to the user.

    ``user`` is the human's own grant. ``requested`` maps agent name -> the
    capabilities the manager proposed for it. Every stored grant is the
    intersection; ``escalations`` records, in order, each (agent, capability)
    the manager asked for that the user does not hold, so the run can say it out
    loud rather than silently shrinking the roster's promise.

    An agent nobody granted anything gets NOTHING (least privilege). That is the
    honest default: a grant is something the user gave, not something an unnamed
    agent inherits by being unnamed.
    """

    def __init__(
        self,
        user: Iterable[str],
        requested: Optional[Mapping[str, Iterable[str]]] = None,
    ) -> None:
        self.user: frozenset = normalize(user)
        self.by_agent: Dict[str, frozenset] = {}
        self.escalations: List[Dict[str, str]] = []
        for name, caps in (requested or {}).items():
            key = _agent_key(name)
            asked = normalize(caps)
            granted = subset_of_user(self.user, asked)
            self.by_agent[key] = granted
            for over in sorted(asked - granted):
                self.escalations.append({"agent": str(name), "capability": over})

    # -- reading the table -------------------------------------------------

    def granted(self, agent: str = "") -> frozenset:
        """The capabilities ``agent`` really holds (never more than the user)."""
        return self.by_agent.get(_agent_key(agent), frozenset())

    def allows(self, agent: str, capability: str) -> bool:
        return capability in self.granted(agent)

    def refusal(self, agent: str, capability: str) -> str:
        """The honest sentence for a denial — the user's own grant is named when
        that (not the manager's choice) is the real reason."""
        who = agent.strip() or "this agent"
        what = CAPABILITY_WORDS.get(capability, capability)
        if capability not in self.user:
            return (
                f"{who} may not {what}: you have not granted that capability, "
                f"so no agent can be given it"
            )
        return f"{who} was not granted the '{capability}' capability"

    def escalation_lines(self) -> List[str]:
        """One honest line per capability the manager asked for and could not get."""
        return [
            f"{e['agent']}: asked for '{e['capability']}' — you do not hold it, so it was not granted"
            for e in self.escalations
        ]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "user": sorted(self.user),
            "agents": {k: sorted(v) for k, v in sorted(self.by_agent.items())},
            "escalations": list(self.escalations),
        }

    # -- construction from the CLI ----------------------------------------

    @classmethod
    def from_cli(
        cls, user_raw: Optional[str], agents_raw: Optional[str]
    ) -> Optional["AgentGrants"]:
        """Build from the two CLI strings, or None when no grant was declared.

        ``user_raw`` is a comma list ("vault,web"). ``agents_raw`` is either a
        JSON object (``{"researcher": ["web"], ...}``) or a comma list, which
        means "this single agent" and is stored under the empty-name key (the
        solo path). None/blank ``agents_raw`` with a present ``user_raw`` grants
        the solo agent the user's own set — the honest identity case.

        A malformed JSON object raises ``CapabilityDenied`` rather than being
        guessed at: a grant nobody can read is not a grant.
        """
        if user_raw is None and agents_raw is None:
            return None
        user = normalize(user_raw)
        requested: Dict[str, Iterable[str]] = {}
        raw = (agents_raw or "").strip()
        if raw.startswith("{"):
            try:
                parsed = json.loads(raw)
            except ValueError as exc:
                raise CapabilityDenied(
                    f"agent capabilities are not readable JSON: {exc}"
                ) from exc
            if not isinstance(parsed, dict):
                raise CapabilityDenied("agent capabilities must be a JSON object")
            for name, caps in parsed.items():
                requested[str(name)] = caps if isinstance(caps, (list, str)) else []
        elif raw:
            requested[""] = raw
        else:
            requested[""] = user
        return cls(user, requested)


def _agent_key(name: str) -> str:
    return str(name or "").strip().lower()


def enforce(
    grants: Optional[AgentGrants], agent: str, capability: str
) -> None:
    """Raise ``CapabilityDenied`` unless ``agent`` holds ``capability``.

    ``grants is None`` means no per-agent grant was declared for this run, which
    leaves every existing path byte-identical (the feature is opt-in). This is
    the ONE enforcement call other modules make — see ``project.apply_file_ops``
    for the ``writes`` gate and ``AgentCapabilityGate`` for the tool gates.
    """
    if grants is None:
        return
    if not grants.allows(agent, capability):
        raise CapabilityDenied(grants.refusal(agent, capability), agent, capability)


# ---------------------------------------------------------------------------
# The tool gate
# ---------------------------------------------------------------------------


def _refused_result(tool: str, reason: str) -> Dict[str, Any]:
    """The honest observation for a REFUSED call — ``isError``-shaped.

    Never a fabricated success and never a silent empty: the model reads the
    real reason and the loop treats it as ``ok:false``. Shaped exactly like
    ``approval._held_result`` so every reader downstream already handles it.
    """
    return {
        "isError": True,
        "refused": True,
        "content": [
            {"type": "text", "text": "refused: %s (tool '%s' not run)" % (reason, tool)}
        ],
    }


class AgentCapabilityGate:
    """A tool source that REFUSES tools the acting agent was not granted.

    Wraps another duck-typed source (``MCPClient`` / ``WebToolProvider`` /
    ``VaultToolProvider`` / ``CompositeToolClient`` / an ``ApprovalGate`` around
    any of them). ``list_tools`` hides what the agent may not use, and
    ``call_tool`` refuses it outright — the inner source is NEVER touched, so an
    agent without ``web`` cannot fetch and an agent without ``vault`` cannot read
    a note, no matter what the model asks for.

    This gate sits OUTSIDE the approval gate deliberately: a missing capability
    is not something a human can approve away mid-run. The single approval that
    created the roster is the only place these grants are decided.

    ``set_agent`` names who is acting; a team's board loop calls it before each
    agent's turn, so ONE shared tool source enforces N different grants.
    """

    def __init__(
        self,
        source: Any,
        grants: AgentGrants,
        agent: str = "",
        telemetry: Optional[Any] = None,
    ) -> None:
        self.source = source
        self.grants = grants
        self.agent = agent
        self._telemetry = telemetry
        #: THE per-turn state, as ONE immutable tuple: (agent, narrowing,
        #: declarations). One assignment, read once per call. Two mutable
        #: fields with an ordering rule enforced by a comment is a race waiting
        #: for the next edit — this gate is shared across a board, and read
        #: steps run in a thread pool.
        self._turn: tuple = (agent or "", None, ())
        #: Every refusal this gate made — (agent, tool, capability, reason).
        #: Evidence, so "an agent was refused" is a recorded fact, not a claim.
        self.refusals: List[Dict[str, str]] = []

    # -- transparency (same contract as ApprovalGate) ----------------------

    def __getattr__(self, name: str) -> Any:
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

    def set_agent(self, agent: str) -> None:
        """Name the agent whose turn it is, and CLEAR any skill narrowing.

        The reset is unconditional and structural — never conditional on the
        name changing. The lead's synthesis turn calls the model with the SAME
        agent name as its board turn and discloses no skills; a reset that
        fired only on a change would leak the board turn's narrowing into that
        prompt, and the refusal would name a skill the synthesis never saw.

        Any installer must therefore call this FIRST and
        ``set_skill_narrowing`` after, never the other way round.
        """
        self.agent = agent or ""
        self._turn = (self.agent, None, ())

    def set_skill_narrowing(self, caps, declarations=()) -> None:
        """Narrow THIS turn to what the landed skills declare.

        ``caps`` is ``None`` when nothing narrows (no skill landed, or one of
        them declared nothing this engine understands — a silent skill may need
        the full grant, so it must not be narrowed by its neighbours).

        An explicit METHOD, not an attribute, so a call site whose target has no
        gate raises instead of silently writing a dead attribute onto some other
        object and believing it applied.

        THE HARD RULE: what arrives here is only ever the right operand of ``&``
        against ``grants.granted(agent)``. It is never an argument to any
        ``AgentGrants`` constructor — that path clamps to the USER's grant
        rather than the SEAT's, so a seat holding only ``vault`` reading a file
        that says ``vault web`` would GAIN web, with an empty escalations list
        and nothing said out loud.
        """
        clean = []
        for name, raw in declarations or ():
            text = "".join(ch for ch in str(raw) if ch.isprintable())[:120]
            clean.append((str(name)[:80], text))
        self._turn = (self.agent, caps, tuple(clean))

    @property
    def narrowing_active(self) -> bool:
        """Whether a skill declaration is constraining this turn right now."""
        return self._turn[1] is not None

    def _effective(self) -> frozenset:
        """What the acting agent may use this turn: the seat's grant, further
        narrowed by any landed skill's declaration. Never wider than the seat."""
        granted = self.grants.granted(self.agent)
        narrowing = self._turn[1]
        return granted if narrowing is None else (granted & narrowing)

    def _narrowing_refusal(self, capability: str) -> str:
        """Why a tool the SEAT holds was refused this turn.

        Never ``AgentGrants.refusal`` — that branches on "not in self.user" and
        would tell the user they had not granted a capability they demonstrably
        had. Names every declaring skill, because ``skill_narrowing`` unions
        declarations and blaming one could claim a refusal it never caused. The
        model sees only parsed capability NAMES, never the raw file text.
        """
        names = ", ".join(n for n, _ in self._turn[2]) or "the active skill"
        allowed = ", ".join(sorted(self._turn[1] or ())) or "nothing"
        return (
            f"'{capability}' is not available on this turn: the skill(s) in use "
            f"({names}) declare allowed-tools covering {allowed}. Your own grant "
            f"is unchanged."
        )

    # -- what the model is even shown --------------------------------------

    def _owning_source(self, name: str) -> Any:
        """The concrete source that would serve ``name`` (for attribution)."""
        owner_map = getattr(self.source, "_owner", None)
        if isinstance(owner_map, dict):
            if not owner_map:
                try:
                    self.source.list_tools()
                except Exception:  # noqa: BLE001 — a broken source must not crash us
                    pass
                owner_map = getattr(self.source, "_owner", {})
            owner = owner_map.get(name)
            if owner is not None:
                return owner
        return self.source

    def _capability_for(self, name: str) -> str:
        owner = self._owning_source(name)
        provider = getattr(owner, "provider", getattr(self.source, "provider", ""))
        return capability_for_provider(provider)

    def list_tools(self) -> List[Any]:
        """Only the tools this agent's grant covers. Hiding is not the security
        boundary (``call_tool`` is) — it is how the model is told the truth
        about what it has, so it stops asking for what it cannot have."""
        tools = self.source.list_tools() or []
        allowed = self._effective()
        return [t for t in tools if self._capability_for(getattr(t, "name", "")) in allowed]

    # -- THE enforcement point ---------------------------------------------

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        capability = self._capability_for(name)
        if capability in self._effective():
            return self.source.call_tool(name, arguments or {})
        # Distinguish the two refusals. A capability the SEAT holds but this
        # turn's skills narrowed away is a different fact from one the user
        # never granted, and saying the second about the first is a false
        # statement about a human in the audit trail.
        narrowed_away = self._turn[1] is not None and capability in self.grants.granted(
            self.agent
        )
        # REFUSED. The inner source is never touched: nothing is fetched, no
        # note is read, nothing egresses. The span and the returned observation
        # both say so, so the trace and the model see the same fact.
        reason = (
            self._narrowing_refusal(capability)
            if narrowed_away
            else self.grants.refusal(self.agent, capability)
        )
        self.refusals.append(
            {
                "agent": self.agent,
                "tool": name,
                "capability": capability,
                "reason": reason,
            }
        )
        telemetry = self._telemetry or _find_telemetry(self.source)
        if telemetry is not None:
            owner = self._owning_source(name)
            provider = getattr(owner, "provider", getattr(self.source, "provider", "mcp"))
            server = getattr(owner, "server_name", getattr(self.source, "server_name", "mcp"))
            try:
                with telemetry.span(
                    "tool_exec",
                    span_type="tool_exec",
                    parent=self.parent_span_id,
                    provider=provider,
                    server=server,
                    tool=name,
                    agent=self.agent,
                    capability=capability,
                    refused=True,
                ) as sp:
                    sp.set(reason=reason)
                    sp.set_status("error")
            except Exception:  # noqa: BLE001 — telemetry must never break a refusal
                pass
        return _refused_result(name, reason)


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


_TOOLS_LINE_RE = re.compile(r"^tools:\s*\[([^\]]*)\]\s*$", re.M)


def _seat_slug(name: str) -> str:
    """The client's agentSlug, mirrored: lowercase, runs of non-alphanumerics
    become one hyphen, trimmed — so 'Reviewer / Verifier' finds
    agents/reviewer-verifier.md exactly as the app writes it."""
    out = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return out or "agent"


def _file_tools(vault: str, name: str) -> Optional[List[str]]:
    """The `tools:` list a seat's own definition file declares, or None when
    the seat has no file / no tools line. Only the frontmatter block is read;
    a malformed or unreadable file counts as undeclared — a broken file must
    degrade to today's behavior, never invent a grant."""
    path = os.path.join(vault, "agents", f"{_seat_slug(name)}.md")
    try:
        if os.path.islink(path) or not os.path.isfile(path):
            return None
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read(64_000)
    except OSError:
        return None
    if not raw.startswith("---"):
        return None
    end = raw.find("---", 3)
    if end < 0:
        return None
    m = _TOOLS_LINE_RE.search(raw[:end])
    if not m:
        return None
    return [t.strip() for t in m.group(1).split(",") if t.strip()]


def grants_from_seat_files(
    vault: str,
    seat_names: Iterable[str],
    ceiling: Iterable[str],
) -> Optional["AgentGrants"]:
    """Slice B: per-seat grants read from each seat's OWN definition file.

    `ceiling` is what this run's user really enabled (vault unless opted out,
    web only when requested). A seat whose file declares `tools:` is clamped
    to that declaration ∩ ceiling — an over-ask lands in `escalations`, said
    out loud by the caller, never silently dropped. A seat with no file or no
    tools line keeps the FULL ceiling (byte-identical to before files spoke).
    Returns None when no seat declares anything — the whole run then keeps
    today's ungated shape.
    """
    declared: Dict[str, List[str]] = {}
    for name in seat_names:
        tools = _file_tools(vault, name)
        if tools is not None:
            declared[name] = tools
    if not declared:
        return None
    requested: Dict[str, Iterable[str]] = {}
    for name in seat_names:
        requested[name] = declared.get(name, list(ceiling))
    return AgentGrants(ceiling, requested)
