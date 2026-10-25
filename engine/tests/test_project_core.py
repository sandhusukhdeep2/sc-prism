import os
import tempfile
import unittest

import _bootstrap  # noqa: F401  (sets up sys.path)

from scprism_engine.project import apply_file_ops, parse_file_blocks, validate_project_path


class ParseFileBlocksTest(unittest.TestCase):
    def test_extracts_multiple_blocks_and_ignores_narration(self):
        text = (
            "I'll create two files.\n"
            "===FILE: index.html===\n<html>hi</html>\n===END===\n"
            "Some narration.\n"
            "===FILE: css/site.css===\nbody{}\n===END===\n"
        )
        self.assertEqual(
            parse_file_blocks(text),
            [("index.html", "<html>hi</html>"), ("css/site.css", "body{}")],
        )

    def test_zero_blocks_returns_empty_list(self):
        self.assertEqual(parse_file_blocks("no blocks here"), [])

    def test_tolerates_whitespace_in_marker_and_preserves_inner_newlines(self):
        text = "===FILE:  a.txt ===\nline1\n\nline2\n===END==="
        self.assertEqual(parse_file_blocks(text), [("a.txt", "line1\n\nline2")])

    def test_unclosed_block_is_ignored(self):
        self.assertEqual(parse_file_blocks("===FILE: a.txt===\nabc"), [])

    def test_crlf_completion_parses_with_clean_body(self):
        text = "===FILE: a.txt===\r\nline1\r\nline2\r\n===END==="
        self.assertEqual(parse_file_blocks(text), [("a.txt", "line1\nline2")])


class ValidatePathTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_accepts_simple_relative_paths(self):
        ok, reason = validate_project_path("src/app.js", self.tmp)
        self.assertTrue(ok)
        self.assertEqual(reason, "")

    def test_rejects_absolute_traversal_git_and_never_touch(self):
        for rel, frag in (
            ("/etc/passwd", "absolute"),
            ("../outside.txt", "outside the project"),
            ("a/../../outside.txt", "outside the project"),
            (".git/hooks/pre-commit", ".git"),
            ("secrets/key.pem", "never-touch"),
        ):
            ok, reason = validate_project_path(rel, self.tmp, never_touch=("secrets/**",))
            self.assertFalse(ok, rel)
            self.assertIn(frag, reason)

    def test_rejects_symlink_escape(self):
        outside = tempfile.mkdtemp()
        os.symlink(outside, os.path.join(self.tmp, "link"))
        ok, reason = validate_project_path("link/evil.txt", self.tmp)
        self.assertFalse(ok)
        self.assertIn("outside the project", reason)

    def test_rejects_case_folded_git_dir(self):
        ok, reason = validate_project_path(".GIT/hooks/x", self.tmp)
        self.assertFalse(ok)
        self.assertIn(".git", reason)

    def test_rejects_case_folded_never_touch(self):
        ok, reason = validate_project_path(
            "SECRETS/key.pem", self.tmp, never_touch=("secrets/**",)
        )
        self.assertFalse(ok)
        self.assertIn("never-touch", reason)

    def test_rejects_paths_that_normalize_to_project_root(self):
        for rel in ("", ".", "a/..", "sub/.."):
            ok, reason = validate_project_path(rel, self.tmp)
            self.assertFalse(ok, repr(rel))
            self.assertIn("not a file path", reason)

    def test_accepts_dot_dot_prefixed_filename(self):
        ok, reason = validate_project_path("..bak", self.tmp)
        self.assertTrue(ok, reason)
        self.assertEqual(reason, "")


class ApplyFileOpsTest(unittest.TestCase):
    def test_writes_accepted_and_reports_rejected(self):
        tmp = tempfile.mkdtemp()
        result = apply_file_ops(
            [("index.html", "<html/>"), ("../evil.txt", "x")], tmp
        )
        self.assertEqual(result["written"], ["index.html"])
        self.assertEqual(result["rejected"][0]["path"], "../evil.txt")
        with open(os.path.join(tmp, "index.html")) as f:
            self.assertEqual(f.read(), "<html/>")

    def test_creates_parent_directories(self):
        tmp = tempfile.mkdtemp()
        result = apply_file_ops([("a/b/c.txt", "deep")], tmp)
        self.assertEqual(result["written"], ["a/b/c.txt"])
        self.assertTrue(os.path.exists(os.path.join(tmp, "a", "b", "c.txt")))

    def test_dot_path_is_rejected_not_raised(self):
        tmp = tempfile.mkdtemp()
        result = apply_file_ops([(".", "x")], tmp)
        self.assertEqual(result["written"], [])
        self.assertEqual(result["rejected"][0]["path"], ".")
        self.assertIn("not a file path", result["rejected"][0]["reason"])

    def test_rejects_symlinked_destination_leaf(self):
        tmp = tempfile.mkdtemp()
        outside = tempfile.mkdtemp()
        victim = os.path.join(outside, "victim.txt")
        with open(victim, "w") as f:
            f.write("original")
        os.symlink(victim, os.path.join(tmp, "evil.txt"))
        result = apply_file_ops([("evil.txt", "pwned")], tmp)
        self.assertEqual(result["written"], [])
        self.assertEqual(result["rejected"][0]["path"], "evil.txt")
        self.assertIn("symlink", result["rejected"][0]["reason"])
        with open(victim) as f:
            self.assertEqual(f.read(), "original")


if __name__ == "__main__":
    unittest.main()
