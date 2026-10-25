"""Vault tool source (vault_tools.py) — stdlib only, no network, no real user data.

Every test runs against a throwaway vault in a TemporaryDirectory, and every
``project_status`` test passes an EXPLICIT store path, so nothing here can read
(or depend on) the machine's real projects store.

The honesty laws under test: a refused path says so, a truncation says so, a
missing file is an error and never an empty success, a listing NEVER leaks
contents, a capped result says how many it did not show, an empty search is an
honest success, a missing/malformed projects store says "no project data
available", and every call — including a blocked one — emits a real
``tool_exec`` span.
"""

import json
import os
import tempfile
import threading
import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine import vault_tools
from scprism_engine.approval import ApprovalGate, ToolApprovalPolicy
from scprism_engine.mcp import MCPBlockedError, MCPTool
from scprism_engine.telemetry import Telemetry, read_spans
from scprism_engine.vault_tools import (
    VaultToolProvider,
    app_data_dir,
    project_status,
    projects_store_candidates,
    resolve_in_vault,
    vault_list,
    vault_read,
    vault_search,
)
from scprism_engine.webtools import CompositeToolClient

# A distinctive body used to prove a listing never leaks file CONTENTS.
_SECRET_BODY = "MAGIC_VAULT_BODY_TOKEN — the fox naps in the retry policy."


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


