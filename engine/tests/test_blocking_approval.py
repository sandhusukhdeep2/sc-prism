"""Mid-run blocking approval — engine layer (broker + gate wiring).

A held tool call can PAUSE the run and wait (bounded) for the user's Approve/Deny
via a vault-file handshake, then resume the SAME run. Invariants proven here:

  * OFF (``broker=None``) → byte-identical to today's held-then-continue.
  * The pause is REAL but BOUNDED — a fake ``sleep`` that advances a fake ``now``
    drives the timeout with NO real sleep; the loop can NEVER hang forever.
  * "deny"/"timeout" → the tool is truthfully NOT run (honest ``_held_result``);
    the inner source is only ever touched on "allow" (the security boundary).
  * The broker NEVER raises out: a write failure resolves to "timeout".
"""

import json
import os
import tempfile
import types
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.approval import (
    ApprovalGate,
    BlockingApprovalBroker,
    ToolApprovalPolicy,
    _held_result,
)
from scprism_engine.telemetry import Telemetry, read_spans


class FakeClock:
    """now()/monotonic()/sleep() with NO real time — ``sleep`` ADVANCES BOTH the
    wall (``now``) and monotonic clocks so a bounded poll loop terminates
    deterministically (drives the timeout in tests). The two clocks are SEPARATE
    so a test can step the WALL clock BACKWARD (NTP/manual) while monotonic keeps
    moving — proving the DEADLINE (measured on monotonic) is unaffected."""

    def __init__(self, t=1000.0):
        self.t = t  # wall clock (the human-readable ``"at"`` timestamp)
        self.m = t  # monotonic clock (the DEADLINE)

    def now(self):
        return self.t

    def monotonic(self):
        return self.m

    def sleep(self, dt):
        self.t += dt
        self.m += dt


class SpyInner:
    """Duck-typed inner tool source that RECORDS every call_tool — so a held /
    denied / timed-out call can be proven never to have reached the inner."""

    def __init__(self, telemetry=None, server_name="spy"):
        self.calls = []
        self.telemetry = telemetry
        self.server_name = server_name
        self.parent_span_id = None

    def list_tools(self):
        return []

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return {"content": [{"type": "text", "text": "ran:%s" % name}]}


class FakeBroker:
    """A deterministic broker returning a preset outcome — records the request it
    was asked to await, so the gate's build+await wiring is observable."""

    def __init__(self, outcome):
        self.outcome = outcome
        self.awaited = []

    def make_request(self, server, tool, arguments, run_id):
        return {
            "id": "fake-%d" % len(self.awaited),
            "server": server,
            "tool": tool,
            "run_id": run_id,
            "args_summary": "",
            "at": 0,
        }

    def await_decision(self, request):
        self.awaited.append(request)
        return self.outcome


def _write_decided(vault, request_id, obj):
    d = os.path.join(vault, "approvals", "decided")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "%s.json" % request_id)
    with open(path, "w", encoding="utf-8") as fh:
        if isinstance(obj, str):
            fh.write(obj)
        else:
            json.dump(obj, fh)
    return path


# --------------------------------------------------------------------------- #
#  BlockingApprovalBroker                                                      #
# --------------------------------------------------------------------------- #


