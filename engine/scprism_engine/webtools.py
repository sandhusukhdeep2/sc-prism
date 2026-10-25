"""Governed web-research tool source (web design, 2026-07-23) — stdlib only.

Lets the companion look things up on the internet mid-run — `web_fetch(url)` and
`web_search(query)` — under the SAME governance as MCP tools. This is a tool
SOURCE, MCPClient-SHAPED (``list_tools()`` + ``call_tool(name, args)`` +
``parent_span_id`` + ``telemetry``), so the v2b tool-use loop (loop.py:238-245)
consumes it unchanged and every v2b guarantee is inherited for free:

  * **Arg gate** — the sensitivity gate (``gateway.SENSITIVE_KEYWORDS``, raising
    ``mcp.MCPBlockedError``) runs on the query/URL BEFORE any bytes egress, so a
    secret can never be searched or fetched. REUSED from the gateway + mcp, never
    duplicated.
  * **Result gate** — fetched content passes the loop's F1 cloud-withhold guard
    (built from the route in loop.py), so sensitive fetched text is withheld
    before a cloud POST.
  * **Telemetry** — every call is a ``tool_exec`` span (``provider="web"``,
    tool, blocked), nested under the dispatch span like MCPClient's own spans.
    An allowed call ALSO records what it actually did — ``url``/``host``/
    ``status``/``bytes`` for a fetch, ``query``/``result_count`` for a search —
    so the UI can say ``🌐 web·web_fetch · docs.anthropic.com — 200, 48 KB``
    instead of "fetching a page from the web…". This is the ONE place tool
    arguments may be recorded, and only because they already egressed; see
    **THE PRIVACY LINE** further down this file before copying the pattern.
  * **Bounded** — the loop's ``max_iters`` + token budget already cap it.

Honesty is the invariant: real HTTP only (``urllib`` / ``html.parser``, no
third-party); a failure is an honest ``isError`` result the model sees, never a
fabricated hit; results carry the REAL source URLs so citations survive; a
blocked call RAISES ``MCPBlockedError`` and still emits a ``blocked=True``
``tool_exec`` span so the block is auditable.

SSRF: ``web_fetch`` allows only http/https and (unless ``allow_private`` — the
test-fixture escape hatch, default OFF) rejects loopback / private / link-local /
reserved hosts. The SECURITY BOUNDARY is post-connect: the opener's custom
``HTTP(S)Connection`` classes re-vet the REAL connected peer IP
(``sock.getpeername()``) after ``connect()`` and drop the socket before any
request bytes egress — so a DNS-rebinding domain (public IP to a pre-check, a
private/metadata IP to the actual socket) is caught because the vetted address
IS the connected address, and every redirect hop opens a fresh connection that is
re-vetted for free. The cheap pre-resolution reject + the per-hop redirect check
remain as defense-in-depth fast paths. HTTPS keeps normal cert validation
(connect by hostname; the peer-IP check runs after the TLS handshake).

Opt-in by construction: nothing here runs unless the caller builds a provider
(``--web``); absent that, the engine is byte-identical.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import socket
import re
from html import unescape as html_unescape
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Sequence

from .gateway import SENSITIVE_KEYWORDS, sensitive_hit
from .mcp import MCPBlockedError, MCPTool

# A short, honest User-Agent so a fetched server can identify the client.
_USER_AGENT = "sc-prism-webtools/1 (+https://scprism.local)"

# Default keyless search endpoint (DuckDuckGo Instant-Answer JSON API).
_DEFAULT_KEYLESS_ENDPOINT = "https://api.duckduckgo.com/"

# The keyless results page answers browser-shaped clients only; we keep our
# own name in the string so a served host can still identify SC Prism.
_RESULTS_PAGE_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) sc-prism/1"
)


def _error(message: str, **extra: Any) -> Dict[str, Any]:
    """An honest MCP-style error result the model sees (never raises out).

    ``extra`` carries the same factual fields a SUCCESS result carries (``url``,
    ``status``, ``bytes``) when the failure actually knew them — a 404 really
    does have a host and a status, and dropping them is what made a failed fetch
    read as an anonymous "couldn't fetch that page". Only non-None values are
    attached, so a failure that knew nothing still says nothing.
    """
    out: Dict[str, Any] = {
        "isError": True,
        "content": [{"type": "text", "text": message}],
    }
    for key, value in extra.items():
        if value is not None:
            out[key] = value
    return out


# -- SSRF guard --------------------------------------------------------------


# The well-known NAT64 prefix (RFC 6052 §2.1). A DNS64 resolver — macOS
# synthesizes these on IPv6-only / CLAT networks — returns AAAA records inside
# it whose low 32 bits ARE the real IPv4 destination.
_NAT64_WELL_KNOWN = ipaddress.IPv6Network("64:ff9b::/96")


def _embedded_ipv4(ip: Any) -> Any:
    """The IPv4 address an IPv6 address REALLY reaches, or None.

    Covers the three forms that carry an IPv4 destination inside an IPv6
    address: IPv4-mapped (``::ffff:a.b.c.d``, what a dual-stack socket reports
    for an IPv4 peer), NAT64 (``64:ff9b::a.b.c.d``, what a DNS64 resolver
    synthesizes), and 6to4 (``2002:AABB:CCDD::``). Anything else -> None.
    """
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        return mapped
    if getattr(ip, "version", None) != 6:
        return None
    if ip in _NAT64_WELL_KNOWN:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return getattr(ip, "sixtofour", None)


def _ip_is_blocked(ip: Any) -> bool:
    """The per-IP predicate: True when an ``ipaddress`` object is one we must
    never reach (loopback / private / link-local / reserved / multicast /
    unspecified — e.g. ``169.254.169.254`` is link-local). Shared by BOTH the
    pre-resolution reject and the post-connect peer re-vet so the two agree.

    An IPv6 address that EMBEDS an IPv4 one is judged by the IPv4 it actually
    reaches (2026-08-18). Python classifies the wrapper, not the destination,
    and that was wrong in BOTH directions:
      * a false BLOCK — ``::ffff:104.18.43.76`` (a public CDN host, and exactly
        what a dual-stack resolver/socket hands back on some networks) reports
        ``is_private`` AND ``is_reserved``, so a perfectly public site was
        refused as an SSRF target;
      * a false ALLOW — ``2002:0a00:0001::`` (6to4 wrapping 10.0.0.1) reports
        neither, so a private address could have been reached through it.
    Unwrapping first fixes the first and closes the second.
    """
    embedded = _embedded_ipv4(ip)
    if embedded is not None:
        ip = embedded
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _ssrf_reject_reason(url: str, allow_private: bool = False) -> Optional[str]:
    """Return WHY ``url`` must not be fetched (SSRF), or None to allow it.

    Always enforces the http/https allowlist. Unless ``allow_private`` (the
    test-fixture escape hatch — a run NEVER sets it), also rejects loopback,
    private, link-local, reserved, multicast and unspecified hosts, resolving a
    hostname first so ``foo.example`` that maps to ``127.0.0.1`` is caught too.
    """
    try:
        parts = urllib.parse.urlsplit(url)
    except (ValueError, AttributeError):
        return "malformed url"
    scheme = (parts.scheme or "").lower()
    if scheme not in ("http", "https"):
        return "scheme %r is not allowed (only http/https)" % scheme
    host = parts.hostname
    if not host:
        return "url has no host"
    if allow_private:
        return None
    h = host.lower().rstrip(".")
    if h == "localhost" or h.endswith(".localhost"):
        return "host %r is not allowed (loopback)" % host
    ips: List[Any] = []
    try:
        ips.append(ipaddress.ip_address(host))
    except ValueError:
        # A hostname: resolve it and vet every address it maps to.
        try:
            for info in socket.getaddrinfo(host, None):
                addr = str(info[4][0]).split("%")[0]  # drop any IPv6 scope id
                try:
                    ips.append(ipaddress.ip_address(addr))
                except ValueError:
                    continue
        except (socket.gaierror, OSError, UnicodeError):
            return "host %r could not be resolved" % host
    if not ips:
        return "host %r could not be resolved" % host
    for ip in ips:
        if _ip_is_blocked(ip):
            return "host %r resolves to a blocked address (%s)" % (host, ip)
    return None


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Vet each redirect target with the SSRF guard before following it.

    A redirect to a rejected host raises ``HTTPError`` (caught by ``web_fetch``
    → an honest isError), so a public URL can't bounce a fetch onto an internal
    address. Allowed hops defer to the stdlib handler (bounded redirect count).
    """

    def __init__(self, allow_private: bool) -> None:
        super().__init__()
        self._allow_private = allow_private

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        reason = _ssrf_reject_reason(newurl, self._allow_private)
        if reason is not None:
            raise urllib.error.HTTPError(
                newurl, code, "blocked redirect: %s" % reason, headers, fp
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# -- SSRF security boundary: re-vet the REAL connected peer ------------------


class _BlockedPeerError(Exception):
    """Raised from a guarded connection's ``connect()`` when the socket is
    ACTUALLY connected to a blocked (loopback/private/link-local/…) peer. Not an
    ``OSError`` subclass, so it surfaces verbatim through ``opener.open`` into
    ``web_fetch``'s honest ``isError`` (never a fabricated hit)."""


def _peer_reject_reason(sock: Any, allow_private: bool) -> Optional[str]:
    """Why the socket's ACTUAL connected peer must be rejected (SSRF), or None.

    This is the security boundary: it inspects ``sock.getpeername()`` — the
    address the socket is REALLY connected to — so a DNS-rebinding domain that
    fed the pre-resolution check a public IP but connected to a private/metadata
    IP is caught (the vetted address IS the connected address). ``allow_private``
    (the test escape hatch) short-circuits, matching ``_ssrf_reject_reason``.
    """
    if allow_private:
        return None
    try:
        peer = sock.getpeername()[0]
    except (OSError, AttributeError, TypeError, IndexError):
        return "could not determine the connected peer address"
    addr = str(peer).split("%")[0]  # drop any IPv6 scope id
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return "connected peer %r is not a valid IP" % peer
    if _ip_is_blocked(ip):
        return "connected peer %s is a blocked address" % ip
    return None


def _guarded_opener(allow_private: bool) -> urllib.request.OpenerDirector:
    """Build a urllib opener whose HTTP(S) connections re-vet the REAL connected
    peer IP right after ``connect()`` (closing DNS-rebinding/TOCTOU and re-vetting
    EVERY redirect hop, since each hop opens a fresh connection), keeping the
    cheap pre-resolution + per-hop redirect checks as defense-in-depth fast paths.
    HTTPS keeps normal cert validation: ``super().connect()`` runs the TLS
    handshake against the hostname (SNI + cert) FIRST, then we check the peer IP.
    """

    def _guard(conn: Any) -> None:
        reason = _peer_reject_reason(conn.sock, allow_private)
        if reason is not None:
            conn.close()  # drop the socket before any request bytes egress
            raise _BlockedPeerError("web_fetch blocked: %s" % reason)

    class _GuardedHTTPConnection(http.client.HTTPConnection):
        def connect(self) -> None:  # type: ignore[override]
            super().connect()
            _guard(self)

    class _GuardedHTTPSConnection(http.client.HTTPSConnection):
        def connect(self) -> None:  # type: ignore[override]
            super().connect()  # TLS handshake + cert validation by hostname
            _guard(self)

    class _GuardedHTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):  # type: ignore[override]
            return self.do_open(_GuardedHTTPConnection, req)

    class _GuardedHTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):  # type: ignore[override]
            # No ``check_hostname=`` kwarg: Python 3.12 removed it from
            # ``do_open`` (hostname verification lives on the SSLContext, and a
            # None context makes the connection build the default one — which
            # verifies). Passing it crashed EVERY https fetch on the bundled
            # runtime with "'_GuardedHTTPSHandler' has no attribute
            # '_check_hostname'" (found live, 2026-08-31).
            return self.do_open(_GuardedHTTPSConnection, req, context=self._context)

    return urllib.request.build_opener(
        _GuardedHTTPHandler(),
        _GuardedHTTPSHandler(),
        _GuardedRedirectHandler(allow_private),
    )


