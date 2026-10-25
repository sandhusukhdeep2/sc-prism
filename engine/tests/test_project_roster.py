"""P1-2: `run_project` runs the role board as the per-step doer when a roster
is given, producing ONE governed Verdict — while the single-doer path (no
roster) stays byte-identical.

The board is faked at the Gateway seam (`Gateway.model_call`): routing
(`Gateway.route`) still runs for REAL per agent, so the models the board lists
are derived from real provider assignment — exactly what the Verdict's
`models_used` must reflect. A "real" fake returns a FILE-block completion (the
board did work); an "offline" fake returns a `[offline:...]` completion that
`loop.run`'s textual guard must fail closed.
"""

import glob
import os
import tempfile
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine import gateway as gw_module
from scprism_engine import team as team_module
from scprism_engine.dispatcher import ModelResult
from scprism_engine.project import run_project
from scprism_engine.skills import load_vault_skill_catalog
from scprism_engine.team import AgentSpec


FILE_BLOCK = "===FILE: index.html===\n<html>from the board</html>\n===END===\nDone."

# Golden hooks order for a project step: post_dispatch present, Tier-1 passes so
# Tier-2 runs. Identical whether the doer is a single model or the role board —
# the roster only swaps WHICH model callable dispatch invokes.
GOLDEN_HOOKS = [
    "plan",
    "memory",
    "dispatch",
    "project_writes",
    "tier1",
    "tier2",
    "stop",
    "writeback",
]


def real_board_model_call(self, messages, route):
    """A REAL (non-stub) board contribution carrying a FILE block. Echoes the
    per-agent route's provider/model so `run_role_board`'s models_used stays
    derived from REAL routing (not from this double)."""
    return gw_module.ModelCallResult(
        text=FILE_BLOCK,
        tokens_in=4,
        tokens_out=4,
        cache="miss",
        provider=route.provider,
        model=route.model,
        is_real=True,
    )


def offline_board_model_call(self, messages, route):
    """A fully-stubbed board: an `[offline:...]` completion `loop.run` must
    filter out of `project_completion` (fail closed — no file writer ever sees
    a stub)."""
    return gw_module.ModelCallResult(
        text=f"[offline:{route.provider}:{route.model}] handled",
        tokens_in=2,
        tokens_out=2,
        cache="miss",
        provider=route.provider,
        model=route.model,
        is_real=False,
    )


