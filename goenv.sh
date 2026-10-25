# Source to put the repo-local Go toolchain on PATH (bootstrapped from go.dev; not committed).
_root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export GOROOT="$_root/.gotool/go"
export GOPATH="$_root/.gopath"
export GOCACHE="$_root/.gocache"
export PATH="$GOROOT/bin:$PATH"
export GOFLAGS="-mod=mod"
