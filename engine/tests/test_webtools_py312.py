"""The guarded HTTPS handler must work on the bundled Python 3.12.

Found live (2026-08-31, sprint D's proof run): every https fetch failed with
"'_GuardedHTTPSHandler' object has no attribute '_check_hostname'" — the
handler passed py<=3.11's private ``check_hostname`` kwarg to ``do_open``,
which 3.12 removed (hostname verification lives on the SSLContext now). The
pin: ``https_open`` completes without touching removed attributes and never
forwards a ``check_hostname`` kwarg.
"""
import unittest

import _bootstrap  # noqa: F401
from scprism_engine import webtools


class TestGuardedHTTPSHandlerPy312(unittest.TestCase):
    def test_https_open_uses_only_supported_do_open_kwargs(self):
        opener = webtools._guarded_opener(False)
        handler = next(
            h for h in opener.handlers if type(h).__name__ == "_GuardedHTTPSHandler"
        )
        captured = {}

        def fake_do_open(cls, req, **kw):
            captured.update(kw)
            return "opened"

        handler.do_open = fake_do_open  # type: ignore[assignment]
        result = handler.https_open(object())
        self.assertEqual(result, "opened")
        self.assertNotIn("check_hostname", captured)


if __name__ == "__main__":
    unittest.main()
