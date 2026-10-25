"""The VAULT EGRESS FLOOR — the product's core promise, under test at the wire.

"Your private work stays on your machine" is the claim the whole product rests
on. The vault tool source hands the model the user's OWN notes, and the only
thing that stood between those notes and a cloud POST was
``guard_cloud_tool_result``: an 18-word keyword denylist. An adversarial audit
walked realistic private notes past it — a diagnosis with a dosage, mortgage
figures, salaries by name, settlement terms, a home address — and every one of
them reached the outbound cloud request verbatim, on the DEFAULT route. The
original commit shipped ZERO tests for this.

So these tests assert the claim where it can actually be broken: at the HTTP
boundary. ``urllib.request.urlopen`` is patched to record every outbound request
the gateway builds, and the note body is searched for in the bodies of the ones
addressed to the CLOUD host. Nothing here reaches the network, and the vault is
a throwaway temp directory — no real user data.

The three laws:

  1. A cloud-routed run that reads the vault flips LOCAL for the rest of the run,
     and the note text appears in NO cloud request body (but DOES reach the local
     model — the companion is kept honest, not blinded).
  2. With no local model to route to, the content is WITHHELD from the cloud turn
     with an honest observation and a ``withheld=True`` / ``provider="vault"``
     span. Never a silent egress, never a silent empty result.
  3. A run that touches no vault tool routes exactly as it did before — the floor
     costs nothing to anyone who never opens a note.
"""

import json
import os
import tempfile
import threading
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.gateway import Gateway, guard_cloud_tool_result
from scprism_engine.loop import _WITHHELD_VAULT_RESULT, VAULT_LOCAL_REASON, run
from scprism_engine.telemetry import Telemetry, read_spans
from scprism_engine.vault_tools import VaultToolProvider

# The private note the audit's medical/mortgage/salary cases all reduce to: a
# string that must never appear in a cloud request body.
_NOTE_TOKEN = "MAGIC_PRIVATE_NOTE_TOKEN"
_NOTE_BODY = (
    "# Health\n\nDiagnosis noted 2026-04-02; dosage 20mg nightly. %s\n" % _NOTE_TOKEN
)

_CLOUD_HOST = "https://api.openai.com"
_LOCAL_URL = "http://127.0.0.1:9"


def _tool_call(name, arguments):
    return "```tool_call\n%s\n```" % json.dumps({"tool": name, "arguments": arguments})


class _FakeResp:
    """Minimal urlopen() context-manager double (mirrors test_gateway's)."""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Wire:
    """Records every outbound model request and scripts the replies.

    The FIRST request gets a ``vault_read`` tool_call block; every later one gets
    a fixed final answer that quotes nothing (so a leak can only come from the
    tool result, never from the fake model echoing its prompt). ``tool=None``
    scripts a model that never asks for a tool at all.
    """

    def __init__(self, tool="vault_read", args=None):
        self.posts = []
        self._lock = threading.Lock()
        self._tool = tool
        self._args = {"path": "notes/health.md"} if args is None else args

    def urlopen(self, req, timeout=None):
        body = json.loads(req.data.decode("utf-8"))
        with self._lock:
            self.posts.append({"url": req.full_url, "body": body})
            first = len(self.posts) == 1
        text = (
            _tool_call(self._tool, self._args)
            if first and self._tool
            else "final answer: noted."
        )
        return _FakeResp(
            {
                "choices": [{"message": {"content": text}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 7},
            }
        )

    # -- what the wire actually carried ---------------------------------

    def bodies_to(self, prefix):
        return [
            json.dumps(p["body"], ensure_ascii=False)
            for p in self.posts
            if p["url"].startswith(prefix)
        ]

    def cloud_bodies(self):
        return self.bodies_to(_CLOUD_HOST)

    def local_bodies(self):
        return self.bodies_to(_LOCAL_URL)


def _cloud_first_gateway(**kw):
    """A gateway whose DEFAULT route is cloud (an explicit primary + a real key)
    and whose local endpoint is a distinguishable dead address, so a request's
    URL alone says which side of the floor it was on."""
    env = {"SCPRISM_PRIMARY": "openai", "OPENAI_API_KEY": "sk-test-not-real"}
    env.update(kw.pop("env", {}))
    return Gateway(openai_base_url=_LOCAL_URL, env=env, timeout=0.2, **kw)


class _VaultRunMixin:
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        os.makedirs(os.path.join(self.vault, "notes"), exist_ok=True)
        with open(
            os.path.join(self.vault, "notes", "health.md"), "w", encoding="utf-8"
        ) as fh:
            fh.write(_NOTE_BODY)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, gateway, wire, task_id, intent="summarize my health note"):
        # One Telemetry for the run AND the provider, exactly as the CLI wires it
        # (`_build_vault_provider(args, telemetry)`) — otherwise the provider's
        # own tool_exec spans are never written and the trace assertions below
        # would be testing an unwired engine.
        tel = Telemetry(os.path.join(self.vault, "spans.jsonl"))
        with mock.patch("urllib.request.urlopen", wire.urlopen):
            return run(
                parse(intent, task_id=task_id),
                vault=self.vault,
                tier1_commands=["true"],
                gateway=gateway,
                telemetry=tel,
                mcp_client=VaultToolProvider(self.vault, telemetry=tel),
                record_training=False,
            )

    def _spans(self, span_type=None, name=None):
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        if span_type:
            spans = [s for s in spans if s["type"] == span_type]
        if name:
            spans = [s for s in spans if s["name"] == name]
        return spans


