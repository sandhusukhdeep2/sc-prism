"""Spend counts real completions only (2026-11-08, design step C).

A stand-in's ``tokens_in`` is an ESTIMATE of a prompt that bought nothing —
the server refused it, or nothing listened. Counting it as local "work" put a
refused 401 into the local share and the cost ledger. Spans with no ``is_real``
key (older engine) are kept: we do not guess.
"""
import json
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine import observability as obs


def span(provider, tin, tout, start, **attrs):
    a = {"provider": provider, "model": "m", "tokens_in": tin, "tokens_out": tout, "operation": "dispatch", **attrs}
    return {"run_id": "r", "span_id": f"s{start}", "parent_id": "r", "name": "model_call", "type": "model_call",
            "start": start, "end": start + 0.1, "duration_ms": 100.0, "status": "ok", "attrs": a}


SPANS = [
    span("local", 100, 50, 1.0, is_real=True),
    span("local", 2683, 0, 2.0, is_real=False, error="local refused the request (HTTP 401)"),
    span("local", 10, 5, 3.0),  # before is_real existed
]


class TestSpendCountsRealCompletionsOnly(unittest.TestCase):
    def test_per_model_cost_skips_a_stand_in(self):
        self.assertEqual(obs.per_model_cost(SPANS)["m"]["tokens"], 165)

    def test_per_operation_cost_skips_a_stand_in(self):
        self.assertEqual(sum(v["tokens"] for v in obs.per_operation_cost(SPANS).values()), 165)

    def test_the_dashboard_total_follows(self):
        with tempfile.TemporaryDirectory() as vault:
            with open(os.path.join(vault, "spans.jsonl"), "w", encoding="utf-8") as fh:
                for s in SPANS:
                    fh.write(json.dumps(s) + "\n")
            self.assertEqual(obs.dashboard(vault)["total_tokens"], 165)


if __name__ == "__main__":
    unittest.main()
