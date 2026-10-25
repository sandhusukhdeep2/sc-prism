"""Conductor integration (E-Conductor, ADR-032).

The planner emits a deterministic Conductor-style workflow YAML per Task
Contract; execution stays deterministic. These tests pin the emitter/parser/
validator round-trip and the loop wiring.
"""

import copy
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.planner import plan
from scprism_engine.loop import run
from scprism_engine import conductor
from scprism_engine.conductor import (
    emit_workflow,
    build_workflow,
    parse_workflow,
    validate_workflow,
    dump_yaml,
    T_READ,
    T_WRITE,
    T_VERIFY,
    T_REPAIR,
    TIER1,
    TIER2,
    REPAIR,
)


class TestEmitAndStructure(unittest.TestCase):
    def test_workflow_emitted_from_contract(self):
        c = parse("add a rate-limit guard", task_id="t-emit")
        y = emit_workflow(c)
        self.assertIsInstance(y, str)
        wf = parse_workflow(y)
        self.assertEqual(wf["name"], "t-emit")
        self.assertEqual(wf["inputs"]["intent"], "add a rate-limit guard")
        self.assertEqual(wf["inputs"]["mode"], "write")
        self.assertIsInstance(wf["inputs"]["token_budget"], int)
        self.assertTrue(wf["tasks"])

    def test_roundtrip_through_parse_workflow(self):
        c = parse("add a rate-limit guard", task_id="t-round")
        y = emit_workflow(c)
        wf = parse_workflow(y)
        # Re-emitting the parsed dict yields byte-identical YAML (full fidelity).
        self.assertEqual(dump_yaml(wf), y)

    def test_contains_read_write_types_routes_and_edges(self):
        c = parse("add password hashing for customer login", task_id="t-types")
        wf = build_workflow(c, plan(c))
        by_name = {t["name"]: t for t in wf["tasks"]}

        types = {t["type"] for t in wf["tasks"]}
        self.assertIn(T_READ, types)
        self.assertIn(T_WRITE, types)
        self.assertIn(T_VERIFY, types)
        self.assertIn(T_REPAIR, types)

        # Every task has a valid route.
        for t in wf["tasks"]:
            self.assertIn(t["route"], ("local", "cloud"), t["name"])

        # Sensitive intent → every executable step stays local (matches planner).
        for t in wf["tasks"]:
            if t["type"] in (T_READ, T_WRITE):
                self.assertEqual(t["route"], "local", t["name"])

        # Verify/repair spine present with explicit edges.
        self.assertEqual(by_name[TIER1]["on_fail"], REPAIR)
        self.assertEqual(by_name[TIER1]["on_pass"], TIER2)
        self.assertEqual(by_name[TIER2]["on_fail"], REPAIR)
        self.assertIn(TIER1, by_name[TIER2]["deps"])  # Tier-1 gates Tier-2
        self.assertIn(REPAIR, by_name)
        self.assertEqual(by_name[REPAIR]["type"], T_REPAIR)

    def test_write_step_has_serial_deps(self):
        c = parse("add a rate-limit guard", task_id="t-serial")
        wf = build_workflow(c, plan(c))
        writes = [t for t in wf["tasks"] if t["type"] == T_WRITE]
        self.assertTrue(writes, "write-mode contract must emit a write task")
        # The write depends on the preceding read steps (its inputs).
        self.assertTrue(writes[0]["deps"], "write task must have deps")

    def test_emission_is_deterministic(self):
        c = parse("refactor the auth token exchange", task_id="t-det")
        a = emit_workflow(c, plan(c))
        b = emit_workflow(c, plan(c))
        self.assertEqual(a, b, "same contract -> identical YAML")

    def test_read_mode_contract_has_no_write_task(self):
        c = parse("analyze the request pipeline", task_id="t-readmode")
        wf = build_workflow(c, plan(c))
        self.assertEqual(c.mode, "read")
        self.assertFalse(any(t["type"] == T_WRITE for t in wf["tasks"]))
        self.assertTrue(validate_workflow(wf)["ok"])


