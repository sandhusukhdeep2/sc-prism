"""CLI-bridge gateway tests (tranche cli-bridge).

No network, no real CLIs: a fake executable stands in for `claude`, and the
missing-binary path is exercised by pointing discovery at nothing.
"""

import base64
import os
import stat
import tempfile
import time
import unittest
from unittest import mock

from scprism_engine import gateway as gw
from scprism_engine.gateway import Gateway


def _messages(text="design a plan"):
    return [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": text},
    ]


def _image_block(name="shot.png", mime="image/png", data="QUJDREVG"):
    return {"type": "image", "image": {"mime": mime, "data_b64": data}, "name": name}


class CliRoutingTests(unittest.TestCase):
    def test_cli_primary_routes_cloud_with_no_key(self):
        g = Gateway(env={"SCPRISM_PRIMARY": "claude-cli"})
        route = g.route("design a distributed plan")
        self.assertEqual(route.target, "cloud")
        self.assertEqual(route.provider, "claude-cli")
        self.assertEqual(route.model, "claude-code-subscription")
        self.assertIsNone(route.api_key)
        self.assertEqual(route.base_url, "")

    def test_sensitive_still_beats_cli_primary(self):
        g = Gateway(env={"SCPRISM_PRIMARY": "gemini-cli"})
        route = g.route("rotate the password for prod")
        self.assertEqual(route.provider, "local")

    def test_casual_chat_goes_to_explicit_primary(self):
        # No reasoning keyword, no sensitivity — the user's chosen primary
        # still answers (this was the 'why I need a github' bug).
        g = Gateway(env={"SCPRISM_PRIMARY": "claude-cli"})
        route = g.route("why I need a github")
        self.assertEqual(route.target, "cloud")
        self.assertEqual(route.provider, "claude-cli")

    def test_no_explicit_primary_defaults_local(self):
        g = Gateway(env={})
        route = g.route("hello there")
        self.assertEqual(route.provider, "local")

    def test_explicit_local_primary_stays_local(self):
        g = Gateway(env={"SCPRISM_PRIMARY": "local"})
        route = g.route("hello there")
        self.assertEqual(route.provider, "local")

    def test_cli_primary_never_routes_through_bifrost(self):
        # Regression: SCPRISM_BIFROST=1 with a claude-cli primary sent every
        # call to the Go daemon, which doesn't know CLI providers → offline
        # stubs everywhere ("unreachable" in the app). CLI primaries must get
        # the in-process Python gateway regardless of the Bifrost flag.
        from scprism_engine.bifrost_client import make_gateway

        g = make_gateway(env={"SCPRISM_BIFROST": "1", "SCPRISM_PRIMARY": "claude-cli"})
        self.assertEqual(type(g).__name__, "Gateway")
        # Non-CLI primaries keep whatever the flag selects (no assertion on
        # BifrostGateway here — daemon availability varies by machine).

    def test_user_defined_sensitive_words_force_local(self):
        g = Gateway(
            env={
                "SCPRISM_PRIMARY": "claude-cli",
                "SCPRISM_SENSITIVE": "driver PII, payroll audit,  ",
            }
        )
        route = g.route("summarize the payroll audit findings")
        self.assertEqual(route.provider, "local")
        self.assertIn("payroll audit", route.reason)
        # Unrelated chat still goes to the explicit primary.
        self.assertEqual(g.route("hello there").provider, "claude-cli")


class CliInvokeTests(unittest.TestCase):
    def _gateway(self, primary="claude-cli"):
        return Gateway(env={"SCPRISM_PRIMARY": primary})

    def test_missing_binary_falls_back_to_stub(self):
        g = self._gateway()
        route = g.route("design a plan")
        with mock.patch.object(gw, "_find_cli", return_value=None):
            result = g.model_call(_messages(), route)
        self.assertFalse(result.is_real)
        self.assertTrue(result.text.startswith("[offline:claude-cli:"))

    def test_fake_cli_completion_is_real(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = os.path.join(tmp, "claude")
            with open(fake, "w", encoding="utf-8") as f:
                f.write("#!/bin/sh\necho 'hello from the fake CLI'\n")
            os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)

            g = self._gateway()
            route = g.route("design a plan")
            with mock.patch.object(gw, "_find_cli", return_value=fake):
                result = g.model_call(_messages(), route)
        self.assertTrue(result.is_real)
        self.assertEqual(result.text, "hello from the fake CLI")
        self.assertEqual(result.provider, "claude-cli")

    def test_failing_cli_falls_back_to_stub(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = os.path.join(tmp, "gemini")
            with open(fake, "w", encoding="utf-8") as f:
                f.write("#!/bin/sh\necho 'not signed in' >&2\nexit 1\n")
            os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)

            g = self._gateway("gemini-cli")
            route = g.route("design a plan")
            with mock.patch.object(gw, "_find_cli", return_value=fake):
                result = g.model_call(_messages("another plan"), route)
        self.assertFalse(result.is_real)
        self.assertTrue(result.text.startswith("[offline:gemini-cli:"))


