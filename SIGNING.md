# SC Prism — code signing & notarization

A local build is **ad-hoc signed** by default (`npm run tauri:build` + `npm run dmg`).
It runs on the machine that built it; on any other Mac, Gatekeeper requires a
right-click → Open the first time, or:
`xattr -dr com.apple.quarantine "/Applications/SC Prism.app"`.

No signing identity is committed to the repository. If you want `tauri build` itself
to sign with your certificate, set `APPLE_SIGNING_IDENTITY` in the environment — Tauri
reads it in place of a value in `tauri.conf.json`.

To ship a **Gatekeeper-accepted, notarized** app you need a paid **Apple Developer**
account and a **"Developer ID Application"** certificate in your login keychain
(Xcode → Settings → Accounts → Manage Certificates → +). Then:

```bash
APPLE_SIGN_ID="Developer ID Application: Your Name (TEAMID)" \
APPLE_ID="you@example.com" APPLE_TEAM_ID="TEAMID" \
APPLE_APP_PASSWORD="app-specific-password" \
./scripts/sign-and-notarize.sh
```

Or store a notarytool profile once and pass `NOTARY_PROFILE=<name>` instead of the
three `APPLE_*` credentials:

```bash
xcrun notarytool store-credentials <name> --apple-id you@example.com --team-id TEAMID
```

The script first runs `scripts/check-bundle-privacy.sh` and refuses to sign a bundle
that still carries the build machine's filesystem paths. It then codesigns every
nested Mach-O and the app with the hardened runtime, submits to Apple's `notarytool`,
waits for the verdict, and staples both the `.app` and the `.dmg`.
