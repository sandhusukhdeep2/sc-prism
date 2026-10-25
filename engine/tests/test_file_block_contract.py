"""A turn that answers in prose writes nothing — and used to say so badly.

Found by real use. A refine run (already improved to show the model the failing
tests AND its own source) came back with 17,777 characters beginning "Let me
analyze the failing tests and the current code to understand what's broken. The
test expects: - 5 agent runs (pass: 3, pen…". Real analysis — and not one
`===FILE:===` block. Writeback therefore landed nothing, the project files
stayed byte-identical (verified by mtime), and the step failed as though the
model had tried and failed. It happened on BOTH refine attempts, which is why
that loop never converged.

The prose was good. The OUTPUT CONTRACT was missed. So:

  * the format requirement is LAST in the prompt and says plainly that an
    analysis-only reply is rejected;
  * a completion with zero file blocks is not accepted in silence — it buys ONE
    explicit correction, and the correction can never be corrected in turn;
  * if the second reply is also analysis, the Verdict SAYS SO, so a user can
    tell "it couldn't fix it" from "it never tried to write".

A first build gets exactly the same treatment as a refine: same prompt builder,
same parser, same way to miss the contract.
"""

import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.dispatcher import ModelResult
from scprism_engine.project import (
    FILE_BLOCK_INSTRUCTIONS,
    NO_FILE_BLOCK_CORRECTION,
    run_project,
)

BLOCK = "===FILE: digest.js===\nmodule.exports = () => 'v2'\n===END==="

PROSE = (
    "Let me analyze the failing tests and the current code to understand "
    "what's broken. The test expects: - 5 agent runs (pass: 3, pending: 2). "
    "The parser reads the header row as data, which is why the count is off "
    "by one."
)