class TestBlockingApprovalBroker(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _paths(self, request_id):
        pending = os.path.join(
            self.vault, "approvals", "pending", "%s.json" % request_id
        )
        decided = os.path.join(
            self.vault, "approvals", "decided", "%s.json" % request_id
        )
        return pending, decided

    def _broker(self, clock, timeout=10.0, poll=0.5):
        return BlockingApprovalBroker(
            self.vault,
            timeout=timeout,
            poll=poll,
            sleep=clock.sleep,
            now=clock.now,
            monotonic=clock.monotonic,
        )

    # -- make_request --------------------------------------------------

    def test_make_request_shape(self):
        clock = FakeClock()
        b = self._broker(clock)
        r1 = b.make_request("echo", "add", {"x": 1}, "run-1")
        r2 = b.make_request("echo", "add", {"x": 1}, "run-1")
        # Fresh unique uuid4 hex id each time.
        self.assertEqual(len(r1["id"]), 32)
        self.assertNotEqual(r1["id"], r2["id"])
        self.assertEqual(r1["run_id"], "run-1")
        self.assertEqual(r1["server"], "echo")
        self.assertEqual(r1["tool"], "add")
        self.assertIn('"x": 1', r1["args_summary"])

    def test_make_request_trims_args_summary(self):
        b = self._broker(FakeClock())
        r = b.make_request("s", "t", {"blob": "z" * 5000}, "")
        self.assertLessEqual(len(r["args_summary"]), 200)
        self.assertTrue(r["args_summary"].endswith("..."))
        self.assertEqual(r["run_id"], "")

    # -- await_decision: writes pending, returns outcomes --------------

    def test_writes_pending_file_with_request_during_wait(self):
        clock = FakeClock()
        b = self._broker(clock, timeout=10.0, poll=0.5)
        req = b.make_request("echo", "add", {"x": 1}, "run-1")
        pending, _ = self._paths(req["id"])
        captured = {}

        # A capturing "sleep": proves the pending file is present MID-WAIT (before
        # cleanup), then jumps the MONOTONIC clock past the bound so the loop ends
        # as "timeout" (the deadline is measured on monotonic, not wall clock).
        def capturing_sleep(dt):
            with open(pending, "r", encoding="utf-8") as fh:
                captured["req"] = json.load(fh)
            clock.m += 999.0

        b._sleep = capturing_sleep
        outcome = b.await_decision(req)

        self.assertEqual(outcome, "timeout")  # no decided file was ever written
        self.assertEqual(captured["req"]["id"], req["id"])
        self.assertEqual(captured["req"]["tool"], "add")
        self.assertEqual(captured["req"]["server"], "echo")
        # Cleaned up on the way out.
        self.assertFalse(os.path.exists(pending))

    def test_returns_allow(self):
        clock = FakeClock()
        b = self._broker(clock)
        req = b.make_request("s", "t", {}, "")
        _write_decided(self.vault, req["id"], {"decision": "allow"})
        self.assertEqual(b.await_decision(req), "allow")
        pending, decided = self._paths(req["id"])
        self.assertFalse(os.path.exists(pending))
        self.assertFalse(os.path.exists(decided))

    def test_returns_deny(self):
        clock = FakeClock()
        b = self._broker(clock)
        req = b.make_request("s", "t", {}, "")
        _write_decided(self.vault, req["id"], {"decision": "deny"})
        self.assertEqual(b.await_decision(req), "deny")

    def test_any_other_decision_value_is_deny(self):
        clock = FakeClock()
        b = self._broker(clock)
        req = b.make_request("s", "t", {}, "")
        _write_decided(self.vault, req["id"], {"decision": "maybe"})
        self.assertEqual(b.await_decision(req), "deny")

    def test_non_dict_decision_is_deny(self):
        clock = FakeClock()
        b = self._broker(clock)
        req = b.make_request("s", "t", {}, "")
        _write_decided(self.vault, req["id"], "\"allow\"")  # bare JSON string
        self.assertEqual(b.await_decision(req), "deny")

    def test_returns_timeout_after_the_bound_no_real_sleep(self):
        clock = FakeClock()
        # timeout 2.0, poll 0.5 → ~4 fake-sleep iterations then timeout.
        b = self._broker(clock, timeout=2.0, poll=0.5)
        req = b.make_request("s", "t", {}, "")
        self.assertEqual(b.await_decision(req), "timeout")
        pending, decided = self._paths(req["id"])
        self.assertFalse(os.path.exists(pending))
        self.assertFalse(os.path.exists(decided))

    def test_nonfinite_or_nonpositive_timeout_clamped_to_default(self):
        # --approval-timeout inf/nan/0/-5 would defeat the "can NEVER hang forever"
        # bound (inf → ``now - start < inf`` always true). Clamp to the 300s default.
        for bad in (float("inf"), float("nan"), 0, -5):
            b = BlockingApprovalBroker(self.vault, timeout=bad)
            self.assertEqual(b.timeout, 300.0)
        # A finite, positive timeout is preserved untouched.
        self.assertEqual(
            BlockingApprovalBroker(self.vault, timeout=42.0).timeout, 42.0
        )

    def test_backward_wall_clock_step_does_not_extend_bound(self):
        # The DEADLINE is measured on a MONOTONIC clock: a backward wall-clock step
        # (NTP / manual set) DURING the wait must NOT stretch the bound. Drive the
        # monotonic clock forward past timeout while the wall clock jumps BACKWARD
        # → still returns "timeout" regardless of what the wall clock does.
        clock = FakeClock()
        b = self._broker(clock, timeout=2.0, poll=0.5)
        req = b.make_request("s", "t", {}, "")

        def sleep_step_wall_backward(dt):
            clock.m += dt      # monotonic advances (drives the deadline)
            clock.t -= 100.0   # wall clock jumps BACKWARD each poll

        b._sleep = sleep_step_wall_backward
        self.assertEqual(b.await_decision(req), "timeout")
        pending, decided = self._paths(req["id"])
        self.assertFalse(os.path.exists(pending))
        self.assertFalse(os.path.exists(decided))

    def test_malformed_decided_file_never_raises(self):
        # A partial/garbage decided file is treated as not-yet-decided (a partial
        # write self-heals); a permanently-bad file → timeout, no raise.
        clock = FakeClock()
        b = self._broker(clock, timeout=2.0, poll=0.5)
        req = b.make_request("s", "t", {}, "")
        _write_decided(self.vault, req["id"], "{ not json")
        self.assertEqual(b.await_decision(req), "timeout")

    def test_write_failure_returns_timeout_no_raise(self):
        # Vault path is a FILE → makedirs raises → honest "timeout", never raises.
        bad = os.path.join(self.vault, "not-a-dir")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("x")
        clock = FakeClock()
        b = BlockingApprovalBroker(
            bad, timeout=10.0, poll=0.5, sleep=clock.sleep, now=clock.now
        )
        req = b.make_request("s", "t", {}, "")
        self.assertEqual(b.await_decision(req), "timeout")

    def test_missing_id_returns_timeout(self):
        clock = FakeClock()
        b = self._broker(clock)
        self.assertEqual(b.await_decision({}), "timeout")

    def test_pending_file_written_atomically_no_tmp_leftover(self):
        clock = FakeClock()
        b = self._broker(clock)
        req = b.make_request("s", "t", {}, "")
        _write_decided(self.vault, req["id"], {"decision": "allow"})
        b.await_decision(req)
        # No stray *.tmp files left in the pending dir.
        pending_dir = os.path.join(self.vault, "approvals", "pending")
        leftovers = [f for f in os.listdir(pending_dir) if f.endswith(".tmp")]
        self.assertEqual(leftovers, [])


# --------------------------------------------------------------------------- #
#  ApprovalGate blocking path                                                 #
# --------------------------------------------------------------------------- #


class TestApprovalGateBlocking(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        self.spans = os.path.join(self.vault, "spans.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def _await_spans(self):
        if not os.path.exists(self.spans):
            return []
        return [
            s
            for s in read_spans(self.spans)
            if s["type"] == "tool_exec" and s["attrs"].get("awaiting") is True
        ]

    def _held_only_spans(self):
        if not os.path.exists(self.spans):
            return []
        return [
            s
            for s in read_spans(self.spans)
            if s["type"] == "tool_exec"
            and s["attrs"].get("held") is True
            and s["attrs"].get("awaiting") is not True
        ]

    def test_broker_none_is_byte_identical_held_path(self):
        # OFF: the held call never reaches the inner, the honest held_result is
        # returned, and a held (NOT awaiting) span lands — today's behavior.
        tel = Telemetry(self.spans)
        inner = SpyInner(telemetry=tel)
        gate = ApprovalGate(inner, ToolApprovalPolicy(require={"secret"}))
        gate.parent_span_id = "P1"

        res = gate.call_tool("secret", {"x": 1})

        self.assertEqual(inner.calls, [])
        self.assertEqual(res, _held_result("secret"))
        self.assertEqual(self._await_spans(), [])  # NO awaiting span when off
        held = self._held_only_spans()
        self.assertTrue(held)
        self.assertEqual(held[0]["attrs"]["tool"], "secret")

    def test_allow_delegates_to_inner_and_emits_spans(self):
        tel = Telemetry(self.spans)
        inner = SpyInner(telemetry=tel)
        broker = FakeBroker("allow")
        gate = ApprovalGate(inner, ToolApprovalPolicy(require={"secret"}), broker=broker)

        res = gate.call_tool("secret", {"x": 1})

        # The tool ACTUALLY ran (inner invoked) once approved.
        self.assertEqual(inner.calls, [("secret", {"x": 1})])
        self.assertEqual(res["content"][0]["text"], "ran:secret")
        self.assertEqual(len(broker.awaited), 1)
        # Two awaiting spans: the start (no resolved) + the resolved="allow".
        aw = self._await_spans()
        self.assertEqual(len(aw), 2)
        starts = [s for s in aw if "resolved" not in s["attrs"]]
        resolved = [s for s in aw if s["attrs"].get("resolved") == "allow"]
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(resolved), 1)

    def test_deny_never_runs_inner_and_returns_held(self):
        tel = Telemetry(self.spans)
        inner = SpyInner(telemetry=tel)
        broker = FakeBroker("deny")
        gate = ApprovalGate(inner, ToolApprovalPolicy(require={"secret"}), broker=broker)

        res = gate.call_tool("secret", {"x": 1})

        self.assertEqual(inner.calls, [])  # NEVER egressed
        self.assertEqual(res, _held_result("secret"))
        resolved = [
            s for s in self._await_spans() if s["attrs"].get("resolved") == "deny"
        ]
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0]["status"], "error")

    def test_timeout_never_runs_inner_and_returns_held(self):
        tel = Telemetry(self.spans)
        inner = SpyInner(telemetry=tel)
        broker = FakeBroker("timeout")
        gate = ApprovalGate(inner, ToolApprovalPolicy(require={"secret"}), broker=broker)

        res = gate.call_tool("secret", {"x": 1})

        self.assertEqual(inner.calls, [])
        self.assertEqual(res, _held_result("secret"))
        resolved = [
            s for s in self._await_spans() if s["attrs"].get("resolved") == "timeout"
        ]
        self.assertEqual(len(resolved), 1)

    def test_allowed_call_never_touches_broker(self):
        # A non-held (allowed) call must not consult the broker at all.
        inner = SpyInner()
        broker = FakeBroker("deny")
        gate = ApprovalGate(inner, ToolApprovalPolicy(require={"secret"}), broker=broker)
        res = gate.call_tool("other", {"q": 1})
        self.assertEqual(inner.calls, [("other", {"q": 1})])
        self.assertEqual(broker.awaited, [])
        self.assertEqual(res["content"][0]["text"], "ran:other")

    def test_integration_real_broker_preplaced_allow_runs_inner(self):
        # End-to-end with the REAL broker: a pre-placed decided "allow" resolves
        # the pause and the inner tool runs. Uses an injected clock (no real sleep
        # needed since the decision is found on the first poll).
        tel = Telemetry(self.spans)
        inner = SpyInner(telemetry=tel)
        clock = FakeClock()
        broker = BlockingApprovalBroker(
            self.vault,
            timeout=10.0,
            poll=0.5,
            sleep=clock.sleep,
            now=clock.now,
            monotonic=clock.monotonic,
        )
        gate = ApprovalGate(inner, ToolApprovalPolicy(require={"secret"}), broker=broker)

        # Pre-mint the id the gate will use? The gate mints its own request via
        # broker.make_request. Instead, drive it by pre-placing on the FIRST poll:
        # a sleep hook that writes the decided file, so the next poll finds allow.
        state = {"req_id": None}
        orig_make = broker.make_request

        def make_and_capture(server, tool, arguments, run_id):
            r = orig_make(server, tool, arguments, run_id)
            state["req_id"] = r["id"]
            return r

        broker.make_request = make_and_capture

        def sleep_then_approve(dt):
            _write_decided(self.vault, state["req_id"], {"decision": "allow"})

        broker._sleep = sleep_then_approve

        res = gate.call_tool("secret", {"x": 9})
        self.assertEqual(inner.calls, [("secret", {"x": 9})])
        self.assertEqual(res["content"][0]["text"], "ran:secret")