class TestVaultReadForcesTheRunLocal(_VaultRunMixin, unittest.TestCase):
    def test_the_note_never_reaches_a_cloud_request_body(self):
        """LAW 1, at the wire. The run starts cloud, reads a note, and from that
        moment every model turn is local — so the note body exists in a LOCAL
        request and in NO cloud request."""
        wire = _Wire()
        self._run(_cloud_first_gateway(), wire, "t-vault-egress-1")

        cloud = wire.cloud_bodies()
        local = wire.local_bodies()
        self.assertTrue(cloud, "the run really started on the cloud provider")
        self.assertTrue(local, "the forced-local turn really happened")
        # THE claim.
        for body in cloud:
            self.assertNotIn(_NOTE_TOKEN, body, "the note reached a CLOUD request")
        # ...and the companion was kept honest, not blinded: the local model
        # really did receive the note.
        self.assertTrue(
            any(_NOTE_TOKEN in body for body in local),
            "the note never reached the local model either — that is blinding, "
            "not protecting",
        )

    def test_the_turn_after_the_read_is_spanned_local_with_an_honest_reason(self):
        """The chip and the Console read the SPANS. If the flip is not on the
        span, the UI keeps claiming the cloud model answered."""
        wire = _Wire()
        self._run(_cloud_first_gateway(), wire, "t-vault-egress-2")

        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        vault_exec = next(
            (
                s
                for s in spans
                if s["type"] == "tool_exec" and s["attrs"].get("provider") == "vault"
            ),
            None,
        )
        self.assertIsNotNone(vault_exec, "the vault tool really ran")
        after = [
            s
            for s in spans
            if s["type"] == "model_call"
            and s["name"] == "model_call"
            and s["start"] >= vault_exec["start"]
            and s["attrs"].get("reason") == VAULT_LOCAL_REASON
        ]
        self.assertTrue(after, "no model turn recorded the forced-local route")
        for s in after:
            self.assertEqual(s["attrs"]["route"], "local")
            self.assertTrue(s["attrs"]["is_local"])
            self.assertEqual(s["attrs"]["provider"], "local")

    def test_the_verdict_names_the_model_that_actually_read_the_notes(self):
        wire = _Wire()
        verdict = self._run(_cloud_first_gateway(), wire, "t-vault-egress-3")
        models = verdict.models_used
        self.assertTrue(
            any(m.startswith("local ") for m in models),
            "the verdict hid the local model that read the vault: %r" % (models,),
        )
        self.assertIn(
            VAULT_LOCAL_REASON,
            json.dumps(verdict.model_route_reasons),
            "the verdict does not say WHY the route changed",
        )

    def test_a_list_or_search_flips_the_run_too(self):
        """All four tools are content-bearing: a listing is the user's filenames
        and a search is their note excerpts."""
        for tool, args, task in (
            ("vault_list", {}, "t-vault-egress-list"),
            ("vault_search", {"query": "diagnosis"}, "t-vault-egress-search"),
            ("project_status", {}, "t-vault-egress-status"),
        ):
            with self.subTest(tool=tool):
                self.tearDown()
                self.setUp()
                wire = _Wire(tool=tool, args=args)
                self._run(_cloud_first_gateway(), wire, task)
                reasons = {
                    s["attrs"].get("reason")
                    for s in self._spans("model_call", "model_call")
                }
                self.assertIn(VAULT_LOCAL_REASON, reasons)


