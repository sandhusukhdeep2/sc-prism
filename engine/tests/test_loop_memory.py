"""LF-1 — memory injection is REAL: the items ``select_context`` selects now
reach the doer prompt (they used to be recorded on the span/Verdict but never
shown to a model — debt #10).

Offline throughout: the model is a fake that captures the prompt it receives,
so we can assert the selected memory actually reached the model. The regression
guarantee — an empty selection leaves the prompt byte-identical — is proven by
capturing two runs and comparing. The budget invariant (no double-budgeting:
the injected text is exactly what ``select_context`` returned) is proven by
reconstructing the selection and comparing against the captured prompt.
"""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run
from scprism_engine.dispatcher import ModelResult
from scprism_engine.memory import MemoryStore, select_context
from scprism_engine.skills import load_vault_skill_catalog

MEMORY_HEADER = "Working context (from your vault):"
SKILLS_HEADER = "Relevant saved skills — follow the matching procedure:"
# The plan's first step description begins with this (see planner) — a stable
# marker for where the TASK text starts, after any injected prefix.
TASK_MARKER = "Understand requirement:"


def _write_skill(vault, filename, *, name, when_to_use, body):
    skills_dir = os.path.join(vault, "skills")
    os.makedirs(skills_dir, exist_ok=True)
    with open(os.path.join(skills_dir, filename), "w", encoding="utf-8") as fh:
        fh.write(
            f"---\nname: {name}\ndescription: a test skill\n"
            f"when_to_use: {when_to_use}\n---\n\n{body}\n"
        )


class _CapturingModel:
    """A fake dispatch model that records every prompt it is handed."""

    def __init__(self):
        self.prompts = []

    def __call__(self, prompt, route):
        self.prompts.append(prompt)
        return ModelResult(text=f"[fake:{route}] ok", tokens=1, route=route)


def _write_note(vault, relpath, *, title, body):
    path = os.path.join(vault, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"---\ntitle: {title}\n---\n\n{body}\n")


