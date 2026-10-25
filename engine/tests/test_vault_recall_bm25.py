"""Vault recall reads whole documents, not the first 400 bytes.

`MemoryStore.vault_items` scored each page on keyword overlap against its
TITLE and FIRST LINE, from a 400-byte read. Everything past that window was
invisible to recall — so a decision recorded in the third paragraph of a note
could not be found, no matter how exactly the task named it. This is the "at
falling cost" leg of the pitch: cost falls when retrieval is precise, and a
400-byte skim is not retrieval.

The cascade (BM25 over full text, then TF-IDF rerank) has existed in
retrieval.py the whole time and was constructed only in tests.

Bounded on purpose: this runs ahead of every turn, so the index build is
capped and any failure degrades to the old keyword scan rather than failing
the run. A slower correct answer is worth having; a run that dies because a
vault got large is not.
"""
import os
import shutil
import tempfile
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.memory import MemoryStore


class TestRecallSeesWholeDocuments(unittest.TestCase):
    def setUp(self):
        self.vault = tempfile.mkdtemp(prefix="scprism-recall-")

    def tearDown(self):
        shutil.rmtree(self.vault, ignore_errors=True)

    def _write(self, rel, text):
        path = os.path.join(self.vault, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)

    def test_a_decision_past_the_400_byte_window_is_found(self):
        # The answer sits well beyond the old read window, and the title says
        # nothing about it — exactly the shape the skim could never find.
        padding = "Background and preamble that is not relevant. " * 20  # ~900 chars
        self._write(
            "notes/architecture.md",
            f"# Architecture notes\n\n{padding}\n\n"
            "We chose Okapi ranking for the retriever because it handles term "
            "saturation. The alternative was rejected.\n",
        )
        self._write("notes/unrelated.md", "# Shopping\n\nMilk, bread, coffee.\n")

        items = MemoryStore(vault=self.vault).vault_items(
            "why did we choose okapi ranking for the retriever", limit=5
        )
        rels = " ".join(i.content + " " + (i.source or "") + " " + i.id for i in items)
        self.assertIn("architecture", rels.lower(), "the relevant note was not recalled")

    def test_an_irrelevant_note_does_not_outrank_a_relevant_one(self):
        self._write("notes/relevant.md", "# Notes\n\n" + ("okapi ranking retriever " * 30))
        self._write("notes/noise.md", "# Notes\n\n" + ("unrelated filler text " * 30))
        items = MemoryStore(vault=self.vault).vault_items("okapi ranking retriever", limit=2)
        self.assertTrue(items, "nothing was recalled at all")
        first = (items[0].content + items[0].id + (items[0].source or "")).lower()
        self.assertIn("relevant", first)


class TestRecallStaysBounded(unittest.TestCase):
    """It runs ahead of every turn: it must never raise, and never hang."""

    def setUp(self):
        self.vault = tempfile.mkdtemp(prefix="scprism-bound-")

    def tearDown(self):
        shutil.rmtree(self.vault, ignore_errors=True)

    def test_a_missing_vault_returns_nothing(self):
        self.assertEqual(MemoryStore(vault="/nonexistent/xyz").vault_items("q"), [])

    def test_an_empty_vault_returns_nothing(self):
        self.assertEqual(MemoryStore(vault=self.vault).vault_items("q"), [])

    def test_the_limit_is_honoured(self):
        for i in range(30):
            with open(os.path.join(self.vault, f"n{i}.md"), "w", encoding="utf-8") as fh:
                fh.write(f"# Note {i}\n\nshared keyword content here\n")
        items = MemoryStore(vault=self.vault).vault_items("shared keyword", limit=4)
        self.assertLessEqual(len(items), 4)

    def test_an_unreadable_file_does_not_kill_recall(self):
        with open(os.path.join(self.vault, "good.md"), "w", encoding="utf-8") as fh:
            fh.write("# Good\n\nfindable keyword\n")
        bad = os.path.join(self.vault, "bad.md")
        with open(bad, "wb") as fh:
            fh.write(b"\xff\xfe\x00binary garbage")
        items = MemoryStore(vault=self.vault).vault_items("findable keyword", limit=5)
        self.assertTrue(items)

    def test_machine_written_trees_are_still_skipped(self):
        """verdicts/ and dotted dirs are engine output, not user knowledge."""
        os.makedirs(os.path.join(self.vault, "verdicts"))
        with open(os.path.join(self.vault, "verdicts", "v.md"), "w", encoding="utf-8") as fh:
            fh.write("# Verdict\n\nsentinel-verdict-text\n")
        items = MemoryStore(vault=self.vault).vault_items("sentinel-verdict-text", limit=5)
        blob = " ".join(i.content + i.id for i in items)
        self.assertNotIn("sentinel-verdict-text", blob)


if __name__ == "__main__":
    unittest.main()
