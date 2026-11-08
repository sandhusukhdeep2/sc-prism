import json
import os
import tempfile
import threading
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.telemetry import Telemetry, read_spans, TelemetryError


class TestTelemetry(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self._tmp.name, "spans.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def test_span_emits_one_line_with_expected_fields(self):
        tel = Telemetry(self.path, run_id="run-1")
        with tel.span("model_call", span_type="model_call", tokens_in=5) as sp:
            sp.set(tokens_out=3)
        spans = read_spans(self.path)
        self.assertEqual(len(spans), 1)
        s = spans[0]
        for key in ("run_id", "span_id", "parent_id", "name", "type",
                    "start", "end", "duration_ms", "status", "attrs"):
            self.assertIn(key, s)
        self.assertEqual(s["run_id"], "run-1")
        self.assertEqual(s["type"], "model_call")
        self.assertEqual(s["status"], "ok")
        self.assertEqual(s["attrs"]["tokens_out"], 3)
        self.assertGreaterEqual(s["duration_ms"], 0.0)

    def test_error_span_records_status_and_reraises(self):
        tel = Telemetry(self.path, run_id="run-2")
        with self.assertRaises(ValueError):
            with tel.span("boom", span_type="tool_exec"):
                raise ValueError("kaboom")
        spans = read_spans(self.path)
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]["status"], "error")
        self.assertIn("kaboom", spans[0]["attrs"]["error"])

    def test_unknown_span_type_rejected(self):
        tel = Telemetry(self.path)
        with self.assertRaises(TelemetryError):
            with tel.span("x", span_type="not-a-type"):
                pass

    def test_parent_child_reconstruction(self):
        tel = Telemetry(self.path, run_id="run-3")
        with tel.span("run:x", span_type="run") as root:
            with tel.span("child", span_type="hook", parent=root.span_id):
                pass
        spans = read_spans(self.path)
        roots = [s for s in spans if s["type"] == "run"]
        children = [s for s in spans if s["type"] == "hook"]
        self.assertEqual(len(roots), 1)
        self.assertEqual(children[0]["parent_id"], roots[0]["span_id"])

    # The seat context (spec 2026-11-08, engine gap 2): a tool span written
    # during a named seat's turn must say WHO used the tool, or the board,
    # the ceremony's live tail and the dossier can never attribute it.
    def test_spans_inside_acting_as_carry_the_seat(self):
        tel = Telemetry(self.path, run_id="run-1")
        with tel.acting_as("scout", "proof"):
            with tel.span("tool_exec", span_type="tool_exec", tool="vault_read"):
                pass
        with tel.span("hook", span_type="hook"):
            pass
        spans = read_spans(self.path)
        self.assertEqual(spans[0]["attrs"]["agent"], "scout")
        self.assertEqual(spans[0]["attrs"]["round"], "proof")
        self.assertEqual(spans[0]["attrs"]["tool"], "vault_read")
        # Outside the block nothing is claimed — absent, not empty.
        self.assertNotIn("agent", spans[1]["attrs"])
        self.assertNotIn("round", spans[1]["attrs"])

    def test_an_explicit_agent_wins_over_the_seat_context(self):
        tel = Telemetry(self.path, run_id="run-1")
        with tel.acting_as("scout", "proof"):
            with tel.span("model_call", span_type="model_call", agent="judge", round="eval"):
                pass
        s = read_spans(self.path)[0]
        self.assertEqual((s["attrs"]["agent"], s["attrs"]["round"]), ("judge", "eval"))

    def test_acting_as_restores_the_outer_seat_and_ignores_blank_names(self):
        tel = Telemetry(self.path, run_id="run-1")
        with tel.acting_as("lead", "1"):
            with tel.acting_as("scout", "2"):
                with tel.span("tool_exec", span_type="tool_exec"):
                    pass
            with tel.span("tool_exec", span_type="tool_exec"):
                pass
        with tel.acting_as("", ""):
            with tel.span("tool_exec", span_type="tool_exec"):
                pass
        a, b, c = read_spans(self.path)
        self.assertEqual(a["attrs"]["agent"], "scout")
        self.assertEqual(b["attrs"]["agent"], "lead")
        self.assertNotIn("agent", c["attrs"])

    # Engine gap 1 (spec 2026-11-08): a span was written only when it closed,
    # so a board could never see a model call or a tool call IN FLIGHT —
    # "thinking", "reading your notes", "searching the web" were coded and
    # tested but impossible on a real run. A model_call / tool_exec span now
    # announces itself when it opens; the close rewrites the same span_id, and
    # read_spans keeps one record per span, the last one written.
    def test_a_model_call_announces_itself_when_it_opens(self):
        tel = Telemetry(self.path, run_id="run-1")
        with tel.acting_as("scout", "1"):
            with tel.span("model_call", span_type="model_call", provider="local") as sp:
                raw_mid = open(self.path, encoding="utf-8").read().splitlines()
                sp.set(tokens_out=3)
        self.assertEqual(len(raw_mid), 1)
        opened = json.loads(raw_mid[0])
        self.assertEqual(opened["status"], "open")
        self.assertIsNone(opened["end"])
        self.assertEqual(opened["attrs"]["agent"], "scout")
        self.assertEqual(opened["attrs"]["provider"], "local")
        raw = open(self.path, encoding="utf-8").read().splitlines()
        self.assertEqual(len(raw), 2)
        closed = json.loads(raw[1])
        self.assertEqual(closed["span_id"], opened["span_id"])
        self.assertEqual(closed["status"], "ok")
        self.assertEqual(closed["attrs"]["tokens_out"], 3)

    def test_read_spans_keeps_one_record_per_span_the_last_one(self):
        tel = Telemetry(self.path, run_id="run-1")
        with tel.span("tool_exec", span_type="tool_exec", tool="vault_read"):
            pass
        with tel.span("hook", span_type="hook"):
            pass
        spans = read_spans(self.path)
        self.assertEqual([s["type"] for s in spans], ["tool_exec", "hook"])
        self.assertEqual(spans[0]["status"], "ok")
        self.assertIsNotNone(spans[0]["end"])

    def test_only_model_and_tool_spans_announce_themselves(self):
        tel = Telemetry(self.path, run_id="run-1")
        with tel.span("hook", span_type="hook"):
            pass
        with tel.span("retrieval", span_type="retrieval"):
            pass
        raw = open(self.path, encoding="utf-8").read().splitlines()
        self.assertEqual(len(raw), 2)
        self.assertTrue(all(json.loads(l)["status"] == "ok" for l in raw))

    def test_a_span_still_open_reads_as_open(self):
        tel = Telemetry(self.path, run_id="run-1")
        cm = tel.span("model_call", span_type="model_call")
        cm.__enter__()  # the run is mid-call; nobody has closed it
        spans = read_spans(self.path)
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]["status"], "open")
        cm.__exit__(None, None, None)

    def test_concurrent_appends_are_not_corrupted(self):
        tel = Telemetry(self.path, run_id="run-4")

        def emit(i):
            with tel.span(f"s{i}", span_type="model_call"):
                pass

        threads = [threading.Thread(target=emit, args=(i,)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        # 20 well-formed JSON lines, none clobbered.
        spans = read_spans(self.path)
        self.assertEqual(len(spans), 20)


if __name__ == "__main__":
    unittest.main()
