"""A run the model never answered is not a pass (2026-11-08).

Found in the user's own vault. Three scheduled manager jobs ran while the
local server rejected every call (401 — see localkey_test.go). Each run's only
"answers" were the gateway's offline stand-ins, ``[offline:local:…] handled: …``.
The loop kept the stand-in as the response, Tier-1 was skipped (nothing to
verify), the Tier-2 judge call was ALSO a stand-in so the heuristic scored the
trace 0.9625, and ``build_verdict`` — which only looked at tier1 ∧ tier2 ∧
governance — filed each run as ``passed`` and emitted a training record.
In that vault 111 of 200 "passed" verdicts and 58% of all training records
were runs like this.

The interface already refused them (``isRealCompletion`` gates ``[offline:``
out on the client). The engine must refuse them too: a verdict can only be a
pass if the model actually answered.
"""
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401
from _fakes import RealGateway

from scprism_engine.contract import parse
from scprism_engine.gateway import Gateway
from scprism_engine.loop import run
from scprism_engine.training import read_records


def _offline_gateway():
    # No provider reachable, no key: every call is the deterministic stand-in.
    return Gateway(openai_base_url="http://127.0.0.1:9", env={}, timeout=0.2)


class TestStandInIsNotAPass(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_a_run_answered_only_by_stand_ins_is_failed(self):
        contract = parse("summarise the new notes", task_id="t-standin")
        v = run(contract, vault=self.vault, gateway=_offline_gateway(), tier1_commands=["true"])

        # The record keeps saying what happened …
        self.assertTrue(v.response.lstrip().startswith("[offline:"), v.response[:80])
        self.assertTrue(v.tier1["passed"], "the deterministic checks themselves did run and pass")
        # … and the verdict says what that is worth: nothing.
        self.assertFalse(v.passed, "a stand-in is not a completion")
        self.assertEqual(v.outcome, "failed")
        self.assertIn("never answered", v.outcome_reason)

    def test_a_run_the_model_never_answered_trains_nothing(self):
        contract = parse("summarise the new notes", task_id="t-standin-train")
        run(contract, vault=self.vault, gateway=_offline_gateway(), tier1_commands=["true"])
        self.assertEqual(read_records(self.vault), [], "no verified outcome, no training record")

    def test_a_run_the_model_did_answer_still_passes_and_trains(self):
        # The fix must not over-fail: a real completion with green checks is a pass.
        contract = parse("summarise the new notes", task_id="t-real")
        v = run(contract, vault=self.vault, gateway=RealGateway(), tier1_commands=["true"])
        self.assertFalse(v.response.lstrip().startswith("[offline:"))
        self.assertTrue(v.passed)
        self.assertEqual(v.outcome, "passed")
        self.assertEqual(len(read_records(self.vault)), 1)


if __name__ == "__main__":
    unittest.main()
