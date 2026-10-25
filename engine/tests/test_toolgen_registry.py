"""Gate 4 — the registry, and activation.

The spec's acceptance criteria, each a test below:

  * A tool cannot be registered without at least one passing test case built
    from user-supplied real data.
  * Deleting a tool's directory removes it from the registry cleanly on next
    load — no orphaned references.
  * A generated tool survives a vault backup/restore and remains callable with
    identical permissions.
  * A tool marked confidential cannot be executed against a third-party
    provider — verifiable from spans.

The registry is the SOURCE OF TRUTH and is resolved at CALL time, not at start
time. That is what makes deleting a directory sufficient to revoke a tool: the
next call simply does not find it. A cached registry would leave a tool
callable after its code was gone, which is the worst kind of stale state.
"""
import json
import os
import shutil
import tempfile
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.toolgen import (
    RegistryError,
    activate_tool,
    load_registry,
    parse_manifest,
    registry_path,
)


def _raw(name="parse_invoice", **over):
    base = {
        "name": name, "version": "1.0.0", "description": "d", "runtime": "python3",
        "entrypoint": "tool.py:run",
        "input_schema": {}, "output_schema": {},
        "permissions": {"filesystem_read": ["inbox/**"]},
        "data_class": "confidential",
    }
    base.update(over)
    return base


class TestRegistry(unittest.TestCase):
    def setUp(self):
        self.vault = tempfile.mkdtemp(prefix="scprism-reg-")
        self.gen = os.path.join(self.vault, "tools", "generated")
        os.makedirs(self.gen)

    def tearDown(self):
        shutil.rmtree(self.vault, ignore_errors=True)

    def _tool(self, name="parse_invoice", **over):
        d = os.path.join(self.gen, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "manifest.json"), "w") as fh:
            json.dump(_raw(name, **over), fh)
        with open(os.path.join(d, "tool.py"), "w") as fh:
            fh.write("def run(p):\n    return {}\n")
        return d

    def test_an_empty_vault_has_an_empty_registry(self):
        self.assertEqual(load_registry(self.vault), {})

    def test_a_tool_is_not_callable_until_activated(self):
        self._tool()
        # Present on disk, absent from the registry — drafted is inert.
        self.assertEqual(load_registry(self.vault), {})

    def test_activation_requires_a_passing_test(self):
        d = self._tool()
        with self.assertRaises(RegistryError) as ctx:
            activate_tool(self.vault, d, approved_by="user", passing_tests=0)
        self.assertIn("test", str(ctx.exception).lower())

    def test_activation_requires_a_human(self):
        d = self._tool()
        with self.assertRaises(RegistryError):
            activate_tool(self.vault, d, approved_by="", passing_tests=2)

    def test_an_activated_tool_appears_in_the_registry(self):
        d = self._tool()
        activate_tool(self.vault, d, approved_by="user", passing_tests=2)
        reg = load_registry(self.vault)
        self.assertIn("parse_invoice", reg)
        self.assertTrue(reg["parse_invoice"].callable)

    def test_activation_stamps_who_and_when(self):
        d = self._tool()
        activate_tool(self.vault, d, approved_by="user", passing_tests=1)
        saved = json.load(open(os.path.join(d, "manifest.json")))
        self.assertEqual(saved["approved_by"], "user")
        self.assertTrue(saved["approved_at"])
        self.assertEqual(saved["passing_tests"], 1)

    def test_deleting_the_directory_removes_it_cleanly(self):
        d = self._tool()
        activate_tool(self.vault, d, approved_by="user", passing_tests=1)
        self.assertIn("parse_invoice", load_registry(self.vault))
        shutil.rmtree(d)
        # No orphan: the registry is resolved from disk at call time.
        self.assertNotIn("parse_invoice", load_registry(self.vault))

    def test_it_survives_a_backup_and_restore_with_identical_permissions(self):
        d = self._tool()
        activate_tool(self.vault, d, approved_by="user", passing_tests=1)
        before = load_registry(self.vault)["parse_invoice"]

        backup = tempfile.mkdtemp(prefix="scprism-bak-")
        shutil.copytree(self.vault, os.path.join(backup, "vault"))
        try:
            after = load_registry(os.path.join(backup, "vault"))["parse_invoice"]
            self.assertEqual(after.permissions, before.permissions)
            self.assertTrue(after.callable)
        finally:
            shutil.rmtree(backup, ignore_errors=True)

    def test_a_confidential_tool_stays_local_after_a_round_trip(self):
        d = self._tool(data_class="confidential", execution_target="any_provider")
        activate_tool(self.vault, d, approved_by="user", passing_tests=1)
        self.assertEqual(load_registry(self.vault)["parse_invoice"].execution_target, "local_only")

    def test_a_malformed_manifest_is_skipped_not_fatal(self):
        good = self._tool("good_tool")
        activate_tool(self.vault, good, approved_by="user", passing_tests=1)
        bad = os.path.join(self.gen, "bad_tool")
        os.makedirs(bad)
        with open(os.path.join(bad, "manifest.json"), "w") as fh:
            fh.write("{not json")
        reg = load_registry(self.vault)
        self.assertIn("good_tool", reg)
        self.assertNotIn("bad_tool", reg)

    def test_a_quarantined_tool_is_never_in_the_registry(self):
        q = os.path.join(self.vault, "tools", "quarantine", "bad_tool")
        os.makedirs(q)
        with open(os.path.join(q, "manifest.json"), "w") as fh:
            json.dump(_raw("bad_tool", approved_by="user", passing_tests=5), fh)
        self.assertNotIn("bad_tool", load_registry(self.vault))

    def test_the_registry_file_lives_where_the_spec_says(self):
        self.assertTrue(registry_path(self.vault).endswith(os.path.join("tools", "registry.json")))


