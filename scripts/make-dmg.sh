#!/usr/bin/env bash
set -euo pipefail

# Build SC Prism and package a compressed .dmg from the produced .app bundle.
# Run from the project root (directory containing package.json).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

VOL_NAME="SC Prism"
OUT_DIR="$PROJECT_ROOT/dist-dmg"
OUT_DMG="$OUT_DIR/SC Prism.dmg"

if [ "${SKIP_BUILD:-0}" = "1" ]; then
  # The signing pipeline packs the ALREADY signed+notarized+stapled app —
  # rebuilding here overwrote it with a fresh unsigned one and Apple rejected
  # the DMG (2026-08-31, submission 8898a4be: "binary is not signed").
  echo "==> SKIP_BUILD=1 — packaging the existing signed app"
else
  echo "==> Building app (npm run tauri:build)..."
  npm run tauri:build
fi

echo "==> Locating produced 'SC Prism.app'..."
APP_PATH="$(find "$PROJECT_ROOT/src-tauri/target" -type d -path '*/bundle/macos/SC Prism.app' -print 2>/dev/null | head -n 1)"
if [ -z "$APP_PATH" ]; then
  echo "ERROR: Could not find 'SC Prism.app' under src-tauri/target/*/bundle/macos/" >&2
  exit 1
fi
echo "    Found: $APP_PATH"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DMG"

echo "==> Creating compressed .dmg..."
hdiutil create -volname "$VOL_NAME" -srcfolder "$APP_PATH" -ov -format UDZO "$OUT_DMG"

echo "==> Verifying .dmg..."
hdiutil verify "$OUT_DMG"

echo ""
echo "==> Done. DMG created at:"
echo "    $OUT_DMG"
