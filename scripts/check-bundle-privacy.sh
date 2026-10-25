#!/usr/bin/env bash
# check-bundle-privacy.sh — refuse to ship a bundle that carries the build
# machine's filesystem layout.
#
# WHY THIS EXISTS. The v0.1.0 DMG shipped `/Users/<builder>` in 709 distinct
# strings: Go recorded the compile-time path of every source file, the Rust
# binary baked in `CARGO_MANIFEST_DIR` through a release-mode fallback, and
# every .pyc carried its `co_filename`. None of it is visible in the repo, none
# of it shows up in a diff, and all of it is published to every user who
# downloads the app. A build flag fixes each one — and silently stops working
# the moment someone adds a step that regenerates bytecode or reintroduces an
# `env!` path, which is exactly what happened here. So the property is checked
# against the artefact, not the source.
#
# Run against a built .app:
#   scripts/check-bundle-privacy.sh "src-tauri/target/release/bundle/macos/SC Prism.app"
set -euo pipefail

APP="${1:-src-tauri/target/release/bundle/macos/SC Prism.app}"
[ -d "$APP" ] || { echo "ERROR: no bundle at $APP — build it first" >&2; exit 1; }

# The build machine's home. Matching on the literal path rather than the
# username alone keeps this working for any developer who builds it.
HOME_RE="/Users/[A-Za-z0-9._-]+"
fail=0

report() {  # report <label> <count> <sample>
  if [ "$2" -gt 0 ]; then
    printf '  FAIL  %-34s %s occurrence(s)\n' "$1" "$2"
    [ -n "${3:-}" ] && printf '        e.g. %s\n' "$3"
    fail=1
  else
    printf '  ok    %-34s clean\n' "$1"
  fi
}

echo "==> Scanning $APP for build-machine paths ..."

# --- compiled binaries ---
for bin in "$APP/Contents/MacOS/"* \
           "$APP/Contents/Resources/resources/engine/bifrost/bifrostd"; do
  [ -f "$bin" ] || continue
  n=$(strings "$bin" 2>/dev/null | grep -cE "$HOME_RE" || true)
  sample=$(strings "$bin" 2>/dev/null | grep -oE "$HOME_RE[A-Za-z0-9/._-]*" | head -1 || true)
  report "$(basename "$bin")" "${n:-0}" "$sample"
done

# --- python bytecode: co_filename records the path it was compiled from ---
pyc=$(find "$APP" -name '*.pyc' 2>/dev/null | wc -l | tr -d ' ')
sample_pyc=$(find "$APP" -name '*.pyc' 2>/dev/null | head -1)
if [ "$pyc" -gt 0 ]; then
  inside=$(strings "$sample_pyc" 2>/dev/null | grep -oE "$HOME_RE[A-Za-z0-9/._-]*" | head -1 || true)
  report "compiled bytecode (.pyc)" "$pyc" "$sample_pyc${inside:+ -> $inside}"
else
  report "compiled bytecode (.pyc)" 0
fi

# --- shipped source: the engine ships as plaintext, so comments ship too ---
names=$( { grep -rlEi "sukhdeep|sandhu" "$APP/Contents/Resources/resources/engine" 2>/dev/null || true; } | wc -l | tr -d ' ')
first=$( { grep -rlEi "sukhdeep|sandhu" "$APP/Contents/Resources/resources/engine" 2>/dev/null || true; } | head -1)
report "personal names in shipped source" "${names:-0}" "$first"

echo
if [ "$fail" -eq 1 ]; then
  echo "REFUSING TO SHIP: the bundle publishes the build machine's layout." >&2
  echo "BUNDLE PRIVACY: FAIL"
  exit 1
fi
echo "BUNDLE PRIVACY: PASS"