def recording_model(*, reply_to_correction=None, always=None):
    """A `dispatcher.ModelCall` that records every prompt it was handed.

    `always` answers everything with one text. `reply_to_correction` answers
    PROSE until the prompt carries `NO_FILE_BLOCK_CORRECTION`, then answers with
    that text — the shape of a model that only needed to be told the format.
    """
    prompts = []

    def _call(prompt: str, route: str) -> ModelResult:
        prompts.append(prompt)
        if always is not None:
            text = always
        elif NO_FILE_BLOCK_CORRECTION in prompt:
            text = reply_to_correction
        else:
            text = PROSE
        return ModelResult(text=text, tokens=max(1, len(text) // 4), route=route)

    _call.prompts = prompts  # type: ignore[attr-defined]
    return _call


def verdict_reason_text(verdict) -> str:
    return verdict.tier1.get("log", "") or ""


def corrections(model) -> int:
    return sum(1 for p in model.prompts if NO_FILE_BLOCK_CORRECTION in p)


class TheFormatRequirementIsLast(unittest.TestCase):
    def test_a_first_build_prompt_ends_with_the_file_block_contract(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        model = recording_model(always=BLOCK)
        run_project("build a digest", project_dir=proj, vault=vault, model=model)
        self.assertTrue(
            any(p.endswith(FILE_BLOCK_INSTRUCTIONS) for p in model.prompts),
            "no dispatched prompt ended with the FILE-block contract",
        )

    def test_a_refine_prompt_ends_with_it_too_after_the_feedback_and_source(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        with open(os.path.join(proj, "digest.js"), "w") as fh:
            fh.write("module.exports = () => 'v1'\n")
        model = recording_model(always=BLOCK)
        run_project(
            "fix the digest",
            project_dir=proj,
            vault=vault,
            refine_feedback="FAILED: expected 5 runs, got 4",
            model=model,
        )
        ends = [p for p in model.prompts if p.endswith(FILE_BLOCK_INSTRUCTIONS)]
        self.assertTrue(ends, "no refine prompt ended with the FILE-block contract")
        # The feedback and the source excerpt are ABOVE it — the contract is the
        # last thing the model reads before answering.
        self.assertIn("FAILED: expected 5 runs", ends[0])
        self.assertLess(
            ends[0].index("FAILED: expected 5 runs"),
            ends[0].index(FILE_BLOCK_INSTRUCTIONS),
        )

    def test_the_contract_says_an_analysis_only_reply_is_rejected(self):
        self.assertIn("REJECTED", FILE_BLOCK_INSTRUCTIONS)
        self.assertIn("analysis", FILE_BLOCK_INSTRUCTIONS)


class AProseOnlyCompletionIsCorrectedOnce(unittest.TestCase):
    def test_one_retry_and_the_correction_is_explicit(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        model = recording_model(reply_to_correction=BLOCK)
        run_project("build a digest", project_dir=proj, vault=vault, model=model)
        # Every prose reply bought exactly ONE correction, and no correction was
        # itself corrected (that would show as a prompt carrying it twice).
        self.assertGreaterEqual(corrections(model), 1)
        for p in model.prompts:
            self.assertLessEqual(p.count(NO_FILE_BLOCK_CORRECTION), 1)
        # The correction says what was wrong and what to do instead.
        correction = next(p for p in model.prompts if NO_FILE_BLOCK_CORRECTION in p)
        self.assertIn("no ===FILE:=== blocks", correction)
        self.assertIn("nothing else", correction)

    def test_a_retry_that_produces_blocks_writes_them(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        model = recording_model(reply_to_correction=BLOCK)
        verdict = run_project(
            "build a digest", project_dir=proj, vault=vault, model=model
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        written = os.path.join(proj, "digest.js")
        self.assertTrue(os.path.exists(written), "the corrected reply wrote nothing")
        with open(written) as fh:
            self.assertIn("v2", fh.read())

    def test_a_second_prose_reply_fails_with_the_specific_reason(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        model = recording_model(reply_to_correction=PROSE)
        verdict = run_project(
            "build a digest", project_dir=proj, vault=vault, model=model
        )
        self.assertFalse(verdict.passed)
        reason = verdict_reason_text(verdict)
        # The user can tell "it couldn't fix it" from "it never tried to write".
        self.assertIn("analysis but no file blocks", reason)
        self.assertIn("asked once more", reason)
        self.assertEqual(os.listdir(proj), [], "nothing may be written")
        # Still bounded: the correction was never corrected.
        for p in model.prompts:
            self.assertLessEqual(p.count(NO_FILE_BLOCK_CORRECTION), 1)

    def test_a_refine_turn_gets_the_same_treatment(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        with open(os.path.join(proj, "digest.js"), "w") as fh:
            fh.write("module.exports = () => 'v1'\n")
        model = recording_model(reply_to_correction=BLOCK)
        verdict = run_project(
            "fix the digest",
            project_dir=proj,
            vault=vault,
            refine_feedback="FAILED: expected 5 runs, got 4",
            model=model,
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        self.assertGreaterEqual(corrections(model), 1)
        with open(os.path.join(proj, "digest.js")) as fh:
            self.assertIn("v2", fh.read())


class TheOrdinaryPathIsUnchanged(unittest.TestCase):
    def test_a_completion_with_blocks_costs_no_extra_call(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        model = recording_model(always=BLOCK)
        verdict = run_project(
            "build a digest", project_dir=proj, vault=vault, model=model
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        self.assertEqual(corrections(model), 0, "a good completion was retried")

    def test_an_offline_stub_is_never_retried(self):
        """A stub is a diagnostic, not a contract miss: asking a keyless
        gateway twice would only buy the same stub. The reason stays the plain
        one, and no correction is ever sent."""
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        model = recording_model(always="[offline: no provider configured]")
        verdict = run_project(
            "build a digest", project_dir=proj, vault=vault, model=model
        )
        self.assertFalse(verdict.passed)
        self.assertEqual(corrections(model), 0)
        reason = verdict_reason_text(verdict)
        # The provider never answered — the reason now NAMES that (2026-08-31);
        # the fail-closed contract this test guards is unchanged.
        self.assertIn("never answered", reason)
        self.assertNotIn("analysis but no file blocks", reason)

    def test_an_instruction_echo_still_reports_itself_as_an_echo(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        echo = "===FILE: relative/path.ext===\n<full file content>\n===END==="
        model = recording_model(always=echo)
        verdict = run_project(
            "build a digest", project_dir=proj, vault=vault, model=model
        )
        self.assertFalse(verdict.passed)
        self.assertIn("instruction echo", verdict_reason_text(verdict))
        # It USED the format, so it is not a contract miss — no correction.
        self.assertEqual(corrections(model), 0)


if __name__ == "__main__":
    unittest.main()
