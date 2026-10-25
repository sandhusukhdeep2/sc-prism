"""The SSRF guard must judge an IPv6 address by the IPv4 it REALLY reaches.

Found while investigating a live report (2026-08-17): the model said "The HTTPS
fetcher hit a local issue" and three ``web_fetch`` calls to
``https://themeforest.net/user/slashcreative`` failed in 49.7 ms, 3.9 ms and
12.4 ms — far too fast for any network round trip, so the failure was inside our
own pre-resolution SSRF check, and the same URL fetches fine from the same code
today. The span recorded ``is_error: true`` and nothing else, so the reason was
unrecoverable from the trace. Both halves are fixed here:

  * ``_ip_is_blocked`` now unwraps IPv4-in-IPv6 forms. Python classifies the
    WRAPPER, not the destination, and it was wrong both ways: ``::ffff:<public>``
    (what a dual-stack resolver or a connected socket reports for an IPv4 peer)
    reads as private AND reserved, so a public site was refused; ``2002:``
    6to4 wrapping ``10.0.0.1`` read as neither, so a private address could have
    been reached through it.
  * a failed web ``tool_exec`` span now records WHY.

No network: these are pure predicate tests plus one local-server span check.
"""

import ipaddress
import os
import tempfile
import unittest

import _bootstrap  # noqa: F401

from scprism_engine.telemetry import Telemetry, read_spans
from scprism_engine.webtools import (
    WebToolProvider,
    _embedded_ipv4,
    _ip_is_blocked,
    _ssrf_reject_reason,
    web_fetch,
)


def _blocked(text):
    return _ip_is_blocked(ipaddress.ip_address(text))


class TestIPv4InIPv6IsJudgedByItsDestination(unittest.TestCase):
    # These tests assert only the GUARD's verdict. They used to begin by asserting
    # the stdlib's own misclassification first ("the wrapper still lies"), but that
    # is version-dependent: Python 3.9 calls ::ffff:<public> private and 6to4-of-
    # private not private, and newer CPython corrected both. On a corrected Python
    # the precondition failed and the test stopped before ever checking the guard —
    # on 3.12, the interpreter the app ships, the guard was going unchecked. The
    # guard unwraps the embedded IPv4 itself, so it must be right on both.

    def test_public_ipv4_mapped_addresses_are_allowed(self):
        # The false BLOCK. 104.18.43.76 is a real public address themeforest.net
        # resolves to; Python 3.9 calls the mapped form private AND reserved.
        self.assertFalse(_blocked("::ffff:104.18.43.76"))
        self.assertFalse(_blocked("104.18.43.76"))  # and both forms agree

    def test_private_ipv4_mapped_addresses_are_still_blocked(self):
        for addr in ("::ffff:127.0.0.1", "::ffff:10.0.0.5", "::ffff:169.254.169.254"):
            with self.subTest(addr=addr):
                self.assertTrue(_blocked(addr))

    def test_nat64_is_judged_by_the_ipv4_it_synthesizes(self):
        # A DNS64 resolver (macOS does this on IPv6-only / CLAT networks) hands
        # back 64:ff9b:: addresses whose low 32 bits are the real IPv4.
        self.assertFalse(_blocked("64:ff9b::104.18.43.76"))
        self.assertTrue(_blocked("64:ff9b::10.0.0.1"))
        self.assertTrue(_blocked("64:ff9b::169.254.169.254"))

    def test_6to4_wrapping_a_private_address_is_blocked(self):
        # The false ALLOW this closes: 2002:0a00:0001:: embeds 10.0.0.1, and
        # Python 3.9 reports it neither private nor reserved.
        for addr in (
            "2002:0a00:0001::1",  # 10.0.0.1
            "2002:7f00:0001::1",  # 127.0.0.1
            "2002:a9fe:a9fe::1",  # 169.254.169.254, the cloud metadata address
        ):
            with self.subTest(addr=addr):
                self.assertTrue(_blocked(addr))
        # A 6to4 address wrapping a PUBLIC v4 is still fine.
        self.assertFalse(_blocked("2002:6812:2b4c::1"))

    def test_ordinary_addresses_are_unchanged(self):
        self.assertIsNone(_embedded_ipv4(ipaddress.ip_address("2606:4700::1")))
        self.assertFalse(_blocked("2606:4700::1"))  # public IPv6, allowed
        self.assertTrue(_blocked("::1"))  # loopback, blocked
        self.assertTrue(_blocked("fe80::1"))  # link-local, blocked
        self.assertTrue(_blocked("192.168.1.1"))
        self.assertFalse(_blocked("8.8.8.8"))

    def test_the_scheme_and_loopback_rejects_still_hold(self):
        # The guard's other refusals are untouched by the unwrap.
        self.assertIn("not allowed", _ssrf_reject_reason("file:///etc/passwd") or "")
        self.assertIn("loopback", _ssrf_reject_reason("http://localhost/x") or "")
        self.assertIn("blocked", _ssrf_reject_reason("http://127.0.0.1/x") or "")
        self.assertIsNone(_ssrf_reject_reason("http://10.0.0.1/x", allow_private=True))


class TestAFailedFetchSaysWhy(unittest.TestCase):
    """A failure the user can act on, and a trace we can diagnose."""

    def test_the_result_names_the_cause(self):
        res = web_fetch("http://127.0.0.1/secret")
        self.assertTrue(res["isError"])
        self.assertIn("blocked", res["content"][0]["text"])

    def test_the_span_records_the_reason_not_just_is_error(self):
        with tempfile.TemporaryDirectory() as d:
            spans = os.path.join(d, "spans.jsonl")
            prov = WebToolProvider(telemetry=Telemetry(spans), allow_private=False)
            res = prov.call_tool("web_fetch", {"url": "http://169.254.169.254/latest/meta-data/"})
            self.assertTrue(res.get("isError"))
            attrs = [s for s in read_spans(spans) if s["type"] == "tool_exec"][0]["attrs"]
            self.assertTrue(attrs["is_error"])
            # This is what was missing on 2026-08-17: the WHY.
            self.assertIn("blocked", attrs["error"])
            self.assertIn("169.254.169.254", attrs["error"])


if __name__ == "__main__":
    unittest.main()