class _VaultMixin:
    """A seeded temp vault: two notes, one nested, plus a dotfile that must be
    skipped by every walk."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = os.path.realpath(self._tmp.name)
        _write(os.path.join(self.vault, "retry-policy.md"), _SECRET_BODY)
        _write(
            os.path.join(self.vault, "notes", "launch.md"),
            "# Launch\n\nShip the mission control build on Friday.\n",
        )
        _write(os.path.join(self.vault, ".hidden", "secret.md"), "never listed")
        self.spans_path = os.path.join(self.vault, "spans.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def provider(self, telemetry=None, **kw):
        return VaultToolProvider(self.vault, telemetry=telemetry, **kw)

    def tool_spans(self):
        return [s for s in read_spans(self.spans_path) if s["type"] == "tool_exec"]


# -- path confinement (the security boundary) --------------------------------


class TestPathConfinement(_VaultMixin, unittest.TestCase):
    def test_dotdot_traversal_is_refused(self):
        outside = _write(
            os.path.join(os.path.dirname(self.vault), "outside-note.md"), "leak me"
        )
        self.addCleanup(lambda: os.path.exists(outside) and os.remove(outside))
        res = vault_read(self.vault, "../outside-note.md")
        self.assertTrue(res["isError"])
        text = res["content"][0]["text"]
        self.assertIn("escapes the vault", text)
        self.assertNotIn("leak me", text)

    def test_deep_traversal_to_etc_passwd_is_refused(self):
        res = vault_read(self.vault, "notes/../../../../../../etc/passwd")
        self.assertTrue(res["isError"])
        self.assertIn("escapes the vault", res["content"][0]["text"])

    def test_absolute_path_outside_the_vault_is_refused(self):
        res = vault_read(self.vault, "/etc/hosts")
        self.assertTrue(res["isError"])
        self.assertIn("escapes the vault", res["content"][0]["text"])

    def test_symlink_escape_is_refused(self):
        """A symlink INSIDE the vault pointing OUT of it must not become a
        read-anything primitive: the check is on the REAL resolved path."""
        target = _write(
            os.path.join(os.path.dirname(self.vault), "symlink-target.md"),
            "OUTSIDE_SECRET",
        )
        self.addCleanup(lambda: os.path.exists(target) and os.remove(target))
        link = os.path.join(self.vault, "escape.md")
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError):  # pragma: no cover - platform
            self.skipTest("symlinks unavailable on this platform")
        res = vault_read(self.vault, "escape.md")
        self.assertTrue(res["isError"])
        self.assertIn("escapes the vault", res["content"][0]["text"])
        self.assertNotIn("OUTSIDE_SECRET", json.dumps(res))

    def test_symlinked_subdir_escape_is_refused_for_list_too(self):
        outside_dir = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(outside_dir, True))
        _write(os.path.join(outside_dir, "elsewhere.md"), "OUTSIDE_TREE")
        link = os.path.join(self.vault, "linked")
        try:
            os.symlink(outside_dir, link)
        except (OSError, NotImplementedError):  # pragma: no cover - platform
            self.skipTest("symlinks unavailable on this platform")
        res = vault_list(self.vault, "linked")
        self.assertTrue(res["isError"])
        self.assertIn("escapes the vault", res["content"][0]["text"])

    def test_an_absolute_path_INSIDE_the_vault_is_allowed(self):
        """Confinement is about WHERE the path lands, not how it was spelled."""
        real, reason = resolve_in_vault(
            self.vault, os.path.join(self.vault, "retry-policy.md")
        )
        self.assertIsNone(reason)
        self.assertEqual(real, os.path.join(self.vault, "retry-policy.md"))

    def test_empty_and_non_string_paths_are_refused_not_crashed(self):
        for bad in ("", "   ", None, 7, ["notes"]):
            res = vault_read(self.vault, bad)
            self.assertTrue(res["isError"], bad)
            self.assertIn("non-empty string", res["content"][0]["text"])

    def test_hidden_paths_are_refused_the_walk_already_hides_them(self):
        """The asymmetry finding: ``_walk_files`` has always skipped dotfiles, so
        list and search never showed one — but read had no such rule, and handed
        back the FULL contents of exactly the files a vault's dot-directories
        hold. One surface must not be quieter than another about the same file."""
        _write(os.path.join(self.vault, ".env"), "STRIPE_SECRET=sk_live_LEAKED")
        _write(os.path.join(self.vault, ".ssh", "id_rsa"), "PRIVATE_KEY_BODY")
        _write(os.path.join(self.vault, ".git", "config"), "GIT_REMOTE_TOKEN")
        for path, secret in (
            (".env", "sk_live_LEAKED"),
            (".ssh/id_rsa", "PRIVATE_KEY_BODY"),
            (".git/config", "GIT_REMOTE_TOKEN"),
        ):
            res = vault_read(self.vault, path)
            self.assertTrue(res["isError"], path)
            self.assertIn("hidden", res["content"][0]["text"])
            self.assertNotIn(secret, json.dumps(res))
        # An absolute spelling of the same file is refused by the same rule.
        res = vault_read(self.vault, os.path.join(self.vault, ".env"))
        self.assertTrue(res["isError"])
        self.assertIn("hidden", res["content"][0]["text"])
        # ...and they are still invisible to the other two tools (unchanged).
        self.assertNotIn("sk_live_LEAKED", json.dumps(vault_list(self.vault)))
        self.assertEqual(vault_search(self.vault, "sk_live_LEAKED")["total"], 0)

    def test_a_hidden_subdir_is_refused_for_list_too(self):
        res = vault_list(self.vault, ".hidden")
        self.assertTrue(res["isError"])
        self.assertIn("hidden", res["content"][0]["text"])

    def test_an_ordinary_path_with_a_dot_inside_a_name_still_reads(self):
        """The rule is a LEADING dot per component — 'v1.2.notes.md' is a normal
        file and must not be caught by it."""
        _write(os.path.join(self.vault, "notes", "v1.2.notes.md"), "ORDINARY")
        res = vault_read(self.vault, "notes/v1.2.notes.md")
        self.assertNotIn("isError", res)
        self.assertEqual(res["content"][0]["text"], "ORDINARY")


# -- vault_read --------------------------------------------------------------


class TestVaultRead(_VaultMixin, unittest.TestCase):
    def test_reads_the_real_note(self):
        res = vault_read(self.vault, "retry-policy.md")
        self.assertNotIn("isError", res)
        self.assertEqual(res["content"][0]["text"], _SECRET_BODY)
        self.assertEqual(res["path"], "retry-policy.md")
        self.assertFalse(res["truncated"])

    def test_size_cap_truncates_with_an_honest_note(self):
        big = "x" * 5_000
        _write(os.path.join(self.vault, "big.md"), big)
        res = vault_read(self.vault, "big.md", max_chars=1_000)
        self.assertNotIn("isError", res)
        text = res["content"][0]["text"]
        self.assertTrue(res["truncated"])
        # `chars` is what was RETURNED; `bytes` is the file's REAL size (from the
        # descriptor's own fstat), so the note names the size of what it cut
        # without having to read the whole thing to find out.
        self.assertEqual(res["chars"], 1_000)
        self.assertEqual(res["bytes"], 5_000)
        self.assertIn("truncated", text)
        self.assertIn("first 1000 characters", text)
        self.assertIn("4.9 KB on disk", text)
        # The body really was cut — the note is not decorative.
        self.assertEqual(text[:1_000], big[:1_000])
        self.assertLess(len(text), 2_000)

    def test_read_is_bounded_at_the_source_never_a_whole_file_slurp(self):
        """The OOM finding: the old code ``fh.read()`` the WHOLE file and only
        then sliced, so ``vault_read('spans.jsonl')`` on a mature install pulled
        hundreds of MB into RSS (measured 22MB -> 622MB on a 300MB file). At most
        cap+1 characters may ever enter the process — asserted by recording what
        the file object is actually asked for."""
        _write(os.path.join(self.vault, "huge.jsonl"), "y" * 200_000)
        real_fdopen = os.fdopen
        asked = []

        def spy_fdopen(fd, *args, **kw):
            fh = real_fdopen(fd, *args, **kw)
            real_read = fh.read

            def read(n=-1):
                asked.append(n)
                return real_read(n)

            fh.read = read
            return fh

        with mock.patch.object(os, "fdopen", spy_fdopen):
            res = vault_read(self.vault, "huge.jsonl", max_chars=1_000)
        self.assertTrue(res["truncated"])
        self.assertEqual(asked, [1_001])  # never an unbounded read()

    def test_the_default_read_cap_fits_the_smallest_consumer(self):
        """40k chars is ~10-13k tokens: ONE call blew the heartbeat's 20k token
        budget and overflowed small local models. The tool's own cap has to be
        smaller than the smallest consumer."""
        self.assertEqual(vault_tools.MAX_READ_CHARS, 8_000)

    def test_a_fifo_is_refused_instead_of_hanging_the_run(self):
        """A FIFO in the vault made ``open()`` block forever waiting for a
        writer — a run that never returns. Only REGULAR files are read."""
        try:
            os.mkfifo(os.path.join(self.vault, "pipe.md"))
        except (AttributeError, OSError, NotImplementedError):  # pragma: no cover
            self.skipTest("mkfifo unavailable on this platform")
        box = {}
        done = threading.Event()

        def run():
            box["res"] = vault_read(self.vault, "pipe.md")
            done.set()

        threading.Thread(target=run, daemon=True).start()
        self.assertTrue(done.wait(timeout=5.0), "vault_read hung on a FIFO")
        self.assertTrue(box["res"]["isError"])
        self.assertIn("not a regular file", box["res"]["content"][0]["text"])

    def test_a_fifo_does_not_hang_a_search_either(self):
        try:
            os.mkfifo(os.path.join(self.vault, "pipe.md"))
        except (AttributeError, OSError, NotImplementedError):  # pragma: no cover
            self.skipTest("mkfifo unavailable on this platform")
        box = {}
        done = threading.Event()

        def run():
            box["res"] = vault_search(self.vault, "fox")
            done.set()

        threading.Thread(target=run, daemon=True).start()
        self.assertTrue(done.wait(timeout=5.0), "vault_search hung on a FIFO")
        # The real note still matched; the FIFO was simply skipped.
        self.assertEqual([h["path"] for h in box["res"]["hits"]], ["retry-policy.md"])

    def test_a_symlink_swapped_in_after_vetting_cannot_win_the_race(self):
        """``resolve_in_vault`` vets a realpath; the open must not follow a
        symlink planted in the window between the two (O_NOFOLLOW + fstat)."""
        target = _write(
            os.path.join(os.path.dirname(self.vault), "toctou-secret.md"),
            "OUTSIDE_SECRET",
        )
        self.addCleanup(lambda: os.path.exists(target) and os.remove(target))
        _write(os.path.join(self.vault, "note.md"), "innocent")
        real_resolve = vault_tools.resolve_in_vault

        def swap(vault, path):
            real, reason = real_resolve(vault, path)
            if real is not None and os.path.isfile(real):
                os.remove(real)  # the attacker's window
                os.symlink(target, real)
            return real, reason

        try:
            with mock.patch.object(vault_tools, "resolve_in_vault", swap):
                res = vault_read(self.vault, "note.md")
        except (OSError, NotImplementedError):  # pragma: no cover - platform
            self.skipTest("symlinks unavailable on this platform")
        self.assertTrue(res["isError"])
        self.assertNotIn("OUTSIDE_SECRET", json.dumps(res))

    def test_under_the_cap_says_nothing_about_truncation(self):
        res = vault_read(self.vault, "notes/launch.md", max_chars=40_000)
        self.assertFalse(res["truncated"])
        self.assertNotIn("truncated", res["content"][0]["text"])

    def test_missing_file_is_an_honest_error_not_an_empty_success(self):
        res = vault_read(self.vault, "notes/nope.md")
        self.assertTrue(res["isError"])
        self.assertIn("no such file in the vault", res["content"][0]["text"])
        self.assertIn("nope.md", res["content"][0]["text"])

    def test_directory_target_is_an_honest_error(self):
        res = vault_read(self.vault, "notes")
        self.assertTrue(res["isError"])
        self.assertIn("is a directory", res["content"][0]["text"])


# -- vault_list --------------------------------------------------------------


class TestVaultList(_VaultMixin, unittest.TestCase):
    def test_lists_names_and_sizes_and_NEVER_contents(self):
        res = vault_list(self.vault)
        self.assertNotIn("isError", res)
        blob = json.dumps(res, ensure_ascii=False)
        self.assertIn("retry-policy.md", blob)
        self.assertIn("notes/launch.md", blob)
        # The law: a listing leaks NO file body, ever.
        self.assertNotIn("MAGIC_VAULT_BODY_TOKEN", blob)
        self.assertNotIn("Ship the mission control build", blob)
        # Sizes are real.
        by_path = {e["path"]: e["bytes"] for e in res["entries"]}
        self.assertEqual(
            by_path["retry-policy.md"],
            os.path.getsize(os.path.join(self.vault, "retry-policy.md")),
        )

    def test_dotfiles_are_skipped(self):
        res = vault_list(self.vault)
        self.assertNotIn(".hidden", json.dumps(res))

    def test_a_symlink_escaping_the_vault_is_not_listed_or_measured(self):
        """A listing reported the SIZE of an out-of-vault target — metadata about
        a file ``vault_read`` refuses to open. List must not describe what read
        cannot reach."""
        target = _write(
            os.path.join(os.path.dirname(self.vault), "outside-big.md"), "z" * 4_096
        )
        self.addCleanup(lambda: os.path.exists(target) and os.remove(target))
        try:
            os.symlink(target, os.path.join(self.vault, "peek.md"))
        except (OSError, NotImplementedError):  # pragma: no cover - platform
            self.skipTest("symlinks unavailable on this platform")
        res = vault_list(self.vault)
        paths = [e["path"] for e in res["entries"]]
        self.assertNotIn("peek.md", paths)
        self.assertNotIn("4096", json.dumps(res))
        # ...and the same skip applies to the search walk.
        self.assertEqual(vault_search(self.vault, "peek")["total"], 0)

    def test_a_symlink_INSIDE_the_vault_is_still_listed(self):
        """The rule is about ESCAPING, not about symlinks — an internal link is
        vault data and stays visible."""
        _write(os.path.join(self.vault, "notes", "target.md"), "inside")
        try:
            os.symlink(
                os.path.join(self.vault, "notes", "target.md"),
                os.path.join(self.vault, "alias.md"),
            )
        except (OSError, NotImplementedError):  # pragma: no cover - platform
            self.skipTest("symlinks unavailable on this platform")
        paths = [e["path"] for e in vault_list(self.vault)["entries"]]
        self.assertIn("alias.md", paths)

    def test_subdir_narrows_the_listing(self):
        res = vault_list(self.vault, "notes")
        paths = [e["path"] for e in res["entries"]]
        self.assertEqual(paths, ["notes/launch.md"])

    def test_missing_subdir_is_an_honest_error(self):
        res = vault_list(self.vault, "ghosts")
        self.assertTrue(res["isError"])
        self.assertIn("not a directory in the vault", res["content"][0]["text"])

    def test_cap_reports_how_many_it_did_not_show(self):
        for i in range(30):
            _write(os.path.join(self.vault, "bulk", "note-%02d.md" % i), "n%d" % i)
        res = vault_list(self.vault, max_entries=5)
        self.assertEqual(len(res["entries"]), 5)
        self.assertEqual(res["total"], 32)  # 30 bulk + 2 seeded (dotfile skipped)
        self.assertTrue(res["truncated"])
        self.assertIn("27 more file(s) not shown", res["content"][0]["text"])

    def test_empty_vault_is_an_honest_empty_success(self):
        with tempfile.TemporaryDirectory() as empty:
            res = vault_list(empty)
            self.assertNotIn("isError", res)
            self.assertEqual(res["total"], 0)
            self.assertIn("No files", res["content"][0]["text"])

    def test_missing_vault_directory_is_an_error(self):
        res = vault_list(os.path.join(self.vault, "does-not-exist"))
        self.assertTrue(res["isError"])
        self.assertIn("no vault directory", res["content"][0]["text"])


# -- vault_search ------------------------------------------------------------


class TestVaultSearch(_VaultMixin, unittest.TestCase):
    def test_content_match_is_case_insensitive_with_a_real_snippet(self):
        res = vault_search(self.vault, "MISSION CONTROL")
        self.assertNotIn("isError", res)
        self.assertEqual(res["total"], 1)
        hit = res["hits"][0]
        self.assertEqual(hit["path"], "notes/launch.md")
        self.assertIn("content", hit["match"])
        self.assertIn("mission control", hit["snippet"].lower())

    def test_filename_match_is_reported_as_such(self):
        res = vault_search(self.vault, "retry-policy")
        self.assertEqual(res["total"], 1)
        self.assertIn("filename", res["hits"][0]["match"])

    def test_empty_result_is_an_honest_success_not_an_error(self):
        res = vault_search(self.vault, "zzz-nothing-matches-zzz")
        self.assertNotIn("isError", res)
        self.assertEqual(res["hits"], [])
        self.assertEqual(res["total"], 0)
        self.assertIn("No vault matches", res["content"][0]["text"])

    def test_cap_reports_how_many_it_did_not_show(self):
        for i in range(12):
            _write(os.path.join(self.vault, "hits", "h-%02d.md" % i), "needle here")
        res = vault_search(self.vault, "needle", max_hits=4)
        self.assertEqual(len(res["hits"]), 4)
        self.assertEqual(res["total"], 12)
        self.assertIn("8 more match(es) not shown", res["content"][0]["text"])

    def test_scan_bound_admits_that_the_answer_is_partial(self):
        """A vast vault must not stall a run — and a search that stopped early
        must SAY so rather than report a confident 'nothing found'."""
        for i in range(20):
            _write(os.path.join(self.vault, "bulk", "b-%02d.md" % i), "filler")
        res = vault_search(self.vault, "zzz-nothing", max_files=5)
        self.assertNotIn("isError", res)
        self.assertEqual(res["scanned"], 5)
        self.assertTrue(res["scan_capped"])
        self.assertIn("search stopped after scanning 5 files", res["content"][0]["text"])
        self.assertIn("partial", res["content"][0]["text"])

    def test_an_unbounded_scan_says_nothing_about_stopping(self):
        res = vault_search(self.vault, "zzz-nothing")
        self.assertFalse(res["scan_capped"])
        self.assertNotIn("stopped after scanning", res["content"][0]["text"])

    def test_binary_files_do_not_produce_garbage_hits(self):
        with open(os.path.join(self.vault, "blob.bin"), "wb") as fh:
            fh.write(b"\x00\x01needle\x00\x02")
        res = vault_search(self.vault, "needle")
        self.assertEqual(res["total"], 0)

    def test_blank_query_is_an_honest_error(self):
        res = vault_search(self.vault, "   ")
        self.assertTrue(res["isError"])
        self.assertIn("non-empty string", res["content"][0]["text"])

    def test_missing_vault_is_an_error_not_a_silent_no_match(self):
        """'I found nothing' and 'I could not look' are different claims."""
        res = vault_search(os.path.join(self.vault, "gone"), "anything")
        self.assertTrue(res["isError"])
        self.assertIn("no vault directory", res["content"][0]["text"])


# -- project_status ----------------------------------------------------------


class TestProjectStatus(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = os.path.join(self._tmp.name, "store", "projects.json")

    def tearDown(self):
        self._tmp.cleanup()

    def _store(self, payload):
        os.makedirs(os.path.dirname(self.store), exist_ok=True)
        with open(self.store, "w", encoding="utf-8") as fh:
            fh.write(payload if isinstance(payload, str) else json.dumps(payload))
        return self.store

    def test_missing_store_says_no_project_data_available(self):
        res = project_status(store_path=self.store)
        self.assertNotIn("isError", res)
        self.assertIn("no project data available", res["content"][0]["text"].lower())
        self.assertEqual(res["projects"], [])

    def test_no_message_leaks_the_users_home_path(self):
        """Every candidate is ``/Users/<real name>/Library/Application Support/…``.
        The model has no use for that and it rides into any reply that quotes the
        error — so the model-facing text names the store by BASENAME only. The
        structured extra still carries the real path for the app."""
        home = os.path.expanduser("~")
        # (a) discovered candidates (the real app-data path is among them).
        # The no-leak claim is unconditional; the BASENAME claim only applies
        # when discovery actually failed. This test used to assert the basename
        # unconditionally, which quietly depended on the developer's own machine
        # having no projects — it began failing the gate the moment a real one
        # existed, reporting a leak that was never there.
        missing = project_status(vault="/somewhere/custom/vault")
        self.assertNotIn(home, missing["content"][0]["text"])
        if not missing.get("projects"):
            self.assertIn("projects.json", missing["content"][0]["text"])
        # (b) unreadable + (c) malformed + (d) empty, all with a real path
        self._store("{not json at all")
        broken = project_status(store_path=self.store)
        self.assertNotIn(self._tmp.name, broken["content"][0]["text"])
        self._store({"nope": 1})
        bad = project_status(store_path=self.store)
        self.assertNotIn(self._tmp.name, bad["content"][0]["text"])
        self._store({"projects": []})
        empty = project_status(store_path=self.store)
        self.assertNotIn(self._tmp.name, empty["content"][0]["text"])
        self.assertEqual(empty["store_path"], self.store)  # extras keep the truth

    def test_projects_are_capped_with_the_modules_own_more_note(self):
        self._store(
            {"projects": [{"name": "p%03d" % i, "status": "idle"} for i in range(70)]}
        )
        res = project_status(store_path=self.store)
        text = res["content"][0]["text"]
        self.assertEqual(res["total"], 70)  # the honest count is still the truth
        self.assertEqual(len(res["projects"]), 50)
        self.assertIn("70 project(s):", text)
        self.assertIn("… 20 more project(s) not shown (cap 50).", text)
        self.assertNotIn("p069", text)

    def test_a_runaway_project_name_is_capped_like_the_note_is(self):
        self._store({"projects": [{"name": "N" * 5_000, "status": "idle"}]})
        res = project_status(store_path=self.store)
        self.assertEqual(len(res["projects"][0]["name"]), 160)
        self.assertLess(len(res["content"][0]["text"]), 400)

    def test_malformed_json_is_an_honest_error_not_an_exception(self):
        self._store("{not json at all")
        res = project_status(store_path=self.store)
        self.assertTrue(res["isError"])
        self.assertIn("no project data available", res["content"][0]["text"].lower())

    def test_wrong_shape_is_an_honest_error(self):
        self._store({"nope": 1})
        res = project_status(store_path=self.store)
        self.assertTrue(res["isError"])
        self.assertIn("malformed", res["content"][0]["text"])

    def test_summarizes_name_status_and_step_only(self):
        self._store(
            {
                "projects": [
                    {
                        "id": "proj-1",
                        "name": "Mission Control",
                        "status": "running",
                        "stepIndex": 2,
                        "plan": ["a", "b", "c", "d"],
                        "lastNote": "step 3 verifying",
                        "goal": "GOAL_SHOULD_NOT_LEAK",
                        "transcript": [
                            {"role": "user", "text": "TRANSCRIPT_SHOULD_NOT_LEAK"}
                        ],
                    },
                    {"name": "Old Thing", "status": "done", "plan": [], "stepIndex": 0},
                    "not-a-project",
                ]
            }
        )
        res = project_status(store_path=self.store)
        self.assertNotIn("isError", res)
        self.assertEqual(res["total"], 2)  # the junk entry is skipped, not guessed
        text = res["content"][0]["text"]
        self.assertIn("Mission Control — running · step 3/4", text)
        self.assertIn("Old Thing — done", text)
        # A status view is NOT a content dump.
        blob = json.dumps(res)
        self.assertNotIn("GOAL_SHOULD_NOT_LEAK", blob)
        self.assertNotIn("TRANSCRIPT_SHOULD_NOT_LEAK", blob)

    def test_empty_projects_list_is_an_honest_empty(self):
        self._store({"projects": []})
        res = project_status(store_path=self.store)
        self.assertNotIn("isError", res)
        self.assertIn("no project data available", res["content"][0]["text"].lower())

    def test_discovery_prefers_the_app_data_store(self):
        """The app writes <appData>/store/projects.json (Tauri store_set), so
        that must be the first place we look — the <vault>/../store guess only
        happens to work for the DEFAULT vault location."""
        candidates = projects_store_candidates(vault="/somewhere/custom/vault")
        base = app_data_dir()
        self.assertIsNotNone(base)
        self.assertEqual(candidates[0], os.path.join(base, "store", "projects.json"))
        self.assertIn(
            os.path.join("/somewhere/custom", "store", "projects.json"), candidates
        )

    def test_env_override_wins(self):
        os.environ["SCPRISM_PROJECTS_STORE"] = "/tmp/override-projects.json"
        self.addCleanup(os.environ.pop, "SCPRISM_PROJECTS_STORE", None)
        self.assertEqual(
            projects_store_candidates()[0], "/tmp/override-projects.json"
        )


# -- the governed provider ---------------------------------------------------


class TestVaultToolProvider(_VaultMixin, unittest.TestCase):
    def test_advertises_the_four_tools(self):
        tools = self.provider().list_tools()
        self.assertEqual(
            {t.name for t in tools},
            {"vault_list", "vault_read", "vault_search", "project_status"},
        )
        self.assertTrue(all(isinstance(t, MCPTool) for t in tools))

    def test_every_tool_emits_a_real_tool_exec_span(self):
        tel = Telemetry(self.spans_path)
        prov = self.provider(telemetry=tel, projects_store=os.path.join(self.vault, "nope.json"))
        prov.parent_span_id = "PARENT-SPAN"
        prov.call_tool("vault_list", {})
        prov.call_tool("vault_read", {"path": "retry-policy.md"})
        prov.call_tool("vault_search", {"query": "fox"})
        prov.call_tool("project_status", {})

        spans = self.tool_spans()
        self.assertEqual(len(spans), 4)
        self.assertEqual(
            [s["attrs"]["tool"] for s in spans],
            ["vault_list", "vault_read", "vault_search", "project_status"],
        )
        for span in spans:
            self.assertEqual(span["attrs"]["provider"], "vault")
            self.assertEqual(span["attrs"]["server"], "vault")
            self.assertEqual(span["parent_id"], "PARENT-SPAN")
            self.assertEqual(span["status"], "ok")
            self.assertFalse(span["attrs"]["is_error"])

    def test_a_read_span_names_the_note_it_opened(self):
        """Disclosure: the run stream / Console must be able to say WHICH note
        was opened, not just "a tool ran". The path comes from the RESULT (already
        vault-relative and confined), never from the model's argument."""
        tel = Telemetry(self.spans_path)
        prov = self.provider(telemetry=tel)
        prov.call_tool("vault_read", {"path": "notes/launch.md"})
        prov.call_tool("vault_read", {"path": "../../etc/passwd"})
        spans = self.tool_spans()
        self.assertEqual(spans[0]["attrs"]["path"], "notes/launch.md")
        # A refused read names nothing — there is no note it opened.
        self.assertNotIn("path", spans[1]["attrs"])

    def test_a_refused_read_still_emits_a_span_marked_is_error(self):
        tel = Telemetry(self.spans_path)
        res = self.provider(telemetry=tel).call_tool(
            "vault_read", {"path": "../../etc/passwd"}
        )
        self.assertTrue(res["isError"])
        spans = self.tool_spans()
        self.assertEqual(len(spans), 1)
        self.assertTrue(spans[0]["attrs"]["is_error"])

    def test_allowlist_block_raises_and_emits_a_blocked_span(self):
        tel = Telemetry(self.spans_path)
        prov = self.provider(telemetry=tel, allowed_tools=["vault_list"])
        with self.assertRaises(MCPBlockedError):
            prov.call_tool("vault_read", {"path": "retry-policy.md"})
        spans = self.tool_spans()
        self.assertEqual(len(spans), 1)
        self.assertTrue(spans[0]["attrs"]["blocked"])
        self.assertEqual(spans[0]["attrs"]["provider"], "vault")
        self.assertEqual(spans[0]["status"], "error")

    def test_unknown_tool_is_an_honest_error_never_a_raise(self):
        self.assertTrue(self.provider().call_tool("vault_delete", {}).get("isError"))

    def test_bad_argument_types_are_honest_errors(self):
        self.assertTrue(self.provider().call_tool("vault_list", {"subdir": 3})["isError"])
        self.assertTrue(self.provider().call_tool("vault_search", {})["isError"])

    # -- THE PRIVACY LINE (see engine/scprism_engine/webtools.py) -----------
    #
    # webtools.py may record a URL / a search query on its span because those
    # ALREADY LEFT THE MACHINE. A vault tool egresses NOTHING, so its arguments
    # are exactly the material that must never be copied into spans.jsonl —
    # the audit trail must not be the first place a secret goes. This asserts
    # the line rather than trusting the comment that states it.

    def test_vault_arguments_are_never_recorded_on_the_span(self):
        tel = Telemetry(self.spans_path)
        prov = self.provider(telemetry=tel)
        prov.call_tool("vault_search", {"query": "platypus-canary-7731"})
        span = self.tool_spans()[0]
        for forbidden in ("query", "subdir", "arguments", "args", "url"):
            self.assertNotIn(forbidden, span["attrs"])
        with open(self.spans_path, "r", encoding="utf-8") as fh:
            self.assertNotIn("platypus-canary-7731", fh.read())

    def test_a_refused_vault_path_is_not_written_to_the_span(self):
        """The argument of a REFUSED read is the one most likely to be hostile
        or sensitive; the span names a note only when the RESULT confirms one
        was really opened."""
        tel = Telemetry(self.spans_path)
        self.provider(telemetry=tel).call_tool(
            "vault_read", {"path": "../../etc/echidna-canary-5520"}
        )
        span = self.tool_spans()[0]
        self.assertNotIn("path", span["attrs"])
        with open(self.spans_path, "r", encoding="utf-8") as fh:
            self.assertNotIn("echidna-canary-5520", fh.read())


