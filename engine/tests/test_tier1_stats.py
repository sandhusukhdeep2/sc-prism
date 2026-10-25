"""Finding 4 — the Stats hero must come from MEASURED engine data.

`tier1_stats` distils the tier1 spans into the numbers the hero renders: how
many runs the deterministic gate ran on, how many it blocked (a "save": Tier-2
short-circuits, judge tokens never spent), which check caught them, and the one
measured basis for pricing a save (the average judge spend on runs that WERE
judged). No session store, no guesses.
"""

import unittest

import _bootstrap  # noqa: F401

from scprism_engine import observability as obs


def _tier1_span(
    run_id, *, passed, commands=(), failed=None, not_found=(), skipped=False,
    skipped_commands=(),
):
    attrs = {"passed": passed, "skipped": skipped, "tokens": 0, "commands": list(commands)}
    if skipped_commands:
        attrs["skipped_commands"] = list(skipped_commands)
    if failed is not None:
        attrs["failed_commands"] = list(failed)
        attrs["not_found"] = list(not_found)
    return {
        "run_id": run_id, "span_id": f"{run_id}-t1", "parent_id": run_id,
        "name": "tier1", "type": "tool_exec", "start": 1.0, "end": 1.1,
        "duration_ms": 100.0, "status": "ok" if passed else "error", "attrs": attrs,
    }


def _tier2_span(run_id, tokens):
    return {
        "run_id": run_id, "span_id": f"{run_id}-t2", "parent_id": run_id,
        "name": "tier2", "type": "verdict", "start": 2.0, "end": 2.1,
        "duration_ms": 100.0, "status": "ok",
        "attrs": {"score": 0.8, "eval_score": 0.8, "passed": True, "tokens": tokens},
    }


class Tier1StatsTests(unittest.TestCase):
    def test_empty_spans_are_zeros_that_say_nothing_ran(self):
        st = obs.tier1_stats([])
        self.assertEqual(st["runs"], 0)
        self.assertEqual(st["failed"], 0)
        self.assertEqual(st["judged_runs"], 0)
        self.assertEqual(st["avg_judge_tokens"], 0.0)

    def test_counts_passes_failures_and_skips_separately(self):
        spans = [
            _tier1_span("r1", passed=True, commands=["npm test"], failed=[]),
            _tier1_span("r2", passed=False, commands=["npm test"], failed=["npm test"]),
            _tier1_span("r3", passed=False, commands=["npm test"], failed=["npm test"]),
            _tier1_span("r4", passed=True, commands=[], failed=[], skipped=True),
        ]
        st = obs.tier1_stats(spans)
        self.assertEqual(st["runs"], 4)
        self.assertEqual(st["ran"], 3)
        self.assertEqual(st["passed"], 2)  # includes the skipped (nothing to disprove)
        self.assertEqual(st["skipped"], 1)
        self.assertEqual(st["failed"], 2)  # the saves

    def test_saves_are_attributed_to_the_check_that_caught_them(self):
        spans = [
            _tier1_span("r1", passed=False, commands=["npm test", "npm run lint"],
                        failed=["npm run lint"]),
            _tier1_span("r2", passed=False, commands=["npm test", "npm run build"],
                        failed=["npm test", "npm run build"]),
        ]
        st = obs.tier1_stats(spans)
        self.assertEqual(st["caught"]["lint"], 1)
        self.assertEqual(st["caught"]["tests"], 1)
        self.assertEqual(st["caught"]["build"], 1)
        self.assertEqual(st["caught"]["other"], 0)

    def test_old_spans_predating_not_found_are_claimed_as_neither(self):
        # The user's 51 recorded runs predate `not_found` entirely, so whether
        # the gate RAN on them is genuinely unknown. Counting them as saves is
        # what turned runs that verified nothing into a gold "53 saves · tests
        # caught 53" hero; counting them as unrunnable would be an equally
        # unmeasured claim. They get their own bucket and are attributed to
        # nothing.
        spans = [
            _tier1_span("r1", passed=False, commands=["npm test"], failed=None),
            _tier1_span("r2", passed=False, commands=["npm test", "npm run lint"], failed=None),
        ]
        st = obs.tier1_stats(spans)
        self.assertEqual(st["failed"], 2)
        self.assertEqual(st["unknown"], 2)
        self.assertEqual(st["blocked"], 0)
        self.assertEqual(st["not_found"], 0)
        self.assertEqual(sum(st["caught"].values()), 0)

    def test_a_missing_verify_command_is_counted_apart_from_a_real_failure(self):
        spans = [
            _tier1_span("r1", passed=False, commands=["npm test"], failed=["npm test"],
                        not_found=["npm test"]),
            _tier1_span("r2", passed=False, commands=["npm test"], failed=["npm test"]),
        ]
        st = obs.tier1_stats(spans)
        self.assertEqual(st["failed"], 2)
        self.assertEqual(st["not_found"], 1)
        # Only the run the gate actually RAN on is a save.
        self.assertEqual(st["blocked"], 1)
        self.assertEqual(st["caught"]["tests"], 1)

    def test_an_unrunnable_gate_catches_nothing(self):
        # THE cardinal-sin regression. Every one of these runs failed because
        # the gate could not run (no project directory / ENOENT). None of them
        # verified anything, so none is a save and none caught a test.
        spans = [
            _tier1_span(f"r{i}", passed=False, commands=["npm test"],
                        failed=["npm test"], not_found=["npm test"])
            for i in range(53)
        ]
        st = obs.tier1_stats(spans)
        self.assertEqual(st["failed"], 53)
        self.assertEqual(st["not_found"], 53)
        self.assertEqual(st["blocked"], 0, "an unrunnable gate blocks nothing")
        self.assertEqual(st["caught"]["tests"], 0, "an unrunnable gate catches nothing")
        self.assertEqual(sum(st["caught"].values()), 0)

    def test_a_run_with_nothing_to_verify_is_a_skip_not_a_save_or_an_error(self):
        # The chat-shaped run: the user HAS a verify command, this run just had
        # no project bound to point it at. Tier-1 is a project gate, so it
        # skipped — it did not run, did not block, did not fail, and must not
        # appear anywhere that implies otherwise.
        spans = [
            _tier1_span("r1", passed=True, commands=[], failed=[], skipped=True,
                        skipped_commands=["npm test"])
            for _ in range(40)
        ]
        spans.append(
            _tier1_span("r2", passed=False, commands=["npm test"], failed=["npm test"])
        )
        st = obs.tier1_stats(spans)
        self.assertEqual(st["runs"], 41)
        self.assertEqual(st["skipped"], 40)
        self.assertEqual(st["skipped_nothing_to_verify"], 40)
        self.assertEqual(st["skipped_no_commands"], 0)
        self.assertEqual(st["ran"], 1, "a skipped gate never counts as a checked run")
        self.assertEqual(st["blocked"], 1, "a skip is never a save")
        self.assertEqual(st["not_found"], 0, "a skip is not an unrunnable gate")
        self.assertEqual(st["unknown"], 0)
        self.assertEqual(st["failed"], 1)
        self.assertEqual(sum(st["caught"].values()), 1, "a skip catches nothing")

    def test_the_two_reasons_for_a_skip_are_counted_apart(self):
        # "You configured no verify command" vs "this run had no codebase to run
        # yours against". Merging them lets the hero tell a user who set
        # `npm test` that they set nothing.
        spans = [
            _tier1_span("r1", passed=True, skipped=True, skipped_commands=["npm test"]),
            _tier1_span("r2", passed=True, skipped=True),
        ]
        st = obs.tier1_stats(spans)
        self.assertEqual(st["skipped"], 2)
        self.assertEqual(st["skipped_nothing_to_verify"], 1)
        self.assertEqual(st["skipped_no_commands"], 1)

    def test_judge_spend_is_averaged_only_over_runs_that_were_judged(self):
        spans = [
            _tier1_span("r1", passed=True, commands=["npm test"], failed=[]),
            _tier2_span("r1", 300),
            _tier1_span("r2", passed=True, commands=["npm test"], failed=[]),
            _tier2_span("r2", 500),
            _tier1_span("r3", passed=False, commands=["npm test"], failed=["npm test"]),
        ]
        st = obs.tier1_stats(spans)
        self.assertEqual(st["judged_runs"], 2)
        self.assertEqual(st["avg_judge_tokens"], 400.0)

    def test_dashboard_exposes_the_block(self):
        import json
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as vault:
            with open(os.path.join(vault, "spans.jsonl"), "w", encoding="utf-8") as f:
                for s in [_tier1_span("r1", passed=False, commands=["npm test"],
                                      failed=["npm test"])]:
                    f.write(json.dumps(s) + "\n")
            d = obs.dashboard(vault)
        self.assertEqual(d["tier1"]["failed"], 1)
        self.assertEqual(d["tier1"]["blocked"], 1)
        self.assertEqual(d["tier1"]["caught"]["tests"], 1)


