"""Task S2 — real disclosure: disclosed skills are INJECTED into the model
context (not merely recorded), the run/project CLI paths load a catalog, and
`--no-skills` opts out.

Offline throughout: the model is a fake that captures the prompt it receives,
so we can assert the disclosed-skill block actually reached the model. The
golden hooks order and the memory-budget invariant must survive untouched.
"""

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr

import _bootstrap  # noqa: F401

from scprism_engine.contract import parse
from scprism_engine.loop import run, _build_skill_context
from scprism_engine.context import CatalogEntry, DisclosedSkill
from scprism_engine.dispatcher import ModelResult
from scprism_engine.memory import MemoryStore
from scprism_engine.__main__ import main, _build_parser

GOLDEN_HOOKS = ["plan", "memory", "dispatch", "tier1", "tier2", "stop", "writeback"]
HEADER = "Relevant saved skills — follow the matching procedure:"


class _CapturingModel:
    """A fake dispatch model that records every prompt it is handed."""

    def __init__(self):
        self.prompts = []

    def __call__(self, prompt, route):
        self.prompts.append(prompt)
        return ModelResult(text=f"[fake:{route}] ok", tokens=1, route=route)


def _write_skill(vault, filename, *, name, when_to_use, body):
    skills_dir = os.path.join(vault, "skills")
    os.makedirs(skills_dir, exist_ok=True)
    with open(os.path.join(skills_dir, filename), "w", encoding="utf-8") as fh:
        fh.write(
            f"---\nname: {name}\ndescription: a test skill\n"
            f"when_to_use: {when_to_use}\n---\n\n{body}\n"
        )


class TestSkillInjectionEndToEnd(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_matching_skill_is_injected_disclosed_and_golden_order(self):
        from scprism_engine.skills import load_vault_skill_catalog

        _write_skill(
            self.vault,
            "test-skill.md",
            name="test-skill",
            when_to_use="add a retry guard",
            body="STEP ONE: always retry. STEP TWO: never crash.",
        )
        catalog = load_vault_skill_catalog(self.vault)
        capture = _CapturingModel()
        contract = parse("add a retry guard to the client", task_id="t-inject")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            skill_catalog=catalog,
            model=capture,
        )
        # Honest attribution: exactly the injected skill.
        self.assertEqual(verdict.disclosed, ["test-skill"])
        # The block reached the model — header + body are in the prompt.
        self.assertTrue(capture.prompts, "the model was actually called")
        first = capture.prompts[0]
        self.assertIn(HEADER, first)
        self.assertIn("STEP ONE: always retry", first)
        self.assertIn("## test-skill", first)
        # Golden hooks order byte-identical.
        self.assertEqual(verdict.hooks_fired, GOLDEN_HOOKS)

    def test_non_matching_intent_injects_nothing(self):
        _write_skill(
            self.vault,
            "test-skill.md",
            name="test-skill",
            when_to_use="add a retry guard",
            body="STEP ONE: always retry.",
        )
        from scprism_engine.skills import load_vault_skill_catalog

        catalog = load_vault_skill_catalog(self.vault)
        capture = _CapturingModel()
        contract = parse("summarize the changelog", task_id="t-clean")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            skill_catalog=catalog,
            model=capture,
        )
        self.assertEqual(verdict.disclosed, [])
        for p in capture.prompts:
            self.assertNotIn(HEADER, p)
            self.assertNotIn("STEP ONE", p)
        self.assertEqual(verdict.hooks_fired, GOLDEN_HOOKS)

    def test_empty_catalog_is_byte_identical(self):
        """No skills dir -> empty catalog -> no injection at all."""
        capture = _CapturingModel()
        contract = parse("add a retry guard to the client", task_id="t-empty")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            skill_catalog=[],
            model=capture,
        )
        self.assertEqual(verdict.disclosed, [])
        # Prompts are exactly the plan step descriptions (no prefix).
        self.assertTrue(capture.prompts)
        self.assertTrue(capture.prompts[0].startswith("Understand requirement:"))

    def test_top3_specificity_ordering_with_four_matches(self):
        # Intent contains all trigger words; specificity = matched trigger's
        # word count (desc), ties broken by catalog order.
        catalog = [
            CatalogEntry(name="A", triggers=["alpha"], instructions="a"),            # 1
            CatalogEntry(name="B", triggers=["alpha beta gamma"], instructions="b"), # 3
            CatalogEntry(name="C", triggers=["beta gamma"], instructions="c"),       # 2
            CatalogEntry(name="D", triggers=["gamma delta"], instructions="d"),      # 2
        ]
        contract = parse("alpha beta gamma delta epsilon", task_id="t-rank")
        verdict = run(
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            skill_catalog=catalog,
        )
        # Top 3 by specificity: B(3), then C(2) & D(2) in catalog order; A(1) dropped.
        self.assertEqual(verdict.disclosed, ["B", "C", "D"])

    def test_huge_skill_does_not_trip_memory_budget_assert(self):
        # A 50k-char skill body + a tiny memory budget: the skills block is
        # capped separately and must NOT be counted against memory_budget.
        store = MemoryStore(profile={"name": "Sukhdeep", "role": "founder"})
        catalog = [
            CatalogEntry(name="huge", triggers=["retry"], instructions="x" * 50000),
        ]
        contract = parse("add a retry guard", task_id="t-huge")
        verdict = run(  # must not raise the memory-budget AssertionError
            contract,
            vault=self.vault,
            tier1_commands=["true"],
            skill_catalog=catalog,
            memory=store,
            session_id="t-huge",
            memory_budget=50,
        )
        self.assertEqual(verdict.disclosed, ["huge"])
        total = sum(m["tokens"] for m in verdict.memory_injected)
        self.assertLessEqual(total, 50)