class CliImageEgressTests(unittest.TestCase):
    """Regression (image-attach audit): a CLI-bridge route is CLOUD and NON-vision.
    An image-bearing turn must NEVER dump its base64 into the CLI argv (that would
    egress the raw image to the cloud CLI subscription). Instead the honest
    '[image attached … not sent …]' note must fire on the CLI path, exactly as it
    does for the HTTP providers — while the text-only flatten stays byte-identical.
    """

    def _image_messages(self, data):
        return [
            {"role": "system", "content": "be brief"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe this shot"},
                    _image_block(name="secret.png", data=data),
                ],
            },
        ]

    def _capture_argv(self, messages):
        """Route to the CLI path with the BOUNDED runner mocked so we can inspect
        the exact argv the flatten built (and return a clean, real completion)."""
        from scprism_engine.proc import BoundedResult

        seen = {}

        def fake_run(argv, *a, **kw):
            seen["argv"] = list(argv)
            return BoundedResult(
                returncode=0, stdout="cli reply", stderr="", timed_out=False
            )

        g = Gateway(env={"SCPRISM_PRIMARY": "claude-cli"})
        route = g.route("design a plan")
        with mock.patch.object(gw, "_find_cli", return_value="/fake/claude"), \
                mock.patch.object(gw.proc_util, "run_bounded", fake_run):
            result = g.model_call(messages, route)
        return result, seen["argv"]

    def test_image_note_fires_and_base64_never_reaches_argv(self):
        b64 = base64.b64encode(b"SECRET-IMAGE-BYTES-DO-NOT-EGRESS" * 8).decode("ascii")
        result, argv = self._capture_argv(self._image_messages(b64))
        joined = " ".join(argv)
        # The honest non-vision note fired on the CLI path…
        self.assertIn("image attached: secret.png", joined)
        self.assertIn("not sent", joined)
        # …the user's text still rode along…
        self.assertIn("describe this shot", joined)
        # …and the raw base64 NEVER reached the CLI argv (no cloud egress).
        self.assertNotIn(b64, joined)
        for a in argv:
            self.assertNotIn(b64, a)
        # A real completion, not the silent stub fallback.
        self.assertTrue(result.is_real)
        self.assertEqual(result.text, "cli reply")

    def test_text_only_prompt_is_the_user_text_and_system_rides_its_own_flag(self):
        # This test used to pin the flatten "System instructions:\nbe brief\n\n
        # user: plain question". That framing was the bug: Claude received our
        # harness prompt as USER text and refused it as an injection attempt
        # (2026-08-31, see test_cli_bridge_system_prompt). `-p` now carries the
        # user's words alone, and the system prompt travels in claude's own flag.
        _result, argv = self._capture_argv(_messages("plain question"))
        self.assertIn("-p", argv)
        self.assertEqual(argv[argv.index("-p") + 1], "plain question")
        self.assertIn("--append-system-prompt", argv)
        self.assertEqual(argv[argv.index("--append-system-prompt") + 1], "be brief")


if __name__ == "__main__":
    unittest.main()


class CliModelOverrideTests(unittest.TestCase):
    """SCPRISM_CLI_MODEL handling: real overrides forwarded, labels dropped."""

    def _echo_cli_result(self, cli_model):
        with tempfile.TemporaryDirectory() as tmp:
            fake = os.path.join(tmp, "claude")
            with open(fake, "w", encoding="utf-8") as f:
                f.write('#!/bin/sh\necho "$@"\n')
            os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)

            g = Gateway(
                env={"SCPRISM_PRIMARY": "claude-cli", "SCPRISM_CLI_MODEL": cli_model}
            )
            route = g.route("design a plan")
            with mock.patch.object(gw, "_find_cli", return_value=fake):
                return g.model_call(_messages(), route)

    def test_display_label_cli_model_is_dropped(self):
        # Legacy client stores persisted the provider-card LABEL as the model;
        # forwarded as --model it kills the real CLI ("model not found" →
        # offline stub → "couldn't reach the AI" in the app).
        result = self._echo_cli_result("claude-code-subscription")
        self.assertTrue(result.is_real)
        self.assertNotIn("--model", result.text)

    def test_real_cli_model_is_forwarded(self):
        result = self._echo_cli_result("opus")
        self.assertTrue(result.is_real)
        self.assertIn("--model opus", result.text)


