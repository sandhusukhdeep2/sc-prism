"""Gate 2 — sandbox execution. Permissions at the host boundary, not by convention.

The spec's requirement for a generated tool, before it may be registered:

    produce output matching output_schema for every test case
    attempt no undeclared filesystem, network, or vault access
    terminate within a timeout
    be deterministic across two consecutive runs on the same input

These tests run REAL tools in a REAL sandbox. Nothing here is mocked, because
every claim is a claim about what the operating system does — and a mock would
agree just as readily with a profile that contains nothing.

Measured before writing the profile: the system `python3` is Xcode's shim and
cannot run under deny-default (it shells out to xcodebuild). The interpreter
BUNDLED with the app runs fine, and under the profile below a socket and an
undeclared write both raise PermissionError from the kernel.
"""
import json
import os
import shutil
import tempfile
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.toolgen import (
    BUNDLED_PYTHON_CANDIDATES,
    parse_manifest,
    sandbox_available,
    sandbox_gate,
)


def _raw(**over):
    base = {
        "name": "echo_tool",
        "version": "1.0.0",
        "description": "d",
        "runtime": "python3",
        "entrypoint": "tool.py:run",
        "input_schema": {"type": "object", "properties": {"n": {"type": "number"}}},
        "output_schema": {"type": "object", "properties": {"n": {"type": "number"}}},
        "permissions": {"filesystem_read": [], "network": []},
        "data_class": "confidential",
    }
    base.update(over)
    return base


TOOL_OK = '''
import json, sys
def run(payload):
    return {"n": payload.get("n", 0) * 2}
if __name__ == "__main__":
    print(json.dumps(run(json.loads(sys.stdin.read()))))
'''

TOOL_NETWORK = '''
import json, sys, socket
def run(payload):
    socket.create_connection(("1.1.1.1", 80), timeout=3)
    return {"n": 1}
if __name__ == "__main__":
    print(json.dumps(run(json.loads(sys.stdin.read()))))
'''

TOOL_WRITES_OUTSIDE = '''
import json, sys
def run(payload):
    open("/tmp/scprism-should-never-exist", "w").write("x")
    return {"n": 1}
if __name__ == "__main__":
    print(json.dumps(run(json.loads(sys.stdin.read()))))
'''

TOOL_NONDETERMINISTIC = '''
import json, sys, random
def run(payload):
    return {"n": random.random()}
if __name__ == "__main__":
    print(json.dumps(run(json.loads(sys.stdin.read()))))
'''

TOOL_WRONG_SHAPE = '''
import json, sys
def run(payload):
    return {"totally": "different"}
if __name__ == "__main__":
    print(json.dumps(run(json.loads(sys.stdin.read()))))
'''

TOOL_HANGS = '''
import json, sys, time
def run(payload):
    time.sleep(60)
    return {"n": 1}
if __name__ == "__main__":
    print(json.dumps(run(json.loads(sys.stdin.read()))))
'''


def _have_python():
    return any(os.path.isfile(p) for p in BUNDLED_PYTHON_CANDIDATES)


@unittest.skipUnless(sandbox_available() and _have_python(), "needs sandbox-exec + bundled python")
class TestSandboxGate(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="scprism-tool-")
        os.makedirs(os.path.join(self.dir, "tests"))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)
        try:
            os.remove("/tmp/scprism-should-never-exist")
        except OSError:
            pass

    def _tool(self, src, cases=((2, {"n": 4}),)):
        with open(os.path.join(self.dir, "tool.py"), "w") as fh:
            fh.write(src)
        for i, (n, expected) in enumerate(cases, 1):
            with open(os.path.join(self.dir, "tests", f"case_{i:03d}.input"), "w") as fh:
                fh.write(json.dumps({"n": n}))
            with open(os.path.join(self.dir, "tests", f"case_{i:03d}.expected"), "w") as fh:
                fh.write(json.dumps(expected))

    def test_a_correct_tool_passes(self):
        self._tool(TOOL_OK)
        r = sandbox_gate(parse_manifest(_raw()), self.dir)
        self.assertTrue(r.passed, r.detail)
        self.assertEqual(r.reason, "")
        self.assertEqual(len(r.cases), 1)

    def test_a_tool_reaching_the_network_is_quarantined(self):
        self._tool(TOOL_NETWORK)
        r = sandbox_gate(parse_manifest(_raw()), self.dir)
        self.assertFalse(r.passed)
        # Machine-readable, per the acceptance criteria.
        self.assertEqual(r.reason, "undeclared_access")

    def test_a_tool_writing_outside_its_declaration_is_quarantined(self):
        self._tool(TOOL_WRITES_OUTSIDE)
        r = sandbox_gate(parse_manifest(_raw()), self.dir)
        self.assertFalse(r.passed)
        self.assertEqual(r.reason, "undeclared_access")
        self.assertFalse(os.path.exists("/tmp/scprism-should-never-exist"))

    def test_a_nondeterministic_tool_is_quarantined(self):
        # Two consecutive runs on the same input must agree, or the tool cannot
        # be reasoned about — and a verifier cannot verify it.
        self._tool(TOOL_NONDETERMINISTIC, cases=((2, {"n": 0.5}),))
        r = sandbox_gate(parse_manifest(_raw()), self.dir)
        self.assertFalse(r.passed)
        self.assertIn(r.reason, ("nondeterministic", "output_mismatch"))

    def test_a_tool_whose_output_does_not_match_its_schema_is_quarantined(self):
        self._tool(TOOL_WRONG_SHAPE)
        r = sandbox_gate(parse_manifest(_raw()), self.dir)
        self.assertFalse(r.passed)
        self.assertIn(r.reason, ("output_mismatch", "schema_mismatch"))

    def test_a_hanging_tool_is_killed_and_quarantined(self):
        self._tool(TOOL_HANGS)
        r = sandbox_gate(parse_manifest(_raw()), self.dir, timeout=3)
        self.assertFalse(r.passed)
        self.assertEqual(r.reason, "timeout")

    def test_no_test_cases_means_no_pass(self):
        """No fixtures, no registration — a tool that proved nothing must not
        be able to claim it proved something."""
        with open(os.path.join(self.dir, "tool.py"), "w") as fh:
            fh.write(TOOL_OK)
        r = sandbox_gate(parse_manifest(_raw()), self.dir)
        self.assertFalse(r.passed)
        self.assertEqual(r.reason, "no_test_cases")

    def test_the_result_names_every_case_it_ran(self):
        self._tool(TOOL_OK, cases=((2, {"n": 4}), (5, {"n": 10})))
        r = sandbox_gate(parse_manifest(_raw()), self.dir)
        self.assertTrue(r.passed, r.detail)
        self.assertEqual(len(r.cases), 2)
        self.assertTrue(all(c.passed for c in r.cases))


if __name__ == "__main__":
    unittest.main()
