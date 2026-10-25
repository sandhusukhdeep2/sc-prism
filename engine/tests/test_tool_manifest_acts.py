"""The tool manifest must tell the model to ACT, not narrate.

Found live 2026-08-31: with the web tools genuinely available and granted,
models replied "I cannot search the live web" and "here is my plan — confirm
and I will execute", and the run recorded ZERO tool calls. The manifest
listed the tools and the call protocol but never said to use them, so a
cautious model treated its plan as the final answer. These lines are the
difference between a tool that is offered and a tool that is used.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.mcp import MCPTool
from scprism_engine.toolloop import build_tool_manifest


class TestManifestActs(unittest.TestCase):
    def setUp(self):
        self.manifest = build_tool_manifest(
            [
                MCPTool(
                    name="web_search",
                    description="search the web",
                    input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
                )
            ]
        )

    def test_it_still_lists_the_tool_and_the_call_protocol(self):
        self.assertIn("web_search", self.manifest)
        self.assertIn("```tool_call", self.manifest)

    def test_it_forbids_asking_for_confirmation_or_narrating_a_plan(self):
        low = self.manifest.lower()
        self.assertIn("already authorized", low)
        self.assertIn("do not ask for confirmation", low)
        self.assertIn("call it now", low)

    def test_it_forbids_the_false_i_cannot_refusal(self):
        self.assertIn("Never claim you cannot search the web", self.manifest)

    def test_it_prefers_tool_results_over_memory(self):
        self.assertIn("not from memory", self.manifest)


if __name__ == "__main__":
    unittest.main()