class TestValidation(unittest.TestCase):
    def _good(self):
        c = parse("add a rate-limit guard", task_id="t-valid")
        return build_workflow(c, plan(c))

    def test_good_workflow_validates(self):
        self.assertEqual(validate_workflow(self._good()), {"ok": True, "issues": []})

    def test_missing_route_rejected(self):
        wf = self._good()
        del wf["tasks"][0]["route"]
        r = validate_workflow(wf)
        self.assertFalse(r["ok"])
        self.assertTrue(any("route" in i for i in r["issues"]))

    def test_missing_type_rejected(self):
        wf = self._good()
        wf["tasks"][0]["type"] = "bogus"
        r = validate_workflow(wf)
        self.assertFalse(r["ok"])
        self.assertTrue(any("type" in i for i in r["issues"]))

    def test_unknown_dep_rejected(self):
        wf = self._good()
        wf["tasks"][-1]["deps"] = ["does-not-exist"]
        self.assertFalse(validate_workflow(wf)["ok"])

    def test_missing_repair_edge_rejected(self):
        wf = self._good()
        by = {t["name"]: t for t in wf["tasks"]}
        del by[TIER1]["on_fail"]
        r = validate_workflow(wf)
        self.assertFalse(r["ok"])
        self.assertTrue(any("on_fail" in i for i in r["issues"]))

    def test_non_serial_writes_rejected(self):
        # Hand-build two writes where the second does NOT depend on the first.
        wf = {
            "name": "t-parallel-writes",
            "version": 1,
            "inputs": {},
            "tasks": [
                {"name": "w1", "type": T_WRITE, "route": "local", "deps": []},
                {"name": "w2", "type": T_WRITE, "route": "local", "deps": []},
                {"name": TIER1, "type": T_VERIFY, "route": "local",
                 "deps": ["w1", "w2"], "on_pass": TIER2, "on_fail": REPAIR},
                {"name": TIER2, "type": T_VERIFY, "route": "cloud",
                 "deps": [TIER1], "on_pass": "writeback", "on_fail": REPAIR},
                {"name": REPAIR, "type": T_REPAIR, "route": "local", "deps": []},
            ],
        }
        r = validate_workflow(wf)
        self.assertFalse(r["ok"])
        self.assertTrue(any("serial" in i for i in r["issues"]))
        # Adding the serial dep fixes it.
        wf["tasks"][1]["deps"] = ["w1"]
        self.assertTrue(validate_workflow(wf)["ok"])

    def test_cycle_in_deps_rejected(self):
        wf = self._good()
        by = {t["name"]: t for t in wf["tasks"]}
        # Create a real cycle between two read steps.
        step_names = [t["name"] for t in wf["tasks"] if t["type"] in (T_READ, T_WRITE)]
        a, b = step_names[0], step_names[1]
        by[a]["deps"] = [b]
        by[b]["deps"] = [a]
        r = validate_workflow(wf)
        self.assertFalse(r["ok"])
        self.assertTrue(any("cycle" in i for i in r["issues"]))

    def test_repair_retry_edge_is_not_a_cycle(self):
        # The repair `retry` back-edge points at the first step but is NOT a
        # dep, so the deps DAG stays acyclic and validation passes.
        wf = self._good()
        by = {t["name"]: t for t in wf["tasks"]}
        self.assertTrue(by[REPAIR]["retry"])  # back-edge exists
        self.assertTrue(validate_workflow(wf)["ok"])


class TestLoopWiring(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_default_loop_writes_no_workflow(self):
        c = parse("add a guard", task_id="t-default")
        verdict = run(c, vault=self.vault, tier1_commands=["true"])
        self.assertEqual(verdict.workflow_path, "")
        self.assertFalse(os.path.isdir(os.path.join(self.vault, "workflows")))
        self.assertNotIn("workflow", verdict.hooks_fired)

    def test_emit_workflow_persists_yaml_and_records_path(self):
        c = parse("add a rate-limit guard", task_id="t-wf")
        verdict = run(
            c, vault=self.vault, tier1_commands=["true"], emit_workflow=True
        )
        wf_path = os.path.join(self.vault, "workflows", "t-wf.yaml")
        self.assertEqual(verdict.workflow_path, wf_path)
        self.assertTrue(os.path.exists(wf_path), "workflow YAML persisted")
        self.assertIn("workflow", verdict.hooks_fired)

        # The persisted YAML parses and validates, and matches emit from the
        # SAME contract+plan (graph is consistent with what the loop executed).
        with open(wf_path, encoding="utf-8") as fh:
            y = fh.read()
        wf = parse_workflow(y)
        self.assertTrue(validate_workflow(wf)["ok"])
        self.assertEqual(y, emit_workflow(c, plan(c)))
        self.assertEqual(wf["name"], "t-wf")

    def test_workflow_written_before_execution(self):
        # If Tier-1 fails (task fails), the workflow must STILL exist — it is
        # emitted before anything runs (the diffable graph exists up front).
        c = parse("add a broken thing", task_id="t-wf-fail")
        verdict = run(
            c, vault=self.vault, tier1_commands=["exit 1"], emit_workflow=True
        )
        self.assertFalse(verdict.passed)
        self.assertTrue(
            os.path.exists(os.path.join(self.vault, "workflows", "t-wf-fail.yaml"))
        )
        self.assertTrue(verdict.workflow_path)


if __name__ == "__main__":
    unittest.main()
