#!/usr/bin/env bash
# Deterministic verify gate (Tier-1 discipline, ~0 tokens). Must PASS before any commit.
set -uo pipefail
cd "$(dirname "$0")"

fail=0

# Step logs go in a fresh private directory per run (mode 0700, random name),
# removed on exit. They used to be fixed names in the shared /tmp, where another
# account on the machine could pre-plant a symlink and have this script
# truncate a file of yours through it.
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/scprism-verify.XXXXXX")" || exit 1
trap 'rm -rf "$LOGS"' EXIT

echo "== typecheck =="
npm run -s typecheck || fail=1

echo "== build =="
if npm run -s build >"$LOGS/build.log" 2>&1; then
  tail -3 "$LOGS/build.log"
else
  echo "build FAILED:"; tail -25 "$LOGS/build.log"; fail=1
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
  if (cd src-tauri && cargo test --lib) >"$LOGS/cargo.log" 2>&1; then
    tail -3 "$LOGS/cargo.log"
  else
    echo "cargo test FAILED:"; tail -25 "$LOGS/cargo.log"; fail=1
  fi
else
  echo "== native (rust) == skipped (no cargo toolchain)"
fi

if [ -d engine/tests ]; then
  # Test on the interpreter the app SHIPS — the pinned .pytool runtime — not
  # whatever python3 happens to be on PATH. They were different (Xcode's 3.9
  # here, 3.12 in the bundle), and two SSRF tests passed on one and failed on the
  # other, so this gate was vouching for a Python the app never runs.
  PY=python3
  [ -x .pytool/python/bin/python3 ] && PY=.pytool/python/bin/python3
  echo "== engine (python $("$PY" -c 'import platform; print(platform.python_version())')) =="
  if "$PY" -m unittest discover -s engine/tests >"$LOGS/python.log" 2>&1; then
    tail -3 "$LOGS/python.log"
  else
    echo "python tests FAILED:"
    grep -E "^(FAIL|ERROR):" "$LOGS/python.log"
    tail -40 "$LOGS/python.log"
    fail=1
  fi
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
