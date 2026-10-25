import io
import json
import unittest
import http.client
import urllib.error
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.gateway import (
    Gateway,
    RouteDecision,
    LOCAL,
    CLOUD,
    DEFAULT_MAX_TOKENS,
    MALFORMED_RETRIES,
    ANTHROPIC_EFFORTS,
    ANTHROPIC_MAX_TOKENS_FLOOR,
)
from scprism_engine.planner import Step


# An unreachable local endpoint + empty env -> every call falls to the
# deterministic offline stub, so these tests never touch the network.
def _gw(**kw):
    kw.setdefault("openai_base_url", "http://127.0.0.1:9")
    kw.setdefault("env", {})
    kw.setdefault("timeout", 0.2)
    return Gateway(**kw)


class TestGatewayRouting(unittest.TestCase):
    def test_sensitive_keyword_forces_local(self):
        gw = _gw()
        d = gw.route("rotate the customer password store")
        self.assertEqual(d.target, LOCAL)
        self.assertTrue(d.is_local)
        self.assertIn("password", d.matched)

    def test_reasoning_keyword_routes_cloud(self):
        # A usable cloud (a real key) must be configured for the reasoning lane
        # to force cloud — otherwise there is nowhere real to route (R2).
        gw = _gw(openai_api_key="k")
        d = gw.route("design a distributed rate limiter")
        self.assertEqual(d.target, CLOUD)
        self.assertFalse(d.is_local)

    def test_reasoning_without_cloud_stays_local(self):
        # R2: heavy reasoning prefers cloud, but a LOCAL-only user (no cloud key,
        # no CLI bridge) must NEVER be silently sent to a keyless cloud stub —
        # the reasoning lane honors the local primary and says so honestly.
        gw = _gw()  # no cloud key, no explicit primary
        d = gw.route("design a distributed rate limiter")
        self.assertEqual(d.target, LOCAL)
        self.assertTrue(d.is_local)
        self.assertIn("no cloud configured", d.reason)

    def test_sensitivity_wins_over_reasoning(self):
        # Contains a reasoning word (refactor) AND a sensitive word (auth/token).
        gw = _gw()
        d = gw.route("refactor the auth token exchange")
        self.assertEqual(d.target, LOCAL, "sensitivity must win over load")

    def test_default_routes_local(self):
        gw = _gw()
        d = gw.route("add a small helper function")
        self.assertEqual(d.target, LOCAL)

    def test_route_accepts_a_step(self):
        gw = _gw(openai_api_key="k")  # usable cloud, so reasoning -> cloud
        step = Step(index=0, description="design a caching layer")
        d = gw.route(step)
        self.assertEqual(d.target, CLOUD)

    def test_route_decision_never_serializes_key(self):
        gw = _gw(claude_api_key="secret-key", primary="claude")
        d = gw.route("design something big")  # cloud -> carries the key
        self.assertEqual(d.provider, "claude")
        self.assertEqual(d.api_key, "secret-key")
        self.assertNotIn("api_key", d.to_dict())