if __name__ == "__main__":
    unittest.main()


class TestScopeApprovalIsItsOwnGate(unittest.TestCase):
    """Gate 1 and Gate 4 are separate decisions, and the schema must say so.

    The spec has scope approval as Gate 1 — "everything downstream is
    constrained by what is approved here" — and activation as Gate 4, after a
    sandbox run and an audit. Collapsing both into one `approved_by` field made
    them indistinguishable: a tool whose SCOPE you had approved looked the same
    as one you had activated, and the UI could not tell the user which decision
    was still theirs to make.

    Scope approval is safe for the interface to record: it is the user's own
    decision about what a tool MAY do, and it grants nothing. Activation is not
    — it requires a passing sandbox run, which only the engine can establish.
    """

    def setUp(self):
        self.vault = tempfile.mkdtemp(prefix="scprism-scope-")
        self.gen = os.path.join(self.vault, "tools", "generated")
        os.makedirs(self.gen)

    def tearDown(self):
        shutil.rmtree(self.vault, ignore_errors=True)

    def _tool(self, **over):
        d = os.path.join(self.gen, "parse_invoice")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "manifest.json"), "w") as fh:
            json.dump(_raw("parse_invoice", **over), fh)
        return d

    def test_a_scope_approved_tool_is_still_not_callable(self):
        m = parse_manifest(_raw(scope_approved_by="user"))
        self.assertFalse(m.callable)

    def test_scope_approval_survives_a_round_trip(self):
        d = self._tool(scope_approved_by="user")
        activate_tool(self.vault, d, approved_by="user", passing_tests=1)
        self.assertEqual(load_registry(self.vault)["parse_invoice"].scope_approved_by, "user")

    def test_activation_still_needs_a_passing_test_even_with_scope_approved(self):
        d = self._tool(scope_approved_by="user")
        with self.assertRaises(RegistryError):
            activate_tool(self.vault, d, approved_by="user", passing_tests=0)

    def test_scope_approval_alone_never_puts_a_tool_in_the_registry(self):
        self._tool(scope_approved_by="user")
        self.assertEqual(load_registry(self.vault), {})