class TestNoLocalModelWithholdsRatherThanEgresses(_VaultRunMixin, unittest.TestCase):
    """LAW 2. The fallback for "there is nowhere local to send this" must be
    silence toward the cloud, never a quiet cloud send."""

    def _no_local_gateway(self):
        # A gateway with NO local endpoint to route to: `local_route_for` answers
        # None, exactly as it does for any gateway that cannot route local (the
        # Bifrost supervisor has no such seam at all — same withhold path).
        gw = _cloud_first_gateway()
        gw.local_base_url = ""
        self.assertIsNone(gw.local_route_for(VAULT_LOCAL_REASON))
        return gw

    def test_the_content_is_withheld_and_never_egressed(self):
        wire = _Wire()
        self._run(self._no_local_gateway(), wire, "t-vault-withhold-1")

        self.assertTrue(wire.cloud_bodies())
        self.assertFalse(wire.local_bodies(), "there was no local model to call")
        for body in wire.cloud_bodies():
            self.assertNotIn(_NOTE_TOKEN, body, "the note reached a CLOUD request")

    def test_the_model_is_told_honestly_that_the_content_exists(self):
        """A silent empty result invites the model to paper over the gap; it is
        told the note exists and could not be shown."""
        wire = _Wire()
        self._run(self._no_local_gateway(), wire, "t-vault-withhold-2")
        told = [b for b in wire.cloud_bodies() if _WITHHELD_VAULT_RESULT in b]
        self.assertTrue(told, "the model was never told the content was withheld")
        for phrase in ("your vault content", "was not sent"):
            self.assertIn(phrase, told[0])

    def test_the_withhold_is_audited_as_a_vault_span(self):
        wire = _Wire()
        self._run(self._no_local_gateway(), wire, "t-vault-withhold-3")
        withheld = [
            s
            for s in self._spans("tool_exec")
            if s["attrs"].get("withheld") is True
        ]
        self.assertTrue(withheld, "the withholding was never audited")
        self.assertEqual(withheld[0]["attrs"]["provider"], "vault")
        self.assertEqual(withheld[0]["attrs"]["tool"], "vault_read")


class TestNoVaultToolNoChange(_VaultRunMixin, unittest.TestCase):
    """LAW 3. The floor costs nothing to a run that never opens a note."""

    def _routes(self):
        """Every dispatch turn's (route, reason), sorted — the run's routing
        fingerprint. Sorted because reads dispatch concurrently, so span ORDER is
        not a stable fact; the set of decisions is."""
        return sorted(
            (s["attrs"].get("route"), s["attrs"].get("reason"))
            for s in self._spans("model_call", "model_call")
        )

    def test_routing_is_byte_identical_to_a_run_with_no_vault_source_at_all(self):
        """The regression guard: with the vault tools present but never CALLED,
        the run must route exactly as the pre-floor engine did. Compared against
        the same contract run with no tool source whatsoever (``--no-vault-tools``
        — the code path that predates all of this)."""
        # (a) vault tools available; the scripted model never asks for one.
        with mock.patch("urllib.request.urlopen", _Wire(tool=None).urlopen):
            with_tools = run(
                parse("draft a short note", task_id="t-vault-none-1"),
                vault=self.vault,
                tier1_commands=["true"],
                gateway=_cloud_first_gateway(),
                telemetry=Telemetry(os.path.join(self.vault, "spans.jsonl")),
                mcp_client=VaultToolProvider(self.vault),
                record_training=False,
            )
        self.assertFalse(
            [s for s in self._spans("tool_exec") if s["attrs"].get("provider") == "vault"]
        )
        tool_routes = self._routes()

        # (b) the same contract with NO tool source at all — today's baseline.
        self.tearDown()
        self.setUp()
        with mock.patch("urllib.request.urlopen", _Wire(tool=None).urlopen):
            plain = run(
                parse("draft a short note", task_id="t-vault-none-1"),
                vault=self.vault,
                tier1_commands=["true"],
                gateway=_cloud_first_gateway(),
                telemetry=Telemetry(os.path.join(self.vault, "spans.jsonl")),
                record_training=False,
            )

        self.assertEqual(tool_routes, self._routes())
        self.assertEqual(with_tools.models_used, plain.models_used)
        self.assertEqual(with_tools.model_route, plain.model_route)
        self.assertNotIn(VAULT_LOCAL_REASON, json.dumps(tool_routes))

    def test_a_local_run_that_reads_the_vault_is_untouched(self):
        """Already local == already zero-egress: the step keeps its OWN honest
        route reason rather than being relabelled by the floor."""
        gateway = Gateway(openai_base_url=_LOCAL_URL, env={}, timeout=0.2)
        wire = _Wire()
        with mock.patch("urllib.request.urlopen", wire.urlopen):
            run(
                parse("read my health note", task_id="t-vault-local-1"),
                vault=self.vault,
                tier1_commands=["true"],
                gateway=gateway,
                mcp_client=VaultToolProvider(self.vault),
                record_training=False,
            )
        self.assertFalse(wire.cloud_bodies())
        reasons = {
            s["attrs"].get("reason") for s in self._spans("model_call", "model_call")
        }
        self.assertNotIn(VAULT_LOCAL_REASON, reasons)
        self.assertIn("default -> local (cheap, zero egress)", reasons)


