"""The tool-call parser must accept the argument shapes models actually emit.

Found live 2026-08-31 in a real web-research run: the model fired `web_search`
and the engine executed it with `{}`, answering "web_search requires a string
'query' argument" — a wasted model turn, twice in one run, on a call the model
got semantically right. The parser recognised only `"arguments"`, while models
routinely write `"parameters"`, `"input"`, `"args"`, or simply put the
parameters at the top level beside `"tool"`.

This is a PARSER tolerance fix, not a protocol change: the manifest still
documents exactly one shape, and a call already using `"arguments"` parses
byte-identically. Being strict here cost turns and taught the model nothing —
the error text it got back never named the key it should have used.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.toolloop import parse_tool_call


def _fenced(body: str) -> str:
    return "I'll look that up.\n\n```tool_call\n" + body + "\n```\n"


class TestArgumentAliases(unittest.TestCase):
    def test_the_documented_shape_is_unchanged(self):
        call = parse_tool_call(_fenced('{"tool": "web_search", "arguments": {"query": "moppers"}}'))
        self.assertEqual(call, {"tool": "web_search", "arguments": {"query": "moppers"}})

    def test_parameters_alias(self):
        call = parse_tool_call(
            _fenced('{"tool": "web_search", "parameters": {"query": "moppers"}}')
        )
        self.assertEqual(call["arguments"], {"query": "moppers"})

    def test_input_alias(self):
        call = parse_tool_call(_fenced('{"tool": "web_search", "input": {"query": "moppers"}}'))
        self.assertEqual(call["arguments"], {"query": "moppers"})

    def test_args_alias(self):
        call = parse_tool_call(_fenced('{"tool": "web_search", "args": {"query": "moppers"}}'))
        self.assertEqual(call["arguments"], {"query": "moppers"})

    def test_top_level_parameters(self):
        """The commonest miss: the params sit beside "tool", with no wrapper."""
        call = parse_tool_call(_fenced('{"tool": "web_search", "query": "moppers"}'))
        self.assertEqual(call["arguments"], {"query": "moppers"})

    def test_name_is_accepted_for_the_tool_key(self):
        call = parse_tool_call(_fenced('{"name": "web_search", "arguments": {"query": "m"}}'))
        self.assertEqual(call["tool"], "web_search")

    def test_name_plus_top_level_params_does_not_leak_the_name_key(self):
        call = parse_tool_call(_fenced('{"name": "web_search", "query": "moppers"}'))
        self.assertEqual(call["tool"], "web_search")
        self.assertEqual(call["arguments"], {"query": "moppers"})

    def test_a_call_with_genuinely_no_arguments_still_parses_empty(self):
        call = parse_tool_call(_fenced('{"tool": "vault_list"}'))
        self.assertEqual(call["arguments"], {})

    def test_an_explicit_wrapper_wins_over_stray_top_level_keys(self):
        call = parse_tool_call(
            _fenced('{"tool": "web_search", "arguments": {"query": "real"}, "note": "ignore me"}')
        )
        self.assertEqual(call["arguments"], {"query": "real"})

    def test_a_non_object_wrapper_is_still_rejected(self):
        self.assertIsNone(parse_tool_call(_fenced('{"tool": "web_search", "arguments": "nope"}')))


if __name__ == "__main__":
    unittest.main()
