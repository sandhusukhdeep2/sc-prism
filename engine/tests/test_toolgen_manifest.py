"""The generated-tool manifest: the contract, written before any code.

From Sukhdeep's self-extending-tools spec. The manifest is drafted FIRST
because writing it first forces the permission surface to be decided before a
line of implementation exists — and Gate 1 (scope approval) is the gate
everything downstream is constrained by.

The invariants below are the spec's own settled decisions, not preferences:

  * `permissions` is a CLOSED list. Anything not declared is denied and there
    is no wildcard grant.
  * `data_class: confidential` FORCES `execution_target: local_only`. A tool
    that touches confidential data cannot be executed by, or have its inputs
    sent to, a third-party provider. This is the privacy floor applied to tool
    creation, and it must not be overridable by the manifest that declares it.
  * `approved_by: null` means NOT CALLABLE. A drafted tool is inert.
  * A tool's permissions are a SUBSET of the agent that built it, never a
    superset — the existing no-escalation rule applied to tool creation.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.toolgen import (
    ManifestError,
    ToolManifest,
    parse_manifest,
    permissions_within,
)


def _raw(**over):
    base = {
        "name": "parse_supplier_invoice",
        "version": "1.0.0",
        "description": "Extract line items from Northwind Foods PDF invoices.",
        "created_by": "manager",
        "runtime": "python3",
        "entrypoint": "tool.py:run",
        "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}},
        "output_schema": {"type": "object", "properties": {"supplier": {"type": "string"}}},
        "permissions": {
            "filesystem_read": ["vault/inbox/invoices/**"],
            "filesystem_write": [],
            "network": [],
            "vault_read": [],
            "vault_write": [],
        },
        "data_class": "confidential",
        "execution_target": "local_only",
        "approved_by": None,
    }
    base.update(over)
    return base


class TestTheClosedPermissionList(unittest.TestCase):
    def test_a_valid_manifest_parses(self):
        m = parse_manifest(_raw())
        self.assertIsInstance(m, ToolManifest)
        self.assertEqual(m.name, "parse_supplier_invoice")

    def test_an_undeclared_permission_key_is_refused(self):
        with self.assertRaises(ManifestError) as ctx:
            parse_manifest(_raw(permissions={"filesystem_read": [], "shell_exec": ["*"]}))
        self.assertIn("shell_exec", str(ctx.exception))

    def test_there_is_no_wildcard_grant(self):
        for bad in ("*", "**", "/", "~", "/**"):
            with self.subTest(bad=bad):
                with self.assertRaises(ManifestError):
                    parse_manifest(_raw(permissions={"filesystem_read": [bad]}))

    def test_an_absent_permission_class_means_none_not_all(self):
        m = parse_manifest(_raw(permissions={"filesystem_read": ["vault/inbox/**"]}))
        self.assertEqual(m.permissions["network"], [])
        self.assertEqual(m.permissions["filesystem_write"], [])

    def test_a_path_escaping_the_vault_is_refused(self):
        with self.assertRaises(ManifestError):
            parse_manifest(_raw(permissions={"filesystem_read": ["../../.ssh/id_rsa"]}))


class TestConfidentialForcesLocal(unittest.TestCase):
    def test_confidential_data_forces_local_only(self):
        m = parse_manifest(_raw(data_class="confidential", execution_target="any_provider"))
        # The manifest does not get to talk its way out of the floor.
        self.assertEqual(m.execution_target, "local_only")

    def test_public_data_may_use_any_provider(self):
        m = parse_manifest(_raw(data_class="public", execution_target="any_provider"))
        self.assertEqual(m.execution_target, "any_provider")

    def test_an_unknown_data_class_is_treated_as_confidential(self):
        # Failing closed: an unrecognised class must not become a way out.
        m = parse_manifest(_raw(data_class="totally-fine-honest"))
        self.assertEqual(m.execution_target, "local_only")


class TestDraftedToolsAreInert(unittest.TestCase):
    def test_an_unapproved_tool_is_not_callable(self):
        self.assertFalse(parse_manifest(_raw(approved_by=None)).callable)

    def test_approval_alone_is_not_enough_without_a_passing_test(self):
        """The spec: no test fixtures, no registration. A tool must prove
        itself against REAL data the user supplied, not fixtures it invented."""
        m = parse_manifest(_raw(approved_by="user", passing_tests=0))
        self.assertFalse(m.callable)

    def test_approved_and_proven_is_callable(self):
        m = parse_manifest(_raw(approved_by="user", passing_tests=3))
        self.assertTrue(m.callable)


class TestPermissionInheritance(unittest.TestCase):
    """permsT ⊆ permsA — a tool never exceeds the agent that built it."""

    def test_a_subset_is_allowed(self):
        ok, reason = permissions_within(
            {"filesystem_read": ["vault/inbox/**"], "network": []},
            {"filesystem_read": ["vault/inbox/**", "vault/notes/**"], "network": ["api.example.com"]},
        )
        self.assertTrue(ok, reason)

    def test_a_permission_the_builder_lacks_is_refused(self):
        ok, reason = permissions_within(
            {"network": ["api.example.com"]},
            {"network": []},
        )
        self.assertFalse(ok)
        self.assertIn("network", reason)

    def test_a_path_outside_the_builders_grant_is_refused(self):
        ok, reason = permissions_within(
            {"filesystem_read": ["vault/secrets/**"]},
            {"filesystem_read": ["vault/inbox/**"]},
        )
        self.assertFalse(ok)
        self.assertIn("vault/secrets/**", reason)

    def test_an_empty_builder_grant_permits_only_an_empty_tool(self):
        self.assertTrue(permissions_within({}, {})[0])
        self.assertFalse(permissions_within({"network": ["x"]}, {})[0])


class TestNamesAndVersions(unittest.TestCase):
    def test_a_name_that_could_shadow_a_shipped_tool_is_refused(self):
        for reserved in ("web_search", "terminal_run", "vault_read"):
            with self.subTest(reserved=reserved):
                with self.assertRaises(ManifestError):
                    parse_manifest(_raw(name=reserved))

    def test_a_name_with_a_path_separator_is_refused(self):
        for bad in ("../escape", "a/b", "a\\b"):
            with self.subTest(bad=bad):
                with self.assertRaises(ManifestError):
                    parse_manifest(_raw(name=bad))

    def test_a_missing_required_field_is_named_in_the_error(self):
        raw = _raw()
        del raw["entrypoint"]
        with self.assertRaises(ManifestError) as ctx:
            parse_manifest(raw)
        self.assertIn("entrypoint", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
