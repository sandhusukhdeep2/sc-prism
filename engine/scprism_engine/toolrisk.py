"""Tool RISK classification — which tool calls can run free, which must be held.

THE PROBLEM THIS SOLVES (measured, 2026-08-17)
----------------------------------------------
The shipped tool posture writes ``{"require": ["all"]}`` into the vault's
``mcp-approvals.json``. The ``all`` sentinel is a blunt instrument: it holds
EVERY tool call whose exact name is not already in ``granted``. One user's span
tail showed **32 held calls** across his wakes — ``web_fetch`` 8x, ``vault_read``
8x, ``web_search`` 6x, ``project_status`` 6x, ``read_file`` 2x, ``vault_list``
2x. Every one of them was a READ. Each new tool NAME cost a separate approval
prompt before it could ever run, and an unattended wake that met one stalled
until the blocking broker's timeout.

His decision, asked and answered: *let it work; hold only risky tools.* So the
gate needs to know the difference between looking and doing — and the engine,
not the UI, is where that knowledge has to live, because the engine is what
enforces it (``approval.ToolApprovalPolicy.decide``, called from
``approval.ApprovalGate.call_tool`` before any egress).

THE TWO CLASSES
---------------
``READ_ONLY``
    The call OBSERVES. It cannot change anything outside this process: no file
    is written, renamed or deleted; no message is sent; no money is spent; no
    remote resource is created or mutated. Running it twice leaves the world
    exactly as running it once did.

``ACTING``
    Anything else — writes, sends, spends, mutates external state — **and
    anything we cannot PROVE is read-only.** Held exactly as today.

HOW A TOOL EARNS ``READ_ONLY`` (the allowlist rule)
---------------------------------------------------
A tool is read-only only when BOTH hold:

  1. its ``provider`` is one of THIS repo's own first-party tool sources, and
  2. its exact name is listed in ``FIRST_PARTY_READ_ONLY`` below, where each
     entry was established by reading that source's code.

``provider`` is the audit tag a source class stamps on its own spans
(``vault_tools.VaultToolProvider.provider = "vault"``,
``webtools.WebToolProvider.provider = "web"``); ``mcp.MCPClient`` sets none, so
the gate's fallback tags it ``"mcp"``. It is set by OUR code, in this repo — a
third-party MCP server cannot set it, spoof it, or inherit it. That is why the
key is the provider and NOT the ``server`` name: a user may legitimately name an
MCP server ``vault``, and name-keying would then hand a stranger's server the
free pass meant for the engine's own note reader.

Note carefully what rule 2 means: adding a new tool to ``VaultToolProvider``
does NOT make it read-only. It is ACTING until someone reads it, establishes it
cannot mutate, and names it here. A ``vault_write`` added tomorrow is held by
default. The allowlist is the point.

WHY THE DEFAULT FOR AN UNKNOWN MCP TOOL IS ``ACTING``
-----------------------------------------------------
MCP servers are third-party code the user registered. A name is not evidence:
``notion.create_page`` is obviously a write, ``notion.search`` sounds like a
read — but ``search`` could bill an API, log a query to someone's CRM, or be a
badly named delete. We cannot read that server's source, so we cannot establish
rule 2 for it, so it is ACTING and stays held. The failure mode we are refusing
is the bad one: silently granting something the user believes is held. Being
wrong in the other direction only costs a prompt.

Read-only tools are also NOT ungoverned. The gate is the THIRD governance layer;
an allowed call still runs the source's own allowlist and the sensitivity gate
before any bytes leave (``approval.ApprovalGate.call_tool`` delegates INTO those
gates, it does not bypass them).

THE POLICY SENTINEL
-------------------
``READ_ONLY_GRANT`` (``"read-only"``) names the CLASS inside the existing
``{require, granted}`` policy file, and it reads the same in both fields:

  * in ``granted`` → every tool this module classifies READ_ONLY runs without a
    prompt.
  * in ``require`` → "require approval for the read-only class too" — a user who
    deliberately chose hold-everything. It OVERRIDES the grant
    (``ToolApprovalPolicy.reads_run_free``), because a user tightening up must
    never lose to a grant left behind in the file, and it is what tells the
    app's launch migration to stand down instead of re-freeing what he just held.

Neither present (the old shape) → nothing changes: every ungranted call is held,
exactly as before. No new file field, no new CLI flag; an older engine reading a
newer file just sees an unmatched tool name and holds everything — failing in
the safe direction.

RESIDUAL RISKS, STATED PLAINLY (we accept these; they are not hidden)
---------------------------------------------------------------------
  * ``web_fetch`` issues a GET. A server that violates HTTP semantics can act
    on a GET (``GET /delete?id=1``). The model chooses the URL. This is bounded
    by the SSRF guard (public http/https peers only), by sending no credentials,
    and by the sensitivity gate on the arguments — and it is the classification
    the user explicitly chose ("web read").
  * ``web_search`` egresses the query string to the configured search backend,
    which may be a POST (that is the backend's transport, not a mutation). The
    model supplies ONLY ``query`` — it cannot steer the endpoint — so the call
    can create no remote resource.
  * Read-only does not mean private: a vault read pulls the user's own notes
    into the run. That is governed elsewhere (the egress floor forces such a run
    LOCAL — ``loop.VAULT_LOCAL_REASON``), which is precisely why the vault reads
    are cheap to grant here.
"""