class TestGatewayRouteHint(unittest.TestCase):
    """Per-message route hint (composer local/cloud/auto). The gateway grants it
    only WITHIN the zero-egress sensitivity floor and stays authoritative."""

    def test_hint_local_forces_local(self):
        # Even a cloud-capable, reasoning intent goes local when the user asks.
        gw = _gw(openai_api_key="k")
        d = gw.route("design a distributed rate limiter", hint="local")
        self.assertEqual(d.target, LOCAL)
        self.assertTrue(d.is_local)
        self.assertIn("you chose local", d.reason)

    def test_hint_cloud_routes_cloud_when_usable(self):
        # A benign intent that would default LOCAL goes cloud on request, when a
        # cloud provider is actually usable.
        gw = _gw(openai_api_key="k", primary="openai")
        d = gw.route("write a friendly greeting", hint="cloud")
        self.assertEqual(d.target, CLOUD)
        self.assertFalse(d.is_local)
        self.assertIn("you chose cloud", d.reason)

    def test_hint_cloud_without_provider_stays_local_honestly(self):
        # No cloud key, no CLI bridge: "cloud" cannot be granted, so stay local
        # and say so — never pretend to route to a keyless stub.
        gw = _gw()  # keyless, no explicit primary
        d = gw.route("write a friendly greeting", hint="cloud")
        self.assertEqual(d.target, LOCAL)
        self.assertTrue(d.is_local)
        self.assertIn("no cloud provider is configured", d.reason)

    def test_sensitivity_floor_overrides_cloud_hint(self):
        # The HARD floor: a secret stays local even when the user asked for cloud,
        # and the reason acknowledges the refusal (honest chip).
        gw = _gw(openai_api_key="k", primary="openai")
        d = gw.route("rotate the customer password", hint="cloud")
        self.assertEqual(d.target, LOCAL)
        self.assertTrue(d.is_local)
        self.assertIn("password", d.matched)
        self.assertIn("you asked for cloud", d.reason)
        self.assertIn("kept local", d.reason)

    def test_sensitivity_floor_overrides_local_hint_trivially(self):
        # "local" + sensitive still local (the plain sensitivity reason stands).
        gw = _gw(openai_api_key="k", primary="openai")
        d = gw.route("rotate the customer password", hint="local")
        self.assertEqual(d.target, LOCAL)
        self.assertIn("sensitive keyword", d.reason)

    def test_no_hint_is_byte_identical_across_branches(self):
        # hint=None must reproduce the EXACT RouteDecision today's route() gives,
        # for each existing branch (sensitive / reasoning / default-local /
        # explicit-primary).
        cases = [
            (_gw(), "rotate the customer password"),          # sensitive
            (_gw(openai_api_key="k"), "design a distributed system"),  # reasoning
            (_gw(), "add a small helper"),                    # default local
            (_gw(claude_api_key="k", primary="claude"), "say hello"),  # primary
        ]
        for gw, intent in cases:
            a = gw.route(intent)
            b = gw.route(intent, hint=None)
            self.assertEqual(a.to_dict(), b.to_dict(), intent)
            self.assertEqual(a.target, b.target, intent)


class TestGatewayCache(unittest.TestCase):
    def test_prompt_cache_hit_on_repeat(self):
        gw = _gw()
        msgs = [{"role": "user", "content": "explain the widget pipeline"}]
        route = gw.route("explain the widget pipeline")

        first = gw.model_call(msgs, route)
        self.assertEqual(first.cache, "miss")

        second = gw.model_call(msgs, route)
        self.assertEqual(second.cache, "prompt")
        self.assertEqual(second.text, first.text)
        self.assertEqual(gw.stats["prompt_hit"], 1)
        self.assertEqual(gw.stats["miss"], 1)

    def test_semantic_cache_hit_on_normalized_intent(self):
        gw = _gw()
        route = gw.route("summarize the report")
        a = [{"role": "user", "content": "Summarize the Report."}]
        b = [{"role": "user", "content": "summarize   the report"}]

        first = gw.model_call(a, route)
        self.assertEqual(first.cache, "miss")

        # Different exact bytes, same normalized intent bucket.
        second = gw.model_call(b, route)
        self.assertEqual(second.cache, "semantic")
        self.assertEqual(gw.stats["semantic_hit"], 1)

    def test_offline_stand_in_is_deterministic_and_names_its_cause(self):
        # Two independent gateways, same messages -> identical output.
        gw1 = _gw()
        gw2 = _gw()
        msgs = [{"role": "user", "content": "produce a deterministic answer"}]
        r1 = gw1.model_call(msgs, gw1.route("produce a deterministic answer"))
        r2 = gw2.model_call(msgs, gw2.route("produce a deterministic answer"))
        self.assertFalse(r1.is_real)
        self.assertEqual(r1.text, r2.text)
        self.assertEqual(r1.tokens_in, r2.tokens_in)
        self.assertEqual(r1.tokens_out, r2.tokens_out)

        # It keeps the "[offline:" contract the client reads as "NOT model
        # output" ...
        self.assertTrue(r1.text.startswith("[offline:"))
        # ... and it now NAMES WHY. The blind stub said only "handled: <prompt>"
        # and recorded `error: null` on the span, so a run that fell back three
        # times in a row left no trace of what had gone wrong. Every ending the
        # gateway can reach is one we can describe.
        self.assertNotIn("handled:", r1.text)
        self.assertTrue(
            any(
                w in r1.text
                for w in ("could not reach", "did not answer", "refused", "answered")
            ),
            f"stand-in does not name a cause: {r1.text!r}",
        )

        # NO TOKENS ARE CLAIMED. The old stub invented a hash-derived count
        # between 8 and 47, which flowed into the token totals and the cost
        # line — measurements of work no model ever did.
        self.assertEqual(r1.tokens_out, 0)


