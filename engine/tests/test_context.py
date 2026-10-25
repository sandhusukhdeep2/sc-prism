"""Tests for context routing & compression (Harness Layer 6, ADR-016)."""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.context import (
    CatalogEntry,
    disclose,
    catalog_names,
    CompressionPolicy,
    compress,
    history_tokens,
    VaultStructure,
    reformulate,
    TRIGGER_TURNS,
    TRIGGER_WINDOW,
    TRIGGER_CHECKPOINT,
)


def _catalog():
    return [
        CatalogEntry(
            name="retry-policy",
            triggers=["retry", "rate limit"],
            instructions="RETRY RULES: " + "x" * 400,
        ),
        CatalogEntry(
            name="auth-policy",
            triggers=["auth", "login"],
            instructions="AUTH RULES: " + "y" * 400,
        ),
    ]


class TestProgressiveDisclosure(unittest.TestCase):
    """Full instructions load ONLY on a matching task."""

    def test_startup_view_is_names_only(self):
        cat = _catalog()
        self.assertEqual(catalog_names(cat), ["retry-policy", "auth-policy"])

    def test_matching_task_loads_only_that_skill(self):
        loaded = disclose("add a retry guard to the client", _catalog())
        names = [d.name for d in loaded]
        self.assertEqual(names, ["retry-policy"])
        self.assertIn("RETRY RULES", loaded[0].instructions)

    def test_non_matching_task_loads_nothing(self):
        loaded = disclose("summarize the changelog", _catalog())
        self.assertEqual(loaded, [])

    def test_multiword_trigger_requires_all_words(self):
        cat = [CatalogEntry(name="rl", triggers=["rate limit"], instructions="I")]
        self.assertEqual(disclose("fix the rate handler", cat), [])
        self.assertEqual(len(disclose("add a rate limit", cat)), 1)


class TestCompressionTriggers(unittest.TestCase):
    """Compression fires at the three defined points and never grows tokens."""

    def _history(self, n):
        return [
            {"role": "assistant", "kind": "tool_output", "content": f"out-{i} " + "z" * 200, "i": i}
            for i in range(n)
        ]

    def test_trigger_fires_after_n_turns(self):
        pol = CompressionPolicy(n_turns=4, window_tokens=10_000_000)
        self.assertIsNone(pol.check_trigger(self._history(3)))
        self.assertEqual(pol.check_trigger(self._history(4)), TRIGGER_TURNS)

    def test_trigger_fires_at_window_pressure(self):
        # ~50 tok/entry * 40 = ~2000 tok; window 2000 * 0.8 = 1600 -> fires.
        pol = CompressionPolicy(n_turns=1000, window_tokens=2000, window_fraction=0.8)
        trig = pol.check_trigger(self._history(40))
        self.assertEqual(trig, TRIGGER_WINDOW)

    def test_checkpoint_wins(self):
        pol = CompressionPolicy()
        self.assertEqual(
            pol.check_trigger(self._history(1), checkpoint=True), TRIGGER_CHECKPOINT
        )

    def test_compress_trims_old_tool_outputs(self):
        hist = self._history(8)
        out = compress(hist, TRIGGER_TURNS, policy=CompressionPolicy(keep_recent=2))
        self.assertLessEqual(out.tokens_after, out.tokens_before)
        self.assertTrue(any(op.startswith("trim") for op in out.ops))
        # Most recent outputs are preserved (not trimmed).
        self.assertNotIn("trimmed", out.entries[-1])

    def test_compress_dedupes_repeated_context(self):
        hist = [
            {"role": "user", "content": "same"},
            {"role": "user", "content": "same"},
            {"role": "user", "content": "different"},
        ]
        out = compress(hist, TRIGGER_TURNS)
        self.assertTrue(any(op.startswith("dedupe") for op in out.ops))
        contents = [e["content"] for e in out.entries]
        self.assertEqual(contents.count("same"), 1)

    def test_compress_summarises_at_window(self):
        hist = self._history(10)
        out = compress(hist, TRIGGER_WINDOW, policy=CompressionPolicy(keep_recent=2))
        self.assertTrue(any(op.startswith("summarise") for op in out.ops))
        self.assertLess(out.tokens_after, out.tokens_before)

    def test_tokens_never_grow(self):
        for trig in (TRIGGER_TURNS, TRIGGER_WINDOW, TRIGGER_CHECKPOINT):
            out = compress(self._history(12), trig)
            self.assertLessEqual(out.tokens_after, out.tokens_before)

    def test_stable_prefix_is_byte_stable(self):
        """Cache boundary (ADR-016): the stable prefix must not be mutated."""
        prefix = [
            {"role": "system", "content": "SYSTEM PROMPT"},
            {"role": "system", "content": "RULE FILES"},
        ]
        tail = self._history(8)
        out = compress(prefix + tail, TRIGGER_WINDOW, stable_prefix=2)
        self.assertEqual(out.entries[0], prefix[0])
        self.assertEqual(out.entries[1], prefix[1])

    def test_unknown_trigger_raises(self):
        with self.assertRaises(ValueError):
            compress([], "bogus")


class TestReformulation(unittest.TestCase):
    """Reformulation binds a raw intent to the vault's structure."""

    def _vault(self):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "policies"))
        with open(os.path.join(d, "retry-policy.md"), "w") as fh:
            fh.write("---\ntype: policy\ntitle: Retry\n---\n")
        return d

    def test_query_binds_to_vault_entities(self):
        vs = VaultStructure.from_vault(self._vault())
        q = reformulate("please review the retry-policy limits", vs)
        self.assertIn("retry-policy", q.entities)
        self.assertIn("entity:retry-policy", q.text)

    def test_query_binds_to_sections(self):
        vs = VaultStructure.from_vault(self._vault())
        q = reformulate("check the policies directory", vs)
        self.assertIn("policies", q.sections)

    def test_stopwords_are_dropped(self):
        q = reformulate("please can you add the retry guard", VaultStructure())
        self.assertNotIn("the", q.terms)
        self.assertNotIn("please", q.terms)
        self.assertIn("retry", q.terms)

    def test_deterministic_offline_no_gateway(self):
        vs = VaultStructure(entities=["retry-policy"], sections=[])
        q1 = reformulate("retry policy audit", vs)
        q2 = reformulate("retry policy audit", vs)
        self.assertEqual(q1.to_dict(), q2.to_dict())


if __name__ == "__main__":
    unittest.main()
