"""BifrostGateway — the Python supervisor for the REAL Go Bifrost (ADR-026).

ADR-026 packaging decision: Bifrost runs as a **bundled, supervised subprocess
over a Unix domain socket** (not an in-process FFI binding). This module is the
supervisor: it locates/builds the ``engine/bifrost/bifrostd`` binary, spawns it
on a private temp UDS, waits for a ``ping``, and speaks the newline-delimited
JSON protocol — giving the loop the SAME interface as the in-process Python
``Gateway`` (``route`` + ``model_call``). On close it terminates the child, so
no orphan process is left behind.

The Go daemon takes over the gateway's ROLE (routing precedence, prompt +
semantic cache, real OpenAI-compatible calls, deterministic offline stub). Its
config is read from the environment at startup, so this supervisor passes the
same provider env the Python ``Gateway`` would read when it spawns the child.

Default engine behavior is UNCHANGED: the loop uses this only when Bifrost is
explicitly enabled AND the binary is available (see ``make_gateway``).
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Union

from . import proc as proc_util
from .gateway import (
    Gateway,
    GatewayError,
    ModelCallResult,
    RouteDecision,
    _PROVIDERS,
    _extract_text,
)

# engine/scprism_engine/bifrost_client.py -> engine/scprism_engine -> engine
_ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO_ROOT = os.path.dirname(_ENGINE_DIR)

BIFROST_DIR = os.path.join(_ENGINE_DIR, "bifrost")
BINARY_PATH = os.path.join(BIFROST_DIR, "bifrostd")
GOENV_PATH = os.path.join(_REPO_ROOT, "goenv.sh")
GOTOOL_PATH = os.path.join(_REPO_ROOT, ".gotool", "go")


def go_available() -> bool:
    """True when the repo-local Go toolchain is present (goenv-bootstrapped)."""
    return os.path.exists(GOTOOL_PATH) and os.path.exists(GOENV_PATH)


def binary_exists() -> bool:
    """True when the compiled bifrostd binary is present and executable."""
    return os.path.isfile(BINARY_PATH) and os.access(BINARY_PATH, os.X_OK)


def build_bifrostd(timeout: float = 180.0) -> str:
    """Compile ``engine/bifrost/bifrostd`` via the repo-local Go toolchain.

    Sources ``goenv.sh`` first (sets GOROOT/GOPATH/GOCACHE/PATH), then
    ``go build``. Returns the binary path. Raises GatewayError if Go is
    unavailable or the build fails.
    """
    if not go_available():
        raise GatewayError(
            "Go toolchain not available (.gotool/go missing) — cannot build "
            "bifrostd. Install the repo-local toolchain or run without Bifrost."
        )
    cmd = f'. "{GOENV_PATH}" && cd "{BIFROST_DIR}" && go build -o bifrostd .'
    # Bounded like every other shell-out (see proc.py): the direct child here is
    # `bash`, and `go build` fans out compile workers under it — a bound that
    # kills only bash would leave those running with our pipes.
    proc = proc_util.run_bounded(
        ["bash", "-c", cmd],
        timeout=float(timeout),
    )
    if proc.timed_out:
        raise GatewayError(
            f"bifrostd build did not finish within {int(timeout)}s (killed)"
        )
    if proc.returncode != 0 or not binary_exists():
        raise GatewayError(
            "bifrostd build failed:\n"
            + (proc.stderr or proc.stdout or "<no output>")
        )
    return BINARY_PATH


class BifrostGateway:
    """Supervises the bifrostd subprocess; drop-in for the Python ``Gateway``.

    Implements ``route`` and ``model_call`` by round-tripping JSON over a
    private UDS. Provider config is forwarded to the child via env, mirroring
    what the in-process Gateway reads.
    """

    def __init__(
        self,
        *,
        openai_base_url: Optional[str] = None,
        openai_api_key: Optional[str] = None,
        claude_api_key: Optional[str] = None,
        gemini_api_key: Optional[str] = None,
        primary: Optional[str] = None,
        timeout: float = 2.0,
        max_tokens: Optional[int] = None,
        env: Optional[Dict[str, str]] = None,
        socket_path: Optional[str] = None,
        auto_build: bool = True,
        ready_timeout: float = 10.0,
    ) -> None:
        if not binary_exists():
            if auto_build and go_available():
                build_bifrostd()
            if not binary_exists():
                raise GatewayError(
                    f"bifrostd binary not found at {BINARY_PATH}. Build it with:\n"
                    f'  source "{GOENV_PATH}" && (cd "{BIFROST_DIR}" && go build -o bifrostd .)'
                )

        base_env = dict(os.environ if env is None else env)
        child_env = self._build_child_env(
            base_env,
            openai_base_url=openai_base_url,
            openai_api_key=openai_api_key,
            claude_api_key=claude_api_key,
            gemini_api_key=gemini_api_key,
            primary=primary,
            timeout=timeout,
            max_tokens=max_tokens,
        )

        # A private UDS path in a temp dir; short-lived and per-instance.
        self._sock_dir: Optional[tempfile.TemporaryDirectory] = None
        if socket_path is None:
            self._sock_dir = tempfile.TemporaryDirectory(prefix="bifrostd-")
            socket_path = os.path.join(self._sock_dir.name, "bifrost.sock")
        self.socket_path = socket_path

        self._lock = threading.Lock()
        self._sock: Optional[socket.socket] = None
        self._rfile = None
        self._closed = False

        self._proc = subprocess.Popen(
            [BINARY_PATH, self.socket_path],
            env=child_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            self._wait_ready(ready_timeout)
        except Exception:
            self.close()
            raise

    # -- config forwarding ---------------------------------------------

    @staticmethod
    def _build_child_env(
        base_env: Dict[str, str],
        *,
        openai_base_url: Optional[str],
        openai_api_key: Optional[str],
        claude_api_key: Optional[str],
        gemini_api_key: Optional[str],
        primary: Optional[str],
        timeout: float,
        max_tokens: Optional[int] = None,
    ) -> Dict[str, str]:
        env = dict(base_env)
        if openai_base_url is not None:
            env["OPENAI_BASE_URL"] = openai_base_url
        if openai_api_key is not None:
            env["OPENAI_API_KEY"] = openai_api_key
        if claude_api_key is not None:
            env["CLAUDE_API_KEY"] = claude_api_key
        if gemini_api_key is not None:
            env["GEMINI_API_KEY"] = gemini_api_key
        if primary is not None:
            env["SCPRISM_BIFROST_PRIMARY"] = primary
        # An EXPLICIT output cap only: unset, the daemon reads SCPRISM_MAX_TOKENS
        # from this same env and otherwise uses its own 4096 default — the same
        # precedence the Python Gateway applies.
        if max_tokens is not None:
            env["SCPRISM_BIFROST_MAX_TOKENS"] = str(int(max_tokens))
        env["SCPRISM_BIFROST_TIMEOUT"] = str(float(timeout))
        return env

    # -- lifecycle ------------------------------------------------------

    def _wait_ready(self, ready_timeout: float) -> None:
        """Block until the daemon answers a ping, or raise on timeout/crash."""
        deadline = time.time() + ready_timeout
        last_err: Optional[Exception] = None
        while time.time() < deadline:
            if self._proc.poll() is not None:
                raise GatewayError(
                    f"bifrostd exited early (code {self._proc.returncode}) "
                    "before becoming ready"
                )
            try:
                self._open_socket()
                if self.ping():
                    return
            except (OSError, ConnectionError) as exc:  # socket not up yet
                last_err = exc
                self._drop_socket()
                time.sleep(0.02)
        raise GatewayError(
            f"bifrostd did not become ready within {ready_timeout}s"
            + (f": {last_err}" if last_err else "")
        )

    def _open_socket(self) -> None:
        if self._sock is not None:
            return
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.connect(self.socket_path)
        except Exception:
            s.close()  # don't leak the fd when the daemon isn't up yet
            raise
        self._sock = s
        self._rfile = s.makefile("rb")

    def _drop_socket(self) -> None:
        try:
            if self._rfile is not None:
                self._rfile.close()
        except Exception:
            pass
        try:
            if self._sock is not None:
                self._sock.close()
        except Exception:
            pass
        self._sock = None
        self._rfile = None

    def close(self) -> None:
        """Terminate the child and clean up the socket — leaves no orphan."""
        if self._closed:
            return
        self._closed = True
        self._drop_socket()
        proc = getattr(self, "_proc", None)
        if proc is not None:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
        if self._sock_dir is not None:
            try:
                self._sock_dir.cleanup()
            except Exception:
                pass
            self._sock_dir = None

    def __enter__(self) -> "BifrostGateway":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __del__(self) -> None:  # best-effort safety net
        try:
            self.close()
        except Exception:
            pass

    # -- protocol -------------------------------------------------------

    def _rpc(self, obj: Dict[str, Any]) -> Dict[str, Any]:
        """Send one JSON request, read one JSON response (line-framed)."""
        if self._closed:
            raise GatewayError("BifrostGateway is closed")
        blob = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        with self._lock:
            if self._sock is None or self._rfile is None:
                self._open_socket()
            assert self._sock is not None and self._rfile is not None
            self._sock.sendall(blob)
            line = self._rfile.readline()
            if not line:
                raise GatewayError("bifrostd closed the connection unexpectedly")
            resp = json.loads(line.decode("utf-8"))
        if isinstance(resp, dict) and "error" in resp and len(resp) == 1:
            raise GatewayError(f"bifrostd error: {resp['error']}")
        return resp

    def ping(self) -> bool:
        """Readiness probe."""
        try:
            return self._rpc({"op": "ping"}).get("ok") is True
        except GatewayError:
            return False

    # -- gateway interface (drop-in with scprism_engine.gateway.Gateway) --

    def route(
        self, step_or_intent: Union[str, Any], hint: Optional[str] = None
    ) -> RouteDecision:
        # Drop-in with Gateway.route: accept the optional per-message hint so the
        # loop's `gateway.route(prompt, route_hint)` call works against either
        # gateway. Forward it to the daemon ONLY when set — a None hint sends the
        # exact same RPC as before (byte-identical). The Go daemon stays
        # authoritative and enforces its own sensitivity floor; an older daemon
        # simply ignores an unknown field and routes normally (the chip still
        # shows the REAL outcome, so the loop stays honest).
        text = _extract_text(step_or_intent)
        payload: Dict[str, Any] = {"op": "route", "intent": text}
        if hint is not None:
            payload["hint"] = hint
        resp = self._rpc(payload)
        return RouteDecision(
            target=resp["target"],
            provider=resp["provider"],
            model=resp["model"],
            base_url=resp["base_url"],
            is_local=resp["is_local"],
            reason=resp["reason"],
            matched=resp.get("matched", ""),
            api_key=None,  # the daemon holds keys; never travels the wire
        )

    def model_call(
        self, messages: List[Dict[str, Any]], route: RouteDecision
    ) -> ModelCallResult:
        resp = self._rpc(
            {
                "op": "model_call",
                "messages": messages,
                "route": route.to_dict(),
                "providers": _PROVIDERS,
            }
        )
        return ModelCallResult(
            text=resp["text"],
            tokens_in=resp["tokens_in"],
            tokens_out=resp["tokens_out"],
            cache=resp["cache"],
            provider=resp["provider"],
            model=resp["model"],
            is_real=resp["is_real"],
            # The daemon reports the length signal; an OLDER daemon binary omits
            # the field, and absent means "not known to be truncated", never a
            # silent claim of completeness.
            truncated=bool(resp.get("truncated", False)),
        )


def make_gateway(
    *,
    use_bifrost: Optional[bool] = None,
    env: Optional[Dict[str, str]] = None,
    **kwargs: Any,
) -> Union[Gateway, BifrostGateway]:
    """Factory: the REAL Go Bifrost when enabled + available, else the Python one.

    Bifrost is selected when ``use_bifrost=True`` OR ``$SCPRISM_BIFROST`` is
    truthy, AND the ``bifrostd`` binary exists (built, or buildable via the
    repo-local Go toolchain). Otherwise the in-process Python ``Gateway`` is
    returned. The DEFAULT is the Python gateway, so all existing behavior and
    tests are unchanged.
    """
    src_env = os.environ if env is None else env
    if use_bifrost is None:
        flag = str(src_env.get("SCPRISM_BIFROST", "")).strip().lower()
        use_bifrost = flag in ("1", "true", "yes", "on")

    # CLI-bridge primaries (claude-cli / gemini-cli / codex-cli) spawn a LOCAL
    # subscription CLI — an in-process concern the Go HTTP daemon cannot serve.
    # Routing them through Bifrost silently degraded every call to the offline
    # stub ("unreachable" in the app), so they always use the Python gateway.
    from .gateway import _CLI_PROVIDERS

    primary = str(kwargs.get("primary") or src_env.get("SCPRISM_PRIMARY") or "")
    if primary in _CLI_PROVIDERS:
        use_bifrost = False

    if use_bifrost and (binary_exists() or go_available()):
        try:
            return BifrostGateway(env=env, **kwargs)
        except GatewayError:
            # Fail safe: never take the loop down because Bifrost is missing.
            pass
    return Gateway(env=env, **kwargs)