class _FakeResp:
    """Minimal urlopen() context-manager double returning a fixed JSON body."""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _capture(payload):
    """Return (patcher-target-fn, captured-dict) — fake urlopen recording the
    outbound Request (url/headers/body) and replying with `payload`."""
    captured: dict = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.headers)
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResp(payload)

    return fake_urlopen, captured


class TestGatewayProviderRequests(unittest.TestCase):
    """Assert the REQUEST built per provider (URL, auth header, model, body
    shape) with monkeypatched HTTP — no real network, no real keys."""

    _MSGS = [{"role": "user", "content": "hello"}]

    def test_openai_request_construction(self):
        gw = _gw(openai_api_key="sk-openai", primary="openai")
        route = gw.route("design a distributed system")  # reasoning -> cloud
        self.assertEqual(route.provider, "openai")
        fake, cap = _capture(
            {"choices": [{"message": {"content": "hi from openai"}}],
             "usage": {"prompt_tokens": 3, "completion_tokens": 5}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            res = gw.model_call(self._MSGS, route)
        self.assertEqual(cap["url"], "https://api.openai.com/v1/chat/completions")
        self.assertEqual(cap["headers"].get("Authorization"), "Bearer sk-openai")
        self.assertNotIn("X-api-key", cap["headers"])
        self.assertEqual(cap["body"]["model"], "gpt-5")
        self.assertEqual(cap["body"]["messages"], self._MSGS)
        self.assertTrue(res.is_real)
        self.assertEqual(res.text, "hi from openai")
        self.assertEqual((res.tokens_in, res.tokens_out), (3, 5))

    def test_gemini_uses_openai_compat_path(self):
        gw = _gw(gemini_api_key="g-key", primary="gemini")
        route = gw.route("design a caching layer")
        self.assertEqual(route.provider, "gemini")
        fake, cap = _capture(
            {"choices": [{"message": {"content": "hi from gemini"}}], "usage": {}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            res = gw.model_call(self._MSGS, route)
        self.assertEqual(
            cap["url"],
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        )
        self.assertEqual(cap["headers"].get("Authorization"), "Bearer g-key")
        # The default is an ALIAS (2026-08-31): Google retired the pinned
        # 2.5-flash for new keys and a fresh install got HTTP 404 on its
        # first call. -latest keeps resolving to a live model.
        self.assertEqual(cap["body"]["model"], "gemini-flash-latest")
        self.assertTrue(res.is_real)
        self.assertEqual(res.text, "hi from gemini")

    def test_claude_uses_messages_api_shape(self):
        gw = _gw(claude_api_key="ck", primary="claude")
        route = gw.route("design a big thing")
        self.assertEqual(route.provider, "claude")
        msgs = [
            {"role": "system", "content": "be terse"},
            {"role": "user", "content": "hello"},
        ]
        fake, cap = _capture(
            {"content": [{"text": "claude says hi"}],
             "usage": {"input_tokens": 4, "output_tokens": 6}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            res = gw.model_call(msgs, route)
        # Anthropic Messages API — separate URL + auth scheme from OpenAI-compat.
        self.assertEqual(cap["url"], "https://api.anthropic.com/v1/messages")
        self.assertEqual(cap["headers"].get("X-api-key"), "ck")
        self.assertEqual(cap["headers"].get("Anthropic-version"), "2023-06-01")
        self.assertNotIn("Authorization", cap["headers"])
        self.assertEqual(cap["body"]["model"], "claude-sonnet-5")
        self.assertIn("max_tokens", cap["body"])
        # system message maps to top-level `system`, not the messages array.
        self.assertEqual(cap["body"]["system"], "be terse")
        self.assertEqual(cap["body"]["messages"], [{"role": "user", "content": "hello"}])
        self.assertTrue(res.is_real)
        self.assertEqual(res.text, "claude says hi")
        self.assertEqual((res.tokens_in, res.tokens_out), (4, 6))

    def test_model_override_is_honored(self):
        gw = _gw(openai_api_key="k", primary="openai", openai_model="gpt-4o")
        route = gw.route("design a system")
        fake, cap = _capture(
            {"choices": [{"message": {"content": "x"}}], "usage": {}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            gw.model_call(self._MSGS, route)
        self.assertEqual(cap["body"]["model"], "gpt-4o")

    def test_primary_from_scprism_env(self):
        # SCPRISM_PRIMARY selects the primary provider (client-forwarded).
        gw = _gw(claude_api_key="ck", env={"SCPRISM_PRIMARY": "claude"})
        self.assertEqual(gw.primary, "claude")

    def test_cloud_without_key_falls_to_offline_stub(self):
        gw = _gw(primary="claude")  # no key
        # An EXPLICIT cloud primary answers the default lane (non-reasoning,
        # non-sensitive) — the keyless cloud route then falls to the stub. (A
        # reasoning intent would now stay local without a usable cloud — R2.)
        route = gw.route("write a friendly greeting")
        self.assertFalse(route.is_local)
        # Must NOT make a network call — patched to explode if it does.
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("no net")):
            res = gw.model_call(self._MSGS, route)
        self.assertFalse(res.is_real)
        self.assertTrue(res.text.startswith("[offline:claude"))


class TestGatewayMaxTokens(unittest.TestCase):
    """The output budget is EXPLICIT on every real path. Without it the server's
    own per-request default silently guillotined the reply (a reasoning model
    spends much of its budget thinking before the visible answer)."""

    _MSGS = [{"role": "user", "content": "write the report"}]
    _OK = {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
           "usage": {}}

    def _openai_body(self, **kw):
        gw = _gw(openai_api_key="k", primary="openai", **kw)
        route = gw.route("design a distributed system")
        fake, cap = _capture(self._OK)
        with mock.patch("urllib.request.urlopen", fake):
            gw.model_call(self._MSGS, route)
        return cap["body"]

    def test_openai_payload_sends_the_default_max_tokens(self):
        self.assertEqual(self._openai_body()["max_tokens"], DEFAULT_MAX_TOKENS)
        self.assertGreater(DEFAULT_MAX_TOKENS, 1024, "1024 was the truncating floor")

    def test_env_overrides_the_default(self):
        body = self._openai_body(env={"SCPRISM_MAX_TOKENS": "7777"})
        self.assertEqual(body["max_tokens"], 7777)

    def test_explicit_arg_beats_the_env(self):
        body = self._openai_body(max_tokens=321, env={"SCPRISM_MAX_TOKENS": "7777"})
        self.assertEqual(body["max_tokens"], 321)

    def test_anthropic_max_tokens_exceeds_every_thinking_floor(self):
        # Thinking is drawn from max_tokens, so the cap must clear the floor at
        # EVERY effort level — including `max` (18432).
        for effort, floor in ANTHROPIC_MAX_TOKENS_FLOOR.items():
            with self.subTest(effort=effort):
                gw = _gw(claude_api_key="ck", primary="claude",
                         env={"SCPRISM_EFFORT": effort})
                route = gw.route("design a big thing")
                fake, cap = _capture(
                    {"content": [{"text": "hi"}], "usage": {}, "stop_reason": "end_turn"}
                )
                with mock.patch("urllib.request.urlopen", fake):
                    gw.model_call(self._MSGS, route)
                self.assertGreaterEqual(cap["body"]["max_tokens"], floor)
                self.assertGreaterEqual(cap["body"]["max_tokens"], DEFAULT_MAX_TOKENS)

    def test_anthropic_max_tokens_defaults_to_the_shared_value(self):
        gw = _gw(claude_api_key="ck", primary="claude")  # no effort -> no thinking
        route = gw.route("design a big thing")
        fake, cap = _capture(
            {"content": [{"text": "hi"}], "usage": {}, "stop_reason": "end_turn"}
        )
        with mock.patch("urllib.request.urlopen", fake):
            gw.model_call(self._MSGS, route)
        self.assertEqual(cap["body"]["max_tokens"], DEFAULT_MAX_TOKENS)


class TestGatewayTruncationHonesty(unittest.TestCase):
    """A reply the provider cut off at the cap must be RECORDED as cut off —
    never handed on (or graded) as a complete answer."""

    _MSGS = [{"role": "user", "content": "top 3 fixes"}]

    def _call(self, payload, **kw):
        gw = _gw(openai_api_key="k", primary="openai", **kw)
        route = gw.route("design a distributed system")
        fake, _cap = _capture(payload)
        with mock.patch("urllib.request.urlopen", fake):
            return gw.model_call(self._MSGS, route)

    def test_length_finish_reason_is_recorded_as_truncated(self):
        res = self._call(
            {"choices": [{"message": {"content": "fix 1... fix 2 is cut"},
                          "finish_reason": "length"}],
             "usage": {"prompt_tokens": 3, "completion_tokens": 9}}
        )
        self.assertTrue(res.truncated)
        self.assertTrue(res.to_dict()["truncated"])

    def test_clean_stop_is_not_marked_truncated(self):
        res = self._call(
            {"choices": [{"message": {"content": "done"}, "finish_reason": "stop"}],
             "usage": {}}
        )
        self.assertFalse(res.truncated)

    def test_anthropic_max_tokens_stop_reason_is_recorded(self):
        gw = _gw(claude_api_key="ck", primary="claude")
        route = gw.route("design a big thing")
        fake, _cap = _capture(
            {"content": [{"text": "cut off mid-sen"}], "usage": {},
             "stop_reason": "max_tokens"}
        )
        with mock.patch("urllib.request.urlopen", fake):
            res = gw.model_call(self._MSGS, route)
        self.assertTrue(res.truncated)

    def test_offline_stub_is_never_marked_truncated(self):
        gw = _gw()  # unreachable endpoint -> deterministic stub
        res = gw.model_call(self._MSGS, gw.route("write a greeting"))
        self.assertFalse(res.is_real)
        self.assertFalse(res.truncated)

    def test_cache_hit_keeps_the_truncation_flag(self):
        gw = _gw(openai_api_key="k", primary="openai")
        route = gw.route("design a distributed system")
        fake, _cap = _capture(
            {"choices": [{"message": {"content": "cut"}, "finish_reason": "length"}],
             "usage": {}}
        )
        with mock.patch("urllib.request.urlopen", fake):
            gw.model_call(self._MSGS, route)
        # Second call is a prompt-cache hit — honesty must survive the cache.
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("no net")):
            hit = gw.model_call(self._MSGS, route)
        self.assertEqual(hit.cache, "prompt")
        self.assertTrue(hit.truncated)


class TestAnthropicThinkingShape(unittest.TestCase):
    """The Anthropic path must send the shape CURRENT Claude models accept.

    The legacy {"type": "enabled", "budget_tokens": N} form is rejected with a
    400 by current models (adaptive thinking replaced it), so an API-key user
    who picked any thinking effort got no answer at all."""

    _MSGS = [{"role": "user", "content": "design a big thing"}]
    _OK = {"content": [{"text": "hi"}], "usage": {}, "stop_reason": "end_turn"}

    def _body(self, effort, model=None):
        kw = {"claude_api_key": "ck", "primary": "claude",
              "env": {"SCPRISM_EFFORT": effort} if effort else {}}
        if model:
            kw["claude_model"] = model
        gw = _gw(**kw)
        route = gw.route("design a big thing")
        fake, cap = _capture(self._OK)
        with mock.patch("urllib.request.urlopen", fake):
            gw.model_call(self._MSGS, route)
        return cap["body"]

    def test_every_effort_level_sends_the_current_shape(self):
        # The UI offers low|medium|high|xhigh|max; the API's own effort ladder
        # is the same five, so the mapping is 1:1 with no clamping.
        for effort in ANTHROPIC_EFFORTS:
            with self.subTest(effort=effort):
                body = self._body(effort)
                self.assertEqual(body["thinking"], {"type": "adaptive"})
                self.assertEqual(body["output_config"], {"effort": effort})

    def test_the_legacy_budget_shape_is_never_sent(self):
        # The regression this fix exists for: budget_tokens 400s on every
        # current Claude model, whatever effort the user picked.
        for effort in ANTHROPIC_EFFORTS:
            with self.subTest(effort=effort):
                body = self._body(effort)
                self.assertNotIn("budget_tokens", body["thinking"])
                self.assertNotEqual(body["thinking"].get("type"), "enabled")

    def test_no_thinking_field_when_effort_is_unset(self):
        body = self._body("")
        self.assertNotIn("thinking", body)
        self.assertNotIn("output_config", body)
        self.assertEqual(body["max_tokens"], DEFAULT_MAX_TOKENS)

    def test_unknown_effort_sends_no_thinking_field(self):
        body = self._body("turbo")
        self.assertNotIn("thinking", body)

    def test_a_model_without_adaptive_thinking_gets_no_thinking_field(self):
        # Omitting the field is the honest move for a pre-4.6 model: it has no
        # adaptive mode, and sending a shape it rejects would lose the answer.
        body = self._body("high", model="claude-3-5-haiku-20241022")
        self.assertNotIn("thinking", body)
        self.assertNotIn("output_config", body)

    def test_max_tokens_still_clears_the_deepest_thinking(self):
        for effort in ANTHROPIC_EFFORTS:
            with self.subTest(effort=effort):
                self.assertGreaterEqual(
                    self._body(effort)["max_tokens"],
                    ANTHROPIC_MAX_TOKENS_FLOOR[effort],
                )


class TestGatewayRejectionHonesty(unittest.TestCase):
    """A request the provider REFUSED must not be dressed up as an offline
    stub — the run has to name the cause instead of reading as 'the model
    didn't answer'."""

    _MSGS = [{"role": "user", "content": "design a big thing"}]

    @staticmethod
    def _http_error(code, body=b""):
        return urllib.error.HTTPError(
            "https://api.anthropic.com/v1/messages", code, "Bad Request", {},
            io.BytesIO(body),
        )

    def _call(self, err):
        gw = _gw(claude_api_key="ck", primary="claude",
                 env={"SCPRISM_EFFORT": "high"})
        route = gw.route("design a big thing")
        with mock.patch("urllib.request.urlopen", side_effect=err):
            return gw.model_call(self._MSGS, route)

    def test_a_rejected_request_is_named_not_silently_stubbed(self):
        res = self._call(self._http_error(
            400, b'{"error":{"message":"thinking: unexpected field budget_tokens"}}'
        ))
        self.assertFalse(res.is_real)
        self.assertTrue(res.text.startswith("[rejected:claude"))
        self.assertFalse(res.text.startswith("[offline:"))
        self.assertIn("400", res.text)
        self.assertIn("budget_tokens", res.text)  # the provider's own cause

    def test_a_rejected_request_is_not_treated_as_a_real_answer(self):
        # The loop's honesty markers gate what reaches chat / a file writer.
        res = self._call(self._http_error(400))
        self.assertTrue(
            res.text.lstrip().startswith(("[offline:", "[stub:", "[rejected:"))
        )

    def test_an_exhausted_rate_limit_still_falls_to_the_offline_stub(self):
        # 429 is an outage, not an invalid request — the stub stays correct.
        import scprism_engine.gateway as gw_module

        with mock.patch.object(gw_module, "_sleep", lambda s: None):
            res = self._call(self._http_error(429))
        self.assertFalse(res.is_real)
        self.assertTrue(res.text.startswith("[offline:claude"))


class TestGatewayPrimary(unittest.TestCase):
    def test_primary_prefers_claude_then_openai_then_gemini(self):
        self.assertEqual(_gw(claude_api_key="k").primary, "claude")
        self.assertEqual(_gw(openai_api_key="k").primary, "openai")
        self.assertEqual(_gw(gemini_api_key="k").primary, "gemini")
        self.assertEqual(_gw().primary, "openai")  # label default


if __name__ == "__main__":
    unittest.main()


class TestHttpTimeoutDefault(unittest.TestCase):
    """The HTTP model-call timeout must fit REAL inference (local model load
    5-30s+, cloud completions seconds) — the old 2.0s default starved every
    real provider into the honest stub while passing on fast test stubs."""

    def test_default_is_inference_scale(self):
        self.assertEqual(Gateway(env={}).timeout, 120.0)

    def test_env_override(self):
        gw = Gateway(env={"SCPRISM_HTTP_TIMEOUT": "45"})
        self.assertEqual(gw.timeout, 45.0)

    def test_explicit_arg_beats_env(self):
        gw = Gateway(env={"SCPRISM_HTTP_TIMEOUT": "45"}, timeout=0.2)
        self.assertEqual(gw.timeout, 0.2)

    def test_garbage_nonfinite_and_nonpositive_fall_back(self):
        for bad in ("banana", "nan", "inf", "-inf", "-3", "0"):
            gw = Gateway(env={"SCPRISM_HTTP_TIMEOUT": bad})
            self.assertEqual(gw.timeout, 120.0, f"env value {bad!r}")


class TestMalformedBodyIsRetried(unittest.TestCase):
    """A body that is not a completion is an INFRASTRUCTURE FAULT, not a verdict.

    Sukhdeep's local server answers short probes perfectly and then, partway
    through a long agentic run, returns a body with no `choices` key. Four
    separate multi-minute wakes died on it — six to fifteen minutes of real work
    each, every one recorded as "the provider is offline". It is not offline:
    the very next request succeeds.
    """

    def _route(self):
        return RouteDecision(
            provider="local", model="m", target="local", is_local=True,
            reason="test", base_url="http://x", api_key="",
        )

    def test_a_malformed_body_is_retried_and_the_retry_is_used(self):
        gw = Gateway()
        calls = {"n": 0}

        def flaky(messages, route):
            calls["n"] += 1
            if calls["n"] == 1:
                raise KeyError("choices")
            return ("real answer", 10, 5, True, False)

        gw._invoke_openai = flaky
        with mock.patch("time.sleep"):
            text, _, _, is_real, _ = gw._invoke_with_retry([], self._route())
        self.assertEqual(text, "real answer")
        self.assertTrue(is_real)
        self.assertEqual(calls["n"], 2)

    def test_a_truncated_read_is_the_same_family(self):
        gw = Gateway()
        calls = {"n": 0}

        def flaky(messages, route):
            calls["n"] += 1
            if calls["n"] < 3:
                raise http.client.IncompleteRead(b"7 bytes")
            return ("recovered", 1, 1, True, False)

        gw._invoke_openai = flaky
        with mock.patch("time.sleep"):
            text, _, _, _, _ = gw._invoke_with_retry([], self._route())
        self.assertEqual(text, "recovered")
        self.assertEqual(calls["n"], 3)

    def test_a_persistent_fault_still_gives_up_rather_than_hanging(self):
        gw = Gateway()
        calls = {"n": 0}

        def always_bad(messages, route):
            calls["n"] += 1
            raise KeyError("choices")

        gw._invoke_openai = always_bad
        with mock.patch("time.sleep"):
            with self.assertRaises(KeyError):
                gw._invoke_with_retry([], self._route())
        # The first attempt plus MALFORMED_RETRIES, and no more.
        self.assertEqual(calls["n"], MALFORMED_RETRIES + 1)

    def test_a_REFUSAL_is_not_retried_it_would_only_be_refused_again(self):
        gw = Gateway()
        calls = {"n": 0}

        def refused(messages, route):
            calls["n"] += 1
            raise urllib.error.HTTPError("http://x", 400, "bad request", {}, None)

        gw._invoke_openai = refused
        with self.assertRaises(urllib.error.HTTPError):
            gw._invoke_with_retry([], self._route())
        self.assertEqual(calls["n"], 1)
