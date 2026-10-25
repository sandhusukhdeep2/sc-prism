#!/usr/bin/env bash
# SC Prism — sign + notarize the macOS build (Developer ID + Apple notarytool).
#
# This produces a Gatekeeper-accepted, notarized, stapled .app and .dmg.
# It CANNOT run without YOUR paid Apple Developer account + a "Developer ID
# Application" certificate installed in your login keychain. Supply credentials
# via env vars (or a keychain profile) and run it once:
#
#   APPLE_SIGN_ID="Developer ID Application: Your Name (TEAMID)" \
#   APPLE_ID="you@example.com" APPLE_TEAM_ID="TEAMID" \
#   APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"  \
#   ./scripts/sign-and-notarize.sh
#
# APPLE_APP_PASSWORD is an app-specific password (appleid.apple.com → Sign-In &
# Security → App-Specific Passwords). Alternatively pre-store a notarytool
# profile once (`xcrun notarytool store-credentials scprism-notary ...`) and set
# NOTARY_PROFILE=scprism-notary instead of the three APPLE_* vars.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="src-tauri/target/release/bundle/macos/SC Prism.app"
OUT_DMG="dist-dmg/SC Prism.dmg"

# --- preflight ---
[ -d "$APP" ] || { echo "ERROR: build the app first: npm run tauri:build"; exit 1; }

# Refuse to sign a bundle that carries the build machine's filesystem layout.
# v0.1.0 shipped 709 such strings — Go's compile-time paths, the Rust binary's
# CARGO_MANIFEST_DIR fallback, and 129 .pyc co_filenames — none of which is
# visible in a diff. Signing is the last point where this is cheap to catch.
"$(dirname "$0")/check-bundle-privacy.sh" "$APP"
: "${APPLE_SIGN_ID:?set APPLE_SIGN_ID to your 'Developer ID Application: …' identity}"
if [ -z "${NOTARY_PROFILE:-}" ]; then
  : "${APPLE_ID:?set APPLE_ID (or NOTARY_PROFILE)}"
  : "${APPLE_TEAM_ID:?set APPLE_TEAM_ID (or NOTARY_PROFILE)}"
  : "${APPLE_APP_PASSWORD:?set APPLE_APP_PASSWORD (or NOTARY_PROFILE)}"
fi
command -v xcrun >/dev/null || { echo "ERROR: Xcode command line tools required"; exit 1; }

notary_args=()
if [ -n "${NOTARY_PROFILE:-}" ]; then
  notary_args=(--keychain-profile "$NOTARY_PROFILE")
else
  notary_args=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD")
fi

echo "==> 1/5 codesign every nested Mach-O, then the .app (hardened runtime)"
# --deep does NOT reach binaries under Contents/Resources (the bundled Python
# runtime + Go bifrostd live there) — Apple rejects the submission unless every
# Mach-O carries its own Developer ID signature + secure timestamp + hardened
# runtime. Sign them individually, innermost first, then the bundle itself.
find "$APP/Contents/Resources" -type f \
  \( -perm -u+x -o -name '*.dylib' -o -name '*.so' \) -print0 |
  while IFS= read -r -d '' f; do
    if file -b "$f" | grep -q 'Mach-O'; then
      codesign --force --options runtime --timestamp --sign "$APPLE_SIGN_ID" "$f"
    fi
  done
codesign --force --deep --options runtime --timestamp \
  --sign "$APPLE_SIGN_ID" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> 2/5 zip + submit .app to notarytool (waits for the verdict)"
ZIP="/tmp/SCPrism-notarize.zip"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" "${notary_args[@]}" --wait

echo "==> 3/5 staple the .app"
xcrun stapler staple "$APP"

echo "==> 4/5 package + sign the .dmg (NEVER rebuild here — see make-dmg.sh)"
SKIP_BUILD=1 npm run dmg
codesign --force --timestamp --sign "$APPLE_SIGN_ID" "$OUT_DMG"

echo "==> 5/5 notarize + staple the .dmg"
xcrun notarytool submit "$OUT_DMG" "${notary_args[@]}" --wait
xcrun stapler staple "$OUT_DMG"

echo ""
echo "✅ Notarized + stapled:"
echo "   $APP"
echo "   $OUT_DMG"
spctl -a -vv "$APP" || true   # should report: accepted, source=Notarized Developer ID
