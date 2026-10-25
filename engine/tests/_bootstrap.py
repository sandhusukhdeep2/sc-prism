"""Make `scprism_engine` importable when tests are discovered from repo root.

`python3 -m unittest discover -s engine/tests` runs with CWD at the repo root,
so the package dir (engine/) is not on sys.path by default. Each test module
imports this first.
"""

import os
import sys

_ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ENGINE_ROOT not in sys.path:
    sys.path.insert(0, _ENGINE_ROOT)
