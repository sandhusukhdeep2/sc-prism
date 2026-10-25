"""Finding 0 — the verification spine.

On a GUI-launched install the engine subprocess inherited `/usr/bin:/bin:...`,
so Tier-1's `npm test` died with `/bin/sh: npm: command not found` — 0 of 51
runs ever passed the gate. Two invariants are pinned here:

  1. the PATH the verify shell runs with can SEE tools installed by Homebrew /
     npm / bun / volta / nvm (nvm's per-version glob, newest version first);
  2. a genuinely missing command fails HONESTLY — "verify command not found:
     npm" — never a raw exit-127 shell dump that reads like a failing test.
"""

import os
import unittest

import _bootstrap  # noqa: F401  (path bootstrap)

from scprism_engine import toolpath
from scprism_engine.verifier import tier1


class NvmDiscoveryTests(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.tmp = tempfile.mkdtemp(prefix="scprism-nvm-")

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def _mk(self, *versions):
        root = os.path.join(self.tmp, "node")
        for v in versions:
            os.makedirs(os.path.join(root, v, "bin"), exist_ok=True)
        return root

    def test_newest_nvm_version_wins(self):
        root = self._mk("v18.20.1", "v22.14.0", "v20.9.0", "v9.1.0")
        dirs = toolpath.nvm_bin_dirs(root)
        names = [os.path.basename(os.path.dirname(d)) for d in dirs]
        # Numeric ordering, not lexicographic ("v9" must not beat "v22").
        self.assertEqual(names, ["v22.14.0", "v20.9.0", "v18.20.1", "v9.1.0"])

    def test_version_without_bin_is_not_offered(self):
        root = self._mk("v22.14.0")
        os.makedirs(os.path.join(root, "v23.0.0"), exist_ok=True)  # no bin/
        names = [os.path.basename(os.path.dirname(d)) for d in toolpath.nvm_bin_dirs(root)]
        self.assertEqual(names, ["v22.14.0"])

    def test_missing_nvm_root_is_empty_not_an_error(self):
        self.assertEqual(toolpath.nvm_bin_dirs("/nope/does/not/exist"), [])

    def test_enriched_path_has_standard_dirs_and_nvm_and_keeps_inherited_first(self):
        root = self._mk("v22.14.0")
        path = toolpath.enriched_path("/usr/bin:/bin", nvm_root=root)
        parts = path.split(os.pathsep)
        self.assertEqual(parts[:2], ["/usr/bin", "/bin"])
        self.assertIn("/opt/homebrew/bin", parts)
        self.assertIn("/usr/local/bin", parts)
        self.assertIn(os.path.expanduser("~/.local/bin"), parts)
        self.assertIn(os.path.expanduser("~/.volta/bin"), parts)
        self.assertIn(os.path.join(root, "v22.14.0", "bin"), parts)

    def test_enriched_path_does_not_duplicate(self):
        path = toolpath.enriched_path("/opt/homebrew/bin:/usr/bin", nvm_root="/nope")
        self.assertEqual(path.split(os.pathsep).count("/opt/homebrew/bin"), 1)

    def test_env_with_path_carries_the_enriched_path(self):
        env = toolpath.env_with_path({"PATH": "/usr/bin", "FOO": "bar"}, nvm_root="/nope")
        self.assertEqual(env["FOO"], "bar")
        self.assertIn("/opt/homebrew/bin", env["PATH"].split(os.pathsep))


class Tier1ExecutionTests(unittest.TestCase):
    def test_a_command_that_exists_runs_and_passes(self):
        res = tier1(["python3 -c \"print('ok')\""])
        self.assertTrue(res.passed, res.log)
        self.assertFalse(res.skipped)
        self.assertIn("ok", res.commands[0].stdout)
        self.assertFalse(res.commands[0].not_found)

    def test_a_real_failure_still_fails_and_is_not_mislabelled(self):
        res = tier1(["python3 -c 'raise SystemExit(3)'"])
        self.assertFalse(res.passed)
        self.assertEqual(res.commands[0].returncode, 3)
        # A genuine failure is NOT a missing command.
        self.assertFalse(res.commands[0].not_found)
        self.assertEqual(res.missing_commands, [])
        self.assertNotIn("verify command not found", res.log)

    def test_a_missing_command_fails_honestly_not_as_a_shell_dump(self):
        res = tier1(["scprism-definitely-not-installed --run"])
        self.assertFalse(res.passed)
        cr = res.commands[0]
        self.assertTrue(cr.not_found)
        self.assertIn("verify command not found: scprism-definitely-not-installed", cr.stderr)
        self.assertIn("not a test failure", cr.stderr)
        # Never the raw shell error on its own.
        self.assertNotIn("/bin/sh:", cr.stderr)
        self.assertEqual(res.missing_commands, ["scprism-definitely-not-installed --run"])
        self.assertIn("verify command not found", res.log)

    def test_a_missing_command_inside_a_compound_line_is_still_honest(self):
        # `cd . && <missing>` starts with a shell builtin, so the pre-flight
        # check is skipped and the shell's own exit 127 must be translated.
        res = tier1(["cd . && scprism-definitely-not-installed"])
        cr = res.commands[0]
        self.assertFalse(res.passed)
        self.assertTrue(cr.not_found)
        self.assertIn("verify command not found", cr.stderr)

    def test_no_commands_is_skipped_not_a_failure(self):
        res = tier1([])
        self.assertTrue(res.passed)
        self.assertTrue(res.skipped)

    def test_the_verify_shell_gets_the_enriched_path(self):
        res = tier1(["python3 -c \"import os;print(os.environ['PATH'])\""])
        self.assertTrue(res.passed, res.log)
        self.assertIn("/opt/homebrew/bin", res.commands[0].stdout.split(os.pathsep))

    def test_the_resolved_binary_is_recorded(self):
        # A version mismatch is invisible without this: the same `npm test`
        # means something different under ~/.local/bin/npm (node 22) than under
        # an nvm shim (node 20), and "but it works in my terminal" is otherwise
        # unfalsifiable.
        res = tier1(['python3 -c "print(1)"'])
        cr = res.commands[0]
        self.assertIsNotNone(cr.resolved)
        self.assertTrue(os.path.isabs(cr.resolved), cr.resolved)
        self.assertEqual(os.path.basename(cr.resolved), "python3")
        self.assertIn(f"# resolved: {cr.resolved}", res.log)


class Tier1CwdTests(unittest.TestCase):
    """The OTHER half of the Tier-1 failure — the working directory.

    `engine_command` pins the engine's cwd to its own folder, which inside the
    installed app is `SC Prism.app/Contents/Resources/resources/engine`: no
    package.json in it or in ANY ancestor. `npm test` there dies with
    `npm error ENOENT`, and the gate reported that as a failing test. The dev
    repo hid this completely — npm walks UP and finds the repo's own
    package.json, so verify.sh went green over a fix that could not work once
    installed. These tests run the PACKAGED shape on purpose.
    """

    def setUp(self):
        import tempfile

        # A directory with no project manifest in it or in any ancestor — the
        # same shape as the app bundle's engine folder.
        self.tmp = tempfile.mkdtemp(prefix="scprism-nocwd-")

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def _assert_no_manifest_above(self, start):
        d = os.path.realpath(start)
        while True:
            self.assertFalse(
                os.path.exists(os.path.join(d, "package.json")),
                f"invalid fixture: {d}/package.json exists, so npm would find a project",
            )
            parent = os.path.dirname(d)
            if parent == d:
                return
            d = parent

    def test_no_cwd_configured_skips_honestly_instead_of_failing(self):
        # An EMPTY cwd means "I have a verify command but no project directory"
        # — a chat message, a manager report, a heartbeat wake. Tier-1 is a
        # PROJECT gate: there is no code to test, so there is nothing to run and
        # nothing to fail. The gate must SKIP, out loud.
        #
        # It used to fail the run instead, which is why essentially every run in
        # the user's history read `passed: False` — a false negative that
        # poisoned pass rates, agent stats and the desk everywhere.
        res = tier1(["npm test"], cwd="")
        self.assertTrue(res.skipped, "a run with nothing to verify skips the gate")
        self.assertTrue(res.passed, "a run with no code to test must not FAIL the gate")
        self.assertEqual(res.commands, [], "nothing ran, so no command result exists")
        self.assertEqual(res.failed_commands, [])
        self.assertEqual(res.missing_commands, [])
        # …but the skip is never silent: the reason and the unrun command ride it.
        self.assertEqual(res.skipped_commands, ["npm test"])
        self.assertIn("no project bound", res.skip_reason)
        self.assertIn("nothing to verify", res.skip_reason)
        self.assertIn("neither a pass nor a test failure", res.skip_reason)
        self.assertIn("nothing to verify", res.log)
        self.assertIn("npm test", res.log)

    def test_no_commands_skips_with_its_own_distinct_reason(self):
        # The OTHER skip. "You configured nothing" and "this run had nothing to
        # point your command at" are different truths, and Stats must be able to
        # tell them apart — saying the first to a user who set `npm test` is a
        # lie.
        res = tier1([])
        self.assertTrue(res.skipped)
        self.assertTrue(res.passed)
        self.assertEqual(res.skipped_commands, [])
        self.assertIn("no verify command configured", res.skip_reason)
        self.assertNotIn("no project bound", res.skip_reason)

    def test_an_empty_cwd_never_shells_out(self):
        # Belt and braces: the skip must happen BEFORE any subprocess. A command
        # that would leave a trace proves nothing ran.
        marker = os.path.join(self.tmp, "ran-anyway")
        res = tier1([f"touch {marker}"], cwd="")
        self.assertTrue(res.skipped)
        self.assertFalse(os.path.exists(marker), "the gate executed a command it had skipped")

    def test_a_bound_project_still_gates_and_a_failing_check_still_fails(self):
        # The other half of the contract: skipping when there is nothing to
        # verify must not weaken the gate when there IS. A real project
        # directory + a genuinely failing command still fails the run, and is
        # NOT laundered into "could not run".
        res = tier1(['python3 -c "raise SystemExit(1)"'], cwd=self.tmp)
        self.assertFalse(res.passed)
        self.assertFalse(res.skipped)
        self.assertEqual(res.skip_reason, "")
        cr = res.commands[0]
        self.assertFalse(cr.not_found, "a real failing check is a failure, not a config gap")
        self.assertEqual(res.failed_commands, ['python3 -c "raise SystemExit(1)"'])

    def test_a_bound_project_that_passes_is_a_real_pass_not_a_skip(self):
        res = tier1(['python3 -c "pass"'], cwd=self.tmp)
        self.assertTrue(res.passed, res.log)
        self.assertFalse(res.skipped, "a gate that RAN must never report itself skipped")

    @unittest.skipIf(toolpath.which("npm") is None, "npm is not installed here")
    def test_npm_in_a_dir_with_no_package_json_anywhere_skips_not_fails(self):
        # THE regression test for the project-less shape. npm exits 254 with
        # `npm error code ENOENT` / `Could not read package.json`. First fix
        # (packaged app): stop it reading as a failing test (not_found). Second
        # fix (2026-08-29): stop it FAILING the tier at all — a new project's
        # workspace legitimately lacks package.json until the step that writes
        # it, and a hard fail here blocks step 1 on what step 4 will create.
        # The honest treatment is the same skip an unbound run already gets.
        self._assert_no_manifest_above(self.tmp)
        res = tier1(["npm test"], cwd=self.tmp, timeout=60)
        self.assertTrue(res.skipped, res.log)
        self.assertTrue(res.passed, "nothing to disprove — the gate must not block the step")
        self.assertEqual(res.skipped_commands, ["npm test"])
        self.assertIn("workspace has no project", res.skip_reason)

    def test_a_simulated_npm_enoent_skips_the_gate_without_needing_npm(self):
        # The same contract, pinned deterministically so the invariant holds on
        # a machine with no npm at all. Not a pass (nothing was verified), not
        # a failure (nothing was disproved) — a skip with the reason recorded.
        script = (
            "import sys;"
            "sys.stderr.write('npm error code ENOENT\\n"
            "npm error enoent Could not read package.json: Error: ENOENT\\n');"
            "sys.exit(254)"
        )
        cmd = f'python3 -c "{script}"'
        res = tier1([cmd], cwd=self.tmp)
        self.assertTrue(res.skipped, res.log)
        self.assertTrue(res.passed)
        self.assertEqual(res.commands, [], "a skipped tier reports no command results")
        self.assertEqual(res.failed_commands, [])
        self.assertEqual(res.missing_commands, [])
        self.assertEqual(res.skipped_commands, [cmd])
        self.assertIn("workspace has no project", res.skip_reason)
        self.assertIn(self.tmp, res.skip_reason)
        self.assertIn("neither a pass nor a test failure", res.skip_reason)

    def test_a_mixed_run_with_a_real_result_keeps_the_failure_contract(self):
        # The skip conversion is ALL-or-nothing: the tier skips only when EVERY
        # command hit the no-project wall. The moment any command produced a
        # real result, the ENOENT one keeps its honest could-not-run failure —
        # a partial verification must never be laundered into a full skip.
        script = (
            "import sys;"
            "sys.stderr.write('npm error code ENOENT\\n"
            "npm error enoent Could not read package.json: Error: ENOENT\\n');"
            "sys.exit(254)"
        )
        res = tier1(['python3 -c "pass"', f'python3 -c "{script}"'], cwd=self.tmp)
        self.assertFalse(res.skipped)
        self.assertFalse(res.passed)
        self.assertTrue(res.commands[1].not_found)
        self.assertIn("could not find a project", res.commands[1].stderr)

    def test_a_real_failing_test_that_exits_254_is_still_a_failure(self):
        # 254 alone proves nothing — only 254 WITH the project-lookup markers.
        res = tier1(['python3 -c "raise SystemExit(254)"'], cwd=self.tmp)
        cr = res.commands[0]
        self.assertFalse(res.passed)
        self.assertFalse(cr.not_found)

    def test_a_missing_project_directory_is_reported_not_raised(self):
        gone = os.path.join(self.tmp, "deleted-project")
        res = tier1(["python3 -c 'pass'"], cwd=gone)
        cr = res.commands[0]
        self.assertFalse(res.passed)
        self.assertTrue(cr.not_found)
        self.assertIn("could not run in", cr.stderr)

    def test_an_omitted_cwd_still_runs_in_the_process_directory(self):
        # None != "" — a shell/CLI caller chose their directory by standing in
        # it, and that path stays byte-identical.
        res = tier1(['python3 -c "import os;print(os.getcwd())"'])
        self.assertTrue(res.passed, res.log)
        self.assertEqual(
            os.path.realpath(res.commands[0].stdout.strip()), os.path.realpath(os.getcwd())
        )


class ShellNotFoundParsingTests(unittest.TestCase):
    """Exit 127 plus the words "not found" is NOT proof of a missing command."""

    def test_a_real_failing_test_exiting_127_saying_not_found_is_a_failure(self):
        # The old rule (`returncode == 127 and "not found" in stderr`) told the
        # user "This is not a test failure" about a genuinely failing test.
        res = tier1(
            [
                "python3 -c \"import sys; sys.stderr.write('FAIL: fixture not found\\n');"
                ' sys.exit(127)"'
            ]
        )
        cr = res.commands[0]
        self.assertFalse(res.passed)
        self.assertFalse(cr.not_found, cr.stderr)
        self.assertNotIn("verify command not found", cr.stderr)

    def test_the_missing_name_comes_from_the_shell_not_the_head_word(self):
        # `cd . && <missing>`: the head word is `cd`, which exists. Naming it as
        # the missing program sends the user off to install the wrong thing.
        res = tier1(["cd . && scprism-definitely-not-installed"])
        cr = res.commands[0]
        self.assertTrue(cr.not_found)
        self.assertIn("verify command not found: scprism-definitely-not-installed", cr.stderr)
        self.assertNotIn("verify command not found: cd", cr.stderr)


class LibRsParityTests(unittest.TestCase):
    """The Tauri shell mirrors `toolpath.STATIC_DIRS` in Rust — pin the pair.

    lib.rs builds the engine subprocess's PATH from its OWN copy of the install
    dirs. Nothing made the two lists agree; they simply happened to. A directory
    added to one and not the other silently reintroduces the GUI-PATH bug for
    exactly one of the engine's two lookup paths, which is the hardest possible
    version of it to notice.
    """

    def _lib_rs(self):
        here = os.path.dirname(os.path.abspath(__file__))
        path = os.path.normpath(os.path.join(here, "..", "..", "src-tauri", "src", "lib.rs"))
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()

    def _const_array(self, src, name):
        import re

        m = re.search(rf"const {name}:\s*\[&str;\s*\d+\]\s*=\s*\[(.*?)\];", src, re.S)
        self.assertIsNotNone(m, f"{name} not found in lib.rs — was it renamed?")
        return re.findall(r'"([^"]+)"', m.group(1))

    def test_lib_rs_tool_dirs_match_toolpath_static_dirs(self):
        src = self._lib_rs()
        tool_dirs = self._const_array(src, "TOOL_DIRS")
        home_dirs = self._const_array(src, "HOME_TOOL_DIRS")
        # lib.rs stores the home dirs relative (joined onto $HOME); toolpath
        # stores them as `~/...`. Normalise to one form before comparing.
        rust = list(tool_dirs) + [f"~/{d}" for d in home_dirs]
        self.assertEqual(
            rust,
            list(toolpath.STATIC_DIRS),
            "lib.rs and toolpath.STATIC_DIRS have drifted — the engine process "
            "and the verify shell would search different directories",
        )


if __name__ == "__main__":
    unittest.main()
