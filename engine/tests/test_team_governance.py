"""Governed `run_team` — contract, spans, budget, Tier-1/2, Verdict, evidence,
training (TG-2). Offline + an injected fake model so token counts and outputs
are exact and deterministic (no real network call, mirroring
`test_project_runner.py`'s `make_fake_model` idiom and `test_team.py`'s
offline-CLI pattern).
"""

import json
import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine import gateway as gw_module
from scprism_engine.gateway import ModelCallResult
from scprism_engine.evidence import EvidenceStore
from scprism_engine.team import AgentSpec, TeamResult, run_team


def make_fake_model(tokens_per_call=40):
    """A `(messages, route) -> ModelCallResult` double: fixed, deterministic
    token cost per call, real text so Tier-2's heuristic scorer sees non-empty,
    error-free output. Mirrors `gateway.Gateway.model_call`'s exact return
    shape so `run_team` cannot tell it apart from a real call."""
    counter = {"n": 0}

    def _call(messages, route):
        counter["n"] += 1
        text = f"contribution #{counter['n']} from {route.provider}: all good here."
        tin = tokens_per_call // 2
        tout = tokens_per_call - tin
        return ModelCallResult(
            text=text,
            tokens_in=tin,
            tokens_out=tout,
            cache="miss",
            provider=route.provider,
            model=route.model,
            is_real=True,
        )

    return _call


# Every agent primary is a KEYLESS cloud provider (openai/gemini) with no key
# in `env` — the gateway's `model_call` goes straight to its offline stub with
# NO network attempt at all (`route.is_local=False and not route.api_key` ->
# `_stub` immediately), so even the Tier-2 judge call (which always goes
# through the LEAD's real gateway, never the injected `model`) is instant and
# deterministic. `_find_cli` is patched too, belt-and-suspenders like
# `test_team.py`.
def _agents():
    return [
        AgentSpec("lead", "Lead and synthesize.", "openai"),
        AgentSpec("researcher", "Research.", "gemini"),
        AgentSpec("critic", "Criticize.", "openai"),
    ]


class RunTeamGovernanceTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name
        self._cli_patch = mock.patch.object(gw_module, "_find_cli", return_value=None)
        self._cli_patch.start()

    def tearDown(self):
        self._cli_patch.stop()
        self._tmp.cleanup()

    def _run(self, intent="draft a launch summary for the team", **kwargs):
        return run_team(
            intent,
            self.vault,
            _agents(),
            env={"PATH": "/nonexistent"},
            model=make_fake_model(),
            **kwargs,
        )

    # -- (a) normal-budget run: contract, spans, verdict, evidence, training --

    def test_normal_run_is_fully_governed(self):
        result = self._run()

        # A contract was built (read-mode) and its task_id is threaded through.
        self.assertTrue(result.task_id)
        self.assertEqual(result.run_id, result.task_id)

        # Spans were emitted, including a `run:` span keyed on the task_id.
        spans_path = os.path.join(self.vault, "spans.jsonl")
        self.assertEqual(result.spans_path, spans_path)
        self.assertTrue(os.path.exists(spans_path))
        with open(spans_path, encoding="utf-8") as fh:
            spans = [json.loads(ln) for ln in fh if ln.strip()]
        self.assertTrue(spans, "spans.jsonl must be non-empty")
        run_spans = [
            s for s in spans
            if s.get("type") == "run" and s.get("attrs", {}).get("task_id") == result.task_id
        ]
        self.assertEqual(len(run_spans), 1)
        self.assertEqual(run_spans[0]["name"], f"run:{result.task_id}")
        model_call_spans = [s for s in spans if s.get("type") == "model_call"]
        # 3 agents * 1 round + 1 synthesis = 4 team model_call spans, plus the
        # Tier-2 judge's own real call (named "eval", also span_type
        # "model_call" — evals.evaluate's own instrumentation) = 5.
        self.assertEqual(len(model_call_spans), 5)
        team_spans = [s for s in model_call_spans if s.get("name") == "model_call"]
        self.assertEqual(len(team_spans), 4)
        self.assertEqual(
            len([s for s in model_call_spans if s.get("name") == "eval"]), 1
        )

        # Not over budget; a real Verdict was built and it passed.
        self.assertFalse(result.over_budget)
        self.assertTrue(result.passed)
        self.assertTrue(result.reason)

        # A Verdict was written to <vault>/verdicts/<task_id>.json.
        verdict_path = os.path.join(self.vault, "verdicts", f"{result.task_id}.json")
        self.assertTrue(os.path.exists(verdict_path))
        with open(verdict_path, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertEqual(on_disk["task_id"], result.task_id)
        self.assertTrue(on_disk["passed"])
        # Tier-1 is a recorded, honest, ADVISORY pass — not fail-closed.
        self.assertTrue(on_disk["tier1"]["passed"])
        self.assertTrue(on_disk["tier2"]["ran"])

        # Evidence was appended AFTER the run span closed, chain intact.
        report = EvidenceStore(self.vault).verify_chain()
        self.assertTrue(report.ok, report.reason)
        self.assertEqual(report.length, 1)

        # A training record was emitted for the passing run.
        records_path = os.path.join(self.vault, "training", "records.jsonl")
        self.assertTrue(os.path.exists(records_path))
        with open(records_path, encoding="utf-8") as fh:
            records = [json.loads(ln) for ln in fh if ln.strip()]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["task_id"], result.task_id)
        self.assertTrue(records[0]["final_verdict"]["passed"])

        # The board file is still written exactly once (unchanged mechanics).
        self.assertTrue(os.path.isfile(result.board_path))
        self.assertEqual(len(result.board), 3)
        self.assertTrue(result.synthesis)

    # -- (b) tiny budget: stops early, over_budget, fails, no training -------

    def test_tiny_budget_stops_early_and_fails_with_no_training(self):
        result = self._run(token_budget=50)

        self.assertTrue(result.over_budget)
        self.assertFalse(result.passed)
        self.assertEqual(result.token_budget, 50)
        self.assertIn("budget", result.reason.lower())

        # Stopped early: fewer than the full 3 agent messages were recorded.
        self.assertLess(len(result.board), 3)

        # Tier-1 is STILL an honest recorded pass (advisory, never fail-closed)
        # even though the overall Verdict fails on the forced envelope breach.
        verdict_path = os.path.join(self.vault, "verdicts", f"{result.task_id}.json")
        self.assertTrue(os.path.exists(verdict_path))
        with open(verdict_path, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertTrue(on_disk["tier1"]["passed"])
        self.assertFalse(on_disk["passed"])

        # No training record on an over-budget (non-compliant) run.
        records_path = os.path.join(self.vault, "training", "records.jsonl")
        emitted = os.path.exists(records_path) and any(
            ln.strip() for ln in open(records_path, encoding="utf-8")
        )
        self.assertFalse(emitted, "an over-budget run must emit no training record")

        # Evidence is still appended (best-effort) even for a failing run.
        report = EvidenceStore(self.vault).verify_chain()
        self.assertTrue(report.ok, report.reason)

    # -- (c) synthetic Tier-1 is a recorded pass in both cases ---------------

    def test_tier1_is_synthetic_advisory_pass_never_fail_closed(self):
        passing = self._run()
        over = self._run(intent="draft another summary", token_budget=1)

        for result in (passing, over):
            verdict_path = os.path.join(self.vault, "verdicts", f"{result.task_id}.json")
            with open(verdict_path, encoding="utf-8") as fh:
                on_disk = json.load(fh)
            self.assertTrue(on_disk["tier1"]["passed"])
            self.assertEqual(on_disk["tier1"]["commands"], [])

    # -- (d) TeamResult.to_dict() carries all new keys -----------------------

    def test_to_dict_carries_governance_keys(self):
        result = self._run()
        d = result.to_dict()
        for key in (
            "run_id", "board", "synthesis", "board_path", "tokens",
            "passed", "over_budget", "token_budget", "reason", "task_id",
            "spans_path", "verdict_path",
        ):
            self.assertIn(key, d)
        self.assertEqual(d["task_id"], result.task_id)
        self.assertEqual(d["passed"], result.passed)
        self.assertEqual(d["over_budget"], result.over_budget)

    def test_to_dict_carries_verdict_path_and_the_file_exists(self):
        # The spec's verdict line names "a link to the saved Verdict" — the
        # client needs the actual on-disk path, not just the boolean passed.
        result = self._run()
        d = result.to_dict()
        self.assertIn("verdict_path", d)
        self.assertEqual(result.verdict_path, d["verdict_path"])
        expected = os.path.join(self.vault, "verdicts", f"{result.task_id}.json")
        self.assertEqual(result.verdict_path, expected)
        self.assertTrue(os.path.isfile(result.verdict_path))

    def test_default_team_result_fields(self):
        # Defaults, independent of run_team, per the interface spec.
        r = TeamResult(run_id="x")
        self.assertFalse(r.passed)
        self.assertFalse(r.over_budget)
        self.assertEqual(r.token_budget, 0)
        self.assertEqual(r.reason, "")
        self.assertEqual(r.task_id, "")
        self.assertEqual(r.spans_path, "")
        self.assertEqual(r.verdict_path, "")

    # -- (d2) a NEGATIVE token_budget must not sneak past `or` truthiness ----

    def test_negative_token_budget_behaves_exactly_like_default(self):
        """`token_budget or contract.token_budget` treats -5 as truthy, so a
        negative budget used to flow straight through as `budget=-5`: the
        very first `result.tokens (0) >= budget (-5)` check fires
        `over_budget=True` at zero spend, before any agent ever speaks — an
        invariant hole (the forced-breach envelope `Envelope(token_budget=0)`
        then does NOT actually breach at 0 spent, since `0 > 0` is False, so
        pass/fail silently falls back to the judge alone). A negative budget
        must be treated exactly like 0 (the contract default), never as a
        literal negative cap."""
        negative = self._run(token_budget=-5)
        default = self._run(intent="draft another launch summary")

        self.assertEqual(negative.token_budget, default.token_budget)
        self.assertFalse(negative.over_budget)
        self.assertTrue(negative.passed)
        self.assertEqual(len(negative.board), 3)

    # -- (e) the Tier-2 envelope + training record use the REAL budget -------

    def test_under_a_nondefault_budget_passes_and_reports_real_budget(self):
        # 3 agents * 1 round + 1 synthesis = 4 calls * 40 tok = 160 tokens,
        # well UNDER a 5000 budget. The envelope must be built from 5000 (not
        # the parse-time default 100000), so there is NO token breach; and the
        # persisted verdict + training record must report 5000, not 100000.
        budget = 5000
        result = self._run(token_budget=budget)

        self.assertFalse(result.over_budget)
        self.assertTrue(result.passed)
        self.assertEqual(result.token_budget, budget)
        # A healthy under-budget run's reason carries no envelope breach.
        self.assertNotIn("breach", result.reason.lower())
        self.assertNotIn("token_budget:", result.reason)

        # The persisted Verdict's Tier-2 envelope reflects the REAL budget.
        verdict_path = os.path.join(self.vault, "verdicts", f"{result.task_id}.json")
        with open(verdict_path, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertTrue(on_disk["passed"])
        self.assertEqual(on_disk["tier2"]["envelope"]["token_budget"], budget)
        self.assertEqual(on_disk["tier2"]["breaches"], [])

        # The training record's inputs + reward read the REAL budget too.
        records_path = os.path.join(self.vault, "training", "records.jsonl")
        with open(records_path, encoding="utf-8") as fh:
            records = [json.loads(ln) for ln in fh if ln.strip()]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["inputs"]["token_budget"], budget)
        # envelope_efficiency = (budget - tokens_spent)/budget, computed off
        # the REAL 5000 budget (the record's own tokens_spent folds in the
        # Tier-2 judge's tokens, exactly as the verdict does) — NOT the ~0.998
        # the hardcoded 100000 default would have produced.
        rec_tokens = records[0]["tokens_spent"]
        eff = records[0]["reward"]["envelope_efficiency"]
        self.assertAlmostEqual(eff, (budget - rec_tokens) / budget, places=4)
        # Guard against the default-100000 regression: efficiency off 5000 is
        # visibly lower than off 100000 would be for the same spend.
        self.assertLess(eff, (100000 - rec_tokens) / 100000)

    def test_more_steps_than_default_max_turns_still_passes(self):
        # 3 rounds * 3 agents = 9 board messages > the parse-time default
        # max_turns of 8. The envelope's max_steps must reflect the REAL step
        # count (rounds*agents+1), so a healthy, above-threshold, under-budget
        # run is NOT spuriously failed with "max_steps: 9 > 8".
        result = self._run(rounds=3)

        self.assertEqual(len(result.board), 9)
        self.assertFalse(result.over_budget)
        self.assertTrue(result.passed, result.reason)
        self.assertNotIn("max_steps", result.reason)

        verdict_path = os.path.join(self.vault, "verdicts", f"{result.task_id}.json")
        with open(verdict_path, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertTrue(on_disk["passed"])
        self.assertEqual(on_disk["tier2"]["breaches"], [])
        # The observed step count cleared the (raised) cap.
        self.assertGreaterEqual(
            on_disk["tier2"]["envelope"]["max_steps"], on_disk["tier2"]["observed"]["steps"]
        )


if __name__ == "__main__":
    unittest.main()


class ConverseTeamTest(unittest.TestCase):
    """A conversational TEAM run is judged as a conversation (2026-08-29).

    Live example: 'Two sentences each seat: the one habit that makes a small
    team ship faster' produced a genuinely good synthesis (the critic's
    feedback visibly revised the lead's answer) yet scored ~0.275 under the
    read frame and FAILED. Solo chat got mode 'converse' + outcome 'replied'
    (bc6c193); the board deserves the same honesty. Build teams unchanged.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, **kwargs):
        return run_team(
            "what single habit makes a small team ship faster?",
            self.vault,
            _agents(),
            env={"PATH": "/nonexistent"},
            model=make_fake_model(),
            **kwargs,
        )

    def test_converse_team_verdict_lands_as_replied(self):
        result = self._run(mode="converse")
        verdict_path = os.path.join(self.vault, "verdicts", f"{result.task_id}.json")
        with open(verdict_path, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertEqual(on_disk["outcome"], "replied")
        self.assertTrue(on_disk["passed"])
        self.assertTrue(result.passed)

    def test_default_team_keeps_read_mode_byte_identical(self):
        result = self._run()
        verdict_path = os.path.join(self.vault, "verdicts", f"{result.task_id}.json")
        with open(verdict_path, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertIn(on_disk["outcome"], ("passed", "attention", "failed"))