def make_fake_model(text):
    """A `dispatcher.ModelCall`-shaped single-doer double (same shape the
    existing project tests use)."""

    def _call(prompt, route):
        return ModelResult(text=text, tokens=max(1, len(text) // 4), route=route)

    return _call


def verdict_reason_text(verdict):
    return verdict.tier1.get("log", "") or ""


def verdict_project_dict(verdict):
    return (verdict.extras or {}).get("project", {})


def default_roster():
    # Three DISTINCT providers so the governed Verdict's models_used lists >1.
    return [
        AgentSpec("lead", "Lead and synthesize.", "claude"),
        AgentSpec("planner", "Plan the work.", "gemini"),
        AgentSpec("developer", "Implement it.", "local"),
    ]


class RosterPathTest(unittest.TestCase):
    def test_roster_board_writes_files_one_verdict_multi_model(self):
        """Roster path: the board (real fake) emits a FILE block -> files
        written, ONE passing Verdict, and models_used lists >1 model derived
        from the roster's REAL per-agent routing."""
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        with mock.patch.object(
            gw_module.Gateway, "model_call", real_board_model_call
        ):
            verdict = run_project(
                "build a landing page",
                project_dir=proj,
                vault=vault,
                roster=default_roster(),
            )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        # Files the board's FILE block asked for are on disk.
        self.assertTrue(os.path.exists(os.path.join(proj, "index.html")))
        self.assertEqual(verdict_project_dict(verdict)["files_written"], ["index.html"])
        # ONE governed Verdict whose models_used reflects the BOARD's models.
        self.assertGreater(
            len(verdict.models_used), 1,
            f"expected >1 board model, got {verdict.models_used}",
        )
        providers = {m.split(" · ")[0] for m in verdict.models_used}
        self.assertEqual(providers, {"claude", "gemini", "local"})

    def test_roster_persists_board_into_run_vault(self):
        """CRITICAL: the board must persist into the RUN's vault (SCPRISM_VAULT
        threaded through the adapter env), not a leaked temp dir."""
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        with mock.patch.object(
            gw_module.Gateway, "model_call", real_board_model_call
        ):
            run_project(
                "build a landing page",
                project_dir=proj,
                vault=vault,
                roster=default_roster(),
            )
        boards = glob.glob(os.path.join(vault, "agents", "board-*.jsonl"))
        self.assertTrue(boards, f"no board persisted under {vault}/agents")

    def test_roster_hooks_order_matches_single_doer_golden(self):
        """Golden `hooks_fired` order is unchanged by the roster: identical to
        the single-doer path."""
        proj_r, vault_r = tempfile.mkdtemp(), tempfile.mkdtemp()
        with mock.patch.object(
            gw_module.Gateway, "model_call", real_board_model_call
        ):
            roster_v = run_project(
                "build a landing page",
                project_dir=proj_r,
                vault=vault_r,
                roster=default_roster(),
            )
        proj_s, vault_s = tempfile.mkdtemp(), tempfile.mkdtemp()
        single_v = run_project(
            "build a landing page",
            project_dir=proj_s,
            vault=vault_s,
            model=make_fake_model(FILE_BLOCK),
        )
        self.assertEqual(single_v.hooks_fired, GOLDEN_HOOKS)
        self.assertEqual(roster_v.hooks_fired, single_v.hooks_fired)


class AbsentRosterByteIdenticalTest(unittest.TestCase):
    def test_no_roster_single_doer_unchanged(self):
        """No roster -> the single-doer path is byte-identical to today: same
        passing verdict shape, files written, golden hooks order, and NO board
        models leaked into models_used."""
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        verdict = run_project(
            "build a page",
            project_dir=proj,
            vault=vault,
            model=make_fake_model(FILE_BLOCK),
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        self.assertTrue(os.path.exists(os.path.join(proj, "index.html")))
        self.assertEqual(verdict.hooks_fired, GOLDEN_HOOKS)
        self.assertEqual(verdict.models_used, [])


class ExplicitModelBeatsRosterTest(unittest.TestCase):
    def test_explicit_model_wins_over_roster(self):
        """An explicit `model` still wins: the roster only builds a doer when
        no model was passed. The board is never consulted."""
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        explicit = make_fake_model("===FILE: explicit.txt===\nfrom explicit\n===END===")
        # If the roster were (wrongly) used, its model_call would emit index.html
        # and blow up the assertions below; patch it to the real board fake so a
        # regression is loud, not silently offline.
        with mock.patch.object(
            gw_module.Gateway, "model_call", real_board_model_call
        ):
            verdict = run_project(
                "build a landing page",
                project_dir=proj,
                vault=vault,
                model=explicit,
                roster=default_roster(),
            )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        self.assertTrue(os.path.exists(os.path.join(proj, "explicit.txt")))
        self.assertFalse(os.path.exists(os.path.join(proj, "index.html")))
        # Explicit model path routes nothing through the board -> no board models.
        self.assertEqual(verdict.models_used, [])


class StubbedBoardFailsClosedTest(unittest.TestCase):
    def test_offline_board_fails_closed_no_writes(self):
        """A fully-stubbed board (offline completions) must fail closed: the
        `[offline:` guard keeps a stub out of the file writer, so no files are
        written and the Verdict fails with 'no file blocks'."""
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        with mock.patch.object(
            gw_module.Gateway, "model_call", offline_board_model_call
        ):
            verdict = run_project(
                "build a landing page",
                project_dir=proj,
                vault=vault,
                roster=default_roster(),
            )
        self.assertFalse(verdict.passed)
        self.assertIn("never answered", verdict_reason_text(verdict))
        self.assertFalse(os.path.exists(os.path.join(proj, "index.html")))
        # Tier-2 short-circuited on the Tier-1-style failure: no "tier2" hook.
        self.assertNotIn("tier2", verdict.hooks_fired)


# ---------------------------------------------------------------------------
# P3-1 fix: on the ROSTER path skills disclose PER-AGENT through the board, not
# globally through loop.run. A `roles: developer` skill must reach only the
# developer agent; a global skill reaches every agent; Verdict.disclosed stays
# honest (the union the board actually injected). The no-roster single-doer path
# is unchanged (loop.run still discloses globally, role tags ignored).
# ---------------------------------------------------------------------------
def _write_scoped_skills(vault):
    """Two vault skills matching the intent's "build" trigger: one scoped to
    `developer`, one global (no roles). Returns the loaded catalog."""
    skills_dir = os.path.join(vault, "skills")
    os.makedirs(skills_dir, exist_ok=True)
    with open(os.path.join(skills_dir, "a-global.md"), "w", encoding="utf-8") as fh:
        fh.write(
            "---\nname: global-note\nwhen_to_use: build\n---\n"
            "GLOBAL_SCOPED_BODY: keep it simple.\n"
        )
    with open(os.path.join(skills_dir, "b-dev.md"), "w", encoding="utf-8") as fh:
        fh.write(
            "---\nname: dev-testing\nwhen_to_use: build\nroles: developer\n---\n"
            "DEVELOPER_SCOPED_BODY: run the tests before shipping.\n"
        )
    return load_vault_skill_catalog(vault)


def make_recording_board_model_call(calls):
    """A real (non-stub) board `Gateway.model_call` double that RECORDS each
    agent's user prompt keyed by provider (so per-agent disclosure is
    assertable) and returns a FILE block so the step passes."""

    def _mc(self, messages, route):
        user = "\n".join(
            str(m.get("content", "")) for m in messages if m.get("role") == "user"
        )
        calls.append({"provider": route.provider, "user": user})
        return gw_module.ModelCallResult(
            text=FILE_BLOCK,
            tokens_in=4,
            tokens_out=4,
            cache="miss",
            provider=route.provider,
            model=route.model,
            is_real=True,
        )

    return _mc


class RosterPerAgentDisclosureTest(unittest.TestCase):
    def test_roster_discloses_per_agent_and_attributes(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        catalog = _write_scoped_skills(vault)
        calls = []
        with mock.patch.object(
            gw_module.Gateway, "model_call", make_recording_board_model_call(calls)
        ):
            verdict = run_project(
                "build a landing page",
                project_dir=proj,
                vault=vault,
                roster=default_roster(),  # lead=claude, planner=gemini, developer=local
                skill_catalog=catalog,
            )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))

        developer = "\n".join(c["user"] for c in calls if c["provider"] == "local")
        planner = "\n".join(c["user"] for c in calls if c["provider"] == "gemini")
        lead = "\n".join(c["user"] for c in calls if c["provider"] == "claude")

        # The developer-scoped skill reaches ONLY the developer agent.
        self.assertIn("DEVELOPER_SCOPED_BODY", developer)
        self.assertNotIn("DEVELOPER_SCOPED_BODY", planner)
        self.assertNotIn("DEVELOPER_SCOPED_BODY", lead)
        # The global skill reaches EVERY agent.
        self.assertIn("GLOBAL_SCOPED_BODY", developer)
        self.assertIn("GLOBAL_SCOPED_BODY", planner)
        self.assertIn("GLOBAL_SCOPED_BODY", lead)
        # Attribution stays honest: Verdict.disclosed is the injected union.
        self.assertEqual(sorted(verdict.disclosed), ["dev-testing", "global-note"])

    def test_no_roster_single_doer_still_discloses_globally(self):
        """Byte-identical single-doer path: loop.run discloses the SAME catalog
        globally (role=""), so a role-tagged skill still reaches the single doer
        and is attributed — role scoping only applies on the board path."""
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        catalog = _write_scoped_skills(vault)
        prompts = []

        def recording_doer(prompt, route):
            prompts.append(prompt)
            return ModelResult(text=FILE_BLOCK, tokens=max(1, len(prompt) // 4), route=route)

        verdict = run_project(
            "build a landing page",
            project_dir=proj,
            vault=vault,
            model=recording_doer,  # single doer, NO roster
            skill_catalog=catalog,
        )
        self.assertTrue(verdict.passed, verdict_reason_text(verdict))
        joined = "\n".join(prompts)
        # loop.run's global disclosure ignores role tags -> both bodies present.
        self.assertIn("DEVELOPER_SCOPED_BODY", joined)
        self.assertIn("GLOBAL_SCOPED_BODY", joined)
        self.assertEqual(sorted(verdict.disclosed), ["dev-testing", "global-note"])


if __name__ == "__main__":
    unittest.main()


class RefineOnTheLeadTest(unittest.TestCase):
    """A REFINE turn runs on the LEAD alone, never the whole board (2026-08-29).

    Measured live: a four-seat board step takes 15-20 minutes end to end, and a
    failed step re-ran the ENTIRE board to apply one piece of feedback — the
    single biggest time-eater of the first real build. A refine is the lead's
    kind of work by definition: it holds the previous attempt's files and the
    judge's feedback, and its job is a corrected synthesis, not a new debate.
    The first attempt keeps the full board, byte-identical.
    """

    def test_refine_turn_uses_the_lead_alone(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        board_calls = []
        real_adapter = team_module.team_model_adapter

        def spying_adapter(*a, **kw):
            board_calls.append(1)
            return real_adapter(*a, **kw)

        with mock.patch.object(team_module, "team_model_adapter", spying_adapter), \
                mock.patch.object(gw_module.Gateway, "model_call", real_board_model_call):
            verdict = run_project(
                "build a landing page",
                project_dir=proj,
                vault=vault,
                roster=default_roster(),
                refine_feedback="the previous attempt missed the footer",
                attempt=2,
                attempt_group="p:step-0",
            )
        # The refine ran and produced a verdict — WITHOUT assembling the board.
        self.assertEqual(board_calls, [])
        self.assertIsNotNone(verdict)

    def test_first_attempt_still_runs_the_board(self):
        proj, vault = tempfile.mkdtemp(), tempfile.mkdtemp()
        board_calls = []
        real_adapter = team_module.team_model_adapter

        def spying_adapter(*a, **kw):
            board_calls.append(1)
            return real_adapter(*a, **kw)

        with mock.patch.object(team_module, "team_model_adapter", spying_adapter), \
                mock.patch.object(gw_module.Gateway, "model_call", real_board_model_call):
            run_project(
                "build a landing page",
                project_dir=proj,
                vault=vault,
                roster=default_roster(),
            )
        self.assertEqual(board_calls, [1])