class TestSkillBlockBuilder(unittest.TestCase):
    """Unit tests for the block builder — the 4000-char cap in particular."""

    def test_cap_truncates_overflowing_skill_and_drops_the_rest(self):
        disclosed = [
            DisclosedSkill(name="first", instructions="f" * 3000, tokens=1, matched_on="a b"),
            DisclosedSkill(name="second", instructions="s" * 3000, tokens=1, matched_on="a"),
        ]
        block, injected = _build_skill_context(disclosed)
        self.assertLessEqual(len(block), 4000)
        self.assertTrue(block.startswith(HEADER))
        # First fits whole; second is truncated to fill the cap (still injected).
        self.assertIn("## first", block)
        self.assertEqual(injected[0], "first")
        self.assertIn("second", injected)

    def test_single_huge_skill_capped_to_4000(self):
        disclosed = [
            DisclosedSkill(name="huge", instructions="x" * 100000, tokens=1, matched_on="x"),
        ]
        block, injected = _build_skill_context(disclosed)
        self.assertLessEqual(len(block), 4000)
        self.assertEqual(injected, ["huge"])

    def test_empty_disclosed_yields_empty_block(self):
        block, injected = _build_skill_context([])
        self.assertEqual(block, "")
        self.assertEqual(injected, [])


class TestNoSkillsFlagWiring(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_run_and_project_parsers_have_no_skills_flag(self):
        parser = _build_parser()
        run_args = parser.parse_args(["run", "intent", "--vault", self.vault])
        self.assertFalse(run_args.no_skills)
        run_args2 = parser.parse_args(["run", "intent", "--vault", self.vault, "--no-skills"])
        self.assertTrue(run_args2.no_skills)
        proj_args = parser.parse_args(
            ["project", "intent", "--project-dir", self.vault, "--vault", self.vault]
        )
        self.assertFalse(proj_args.no_skills)
        proj_args2 = parser.parse_args(
            ["project", "intent", "--project-dir", self.vault, "--vault", self.vault, "--no-skills"]
        )
        self.assertTrue(proj_args2.no_skills)

    def test_cli_run_loads_catalog_unless_no_skills(self):
        _write_skill(
            self.vault,
            "test-skill.md",
            name="test-skill",
            when_to_use="add a retry guard",
            body="STEP ONE: always retry.",
        )
        # Without --no-skills: the catalog loads and the matching skill discloses.
        code, obj = self._run_cli(
            ["run", "add a retry guard to the client", "--vault", self.vault, "--tier1", "true"]
        )
        self.assertEqual(code, 0)
        self.assertEqual(obj["disclosed"], ["test-skill"])
        # With --no-skills: no catalog is loaded, nothing discloses.
        code2, obj2 = self._run_cli(
            ["run", "add a retry guard to the client", "--vault", self.vault,
             "--tier1", "true", "--no-skills"]
        )
        self.assertEqual(code2, 0)
        self.assertEqual(obj2["disclosed"], [])

    @staticmethod
    def _run_cli(argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
        text = out.getvalue().strip()
        return code, (json.loads(text) if text else None)


if __name__ == "__main__":
    unittest.main()
