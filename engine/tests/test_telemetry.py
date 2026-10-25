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
