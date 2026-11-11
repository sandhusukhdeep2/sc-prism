#!/usr/bin/env bash
set -euo pipefail

# build-extensions.sh — build the optional-library environment that
# prep-bundle.sh packs into the app (2026-11-11).
#
# LightRAG (graph retrieval) and DeepEval (the Tier-2 judge framework) used to
# exist only in two developer virtualenvs, so every installed app said "not
# installed here". They are installed TOGETHER, at pinned versions, into ONE
# environment built with the same portable Python the app ships
# (.pytool/python), so their compiled wheels match the bundled interpreter and
# both can be switched on at once.
#
# Output: engine/.venv-ext (git-ignored). Re-run to rebuild from scratch.
# Needs network access to PyPI.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PY="$PROJECT_ROOT/.pytool/python/bin/python3"
ENV_DIR="$PROJECT_ROOT/engine/.venv-ext"

# Pinned: the versions the engine's backends were written and tested against.
LIGHTRAG_VERSION="1.5.4"
DEEPEVAL_VERSION="4.0.7"

[ -x "$PY" ] || { echo "ERROR: portable python not found at $PY" >&2; exit 1; }

echo "==> Rebuilding $ENV_DIR ..."
rm -rf "$ENV_DIR"
"$PY" -m venv "$ENV_DIR"
"$ENV_DIR/bin/python3" -m pip install --quiet --disable-pip-version-check \
  "lightrag-hku==$LIGHTRAG_VERSION" "deepeval==$DEEPEVAL_VERSION"

echo "==> Smoke test: both libraries import and LightRAG is runnable ..."
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PROJECT_ROOT/engine" "$ENV_DIR/bin/python3" -B -c "
import lightrag, deepeval
from scprism_engine import lightrag_backend, deepeval_backend
assert lightrag_backend.lightrag_available(), lightrag_backend.runnable_error()
assert deepeval_backend.deepeval_available()
print('   lightrag', lightrag.__version__, '· deepeval', deepeval.__version__, '· OK')
"
echo "EXTENSIONS: PASS"
