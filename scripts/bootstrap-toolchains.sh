#!/usr/bin/env bash
# bootstrap-toolchains.sh — fetch the two repo-local toolchains a fresh clone
# needs and nothing in git provides:
#
#   .pytool/python  — the portable Python 3.12 the app bundles and the engine
#                     runs on (python-build-standalone, relocatable)
#   .gotool/go      — the Go toolchain that builds the Bifrost router
#
# Both are pinned to exact builds and checked against their publishers' SHA-256
# before anything is unpacked: the Python runtime ends up inside every shipped
# .app, so "whatever the latest download is" is not good enough. The Python
# build is the same one the released app ships, so a source build matches it.
#
# Idempotent: a toolchain that is already present at the pinned version is left
# alone. Apple Silicon only, because that is the only target SC Prism ships.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PY_VERSION="3.12.13"
PY_BUILD="20260623"
PY_ASSET="cpython-${PY_VERSION}+${PY_BUILD}-aarch64-apple-darwin-install_only.tar.gz"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_BUILD}/${PY_ASSET}"
PY_SHA256="3724aa4dafb5f7b6c2cf98e89914e4248dc6bd2fe40407df4a2d73de99615f16"

GO_VERSION="1.26.4"
GO_ASSET="go${GO_VERSION}.darwin-arm64.tar.gz"
GO_URL="https://go.dev/dl/${GO_ASSET}"
GO_SHA256="b62ad2b6d7d2464f12a5bcad7ff47f19d08325773b5efd21610e445a05a9bf53"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "ERROR: SC Prism builds on Apple Silicon macOS only (got $(uname -s) $(uname -m))." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() {  # fetch <url> <file> <sha256>
  local url="$1" out="$2" want="$3" got
  echo "    downloading $(basename "$out") ..."
  curl --fail --location --silent --show-error --output "$out" "$url"
  got="$(shasum -a 256 "$out" | awk '{print $1}')"
  if [ "$got" != "$want" ]; then
    echo "ERROR: checksum mismatch for $(basename "$out")" >&2
    echo "  expected $want" >&2
    echo "  got      $got" >&2
    exit 1
  fi
  echo "    sha256 verified"
}

# --- Python ---------------------------------------------------------------
if [ -x .pytool/python/bin/python3 ] &&
   [ "$(.pytool/python/bin/python3 -c 'import platform; print(platform.python_version())')" = "$PY_VERSION" ]; then
  echo "==> Python $PY_VERSION already at .pytool/python — leaving it"
else
  echo "==> Python $PY_VERSION (python-build-standalone $PY_BUILD)"
  fetch "$PY_URL" "$TMP/$PY_ASSET" "$PY_SHA256"
  rm -rf .pytool/python
  mkdir -p .pytool
  tar -xzf "$TMP/$PY_ASSET" -C .pytool   # unpacks to .pytool/python
  .pytool/python/bin/python3 -c 'import sys; print("    ready:", sys.version.split()[0])'
fi

# --- Go -------------------------------------------------------------------
if [ -x .gotool/go/bin/go ] && .gotool/go/bin/go version | grep -q "go${GO_VERSION} "; then
  echo "==> Go $GO_VERSION already at .gotool/go — leaving it"
else
  echo "==> Go $GO_VERSION"
  fetch "$GO_URL" "$TMP/$GO_ASSET" "$GO_SHA256"
  rm -rf .gotool/go
  mkdir -p .gotool
  tar -xzf "$TMP/$GO_ASSET" -C .gotool   # unpacks to .gotool/go
  echo "    ready: $(.gotool/go/bin/go version)"
fi

echo ""
echo "Toolchains ready. Next: npm install && ./verify.sh"
