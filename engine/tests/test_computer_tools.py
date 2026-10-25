"""Computer control as a governed capability (Sukhdeep, 2026-08-29 evening:
"give our agent capability to control the PC… screenshots… and manager is the
one who is choosing who got how many powers").

Same contract as every other tool source: MCPClient-shaped provider tagged
``provider="computer"``, gated by the SAME per-agent grants (the seat's file
must declare ``tools: [computer]`` and the user's ceiling must hold it), and
riding the approval gate like any other side-effectful tool. macOS TCC
denials surface as HONEST errors naming the permission and where to grant it
— never a mystery failure."""

import unittest
from unittest import mock

import _bootstrap  # noqa: F401

from scprism_engine.capabilities import CAPABILITIES, capability_for_provider
from scprism_engine.computer_tools import ComputerToolProvider
from scprism_engine.mcp import MCPBlockedError


def _proc(returncode=0, stdout=b"", stderr=b""):
    p = mock.Mock()
    p.returncode = returncode
    p.stdout = stdout
    p.stderr = stderr
    return p


class TestComputerCapability(unittest.TestCase):
    def test_computer_is_a_known_capability_and_provider_maps_to_it(self):
        self.assertIn("computer", CAPABILITIES)
        self.assertEqual(capability_for_provider("computer"), "computer")

    def test_lists_the_five_tools(self):
        prov = ComputerToolProvider()
        names = {t.name for t in prov.list_tools()}
        self.assertEqual(
            names,
            {
                "computer_screenshot",
                "computer_open_app",
                "computer_click",
                "computer_type",
                "computer_key",
            },
        )

    def test_screenshot_success_returns_the_file_path(self):
        prov = ComputerToolProvider()
        with mock.patch("scprism_engine.computer_tools.subprocess.run", return_value=_proc(0)):
            with mock.patch("scprism_engine.computer_tools.os.path.getsize", return_value=51234):
                out = prov.call_tool("computer_screenshot", {})
        self.assertFalse(out.get("isError"))
        self.assertTrue(str(out.get("path", "")).endswith(".png"))
        self.assertEqual(out.get("bytes"), 51234)

    def test_screenshot_tcc_denial_names_the_permission(self):
        prov = ComputerToolProvider()
        with mock.patch(
            "scprism_engine.computer_tools.subprocess.run",
            return_value=_proc(1, stderr=b"could not create image from display"),
        ):
            out = prov.call_tool("computer_screenshot", {})
        self.assertTrue(out.get("isError"))
        self.assertIn("Screen Recording", out["content"][0]["text"])
        self.assertIn("System Settings", out["content"][0]["text"])

    def test_click_denial_names_accessibility(self):
        prov = ComputerToolProvider()
        with mock.patch(
            "scprism_engine.computer_tools.subprocess.run",
            return_value=_proc(1, stderr=b"execution error: Not authorised to send Apple events (-1743)"),
        ):
            out = prov.call_tool("computer_click", {"x": 100, "y": 200})
        self.assertTrue(out.get("isError"))
        self.assertIn("Accessibility", out["content"][0]["text"])

    def test_type_requires_text(self):
        prov = ComputerToolProvider()
        out = prov.call_tool("computer_type", {})
        self.assertTrue(out.get("isError"))

    def test_allowlist_blocks_unlisted_tools(self):
        prov = ComputerToolProvider(allowed_tools=["computer_screenshot"])
        with self.assertRaises(MCPBlockedError):
            prov.call_tool("computer_click", {"x": 1, "y": 2})


if __name__ == "__main__":
    unittest.main()