def _hook_span(name, *, status="ok", attrs=None, ms=10.0):
    return {
        "run_id": "r1", "span_id": f"r1-{name}", "parent_id": "r1",
        "name": name, "type": "hook", "start": 1.0, "end": 1.1,
        "duration_ms": ms, "status": status, "attrs": attrs or {},
    }


class HookStatsErrorVsOutcomeTests(unittest.TestCase):
    """A hook that FAILS A RUN is not a hook that broke (Finding 3b).

    Console badged a red "53 errors" over an enforcement layer that was working
    perfectly: a `stop` span's status=error records "compliance ratchet: FAIL —
    task not done", i.e. the ratchet ran and correctly refused to call an
    unfinished task done. Those are the same 53 events the Stats hero was
    miscounting as saves.
    """

    def test_a_failing_ratchet_outcome_is_not_a_hook_error(self):
        spans = [
            _hook_span("stop", status="error", attrs={"compliant": False, "reason": "not done"})
            for _ in range(53)
        ]
        st = obs.hook_stats(spans)
        self.assertEqual(st["stop"]["fires"], 53)
        self.assertEqual(st["stop"]["errors"], 0, "the ratchet working is not an error")
        self.assertEqual(st["stop"]["failed_outcomes"], 53)

    def test_a_hook_that_genuinely_threw_is_still_an_error(self):
        # No outcome attr at all: the hook did not reach a decision.
        st = obs.hook_stats([_hook_span("plan", status="error", attrs={})])
        self.assertEqual(st["plan"]["errors"], 1)
        self.assertEqual(st["plan"]["failed_outcomes"], 0)

    def test_a_compliant_run_is_neither(self):
        st = obs.hook_stats([_hook_span("stop", attrs={"compliant": True})])
        self.assertEqual(st["stop"]["errors"], 0)
        self.assertEqual(st["stop"]["failed_outcomes"], 0)

    def test_blocks_are_still_counted_independently(self):
        st = obs.hook_stats(
            [_hook_span("gate:write", status="error", attrs={"allowed": False})]
        )
        self.assertEqual(st["gate:write"]["blocks"], 1)
        self.assertEqual(st["gate:write"]["errors"], 1)


if __name__ == "__main__":
    unittest.main()
