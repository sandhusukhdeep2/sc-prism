#!/usr/bin/env bash
# Deterministic verify gate (Tier-1 discipline, ~0 tokens). Must PASS before any commit.
set -uo pipefail
cd "$(dirname "$0")"

fail=0

echo "== typecheck =="
npm run -s typecheck || fail=1

echo "== build =="
if npm run -s build >/tmp/scprism-build.log 2>&1; then
  tail -3 /tmp/scprism-build.log
else
  echo "build FAILED:"; tail -25 /tmp/scprism-build.log; fail=1
fi

if grep -q '"test"' package.json; then
  echo "== test =="
  npm test --silent || fail=1
fi

# Native (Rust) unit tests — the bridge's own guards: approval-id safety, the
# exact decision bytes the engine reads, and (2026-08-11) the Telegram inbound
# parser, its chat-id gate and its token custody. `--lib` only: this runs the
# unit tests, it never builds an app bundle. Skipped cleanly without cargo.
if command -v cargo >/dev/null 2>&1 && [ -d src-tauri ]; then
  echo "== native (rust) =="
  bash scripts/ensure-resources.sh   # the resources glob must match on a fresh clone
  if (cd src-tauri && cargo test --lib) >/tmp/scprism-cargo.log 2>&1; then
    tail -3 /tmp/scprism-cargo.log
  else
    echo "cargo test FAILED:"; tail -25 /tmp/scprism-cargo.log; fail=1
  fi
else
  echo "== native (rust) == skipped (no cargo toolchain)"
fi

if [ -d engine/tests ]; then
  echo "== engine (python) =="
  python3 -m unittest discover -s engine/tests 2>&1 | tail -3 || fail=1
fi

# Go Bifrost gateway (tranche E-Bifrost). Only when the repo-local Go toolchain
# is present; skip cleanly otherwise so the gate stays green on Go-less machines.
if [ -x .gotool/go/bin/go ] && [ -f goenv.sh ] && [ -d engine/bifrost ]; then
  echo "== engine (go bifrost) =="
  # shellcheck disable=SC1091
  . ./goenv.sh
  # -trimpath: without it the binary embeds absolute build paths (the developer's
  # home directory and the private source layout) and ships them to every user.
  if (cd engine/bifrost && go build -trimpath -o bifrostd . && go test ./...) 2>&1 | tail -3; then
    :
  else
    fail=1
  fi
else
  echo "== engine (go bifrost) == skipped (no repo-local Go toolchain)"
fi

echo "---"
if [ "$fail" -eq 0 ]; then echo "VERIFY: PASS"; else echo "VERIFY: FAIL"; fi
exit "$fail"
