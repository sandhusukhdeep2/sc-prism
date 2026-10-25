"""Governance wired into the loop — enforcement is the audit spine (E3a).

Proves the acceptance criteria end-to-end: a destructive command is blocked
pre-exec, an out-of-scope path is denied, an irreversible action needs a
recorded approval, the Stop ratchet runs once, a secret in tool output is
caught, and every decision lands in the Verdict + spans.
"""

import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run
from scprism_engine.gateway import Gateway
from scprism_engine.telemetry import read_spans
from scprism_engine.hooks import ToolRequest, Approval, now_iso


def _offline_gateway():
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


class TestGovernanceLoop(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, task_id, **kw):
        contract = parse("add a rate-limit guard", task_id=task_id, scope=["engine/**"])
        return run(
            contract, vault=self.vault, tier1_commands=["true"],
            gateway=_offline_gateway(), **kw,
        )

    def _load(self, task_id):
        with open(os.path.join(self.vault, "verdicts", f"{task_id}.json")) as fh:
            return json.load(fh)

    def test_destructive_command_blocked_pre_exec_and_recorded(self):
        reqs = [ToolRequest(tool="bash", action="execute", command="rm -rf /")]
        v = self._run("t-destroy", tool_requests=reqs)
        self.assertTrue(v.blocks, "a block must be recorded")
        self.assertFalse(v.passed, "a blocked run cannot pass")
        block = v.blocks[0]
        self.assertEqual(block["hook"], "PreToolUse")
        self.assertEqual(block["exit_code"], 2)
        # Persisted to the Verdict evidence.
        data = self._load("t-destroy")
        self.assertTrue(data["blocks"])
        self.assertTrue(data["hook_decisions"])

    def test_destructive_blocked_every_phrasing(self):
        for i, cmd in enumerate([
            "rm -rf /", "oops; rm -rf /var", "RM -RF ./x", "rm  -r  -f  /data",
        ]):
            v = self._run(
                f"t-phr-{i}",
                tool_requests=[ToolRequest(tool="bash", command=cmd)],
            )
            self.assertTrue(v.blocks, f"must block phrasing: {cmd!r}")

    def test_out_of_scope_path_denied_with_reason(self):
        reqs = [ToolRequest(tool="write_file", action="write", path="src/app.py",
                            content="x = 1")]
        v = self._run("t-scope", tool_requests=reqs)
        self.assertTrue(v.blocks)
        block = next(b for b in v.blocks if b["hook"] == "PermissionCheck")
        self.assertIn("outside declared scope", block["reason"])

    def test_irreversible_without_approval_blocked(self):
        reqs = [ToolRequest(tool="write_rule", action="write_rule",
                            path="engine/rules.md", content="new rule")]
        v = self._run("t-noappr", tool_requests=reqs, role="admin")
        self.assertTrue(v.blocks)
        self.assertTrue(any("approval" in b["reason"].lower() for b in v.blocks))
        self.assertFalse(v.approvals)

    def test_irreversible_with_approval_proceeds_and_records(self):
        req = ToolRequest(tool="write_rule", action="write_rule",
                          path="engine/rules.md", content="new rule")
        appr = Approval(action="write_rule", target="engine/rules.md",
                        approver="founder", granted_at=now_iso(), approval_id="ap-9")
        v = self._run("t-appr", tool_requests=[req], approvals=[appr], role="admin")
        # No blocks; the approval is recorded in the evidence layer.
        self.assertFalse(v.blocks, f"unexpected blocks: {v.blocks}")
        self.assertTrue(v.approvals)
        self.assertEqual(v.approvals[0]["approver"], "founder")
        data = self._load("t-appr")
        self.assertEqual(data["approvals"][0]["approval_id"], "ap-9")

    def test_stop_ratchet_runs_exactly_once(self):
        v = self._run("t-stop", tool_requests=[])
        stop_names = [h for h in v.hooks_fired if h == "stop"]
        self.assertEqual(len(stop_names), 1, "stop hook fires exactly once")
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        stop_spans = [s for s in spans if s["name"] == "stop"]
        self.assertEqual(len(stop_spans), 1)
        self.assertEqual(stop_spans[0]["attrs"]["ratchet_runs"], 1)

    def test_secret_in_tool_output_caught(self):
        req = ToolRequest(tool="bash", action="execute", command="printenv",
                          output="OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz012345")
        v = self._run("t-secret", tool_requests=[req])
        self.assertTrue(v.blocks)
        self.assertTrue(any(b["hook"] == "PostToolUse" for b in v.blocks))

    def test_hooks_and_decisions_land_in_verdict_and_spans(self):
        req = ToolRequest(tool="write_file", action="write", path="engine/x.py",
                          content="x = 1", output="wrote 1 line")
        v = self._run("t-audit", tool_requests=[req])
        # Verdict evidence spine.
        self.assertIn("stop", v.hooks_fired)
        self.assertIn("pre_tool_use", v.hooks_fired)
        self.assertIn("permission_check", v.hooks_fired)
        self.assertIn("post_tool_use", v.hooks_fired)
        self.assertTrue(v.hook_decisions)
        self.assertFalse(v.blocks)
        self.assertTrue(v.passed)
        # Spans: a per-tool gate hook span exists.
        spans = read_spans(os.path.join(self.vault, "spans.jsonl"))
        self.assertTrue(any(s["name"].startswith("gate:") for s in spans))

    def test_clean_run_without_tool_requests_still_passes(self):
        # Back-compat: no tool_requests -> no governance blocks, task passes,
        # stop ratchet still runs once.
        v = self._run("t-clean")
        self.assertTrue(v.passed)
        self.assertFalse(v.blocks)
        self.assertEqual(len([h for h in v.hooks_fired if h == "stop"]), 1)


if __name__ == "__main__":
    unittest.main()