# --------------------------------------------------------------------------- #
#  CLI wiring: _apply_approval_gate                                           #
# --------------------------------------------------------------------------- #


class TestBlockingCLIWiring(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _args(self, **kw):
        base = dict(
            vault=self.vault,
            require_approval=["all"],
            approve=None,
            approval_blocking=False,
            approval_timeout=300.0,
        )
        base.update(kw)
        return types.SimpleNamespace(**base)

    def test_flag_builds_broker_with_timeout(self):
        from scprism_engine.__main__ import _apply_approval_gate

        inner = SpyInner()
        source, ok = _apply_approval_gate(
            self._args(approval_blocking=True, approval_timeout=42.0), inner
        )
        self.assertTrue(ok)
        self.assertIsInstance(source, ApprovalGate)
        self.assertIsInstance(source.broker, BlockingApprovalBroker)
        self.assertEqual(source.broker.timeout, 42.0)
        self.assertEqual(source.broker.vault, self.vault)

    def test_absent_flag_is_byte_identical_no_broker(self):
        from scprism_engine.__main__ import _apply_approval_gate

        inner = SpyInner()
        source, ok = _apply_approval_gate(self._args(approval_blocking=False), inner)
        self.assertTrue(ok)
        self.assertIsInstance(source, ApprovalGate)
        self.assertIsNone(source.broker)

    def test_blocking_with_inactive_policy_is_a_noop(self):
        # No active policy → no gate at all, even with --approval-blocking. The
        # source passes through untouched (byte-identical, nothing ever held).
        from scprism_engine.__main__ import _apply_approval_gate

        inner = SpyInner()
        source, ok = _apply_approval_gate(
            self._args(require_approval=None, approval_blocking=True), inner
        )
        self.assertTrue(ok)
        self.assertIs(source, inner)


if __name__ == "__main__":
    unittest.main()
