"""Gate 3 — the static audit.

The spec's list: "dynamic evaluation of strings, subprocess spawning, outbound
sockets, writes outside declared paths, credential access."

WHY THIS IS AN AST WALK AND NOT A REGEX SWEEP. A regex over source is
bypassable by anyone who knows it exists — `ev + "al"`, a line break inside the
call, an alias, a lookup through getattr. The generator writing these tools is
a language model that has read a great deal of code, and a check it can talk
its way around is a check that will eventually be talked around. An AST sees
the call that will actually execute, not the characters that spell it.

The audit is a SECOND line, not the only one. Gate 2 already ran the tool with
the kernel enforcing its permissions. This catches what a passing sandbox run
cannot: capability that exists in the code but happened not to fire on the test
cases the user supplied.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.toolgen import audit_source, parse_manifest


def _m(**over):
    base = {
        "name": "tool_under_audit", "version": "1.0.0", "description": "d", "runtime": "python3",
        "entrypoint": "tool.py:run",
        "input_schema": {}, "output_schema": {},
        "permissions": {}, "data_class": "confidential",
    }
    base.update(over)
    return parse_manifest(base)


class TestDynamicEvaluation(unittest.TestCase):
    def test_eval_is_refused(self):
        f = audit_source("x = eval('1+1')", _m())
        self.assertTrue(f)
        self.assertEqual(f[0].kind, "dynamic_eval")

    def test_exec_and_compile_are_refused(self):
        self.assertTrue(audit_source("exec('x=1')", _m()))
        self.assertTrue(audit_source("compile('x', '<s>', 'exec')", _m()))

    def test_dunder_import_is_refused(self):
        self.assertTrue(audit_source("__import__('os').system('ls')", _m()))

    def test_an_alias_does_not_get_past_it(self):
        """A regex sweep would miss this. The AST does not."""
        self.assertTrue(audit_source("e = eval\ne('1+1')", _m()))

    def test_a_getattr_lookup_is_refused(self):
        self.assertTrue(audit_source("getattr(__builtins__, 'eval')('1')", _m()))


class TestSubprocessAndShell(unittest.TestCase):
    def test_subprocess_is_refused(self):
        f = audit_source("import subprocess\nsubprocess.run(['ls'])", _m())
        self.assertTrue(f)
        self.assertEqual(f[0].kind, "subprocess")

    def test_os_system_is_refused(self):
        self.assertTrue(audit_source("import os\nos.system('ls')", _m()))

    def test_os_popen_and_exec_family_are_refused(self):
        self.assertTrue(audit_source("import os\nos.popen('ls')", _m()))
        self.assertTrue(audit_source("import os\nos.execv('/bin/ls', [])", _m()))


class TestNetwork(unittest.TestCase):
    def test_a_socket_is_refused_when_no_network_was_declared(self):
        f = audit_source("import socket\ns = socket.socket()", _m())
        self.assertTrue(f)
        self.assertEqual(f[0].kind, "network")

    def test_http_libraries_are_refused_too(self):
        for src in (
            "import urllib.request\nurllib.request.urlopen('http://x')",
            "import requests\nrequests.get('http://x')",
            "import http.client",
        ):
            with self.subTest(src=src):
                self.assertTrue(audit_source(src, _m()))

    def test_network_is_allowed_when_the_manifest_declared_it(self):
        m = _m(permissions={"network": ["api.example.com"]}, data_class="public")
        self.assertEqual(audit_source("import socket\ns = socket.socket()", m), [])


class TestCredentialAccess(unittest.TestCase):
    def test_reading_ssh_keys_is_refused(self):
        f = audit_source("open('/Users/x/.ssh/id_rsa').read()", _m())
        self.assertTrue(f)
        self.assertIn(f[0].kind, ("credential_access", "undeclared_path"))

    def test_reading_the_app_key_store_is_refused(self):
        self.assertTrue(
            audit_source("open('~/Library/Application Support/com.slashcreative.scprism/store/settings.json')", _m())
        )

    def test_reading_the_environment_for_secrets_is_refused(self):
        self.assertTrue(audit_source("import os\nk = os.environ['ANTHROPIC_API_KEY']", _m()))


class TestPaths(unittest.TestCase):
    def test_an_absolute_write_outside_the_declaration_is_refused(self):
        f = audit_source("open('/etc/hosts', 'w').write('x')", _m())
        self.assertTrue(f)

    def test_a_relative_escape_is_refused(self):
        self.assertTrue(audit_source("open('../../secrets.txt')", _m()))

    def test_a_declared_relative_path_is_fine(self):
        m = _m(permissions={"filesystem_read": ["vault/inbox/**"]})
        self.assertEqual(audit_source("open('vault/inbox/a.pdf')", m), [])


class TestTheAuditIsUsable(unittest.TestCase):
    def test_a_clean_tool_produces_no_findings(self):
        src = (
            "import json\n"
            "def run(payload):\n"
            "    return {'n': payload.get('n', 0) * 2}\n"
        )
        self.assertEqual(audit_source(src, _m()), [])

    def test_unparseable_source_is_a_finding_not_a_crash(self):
        f = audit_source("def run(:\n", _m())
        self.assertTrue(f)
        self.assertEqual(f[0].kind, "unparseable")

    def test_every_finding_names_a_line(self):
        f = audit_source("import json\nx = eval('1')", _m())
        self.assertEqual(f[0].line, 2)

    def test_findings_are_machine_readable(self):
        f = audit_source("import subprocess", _m())
        self.assertTrue(all(x.kind and x.detail for x in f))


if __name__ == "__main__":
    unittest.main()