class TestTheUsersOwnSensitiveWordsReachTheResultGuard(unittest.TestCase):
    """The audit's second half: ``route()`` has always honored the interview's
    ``SCPRISM_SENSITIVE`` words, but the module-level result guard could not see
    them — a word the USER declared sensitive governed routing and never a tool
    result. The gateway now threads them in; the built-ins stay."""

    def test_a_user_word_now_withholds_a_tool_result(self):
        gw = Gateway(env={"SCPRISM_SENSITIVE": "hollowmere, ledger-x"})
        safe, withheld = gw.guard_tool_result("the Hollowmere merger closes Friday")
        self.assertTrue(withheld)
        self.assertNotIn("Hollowmere", safe)

    def test_the_built_in_list_still_applies(self):
        gw = Gateway(env={"SCPRISM_SENSITIVE": "hollowmere"})
        _safe, withheld = gw.guard_tool_result("db password = hunter2")
        self.assertTrue(withheld)

    def test_ordinary_content_still_passes_through_unchanged(self):
        gw = Gateway(env={"SCPRISM_SENSITIVE": "hollowmere"})
        text = "the fox naps in the retry policy"
        self.assertEqual(gw.guard_tool_result(text), (text, False))
        # ...and the module-level function is byte-identical without `extra`.
        self.assertEqual(guard_cloud_tool_result(text), (text, False))


class TestTheTeamBoardHonorsTheSameFloor(_VaultRunMixin, unittest.TestCase):
    """A team run is offered the vault tools exactly like a solo run
    (test_loop_vault pins that), and it runs its OWN copy of the tool loop in
    team.py. The floor is one shared object precisely so the two paths cannot
    drift — this proves the team side really uses it."""

    def test_a_cloud_agent_that_reads_a_note_flips_the_team_run_local(self):
        from scprism_engine.team import AgentSpec, run_team

        wire = _Wire()
        tel = Telemetry(os.path.join(self.vault, "spans.jsonl"))
        with mock.patch("urllib.request.urlopen", wire.urlopen):
            run_team(
                "summarize my health note",
                self.vault,
                [AgentSpec(name="lead", role="summarize the note", primary="openai")],
                env={"SCPRISM_PRIMARY": "openai", "OPENAI_API_KEY": "sk-test-not-real"},
                telemetry=tel,
                mcp_client=VaultToolProvider(self.vault, telemetry=tel),
            )
        self.assertTrue(wire.cloud_bodies(), "the agent really started on cloud")
        for body in wire.cloud_bodies():
            self.assertNotIn(_NOTE_TOKEN, body, "the note reached a CLOUD request")
        reasons = {
            s["attrs"].get("reason") for s in self._spans("model_call", "model_call")
        }
        self.assertIn(VAULT_LOCAL_REASON, reasons)


if __name__ == "__main__":
    unittest.main()