# -- HTML -> text ------------------------------------------------------------


class _TextExtractor(HTMLParser):
    """Strip HTML to readable text: drop script/style, capture <title>, collapse
    whitespace. Entity refs are converted (``convert_charrefs=True``)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0  # inside <script>/<style>
        self._in_title = False
        self._parts: List[str] = []
        self._title_parts: List[str] = []

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in ("script", "style"):
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        if self._in_title:
            self._title_parts.append(data)
        else:
            self._parts.append(data)

    def text(self) -> str:
        return " ".join(" ".join(self._parts).split())

    def title(self) -> str:
        return " ".join(" ".join(self._title_parts).split())


# -- web_fetch ---------------------------------------------------------------


def web_fetch(
    url: str,
    *,
    timeout: float = 8.0,
    max_bytes: int = 200_000,
    allow_private: bool = False,
) -> Dict[str, Any]:
    """GET ``url`` and return its readable text (MCP-style result). NEVER raises.

    Allows only http/https; SSRF-guards by re-vetting the REAL connected peer IP
    after connect (the security boundary — catches DNS rebinding + every redirect
    hop), with the pre-resolution host reject + per-hop redirect check as
    defense-in-depth (unless ``allow_private`` — the test escape hatch, off in
    production); caps the body at ``max_bytes``; strips HTML→text and captures the
    <title>. On success
    returns ``{"content":[{"type":"text","text":...}], "url":<final>,
    "title":..., "status":<http status>, "bytes":<raw body size>}``; on ANY
    failure (bad scheme, blocked host, DNS, 4xx/5xx, timeout, transport) returns
    an honest ``{"isError":True, "content":[...]}`` — carrying ``status``/``url``
    when the failure knew them (a 404 does).
    Content is the REAL fetched page — nothing is ever fabricated.

    ``status`` and ``bytes`` are OUTCOME facts, measured from the real response
    (``resp.status`` and ``len(raw)``), never estimated. They exist so the
    disclosure surfaces can say "200, 48 KB" instead of "fetched a page".
    """
    try:
        reason = _ssrf_reject_reason(url, allow_private)
        if reason is not None:
            return _error("web_fetch blocked: %s" % reason)
        req = urllib.request.Request(
            url,
            headers={"User-Agent": _USER_AGENT, "Accept": "text/html, text/*, */*"},
        )
        opener = _guarded_opener(allow_private)
        with opener.open(req, timeout=timeout) as resp:
            final_url = resp.geturl()
            charset = resp.headers.get_content_charset() or "utf-8"
            status = getattr(resp, "status", None)
            if status is None:
                try:
                    status = resp.getcode()
                except Exception:  # noqa: BLE001 — a status we can't read is None
                    status = None
            raw = resp.read(max(0, int(max_bytes)))
        html = raw.decode(charset, errors="replace")
        extractor = _TextExtractor()
        try:
            extractor.feed(html)
            extractor.close()
        except Exception:
            # A malformed document must still yield whatever text parsed so far.
            pass
        out: Dict[str, Any] = {
            "content": [{"type": "text", "text": extractor.text()}],
            "url": final_url,
            "title": extractor.title(),
            "bytes": len(raw),
        }
        if isinstance(status, int):
            out["status"] = status
        return out
    except urllib.error.HTTPError as exc:
        # A 4xx/5xx (and a blocked redirect, which this module raises as an
        # HTTPError) is a REAL status the user should see — "404" reads very
        # differently from "couldn't fetch that page".
        return _error(
            "web_fetch failed for %s: %s" % (url, exc),
            url=url,
            status=getattr(exc, "code", None),
        )
    except Exception as exc:  # noqa: BLE001 — honesty: never raise, honest isError
        return _error("web_fetch failed for %s: %s" % (url, exc), url=url)


# -- search backends ---------------------------------------------------------


def _coerce_json(payload: Any) -> Any:
    """Best-effort JSON: bytes/str -> parsed; dict/list -> as-is; else None."""
    if isinstance(payload, (dict, list)):
        return payload
    if isinstance(payload, (bytes, bytearray)):
        try:
            return json.loads(payload.decode("utf-8", errors="replace"))
        except (ValueError, TypeError):
            return None
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except (ValueError, TypeError):
            return None
    return None


class WebSearchBackendError(Exception):
    """A search backend's transport/HTTP call FAILED (timeout, 4xx/5xx incl. 429,
    connection error) — distinct from a call that SUCCEEDED with zero hits. It
    propagates out of ``search()`` so the provider returns an honest ``isError``
    ("web search failed: …") instead of a success-shaped "No web results"."""


def _http_json(
    url: str,
    *,
    timeout: float = 8.0,
    max_bytes: int = 200_000,
    method: str = "GET",
    data: Optional[bytes] = None,
    headers: Optional[Dict[str, str]] = None,
) -> Any:
    """Fetch ``url`` and parse JSON. RAISES ``WebSearchBackendError`` on a
    transport/HTTP FAILURE (timeout, 4xx/5xx incl. 429, connection error); a
    request that SUCCEEDED but whose body is empty/unparseable yields ``None``
    (→ the backend's honest "no results"), so a genuine miss is never confused
    with a failure.

    Search backends hit an operator-CONFIGURED endpoint (DuckDuckGo or a keyed
    API), not a model-supplied URL, so there is no SSRF host-guard here (that
    guards ``web_fetch``).
    """
    hdrs = {"User-Agent": _USER_AGENT, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(max(0, int(max_bytes)))
    except Exception as exc:  # noqa: BLE001 — honest FAILURE, not an empty result
        raise WebSearchBackendError(str(exc) or exc.__class__.__name__) from exc
    return _coerce_json(raw)


class WebSearchBackend:
    """Abstract search backend: ``search(query) -> list[{title,url,snippet}]``."""

    def search(self, query: str) -> List[Dict[str, str]]:
        raise NotImplementedError


def _flatten_ddg_topics(node: Any) -> List[Dict[str, Any]]:
    """Flatten DuckDuckGo ``RelatedTopics``/``Results`` (nested ``Topics``)."""
    out: List[Dict[str, Any]] = []
    if isinstance(node, list):
        for item in node:
            out.extend(_flatten_ddg_topics(item))
    elif isinstance(node, dict):
        topics = node.get("Topics")
        if isinstance(topics, list):
            out.extend(_flatten_ddg_topics(topics))
        else:
            out.append(node)
    return out


class KeylessBackend(WebSearchBackend):
    """Keyless default: DuckDuckGo Instant-Answer JSON. Parses DEFENSIVELY (an
    empty/unparseable but SUCCESSFUL response → ``[]``, never a fabricated hit); a
    transport/HTTP FAILURE (timeout/429/5xx) raises ``WebSearchBackendError`` so
    the provider reports an honest isError, not a false "no results"."""

    def __init__(
        self,
        *,
        endpoint: str = _DEFAULT_KEYLESS_ENDPOINT,
        timeout: float = 8.0,
        max_results: int = 8,
    ) -> None:
        self.endpoint = endpoint
        self.timeout = float(timeout)
        self.max_results = int(max_results)

    def search(self, query: str) -> List[Dict[str, str]]:
        params = urllib.parse.urlencode(
            {"q": query, "format": "json", "no_html": "1", "no_redirect": "1"}
        )
        sep = "&" if "?" in self.endpoint else "?"
        url = self.endpoint + sep + params
        data = _http_json(url, timeout=self.timeout)
        results = self.parse(data)[: self.max_results]
        if results:
            return results
        # THE INSTANT-ANSWER API ANSWERS ALMOST NOTHING (verified live
        # 2026-08-31: an ordinary research query returns every field empty).
        # Keyless search that silently finds nothing is a tool that only
        # LOOKS like it works — so fall back to the ordinary results page.
        # A failure here still raises, so a real outage is never dressed as
        # "no results"; a genuine empty result stays honestly empty.
        return self._results_page(query)[: self.max_results]

    def _results_page(self, query: str) -> List[Dict[str, str]]:
        """Parse DuckDuckGo's no-JS results page — titles + real destination
        URLs, nothing executed, no cookies, no JavaScript."""
        url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
        # The results page varies its output by client: our bare tool UA gets
        # an empty page (verified 2026-08-31), a browser-shaped one gets the
        # real results. We still say who we are — the product name rides
        # along — we just speak the dialect the page answers.
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": _RESULTS_PAGE_UA,
                "Accept": "text/html,application/xhtml+xml",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                html = resp.read(400_000).decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001 — an outage is a FAILURE
            raise WebSearchBackendError(str(exc) or exc.__class__.__name__) from exc
        out: List[Dict[str, str]] = []
        seen = set()
        for m in re.finditer(
            r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
            html,
            re.S,
        )        :
            href, label = m.group(1), re.sub(r"<[^>]+>", "", m.group(2))
            # DDG wraps hits as /l/?uddg=<encoded real url> — unwrap to the
            # real destination so a citation points where it claims to.
            if "uddg=" in href:
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
                href = (qs.get("uddg") or [href])[0]
            href = html_unescape(href)
            if not href.startswith("http") or href in seen:
                continue
            seen.add(href)
            out.append(
                {"title": html_unescape(label).strip(), "url": href, "snippet": ""}
            )
        return out

    @staticmethod
    def parse(payload: Any) -> List[Dict[str, str]]:
        data = _coerce_json(payload)
        if not isinstance(data, dict):
            return []
        results: List[Dict[str, str]] = []
        abs_url = data.get("AbstractURL")
        if isinstance(abs_url, str) and abs_url:
            heading = data.get("Heading") or abs_url
            abstract = data.get("AbstractText") or data.get("Abstract") or ""
            results.append(
                {"title": str(heading), "url": abs_url, "snippet": str(abstract)}
            )
        for key in ("Results", "RelatedTopics"):
            for item in _flatten_ddg_topics(data.get(key)):
                url = item.get("FirstURL")
                text = item.get("Text")
                if isinstance(url, str) and url:
                    results.append(
                        {
                            "title": str(text or url),
                            "url": url,
                            "snippet": str(text or ""),
                        }
                    )
        # De-dupe by URL, first wins.
        seen: set = set()
        out: List[Dict[str, str]] = []
        for r in results:
            if r["url"] in seen:
                continue
            seen.add(r["url"])
            out.append(r)
        return out


def _first(item: Dict[str, Any], keys: Sequence[str]) -> Optional[Any]:
    for k in keys:
        if k in item and item[k] not in (None, ""):
            return item[k]
    return None


def _find_result_list(data: Any) -> List[Any]:
    """Find the list of result objects in a generic search JSON, DEFENSIVELY."""
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ("results", "data", "items", "organic", "hits", "value", "webPages"):
        val = data.get(key)
        if isinstance(val, list):
            return val
        if isinstance(val, dict):  # e.g. Bing-style {"webPages": {"value": [...]}}
            inner = val.get("value")
            if isinstance(inner, list):
                return inner
    return []


class ApiKeyBackend(WebSearchBackend):
    """Generic keyed backend: GET/POST a configured endpoint with the key, parse
    ``{title,url,snippet}`` DEFENSIVELY. The key stays server-side (never in a
    result). An empty/unparseable but SUCCESSFUL response → ``[]``; a
    transport/HTTP FAILURE raises ``WebSearchBackendError`` (honest isError)."""

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        *,
        method: str = "GET",
        timeout: float = 8.0,
        max_results: int = 8,
        query_param: str = "q",
        key_param: str = "key",
        key_header: Optional[str] = None,
    ) -> None:
        self.endpoint = endpoint
        self.api_key = api_key
        self.method = method.upper()
        self.timeout = float(timeout)
        self.max_results = int(max_results)
        self.query_param = query_param
        self.key_param = key_param
        self.key_header = key_header

    def search(self, query: str) -> List[Dict[str, str]]:
        if self.method == "POST":
            body = json.dumps(
                {self.query_param: query, self.key_param: self.api_key}
            ).encode("utf-8")
            headers = {"Content-Type": "application/json"}
            if self.key_header:
                headers[self.key_header] = self.api_key
            data = _http_json(
                self.endpoint,
                timeout=self.timeout,
                method="POST",
                data=body,
                headers=headers,
            )
        else:
            query_params: Dict[str, str] = {self.query_param: query}
            headers = {}
            if self.key_header:
                headers[self.key_header] = self.api_key
            else:
                query_params[self.key_param] = self.api_key
            sep = "&" if "?" in self.endpoint else "?"
            url = self.endpoint + sep + urllib.parse.urlencode(query_params)
            data = _http_json(url, timeout=self.timeout, headers=headers or None)
        return self.parse(data)[: self.max_results]

    @staticmethod
    def parse(payload: Any) -> List[Dict[str, str]]:
        data = _coerce_json(payload)
        out: List[Dict[str, str]] = []
        for item in _find_result_list(data):
            if not isinstance(item, dict):
                continue
            url = _first(item, ("url", "link", "href", "URL", "FirstURL"))
            if not isinstance(url, str) or not url:
                continue
            title = _first(item, ("title", "name", "Title", "Heading"))
            snippet = _first(
                item,
                ("snippet", "description", "abstract", "content", "body", "Text"),
            )
            out.append(
                {
                    "title": str(title or url),
                    "url": url,
                    "snippet": str(snippet or ""),
                }
            )
        return out


def make_search_backend(
    *,
    api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
) -> WebSearchBackend:
    """Pick the backend from config: a key + endpoint → ``ApiKeyBackend``; else
    the keyless DuckDuckGo default (a key with no endpoint has nowhere to go, so
    it honestly falls back to keyless)."""
    if api_key and endpoint:
        return ApiKeyBackend(endpoint, api_key)
    return KeylessBackend()


def _search_result(query: str, results: List[Dict[str, str]]) -> Dict[str, Any]:
    """Render search results as an MCP-style text result whose body carries every
    source URL, so the model can cite REAL sources. Empty is honest, not error."""
    if not results:
        text = "No web results for %r." % query
    else:
        lines = ["Web search results for %r:" % query, ""]
        for i, r in enumerate(results, 1):
            title = str(r.get("title") or r.get("url") or "")
            url = str(r.get("url") or "")
            lines.append("%d. %s\n   %s" % (i, title, url))
            snippet = str(r.get("snippet") or "")
            if snippet and snippet != title:
                lines.append("   %s" % snippet)
        text = "\n".join(lines)
    return {
        "content": [{"type": "text", "text": text}],
        "query": query,
        "results": results,
    }


# -- THE PRIVACY LINE: which tool arguments may be recorded on a span ---------
#
# THE RULE, and it is a line, not a preference:
#
#   A WEB tool's argument MAY be recorded on its span.
#   A LOCAL tool's argument MAY NOT.
#
# WHY, in one sentence: recording a web argument discloses nothing new, because
# that argument ALREADY LEFT THE MACHINE — the URL was requested over the wire,
# the query was typed into a search engine's endpoint — so a copy of it is
# already on somebody else's disk; whereas a LOCAL tool's arguments (a vault
# path, an MCP tool's parameters, a shell command) may contain material that
# NEVER egressed, and writing it into spans.jsonl would be a new disclosure the
# user never authorised. The audit trail must never be the first place a secret
# goes.
#
# Two corollaries, both enforced in code below and asserted in the tests:
#
#   1. NOTHING is recorded on the BLOCKED path. A call the sensitivity gate
#      stopped did NOT egress — that is the whole point of the gate — so its
#      argument is exactly the class of thing this rule protects (it was blocked
#      BECAUSE it looked like a secret). Writing it to the span would defeat the
#      gate by copying the secret into the audit file.
#   2. Everything below reads the RESULT, never ``arguments``. ``web_fetch``
#      puts ``url`` in its result only once the request actually reached the
#      network (the final URL after redirects on success; the requested URL on
#      an HTTP/transport failure), and ``web_search`` puts ``query`` in its
#      result only once the backend was really called. So "already egressed" is
#      not a claim this code makes — it is a property of where the value came
#      from. A pre-egress reject (malformed URL, SSRF block, sensitivity block)
#      carries neither, and therefore records neither.
#
# The other governed sources — ``vault_tools.VaultToolProvider``,
# ``mcp.MCPClient`` — deliberately record NO arguments. Do not "make them
# consistent" with this module: they are on the other side of the line. What
# they may safely add is RESULT metadata that is not user content (the vault
# already names the note it opened, taken from the result; MCP records its
# result size), because that is a fact about the outcome, not a copy of the
# input.


def _web_span_attrs(name: str, result: Dict[str, Any]) -> Dict[str, Any]:
    """The truthful, already-egressed facts to record on a web ``tool_exec``
    span: WHERE it went and WHAT came back.

    Reads the RESULT only (see the privacy line above) — never the model-supplied
    arguments — so a call that never reached the network contributes nothing.

      * ``web_fetch``  → ``url`` (final, after redirects), ``host``, ``status``
                         (real HTTP status), ``bytes`` (real body size)
      * ``web_search`` → ``query``, ``result_count``

    Every key is omitted when the result did not really carry it: a missing attr
    makes the UI say the generic honest phrase, which is the correct outcome.
    """
    attrs: Dict[str, Any] = {}
    # WHY it failed (2026-08-18). The span used to record `is_error: true` and
    # nothing else, which made a real user report — "The HTTPS fetcher hit a
    # local issue" — impossible to diagnose from the trace: three failed
    # fetches, no reason, no way to tell an SSRF reject from a 404 from a
    # timeout. The message is OUR OWN honest error text (the same string the
    # model was shown), never model-supplied arguments, so the privacy line
    # above holds.
    if result.get("isError"):
        content = result.get("content")
        text = ""
        if isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict) and isinstance(first.get("text"), str):
                text = first["text"]
        if text:
            attrs["error"] = text[:300]
    if name == "web_fetch":
        url = result.get("url")
        if isinstance(url, str) and url:
            attrs["url"] = url
            try:
                host = urllib.parse.urlsplit(url).hostname
            except ValueError:
                host = None
            if host:
                attrs["host"] = host
        status = result.get("status")
        if isinstance(status, int):
            attrs["status"] = status
        size = result.get("bytes")
        if isinstance(size, int):
            attrs["bytes"] = size
    elif name == "web_search":
        query = result.get("query")
        if isinstance(query, str) and query:
            attrs["query"] = query
        results = result.get("results")
        if isinstance(results, list):
            attrs["result_count"] = len(results)
    return attrs


# -- the governed provider ---------------------------------------------------


class WebToolProvider:
    """MCPClient-SHAPED web-research tool source (``list_tools`` + ``call_tool``
    + ``parent_span_id`` + ``telemetry``) — governed exactly like the MCP client.

    ``call_tool`` runs the allowlist + the SAME sensitivity gate as MCP (reusing
    ``gateway.SENSITIVE_KEYWORDS`` on the args JSON) BEFORE any egress, raising
    ``mcp.MCPBlockedError`` and emitting a ``blocked=True`` ``tool_exec`` span; a
    non-blocked call emits a truthful ``tool_exec`` span (``provider="web"``) and
    dispatches to ``web_fetch``/``web_search``, returning the MCP-style result.
    """

    def __init__(
        self,
        *,
        telemetry: Optional[Any] = None,
        server_name: str = "web",
        search_backend: Optional[WebSearchBackend] = None,
        allowed_tools: Optional[Sequence[str]] = None,
        allow_private: bool = False,
        timeout: float = 8.0,
        max_bytes: int = 200_000,
    ) -> None:
        self.telemetry = telemetry
        self.parent_span_id: Optional[str] = None
        # The audit provider tag for THIS source's spans (incl. a withheld-result
        # governance span emitted by the loop) — a web tool is honestly "web".
        self.provider = "web"
        self.server_name = server_name
        self.search_backend: WebSearchBackend = search_backend or KeylessBackend()
        self.allowed_tools: Optional[set] = (
            None if allowed_tools is None else set(allowed_tools)
        )
        # allow_private is the test-fixture escape hatch (reach a loopback
        # http.server) — a real run NEVER sets it, so the SSRF guard is live.
        self.allow_private = allow_private
        self.timeout = float(timeout)
        self.max_bytes = int(max_bytes)

    def list_tools(self) -> List[MCPTool]:
        return [
            MCPTool(
                name="web_fetch",
                description=(
                    "Fetch a URL over HTTP(S) and return its readable page text "
                    "(SSRF-guarded, byte-capped). Argument: url (string)."
                ),
                input_schema={
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
            ),
            MCPTool(
                name="web_search",
                description=(
                    "Search the web and return titled results with their source "
                    "URLs (cite these). Argument: query (string)."
                ),
                input_schema={
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            ),
        ]

    def _blocked_reason(self, name: str, arguments: Dict[str, Any]) -> Optional[str]:
        """Return why the call is blocked, or None. Mirrors ``MCPClient``."""
        if self.allowed_tools is not None and name not in self.allowed_tools:
            return "tool '%s' is not allowed" % name
        # Sensitivity gate — REUSES gateway.sensitive_hit (no duplication, and
        # the SAME word-aware rule route() uses): a secret must never reach a
        # search query or a fetched URL. Word-aware matters most HERE: this gate
        # used to kill "mlx multi token prediction" pre-egress on the substring
        # "token", and the user was told nothing.
        if sensitive_hit(json.dumps(arguments, ensure_ascii=False)) is not None:
            return (
                "blocked: web tool arguments contain sensitive data "
                "(a secret must not be sent to the internet)"
            )
        return None

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Governed dispatch. Blocks (raises ``MCPBlockedError``) before egress."""
        arguments = arguments or {}
        blocked_reason = self._blocked_reason(name, arguments)
        if blocked_reason is not None:
            if self.telemetry is not None:
                with self.telemetry.span(
                    "tool_exec",
                    span_type="tool_exec",
                    parent=self.parent_span_id,
                    provider="web",
                    server=self.server_name,
                    tool=name,
                    blocked=True,
                ) as sp:
                    # NO url / query / arguments here — corollary 1 of the
                    # privacy line above. This call did NOT egress; it was
                    # stopped precisely because its argument looked like a
                    # secret, so copying it into spans.jsonl would defeat the
                    # gate. The reason is enough for the audit.
                    sp.set(reason=blocked_reason)
                    sp.set_status("error")
            raise MCPBlockedError(blocked_reason)

        if self.telemetry is not None:
            with self.telemetry.span(
                "tool_exec",
                span_type="tool_exec",
                parent=self.parent_span_id,
                provider="web",
                server=self.server_name,
                tool=name,
            ) as sp:
                result = self._dispatch(name, arguments)
                sp.set(is_error=bool(result.get("isError")))
                # WHERE it went and WHAT came back (host/status/size, or the
                # query and its hit count). Result-derived and already-egressed
                # — see THE PRIVACY LINE above. Without this the run stream
                # rendered 66 real web calls as "fetching a page from the web…",
                # which from the user's seat is indistinguishable from the
                # feature not existing.
                sp.set(**_web_span_attrs(name, result))
                return result
        return self._dispatch(name, arguments)

    def _dispatch(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        if name == "web_fetch":
            url = arguments.get("url")
            if not isinstance(url, str) or not url:
                return _error("web_fetch requires a string 'url' argument")
            return web_fetch(
                url,
                timeout=self.timeout,
                max_bytes=self.max_bytes,
                allow_private=self.allow_private,
            )
        if name == "web_search":
            query = arguments.get("query")
            if not isinstance(query, str) or not query:
                return _error("web_search requires a string 'query' argument")
            try:
                results = self.search_backend.search(query)
            except Exception as exc:  # noqa: BLE001 — honest error, never a raise
                # A transport/HTTP FAILURE (WebSearchBackendError: timeout, 429,
                # 5xx, connection error) is surfaced honestly as isError — the
                # model must not read a failed search as "no results". The query
                # rides along because it ALREADY reached the search engine (see
                # the privacy line below), so "couldn't search for X" is sayable.
                return _error("web search failed: %s" % exc, query=query)
            if not isinstance(results, list):
                results = []
            return _search_result(query, results)
        return _error("unknown tool %r" % name)


# -- composition -------------------------------------------------------------


class CompositeToolClient:
    """Fan several duck-typed tool sources (MCP + web) into ONE tool source so a
    run can carry both. ``parent_span_id`` fans out to every source;
    ``list_tools`` concatenates de-duped by name (first source wins);
    ``call_tool`` routes to the source that advertised the name."""

    def __init__(self, sources: Sequence[Any]) -> None:
        self.sources: List[Any] = list(sources)
        self._parent: Optional[str] = None
        self._owner: Dict[str, Any] = {}

    @property
    def parent_span_id(self) -> Optional[str]:
        return self._parent

    @parent_span_id.setter
    def parent_span_id(self, value: Optional[str]) -> None:
        self._parent = value
        for source in self.sources:
            try:
                source.parent_span_id = value
            except Exception:  # noqa: BLE001 — a source without the attr is fine
                pass

    def list_tools(self) -> List[MCPTool]:
        seen: set = set()
        out: List[MCPTool] = []
        self._owner = {}
        for source in self.sources:
            try:
                tools = source.list_tools()
            except Exception:  # noqa: BLE001 — a broken source must not kill others
                continue
            for tool in tools or []:
                if tool.name in seen:
                    continue
                seen.add(tool.name)
                self._owner[tool.name] = source
                out.append(tool)
        return out

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        if not self._owner:
            # The loop always lists first, but a direct caller may not have; build
            # the ownership map lazily so routing is always correct.
            self.list_tools()
        owner = self._owner.get(name)
        if owner is None:
            return _error("unknown tool %r" % name)
        return owner.call_tool(name, arguments)