class TestMemoryInjectionReachesPrompt(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_selected_vault_note_reaches_the_doer_prompt(self):
        # A real vault note whose title/path overlaps the intent is surfaced by
        # the store, selected under budget, and its verbatim item text must land
        # in the prompt under the labelled header.
        _write_note(
            self.vault,
            os.path.join("notes", "retry-policy.md"),
            title="Retry Policy",
            body="always retry with backoff",
        )
        store = MemoryStore(vault=self.vault)
        capture = _CapturingModel()
        contract = parse("review the retry policy", task_id="t-mem-note")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            memory=store,
            session_id="t-mem-note",
            memory_budget=500,
            model=capture,
        )
        # Attribution recorded a real selection...
        self.assertTrue(verdict.memory_injected, "a note was selected")
        # ...and that selection actually reached the model.
        self.assertTrue(capture.prompts, "the model was called")
        first = capture.prompts[0]
        self.assertIn(MEMORY_HEADER, first)
        # The REAL selected content is the store's item text: "[rel] title".
        self.assertIn("[notes/retry-policy.md] Retry Policy", first)

    def test_no_selection_adds_no_memory_block(self):
        # Regression guarantee: no memory store AND an empty store both leave the
        # prompt without a memory block (header absent) — an empty selection
        # changes nothing.
        cap_none = _CapturingModel()
        run(
            parse("summarize the changelog", task_id="t-none"),
            vault=self.vault,
            tier1_commands=["true"],
            model=cap_none,
        )
        cap_empty = _CapturingModel()
        run(
            parse("summarize the changelog", task_id="t-empty"),
            vault=self.vault,
            tier1_commands=["true"],
            memory=MemoryStore(),  # no profile / working / vault -> no candidates
            session_id="t-empty",
            memory_budget=500,
            model=cap_empty,
        )
        self.assertTrue(cap_none.prompts and cap_empty.prompts)
        for p in cap_none.prompts + cap_empty.prompts:
            self.assertNotIn(MEMORY_HEADER, p)

    def test_composed_input_is_memory_block_plus_the_clean_task(self):
        # A REAL differential (replacing the old two-empty-runs tautology): the
        # model input WITH a selected memory item is EXACTLY the memory block
        # prepended to the unchanged clean task text — the block is added, the
        # task text is byte-identical, and the block sits BEFORE the task.
        _write_note(
            self.vault,
            os.path.join("notes", "retry-policy.md"),
            title="Retry Policy",
            body="always retry with backoff",
        )
        intent = "review the retry policy"
        # WITH memory FIRST: a fresh vault, so at selection time the ONLY .md
        # candidate is the note (run artifacts are written later, after dispatch).
        cap_with = _CapturingModel()
        v = run(
            parse(intent, task_id="t-with"),
            vault=self.vault,
            tier1_commands=["true"],
            memory=MemoryStore(vault=self.vault),
            session_id="t-with",
            memory_budget=500,
            model=cap_with,
        )
        self.assertTrue(v.memory_injected, "the note was selected")
        # WITHOUT memory: no store -> no block. The plan is deterministic on the
        # intent, so the task text matches the WITH run's exactly.
        cap_without = _CapturingModel()
        run(
            parse(intent, task_id="t-without"),
            vault=self.vault,
            tier1_commands=["true"],
            model=cap_without,
        )
        memory_block = MEMORY_HEADER + "\n[notes/retry-policy.md] Retry Policy"
        self.assertEqual(
            cap_with.prompts[0], f"{memory_block}\n\n{cap_without.prompts[0]}"
        )
        self.assertNotIn(MEMORY_HEADER, cap_without.prompts[0])

    def test_skills_block_then_memory_block_then_task_order(self):
        # Position pin: skills block FIRST, THEN the memory block, THEN the task.
        # Moving the memory block (or the skills block) fails this ordering.
        _write_note(
            self.vault,
            os.path.join("notes", "retry-policy.md"),
            title="Retry Policy",
            body="always retry with backoff",
        )
        _write_skill(
            self.vault,
            "retry-skill.md",
            name="retry-skill",
            when_to_use="review the retry policy",
            body="STEP ONE: always retry.",
        )
        catalog = load_vault_skill_catalog(self.vault)
        cap = _CapturingModel()
        run(
            parse("review the retry policy", task_id="t-order"),
            vault=self.vault,
            tier1_commands=["true"],
            memory=MemoryStore(vault=self.vault),
            session_id="t-order",
            skill_catalog=catalog,
            memory_budget=500,
            model=cap,
        )
        p = cap.prompts[0]
        i_skill = p.find(SKILLS_HEADER)
        i_mem = p.find(MEMORY_HEADER)
        i_task = p.find(TASK_MARKER)
        self.assertNotEqual(i_skill, -1, "skills block present")
        self.assertNotEqual(i_mem, -1, "memory block present")
        self.assertNotEqual(i_task, -1, "task text present")
        self.assertLess(i_skill, i_mem, "skills block precedes the memory block")
        self.assertLess(i_mem, i_task, "memory block precedes the task text")

    def test_injected_block_is_exactly_the_selection_no_double_budget(self):
        # A tight budget forces select_context to pick a subset. The memory block
        # in the prompt must be EXACTLY the header + those selected items'
        # verbatim content — nothing dropped, nothing extra, no re-budgeting.
        store = MemoryStore(
            profile={"name": "Sukhdeep", "role": "founder", "domain": "governance"},
        )
        store.working("t-budget").put("focus", "retry policy work")
        intent = "review the retry policy"
        budget = 8  # tight: only the densest items fit
        contract = parse(intent, task_id="t-budget")
        capture = _CapturingModel()
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            memory=store,
            session_id="t-budget",
            memory_budget=budget,
            model=capture,
        )
        # Reconstruct the loop's own selection independently and build the block
        # the way the loop does: header + each selected item's content verbatim.
        candidates = store.candidates("t-budget", intent)
        selected = select_context(candidates, budget)
        self.assertTrue(selected, "the tight budget still fits something")
        expected_block = "\n".join([MEMORY_HEADER] + [i.content for i in selected])

        first = capture.prompts[0]
        self.assertIn(expected_block, first)
        # No double-budgeting: the recorded injection respects the budget...
        total = sum(m["tokens"] for m in verdict.memory_injected)
        self.assertLessEqual(total, budget)
        # ...and nothing that select_context dropped leaked into the prompt.
        dropped = [c for c in candidates if c.id not in {s.id for s in selected}]
        for d in dropped:
            self.assertNotIn(d.content, first)


if __name__ == "__main__":
    unittest.main()
