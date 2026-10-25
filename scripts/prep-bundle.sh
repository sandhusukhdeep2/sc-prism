#!/usr/bin/env bash
set -euo pipefail

# prep-bundle.sh — stage the self-contained runtime resources that get baked into
# the SC Prism .app so it runs the REAL Python engine with NO dependency on the
# repo at runtime.
#
# Produces src-tauri/resources/ containing:
#   python/   — the portable, relocatable Python 3.12 (copied from .pytool/python)
#   engine/   — the engine package (scprism_engine) + goldens
#
# tauri.conf.json bundles resources/** into the app, landing them at
#   <App>.app/Contents/Resources/resources/{python,engine}
# which src-tauri/src/lib.rs resolves via app.path().resource_dir() at runtime.
#
# Reproducible: the resources dir is wiped and recopied on every run.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

PYTOOL_SRC="$PROJECT_ROOT/.pytool/python"
ENGINE_PKG_SRC="$PROJECT_ROOT/engine/scprism_engine"
GOLDENS_SRC="$PROJECT_ROOT/engine/goldens"

RES_DIR="$PROJECT_ROOT/src-tauri/resources"
RES_PYTHON="$RES_DIR/python"
RES_ENGINE="$RES_DIR/engine"

# --- sanity checks on sources ---
[ -x "$PYTOOL_SRC/bin/python3" ] || { echo "ERROR: portable python not found at $PYTOOL_SRC/bin/python3 (build it into .pytool/python first)" >&2; exit 1; }
[ -d "$ENGINE_PKG_SRC" ]        || { echo "ERROR: engine package not found at $ENGINE_PKG_SRC" >&2; exit 1; }
[ -d "$GOLDENS_SRC" ]           || { echo "ERROR: goldens not found at $GOLDENS_SRC" >&2; exit 1; }

echo "==> Wiping $RES_DIR ..."
rm -rf "$RES_DIR"
mkdir -p "$RES_ENGINE"

# --- (a) portable Python: preserve executables + symlinks (ditto is symlink-safe) ---
echo "==> Staging portable Python (.pytool/python -> resources/python) ..."
ditto "$PYTOOL_SRC" "$RES_PYTHON"

# --- (b) engine: package + goldens, without bytecode caches ---
echo "==> Staging engine (scprism_engine + goldens -> resources/engine) ..."
ditto "$ENGINE_PKG_SRC" "$RES_ENGINE/scprism_engine"
ditto "$GOLDENS_SRC"    "$RES_ENGINE/goldens"
# Drop compiled bytecode so the staged tree is clean/reproducible — and because
# a .pyc records the absolute path of the file it was compiled from. Leaving
# them in ships the build machine's home directory and the private source
# layout to every user. This must cover the bundled interpreter too, not just
# the engine: the stdlib .pyc carry the same paths.
find "$RES_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$RES_DIR" -name '*.pyc' -delete 2>/dev/null || true

# --- (c) bifrostd: the Go router + prompt/semantic cache the engine supervises.
# bifrost_client resolves <engine dir>/bifrost/bifrostd relative to the PACKAGE,
# so in the bundle that is resources/engine/bifrost/bifrostd. It was never
# staged: every packaged install ran with SCPRISM_BIFROST=1 and no daemon to
# spawn — the engine fell back silently and the Stats cache card said
# "warming" over a cache that could not exist. Stage it when built; a missing
# binary WARNS instead of failing so a Go-less machine can still bundle.
BIFROSTD_SRC="$PROJECT_ROOT/engine/bifrost/bifrostd"
if [ -x "$BIFROSTD_SRC" ]; then
  echo "==> Staging bifrostd (engine/bifrost/bifrostd -> resources/engine/bifrost/) ..."
  mkdir -p "$RES_ENGINE/bifrost"
  ditto "$BIFROSTD_SRC" "$RES_ENGINE/bifrost/bifrostd"
  chmod +x "$RES_ENGINE/bifrost/bifrostd"
else
  echo "WARN: engine/bifrost/bifrostd not built — the packaged app will run without the Bifrost router/cache" >&2
fi

# --- smoke: the staged interpreter can import the staged engine (no repo on path) ---
# -B / PYTHONDONTWRITEBYTECODE: this import used to run AFTER the bytecode strip
# above and silently undo it — importing the engine compiles it and every stdlib
# module it touches, and each .pyc records the absolute path it was compiled
# from. That is how 129 .pyc carrying the build machine's home directory reached
# the shipped v0.1.0 DMG.
echo "==> Smoke test: staged python imports staged engine ..."
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$RES_ENGINE" "$RES_PYTHON/bin/python3" -B \
  -c "import scprism_engine; print('   staged engine import OK')"

# --- bytecode strip, LAST: nothing after this point may write a .pyc ---
find "$RES_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$RES_DIR" -name '*.pyc' -delete 2>/dev/null || true
remaining=$(find "$RES_DIR" -name '*.pyc' | wc -l | tr -d ' ')
if [ "$remaining" != "0" ]; then
  echo "ERROR: $remaining .pyc survived the strip — they carry build paths" >&2
  exit 1
fi

echo "==> Done. Staged resources:"
du -sh "$RES_PYTHON" "$RES_ENGINE"
