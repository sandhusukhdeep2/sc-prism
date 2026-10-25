"""Layer 3 — RBAC + ABAC permission enforcement (ADR-011, specs/03)."""

import time
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.permissions import (
    PermissionEngine,
    AccessContext,
    READ,
    WRITE,
    EXECUTE,
    DELETE,
    WRITE_RULE,
    CHANGE_PERMISSIONS,
    DEFAULT_GRANT_TTL_SECONDS,
)


class TestRBAC(unittest.TestCase):
    def setUp(self):
        self.p = PermissionEngine()

    def _ctx(self, role, scope=None, env="dev", **kw):
        return AccessContext(
            role=role, scope=scope or ["engine/**"], env=env, issued_at=time.time(),
            **kw,
        )

    def test_data_reader_cannot_write(self):
        d = self.p.check("a1", WRITE, "engine/x.py", self._ctx("data-reader"))
        self.assertFalse(d.allow)
        self.assertIn("data-reader", d.reason)

    def test_implementer_can_write_in_scope(self):
        d = self.p.check("a1", WRITE, "engine/x.py", self._ctx("implementer"))
        self.assertTrue(d.allow, d.reason)

    def test_implementer_cannot_do_irreversible(self):
        d = self.p.check("a1", WRITE_RULE, "engine/rules.md", self._ctx("implementer"))
        self.assertFalse(d.allow)

    def test_admin_can_do_irreversible(self):
        d = self.p.check("a1", WRITE_RULE, "engine/rules.md", self._ctx("admin"))
        self.assertTrue(d.allow, d.reason)

    def test_unknown_role_denied(self):
        d = self.p.check("a1", READ, "engine/x.py", self._ctx("wizard"))
        self.assertFalse(d.allow)
        self.assertIn("unknown role", d.reason)

    def test_reviewer_may_execute_not_write(self):
        self.assertTrue(self.p.check("a", EXECUTE, "", self._ctx("reviewer")).allow)
        self.assertFalse(self.p.check("a", WRITE, "engine/x.py", self._ctx("reviewer")).allow)


class TestABAC(unittest.TestCase):
    def setUp(self):
        self.p = PermissionEngine()

    def test_out_of_scope_path_denied_with_reason(self):
        ctx = AccessContext(
            role="implementer", scope=["engine/**"], purpose="tranche E3a",
            issued_at=time.time(),
        )
        d = self.p.check("a1", WRITE, "src/secret.py", ctx)
        self.assertFalse(d.allow)
        self.assertIn("outside declared scope", d.reason)
        self.assertIn("src/secret.py", d.reason)

    def test_in_scope_path_allowed(self):
        ctx = AccessContext(role="implementer", scope=["engine/**"], issued_at=time.time())
        self.assertTrue(self.p.check("a1", WRITE, "engine/deep/nested.py", ctx).allow)

    def test_prod_irreversible_requires_admin(self):
        ctx = AccessContext(
            role="admin", scope=["engine/**"], env="prod", issued_at=time.time()
        )
        # admin ok in prod
        self.assertTrue(self.p.check("a", DELETE, "engine/x.py", ctx).allow)
        # a role that would otherwise be able to delete is blocked in prod... but
        # only admin has delete anyway; assert the prod reason path by granting
        # delete to a custom role.
        p2 = PermissionEngine(roles={"ops": frozenset({DELETE, READ})})
        ctx2 = AccessContext(role="ops", scope=["engine/**"], env="prod", issued_at=time.time())
        d = p2.check("a", DELETE, "engine/x.py", ctx2)
        self.assertFalse(d.allow)
        self.assertIn("prod", d.reason)

    def test_expired_grant_denied(self):
        ctx = AccessContext(
            role="admin", scope=["engine/**"],
            issued_at=time.time() - (DEFAULT_GRANT_TTL_SECONDS + 10),
            now=time.time(),
        )
        d = self.p.check("a", WRITE, "engine/x.py", ctx)
        self.assertFalse(d.allow)
        self.assertIn("expired", d.reason)

    def test_attribute_store_narrows_grant(self):
        p = PermissionEngine()
        # implementer role permits write, but the attribute grant for this
        # agent:task_type only allows read -> least privilege wins.
        p.grant_attributes("agent-7", "audit-read", ops=[READ], paths=["engine/audit/**"])
        ctx = AccessContext(
            role="implementer", scope=["engine/**"], task_type="audit-read",
            issued_at=time.time(),
        )
        self.assertTrue(p.check("agent-7", READ, "engine/audit/log.json", ctx).allow)
        d = p.check("agent-7", WRITE, "engine/audit/log.json", ctx)
        self.assertFalse(d.allow)
        self.assertIn("attribute grant", d.reason)

    def test_decision_is_auditable(self):
        ctx = AccessContext(role="implementer", scope=["engine/**"], issued_at=time.time())
        d = self.p.check("a1", WRITE, "engine/x.py", ctx)
        rec = d.to_dict()
        for key in ("allow", "reason", "agent", "action", "path", "role"):
            self.assertIn(key, rec)


if __name__ == "__main__":
    unittest.main()