from __future__ import annotations

from typing import Any, Dict, FrozenSet, Optional

# -- the two classes ---------------------------------------------------------

READ_ONLY = "read-only"
ACTING = "acting"

# -- the sentinel a `granted` list carries to free the read-only class --------

READ_ONLY_GRANT = "read-only"

# -- the allowlist (provider -> the exact tool names established read-only) ---
#
# Every name below was established by reading the source it comes from. The
# citation is part of the entry: if you add a name, add the reason.
FIRST_PARTY_READ_ONLY: Dict[str, FrozenSet[str]] = {
    # vault_tools.VaultToolProvider (provider="vault"). Its module docstring:
    # "Read-only in v1. No tool here writes, renames or deletes anything." The
    # dispatch has exactly these four branches; the only file access is
    # `_open_regular`, which opens O_RDONLY|O_NOFOLLOW|O_NONBLOCK and refuses
    # anything that is not a regular file. `project_status` only reads the app's
    # projects store. Nothing egresses.
    "vault": frozenset({"vault_list", "vault_read", "vault_search", "project_status"}),
    # webtools.WebToolProvider (provider="web"). `web_fetch` is a GET (a
    # urllib Request with no `data`, so never a POST) that returns page text;
    # `web_search` sends only the model's query to the configured backend and
    # returns titled results. Neither creates or mutates a remote resource.
    # See RESIDUAL RISKS above — both caveats are known and accepted.
    "web": frozenset({"web_fetch", "web_search"}),
}


def classify(provider: Optional[str], tool: Optional[str]) -> str:
    """``READ_ONLY`` or ``ACTING`` for one tool call. Never raises.

    ``provider`` is the source's own audit tag (``"vault"`` / ``"web"`` /
    ``"mcp"``); ``tool`` is the exact tool name. Read-only requires BOTH a
    first-party provider AND a name on that provider's allowlist. Every other
    input — an unknown provider, an unlisted name, ``None``, a non-string, an
    MCP tool of any name — is ``ACTING``, i.e. still held.

    The ``server`` name is deliberately NOT a parameter: it is user-chosen and
    therefore spoofable (an MCP server may be named ``vault``), while
    ``provider`` is stamped by this repo's own source classes.
    """
    if not isinstance(provider, str) or not isinstance(tool, str):
        return ACTING
    allowed = FIRST_PARTY_READ_ONLY.get(provider)
    if allowed is None:
        return ACTING
    return READ_ONLY if tool in allowed else ACTING


def is_read_only(provider: Optional[str], tool: Optional[str]) -> bool:
    """``True`` when ``classify`` says ``READ_ONLY`` — the readable form."""
    return classify(provider, tool) == READ_ONLY


def provider_of(source: Any, fallback: Any = None) -> str:
    """The audit ``provider`` tag of a tool source, defaulting CONSERVATIVELY.

    A source without a ``provider`` attribute (``MCPClient``, a
    ``CompositeToolClient`` we could not route through) yields ``fallback``'s
    provider or ``"mcp"`` — never a first-party tag — so an unroutable call
    classifies ACTING and stays held.
    """
    value = getattr(source, "provider", None)
    if isinstance(value, str) and value:
        return value
    if fallback is not None:
        value = getattr(fallback, "provider", None)
        if isinstance(value, str) and value:
            return value
    return "mcp"
