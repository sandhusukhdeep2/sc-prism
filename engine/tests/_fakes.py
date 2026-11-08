"""Test doubles shared across the engine suite.

Two ways to make the engine talk to a provider that actually answers:

* ``RealGateway`` — in-process. Pass it as ``gateway=`` to the loop, the
  goldens or the CI gate.
* ``fake_openai_server()`` — a real HTTP server on 127.0.0.1 speaking the
  OpenAI chat-completions shape, for code that builds its own gateway from the
  environment (the CLI, the Go daemon). Point ``OPENAI_BASE_URL`` at it.

Why these exist. The default ``Gateway`` with no provider configured answers
with the offline STAND-IN (``[offline:…] handled: …``, ``is_real=False``), and
for a long time the suite used that stand-in as a convenient "pass". That is
exactly how the engine learned to file a run the model never answered as
passed. A test about some other property that merely needs a run that succeeds
must use one of these, so that "succeeds" means what it means in production:
the model answered.

Both answer a Tier-2 judge prompt (it names the four metrics) with a parseable
verdict, and anything else with a fixed reply.
"""
import contextlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from scprism_engine import evals
from scprism_engine.gateway import Gateway, ModelCallResult


def answer_for(prompt: str, *, reply: str, score: float) -> str:
    """The reply a real provider would give to ``prompt`` in these tests."""
    if all(name in prompt for name in evals.METRIC_NAMES):
        return json.dumps({name: score for name in evals.METRIC_NAMES})
    return reply


class RealGateway(Gateway):
    """A gateway whose every call is a real completion."""

    def __init__(self, *, reply="a real answer", score=0.9, **kwargs):
        kwargs.setdefault("openai_base_url", "http://127.0.0.1:9")
        kwargs.setdefault("env", {})
        kwargs.setdefault("timeout", 0.2)
        super().__init__(**kwargs)
        self.reply = reply
        self.score = score
        self.calls = []

    def model_call(self, messages, route):
        self.calls.append(messages)
        prompt = str(messages[-1].get("content", "")) if messages else ""
        return ModelCallResult(
            text=answer_for(prompt, reply=self.reply, score=self.score),
            tokens_in=12,
            tokens_out=4,
            cache="miss",
            provider=route.provider,
            model=route.model,
            is_real=True,
        )


class _Handler(BaseHTTPRequestHandler):
    reply = "a real answer"
    score = 0.9
    require_key = ""  # when set, a request without this bearer gets 401 like oMLX
    seen = None  # list the server appends each request's Authorization header to

    def log_message(self, *_):  # keep test output clean
        pass

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200, {"object": "list", "data": [{"id": "fake-model", "object": "model"}]})

    def do_POST(self):
        auth = self.headers.get("Authorization", "")
        if self.seen is not None:
            self.seen.append(auth)
        if self.require_key and auth != f"Bearer {self.require_key}":
            self._send(401, {"detail": "API key required"})
            return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            req = {}
        msgs = req.get("messages") or []
        prompt = str(msgs[-1].get("content", "")) if msgs else ""
        if isinstance(prompt, list):  # multimodal parts
            prompt = " ".join(str(p.get("text", "")) for p in prompt if isinstance(p, dict))
        text = answer_for(prompt, reply=self.reply, score=self.score)
        self._send(200, {
            "id": "chatcmpl-fake",
            "object": "chat.completion",
            "model": req.get("model") or "fake-model",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16},
        })


@contextlib.contextmanager
def fake_openai_server(*, reply="a real answer", score=0.9, require_key=""):
    """Serve the OpenAI chat shape on a free local port; yields the base URL.

    ``require_key`` makes it behave like oMLX: 401 without that exact bearer.
    The handler's ``seen`` list records every Authorization header received.
    """
    handler = type("Handler", (_Handler,), {
        "reply": reply, "score": score, "require_key": require_key, "seen": [],
    })
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}", handler.seen
    finally:
        srv.shutdown()
        srv.server_close()
