"""L2 working memory finally has a writer (2026-11-11).

`WorkingMemory.put()` had no caller, and the loop injects memory once, at the
start of a run, when a fresh process's working memory is necessarily empty —
so the tier the Memory page describes never held anything. A project build is
several engine processes, one per plan step, so its working memory lives on
disk between them: each step records its outcome, the next step is shown the
outcomes so far, and a new build starts clean.
"""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.dispatcher import ModelResult
from scprism_engine.memory import L2, MemoryStore, working_path
from scprism_engine.project import run_project


class TestWorkingMemoryPersists(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_what_one_process_records_the_next_process_reads(self):
        first = MemoryStore(vault=self.vault)
        first.working("project:site").put("step: draft the page", "passed — wrote index.html")
        first.save_working("project:site")

        second = MemoryStore(vault=self.vault)
        self.assertEqual(second.load_working("project:site"), 1)
        items = second.candidates("project:site", "anything")
        l2 = [i for i in items if i.tier == L2]
        self.assertEqual(len(l2), 1)
        self.assertIn("step: draft the page: passed — wrote index.html", l2[0].content)

    def test_it_lives_outside_the_notes_in_a_hidden_folder(self):
        store = MemoryStore(vault=self.vault)
        store.working("project:site").put("k", "v")
        store.save_working("project:site")
        path = working_path(self.vault, "project:site")
        self.assertTrue(os.path.isfile(path))
        self.assertIn(os.path.join(".scprism", "working"), path)

    def test_one_project_never_reads_anothers(self):
        store = MemoryStore(vault=self.vault)
        store.working("project:site").put("k", "site only")
        store.save_working("project:site")
        other = MemoryStore(vault=self.vault)
        self.assertEqual(other.load_working("project:shop"), 0)
        self.assertEqual([i for i in other.candidates("project:shop", "x") if i.tier == L2], [])

    def test_reset_discards_it_in_memory_and_on_disk(self):
        store = MemoryStore(vault=self.vault)
        store.working("project:site").put("k", "v")
        store.save_working("project:site")
        store.reset_working("project:site")
        self.assertFalse(os.path.exists(working_path(self.vault, "project:site")))
        self.assertEqual(MemoryStore(vault=self.vault).load_working("project:site"), 0)

    def test_it_keeps_only_the_newest_entries(self):
        store = MemoryStore(vault=self.vault)
        wm = store.working("project:site")
        for n in range(20):
            wm.put(f"step {n}", "done")
        store.save_working("project:site")
        again = MemoryStore(vault=self.vault)
        self.assertEqual(again.load_working("project:site"), 8)
        self.assertEqual(again.working("project:site").keys()[0], "step 12")

    def test_a_damaged_file_is_an_empty_memory_never_a_crash(self):
        path = working_path(self.vault, "project:site")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{ not json")
        self.assertEqual(MemoryStore(vault=self.vault).load_working("project:site"), 0)


class TestProjectStepsShareWorkingMemory(unittest.TestCase):
    """Two plan steps = two run_project calls, as the app launches them."""

    FILE_REPLY = "===FILE: index.html===\n<h1>hi</h1>\n===END===\n"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = os.path.join(self._tmp.name, "vault")
        self.proj = os.path.join(self._tmp.name, "site")
        os.makedirs(self.vault)
        os.makedirs(self.proj)
        self.prompts = []

    def tearDown(self):
        self._tmp.cleanup()

    def _model(self):
        def _call(prompt: str, route: str) -> ModelResult:
            self.prompts.append(prompt)
            return ModelResult(text=self.FILE_REPLY, tokens=10, route=route)

        return _call

    def _step(self, intent, stage, **kw):
        return run_project(
            intent,
            project_dir=self.proj,
            vault=self.vault,
            slug="site",
            stage=stage,
            model=self._model(),
            memory=MemoryStore(vault=self.vault),
            **kw,
        )

    def test_the_second_step_is_shown_what_the_first_step_did(self):
        self._step("build the page", "1 · build the page", working_reset=True)
        first_count = len(self.prompts)
        self._step("add the footer", "2 · add the footer")
        later = "\n".join(self.prompts[first_count:])
        self.assertIn("1 · build the page", later)
        self.assertIn("index.html", later)

    def test_the_first_step_of_a_build_sees_nothing_from_the_last_build(self):
        self._step("build the page", "1 · build the page", working_reset=True)
        self._step("add the footer", "2 · add the footer")
        before = len(self.prompts)
        # A new build of the same project starts clean.
        self._step("rebuild the page", "1 · rebuild the page", working_reset=True)
        fresh = "\n".join(self.prompts[before:])
        self.assertNotIn("add the footer", fresh)

    def test_without_a_memory_store_nothing_is_written(self):
        run_project("build the page", project_dir=self.proj, vault=self.vault, slug="site", model=self._model())
        self.assertFalse(os.path.exists(working_path(self.vault, "project:site")))
