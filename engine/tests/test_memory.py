"""Tests for the three-tier memory system (Harness Layer 1, ADR-014)."""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.memory import (
    MemoryStore,
    MemoryItem,
    RuleSet,
    RuleFact,
    validate_write,
    select_context,
    injected_tokens,
    parse_frontmatter,
    est_tokens,
    L1,
    L2,
    L3,
)


class TestWriteValidationGate(unittest.TestCase):
    """A contradictory / malformed write is rejected BEFORE it persists."""

    def test_write_contradicting_a_rule_file_is_rejected_with_reason(self):
        rules = RuleSet([RuleFact(key="max_retries", value="3", source="policies/retry.md")])
        content = "---\ntype: policy\nmax_retries: 5\n---\nBody.\n"
        res = validate_write("policies/retry-new.md", content, rules)
        self.assertFalse(res["ok"], "fails closed")
        self.assertIn("max_retries", res["reason"])
        self.assertIn("policies/retry.md", res["reason"])

    def test_restating_same_value_is_not_a_contradiction(self):
        rules = RuleSet([RuleFact(key="max_retries", value="3", source="policies/retry.md")])
        content = "---\ntype: policy\nmax_retries: 3\n---\nBody.\n"
        res = validate_write("policies/retry-copy.md", content, rules)
        self.assertTrue(res["ok"], res["reason"])

    def test_missing_required_frontmatter_type_is_rejected(self):
        res = validate_write("notes/foo.md", "no frontmatter here", None)
        self.assertFalse(res["ok"])
        self.assertIn("type", res["reason"])

    def test_policy_without_max_guardrail_is_rejected(self):
        content = "---\ntype: policy\ntitle: A policy\n---\nBody.\n"
        res = validate_write("policies/loose.md", content, None)
        self.assertFalse(res["ok"])
        self.assertIn("max_", res["reason"])

    def test_clean_policy_write_validates(self):
        content = "---\ntype: policy\nmax_tokens: 1000\n---\nBody.\n"
        res = validate_write("policies/budget.md", content, None)
        self.assertTrue(res["ok"], res["reason"])

    def test_empty_content_rejected(self):
        res = validate_write("policies/x.md", "   ", None)
        self.assertFalse(res["ok"])

    def test_gate_reads_existing_rule_files_from_vault(self):
        with tempfile.TemporaryDirectory() as vault:
            pol = os.path.join(vault, "policies")
            os.makedirs(pol)
            with open(os.path.join(pol, "retry.md"), "w") as fh:
                fh.write("---\ntype: policy\nmax_retries: 3\n---\n")
            rules = RuleSet.from_vault(vault)
            bad = "---\ntype: policy\nmax_retries: 9\n---\n"
            res = validate_write("policies/other.md", bad, rules)
            self.assertFalse(res["ok"])
            self.assertIn("max_retries", res["reason"])


class TestSessionIsolation(unittest.TestCase):
    """Two concurrent tasks cannot read each other's working memory."""

    def test_two_sessions_do_not_cross_contaminate(self):
        store = MemoryStore()
        a = store.working("task-a")
        b = store.working("task-b")
        a.put("policy", "retry-limit")
        b.put("policy", "rate-limit")

        self.assertEqual(a.get("policy"), "retry-limit")
        self.assertEqual(b.get("policy"), "rate-limit")
        self.assertNotEqual(a.get("policy"), b.get("policy"))

    def test_session_cannot_see_another_sessions_key(self):
        store = MemoryStore()
        a = store.working("task-a")
        b = store.working("task-b")
        b.put("secret", "classified")
        # `a` has no access path to b's key.
        self.assertIsNone(a.get("secret"))
        self.assertNotIn("secret", a.keys())

    def test_same_session_id_returns_same_namespace(self):
        store = MemoryStore()
        a1 = store.working("task-a")
        a1.put("k", "v")
        a2 = store.working("task-a")
        self.assertEqual(a2.get("k"), "v")

    def test_drop_session_forgets_working_memory(self):
        store = MemoryStore()
        store.working("t").put("k", "v")
        self.assertTrue(store.has_session("t"))
        store.drop_session("t")
        self.assertFalse(store.has_session("t"))


class TestTokenBudget(unittest.TestCase):
    """Memory injection never exceeds its configured token budget."""

    def _items(self, n, size):
        return [
            MemoryItem(id=f"i{i}", tier=L3, content="x" * size, priority=1.0)
            for i in range(n)
        ]

    def test_injection_never_exceeds_budget(self):
        items = self._items(20, 400)  # each ~100 tokens
        budget = 250
        chosen = select_context(items, budget)
        self.assertLessEqual(injected_tokens(chosen), budget)
        self.assertGreater(len(chosen), 0)

    def test_higher_priority_items_win_the_budget(self):
        low = MemoryItem(id="low", tier=L3, content="x" * 200, priority=1.0)
        high = MemoryItem(id="high", tier=L1, content="x" * 200, priority=5.0)
        chosen = select_context([low, high], budget=est_tokens("x" * 200))
        self.assertEqual([c.id for c in chosen], ["high"])

    def test_zero_budget_injects_nothing(self):
        self.assertEqual(select_context(self._items(5, 100), 0), [])

    def test_item_bigger_than_budget_is_skipped(self):
        big = MemoryItem(id="big", tier=L3, content="x" * 1000, priority=9.0)
        small = MemoryItem(id="small", tier=L3, content="x" * 20, priority=1.0)
        chosen = select_context([big, small], budget=10)
        self.assertNotIn("big", [c.id for c in chosen])
        self.assertLessEqual(injected_tokens(chosen), 10)


class TestStoreTiers(unittest.TestCase):
    def test_profile_items_are_l1(self):
        store = MemoryStore(profile={"name": "Sukhdeep", "role": "founder"})
        items = store.profile_items()
        self.assertTrue(all(i.tier == L1 for i in items))
        self.assertEqual(len(items), 2)

    def test_candidates_span_three_tiers(self):
        with tempfile.TemporaryDirectory() as vault:
            with open(os.path.join(vault, "retry-policy.md"), "w") as fh:
                fh.write("---\ntype: policy\ntitle: Retry policy\n---\nretry limits\n")
            store = MemoryStore(profile={"name": "S"}, vault=vault)
            store.working("s1").put("focus", "retry policy work")
            cands = store.candidates("s1", "review the retry policy")
            tiers = {c.tier for c in cands}
            self.assertIn(L1, tiers)
            self.assertIn(L2, tiers)
            self.assertIn(L3, tiers)


class TestFrontmatter(unittest.TestCase):
    def test_parse_flat_frontmatter(self):
        fm = parse_frontmatter("---\ntype: policy\nmax_x: 3\n---\nbody")
        self.assertEqual(fm["type"], "policy")
        self.assertEqual(fm["max_x"], "3")

    def test_no_frontmatter_returns_empty(self):
        self.assertEqual(parse_frontmatter("just text"), {})


if __name__ == "__main__":
    unittest.main()
