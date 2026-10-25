import threading
import time
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.planner import Step, READ, WRITE, LOCAL
from scprism_engine.dispatcher import dispatch, ModelResult


class TestDispatcherSeriality(unittest.TestCase):
    def test_writes_are_serial_reads_may_overlap(self):
        active = {"n": 0}
        overlaps = {"read": 0, "write": 0}
        lock = threading.Lock()

        def instrumented(prompt, route):
            is_write = prompt.startswith("W")
            with lock:
                active["n"] += 1
                if active["n"] > 1:
                    overlaps["write" if is_write else "read"] += 1
                cur = active["n"]
            time.sleep(0.02)
            with lock:
                active["n"] -= 1
            return ModelResult(text=f"done:{prompt}", tokens=1, route=route)

        steps = [
            Step(0, "R read a", kind=READ, route=LOCAL),
            Step(1, "R read b", kind=READ, route=LOCAL),
            Step(2, "R read c", kind=READ, route=LOCAL),
            Step(3, "W write a", kind=WRITE, route=LOCAL),
            Step(4, "W write b", kind=WRITE, route=LOCAL),
        ]
        result = dispatch(steps, model=instrumented, max_workers=4)

        # No write ever overlapped anything.
        self.assertEqual(overlaps["write"], 0, "writes must be strictly serial")
        # Reads were allowed to overlap (they ran in a batch of 3).
        self.assertGreater(overlaps["read"], 0, "reads should run concurrently")
        # Write steps executed in plan order.
        self.assertEqual(result.write_order, [3, 4])
        self.assertEqual(len(result.step_results), 5)

    def test_tokens_are_summed(self):
        steps = [Step(0, "read something", kind=READ, route=LOCAL)]
        result = dispatch(steps)
        self.assertGreater(result.tokens_spent, 0)


if __name__ == "__main__":
    unittest.main()
