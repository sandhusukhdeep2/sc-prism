"""A step that failed because the PROVIDER never answered says so.

Found live (2026-08-31, stress check): the founder's Claude CLI hit its plan
limit mid-build. The gateway honestly returned
``[offline:claude-cli:fable] GatewayError: … You've reached your Fable 5
limit``, but the step reported only "no file blocks in completion" — true,
useless, and it sends a user hunting a bug in their own prompt when the real
fix is "wait, or switch model". The provider's own sentence now leads.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine.project import FileBlockContract


from dataclasses import dataclass, field
from typing import Any, Dict


@dataclass
class _Result:
    """The minimum ModelCall result shape the contract touches."""

    text: str
    tokens: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    extras: Dict[str, Any] = field(default_factory=dict)


class TestProviderErrorLeads(unittest.TestCase):
    def test_offline_stand_in_becomes_the_reason(self):
        c = FileBlockContract()
        wrapped = c.wrap(
            lambda _p, _r: _Result(
                "[offline:claude-cli:fable] GatewayError: claude exited 1: "
                "You've reached your Fable 5 limit."
            )
        )
        wrapped("do the step", "cloud")
        reason = c.no_blocks_reason(parsed_any=False)
        self.assertIn("never answered", reason)
        self.assertIn("Fable 5 limit", reason)

    def test_a_real_prose_reply_keeps_its_own_reason(self):
        c = FileBlockContract()
        wrapped = c.wrap(lambda _p, _r: _Result("Here is my analysis of the task."))
        wrapped("do the step", "cloud")
        reason = c.no_blocks_reason(parsed_any=False)
        self.assertNotIn("never answered", reason)
        self.assertIn("file blocks", reason)


if __name__ == "__main__":
    unittest.main()
