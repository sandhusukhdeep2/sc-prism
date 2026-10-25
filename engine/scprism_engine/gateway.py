"""Gateway — Bifrost's role, interim stdlib-only Python (ADR-002/006/016/026).

ALL model calls go THROUGH THE GATEWAY; the loop never talks to a provider
directly. This module is a spec-faithful stand-in for the real Go Bifrost and
sits behind an interface the Go binary can replace later (tranche E-Bifrost).

Responsibilities:
  * Provider config from env/args — a local OpenAI-compatible endpoint
    (``OPENAI_BASE_URL``, default http://localhost:1234) plus optional
    Claude / OpenAI / Gemini cloud keys, with a single ``primary`` cloud pick.
  * ``route(step_or_intent) -> RouteDecision`` — sensitivity keywords force
    LOCAL, reasoning-heavy keywords go CLOUD, otherwise LOCAL. Sensitivity
    always wins (precedence).
  * ``model_call(messages, route)`` — a real OpenAI-compatible HTTP POST via
    urllib with a short timeout; on ANY error / no endpoint / no key it falls
    back to a DETERMINISTIC offline stub (seeded by the message hash) so the
    engine always runs offline.
  * A **prompt cache** (exact hash of messages) and a **semantic cache**
    (normalized-intent bucket). Every result records a cache hit/miss.

Caches are per-process dicts — sufficient for E1; the real Bifrost owns a
shared cache later.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import http.client
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from . import proc as proc_util
from . import toolpath

DEFAULT_LOCAL_URL = "http://localhost:1234"

# How long ONE call through a subscription CLI may take (override:
# SCPRISM_CLI_TIMEOUT). An agentic CLI thinks and streams, so this is much
# longer than the HTTP timeout — but it MUST stay under the app's own cancel.
#
# The client races every engine run against a 240s hard cancel (AppStore's
# `raceCancelable(..., 240_000, runId)`). If the CLI bound met or exceeded that,
# the client would always win: it kills the run, the engine's honest timeout
# never gets to fire, and the beat reads "stopped at 240s" with nothing to show.
# The engine has to lose FIRST so it can report the timeout itself and the run
# still finishes with an honest verdict. 180s is the largest bound that leaves
# the rest of a wake (routing, the local follow-up turns, tier-1/tier-2) room to
# finish inside 240s — ~60s of headroom. Raising it would just hand the win back
# to the client, so a bigger number belongs on the CLIENT's cancel first.
CLI_TIMEOUT_DEFAULT = 180.0

# A LOCAL model that could not be LOADED (2026-08-17).
#
# oMLX answers a chat POST for a model that does not fit with HTTP 507 and a
# body naming the arithmetic: "projected memory 42.36GB would exceed the
# metal_cap memory ceiling 24.96GB". The server was up, fast and explicit —
# but that status fell into the 5xx branch of `_invoke`, became the
# deterministic offline stub, and the app told the user his local provider was
# UNREACHABLE. He went looking for a network fault that never existed.
#
# So the status is read and named now. The marker below is the contract with
# the client (`src/lib/runBudget.ts` :: LOAD_FAILED_MARK): a reason carrying it
# is rendered as "your local model couldn't load", never as an outage.
LOAD_FAILED_MARK = "local model could not load"

# Statuses a local server uses to say "this model does not fit". 507
# (Insufficient Storage) is oMLX's. 503 is deliberately NOT here: it is a
# retryable overload (see RETRY_STATUSES), not a refusal to load.
LOAD_FAILED_STATUSES = (507,)

# The body's own words for a memory refusal, whatever status carried it.
_LOAD_FAILED_BODY = re.compile(
    r"memory ceiling|metal_cap|out of memory|insufficient memory|cannot fit|won'?t fit",
    re.I,
)
_PROJECTED_GB = re.compile(r"projected memory\s*([\d.]+)\s*GB", re.I)
_CEILING_GB = re.compile(r"ceiling\s*([\d.]+)\s*GB", re.I)


def local_load_failure(status: int, body: str) -> Optional[str]:
    """The honest reason when a LOCAL call failed because the model could not
    be loaded — else ``None``.

    Pure (status + body in, one sentence out) so the classification is testable
    without a server. Every number in the result is the SERVER's own: this
    parses what it said, it never estimates a footprint.
    """
    text = (body or "").strip()
    if status not in LOAD_FAILED_STATUSES and not _LOAD_FAILED_BODY.search(text):
        return None
    projected = _PROJECTED_GB.search(text)
    ceiling = _CEILING_GB.search(text)
    if projected and ceiling:
        detail = (
            f"not enough GPU memory — this model needs "
            f"{float(projected.group(1)):.1f} GB and the server's ceiling is "
            f"{float(ceiling.group(1)):.1f} GB"
        )
    else:
        detail = "not enough GPU memory"
    said = " ".join(text[:200].split())
    return f"{LOAD_FAILED_MARK}: {detail}" + (
        f' (the server said, HTTP {status}: "{said}")' if said else f" (HTTP {status})"
    )


# Rate-limit handling (specs/02 §7): retry 429 / 503 / 529 with exponential
# backoff, give up after RETRY_ATTEMPTS extra tries (then the offline stub).
RETRY_STATUSES = (429, 503, 529)
RETRY_ATTEMPTS = 3
RETRY_BASE_DELAY = 1.0

# Output budget for EVERY provider (both payload builders). 1024 was the old
# Anthropic-only default and it guillotined real work: a report or summary in
# this product routinely needs well over 1k tokens, and a REASONING model spends
# much of its budget thinking before the visible answer even starts. 4096 is the
# smallest defensible ceiling for that work, and it keeps the Anthropic thinking
# arithmetic sane (max_tokens still clears every thinking floor below).
DEFAULT_MAX_TOKENS = 4096

# A malformed response body (no `choices`, a truncated read) is an
# infrastructure fault, not a verdict — see `_invoke_with_retry`. Two extra
# attempts, 0.5s then 1s: enough to ride out a server hiccup mid-run, short
# enough that a genuinely broken endpoint still fails promptly.
MALFORMED_RETRIES = 2
MALFORMED_BACKOFF_S = 0.5

# Anthropic thinking. CURRENT Claude models accept ONE shape —
# ``{"type": "adaptive"}`` plus ``output_config.effort`` — and REJECT the legacy
# ``{"type": "enabled", "budget_tokens": N}`` with a 400 (adaptive thinking
# replaced the fixed-budget form; the model now decides its own depth). The
# API's own effort ladder is low|medium|high|xhigh|max, which is exactly the
# ladder the UI already offers, so the mapping is 1:1 — no clamping.
ANTHROPIC_EFFORTS = ("low", "medium", "high", "xhigh", "max")

# Thinking is drawn from max_tokens, so the cap must leave room for BOTH the
# reasoning and the visible answer. These per-effort floors are the same numbers
# the old budget arithmetic produced (budget + 2048), so the invariant survives
# the shape change: max_tokens always clears the deepest thinking a level buys.
ANTHROPIC_MAX_TOKENS_FLOOR = {
    "low": 2048,
    "medium": 4096,
    "high": 6144,
    "xhigh": 10240,
    "max": 18432,
}

# Claude generations that accept adaptive thinking. It arrived with the 4.6
# family and is the ONLY accepted form from 4.7/5 onward; everything older
# (Sonnet 4.5, Haiku 4.5, the 3.x line) has no adaptive mode at all. For those
# we send NO thinking field rather than a shape the model would reject — a
# request that errors is strictly worse than one that simply doesn't think.
_ADAPTIVE_THINKING_MODELS = (
    "opus-4-6", "opus-4-7", "opus-4-8", "opus-5",
    "sonnet-4-6", "sonnet-5",
    "fable-5", "mythos-5",
)


def _supports_adaptive_thinking(model: str) -> bool:
    """True when `model` is a Claude generation that accepts adaptive thinking."""
    low = (model or "").lower()
    return any(tag in low for tag in _ADAPTIVE_THINKING_MODELS)


def _sleep(seconds: float) -> None:  # module-level so tests can patch it
    time.sleep(seconds)

LOCAL = "local"
CLOUD = "cloud"

# Sensitivity FORCES local — sensitive data must never leave the machine.
# (specs/05 + CLAUDE invariant.) Precedence: these win over everything.
SENSITIVE_KEYWORDS = (
    "password",
    "passwd",
    "credential",
    "customer",
    "auth",
    "authentication",
    "authorization",
    "login",
    "token",
    "secret",
    "prod",
    "production",
    "pii",
    "ssn",
    "private-key",
    "privatekey",
    "api-key",
    "apikey",
)

# --- HOW those keywords are matched (2026-08-17) ----------------------------
#
# They used to be matched with plain `in` containment, so ANY string carrying
# one as a SUBSTRING tripped the gate. The research query "mlx multi token
# prediction" was killed pre-egress because it contains "token"; so were
# "authentic" ("auth"), "prodigy" ("prod") and "customer-facing copy". Because
# a blocked call correctly records no destination (the privacy rule), the user
# saw NOTHING — a legitimate search simply vanished.
#
# The rule now has two halves, and both are word-aware:
#
#   1. STRONG terms are sensitive ON THEIR OWN, matched as WHOLE WORDS.
#      Boundaries are alphanumeric-only lookarounds, NOT `\b`, because `\b`
#      treats `_` as a word character — `\bpassword\b` would have MISSED
#      `aws_password=hunter2`, which is exactly the shape a leaked secret has.
#      A term's own separators are elastic, so one entry covers every spelling:
#      "api-key" also matches "apikey", "api key" and "api_key". A trailing
#      plural is allowed ("passwords", "credentials", "api-keys").
#
#   2. AMBIGUOUS terms are ordinary English words that are only sensitive IN
#      CONTEXT. As bare words they are the entire false-positive problem, so
#      they trip only when a QUALIFIER sits within two words of them:
#      "prod database", "customer data", "auth token", "access token",
#      "production credentials" all trip; "mlx multi token prediction",
#      "production values" and "customer-facing copy" do not.
#
# ONE function (`sensitive_hit`) implements both halves and EVERY caller uses
# it — `route()`, `guard_cloud_tool_result`, the web-tool arg gate, the MCP arg
# gate and `planner.route` — so the rule cannot drift between the place that
# decides a route and the place that guards a tool result. The user's own
# `extra_sensitive` words (the interview's SCPRISM_SENSITIVE list) go through
# the SAME word matcher as the strong terms: "acme" matches the word acme and
# never the inside of another word.
AMBIGUOUS_SENSITIVE_KEYWORDS = (
    "customer",
    "auth",
    "token",
    "prod",
    "production",
)

STRONG_SENSITIVE_KEYWORDS = tuple(
    k for k in SENSITIVE_KEYWORDS if k not in AMBIGUOUS_SENSITIVE_KEYWORDS
)

# How far from an ambiguous word a qualifier may sit (in words, either side).
SENSITIVE_WINDOW = 2

# Words that turn an ambiguous term sensitive when they sit near it. The strong
# terms are included so an ambiguous+strong pair is caught by BOTH halves, and
# the ambiguous terms are included so a pair of them ("auth token", "customer
# login", "prod credentials") trips too.
SENSITIVE_QUALIFIERS = frozenset(
    """
    password passwords passwd credential credentials secret secrets pii ssn ssns
    key keys apikey privatekey login logins signin
    token tokens auth oauth jwt bearer access refresh session cookie header
    headers signature signing hash salt rotate rotation revoke leak leaked
    database databases db dbs datastore warehouse server servers host hosts
    cluster instance bucket dump dumps backup backups env environment
    environments deploy deployment release
    customer customers client clients user users subscriber subscribers
    data record records row rows account accounts profile profile profiles
    email emails address addresses phone phones name names identity identities
    info information details list lists invoice invoices payment payments
    card cards billing salary medical private personal confidential
    api id ids endpoint credentialing
    """.split()
)

# Cache of compiled per-term patterns (terms are a fixed small set plus the
# user's own words, so this never grows unbounded in practice).
_TERM_PATTERNS: Dict[str, Optional["re.Pattern[str]"]] = {}

# Words, for the ambiguous-term window scan. Splitting on non-alphanumerics is
# what makes "customer-facing" two words and "aws_password" two words.
_WORDS = re.compile(r"[a-z0-9]+")


def _term_pattern(term: str) -> Optional["re.Pattern[str]"]:
    """A whole-word regex for one sensitive term, or None if it has no letters.

    Separators inside the term are elastic (``api-key`` == ``apikey`` ==
    ``api key`` == ``api_key``) and a trailing plural is tolerated. Boundaries
    are alphanumeric lookarounds so ``_``/``-``/``=``/``.`` all count as the
    edge of a word — a secret spelled ``aws_password=…`` is still caught.
    """
    if term in _TERM_PATTERNS:
        return _TERM_PATTERNS[term]
    parts = [p for p in re.split(r"[^a-z0-9]+", term.lower()) if p]
    pattern: Optional["re.Pattern[str]"] = None
    if parts:
        body = r"[\s\-_./]*".join(re.escape(p) for p in parts)
        pattern = re.compile(r"(?<![a-z0-9])" + body + r"(?:e?s)?(?![a-z0-9])")
    _TERM_PATTERNS[term] = pattern
    return pattern


# An ambiguous term ASSIGNED A VALUE is sensitive on its own, whatever sits
# around it: `?token=abc123` in a URL, `"token": "..."` in a JSON tool argument,
# `prod_db=...` in a config line. This is the shape a real credential takes, and
# it has no innocent reading — where "multi token prediction" is prose about a
# technique, "token=abc123" IS the secret. Optional quote/space before the
# operator so JSON (`"token": "…"`) and shell (`token = …`) both match.
_ASSIGNED_SENSITIVE = tuple(
    (term, re.compile(r"(?<![a-z0-9])" + re.escape(term) + r"(?:e?s)?[\"'\s]*[:=]"))
    for term in AMBIGUOUS_SENSITIVE_KEYWORDS
)

# Every surface form of an ambiguous term -> the term itself.
_AMBIGUOUS_FORMS: Dict[str, str] = {}
for _term in AMBIGUOUS_SENSITIVE_KEYWORDS:
    for _form in (_term, _term + "s", _term + "es"):
        _AMBIGUOUS_FORMS[_form] = _term
del _term, _form


def sensitive_hit(text: str, extra: Sequence[str] = ()) -> Optional[str]:
    """The sensitive term this text carries, or ``None``.

    THE one sensitivity rule for the whole engine (see the comment above
    ``AMBIGUOUS_SENSITIVE_KEYWORDS``). ``extra`` are the USER's own declared
    words; they are matched as WHOLE WORDS exactly like the strong built-ins —
    never as substrings of other words, and always when they appear as a word.

    The return value is the human-readable term to quote in a route reason: a
    strong term ("password", "api-key", a user word), the ambiguous term shown
    as an assignment ("token=") when it was given a value, or the ambiguous
    pair that tripped, in the order it appears ("prod database", "auth token").
    """
    low = (text or "").lower()
    if not low:
        return None
    for term in (*STRONG_SENSITIVE_KEYWORDS, *(e for e in extra if e and e.strip())):
        pattern = _term_pattern(term)
        if pattern is not None and pattern.search(low):
            return term
    for term, pattern in _ASSIGNED_SENSITIVE:
        if pattern.search(low):
            return term + "="
    words = _WORDS.findall(low)
    for i, word in enumerate(words):
        base = _AMBIGUOUS_FORMS.get(word)
        if base is None:
            continue
        lo = max(0, i - SENSITIVE_WINDOW)
        hi = min(len(words), i + SENSITIVE_WINDOW + 1)
        for j in range(lo, hi):
            if j == i or words[j] not in SENSITIVE_QUALIFIERS:
                continue
            return f"{base} {words[j]}" if j > i else f"{words[j]} {base}"
    return None


# Reasoning-heavy work benefits from a larger cloud model (absent sensitivity).
REASONING_KEYWORDS = (
    "architect",
    "design",
    "refactor",
    "plan",
    "algorithm",
    "distributed",
    "concurrency",
    "optimize",
    "optimise",
    "migrate",
    "proof",
)

# F1 — the tool-RESULT egress gate. MCPClient's sensitivity gate stops a secret
# going TO a tool; this stops a tool RESULT (e.g. file contents carrying a
# secret) being POSTed back to a CLOUD model on the loop's next turn. REUSES
# SENSITIVE_KEYWORDS (the same set the client's arg gate uses — no duplication).
#
# What this gate is NOT: a keyword denylist is a coarse net over PROSE. It does
# not recognise a diagnosis, a salary, a settlement figure or a home address, so
# it is a backstop for tools whose results MIGHT carry a secret — never the
# defence for content that is private BY DEFINITION. The user's own notes get a
# categorical rule instead (``loop.VAULT_LOCAL_REASON``): reading the vault
# keeps the whole run local.
_WITHHELD_CLOUD_RESULT = (
    "[withheld: tool result contains sensitive data; not sent to a cloud model]"
)


def guard_cloud_tool_result(
    content: str, extra: Sequence[str] = ()
) -> Tuple[str, bool]:
    """Scan a tool RESULT bound for a CLOUD model; redact if sensitive.

    Returns ``(safe_content, withheld)``: when the content contains ANY
    sensitive keyword, ``(_WITHHELD_CLOUD_RESULT, True)`` so the secret NEVER
    reaches the POST; otherwise ``(content, False)`` unchanged. The tool-use
    loop feeds the safe content back to the model and records ``withheld`` on
    the trace (honest — the model is told the content was withheld). LOCAL
    routes skip this guard entirely (zero egress; nothing to redact).

    ``extra`` are the USER's own sensitive words (the interview's
    ``SCPRISM_SENSITIVE`` list, which ``route()`` has always honored through
    ``Gateway.extra_sensitive``). They were unreachable from this module-level
    function, so a word the user themselves declared sensitive applied to
    ROUTING but never to a tool result — ``Gateway.guard_tool_result`` now
    threads them in. Default ``()`` keeps every existing call site
    byte-identical.

    Matching is ``sensitive_hit`` — the SAME word-aware rule ``route()`` uses,
    so what keeps a run local and what withholds a tool result can never be two
    different rules.
    """
    if sensitive_hit(content, extra) is not None:
        return _WITHHELD_CLOUD_RESULT, True
    return content, False

# Provider defaults — REAL cloud endpoints (ADR-026, tranche cloud-providers).
#   * openai  — OpenAI Chat Completions, Bearer auth.
#   * gemini  — Google's OpenAI-COMPATIBLE endpoint (…/v1beta/openai/…), Bearer.
#   * claude  — Anthropic's Messages API (NOT OpenAI-compatible): a separate code
#               path with x-api-key + anthropic-version headers.
# ``kind`` selects the request builder: "openai" (OpenAI-compat, incl. gemini)
# or "anthropic" (Messages API). ``chat_path`` is the POST path appended to the
# base URL for OpenAI-compat providers.
_PROVIDERS = {
    "openai": {
        "base_url": "https://api.openai.com",
        "model": "gpt-5",
        "kind": "openai",
        "chat_path": "/v1/chat/completions",
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com",
        # An ALIAS, not a pinned version (2026-08-31): Google retired
        # gemini-2.5-flash for new keys — a fresh user's first call came back
        # HTTP 404 "no longer available to new users". The -latest aliases keep
        # resolving to a live model as Google rotates them.
        "model": "gemini-flash-latest",
        "kind": "openai",
        "chat_path": "/v1beta/openai/chat/completions",
    },
    "claude": {
        "base_url": "https://api.anthropic.com",
        "model": "claude-sonnet-5",
        "kind": "anthropic",
        "chat_path": "/v1/messages",
    },
}

# Anthropic Messages API version pin (sent as the ``anthropic-version`` header).
ANTHROPIC_VERSION = "2023-06-01"

# CLI-bridge providers (tranche cli-bridge): route through a locally installed,
# subscription-authenticated agent CLI instead of an HTTP API. The user signs
# in ONCE in their terminal (Claude Pro/Max -> `claude`, Google account ->
# `gemini`, ChatGPT plan -> `codex`); no API key ever touches SC Prism.
#   ``argv`` builds the non-interactive one-shot command for a prompt.
#   ``model`` is an honest display label — the CLI picks the real model.
_CLI_PROVIDERS = {
    "claude-cli": {
        "bin": "claude",
        "model": "claude-code-subscription",
        # --setting-sources project: do NOT load the user's personal CLI
        # config/memory (their global CLAUDE.md leaked into replies and slowed
        # every call); auth (keychain OAuth) is unaffected.
        "argv": lambda prompt: ["-p", prompt, "--setting-sources", "project"],
        # OUR system prompt must arrive AS a system prompt. Flattened into the
        # `-p` user turn it read as a pasted persona + tool protocol, and Claude
        # correctly refused it as an injection attempt instead of answering
        # (2026-08-31 — the tools ran fine; the ANSWER was destroyed).
        "system_argv": lambda system: ["--append-system-prompt", system],
    },
    "gemini-cli": {
        "bin": "gemini",
        "model": "gemini-cli-account",
        "argv": lambda prompt: ["-p", prompt],
    },
    "codex-cli": {
        "bin": "codex",
        "model": "codex-chatgpt-plan",
        "argv": lambda prompt: ["exec", "--skip-git-repo-check", prompt],
    },
}

# Where subscription CLIs commonly live: `toolpath`, and only `toolpath`.
# GUI-launched processes get a minimal PATH (/usr/bin:/bin:...), so PATH lookup
# alone misses Homebrew / npm / nvm installs. The list (incl. nvm's per-version
# glob) lives there so the gateway and Tier-1's verify shell search exactly the
# same places — a local alias could only ever drift out of that agreement.


def _find_cli(bin_name: str) -> Optional[str]:
    """Absolute path of a CLI binary: PATH first, then the common install dirs."""
    return toolpath.which(bin_name)



def _offline_cause(exc: BaseException) -> str:
    """Plain words for WHY a call fell back to a stand-in.

    THE GAP THIS CLOSES. The generic `except Exception -> _stub` swallowed the
    exception whole, so the `model_call` span recorded `is_real=false` with
    `error: null` and `detail: null`. On the owner's machine a run would answer
    twice for real and then quietly produce three stand-ins, and NOTHING
    anywhere said why — not the span, not the board, not the page. "It stopped
    working and no one wrote down what happened" is the worst possible state for
    a product whose whole promise is that what you see is real.

    Every ending named here is one we can act on: the server took too long, it
    refused the connection, the address is wrong, the name does not resolve.
    """
    import socket
    import urllib.error

    if isinstance(exc, socket.timeout) or isinstance(exc, TimeoutError):
        return "the server did not answer in time"
    if isinstance(exc, urllib.error.HTTPError):
        return f"the server answered {exc.code}"
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", None)
        if isinstance(reason, socket.timeout) or isinstance(reason, TimeoutError):
            return "the server did not answer in time"
        if isinstance(reason, ConnectionRefusedError):
            return "the server refused the connection — is it running?"
        if isinstance(reason, socket.gaierror):
            return "that address could not be resolved"
        return f"could not reach the server — {reason}" if reason else "could not reach the server"
    if isinstance(exc, ConnectionRefusedError):
        return "the server refused the connection — is it running?"
    name = type(exc).__name__
    text = str(exc).strip()
    # OUR OWN errors are already written for the user ("the gemini CLI is not
    # signed in — run `gemini` once in your Terminal"). Prefixing the class name
    # turns that advice back into a stack-trace fragment. A foreign exception
    # keeps its type: often the only clue it carries.
    if isinstance(exc, GatewayError) and text:
        return text
    return f"{name}: {text}" if text else name


class GatewayError(RuntimeError):
    """Raised on gateway configuration errors."""


class GatewayTimeout(GatewayError):
    """The provider did not answer inside our bound and was killed.

    Its own subclass so the invoke path can tell a TIMEOUT (we gave up on a live
    program) apart from every other CLI failure (not installed, not signed in,
    non-zero exit). The two are not the same story and must not read the same.
    """


@dataclass
class RouteDecision:
    """Where a call is routed and why (audit trail)."""

    target: str  # 'local' | 'cloud'
    provider: str  # 'local' | 'openai' | 'claude' | 'gemini'
    model: str
    base_url: str
    is_local: bool
    reason: str
    matched: str = ""
    api_key: Optional[str] = field(default=None, repr=False)
    # Whether this route's provider can actually SEE an image. Runtime-only (NOT
    # serialized in to_dict, so the route/span shape stays byte-identical): the
    # image payload builders read it to send a real image block to a vision
    # provider or fall back to the honest 'image attached — not sent' note.
    supports_vision: bool = False

    def to_dict(self) -> Dict[str, Any]:
        # api_key is intentionally never serialized.
        return {
            "target": self.target,
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "is_local": self.is_local,
            "reason": self.reason,
            "matched": self.matched,
        }


@dataclass
class ModelCallResult:
    """Outcome of a single model call (the gateway's return contract)."""

    text: str
    tokens_in: int
    tokens_out: int
    cache: str  # 'miss' | 'prompt' | 'semantic'
    provider: str
    model: str
    is_real: bool = False
    # The provider said it stopped because it hit the output cap (OpenAI-compat
    # finish_reason == 'length' / Anthropic stop_reason == 'max_tokens'), so this
    # text is CUT OFF, not finished. Carried so a truncated reply is never graded
    # (or shown) as a complete answer. Default False = a clean completion.
    truncated: bool = False

    @property
    def cache_hit(self) -> bool:
        return self.cache != "miss"

    @property
    def tokens(self) -> int:
        return self.tokens_in + self.tokens_out

    def to_dict(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "cache": self.cache,
            "provider": self.provider,
            "model": self.model,
            "is_real": self.is_real,
            "truncated": self.truncated,
        }


def _est_tokens(text: str) -> int:
    """Deterministic ~4-chars/token estimate."""
    return max(1, len(text) // 4)


def _err_body(err) -> str:
    """The provider's OWN error body, read at most once.

    An ``HTTPError`` body is a one-shot stream: whoever reads it first wins and
    every later reader gets ''. Two readers now need it (the load-failure
    classifier and `_rejected`), so the first read is cached on the exception
    and both see the same real text instead of one of them silently losing the
    provider's explanation.
    """
    # NOTE: read the cache out of ``__dict__``, never with getattr. HTTPError
    # forwards unknown attribute lookups to its file object, and a missing one
    # raises KeyError from deep inside tempfile rather than returning the
    # default — the engine suite caught exactly that on a 401.
    try:
        cached = err.__dict__.get("_scprism_body")
    except Exception:
        cached = None
    if cached is not None:
        return cached
    try:
        body = (err.read() or b"").decode("utf-8", "replace").strip()
    except Exception:  # not readable / already consumed
        body = ""
    try:
        err.__dict__["_scprism_body"] = body
    except Exception:  # exotic exception object — reading twice is the worst case
        pass
    return body


# ---------------------------------------------------------------------------
# Multimodal message contract (image attach). A message ``content`` is EITHER a
# plain ``str`` (unchanged, the text-only path) OR a list of provider-neutral
# blocks: ``[{"type": "text", "text": ...},
#            {"type": "image", "image": {"mime": ..., "data_b64": ...},
#             "name": ...}]``. EVERY content reader below handles BOTH shapes and
# NEVER ``str()``s a list (that yields Python's list repr, i.e. garbage). When no
# message carries an image the list branch is never taken, so the text-only path
# is byte-identical to before this landed.
# ---------------------------------------------------------------------------

# Supported image MIME types (extension -> media type). png/jpeg/gif/webp only;
# everything else is rejected honestly by ``load_image_block``.
_IMAGE_MIMES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
_MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB cap — a chat attachment, not a payload.

# Providers whose flagship models can actually SEE an image (OpenAI gpt-4o/gpt-5
# class, Anthropic Claude 3.5+, Google Gemini). A LOCAL OpenAI-compatible server
# is conservatively assumed NOT vision-capable (opt in with SCPRISM_LOCAL_VISION);
# the offline stub and the CLI-bridge providers are never treated as vision.
VISION_PROVIDERS = frozenset({"openai", "claude", "gemini"})


def _content_text(content: Any) -> str:
    """The plain-text view of a message ``content`` — for hashing, token
    estimates, semantic bucketing, and the offline stub.

    A ``str`` is returned AS-IS (byte-identical). A list of blocks is flattened:
    text blocks join with newlines, and each image block contributes a short
    ``[image: <name>]`` marker so the text carries an HONEST trace that an image
    rode along (never the raw base64). Never ``str()``s the list itself.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for block in content:
            if not isinstance(block, dict):
                parts.append(str(block))
                continue
            btype = block.get("type")
            if btype == "text":
                parts.append(str(block.get("text", "")))
            elif btype == "image":
                parts.append(f"[image: {block.get('name') or 'image'}]")
        return "\n".join(parts)
    if content is None:
        return ""
    return str(content)  # defensive: never a list here (handled above)


def _has_image(messages: List[Dict[str, Any]]) -> bool:
    """True when ANY message carries an image block — the single gate that keeps
    the text-only path byte-identical (no image -> no message is ever rebuilt)."""
    for m in messages:
        content = m.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "image":
                    return True
    return False


def _blocks_of(content: Any) -> "tuple[str, List[Dict[str, Any]]]":
    """Split a ``content`` value into (joined_text, image_blocks).

    A ``str`` -> (itself, []). A list -> the joined text of its text blocks plus
    the list of its image blocks. Used by the per-provider payload builders.
    """
    if isinstance(content, str):
        return content, []
    if not isinstance(content, list):
        return _content_text(content), []
    texts: List[str] = []
    images: List[Dict[str, Any]] = []
    for block in content:
        if not isinstance(block, dict):
            texts.append(str(block))
            continue
        if block.get("type") == "text":
            texts.append(str(block.get("text", "")))
        elif block.get("type") == "image":
            images.append(block)
    return "\n".join(texts), images


def _image_not_sent_note(name: Any) -> str:
    """The HONEST fallback line for a non-vision route: the model is TOLD an image
    was attached and that it was NOT sent — never a fabricated 'I can see it'."""
    return (
        f"[image attached: {name or 'image'} — not sent; "
        f"this model/route doesn't support images]"
    )


def _openai_image_content(content: Any, supports_vision: bool) -> Any:
    """Build the OpenAI-compatible ``content`` for one message.

    * ``str`` (or a list with NO image) -> returned UNCHANGED (byte-identical).
    * list + vision -> ``[{"type":"text",...}, {"type":"image_url",
      "image_url":{"url":"data:<mime>;base64,<b64>"}}, ...]``.
    * list + NO vision -> the image is DROPPED and an honest note is PREPENDED to
      the text (a plain string; never a fake image block).
    """
    text, images = _blocks_of(content)
    if not images:
        return content
    if supports_vision:
        blocks: List[Dict[str, Any]] = [{"type": "text", "text": text}]
        for img in images:
            data = img.get("image", {}) or {}
            mime = data.get("mime", "image/png")
            b64 = data.get("data_b64", "")
            blocks.append(
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}
            )
        return blocks
    notes = "\n".join(_image_not_sent_note(img.get("name")) for img in images)
    return f"{notes}\n{text}" if text else notes


def _anthropic_image_content(content: Any, supports_vision: bool) -> Any:
    """Build the Anthropic Messages ``content`` for one message.

    * ``str`` (or a list with NO image) -> returned UNCHANGED (byte-identical).
    * list + vision -> ``[{"type":"text",...}, {"type":"image",
      "source":{"type":"base64","media_type":<mime>,"data":<b64>}}, ...]``.
    * list + NO vision -> image DROPPED, honest note PREPENDED to the text.
    """
    text, images = _blocks_of(content)
    if not images:
        return content
    if supports_vision:
        blocks: List[Dict[str, Any]] = [{"type": "text", "text": text}]
        for img in images:
            data = img.get("image", {}) or {}
            blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": data.get("mime", "image/png"),
                        "data": data.get("data_b64", ""),
                    },
                }
            )
        return blocks
    notes = "\n".join(_image_not_sent_note(img.get("name")) for img in images)
    return f"{notes}\n{text}" if text else notes


def _prepare_provider_messages(
    messages: List[Dict[str, Any]], supports_vision: bool, kind: str
) -> List[Dict[str, Any]]:
    """Rewrite each message's ``content`` for the target provider's wire shape.

    NO message carries an image -> the SAME ``messages`` object is returned
    unchanged, so the outbound body is byte-identical to the text-only path.
    Otherwise each image-bearing message is rebuilt (vision payload, or honest
    dropped-image note) while text-only messages pass through untouched.
    """
    if not _has_image(messages):
        return messages
    builder = _anthropic_image_content if kind == "anthropic" else _openai_image_content
    out: List[Dict[str, Any]] = []
    for m in messages:
        new_content = builder(m.get("content", ""), supports_vision)
        if new_content is m.get("content", ""):
            out.append(m)
        else:
            nm = dict(m)
            nm["content"] = new_content
            out.append(nm)
    return out


def load_image_block(path: str) -> Dict[str, Any]:
    """Read a local image file into a provider-neutral image block (stdlib only).

    Caps the file at 5 MB, detects the MIME from the extension (png/jpeg/gif/webp
    only), and returns ``{"type": "image", "image": {"mime", "data_b64"},
    "name"}``. Raises ``GatewayError`` (honest message) on an unsupported type, a
    missing/unreadable file, or an oversize image — never a fabricated block.
    """
    import base64
    import os

    ext = os.path.splitext(path)[1].lower()
    mime = _IMAGE_MIMES.get(ext)
    if mime is None:
        raise GatewayError(
            f"unsupported image type {ext or '(none)'!r} "
            f"(png/jpeg/gif/webp only)"
        )
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        raise GatewayError(f"cannot read image {path!r}: {exc}")
    if size > _MAX_IMAGE_BYTES:
        raise GatewayError(
            f"image too large: {size} bytes (cap {_MAX_IMAGE_BYTES})"
        )
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as exc:
        raise GatewayError(f"cannot read image {path!r}: {exc}")
    b64 = base64.b64encode(raw).decode("ascii")
    return {
        "type": "image",
        "image": {"mime": mime, "data_b64": b64},
        "name": os.path.basename(path) or "image",
    }


def _messages_text(messages: List[Dict[str, Any]]) -> str:
    return "\n".join(_content_text(m.get("content", "")) for m in messages)


def _user_text(messages: List[Dict[str, Any]]) -> str:
    users = [
        _content_text(m.get("content", ""))
        for m in messages
        if m.get("role") == "user"
    ]
    return "\n".join(users) if users else _messages_text(messages)


# Phrases that prove a CLI stopped to ask a HUMAN to authenticate. Matched
# against the output we already captured, so the classification is evidence,
# never a guess. Deliberately narrow: each one names an ACT of authenticating,
# so a model answering a question ABOUT login code cannot trip it.
_SIGNIN_MARKERS = (
    "opening authentication page",
    "authentication page in your browser",
    "authentication required",
    "not logged in",
    "not authenticated",
    "please log in",
    "please login",
    "login to continue",
    "sign in to continue",
    "oauth consent",
    "login`",
    "login\n",
    " login to authenticate",
)


def cli_signin_hint(bin_name: str, output: str) -> str:
    """An honest message when `output` proves the CLI was waiting on a sign-in.

    Returns "" when it does not — a genuine timeout must keep saying timeout.
    The bounded runner captures partial stdout before the kill, which is what
    makes this evidence rather than inference (2026-08-31: gemini hung 180s on
    "Opening authentication page… [Y/n]" and we reported a timeout).
    """
    low = (output or "").lower()
    if not any(m in low for m in _SIGNIN_MARKERS):
        return ""
    return (
        f"the {bin_name} CLI is not signed in — it stopped to ask for "
        f"authentication, which SC Prism cannot answer for you. Run "
        f"`{bin_name}` once in your own Terminal, sign in, then try again."
    )


# A subscription CLI that has spent its plan budget. Each marker names the
# LIMIT being hit, so a model explaining quotas in an answer cannot trip it.
_PLAN_LIMIT_MARKERS = (
    "usage limit reached",
    "reached your usage limit",
    "plan limit reached",
    "insufficient quota",
    "exceeded your current quota",
    "rate limit exceeded for your plan",
    "out of credits",
)


def cli_plan_limit_hint(bin_name: str, output: str) -> str:
    """An honest message when `output` proves the plan, not the app, ran out.

    Returns "" otherwise. A plan limit is NOT an outage — the same subscription
    usually has another model with budget left, so the message points at the
    switch instead of leaving the user with `claude exited 1: …`
    (the owner, 2026-08-31: Fable was out of budget while Opus worked).
    """
    low = (output or "").lower()
    if not any(m in low for m in _PLAN_LIMIT_MARKERS):
        return ""
    return (
        f"your {bin_name} plan is out of budget for the model you chose — this "
        f"is a billing limit, not a fault. Pick another model for this provider "
        f"in Settings (the same subscription usually has budget left on one), "
        f"then try again."
    )


def cli_argv_for(provider: str, messages: List[Dict[str, Any]]) -> List[str]:
    """The argv (minus the binary) for one CLI-bridge completion.

    Pure and separately testable BECAUSE the framing is the whole bug: a bridge
    that hands our system prompt to the model as user text gets refused as an
    injection attempt. A provider declaring ``system_argv`` receives the system
    prompt through its own flag and a clean user prompt; one without keeps the
    flattened prompt, which still CONTAINS the system text rather than losing it.
    """
    conf = _CLI_PROVIDERS[provider]
    system, conversation = _split_system(messages)
    conversation = _prepare_provider_messages(conversation, False, "openai")
    build_system = conf.get("system_argv")

    parts: List[str] = []
    if system and not build_system:
        parts.append(f"System instructions:\n{system}")
    for m in conversation:
        text = _content_text(m.get("content", ""))
        # With the system prompt in its own flag there is one voice left in the
        # `-p` string — the user's. Labelling it "user:" only re-introduces the
        # transcript shape that made the model read the whole thing as data.
        parts.append(text if build_system else f"{m.get('role', 'user')}: {text}")
    prompt = "\n\n".join(p for p in parts if p) or _user_text(messages)

    argv = list(conf["argv"](prompt))  # type: ignore[operator]
    if system and build_system:
        argv += list(build_system(system))  # type: ignore[operator]
    return argv


def _prompt_hash(messages: List[Dict[str, Any]]) -> str:
    blob = json.dumps(messages, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _semantic_key(messages: List[Dict[str, Any]]) -> str:
    """Normalized-intent bucket: lowercase, punctuation->space, collapse ws."""
    norm = re.sub(r"[^a-z0-9]+", " ", _user_text(messages).lower()).strip()
    norm = re.sub(r"\s+", " ", norm)
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def _split_system(
    messages: List[Dict[str, Any]],
) -> "tuple[str, List[Dict[str, Any]]]":
    """Split OpenAI-style messages for the Anthropic Messages API.

    Anthropic takes ``system`` as a top-level string (not a message role), so
    concatenate any ``system`` messages and return the remaining user/assistant
    turns as the conversation array.
    """
    system_parts: List[str] = []
    conversation: List[Dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content", "")
        if role == "system":
            # System content is always plain text; _content_text is str-safe
            # (a str returns itself) and never str()s a list.
            system_parts.append(_content_text(content))
        else:
            # Preserve the content shape (str OR image-bearing list) verbatim —
            # the per-provider builder rewrites it just before the POST.
            conversation.append({"role": role or "user", "content": content})
    return "\n".join(system_parts), conversation


def _extract_text(step_or_intent: Any) -> str:
    """Accept a Step (has .description), a raw string, or anything str()-able."""
    desc = getattr(step_or_intent, "description", None)
    if desc is not None:
        return str(desc)
    return str(step_or_intent)


class Gateway:
    """Provider abstraction + sensitivity routing + prompt/semantic cache."""

    def __init__(
        self,
        *,
        openai_base_url: Optional[str] = None,
        openai_api_key: Optional[str] = None,
        claude_api_key: Optional[str] = None,
        gemini_api_key: Optional[str] = None,
        primary: Optional[str] = None,
        openai_model: Optional[str] = None,
        claude_model: Optional[str] = None,
        gemini_model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        timeout: Optional[float] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> None:
        import os

        env = os.environ if env is None else env

        self.local_base_url = (
            openai_base_url or env.get("OPENAI_BASE_URL") or DEFAULT_LOCAL_URL
        )
        self.local_model = env.get("OPENAI_MODEL", "local-model")
        # A LOCAL OpenAI-compatible server is CONSERVATIVELY assumed to be
        # non-vision (most aren't). SCPRISM_LOCAL_VISION=1 opts a known
        # vision-capable local server in; default False keeps the honest
        # 'image not sent' fallback for local routes.
        self.local_supports_vision = (env.get("SCPRISM_LOCAL_VISION") or "").strip().lower() in (
            "1",
            "true",
            "yes",
            "on",
        )
        self.openai_api_key = openai_api_key or env.get("OPENAI_API_KEY")
        # A local OpenAI-compatible server may itself require an API key (e.g.
        # oMLX returning 401). It shares OPENAI_API_KEY with the cloud OpenAI
        # provider — the base URL disambiguates which endpoint is called.
        self.local_api_key = self.openai_api_key
        self.claude_api_key = (
            claude_api_key or env.get("CLAUDE_API_KEY") or env.get("ANTHROPIC_API_KEY")
        )
        self.gemini_api_key = (
            gemini_api_key or env.get("GEMINI_API_KEY") or env.get("GOOGLE_API_KEY")
        )
        # Real inference needs real time: a local server loads the model into
        # RAM on first call (5-30s+) and cloud completions stream for seconds.
        # The old 2.0s default starved EVERY real HTTP provider into the
        # honest stub (while looking healthy on the fast test stubs). Explicit
        # arg wins (tests pass tiny values for fast-fail); else
        # SCPRISM_HTTP_TIMEOUT; else 120s. Same clamp discipline as the
        # approval timeout: garbage / non-finite / <= 0 -> the default.
        if timeout is None:
            try:
                timeout = float(env.get("SCPRISM_HTTP_TIMEOUT", "") or 120.0)
            except (TypeError, ValueError):
                timeout = 120.0
            if not math.isfinite(timeout) or timeout <= 0:
                timeout = 120.0
        self.timeout = float(timeout)
        # Per-call bound for the subscription-CLI bridge (see
        # CLI_TIMEOUT_DEFAULT for why it sits under the app's 240s cancel).
        # Same clamp discipline as the HTTP timeout: garbage / non-finite /
        # <= 0 -> the default, so a bad override can never disable the bound.
        try:
            cli_timeout = float(env.get("SCPRISM_CLI_TIMEOUT", "") or CLI_TIMEOUT_DEFAULT)
        except (TypeError, ValueError):
            cli_timeout = CLI_TIMEOUT_DEFAULT
        if not math.isfinite(cli_timeout) or cli_timeout <= 0:
            cli_timeout = CLI_TIMEOUT_DEFAULT
        self.cli_timeout = float(cli_timeout)
        # The primary cloud provider: explicit arg > SCPRISM_PRIMARY env > the
        # first provider we hold a key for (see _pick_primary). When the USER
        # explicitly chose a primary (arg/env), default routing honors it —
        # their chosen co-founder answers unless sensitivity forces local.
        explicit = primary or env.get("SCPRISM_PRIMARY")
        self.primary = explicit or self._pick_primary()
        self.primary_explicit = bool(explicit) and self.primary != "local"
        # Whether the user made ANY explicit provider choice (arg/env), including
        # explicit LOCAL or a custom OpenAI-compat endpoint that maps to
        # primary='local'. `primary_explicit` above is cloud-only (it drives the
        # "answer with your chosen cloud co-founder" default), so it is False for
        # an explicit-local user — which must NOT let a learned policy override
        # their zero-egress choice. This flag gates the policy lane so an explicit
        # provider pick (local OR cloud) is always honored (LF-fix A).
        self.has_explicit_primary = bool(explicit)
        # User-defined sensitive words (interview → SCPRISM_SENSITIVE, comma
        # separated). Same force-local power as the built-in list.
        self.extra_sensitive = tuple(
            w.strip().lower()
            for w in (env.get("SCPRISM_SENSITIVE") or "").split(",")
            if w.strip()
        )
        # Thinking/effort level chosen by the user (low|medium|high|xhigh|max).
        # Mapped per provider: Anthropic extended thinking, OpenAI/Gemini
        # reasoning_effort, claude CLI --effort.
        self.effort = (env.get("SCPRISM_EFFORT") or "").strip().lower()
        # Model override for the CLI bridge (e.g. "opus", "fable"). A CLI
        # provider's display LABEL is not a real override (legacy client
        # stores persisted it as the model; as --model it kills every call) —
        # treat it as unset so the CLI picks its own default.
        cli_model = (env.get("SCPRISM_CLI_MODEL") or "").strip()
        if cli_model in {str(c["model"]) for c in _CLI_PROVIDERS.values()}:
            cli_model = ""
        self.cli_model = cli_model
        # Per-provider model overrides (optional). The client forwards the model
        # chosen in Settings; absent an override we use the honest default above.
        self.model_overrides = {
            "openai": openai_model or env.get("SCPRISM_OPENAI_MODEL"),
            "claude": claude_model or env.get("SCPRISM_CLAUDE_MODEL"),
            "gemini": gemini_model or env.get("SCPRISM_GEMINI_MODEL"),
        }
        # Max tokens for EVERY real provider. The Anthropic Messages API requires
        # it; the OpenAI-compat path used to omit it, so whatever per-request
        # default the server happened to use silently cut the answer short (an
        # oMLX reasoning model answered ~700 visible tokens and stopped
        # mid-sentence). Explicit arg > SCPRISM_MAX_TOKENS > DEFAULT_MAX_TOKENS.
        self.max_tokens = int(
            max_tokens or env.get("SCPRISM_MAX_TOKENS") or DEFAULT_MAX_TOKENS
        )

        # Per-process caches (fine for E1).
        self._prompt_cache: Dict[str, ModelCallResult] = {}
        self._semantic_cache: Dict[str, ModelCallResult] = {}
        # Observability counters (mirrors the Console's cache-warmth view).
        self.stats = {"prompt_hit": 0, "semantic_hit": 0, "miss": 0}

        # Adopted route-SELECTION policy (LF-2). Unset by default, so routing
        # uses the built-in rules for every user until they explicitly Apply a
        # promoted policy. When set (via set_route_policy), it decides ONLY the
        # final default lane of route() — local vs cloud for non-sensitive,
        # non-reasoning, non-explicit-primary work. This is route selection, not
        # the model "learning": the policy is the promoted stdlib softmax over
        # {local, cloud} per intent bucket, read back by load_current_route_policy.
        self._route_policy: Optional[Any] = None
        self._route_policy_version: str = ""

    # -- config ---------------------------------------------------------

    def _pick_primary(self) -> str:
        """Choose the single primary cloud provider by available key."""
        if self.claude_api_key:
            return "claude"
        if self.openai_api_key:
            return "openai"
        if self.gemini_api_key:
            return "gemini"
        return "openai"  # label default; offline stub covers a missing key

    def _key_for(self, provider: str) -> Optional[str]:
        return {
            "openai": self.openai_api_key,
            "claude": self.claude_api_key,
            "gemini": self.gemini_api_key,
        }.get(provider)

    def _cloud_usable(self) -> bool:
        """True when the PRIMARY can actually reach a cloud model — a real API
        key, or a self-authenticating CLI-bridge provider (no key needed).

        When False, forcing the reasoning lane to "cloud" would only hit the
        keyless offline stub while BYPASSING the local primary — so ``route()``
        honors the local primary instead of pretending to route to cloud (R2).
        """
        if self.primary in _CLI_PROVIDERS:
            return True
        return bool(self._key_for(self.primary))

    def _model_for(self, provider: str) -> str:
        """The model string sent to a provider — override, else honest default."""
        override = self.model_overrides.get(provider)
        if override and override.strip():
            return override.strip()
        conf = _PROVIDERS.get(provider, _PROVIDERS["openai"])
        return conf["model"]

    # -- routing --------------------------------------------------------

    def set_route_policy(self, policy: Any, version: str = "") -> None:
        """Adopt a trained route-SELECTION policy for the default routing lane.

        Affects ONLY the final default branch of ``route()`` (local-vs-cloud for
        non-sensitive, non-reasoning work) and is consulted ONLY when the user
        made NO explicit provider choice (arg/env). Sensitivity always keeps work
        local and any explicit provider pick — cloud OR local — always wins; all
        return before the policy is ever consulted, so an explicit-local user
        stays zero-egress no matter what the policy would prefer. This is route
        selection, not model fine-tuning: ``policy`` is the promoted stdlib
        softmax over {local, cloud} per intent bucket. ``version`` labels it for
        an honest route reason. Default (never called) → built-in rules only.
        """
        self._route_policy = policy
        self._route_policy_version = str(version)

    def route(
        self, step_or_intent: Union[str, Any], hint: Optional[str] = None
    ) -> RouteDecision:
        """Decide local vs cloud. Sensitivity wins over reasoning load — and over
        an explicit per-message ``hint``.

        ``hint`` is an OPTIONAL per-message route REQUEST (``"local"`` |
        ``"cloud"`` | ``None``) the user expresses in the composer. The gateway
        stays authoritative and grants it only WITHIN the zero-egress floor:

          * The SENSITIVITY branch is checked FIRST and is a HARD override — a
            sensitive keyword keeps the message LOCAL even when the user asked
            for cloud. The reason then acknowledges the refusal, so the
            attribution chip stays honest ("you asked for cloud, but …").
          * With no sensitivity hit, the hint is honored immediately (before the
            reasoning/primary/policy lanes): ``"local"`` forces local; ``"cloud"``
            routes to the primary IF a cloud provider is usable, else honestly
            stays local and says so.
          * ``hint is None`` (the default) falls through to the existing branches
            unchanged — every no-hint call is BYTE-IDENTICAL to before this
            landed.
        """
        text = _extract_text(step_or_intent)
        low = text.lower()

        hit = sensitive_hit(text, self.extra_sensitive)
        if hit:
            # The sensitivity floor is a HARD override: even an explicit "cloud"
            # request cannot egress a secret. Acknowledge the refusal in the
            # reason so the chip tells the truth (asked cloud, kept local).
            if hint == "cloud":
                return self._local_decision(
                    reason=(
                        f"you asked for cloud, but sensitive keyword '{hit}' "
                        f"-> kept local (no egress)"
                    ),
                    matched=hit,
                )
            return self._local_decision(
                reason=f"sensitive keyword '{hit}' -> keep local (no egress)",
                matched=hit,
            )

        # Per-message route hint — honored AFTER the sensitivity floor, BEFORE the
        # reasoning/primary/policy lanes. Only "local"/"cloud" act; None is a
        # no-op that falls through to the existing rules (byte-identical).
        if hint == "local":
            return self._local_decision(
                reason="you chose local for this message", matched=""
            )
        if hint == "cloud":
            # Honor "cloud" only when a cloud provider is actually usable (a real
            # key or a self-authenticating CLI bridge); otherwise forcing the
            # cloud lane would just hit the keyless offline stub while bypassing
            # the local primary — so stay local and say so honestly (R2 logic).
            if self._cloud_usable():
                return self._cloud_decision(
                    reason="you chose cloud for this message", matched=""
                )
            return self._local_decision(
                reason=(
                    "you asked for cloud, but no cloud provider is configured "
                    "-> local"
                ),
                matched="",
            )

        heavy = next((k for k in REASONING_KEYWORDS if k in low), None)
        if heavy:
            # Heavy reasoning prefers cloud — but ONLY when a cloud provider is
            # actually usable (a real key, or a self-authenticating CLI bridge).
            # With no cloud configured, forcing the "cloud" lane would just hit
            # the keyless offline stub while BYPASSING the local primary — and
            # the verdict card would lie ("routed to your primary") though the
            # primary never answered. Honor the local primary instead (R2).
            if self._cloud_usable():
                return self._cloud_decision(
                    reason=f"reasoning keyword '{heavy}' -> cloud", matched=heavy
                )
            return self._local_decision(
                reason="heavy reasoning, but no cloud configured -> local",
                matched=heavy,
            )

        # No sensitivity, no heavy-reasoning marker: the user's EXPLICIT
        # primary answers by default (that is who they chose to talk to).
        if self.primary_explicit:
            return self._cloud_decision(
                reason=f"default -> primary ({self.primary}) per user selection",
                matched="",
            )

        # Still the default lane. With an adopted route-SELECTION policy (LF-2),
        # let it choose local-vs-cloud by the intent's TRAINING bucket — the
        # decision the golden-gated flywheel actually promoted. Consulted ONLY
        # when the user made no explicit provider choice: an explicit pick (cloud
        # already returned above via primary_explicit; local reaches here) must
        # be honored, so a learned policy can never egress an explicit-local
        # user's work to cloud (LF-fix A). No policy set (or a policy that can't
        # score this text) → the built-in zero-egress default, byte-identical.
        if self._route_policy is not None and not self.has_explicit_primary:
            learned = self._route_policy_decision(text)
            if learned is not None:
                return learned
        return self._local_decision(
            reason="default -> local (cheap, zero egress)", matched=""
        )

    def _route_policy_decision(self, text: str) -> Optional[RouteDecision]:
        """The default-lane route chosen by the adopted route policy, or None.

        Buckets ``text`` with the SAME categorization used in training
        (``grpo.task_bucket`` — the shared helper, not a re-implemented keyword
        table), reads the policy's action distribution for that bucket, and takes
        the argmax over {local, cloud} (a tie → local, the zero-egress default).
        The route reason names the version + bucket + probability HONESTLY, e.g.
        ``learned route policy v3: bucket 'docs' -> cloud (p=0.61)`` — that reason
        already flows into every model_call span, so Manager View shows the
        learned decision truthfully for free. Any failure (bad policy, unscoreable
        bucket) → None so ``route()`` falls through to the built-in default.
        """
        try:
            from .grpo import task_bucket  # shared bucketing (no keyword dup)

            bucket = task_bucket({"task_intent": text})
            probs = self._route_policy.act(bucket)
            p_local = float(probs.get(LOCAL, 0.0))
            p_cloud = float(probs.get(CLOUD, 0.0))
        except Exception:
            return None
        version = self._route_policy_version or "current"
        if p_cloud > p_local:  # tie → local (the zero-egress default)
            return self._cloud_decision(
                reason=(
                    f"learned route policy {version}: bucket '{bucket}' "
                    f"-> cloud (p={p_cloud:.2f})"
                ),
                matched=bucket,
            )
        return self._local_decision(
            reason=(
                f"learned route policy {version}: bucket '{bucket}' "
                f"-> local (p={p_local:.2f})"
            ),
            matched=bucket,
        )

    def guard_tool_result(self, content: str) -> Tuple[str, bool]:
        """The F1 tool-RESULT egress gate for THIS gateway's user.

        The module-level ``guard_cloud_tool_result`` can only see the built-in
        ``SENSITIVE_KEYWORDS``; this instance method adds the words the USER
        declared sensitive in the interview (``SCPRISM_SENSITIVE`` ->
        ``extra_sensitive``), which ``route()`` has always honored and the
        result guard never could. Built-ins are kept, not replaced.
        """
        return guard_cloud_tool_result(content, self.extra_sensitive)

    def local_route_for(
        self, reason: str, matched: str = ""
    ) -> Optional[RouteDecision]:
        """A LOCAL ``RouteDecision`` carrying ``reason``, or None when this
        install has no local endpoint to route to.

        The caller-facing seam for a MID-RUN force-local (the loop uses it when
        a vault tool hands back the user's own notes on a cloud route). None is
        the honest "there is nowhere local to send this" answer — the caller
        must then WITHHOLD the content rather than fall back to cloud, so a
        missing local model can never become a silent egress.
        """
        if not str(self.local_base_url or "").strip():
            return None
        return self._local_decision(reason=reason, matched=matched)

    def _local_decision(self, *, reason: str, matched: str) -> RouteDecision:
        return RouteDecision(
            target=LOCAL,
            provider="local",
            model=self.local_model,
            base_url=self.local_base_url,
            is_local=True,
            reason=reason,
            matched=matched,
            api_key=self.local_api_key,
            supports_vision=self.local_supports_vision,
        )

    def _cloud_decision(self, *, reason: str, matched: str) -> RouteDecision:
        # CLI-bridge primary: no base URL, no key — the local CLI authenticates
        # itself with the user's subscription login. The one-shot CLI bridge
        # flattens the chat to a text prompt, so it can't carry an image →
        # supports_vision stays False (the honest 'not sent' note fires).
        if self.primary in _CLI_PROVIDERS:
            return RouteDecision(
                target=CLOUD,
                provider=self.primary,
                model=self.cli_model or str(_CLI_PROVIDERS[self.primary]["model"]),
                base_url="",
                is_local=False,
                reason=reason,
                matched=matched,
                api_key=None,
                supports_vision=False,
            )
        conf = _PROVIDERS.get(self.primary, _PROVIDERS["openai"])
        return RouteDecision(
            target=CLOUD,
            provider=self.primary,
            model=self._model_for(self.primary),
            base_url=conf["base_url"],
            is_local=False,
            reason=reason,
            matched=matched,
            api_key=self._key_for(self.primary),
            supports_vision=self.primary in VISION_PROVIDERS,
        )

    # -- model call -----------------------------------------------------

    def model_call(
        self, messages: List[Dict[str, Any]], route: RouteDecision
    ) -> ModelCallResult:
        """Call a model through the gateway, honoring prompt + semantic cache.

        Returns a ModelCallResult carrying text, token counts, and the cache
        outcome ('prompt'/'semantic'/'miss'). A miss makes a real HTTP call if
        reachable, else a deterministic offline stub.
        """
        pkey = _prompt_hash(messages)
        if pkey in self._prompt_cache:
            self.stats["prompt_hit"] += 1
            return self._with_cache(self._prompt_cache[pkey], "prompt")

        skey = _semantic_key(messages)
        if skey in self._semantic_cache:
            self.stats["semantic_hit"] += 1
            hit = self._with_cache(self._semantic_cache[skey], "semantic")
            # Promote to the exact-prompt cache for next time.
            self._prompt_cache[pkey] = hit
            return hit

        # Cache miss — invoke (real or stub).
        text, tin, tout, is_real, truncated = self._invoke(messages, route)
        result = ModelCallResult(
            text=text,
            tokens_in=tin,
            tokens_out=tout,
            cache="miss",
            provider=route.provider,
            model=route.model,
            is_real=is_real,
            truncated=truncated,
        )
        self.stats["miss"] += 1
        self._prompt_cache[pkey] = result
        self._semantic_cache[skey] = result
        return result

    @staticmethod
    def _with_cache(base: ModelCallResult, cache: str) -> ModelCallResult:
        return ModelCallResult(
            text=base.text,
            tokens_in=base.tokens_in,
            tokens_out=base.tokens_out,
            cache=cache,
            provider=base.provider,
            model=base.model,
            is_real=base.is_real,
            truncated=base.truncated,
        )

    def _invoke(self, messages, route):
        """Real provider HTTP POST; deterministic stub on any error / no key.

        Per-provider request construction (ADR-026):
          * local + openai + gemini -> OpenAI-compatible ``chat/completions``
            with ``Authorization: Bearer``. Gemini uses Google's OpenAI-compat
            path (``/v1beta/openai/chat/completions``).
          * claude -> the Anthropic Messages API (``/v1/messages``), a SEPARATE
            code path with ``x-api-key`` + ``anthropic-version`` and the
            ``{model, max_tokens, messages, system}`` body shape.
        """
        # CLI-bridge providers authenticate via their own login, not a key.
        if route.provider in _CLI_PROVIDERS:
            try:
                return self._invoke_cli(messages, route)
            except GatewayTimeout as exc:
                # A TIMEOUT is its own story: the CLI was alive, we killed it.
                # The deterministic stub would say "handled: <prompt>", which
                # reads as an offline provider and hides the real cause.
                return self._timed_out(messages, route, str(exc))
            except Exception as exc:
                # CLI missing / not signed in / non-zero exit. NAME it: a stub
                # that says only "handled:" leaves the user with no idea whether
                # their CLI is missing, signed out, or simply broken.
                return self._named_offline(messages, route, _offline_cause(exc))

        # A cloud route without a key can't authenticate — go straight to stub
        # rather than making a doomed request. (Local may be keyless.)
        if not route.is_local and not route.api_key:
            return self._stub(messages, route)

        try:
            return self._invoke_with_retry(messages, route)
        except urllib.error.HTTPError as err:
            # HONESTY: the LOCAL model could not be LOADED. The server answered
            # (507 / "would exceed the metal_cap memory ceiling") — it is up, it
            # simply cannot fit this model beside what is already resident. That
            # is a specific, fixable thing (unload a model, or pick a smaller
            # one) and it must never again be reported as an unreachable
            # provider, which is what the stub below made the app say.
            if route.is_local:
                body = _err_body(err)
                reason = local_load_failure(err.code, body)
                if reason:
                    return self._named_offline(messages, route, reason)
            # A non-retryable 4xx means the provider REFUSED what WE sent (an
            # invalid request shape, a bad key, an unknown model) — that is our
            # bug, not an outage, and dressing it as an offline stub tells the
            # user "the model didn't answer" instead of naming the cause.
            # Retryable statuses that exhausted their backoff really are an
            # outage, so those keep the stub.
            if 400 <= err.code < 500 and err.code not in RETRY_STATUSES:
                return self._rejected(messages, route, err)
            return self._stub(messages, route)
        except Exception as exc:
            # No endpoint / refused / timeout / bad payload. This used to return
            # the blind stub, which is how a run came to produce three
            # stand-ins with `error: null` on every span — real work stopping
            # for a reason nobody recorded. The cause is named now.
            return self._named_offline(messages, route, _offline_cause(exc))

    def _invoke_with_retry(self, messages, route):
        """Invoke, retrying a MALFORMED BODY a bounded number of times.

        WHY THIS EXISTS. The owner's local server answers short probes perfectly
        and then, partway through a long agentic run, returns a body that is not
        a completion at all — no ``choices`` key, or a truncated read. Four
        separate multi-minute wakes died on it (``KeyError: 'choices'``,
        ``IncompleteRead``), each after six to fifteen minutes of real work, and
        each was recorded as the provider being offline. It is not offline: the
        very next request succeeds.

        A malformed body is an INFRASTRUCTURE FAULT, in the same family as a
        broken pipe — it carries no verdict from the model, so retrying it asks
        the same question again rather than papering over an answer. That is the
        line: a 4xx is the provider REFUSING what we sent and is never retried
        here (it would just be refused again, and the honest report is the
        refusal); a timeout is the provider being genuinely too slow and is
        already handled above.

        Bounded at two extra attempts with a short backoff. If the shape is
        still wrong after that, the exception propagates and the caller names
        the cause exactly as before — a persistent fault must not be retried
        into a silent hang.
        """
        last: Exception
        for attempt in range(MALFORMED_RETRIES + 1):
            try:
                if route.provider == "claude":
                    return self._invoke_anthropic(messages, route)
                return self._invoke_openai(messages, route)
            except (KeyError, IndexError, TypeError, ValueError, http.client.IncompleteRead) as exc:
                # The body was not a completion. Every one of these means "the
                # server said something we cannot read as an answer", never
                # "the model answered and we disliked it".
                last = exc
                if attempt >= MALFORMED_RETRIES:
                    break
                time.sleep(MALFORMED_BACKOFF_S * (2 ** attempt))
        raise last

    def _post_json(self, req) -> Dict[str, Any]:
        """POST + parse, with bounded exponential backoff on rate limits.

        429/503/529 → wait 1s, 2s, 4s and retry; any other error (or the
        final rate-limit) propagates so `_invoke` falls to the offline stub.
        """
        for attempt in range(RETRY_ATTEMPTS + 1):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as err:
                if err.code not in RETRY_STATUSES or attempt == RETRY_ATTEMPTS:
                    raise
                _sleep(RETRY_BASE_DELAY * (2**attempt))
        raise RuntimeError("unreachable")  # loop always returns or raises

    @staticmethod
    def _chat_url(route) -> str:
        """OpenAI-compatible chat/completions URL for local/openai/gemini."""
        base = route.base_url.rstrip("/")
        if route.provider == "gemini":
            # Google's OpenAI-compat endpoint lives under /v1beta/openai.
            return base + "/v1beta/openai/chat/completions"
        return base + "/v1/chat/completions"

    def _invoke_openai(self, messages, route):
        """OpenAI-compatible POST (local, OpenAI, Gemini). Bearer auth."""
        url = self._chat_url(route)
        # Multimodal: rebuild any image-bearing message for the OpenAI wire shape
        # (real image_url block on a vision route; honest dropped-image note
        # otherwise). No image -> the SAME list, byte-identical to the text path.
        payload_messages = _prepare_provider_messages(
            messages, route.supports_vision, "openai"
        )
        body_obj: Dict[str, Any] = {
            "model": route.model,
            "messages": payload_messages,
            "temperature": 0,
            # ALWAYS explicit: without it the server's own per-request default
            # decides how long an answer may be, and a reasoning model spends
            # part of that budget thinking (see DEFAULT_MAX_TOKENS).
            "max_tokens": self.max_tokens,
        }
        # Thinking effort → OpenAI/Gemini `reasoning_effort` (their compat
        # layers accept low|medium|high; clamp the CLI's xhigh/max to high).
        if self.effort and route.provider in ("openai", "gemini"):
            body_obj["reasoning_effort"] = (
                "high" if self.effort in ("xhigh", "max") else self.effort
            )
        body = json.dumps(body_obj).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json"},
        )
        if route.api_key:
            req.add_header("Authorization", f"Bearer {route.api_key}")
        payload = self._post_json(req)
        choice = payload["choices"][0]
        text = choice["message"]["content"]
        usage = payload.get("usage", {}) or {}
        tin = int(usage.get("prompt_tokens", _est_tokens(_messages_text(messages))))
        tout = int(usage.get("completion_tokens", _est_tokens(text)))
        # OpenAI-compat says finish_reason == "length" when the cap cut the reply
        # off. Capture it — a cut-off answer must never be presented as complete.
        truncated = str(choice.get("finish_reason") or "") == "length"
        return text, tin, tout, True, truncated

    def _invoke_anthropic(self, messages, route):
        """Anthropic Messages API POST — the Claude-specific path.

        Maps any ``system`` message to the top-level ``system`` field and sends
        the rest as the ``messages`` array; parses ``content[0].text`` back.
        """
        url = route.base_url.rstrip("/") + "/v1/messages"
        system, conversation = _split_system(messages)
        # Multimodal: rebuild any image-bearing turn for the Anthropic wire shape
        # (real image source block on a vision route; honest dropped-image note
        # otherwise). No image -> the SAME conversation, byte-identical.
        conversation = _prepare_provider_messages(
            conversation, route.supports_vision, "anthropic"
        )
        payload_obj: Dict[str, Any] = {
            "model": route.model,
            "max_tokens": self.max_tokens,
            "messages": conversation,
        }
        if system:
            payload_obj["system"] = system
        # Thinking effort → Anthropic ADAPTIVE thinking (see ANTHROPIC_EFFORTS).
        # The legacy {"type": "enabled", "budget_tokens": N} shape this used to
        # send is rejected outright by current Claude models, so every API-key
        # user who picked ANY effort got a 400 — and the honest fallback then
        # turned that into an offline stub, which reads as "the model didn't
        # answer" rather than "we sent an invalid request". A model with no
        # adaptive mode gets no thinking field at all.
        if self.effort in ANTHROPIC_EFFORTS and _supports_adaptive_thinking(route.model):
            payload_obj["thinking"] = {"type": "adaptive"}
            payload_obj["output_config"] = {"effort": self.effort}
            payload_obj["max_tokens"] = max(
                self.max_tokens, ANTHROPIC_MAX_TOKENS_FLOOR[self.effort]
            )
        body = json.dumps(payload_obj).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json"},
        )
        req.add_header("x-api-key", route.api_key or "")
        req.add_header("anthropic-version", ANTHROPIC_VERSION)
        payload = self._post_json(req)
        text = payload["content"][0]["text"]
        usage = payload.get("usage", {}) or {}
        tin = int(usage.get("input_tokens", _est_tokens(_messages_text(messages))))
        tout = int(usage.get("output_tokens", _est_tokens(text)))
        # The Anthropic spelling of the same signal (see _invoke_openai).
        truncated = str(payload.get("stop_reason") or "") == "max_tokens"
        return text, tin, tout, True, truncated

    def _invoke_cli(self, messages, route):
        """One-shot call through a subscription-authenticated local CLI.

        Flattens the chat into a single prompt (system block + turns), runs the
        CLI non-interactively in a throwaway temp dir (so an agentic CLI has
        nothing to read or touch), and returns its stdout as the completion.
        Raises on any failure — the caller falls back to the offline stub.
        """
        import os
        import tempfile

        conf = _CLI_PROVIDERS[route.provider]
        bin_path = _find_cli(str(conf["bin"]))
        if not bin_path:
            raise GatewayError(f"{conf['bin']} CLI not installed")

        # Agent CLIs think + stream; give them real time (env-overridable),
        # never the gateway's short HTTP timeout. Read at construction — see
        # `self.cli_timeout` — so an explicit `Gateway(env=…)` is honored too.
        cli_timeout = self.cli_timeout

        # ONE build of the argv, shared with `cli_argv_for` so what the tests
        # pin is exactly what runs: the system prompt travels in the provider's
        # own flag where it has one, and only the user's words go into `-p`.
        argv = [bin_path] + cli_argv_for(route.provider, messages)
        # User-chosen model + thinking effort (claude CLI supports both flags).
        if route.provider == "claude-cli":
            if self.cli_model:
                argv += ["--model", self.cli_model]
            if self.effort in ("low", "medium", "high", "xhigh", "max"):
                argv += ["--effort", self.effort]
        with tempfile.TemporaryDirectory(prefix="scprism-cli-") as tmp:
            out_file = os.path.join(tmp, "last-message.txt")
            if route.provider == "codex-cli":
                # codex prints progress logs to stdout; ask it to also write
                # just the final message to a file we can read cleanly.
                argv = argv[:-1] + ["--output-last-message", out_file, argv[-1]]
            # NOT `subprocess.run(timeout=…)`: that bound is unenforceable here.
            # It kills only the direct child (these CLIs are node programs whose
            # real work is a grandchild) and it measures on a clock that stops
            # while the Mac sleeps, so a wake started on a maintenance DarkWake
            # ran for 48 WALL minutes against a "180s" bound and answered long
            # after the app had cancelled the run. `run_bounded` kills the whole
            # process group and measures on the longer of the two clocks —
            # the same wall clock the app's 240s cancel uses. See proc.py.
            proc = proc_util.run_bounded(
                argv,
                timeout=cli_timeout,
                cwd=tmp,
                # These CLIs are node programs that shell out to `node`/`npx`;
                # a GUI-inherited PATH cannot see an nvm install (same root
                # cause as the Tier-1 verify failure), so hand them a real one.
                env=toolpath.env_with_path(),
            )
            # A CLI that stopped to ask a HUMAN to sign in is not slow and not
            # broken — and saying "did not answer within 180s" sends the user
            # hunting the wrong problem. Check the output we already captured
            # BEFORE classifying, on both the timeout and the non-zero paths.
            captured = (proc.stdout or "") + "\n" + (proc.stderr or "")
            # Two endings that look like a failure but are neither: the CLI is
            # waiting on a human to sign in, or the plan is out of budget. Both
            # have a fix the user can act on, so both must say it.
            blocked = cli_signin_hint(str(conf["bin"]), captured) or cli_plan_limit_hint(
                str(conf["bin"]), captured
            )
            if proc.timed_out:
                if blocked:
                    raise GatewayError(blocked)
                # HONESTY: we killed a LIVE program. Say so — and say it in the
                # words the user needs ("did not answer within Ns"), never as a
                # generic failure and never as a completion.
                raise GatewayTimeout(
                    f"the {conf['bin']} CLI did not answer within "
                    f"{int(cli_timeout)}s"
                )
            if proc.returncode != 0:
                if blocked:
                    raise GatewayError(blocked)
                err = (proc.stderr or proc.stdout or "").strip()
                raise GatewayError(f"{conf['bin']} exited {proc.returncode}: {err[:200]}")
            text = ""
            if route.provider == "codex-cli" and os.path.isfile(out_file):
                with open(out_file, "r", encoding="utf-8") as f:
                    text = f.read().strip()
            if not text:
                text = (proc.stdout or "").strip()
        if not text:
            raise GatewayError(f"{conf['bin']} produced no output")

        tin = _est_tokens(_messages_text(messages))
        tout = _est_tokens(text)
        # A CLI bridge has no cap of ours to hit and reports no length signal.
        return text, tin, tout, True, False

    @staticmethod
    def _rejected(messages, route, err):
        """Honest stand-in when the provider REFUSED our request (4xx).

        Deliberately NOT the offline stub: a stub is the honest answer when
        there is nowhere real to call, but a rejection means we DID reach the
        provider and it told us the request was wrong. The text names the cause
        (status + the provider's own message) and carries the `[rejected:`
        marker so the loop treats it as a diagnostic, never as chat content.
        """
        detail = _err_body(err)
        text = (
            f"[rejected:{route.provider}:{route.model}] "
            f"provider refused the request (HTTP {err.code})"
            + (f": {detail[:300]}" if detail else "")
        )
        return text, _est_tokens(_messages_text(messages)), 0, False, False

    @staticmethod
    def _timed_out(messages, route, detail):
        """Honest stand-in when WE gave up on a live provider.

        Keeps the ``[offline:`` prefix on purpose: that prefix is the client's
        contract for "this is NOT model output" (`isRealCompletion`), and a
        killed call is exactly that — so the app still falls back to its honest
        offline path instead of surfacing this as an answer. What changes is the
        REASON: it names the bound we enforced ("the claude CLI did not answer
        within 180s") instead of the stub's "handled: …".

        ``is_real`` is False and ``tokens_out`` is 0: no reply came back, and
        the provider-side spend of a killed run is unknowable from here — an
        estimate would be a fabrication. The ``model_call`` span therefore
        records ``is_real=false`` with a duration of about the bound, which is
        the truth of what happened.
        """
        return Gateway._named_offline(messages, route, detail)

    @staticmethod
    def _named_offline(messages, route, detail):
        """The ``[offline:`` stand-in that NAMES its cause.

        Shared by every ending where something real happened and we know what
        it was: we killed a live CLI (`_timed_out`), or the local server
        refused to load the model (`local_load_failure`). The prefix keeps the
        client's "this is not model output" contract; the reason is what the
        client renders instead of "the provider is unreachable".
        """
        return (
            f"[offline:{route.provider}:{route.model}] {detail}",
            _est_tokens(_messages_text(messages)),
            0,
            False,
            False,
        )

    @staticmethod
    def _stub(messages, route):
        """Deterministic offline response seeded by the message hash."""
        h = _prompt_hash(messages)
        seed = int(h[:8], 16)
        prompt = _user_text(messages)
        text = (
            f"[offline:{route.provider}:{route.model}] "
            f"handled: {prompt} ({h[:8]})"
        )
        tin = _est_tokens(_messages_text(messages))
        tout = max(1, (seed % 40) + 8)  # stable, non-zero, hash-derived
        return text, tin, tout, False, False  # the stub is always complete
