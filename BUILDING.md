# Building SC Prism from source

SC Prism is a Tauri 2 desktop app: a React + TypeScript interface, a Rust bridge,
a Python engine, and a Go router. It builds on **Apple Silicon macOS** only.

## Prerequisites

| Tool | Version | Get it |
|---|---|---|
| Xcode Command Line Tools | current | `xcode-select --install` |
| Node.js | 20 or newer | [nodejs.org](https://nodejs.org) or `nvm install 20` |
| Rust | current stable | [rustup.rs](https://rustup.rs) |
| Python 3.12 + Go 1.26 | pinned | fetched by the bootstrap script below |

You do not install Python or Go yourself. The app ships its own Python runtime, and
the repo pins the exact one it ships, so the bootstrap script fetches both
toolchains into the repo and checks each against its publisher's SHA-256.

## From clone to running app

```bash
git clone https://github.com/sandhusukhdeep2/sc-prism.git
cd sc-prism
./scripts/bootstrap-toolchains.sh   # .pytool/python (3.12.13) + .gotool/go (1.26.4)
npm ci
./verify.sh                         # the gate — see below
npm run tauri:dev                   # the native app, running the engine from engine/
```

`npm run dev` starts the interface alone in a browser at `http://localhost:5173`.
It's quick for UI work, but there is no engine behind it.

## The gate: `./verify.sh`

Every change must leave `./verify.sh` ending in the literal line `VERIFY: PASS`.
It runs, in order:

1. TypeScript typecheck
2. production build of the interface
3. the JavaScript test suite (Vitest)
4. the Rust unit tests (`cargo test --lib`)
5. the Python engine tests (`unittest`)
6. the Go router build and tests — this is also what produces
   `engine/bifrost/bifrostd`, which the app bundle needs

The Rust and Go steps **skip, rather than fail, when their toolchain is missing**,
and say so in the output. Run the bootstrap script first, or a green gate on a
fresh clone means less than it looks.

## Building the app

```bash
./verify.sh            # builds bifrostd, among everything else
npm run tauri:build    # → src-tauri/target/release/bundle/macos/SC Prism.app
npm run dmg            # → dist-dmg/SC Prism.dmg
```

`tauri:build` first runs `scripts/prep-bundle.sh`, which stages the pinned Python
runtime, the engine, and `bifrostd` inside the app. Then it strips every `.pyc`,
and fails the build if any survive, because bytecode records the absolute path it
was compiled from. Rust paths are remapped for the same reason. A release must not
carry the build machine's filesystem layout.

A local build is **ad-hoc signed**: it runs on the Mac that built it. To produce a
Gatekeeper-accepted, notarized build you need an Apple Developer ID — see
[SIGNING.md](SIGNING.md).

## Where things live

| Path | What |
|---|---|
| `src/` | the interface — pages, components, the app store, and `src/lib/` logic |
| `src-tauri/` | the Rust bridge between the interface and the engine |
| `engine/scprism_engine/` | the Python engine: orchestrator, gates, verifier, memory, tools |
| `engine/bifrost/` | the Go router and prompt cache |
| `engine/tests/` | engine tests |
| `specs/` | the design blueprint and the decision log (ADRs) — start at `specs/00` |
| `docs/superpowers/specs/` | feature-level design notes |
| `docs/index.html` | the project website (GitHub Pages) |

`CLAUDE.md` lists the project's invariants. It's written for AI coding agents, but
it's the shortest accurate summary of what must never change.