class TestVaultToolsRideTheApprovalGate(_VaultMixin, unittest.TestCase):
    """A vault tool must be held by the approval posture exactly like any other
    tool source — no special-casing that would let it skip a hold."""

    def test_require_all_holds_a_vault_read_and_never_reads_the_file(self):
        tel = Telemetry(self.spans_path)
        prov = self.provider(telemetry=tel)
        gate = ApprovalGate(prov, ToolApprovalPolicy(require="all"))
        res = gate.call_tool("vault_read", {"path": "retry-policy.md"})
        self.assertTrue(res["isError"])
        self.assertTrue(res["held"])
        # The file body NEVER reached the model.
        self.assertNotIn("MAGIC_VAULT_BODY_TOKEN", json.dumps(res))
        spans = self.tool_spans()
        self.assertEqual(len(spans), 1)
        self.assertTrue(spans[0]["attrs"]["held"])
        self.assertEqual(spans[0]["attrs"]["provider"], "vault")
        self.assertEqual(spans[0]["attrs"]["server"], "vault")

    def test_granting_the_tool_lets_the_real_read_through(self):
        prov = self.provider()
        gate = ApprovalGate(prov, ToolApprovalPolicy(require="all", granted="vault_read"))
        res = gate.call_tool("vault_read", {"path": "retry-policy.md"})
        self.assertNotIn("isError", res)
        self.assertIn("MAGIC_VAULT_BODY_TOKEN", res["content"][0]["text"])

    def test_held_through_a_composite_is_attributed_to_the_vault_provider(self):
        tel = Telemetry(self.spans_path)
        comp = CompositeToolClient([self.provider(telemetry=tel)])
        comp.list_tools()
        gate = ApprovalGate(comp, ToolApprovalPolicy(require="vault_search"))
        res = gate.call_tool("vault_search", {"query": "fox"})
        self.assertTrue(res["held"])
        self.assertEqual(self.tool_spans()[0]["attrs"]["provider"], "vault")


if __name__ == "__main__":
    unittest.main()
