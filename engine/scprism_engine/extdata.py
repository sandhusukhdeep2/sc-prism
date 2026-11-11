"""Where the optional libraries keep their data (2026-11-11).

LightRAG keeps a graph index and DeepEval keeps a cache. Both used to live
under ``engine/`` — fine in a checkout, but in an installed app ``engine/`` is
inside the signed, read-only application bundle. The app names a writable
folder in ``SCPRISM_EXT_DATA`` (under the user's vault, in the hidden
``.scprism`` tree the notes index and the vault check skip); without it the
old location is used, so a checkout behaves exactly as before.
"""

from __future__ import annotations

import os
from typing import Mapping, Optional

ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def ext_data_dir(env: Optional[Mapping[str, str]] = None) -> str:
    """The folder optional libraries may write to."""
    env = os.environ if env is None else env
    named = str(env.get("SCPRISM_EXT_DATA", "") or "").strip()
    return named or ENGINE_DIR
