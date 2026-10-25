"""Containment closes two verified paths without breaking the tool's job.

Both denials below were MEASURED on a real machine before this module existed:
the app's own settings.json holds a live 53-character provider API key and a
plain shell command read it in full; a sandbox-exec read-deny returned
"Operation not permitted" for the same read.

These tests run real commands through real sandbox-exec. They are not mocked,
because every claim here is a claim about what the operating system does, and
a mock would agree with a profile that contains nothing.
"""
import os
import shutil
import subprocess
import tempfile
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.containment import (
    CONTAINMENT_LIMITS,
    available,
    build_profile,
    contain,
    scrub_env,
)


def _run(argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, timeout=30, **kw)


@unittest.skipUnless(available(), "sandbox-exec not on this machine")
class TestSecretsAreUnreadable(unittest.TestCase):
    def setUp(self):
        self.store = os.path.expanduser(
            "~/Library/Application Support/com.slashcreative.scprism"
        )

    def test_the_credential_store_cannot_be_read(self):
        if not os.path.isdir(self.store):
            self.skipTest("no app store on this machine")
        target = os.path.join(self.store, "store", "settings.json")
        if not os.path.isfile(target):
            self.skipTest("no settings.json")
        r = _run(contain(["/bin/sh", "-c", f'cat "{target}"']))
        self.assertNotEqual(r.returncode, 0, "the credential store was readable")
        self.assertIn("not permitted", (r.stderr + r.stdout).lower())

    def test_ssh_keys_cannot_be_read(self):
        ssh = os.path.expanduser("~/.ssh")
        if not os.path.isdir(ssh):
            self.skipTest("no ~/.ssh")
        r = _run(contain(["/bin/sh", "-c", f'ls "{ssh}"']))
        self.assertNotEqual(r.returncode, 0)


@unittest.skipUnless(available(), "sandbox-exec not on this machine")
class TestSelfApprovalIsBlocked(unittest.TestCase):
    """A command that can rewrite mcp-approvals.json can approve itself for
    every future tool, permanently — approval is by tool NAME and never
    expires. This is the escalation the write-jail design would have created."""

    def setUp(self):
        self.vault = tempfile.mkdtemp(prefix="scprism-vault-")
        self.approvals = os.path.join(self.vault, "mcp-approvals.json")
        with open(self.approvals, "w", encoding="utf-8") as fh:
            fh.write('{"require":["all"],"granted":[]}')

    def tearDown(self):
        shutil.rmtree(self.vault, ignore_errors=True)

    def test_the_approvals_file_cannot_be_rewritten(self):
        r = _run(
            contain(
                ["/bin/sh", "-c", f'echo HACKED > "{self.approvals}"'], vault=self.vault
            )
        )
        self.assertNotEqual(r.returncode, 0, "the approvals file was rewritten")
        with open(self.approvals, "r", encoding="utf-8") as fh:
            self.assertNotIn("HACKED", fh.read())

    def test_ordinary_vault_writes_still_work(self):
        """Only the governance surface is denied. An agent writing notes and
        verdicts into the vault is the product working."""
        note = os.path.join(self.vault, "notes.md")
        r = _run(contain(["/bin/sh", "-c", f'echo fine > "{note}"'], vault=self.vault))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.isfile(note))


@unittest.skipUnless(available(), "sandbox-exec not on this machine")
class TestRealWorkStillRuns(unittest.TestCase):
    """A containment that blocks `npm test` teaches the user to switch it off."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="scprism-work-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_everyday_commands_succeed(self):
        for cmd in (
            "echo hello",
            "ls /",
            "python3 -c 'print(1+1)'",
            f'cd "{self.tmp}" && git init -q . && git status --short',
            f'mkdir -p "{self.tmp}/build" && echo x > "{self.tmp}/build/a.o" && cat "{self.tmp}/build/a.o"',
            f'cd "{self.tmp}" && printf "x" > f.txt && rm f.txt',
        ):
            with self.subTest(cmd=cmd):
                r = _run(contain(["/bin/sh", "-c", cmd]))
                self.assertEqual(r.returncode, 0, f"{cmd!r} failed: {r.stderr}")

    def test_temp_and_home_writes_are_not_jailed(self):
        """Real toolchains write caches far outside any project root."""
        r = _run(contain(["/bin/sh", "-c", f'echo x > "{self.tmp}/cache" && cat "{self.tmp}/cache"']))
        self.assertEqual(r.returncode, 0, r.stderr)


class TestEnvScrub(unittest.TestCase):
    def test_credential_shaped_variables_are_removed(self):
        env = {
            "PATH": "/usr/bin",
            "HOME": "/Users/x",
            "ANTHROPIC_API_KEY": "sk-secret",
            "GEMINI_API_KEY": "g-secret",
            "AWS_SECRET_ACCESS_KEY": "a-secret",
            "GITHUB_TOKEN": "gh-secret",
            "MY_DB_PASSWORD": "p",
            "EDITOR": "vim",
        }
        out = scrub_env(env)
        self.assertEqual(out["PATH"], "/usr/bin")
        self.assertEqual(out["EDITOR"], "vim")
        for gone in (
            "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "AWS_SECRET_ACCESS_KEY",
            "GITHUB_TOKEN", "MY_DB_PASSWORD",
        ):
            self.assertNotIn(gone, out)


class TestHonesty(unittest.TestCase):
    def test_the_limits_string_does_not_claim_a_sandbox(self):
        low = CONTAINMENT_LIMITS.lower()
        self.assertIn("not a sandbox", low)
        self.assertIn("runs as your user", low)
        self.assertIn("tier-1", low)

    def test_an_unavailable_sandbox_returns_the_command_unchanged(self):
        import scprism_engine.containment as c

        real = c.available
        try:
            c.available = lambda: False
            self.assertEqual(c.contain(["/bin/echo", "hi"]), ["/bin/echo", "hi"])
        finally:
            c.available = real

    def test_the_profile_never_writes_itself_to_disk(self):
        """A profile file inside a directory the command can write is a profile
        the command can rewrite. It is passed inline with -p."""
        argv = contain(["/bin/echo", "x"])
        if len(argv) > 2:
            self.assertIn("-p", argv)
            self.assertTrue(build_profile().startswith("(version 1)"))


if __name__ == "__main__":
    unittest.main()
