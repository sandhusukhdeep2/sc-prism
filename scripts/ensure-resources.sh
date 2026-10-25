#!/usr/bin/env bash
# ensure-resources.sh — make `src-tauri/resources/` exist and hold at least one
# file, so dev and test builds compile on a fresh clone.
#
# tauri.conf.json bundles "resources/**/*", and Tauri's build script FAILS when
# that glob matches nothing ("path not found or didn't match any files"). The
# directory is gitignored because a release build fills it with the staged
# Python runtime and engine (scripts/prep-bundle.sh). On the author's machine it
# always existed; on any fresh clone — and in CI — `cargo test` and
# `tauri dev` failed before compiling a line.
#
# A dev build runs the engine straight from engine/ (see resolve_engine_runtime
# in src-tauri/src/lib.rs), so all it needs here is a file for the glob to
# match. A release build wipes this directory and stages the real contents, so
# the placeholder never reaches a shipped app.
set -euo pipefail
RES="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src-tauri/resources"
mkdir -p "$RES"
if [ -z "$(ls -A "$RES")" ]; then
  cat > "$RES/README.txt" <<'TXT'
Placeholder for dev and test builds. `npm run tauri:build` replaces this
directory with the staged Python runtime and engine (scripts/prep-bundle.sh).
TXT
fi