class CliTimeoutTests(unittest.TestCase):
    """The bound the user's spans proved was decorative.

    Two concurrent `claude-cli` model_calls ran 48 minutes against a "180s"
    `subprocess.run(timeout=…)` and then returned REAL answers — the app had
    cancelled the run at its own 240s bound 44 minutes earlier. A CLI that does
    not answer must be KILLED, and the result must read as a TIMEOUT, never as
    a completion.
    """

    def _hanging_cli(self, tmp, name="claude"):
        """A fake CLI that spawns a surviving grandchild holding the pipe and
        then sleeps forever — the shape of the real failure."""
        path = os.path.join(tmp, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(
                "#!/bin/sh\n"
                "sleep 600 &\n"        # grandchild, inherits stdout/stderr
                "echo 'thinking...'\n"
                "sleep 600\n"
            )
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
        return path

    def _call_with_timeout(self, seconds, primary="claude-cli", bin_name="claude"):
        with tempfile.TemporaryDirectory() as tmp:
            fake = self._hanging_cli(tmp, bin_name)
            g = Gateway(
                env={"SCPRISM_PRIMARY": primary, "SCPRISM_CLI_TIMEOUT": str(seconds)}
            )
            route = g.route("design a plan")
            started = time.monotonic()
            with mock.patch.object(gw, "_find_cli", return_value=fake):
                result = g.model_call(_messages(), route)
            return result, time.monotonic() - started

    def test_hanging_cli_is_killed_within_the_bound(self):
        result, elapsed = self._call_with_timeout(2)
        self.assertGreaterEqual(elapsed, 2.0)
        self.assertLess(elapsed, 15.0, "the call must return, bounded")
        self.assertIsNotNone(result)

    def test_timeout_is_reported_honestly_and_is_not_real(self):
        result, _ = self._call_with_timeout(2)
        # NEVER a completion: the span records is_real=false.
        self.assertFalse(result.is_real)
        # No reply came back, so no output tokens are invented.
        self.assertEqual(result.tokens_out, 0)
        # The client's "this is not model output" prefix is preserved…
        self.assertTrue(result.text.startswith("[offline:claude-cli:"))
        # …and the REASON names the bound, not a generic failure.
        self.assertIn("the claude CLI did not answer within 2s", result.text)
        # It is NOT the deterministic offline stub's wording.
        self.assertNotIn("handled:", result.text)

    def test_missing_cli_still_reads_as_offline_not_as_a_timeout(self):
        # The two failures stay distinguishable: a CLI that isn't there is not
        # a CLI we killed.
        g = Gateway(env={"SCPRISM_PRIMARY": "claude-cli"})
        route = g.route("design a plan")
        with mock.patch.object(gw, "_find_cli", return_value=None):
            result = g.model_call(_messages(), route)
        self.assertFalse(result.is_real)
        self.assertNotIn("did not answer within", result.text)

    def test_default_bound_sits_under_the_apps_240s_cancel(self):
        # The client races every run against 240_000 ms (AppStore
        # raceCancelable). If the engine's bound met or exceeded that, the
        # client would always win and the engine could never report honestly.
        g = Gateway(env={"SCPRISM_PRIMARY": "claude-cli"})
        self.assertEqual(g.cli_timeout, gw.CLI_TIMEOUT_DEFAULT)
        self.assertEqual(g.cli_timeout, 180.0)
        self.assertLess(g.cli_timeout, 240.0)

    def test_env_override_is_respected(self):
        self.assertEqual(
            Gateway(env={"SCPRISM_CLI_TIMEOUT": "45"}).cli_timeout, 45.0
        )
        # Real os.environ, not just an injected dict.
        with mock.patch.dict(os.environ, {"SCPRISM_CLI_TIMEOUT": "37"}):
            self.assertEqual(Gateway().cli_timeout, 37.0)

    def test_garbage_override_falls_back_to_the_default(self):
        # A bad value must never DISABLE the bound (0 / negative / not a number).
        for bad in ("", "nonsense", "0", "-5", "nan"):
            self.assertEqual(
                Gateway(env={"SCPRISM_CLI_TIMEOUT": bad}).cli_timeout,
                gw.CLI_TIMEOUT_DEFAULT,
                bad,
            )

    def test_fast_cli_is_unaffected_and_byte_identical(self):
        # The 180s default is nowhere near this call; the answer is exactly what
        # the CLI printed, marked real, same as before the fix.
        with tempfile.TemporaryDirectory() as tmp:
            fake = os.path.join(tmp, "claude")
            with open(fake, "w", encoding="utf-8") as f:
                f.write("#!/bin/sh\necho 'hello from the fake CLI'\n")
            os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
            g = Gateway(env={"SCPRISM_PRIMARY": "claude-cli"})
            route = g.route("design a plan")
            started = time.monotonic()
            with mock.patch.object(gw, "_find_cli", return_value=fake):
                result = g.model_call(_messages(), route)
            elapsed = time.monotonic() - started
        self.assertTrue(result.is_real)
        self.assertEqual(result.text, "hello from the fake CLI")
        self.assertLess(elapsed, 10.0)
