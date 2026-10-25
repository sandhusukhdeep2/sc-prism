use std::collections::HashMap;
use tauri::Emitter;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Inbound Telegram decisions (approve/deny a PARKED request from the phone).
/// Lives in its own module because it owns the bot token native-side and must
/// keep it out of every error string — see the custody note there.
mod telegram;

/// Handles to in-flight engine subprocesses, keyed by the client's `run_id`.
/// Retaining the `Child` is what makes a run cancellable: `cancel_engine_run`
/// looks the child up and kills it, so a client that times out and gives up can
/// actually stop the subprocess instead of leaving a zombie running. The map is
/// an `Arc<Mutex<..>>` so a command can clone the handle out of Tauri-managed
/// state and move it into its `spawn_blocking` worker.
#[derive(Clone, Default)]
struct EngineRuns(Arc<Mutex<HashMap<String, Child>>>);

impl EngineRuns {
    /// Kill and reap every retained child — the same kill-then-wait path
    /// `cancel_engine_run` takes for one run, applied to the whole map. Called
    /// from the `tauri::RunEvent::Exit` handler in `run()` so that quitting
    /// the app is an honest cancel of every in-flight run: without it the
    /// engine children outlive the app, finish solo (spending real provider
    /// tokens), and land Verdicts + spans no client ever records (observed
    /// live 2026-08-28). Returns how many children were terminated.
    fn terminate_all(&self) -> usize {
        // Drain under the lock, kill + wait outside it — never hold the lock
        // across a blocking wait (same discipline as cancel_engine_run).
        let drained: Vec<(String, Child)> = self.0.lock().unwrap().drain().collect();
        let n = drained.len();
        for (_, mut child) in drained {
            let _ = child.kill(); // best-effort: harmless if it already exited
            let _ = child.wait(); // reap the killed child
        }
        n
    }
}

/// Marker returned by `run_capturing` when the run was cancelled mid-flight
/// (its child was removed + killed by `cancel_engine_run`). The client has
/// already timed out and dropped this run, so the exact text is never shown.
const ENGINE_CANCELLED: &str = "engine run cancelled";

/// Spawn `cmd` with its `Child` RETAINED in `runs` under `run_id`, capture
/// stdout + stderr to completion, then reap — the captured-output contract is
/// byte-identical to the old blocking `cmd.output()` (stdout regardless of exit
/// code), so a normal run is unchanged. The difference is only that while the
/// child runs it is reachable by `cancel_engine_run(run_id)`, which kills it.
///
/// Deadlock-free by construction: the shared lock is NEVER held across a
/// blocking read or wait. The pipes are drained concurrently (stderr on a side
/// thread, stdout on this one) exactly like `Command::output` does internally,
/// so a full pipe can't wedge the other. A blank `run_id` runs uncancellable
/// (never registered), matching pre-cancel behavior for any id-less caller.
fn run_capturing(mut cmd: Command, run_id: &str, runs: &EngineRuns) -> Result<Output, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch python: {e}"))?;
    // Move the pipes out BEFORE the child is handed to the shared map, so the
    // retained handle has no borrowed readers and stays purely a kill target.
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let registered = !run_id.is_empty();
    // Either retain the child in the shared map (cancellable) or keep it local.
    let mut local: Option<Child> = if registered {
        runs.0.lock().unwrap().insert(run_id.to_string(), child);
        None
    } else {
        Some(child)
    };

    // Drain stderr on a side thread; stdout on this thread — concurrently, so
    // neither pipe filling up can deadlock the other (Command::output parity).
    let stderr_thread = std::thread::spawn(move || -> Vec<u8> {
        let mut buf = Vec::new();
        if let Some(mut p) = stderr_pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let mut stdout_buf = Vec::new();
    if let Some(mut p) = stdout_pipe {
        let _ = p.read_to_end(&mut stdout_buf);
    }
    let stderr_buf = stderr_thread.join().unwrap_or_default();

    // Reap. Reclaim the child (from the map if registered — binding it to a
    // local first so the lock is released BEFORE the blocking wait) and wait for
    // the exit status. If it's already gone from the map, cancel_engine_run took
    // + killed + reaped it, so report the cancellation honestly to the (already
    // departed) caller.
    let status = if registered {
        let taken = runs.0.lock().unwrap().remove(run_id);
        match taken {
            Some(mut c) => c.wait().map_err(|e| format!("engine wait failed: {e}"))?,
            None => return Err(ENGINE_CANCELLED.to_string()),
        }
    } else {
        local
            .as_mut()
            .expect("unregistered run keeps its child local")
            .wait()
            .map_err(|e| format!("engine wait failed: {e}"))?
    };

    Ok(Output { status, stdout: stdout_buf, stderr: stderr_buf })
}

/// Cancel an in-flight engine run: look the retained child up by `run_id` and
/// kill it. A no-op when the run already finished (removed by `run_capturing`)
/// or was never registered, so it is always safe to call. Kill THEN wait so the
/// killed process is reaped rather than left as an OS zombie.
#[tauri::command]
fn cancel_engine_run(run_id: String, runs: tauri::State<'_, EngineRuns>) -> Result<(), String> {
    // Bind the taken child outside the lock so kill/wait never hold it.
    let taken = runs.0.lock().unwrap().remove(&run_id);
    if let Some(mut c) = taken {
        let _ = c.kill(); // best-effort: harmless if it already exited
        let _ = c.wait(); // reap the killed child
    }
    Ok(())
}

/// The resolved engine runtime: which Python interpreter to launch and which
/// directory to put on `PYTHONPATH` (the one holding the `scprism_engine`
/// package).
struct EngineRuntime {
    /// Interpreter to run. `None` means fall back to the ambient `python3` on
    /// PATH (dev machines with a system/venv Python).
    python: Option<PathBuf>,
    /// Directory containing the `scprism_engine` package.
    engine_dir: PathBuf,
}

fn has_pkg(p: &PathBuf) -> bool {
    p.join("scprism_engine").is_dir()
}

/// Pick the bundled Python interpreter inside a staged `resources/python`.
/// The portable build ships `bin/python3` (a symlink to `python3.12`), but
/// resource copying can materialise it as a plain file — so accept either.
fn bundled_python(python_root: &PathBuf) -> Option<PathBuf> {
    for name in ["bin/python3", "bin/python3.12"] {
        let cand = python_root.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Resolve the Python interpreter + engine directory. Priority order:
///   1. **Bundled app**: `<resource_dir>/resources/engine` (holds the package)
///      run with `<resource_dir>/resources/python/bin/python3`. This is the
///      self-contained path — no dependency on the repo at runtime.
///   2. `SCPRISM_ENGINE_DIR` env override (dev), ambient `python3`.
///   3. Compile-time `<manifest>/../engine` (repo layout: src-tauri/../engine).
///   4. `<cwd>/engine`.
/// The dev fallbacks (2–4) run the ambient `python3` on PATH.
fn resolve_engine_runtime(app: &tauri::AppHandle) -> Option<EngineRuntime> {
    // Dev builds: ALWAYS prefer the live repo engine over the staged bundle —
    // otherwise `tauri dev` silently runs a stale copy of the Python engine.
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(parent) = manifest.parent() {
            let p = parent.join("engine");
            if has_pkg(&p) {
                return Some(EngineRuntime { python: None, engine_dir: p });
            }
        }
    }

    // 1. Self-contained bundle: python + engine staged under resource_dir.
    if let Ok(res_dir) = app.path().resource_dir() {
        let engine_dir = res_dir.join("resources").join("engine");
        if has_pkg(&engine_dir) {
            let python = bundled_python(&res_dir.join("resources").join("python"));
            // Bundled engine present: use it, with the bundled python when it is
            // also present (falls back to ambient python3 only if missing).
            return Some(EngineRuntime { python, engine_dir });
        }
    }

    // 2. Dev override.
    if let Ok(dir) = std::env::var("SCPRISM_ENGINE_DIR") {
        let p = PathBuf::from(dir);
        if has_pkg(&p) {
            return Some(EngineRuntime { python: None, engine_dir: p });
        }
    }

    // 3. Repo layout at compile time — DEV ONLY. `env!("CARGO_MANIFEST_DIR")`
    // is the builder's absolute path, and `--remap-path-prefix` does not touch
    // it because it is a string literal, not debug info. In a release build the
    // directory cannot exist on the user's machine, so this branch could only
    // ever fail — while publishing the build machine's layout to everyone who
    // downloads the app. Compiled out of release entirely.
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(parent) = manifest.parent() {
            let p = parent.join("engine");
            if has_pkg(&p) {
                return Some(EngineRuntime { python: None, engine_dir: p });
            }
        }
    }

    // 4. Current working directory.
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("engine");
        if has_pkg(&p) {
            return Some(EngineRuntime { python: None, engine_dir: p });
        }
    }

    None
}

/// Extra directories where developer tools actually live. A GUI-launched app
/// inherits a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew, npm,
/// bun, volta and nvm installs are invisible to us AND to every process we
/// spawn. Mirrors `STATIC_DIRS` in engine/scprism_engine/toolpath.py.
const TOOL_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];
const HOME_TOOL_DIRS: [&str; 5] = [".local/bin", ".npm-global/bin", ".bun/bin", ".volta/bin", "bin"];

/// nvm installs node per-version under `~/.nvm/versions/node/<v>/bin` with no
/// stable symlink, so we glob and sort NEWEST VERSION FIRST. Missing/unreadable
/// root -> empty (never an error).
fn nvm_bin_dirs(nvm_root: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(Vec<u64>, PathBuf)> = Vec::new();
    let entries = match std::fs::read_dir(nvm_root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        let bin = entry.path().join("bin");
        if !bin.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let stripped = name.strip_prefix('v').unwrap_or(&name);
        let mut key: Vec<u64> = stripped
            .split('.')
            .take(3)
            .map(|frag| {
                frag.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect();
        while key.len() < 3 {
            key.push(0);
        }
        found.push((key, bin));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    found.into_iter().map(|(_, p)| p).collect()
}

/// Every extra dir to search, in priority order: the static install dirs, then
/// nvm's per-version bins (newest first).
fn tool_search_dirs(home: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = TOOL_DIRS.iter().map(PathBuf::from).collect();
    if !home.is_empty() {
        for d in HOME_TOOL_DIRS {
            dirs.push(PathBuf::from(home).join(d));
        }
        dirs.extend(nvm_bin_dirs(&PathBuf::from(home).join(".nvm/versions/node")));
    }
    dirs
}

/// `base` PATH with the tool dirs APPENDED (inherited entries keep priority, no
/// duplicates). This is the value handed to the engine subprocess.
fn enriched_path(base: &str, home: &str) -> String {
    let mut parts: Vec<PathBuf> = std::env::split_paths(base).filter(|p| !p.as_os_str().is_empty()).collect();
    for d in tool_search_dirs(home) {
        if !parts.contains(&d) {
            parts.push(d);
        }
    }
    std::env::join_paths(parts)
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|_| base.to_string())
}

/// The PATH to give child processes on this machine.
fn engine_path_env() -> String {
    enriched_path(
        &std::env::var("PATH").unwrap_or_default(),
        &std::env::var("HOME").unwrap_or_default(),
    )
}

/// Build the `Command` that runs `scprism_engine` for the given subcommand args,
/// using the resolved interpreter + engine dir. `PYTHONPATH` is set to the engine
/// dir so `-m scprism_engine` resolves regardless of the working directory.
///
/// PATH is enriched HERE — the single place the app spawns the engine — because
/// a child inherits it: the fix reaches the engine itself (CLI provider
/// discovery) AND everything the engine forks, including Tier-1's `/bin/sh`
/// running the user's `npm test`. Without it the GUI's minimal PATH made every
/// Tier-1 run fail with "npm: command not found".
fn engine_command(rt: &EngineRuntime, args: &[&str]) -> Command {
    let mut cmd = match &rt.python {
        Some(py) => Command::new(py),
        None => Command::new("python3"),
    };
    cmd.arg("-m").arg("scprism_engine");
    for a in args {
        cmd.arg(a);
    }
    cmd.env("PYTHONPATH", &rt.engine_dir)
        .env("PATH", engine_path_env())
        .current_dir(&rt.engine_dir);
    cmd
}

/// Forward the optional web_search config (web design, 2026-07-23) to the engine
/// as environment ONLY — the API key never travels as argv and is never logged,
/// same discipline as the provider keys. Empty/None values are omitted, so the
/// engine falls back to its keyless default backend. The `--web` flag (argv)
/// gates whether web tools are built at all; this only supplies their config.
fn set_search_env(cmd: &mut Command, api_key: &Option<String>, endpoint: &Option<String>) {
    if let Some(k) = api_key {
        if !k.is_empty() {
            cmd.env("SCPRISM_SEARCH_API_KEY", k);
        }
    }
    if let Some(e) = endpoint {
        if !e.is_empty() {
            cmd.env("SCPRISM_SEARCH_ENDPOINT", e);
        }
    }
}

/// Run the real Python engine for one task and return the Verdict JSON (stdout).
///
/// Executes `python3 -m scprism_engine run <intent> --vault <vault>` with the
/// working directory set to the repo's `engine/` folder. The engine exits 1 when
/// a verdict FAILS but still prints valid JSON to stdout, so a non-zero exit is
/// NOT treated as an error as long as stdout carries the verdict.
/// `token_budget` (> 0) becomes `--token-budget <v>` — the heartbeat wake's
/// real work bound; 0 omits the flag (the engine's contract default applies),
/// mirroring `run_engine_team`'s discipline. `tool_turns` (> 0) becomes
/// `--tool-turns <v>` on the same omit-means-default contract: it caps TOOL
/// EXECUTIONS per model turn, and None/0 lets the engine resolve its own
/// (already bounded) default.
///
/// `tier1_cwd` is the directory the user's verify command runs in, and it is
/// NOT optional in spirit: `engine_command` pins the engine's own working
/// directory to `rt.engine_dir`, which inside the packaged app is
/// `SC Prism.app/Contents/Resources/resources/engine` — a directory with no
/// `package.json` in it or in any ancestor. Tier-1 inheriting that made every
/// `npm test` die with `npm error ENOENT`, and the dev repo hid it (npm walks
/// up and finds the repo's OWN package.json, so verify.sh went green over a
/// gate that could not work once installed). An empty value is therefore
/// forwarded as an EMPTY `--tier1-cwd`, which the engine treats as "a verify
/// command is configured, but this run has no project directory" — never a
/// silent run in the app's own folder. Tier-1 is a PROJECT gate, so the engine
/// SKIPS it there (chat, manager reports, heartbeat wakes have no codebase to
/// check) and records why; it does not fail the run for having nothing to
/// verify. The command is still forwarded on purpose: `--tier1` WITH an empty
/// `--tier1-cwd` is exactly how the app distinguishes "no codebase this run"
/// from "the user configured no verify command at all".
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_engine_task(
    app: tauri::AppHandle,
    runs: tauri::State<'_, EngineRuns>,
    run_id: String,
    intent: String,
    vault: String,
    base_url: String,
    api_key: String,
    claude_api_key: Option<String>,
    gemini_api_key: Option<String>,
    primary: Option<String>,
    local_model: Option<String>,
    openai_model: Option<String>,
    claude_model: Option<String>,
    gemini_model: Option<String>,
    context: Option<String>,
    sensitive: Option<String>,
    tier1: Option<String>,
    tier1_cwd: Option<String>,
    cli_model: Option<String>,
    effort: Option<String>,
    // Per-run cap on model OUTPUT tokens (SCPRISM_MAX_TOKENS). A heartbeat
    // wake passes a small one: it asks for a first-line summary, and on a slow
    // local model an uncapped 4096-token generation is minutes of inference
    // for an answer nobody wanted that long. None/0 omits the env entirely, so
    // the engine keeps its own default and the run is byte-identical.
    max_tokens: Option<u32>,
    // Plan N steps instead of the engine's default shape. Only 1 is special: a
    // SINGLE findings step, for work that is one small piece rather than a
    // change to a codebase. The default plan runs understand -> locate ->
    // produce, and each step has its OWN tool loop and turn budget, so a
    // heartbeat wake did the same research three times over. None/0 omits the
    // flag entirely and the run is byte-identical.
    steps: Option<u32>,
    // WHO the user sees as doing this run, and WHICH phase of a larger job it
    // is. A team run has always named its agents; a solo run named nobody, so
    // a chat, a wake or a project step was unattributable on the board. Empty
    // omits the flags entirely and the run is byte-identical.
    agent_name: Option<String>,
    stage: Option<String>,
    // Withhold the vault TOOLS from this run (`--no-vault-tools`). Not a
    // privacy switch — it is a SPEED one, and the two are entangled: reading a
    // note through a tool trips the egress floor, which pins every later turn
    // of the run to the on-device model. A run that never reads one stays on
    // whatever fast provider it started on. None/false omits the flag.
    no_vault_tools: Option<bool>,
    flag_deepeval: Option<bool>,
    flag_lightrag: Option<bool>,
    flag_bifrost: Option<bool>,
    token_budget: u32,
    web: Option<bool>,
    approval: Option<String>,
    approval_blocking: Option<bool>,
    search_api_key: Option<String>,
    search_endpoint: Option<String>,
    route: Option<String>,
    image: Option<String>,
    user_capabilities: Option<String>,
    agent_capabilities: Option<String>,
    tool_turns: Option<u32>,
    // Contract mode (`--mode`). The chat path passes "converse" so the engine
    // plans the turn as one reply and judges it as one — before this, a chat
    // message arrived with no kind at all, the contract inferred "write", and
    // a good reply was graded as a build that produced no files. None/empty
    // omits the flag entirely (same discipline as `--route`), so every
    // existing caller is byte-identical.
    mode: Option<String>,
) -> Result<String, String> {
    // Clone the shared run map out of Tauri state so the retained-child handle
    // can move into the blocking worker (State is not 'static / Send-into-move).
    let runs = runs.inner().clone();
    // Engine runs take seconds-to-minutes (subscription CLIs especially) —
    // NEVER on the main thread, or the whole window beachballs.
    tauri::async_runtime::spawn_blocking(move || {
    let mut rt = resolve_engine_runtime(&app)
        .ok_or_else(|| "could not locate the engine (scprism_engine)".to_string())?;

    // Optional extension runtimes live in per-extension virtualenvs (dev only):
    // LightRAG needs the py3.12 .venv-rag, DeepEval the .venv. When a flag is
    // on AND the venv exists, run the engine under that interpreter (LightRAG
    // wins if both — DeepEval then falls back to the built-in judge).
    if let Some(dev) = dev_engine_dir() {
        let want_rag = flag_lightrag.unwrap_or(false);
        let want_eval = flag_deepeval.unwrap_or(false);
        let rag_py = dev.join(".venv-rag/bin/python3");
        let eval_py = dev.join(".venv/bin/python3");
        if want_rag && rag_py.is_file() {
            rt.python = Some(rag_py);
        } else if want_eval && eval_py.is_file() {
            rt.python = Some(eval_py);
        }
    }

    // The user's OWN verify command becomes the deterministic Tier-1 gate —
    // run in the PROJECT's directory, never the engine's own. See the doc
    // comment: an empty cwd is forwarded deliberately so the engine refuses to
    // guess a folder instead of "failing tests" inside the app bundle.
    // Per-agent CAPABILITIES (Sukh-orchestrates design, 2026-08-15). These
    // carry the grant the ENGINE enforces: `--user-capabilities` is the
    // ceiling (a manager can never grant beyond it) and `--agent-capabilities`
    // is the per-agent request, which the engine intersects with the ceiling in
    // capabilities.AgentGrants. Declared BEFORE `args` so the borrows outlive
    // it. Both empty -> no flags -> no gate at all, byte-identical.
    let user_caps = user_capabilities.unwrap_or_default();
    let agent_caps = agent_capabilities.unwrap_or_default();
    let mut args: Vec<&str> = vec!["run", &intent, "--vault", &vault];
    if !user_caps.is_empty() || !agent_caps.is_empty() {
        args.push("--user-capabilities");
        args.push(&user_caps);
        args.push("--agent-capabilities");
        args.push(&agent_caps);
    }
    let tier1_cmd = tier1.unwrap_or_default();
    let tier1_dir = tier1_cwd.unwrap_or_default().trim().to_string();
    if !tier1_cmd.trim().is_empty() {
        args.push("--tier1");
        args.push(tier1_cmd.trim());
        args.push("--tier1-cwd");
        args.push(&tier1_dir);
    }
    // Hard token cap (heartbeat wakes): `token_budget` (> 0) becomes
    // `--token-budget <v>`, same empty-omission discipline as
    // `run_engine_team`'s budget — 0 means "omit, let the engine's contract
    // default (100_000) apply", so every non-heartbeat run stays
    // byte-identical.
    let token_budget_s = token_budget.to_string();
    if token_budget > 0 {
        args.push("--token-budget");
        args.push(&token_budget_s);
    }
    // Per-run TOOL-TURN cap (2026-08-18). Same omit-means-default discipline as
    // the token budget: None/0 pushes no flag, so the engine resolves
    // SCPRISM_TOOL_TURNS or its own default and the command line is
    // byte-identical to before this parameter existed. > 0 is a deliberate
    // per-run choice (the heartbeat wake asks for a smaller one), and the
    // engine still clamps it — no caller can unbound the loop from here.
    let tool_turns_v = tool_turns.unwrap_or(0);
    let tool_turns_s = tool_turns_v.to_string();
    if tool_turns_v > 0 {
        args.push("--tool-turns");
        args.push(&tool_turns_s);
    }
    let steps_v = steps.unwrap_or(0);
    let steps_s = steps_v.to_string();
    if steps_v > 0 {
        args.push("--steps");
        args.push(&steps_s);
    }
    let agent_name_s = agent_name.unwrap_or_default();
    if !agent_name_s.trim().is_empty() {
        args.push("--agent");
        args.push(agent_name_s.trim());
    }
    let stage_s = stage.unwrap_or_default();
    if !stage_s.trim().is_empty() {
        args.push("--stage");
        args.push(stage_s.trim());
    }
    if no_vault_tools.unwrap_or(false) {
        args.push("--no-vault-tools");
    }
    // Web research (web design, 2026-07-23): opt-in `--web` enables the governed
    // web_fetch/web_search tool source on the run's v2b loop. Off by default —
    // byte-identical to a non-web run when the flag is absent.
    if web.unwrap_or(false) {
        args.push("--web");
    }
    // Tool posture (companion grant): 'ask' threads `--require-approval all`
    // so held calls park on the desk — belt-and-braces with the vault's
    // mcp-approvals.json policy (either alone gates; audit: blocking is a
    // documented no-op without an ACTIVE require policy, so ask must ride
    // the argv too, not only a file that can fail to write).
    let approval_arg = approval.unwrap_or_default();
    if approval_arg == "all" {
        args.push("--require-approval");
        args.push("all");
    }
    // Mid-run blocking approval (companion grant): pause the run at a held tool
    // call until the user decides on the Work desk, bounded at 300s — silence
    // means the tool honestly does not run. Absent → byte-identical run.
    if approval_blocking.unwrap_or(false) {
        args.push("--approval-blocking");
        args.push("--approval-timeout");
        args.push("300");
    }
    // Per-message route hint (composer local/cloud/auto). Only local/cloud are
    // forwarded as `--route`; auto/None omit the flag entirely, byte-identical
    // to a run without it. The engine's gateway stays authoritative and keeps
    // sensitive content local even under `--route cloud`.
    let route_arg = route.unwrap_or_default();
    if route_arg == "local" || route_arg == "cloud" {
        args.push("--route");
        args.push(&route_arg);
    }
    // Contract mode: only the engine's own choices are forwarded as `--mode`;
    // anything else (None, "", a typo) omits the flag and the engine infers
    // read/write from the intent exactly as before. "converse" is the one the
    // chat path sends — the flag exists so a chat turn stops reaching the
    // judge dressed as a write task.
    let mode_arg = mode.unwrap_or_default();
    if mode_arg == "read" || mode_arg == "write" || mode_arg == "converse" {
        args.push("--mode");
        args.push(&mode_arg);
    }
    // Image attach: forward the picked file PATH as `--image <path>`. The engine
    // reads + validates + base64s it (png/jpeg/gif/webp, <=5 MB) and builds the
    // provider-neutral image block — a vision route sends it, a non-vision route
    // is told honestly it wasn't sent. Absent (empty) → no flag, byte-identical
    // to a text-only run. An image on a LOCAL route stays local, as always.
    let image_path = image.unwrap_or_default();
    if !image_path.trim().is_empty() {
        args.push("--image");
        args.push(image_path.trim());
    }
    let mut cmd = engine_command(&rt, &args);
    set_search_env(&mut cmd, &search_api_key, &search_endpoint);
    if flag_deepeval.unwrap_or(false) {
        cmd.env("SCPRISM_DEEPEVAL", "1");
    }
    if flag_lightrag.unwrap_or(false) {
        cmd.env("SCPRISM_LIGHTRAG", "1");
    }
    if flag_bifrost.unwrap_or(false) {
        cmd.env("SCPRISM_BIFROST", "1");
    }
    // Forward ALL enabled-provider config so the engine's gateway can reach +
    // authenticate the configured primary (local OR a cloud provider). Keys are
    // passed via the environment only — never as argv, never logged.
    //
    //   OPENAI_BASE_URL / OPENAI_API_KEY — local server (and cloud OpenAI, which
    //     shares OPENAI_API_KEY; the base URL disambiguates which is called).
    //   CLAUDE_API_KEY / GEMINI_API_KEY  — the respective cloud providers.
    //   SCPRISM_PRIMARY                  — which provider the gateway routes to.
    //   SCPRISM_<P>_MODEL                — optional per-provider model override.
    if !base_url.is_empty() {
        cmd.env("OPENAI_BASE_URL", &base_url);
    }
    if !api_key.is_empty() {
        cmd.env("OPENAI_API_KEY", &api_key);
    }
    let set_env = |cmd: &mut Command, key: &str, val: &Option<String>| {
        if let Some(v) = val {
            if !v.is_empty() {
                cmd.env(key, v);
            }
        }
    };
    set_env(&mut cmd, "CLAUDE_API_KEY", &claude_api_key);
    set_env(&mut cmd, "GEMINI_API_KEY", &gemini_api_key);
    set_env(&mut cmd, "SCPRISM_PRIMARY", &primary);
    // Model id for the local/custom OpenAI-compatible endpoint.
    set_env(&mut cmd, "OPENAI_MODEL", &local_model);
    // Workspace context (interview summary) appended to the Companion charter.
    set_env(&mut cmd, "SCPRISM_CONTEXT", &context);
    // User-defined sensitive words — force-local routing (comma separated).
    set_env(&mut cmd, "SCPRISM_SENSITIVE", &sensitive);
    // User-chosen model for the CLI bridge + thinking/effort level.
    set_env(&mut cmd, "SCPRISM_CLI_MODEL", &cli_model);
    set_env(&mut cmd, "SCPRISM_EFFORT", &effort);
    if let Some(mt) = max_tokens {
        if mt > 0 {
            cmd.env("SCPRISM_MAX_TOKENS", mt.to_string());
        }
    }
    set_env(&mut cmd, "SCPRISM_OPENAI_MODEL", &openai_model);
    set_env(&mut cmd, "SCPRISM_CLAUDE_MODEL", &claude_model);
    set_env(&mut cmd, "SCPRISM_GEMINI_MODEL", &gemini_model);

    // Retained-child capture (cancellable), byte-identical stdout/verdict
    // contract to the old blocking cmd.output().
    let output = run_capturing(cmd, &run_id, &runs)?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        // stdout holds the Verdict JSON regardless of the exit code (a failing
        // verdict exits 1 but still prints valid JSON).
        return Ok(stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "engine produced no output (exit {:?}): {stderr}",
        output.status.code()
    ))
    })
    .await
    .map_err(|e| format!("engine task join failed: {e}"))?
}

/// Fixed intent for a verify-only run (`run_engine_verify`) — the project's
/// test loop never asks the model to change anything, so the intent text
/// itself commits to that: report pass/fail, make no changes.
const VERIFY_INTENT: &str =
    "Run the project's verification and report pass/fail — make no changes.";

/// Run a project's verify command as a governed, read-only check (the project
/// "test loop", P2-2) and return the Verdict JSON (stdout) — mirrors
/// `run_engine_task` exactly for runtime resolution, extension venvs, and
/// provider credentials (env-only, never argv). Executes `python3 -m
/// scprism_engine run "<fixed verify intent>" --vault <vault> --tier1
/// "<verify_command>" --tier1-cwd <project_dir>`. `run` mode has no
/// FILE-block writing and never branches, so this writes NO project files
/// and never touches git — the Tier-1 gate simply runs `verify_command`
/// inside `project_dir` and reports the verdict. Like `run_engine_task`, the
/// engine exits 1 when a verdict FAILS but still prints valid JSON to
/// stdout, so a non-zero exit is NOT treated as an error as long as stdout
/// carries the verdict.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_engine_verify(
    app: tauri::AppHandle,
    project_dir: String,
    verify_command: String,
    vault: String,
    base_url: String,
    api_key: String,
    claude_api_key: Option<String>,
    gemini_api_key: Option<String>,
    primary: Option<String>,
    local_model: Option<String>,
    openai_model: Option<String>,
    claude_model: Option<String>,
    gemini_model: Option<String>,
    context: Option<String>,
    sensitive: Option<String>,
    cli_model: Option<String>,
    effort: Option<String>,
    flag_deepeval: Option<bool>,
    flag_lightrag: Option<bool>,
    flag_bifrost: Option<bool>,
) -> Result<String, String> {
    // Engine runs take seconds-to-minutes (subscription CLIs especially) —
    // NEVER on the main thread, or the whole window beachballs.
    tauri::async_runtime::spawn_blocking(move || {
    let mut rt = resolve_engine_runtime(&app)
        .ok_or_else(|| "could not locate the engine (scprism_engine)".to_string())?;

    // Optional extension runtimes live in per-extension virtualenvs (dev only):
    // LightRAG needs the py3.12 .venv-rag, DeepEval the .venv. When a flag is
    // on AND the venv exists, run the engine under that interpreter (LightRAG
    // wins if both — DeepEval then falls back to the built-in judge).
    if let Some(dev) = dev_engine_dir() {
        let want_rag = flag_lightrag.unwrap_or(false);
        let want_eval = flag_deepeval.unwrap_or(false);
        let rag_py = dev.join(".venv-rag/bin/python3");
        let eval_py = dev.join(".venv/bin/python3");
        if want_rag && rag_py.is_file() {
            rt.python = Some(rag_py);
        } else if want_eval && eval_py.is_file() {
            rt.python = Some(eval_py);
        }
    }

    // The project's OWN verify command becomes the deterministic Tier-1
    // gate, run inside `project_dir` via `--tier1-cwd` — the test-loop seam
    // (P2-2): `run` mode writes no project files and never branches, so
    // this is inherently read-only/verify-only.
    let mut args: Vec<&str> = vec!["run", VERIFY_INTENT, "--vault", &vault];
    let verify_trim = verify_command.trim();
    if !verify_trim.is_empty() {
        args.push("--tier1");
        args.push(verify_trim);
    }
    args.push("--tier1-cwd");
    args.push(&project_dir);
    let mut cmd = engine_command(&rt, &args);
    if flag_deepeval.unwrap_or(false) {
        cmd.env("SCPRISM_DEEPEVAL", "1");
    }
    if flag_lightrag.unwrap_or(false) {
        cmd.env("SCPRISM_LIGHTRAG", "1");
    }
    if flag_bifrost.unwrap_or(false) {
        cmd.env("SCPRISM_BIFROST", "1");
    }
    // Forward ALL enabled-provider config so the engine's gateway can reach +
    // authenticate the configured primary (local OR a cloud provider). Keys are
    // passed via the environment only — never as argv, never logged.
    //
    //   OPENAI_BASE_URL / OPENAI_API_KEY — local server (and cloud OpenAI, which
    //     shares OPENAI_API_KEY; the base URL disambiguates which is called).
    //   CLAUDE_API_KEY / GEMINI_API_KEY  — the respective cloud providers.
    //   SCPRISM_PRIMARY                  — which provider the gateway routes to.
    //   SCPRISM_<P>_MODEL                — optional per-provider model override.
    if !base_url.is_empty() {
        cmd.env("OPENAI_BASE_URL", &base_url);
    }
    if !api_key.is_empty() {
        cmd.env("OPENAI_API_KEY", &api_key);
    }
    let set_env = |cmd: &mut Command, key: &str, val: &Option<String>| {
        if let Some(v) = val {
            if !v.is_empty() {
                cmd.env(key, v);
            }
        }
    };
    set_env(&mut cmd, "CLAUDE_API_KEY", &claude_api_key);
    set_env(&mut cmd, "GEMINI_API_KEY", &gemini_api_key);
    set_env(&mut cmd, "SCPRISM_PRIMARY", &primary);
    // Model id for the local/custom OpenAI-compatible endpoint.
    set_env(&mut cmd, "OPENAI_MODEL", &local_model);
    // Workspace context (interview summary) appended to the Companion charter.
    set_env(&mut cmd, "SCPRISM_CONTEXT", &context);
    // User-defined sensitive words — force-local routing (comma separated).
    set_env(&mut cmd, "SCPRISM_SENSITIVE", &sensitive);
    // User-chosen model for the CLI bridge + thinking/effort level.
    set_env(&mut cmd, "SCPRISM_CLI_MODEL", &cli_model);
    set_env(&mut cmd, "SCPRISM_EFFORT", &effort);
    set_env(&mut cmd, "SCPRISM_OPENAI_MODEL", &openai_model);
    set_env(&mut cmd, "SCPRISM_CLAUDE_MODEL", &claude_model);
    set_env(&mut cmd, "SCPRISM_GEMINI_MODEL", &gemini_model);

    let output = cmd
        .output()
        .map_err(|e| format!("failed to launch python: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        // stdout holds the Verdict JSON regardless of the exit code (a failing
        // verdict exits 1 but still prints valid JSON).
        return Ok(stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "engine produced no output (exit {:?}): {stderr}",
        output.status.code()
    ))
    })
    .await
    .map_err(|e| format!("engine verify join failed: {e}"))?
}

/// Run one project-mode step through the real Python engine and return the
/// Verdict JSON (stdout) — mirrors `run_engine_task` exactly for runtime
/// resolution, extension venvs, and provider credentials (env-only, never
/// argv). Executes `python3 -m scprism_engine project <intent> --project-dir
/// <dir> --vault <vault> [--tier1 <cmd>] [--context <ctx>]
/// [--refine-feedback <fb>] [--attempt <n> --attempt-group <id>]
/// [--previous-verdict <path>] [--existing] [--slug <s>] [--never-touch <g>]…
/// [--run-branch <b>] [--agents <roster>]`. `existing_mode`/`slug`/
/// `never_touch` drive the engine's existing-repo branch-per-run lifecycle;
/// `run_branch` (V2-5) is the caller's STORED run branch from a prior run
/// that already returned to base — when it still names a real local branch
/// the engine resumes it instead of creating a new numbered branch. `roster`
/// (P1-3) is an optional `name:provider,name:provider` spec (e.g.
/// `lead:claude,planner:gemini,developer:local`); when non-blank it becomes
/// `--agents <roster>`, which the engine parses into a per-role board that
/// runs this step instead of a single model (P1-2). All five are no-ops
/// (flag omitted) on the v1 new-project path, keeping that path
/// byte-identical. Like `run`, the engine exits 1 when a verdict FAILS but
/// still prints valid JSON to stdout, so a non-zero exit is NOT treated as an
/// error as long as stdout carries the verdict.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_engine_project(
    app: tauri::AppHandle,
    runs: tauri::State<'_, EngineRuns>,
    run_id: String,
    intent: String,
    project_dir: String,
    vault: String,
    // The PHASE this plan step is, in the user's own words — written onto the
    // step's spans so the crew board can draw one column per step instead of
    // one anonymous "Working". Empty omits the flag.
    stage: Option<String>,
    base_url: String,
    api_key: String,
    claude_api_key: Option<String>,
    gemini_api_key: Option<String>,
    primary: Option<String>,
    local_model: Option<String>,
    openai_model: Option<String>,
    claude_model: Option<String>,
    gemini_model: Option<String>,
    context: Option<String>,
    sensitive: Option<String>,
    tier1: Option<String>,
    cli_model: Option<String>,
    effort: Option<String>,
    flag_deepeval: Option<bool>,
    flag_lightrag: Option<bool>,
    flag_bifrost: Option<bool>,
    web: Option<bool>,
    search_api_key: Option<String>,
    search_endpoint: Option<String>,
    project_context: String,
    refine_feedback: String,
    attempt: Option<i64>,
    attempt_group: String,
    previous_verdict: String,
    existing_mode: bool,
    slug: String,
    never_touch: Vec<String>,
    run_branch: String,
    roster: String,
    user_capabilities: Option<String>,
    agent_capabilities: Option<String>,
    token_budget: Option<i64>,
) -> Result<String, String> {
    // Clone the shared run map out of state so it can move into the worker.
    let runs = runs.inner().clone();
    // Engine runs take seconds-to-minutes (subscription CLIs especially) —
    // NEVER on the main thread, or the whole window beachballs.
    tauri::async_runtime::spawn_blocking(move || {
    let mut rt = resolve_engine_runtime(&app)
        .ok_or_else(|| "could not locate the engine (scprism_engine)".to_string())?;

    // Optional extension runtimes live in per-extension virtualenvs (dev only):
    // LightRAG needs the py3.12 .venv-rag, DeepEval the .venv. When a flag is
    // on AND the venv exists, run the engine under that interpreter (LightRAG
    // wins if both — DeepEval then falls back to the built-in judge).
    if let Some(dev) = dev_engine_dir() {
        let want_rag = flag_lightrag.unwrap_or(false);
        let want_eval = flag_deepeval.unwrap_or(false);
        let rag_py = dev.join(".venv-rag/bin/python3");
        let eval_py = dev.join(".venv/bin/python3");
        if want_rag && rag_py.is_file() {
            rt.python = Some(rag_py);
        } else if want_eval && eval_py.is_file() {
            rt.python = Some(eval_py);
        }
    }

    // The user's OWN verify command becomes the deterministic Tier-1 gate.
    // Per-agent CAPABILITIES (Sukh-orchestrates design, 2026-08-15). These
    // carry the grant the ENGINE enforces: `--user-capabilities` is the
    // ceiling (a manager can never grant beyond it) and `--agent-capabilities`
    // is the per-agent request, which the engine intersects with the ceiling in
    // capabilities.AgentGrants. Declared BEFORE `args` so the borrows outlive
    // it. Both empty -> no flags -> no gate at all, byte-identical.
    let user_caps = user_capabilities.unwrap_or_default();
    let agent_caps = agent_capabilities.unwrap_or_default();
    let mut args: Vec<&str> = vec!["project", &intent, "--project-dir", &project_dir, "--vault", &vault];
    let proj_stage = stage.unwrap_or_default();
    if !proj_stage.trim().is_empty() {
        args.push("--stage");
        args.push(proj_stage.trim());
    }
    if !user_caps.is_empty() || !agent_caps.is_empty() {
        args.push("--user-capabilities");
        args.push(&user_caps);
        args.push("--agent-capabilities");
        args.push(&agent_caps);
    }
    let tier1_cmd = tier1.unwrap_or_default();
    if !tier1_cmd.trim().is_empty() {
        args.push("--tier1");
        args.push(tier1_cmd.trim());
    }
    let project_context_trim = project_context.trim();
    if !project_context_trim.is_empty() {
        args.push("--context");
        args.push(project_context_trim);
    }
    let refine_feedback_trim = refine_feedback.trim();
    if !refine_feedback_trim.is_empty() {
        args.push("--refine-feedback");
        args.push(refine_feedback_trim);
    }
    // Attempt lineage (F1): which attempt at ONE logical step this run is, and
    // the group id tying the attempts together. The engine never infers the
    // grouping — only this driver knows two runs are the same step. Both are
    // required before either is passed: an attempt number with no group has
    // nothing to belong to, and a group with no number has no order. Omitted ->
    // the engine records no attempt extras at all, byte-identical to before.
    let attempt_n = attempt.unwrap_or(0);
    let attempt_str = attempt_n.to_string();
    let attempt_group_trim = attempt_group.trim();
    if attempt_n > 0 && !attempt_group_trim.is_empty() {
        args.push("--attempt");
        args.push(&attempt_str);
        args.push("--attempt-group");
        args.push(attempt_group_trim);
    }
    // The previous attempt's verdict — what the refine turn is shown the CURRENT
    // contents of, and the link back to the attempt being fixed.
    let previous_verdict_trim = previous_verdict.trim();
    if !previous_verdict_trim.is_empty() {
        args.push("--previous-verdict");
        args.push(previous_verdict_trim);
    }
    if existing_mode {
        args.push("--existing");
    }
    let slug_trim = slug.trim();
    if !slug_trim.is_empty() {
        args.push("--slug");
        args.push(slug_trim);
    }
    // Repeatable flag, same empty-omission discipline as the scalar args
    // above: trim each entry and skip blanks rather than pass them through.
    let never_touch_trimmed: Vec<&str> = never_touch.iter().map(|g| g.trim()).collect();
    for g in &never_touch_trimmed {
        if !g.is_empty() {
            args.push("--never-touch");
            args.push(g);
        }
    }
    // V2-5: the caller's STORED run branch to resume, same empty-omission
    // discipline as `--slug` above.
    let run_branch_trim = run_branch.trim();
    if !run_branch_trim.is_empty() {
        args.push("--run-branch");
        args.push(run_branch_trim);
    }
    // P1-3: an optional roster string (`name:provider,name:provider`) becomes
    // `--agents <roster>`, the same empty-omission discipline as slug/
    // run_branch above — a blank/absent roster never reaches the engine, so
    // run_project's single-doer path stays byte-identical.
    let roster_trim = roster.trim();
    if !roster_trim.is_empty() {
        args.push("--agents");
        args.push(roster_trim);
    }
    // The step's contract envelope, when the caller set one — same
    // omit-means-default discipline as every flag above. 0/absent pushes
    // nothing and the engine keeps its 100k contract default.
    let budget_v = token_budget.unwrap_or(0);
    let budget_s = budget_v.to_string();
    if budget_v > 0 {
        args.push("--token-budget");
        args.push(&budget_s);
    }
    // `--web` restored (2026-08-28): the engine's `project` subcommand now
    // runs the same governed web loop as `run`/`team` (run_project threads the
    // tool source into loop.run), so the flag is safe to push again — the
    // argparse exit-2/no-verdict death that forced `let _ = web;` is covered
    // by engine tests (test_project_cli.TestProjectWebAndVaultTools). Search
    // config still rides the environment via set_search_env below. Off by
    // default — byte-identical to a non-web step when the flag is absent.
    if web.unwrap_or(false) {
        args.push("--web");
    }
    let mut cmd = engine_command(&rt, &args);
    set_search_env(&mut cmd, &search_api_key, &search_endpoint);
    if flag_deepeval.unwrap_or(false) {
        cmd.env("SCPRISM_DEEPEVAL", "1");
    }
    if flag_lightrag.unwrap_or(false) {
        cmd.env("SCPRISM_LIGHTRAG", "1");
    }
    if flag_bifrost.unwrap_or(false) {
        cmd.env("SCPRISM_BIFROST", "1");
    }
    // Forward ALL enabled-provider config so the engine's gateway can reach +
    // authenticate the configured primary (local OR a cloud provider). Keys are
    // passed via the environment only — never as argv, never logged.
    //
    //   OPENAI_BASE_URL / OPENAI_API_KEY — local server (and cloud OpenAI, which
    //     shares OPENAI_API_KEY; the base URL disambiguates which is called).
    //   CLAUDE_API_KEY / GEMINI_API_KEY  — the respective cloud providers.
    //   SCPRISM_PRIMARY                  — which provider the gateway routes to.
    //   SCPRISM_<P>_MODEL                — optional per-provider model override.
    if !base_url.is_empty() {
        cmd.env("OPENAI_BASE_URL", &base_url);
    }
    if !api_key.is_empty() {
        cmd.env("OPENAI_API_KEY", &api_key);
    }
    let set_env = |cmd: &mut Command, key: &str, val: &Option<String>| {
        if let Some(v) = val {
            if !v.is_empty() {
                cmd.env(key, v);
            }
        }
    };
    set_env(&mut cmd, "CLAUDE_API_KEY", &claude_api_key);
    set_env(&mut cmd, "GEMINI_API_KEY", &gemini_api_key);
    set_env(&mut cmd, "SCPRISM_PRIMARY", &primary);
    // Model id for the local/custom OpenAI-compatible endpoint.
    set_env(&mut cmd, "OPENAI_MODEL", &local_model);
    // Workspace context (interview summary) appended to the Companion charter.
    set_env(&mut cmd, "SCPRISM_CONTEXT", &context);
    // User-defined sensitive words — force-local routing (comma separated).
    set_env(&mut cmd, "SCPRISM_SENSITIVE", &sensitive);
    // User-chosen model for the CLI bridge + thinking/effort level.
    set_env(&mut cmd, "SCPRISM_CLI_MODEL", &cli_model);
    set_env(&mut cmd, "SCPRISM_EFFORT", &effort);
    set_env(&mut cmd, "SCPRISM_OPENAI_MODEL", &openai_model);
    set_env(&mut cmd, "SCPRISM_CLAUDE_MODEL", &claude_model);
    set_env(&mut cmd, "SCPRISM_GEMINI_MODEL", &gemini_model);

    // Retained-child capture (cancellable), byte-identical stdout/verdict
    // contract to the old blocking cmd.output().
    let output = run_capturing(cmd, &run_id, &runs)?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        // stdout holds the Verdict JSON regardless of the exit code (a failing
        // verdict exits 1 but still prints valid JSON).
        return Ok(stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "engine produced no output (exit {:?}): {stderr}",
        output.status.code()
    ))
    })
    .await
    .map_err(|e| format!("engine project join failed: {e}"))?
}

/// Merge a finished run branch into `project_dir`'s CURRENT branch via the
/// engine's `project-merge` op (a plain, local, no-ff-forcing merge — NEVER
/// pushes, forces, or rebases; a conflict aborts and reports honestly).
/// Executes `python3 -m scprism_engine project-merge --project-dir <dir>
/// --branch <branch> [--into <into>]`. `into` is the merge target guard (v2
/// final review): when non-empty, the engine refuses unless the repo is
/// ACTUALLY checked out on `into` — closes the self-merge / wrong-branch
/// hole where an interrupted run (repo left on the run branch) or an
/// external checkout would otherwise merge into whatever branch happened to
/// be checked out. Pure git op — no provider credentials needed. Mirrors
/// `run_engine_project`'s stdout-regardless-of-exit contract: the engine
/// always prints one `{ok, detail}` JSON object to stdout (exit 0 ok / 1
/// not-ok), so a non-zero exit still parses.
#[tauri::command]
async fn run_engine_project_merge(
    app: tauri::AppHandle,
    project_dir: String,
    branch: String,
    into: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rt = resolve_engine_runtime(&app)
            .ok_or_else(|| "could not locate the engine (scprism_engine)".to_string())?;
        let mut args: Vec<&str> = vec!["project-merge", "--project-dir", &project_dir, "--branch", &branch];
        let into_trim = into.trim();
        if !into_trim.is_empty() {
            args.push("--into");
            args.push(into_trim);
        }
        let mut cmd = engine_command(&rt, &args);

        let output = cmd
            .output()
            .map_err(|e| format!("failed to launch python: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "engine produced no output (exit {:?}): {stderr}",
            output.status.code()
        ))
    })
    .await
    .map_err(|e| format!("engine project-merge join failed: {e}"))?
}

/// Return an attached project to a clean state via the engine's
/// `project-finish` op: wip-commit any leftovers left on a `scprism/*` run
/// branch, then checkout `base`. Executes `python3 -m scprism_engine
/// project-finish --project-dir <dir> --base <base>`. Pure git op — no
/// provider credentials needed. Same stdout-regardless-of-exit `{ok, detail}`
/// contract as `run_engine_project_merge`.
#[tauri::command]
async fn run_engine_project_finish(
    app: tauri::AppHandle,
    project_dir: String,
    base: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rt = resolve_engine_runtime(&app)
            .ok_or_else(|| "could not locate the engine (scprism_engine)".to_string())?;
        let args: Vec<&str> = vec!["project-finish", "--project-dir", &project_dir, "--base", &base];
        let mut cmd = engine_command(&rt, &args);

        let output = cmd
            .output()
            .map_err(|e| format!("failed to launch python: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "engine produced no output (exit {:?}): {stderr}",
            output.status.code()
        ))
    })
    .await
    .map_err(|e| format!("engine project-finish join failed: {e}"))?
}

/// Run a multi-agent TEAM through the engine (`team` subcommand): each agent
/// on its own provider, orchestrator-relayed board, result JSON on stdout.
/// Provider keys forwarded via env only — never argv. `token_budget` (> 0)
/// becomes `--token-budget <v>` (TG-3), same empty-omission discipline as
/// `run_engine_project`'s optional argv values: 0 means "omit, let the
/// engine's contract default (100_000) apply" rather than an explicit
/// zero-budget run. Provider forwarding otherwise mirrors `run_engine_task`
/// (dev-venv selection + env vars) for parity — every field here reaches a
/// real seam a governed team run reads (each agent's own `Gateway`, or the
/// Tier-2 judge's backend selection) EXCEPT `tier1`, which `run_engine_task`
/// only ever turns into the `run` subcommand's `--tier1 <cmd>` argv flag —
/// `team` has no such flag (a team's Tier-1 is a synthetic, always-advisory
/// pass; see `team.py`), so there is nothing to forward it to and it is
/// intentionally NOT a parameter here.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn run_engine_team(
    app: tauri::AppHandle,
    runs: tauri::State<'_, EngineRuns>,
    run_id: String,
    intent: String,
    vault: String,
    agents: String,
    rounds: u32,
    mode: Option<String>,
    base_url: String,
    api_key: String,
    claude_api_key: Option<String>,
    gemini_api_key: Option<String>,
    primary: Option<String>,
    local_model: Option<String>,
    openai_model: Option<String>,
    claude_model: Option<String>,
    gemini_model: Option<String>,
    context: Option<String>,
    sensitive: Option<String>,
    cli_model: Option<String>,
    effort: Option<String>,
    flag_deepeval: Option<bool>,
    flag_lightrag: Option<bool>,
    flag_bifrost: Option<bool>,
    token_budget: u32,
    web: Option<bool>,
    approval: Option<String>,
    approval_blocking: Option<bool>,
    search_api_key: Option<String>,
    search_endpoint: Option<String>,
    user_capabilities: Option<String>,
    agent_capabilities: Option<String>,
    tool_turns: Option<u32>,
) -> Result<String, String> {
    // Clone the shared run map out of state so it can move into the worker.
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut rt = resolve_engine_runtime(&app)
            .ok_or_else(|| "could not locate the engine (scprism_engine)".to_string())?;

        // Same dev-venv selection as run_engine_task/run_engine_project — a
        // team's Tier-2 judge (evals.evaluate) honors SCPRISM_DEEPEVAL just
        // like a single task's does.
        if let Some(dev) = dev_engine_dir() {
            let want_rag = flag_lightrag.unwrap_or(false);
            let want_eval = flag_deepeval.unwrap_or(false);
            let rag_py = dev.join(".venv-rag/bin/python3");
            let eval_py = dev.join(".venv/bin/python3");
            if want_rag && rag_py.is_file() {
                rt.python = Some(rag_py);
            } else if want_eval && eval_py.is_file() {
                rt.python = Some(eval_py);
            }
        }

        let rounds_s = rounds.max(1).to_string();
        let token_budget_s = token_budget.to_string();
        // Per-run TOOL-TURN cap — same omit-means-default contract as `run`.
        let tool_turns_v = tool_turns.unwrap_or(0);
        let tool_turns_s = tool_turns_v.to_string();
        // Per-agent CAPABILITIES (Sukh-orchestrates design, 2026-08-15). These
        // carry the grant the ENGINE enforces: `--user-capabilities` is the
        // ceiling (a manager can never grant beyond it) and `--agent-capabilities`
        // is the per-agent request, which the engine intersects with the ceiling in
        // capabilities.AgentGrants. Declared BEFORE `args` so the borrows outlive
        // it. Both empty -> no flags -> no gate at all, byte-identical.
        let user_caps = user_capabilities.unwrap_or_default();
        let agent_caps = agent_capabilities.unwrap_or_default();
        let mut args: Vec<&str> = vec![
            "team", &intent, "--vault", &vault, "--agents", &agents, "--rounds", &rounds_s,
        ];
    // Same whitelist-omission discipline as `run` — a conversational team
    // (the composer's team target) stops reaching the judge dressed as a
    // research task. Absent -> byte-identical argv, the read default.
    let team_mode = mode.unwrap_or_default();
    if team_mode == "read" || team_mode == "write" || team_mode == "converse" {
        args.push("--mode");
        args.push(&team_mode);
    }

        if !user_caps.is_empty() || !agent_caps.is_empty() {
            args.push("--user-capabilities");
            args.push(&user_caps);
            args.push("--agent-capabilities");
            args.push(&agent_caps);
        }
        if token_budget > 0 {
            args.push("--token-budget");
            args.push(&token_budget_s);
        }
        if tool_turns_v > 0 {
            args.push("--tool-turns");
            args.push(&tool_turns_s);
        }
        // Web research (web design, 2026-07-23): opt-in `--web` enables the
        // governed web tools for every agent contribution AND the lead
        // synthesis. Off by default — byte-identical without the flag.
        if web.unwrap_or(false) {
            args.push("--web");
        }
        // Tool posture + mid-run blocking (companion grant) — same contract
        // as `run`: 'ask' rides the argv so the gate can't be lost to a
        // failed vault write; blocking needs that active policy to matter.
        let approval_arg = approval.unwrap_or_default();
        if approval_arg == "all" {
            args.push("--require-approval");
            args.push("all");
        }
        if approval_blocking.unwrap_or(false) {
            args.push("--approval-blocking");
            args.push("--approval-timeout");
            args.push("300");
        }
        let mut cmd = engine_command(&rt, &args);
        set_search_env(&mut cmd, &search_api_key, &search_endpoint);
        if flag_deepeval.unwrap_or(false) {
            cmd.env("SCPRISM_DEEPEVAL", "1");
        }
        if flag_lightrag.unwrap_or(false) {
            cmd.env("SCPRISM_LIGHTRAG", "1");
        }
        if flag_bifrost.unwrap_or(false) {
            cmd.env("SCPRISM_BIFROST", "1");
        }
        if !base_url.is_empty() {
            cmd.env("OPENAI_BASE_URL", &base_url);
        }
        if !api_key.is_empty() {
            cmd.env("OPENAI_API_KEY", &api_key);
        }
        let set_env = |cmd: &mut Command, key: &str, val: &Option<String>| {
            if let Some(v) = val {
                if !v.is_empty() {
                    cmd.env(key, v);
                }
            }
        };
        set_env(&mut cmd, "CLAUDE_API_KEY", &claude_api_key);
        set_env(&mut cmd, "GEMINI_API_KEY", &gemini_api_key);
        set_env(&mut cmd, "SCPRISM_PRIMARY", &primary);
        set_env(&mut cmd, "OPENAI_MODEL", &local_model);
        set_env(&mut cmd, "SCPRISM_CONTEXT", &context);
        set_env(&mut cmd, "SCPRISM_SENSITIVE", &sensitive);
        set_env(&mut cmd, "SCPRISM_CLI_MODEL", &cli_model);
        set_env(&mut cmd, "SCPRISM_EFFORT", &effort);
        set_env(&mut cmd, "SCPRISM_OPENAI_MODEL", &openai_model);
        set_env(&mut cmd, "SCPRISM_CLAUDE_MODEL", &claude_model);
        set_env(&mut cmd, "SCPRISM_GEMINI_MODEL", &gemini_model);

        // Retained-child capture (cancellable), byte-identical stdout contract.
        let output = run_capturing(cmd, &run_id, &runs)?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "team run produced no output (exit {:?}): {stderr}",
            output.status.code()
        ))
    })
    .await
    .map_err(|e| format!("team join failed: {e}"))?
}

/// Run the engine's observability `dashboard` view and return its JSON (stdout).
///
/// Executes `python3 -m scprism_engine dashboard --vault <vault>` with the same
/// engine-dir resolution + working directory as `run_engine_task`. The dashboard
/// is a pure read of `<vault>/spans.jsonl`, so it is side-effect free.
#[tauri::command]
async fn run_engine_dashboard(app: tauri::AppHandle, vault: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rt = resolve_engine_runtime(&app)
            .ok_or_else(|| "could not locate the engine (scprism_engine)".to_string())?;

        let output = engine_command(&rt, &["dashboard", "--vault", &vault])
            .output()
            .map_err(|e| format!("failed to launch python: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "engine produced no output (exit {:?}): {stderr}",
            output.status.code()
        ))
    })
    .await
    .map_err(|e| format!("dashboard join failed: {e}"))?
}

/// Run the engine's learning step in dry-run mode and return the training
/// report JSON (stdout).
///
/// Executes `python3 -m scprism_engine train --vault <vault> --dry-run` with
/// the same engine-dir resolution as `run_engine_dashboard`. This reads the
/// vault's accumulated `training/records.jsonl`, trains the RoutePolicy
/// (which model a task ROUTES to — never LLM weight fine-tuning), runs it
/// through the golden lift-gate, and returns a PROMOTE/DISCARD report. The
/// `--dry-run` flag is always forced: this command never persists weights,
/// even when the gate would say PROMOTE.
#[tauri::command]
async fn run_engine_train(app: tauri::AppHandle, vault: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rt = resolve_engine_runtime(&app)
            .ok_or_else(|| "could not locate the engine (scprism_engine)".to_string())?;

        let output = engine_command(&rt, &["train", "--vault", &vault, "--dry-run"])
            .output()
            .map_err(|e| format!("failed to launch python: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "train produced no output (exit {:?}): {stderr}",
            output.status.code()
        ))
    })
    .await
    .map_err(|e| format!("train join failed: {e}"))?
}

/// Run the engine's learning step WITHOUT `--dry-run` — the human's explicit
/// "adopt this router" (LF-2). Identical to `run_engine_train` except it omits
/// `--dry-run`, so the engine PERSISTS a new versioned route policy when — and
/// ONLY when — the golden lift-gate says PROMOTE. The gate stays the machine
/// gate: apply is not bypass. On DISCARD nothing is written and the current
/// router stays live. This still only ever changes ROUTE SELECTION (which model
/// handles a task, local vs cloud) — never LLM weight fine-tuning. Returns the
/// same PROMOTE/DISCARD report JSON (stdout) that names the persisted version.
#[tauri::command]
async fn run_engine_train_apply(app: tauri::AppHandle, vault: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rt = resolve_engine_runtime(&app)
            .ok_or_else(|| "could not locate the engine (scprism_engine)".to_string())?;

        let output = engine_command(&rt, &["train", "--vault", &vault])
            .output()
            .map_err(|e| format!("failed to launch python: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "train apply produced no output (exit {:?}): {stderr}",
            output.status.code()
        ))
    })
    .await
    .map_err(|e| format!("train apply join failed: {e}"))?
}

/// List a configured MCP server's tools via the engine `mcp --action list`
/// (reads `<vault>/mcp-servers.json`). Returns the engine's JSON
/// (`{"server":...,"tools":[{name,description,inputSchema}]}`) on success; on
/// failure the engine prints `{"ok":false,"error":...}` to stderr and exits
/// non-zero, so we return that stderr as the Err string for the UI to surface.
#[tauri::command]
async fn run_engine_mcp(app: tauri::AppHandle, vault: String, server: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rt = resolve_engine_runtime(&app)
            .ok_or_else(|| "could not locate the engine (scprism_engine)".to_string())?;
        let output = engine_command(&rt, &["mcp", "--vault", &vault, "--server", &server, "--action", "list"])
            .output()
            .map_err(|e| format!("failed to launch python: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("{stderr}"))
    })
    .await
    .map_err(|e| format!("mcp join failed: {e}"))?
}

/// Dev-repo engine dir (…/engine next to src-tauri), if present.
///
/// Release builds always answer `None`. The path comes from
/// `env!("CARGO_MANIFEST_DIR")`, which is the builder's own absolute path; in a
/// shipped app it names a directory that does not exist on the user's machine,
/// so the only thing it ever did there was embed the build layout in the binary.
fn dev_engine_dir() -> Option<PathBuf> {
    #[cfg(not(debug_assertions))]
    {
        None
    }
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let p = manifest.parent()?.join("engine");
        if has_pkg(&p) { Some(p) } else { None }
    }
}

/// Which optional engine extensions are AVAILABLE on this machine (dev
/// runtimes: per-extension virtualenvs + the compiled bifrostd). The installed
/// app does not bundle them, so this honestly reports false there.
#[tauri::command]
async fn check_extensions() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(dir) = dev_engine_dir() else {
            return serde_json::json!({
                "deepeval": false, "lightrag": false, "llm": false, "bifrost": false
            });
        };
        serde_json::json!({
            "deepeval": dir.join(".venv/bin/python3").is_file(),
            "lightrag": dir.join(".venv-rag/bin/python3").is_file(),
            "llm": dir.join(".venv-llm/bin/python3").is_file(),
            "bifrost": dir.join("bifrost/bifrostd").is_file(),
        })
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({
        "deepeval": false, "lightrag": false, "llm": false, "bifrost": false
    }))
}

/// Run the engine's REAL compliance export (hash-chained evidence) and write
/// it into the vault as JSON; returns the export JSON string.
#[tauri::command]
async fn run_engine_export(app: tauri::AppHandle, vault: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rt = resolve_engine_runtime(&app)
            .ok_or_else(|| "could not locate the engine".to_string())?;
        let output = engine_command(&rt, &["export", "--vault", &vault])
            .output()
            .map_err(|e| format!("failed to launch python: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Err("export produced no output".into());
        }
        // Persist a copy into the vault so the report is a real artifact.
        let dir = PathBuf::from(&vault).join("exports");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("compliance-export.json"), stdout.as_bytes());
        Ok(stdout)
    })
    .await
    .map_err(|e| format!("export join failed: {e}"))?
}

/// Validate the vault against the OKF v0.1 contract (engine `okf`), returning
/// the report JSON. Read-only. Empty/cold vault → a healthy empty report.
#[tauri::command]
async fn run_engine_okf(app: tauri::AppHandle, vault: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rt = resolve_engine_runtime(&app)
            .ok_or_else(|| "could not locate the engine".to_string())?;
        let output = engine_command(&rt, &["okf", "--vault", &vault])
            .output()
            .map_err(|e| format!("failed to launch python: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }
        Ok("{\"ok\":true,\"issues\":[],\"warnings\":[],\"doc_count\":0}".to_string())
    })
    .await
    .map_err(|e| format!("okf join failed: {e}"))?
}

/// Lines in `<vault>/training/records.jsonl` — the GRPO training seam count.
#[tauri::command]
async fn read_training_count(vault: String) -> u64 {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&vault).join("training").join("records.jsonl");
        match std::fs::read_to_string(&path) {
            Ok(s) => s.lines().filter(|l| !l.trim().is_empty()).count() as u64,
            Err(_) => 0,
        }
    })
    .await
    .unwrap_or(0)
}

/// Durable key-value store under `<appData>/store/<key>.json`. The webview's
/// localStorage flushes lazily and loses the last writes on force-quit — so
/// critical state (settings, onboarding, interview) writes through here.
fn store_file(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err("invalid store key".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("store");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create store dir: {e}"))?;
    Ok(dir.join(format!("{key}.json")))
}

#[tauri::command]
async fn store_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = store_file(&app, &key)?;
        // Write via a temp file + rename so a crash never leaves a torn file.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, value.as_bytes()).map_err(|e| format!("store write failed: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("store rename failed: {e}"))
    })
    .await
    .map_err(|e| format!("store join failed: {e}"))?
}

#[tauri::command]
async fn store_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = store_file(&app, &key)?;
        match std::fs::read_to_string(&path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("store read failed: {e}")),
        }
    })
    .await
    .map_err(|e| format!("store join failed: {e}"))?
}

/// Tail of the vault's span stream (`spans.jsonl`) — the live "engine
/// console" feed. Pure read; returns up to `max_lines` raw JSON lines.
#[tauri::command]
async fn read_spans_tail(vault: String, max_lines: Option<usize>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&vault).join("spans.jsonl");
        let n = max_lines.unwrap_or(60).min(400);
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        let mut tail: Vec<String> = raw.lines().rev().take(n).map(|s| s.to_string()).collect();
        tail.reverse();
        Ok(tail)
    })
    .await
    .map_err(|e| format!("spans read join failed: {e}"))?
}

/// Send a one-way Telegram report through the Bot API (companion grants,
/// 2026-07-29 spec). Runs native-side so the bot token never touches the
/// webview's network layer — same custody discipline as provider keys. The
/// token travels only in the URL path Telegram itself defines; body is JSON
/// {chat_id, text}. Ok(()) ONLY on a 2xx — the caller treats anything else as
/// "not delivered" and says so honestly.
#[tauri::command]
async fn send_telegram(token: String, chat_id: String, text: String) -> Result<(), String> {
    let token = token.trim().to_string();
    let chat_id = chat_id.trim().to_string();
    if token.is_empty() || chat_id.is_empty() {
        return Err("token and chat id are both required".into());
    }
    // Telegram bot tokens are `<digits>:<base64ish>`; positively validate so
    // the token can't rewrite the request path (audit: `\` normalizes to `/`
    // in WHATWG URLs and `%2F` decodes server-side — a denylist is not enough).
    // One rule, shared with the inbound side (telegram::token_looks_valid).
    if !telegram::token_looks_valid(&token) {
        return Err("that does not look like a bot token".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("sc-prism")
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;
    let url = format!("https://api.telegram.org/bot{token}/sendMessage");
    let body = serde_json::json!({ "chat_id": chat_id, "text": text }).to_string();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        // AUDIT: never Display the reqwest error here — it embeds the full
        // request URL, token included, and this string reaches the DOM.
        .map_err(|_| "connection failed — check your network".to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        // Telegram's error payloads carry a short human "description".
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("description").and_then(|d| d.as_str()).map(String::from))
            .unwrap_or_default();
        Err(format!("telegram said {status}{}{}", if detail.is_empty() { "" } else { ": " }, detail))
    }
}

/// Probe a provider endpoint from the native side (avoids webview CORS) over a
/// TLS-capable client, so `https://` cloud endpoints are reachable. GETs `url`
/// with the provider-appropriate auth header when the key is non-empty and a
/// short timeout, returning the HTTP status code. A 401/403 is a real status
/// (server reachable, key needed) — only a connection failure returns Err.
///
/// `auth_header` selects the scheme: `"x-api-key"` sends `x-api-key` +
/// `anthropic-version` (Anthropic Messages API), anything else (default) sends
/// `Authorization: Bearer` (OpenAI-compatible: local / OpenAI / Gemini).
/// Runs on Tauri's async runtime (tokio).
#[tauri::command]
async fn ping_provider(
    url: String,
    api_key: String,
    auth_header: Option<String>,
) -> Result<u16, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(2500))
        // GitHub's API rejects requests without a User-Agent; harmless elsewhere.
        .user_agent("sc-prism")
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let mut req = client.get(&url);
    if !api_key.is_empty() {
        if auth_header.as_deref() == Some("x-api-key") {
            req = req
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01");
        } else {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("connection failed: {e}"))?;
    Ok(resp.status().as_u16())
}

/// A binary name we are willing to look for / run: plain ASCII, no separators,
/// so nothing from the webview can escape into a path or a shell.
fn is_safe_bin_name(bin: &str) -> bool {
    !bin.is_empty() && bin.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Absolute path of a subscription CLI on this machine, or None. PATH first,
/// then the common install dirs — shared by `check_cli` and `probe_cli` so
/// "installed" and "can it answer" always talk about the SAME binary.
fn find_cli_path(bin: &str) -> Option<PathBuf> {
    if !is_safe_bin_name(bin) {
        return None;
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend(tool_search_dirs(&std::env::var("HOME").unwrap_or_default()));
    dirs.into_iter().map(|d| d.join(bin)).find(|c| c.is_file())
}

/// Locate a subscription CLI (`claude` / `gemini` / `codex`) on this machine.
/// GUI apps get a minimal PATH, so after PATH we search the common install
/// dirs (Homebrew, npm-global, bun, volta, ~/.local, nvm). Returns the absolute
/// path, or Err when not installed. Shares `tool_search_dirs` with the PATH the
/// engine subprocess is given, so discovery and execution agree.
///
/// INSTALLED IS NOT USABLE. This command answers "is the binary there?" and
/// nothing more — a CLI can be installed and still refuse every call (signed
/// out, or an OAuth tier Google has since closed). `probe_cli` is the question
/// "can it actually answer?", and only that one may be reported as connected.
#[tauri::command]
async fn check_cli(bin: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_bin_name(&bin) {
            return Err("invalid binary name".into());
        }
        match find_cli_path(&bin) {
            Some(p) => Ok(p.to_string_lossy().to_string()),
            None => Err(format!("{bin} not found — install it and sign in once")),
        }
    })
    .await
    .map_err(|e| format!("check join failed: {e}"))?
}

/// The cheapest prompt that still proves a real round trip happened.
const CLI_PROBE_PROMPT: &str = "Reply with the single word: ok";

/// The one-shot argv that asks a subscription CLI to answer ONCE, mirroring the
/// gateway's own `_CLI_PROVIDERS` argv (engine/scprism_engine/gateway.py) — the
/// probe must exercise the same call shape the real runs use, or a green tick
/// here would be about a command the app never makes. Unknown binaries are
/// deliberately unprobeable (None) rather than guessed at.
fn cli_probe_argv(bin: &str) -> Option<Vec<String>> {
    let s = |v: &str| v.to_string();
    match bin {
        // --setting-sources project: same as the gateway — do not load the
        // user's personal CLI config/memory just to say "ok".
        "claude" => Some(vec![
            s("-p"),
            s(CLI_PROBE_PROMPT),
            s("--setting-sources"),
            s("project"),
        ]),
        "gemini" => Some(vec![s("-p"), s(CLI_PROBE_PROMPT)]),
        "codex" => Some(vec![
            s("exec"),
            s("--skip-git-repo-check"),
            s(CLI_PROBE_PROMPT),
        ]),
        _ => None,
    }
}

/// The CLI's OWN failure text, trimmed to one honest line the UI can show
/// (e.g. "IneligibleTierError: This client is no longer supported…"). Prefers
/// stderr, falls back to stdout, and never invents a reason: an empty capture
/// yields '' and the caller says only what it knows.
fn cli_error_line(stderr: &str, stdout: &str) -> String {
    let pick = |s: &str| -> String {
        s.lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("")
            .to_string()
    };
    let line = {
        let e = pick(stderr);
        if e.is_empty() {
            pick(stdout)
        } else {
            e
        }
    };
    if line.chars().count() > 200 {
        let cut: String = line.chars().take(200).collect();
        format!("{cut}…")
    } else {
        line
    }
}

/// PROVE a subscription CLI can answer: run its real one-shot command with a
/// short timeout and report what actually happened.
///
/// `Ok(reply)` — the CLI answered (exit 0 with output). `Err(reason)` — it is
/// installed but cannot work right now, carrying the CLI's own error line so
/// the user reads Google's/Anthropic's words rather than ours. Not installed is
/// also an `Err`, worded distinctly; the caller (`pingProvider`) separates the
/// two by asking `check_cli` first.
#[tauri::command]
async fn probe_cli(bin: String, timeout_secs: Option<u64>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_bin_name(&bin) {
            return Err("invalid binary name".into());
        }
        let path = match find_cli_path(&bin) {
            Some(p) => p,
            None => return Err(format!("{bin} not found — install it and sign in once")),
        };
        let args = match cli_probe_argv(&bin) {
            Some(a) => a,
            None => return Err(format!("no probe is defined for {bin}")),
        };
        // Bounded: a hung CLI must not hold the app's health check open.
        let secs = timeout_secs.unwrap_or(45).clamp(5, 120);

        let mut cmd = Command::new(&path);
        for a in &args {
            cmd.arg(a);
        }
        cmd.env("PATH", engine_path_env())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("{bin} could not start: {e}"))?;
        // Drain both pipes on side threads so a chatty CLI can't fill a pipe
        // and wedge the wait loop below (same discipline as `run_capturing`).
        let mut out = child.stdout.take();
        let mut err = child.stderr.take();
        let t_out = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(h) = out.as_mut() {
                let _ = h.read_to_string(&mut s);
            }
            s
        });
        let t_err = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(h) = err.as_mut() {
                let _ = h.read_to_string(&mut s);
            }
            s
        });

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) => {}
                Err(e) => return Err(format!("{bin} probe failed: {e}")),
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{bin} did not answer within {secs}s"));
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        let stdout = t_out.join().unwrap_or_default();
        let stderr = t_err.join().unwrap_or_default();

        if status.success() && !stdout.trim().is_empty() {
            return Ok(stdout.trim().chars().take(200).collect::<String>());
        }
        let line = cli_error_line(&stderr, &stdout);
        Err(if line.is_empty() {
            format!("{bin} exited without answering")
        } else {
            line
        })
    })
    .await
    .map_err(|e| format!("probe join failed: {e}"))?
}

/// Run `git` against the vault directory. When `token` is supplied, a
/// credential helper reads it from the GIT_TOKEN env var — the token never
/// appears in argv, remote URLs, or .git/config.
fn run_git(vault: &str, args: &[&str], token: Option<&str>) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(vault);
    if token.is_some() {
        cmd.arg("-c").arg(
            "credential.helper=!f() { echo username=x-access-token; echo \"password=$GIT_TOKEN\"; }; f",
        );
    }
    for a in args {
        cmd.arg(a);
    }
    if let Some(t) = token {
        cmd.env("GIT_TOKEN", t);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.output().map_err(|e| format!("failed to run git: {e}"))
}

fn valid_repo_slug(repo: &str) -> bool {
    let parts: Vec<&str> = repo.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        })
}

/// Sync the vault folder to a GitHub repo: init if needed, commit everything,
/// push to `main`. Returns a human-readable summary. REAL git — requires the
/// repo to exist on GitHub and the token to have `repo` (contents write) scope.
#[tauri::command]
async fn sync_vault(
    vault: String,
    repo: String,
    token: String,
    message: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    if !valid_repo_slug(&repo) {
        return Err("repo must look like owner/repository".into());
    }
    std::fs::create_dir_all(&vault).map_err(|e| format!("cannot create vault dir: {e}"))?;

    // init (idempotent) + make sure we're on main
    if !PathBuf::from(&vault).join(".git").is_dir() {
        let out = run_git(&vault, &["init", "-b", "main"], None)?;
        if !out.status.success() {
            // older git without -b support
            run_git(&vault, &["init"], None)?;
            run_git(&vault, &["branch", "-M", "main"], None)?;
        }
    }

    run_git(&vault, &["add", "-A"], None)?;

    let msg = message.unwrap_or_else(|| "vault sync from SC Prism".to_string());
    let commit = run_git(
        &vault,
        &[
            "-c",
            "user.name=SC Prism",
            "-c",
            "user.email=scprism@localhost",
            "commit",
            "-m",
            &msg,
        ],
        None,
    )?;
    let commit_err = String::from_utf8_lossy(&commit.stderr).to_string()
        + &String::from_utf8_lossy(&commit.stdout);
    let committed = commit.status.success();
    if !committed && !commit_err.contains("nothing to commit") {
        return Err(format!("git commit failed: {}", commit_err.trim()));
    }

    let url = format!("https://github.com/{repo}.git");
    let push = run_git(&vault, &["push", &url, "HEAD:main"], Some(&token))?;
    if !push.status.success() {
        let err = String::from_utf8_lossy(&push.stderr).trim().to_string();
        return Err(format!("git push failed: {err}"));
    }

    Ok(if committed {
        format!("committed & pushed to {repo} (main)")
    } else {
        format!("nothing new to commit — {repo} (main) is up to date")
    })
    })
    .await
    .map_err(|e| format!("sync join failed: {e}"))?
}

/// Read Obsidian's vault registry (~/Library/Application Support/obsidian/
/// obsidian.json) and return the paths of vaults that still exist on disk.
/// Purely local detection — nothing is opened or modified.
#[tauri::command]
async fn detect_obsidian_vaults() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
    let home = std::env::var("HOME").unwrap_or_default();
    let reg = PathBuf::from(&home)
        .join("Library/Application Support/obsidian/obsidian.json");
    let Ok(raw) = std::fs::read_to_string(&reg) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(map) = v.get("vaults").and_then(|x| x.as_object()) {
        for entry in map.values() {
            if let Some(path) = entry.get("path").and_then(|x| x.as_str()) {
                if PathBuf::from(path).is_dir() {
                    out.push(path.to_string());
                }
            }
        }
    }
    out.sort();
    out
    })
    .await
    .unwrap_or_default()
}

/// Open the native macOS folder picker and return the chosen POSIX path.
/// Errors when the user cancels (callers treat Err as "no selection").
#[tauri::command]
async fn pick_folder(prompt: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let msg = prompt.unwrap_or_else(|| "Choose a folder".to_string());
    // `choose folder` needs no extra permissions and matches the OS look.
    let script = format!(
        "POSIX path of (choose folder with prompt \"{}\")",
        msg.replace('"', "")
    );
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if !output.status.success() {
        return Err("cancelled".into());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let path = path.trim_end_matches('/').to_string();
    if path.is_empty() {
        return Err("cancelled".into());
    }
    Ok(path)
    })
    .await
    .map_err(|e| format!("picker join failed: {e}"))?
}

/// Open the native macOS file picker and return the chosen POSIX path.
/// Errors when the user cancels (callers treat Err as "no selection"). Mirrors
/// `pick_folder` exactly, but asks for a file (`choose file`) instead of a
/// folder — used by the chat composer's 📎 attach button (Slice A).
#[tauri::command]
async fn pick_file(prompt: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let msg = prompt.unwrap_or_else(|| "Choose a file".to_string());
    let script = format!(
        "POSIX path of (choose file with prompt \"{}\")",
        msg.replace('"', "")
    );
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript failed: {e}"))?;
    if !output.status.success() {
        return Err("cancelled".into());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Err("cancelled".into());
    }
    Ok(path)
    })
    .await
    .map_err(|e| format!("picker join failed: {e}"))?
}

/// Cap on how much of a picked file's text this command will read into a chat
/// attachment (200 KB) — plenty for source/docs, small enough to keep a huge
/// log/dataset from blowing up the model's context window.
const MAX_ATTACH_FILE_BYTES: u64 = 200_000;

/// Read one arbitrary file's UTF-8 text content for a chat attachment (Slice
/// A: files reach the AI as plain context — works with any connected model).
/// Only absolute paths are accepted (mirrors `reveal_path`'s allowlist — a
/// `pick_file` result is always absolute, so this also guards any caller
/// passing a relative/`~` path through by mistake). Oversize and non-UTF-8
/// (binary) files are rejected honestly rather than truncated or mangled, so
/// the composer can surface "couldn't attach <name>" instead of silently
/// dropping or corrupting content.
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !path.starts_with('/') {
            return Err("only absolute paths are allowed".into());
        }
        let meta = std::fs::metadata(&path).map_err(|e| format!("not found: {e}"))?;
        if !meta.is_file() {
            return Err("not a file".into());
        }
        if meta.len() > MAX_ATTACH_FILE_BYTES {
            return Err(format!(
                "file too large to attach (>{} KB)",
                MAX_ATTACH_FILE_BYTES / 1000
            ));
        }
        // Distinguish a genuine non-UTF-8/binary file (InvalidData) from a
        // real IO failure (permissions, or a TOCTOU race where the file was
        // moved/deleted between the metadata check and the read) — don't
        // mislabel a permission error as "not a text file".
        std::fs::read_to_string(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::InvalidData {
                "not a text file (binary or non-UTF-8 content)".to_string()
            } else {
                format!("read failed: {e}")
            }
        })
    })
    .await
    .map_err(|e| format!("read join failed: {e}"))?
}

/// Cap on how large an attached IMAGE this command will read into a data URI
/// (5 MB) — a chat attachment, not a payload. Mirrors the engine's own cap so
/// the client and engine agree on what's attachable.
const MAX_ATTACH_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

/// Standard base64 alphabet (RFC 4648) — a tiny dependency-free encoder so the
/// image-attach data URI needs no extra crate.
const B64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode bytes to standard base64 (with `=` padding). Small + allocation-light;
/// used only for the capped (<=5 MB) image attachment.
fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(B64_ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// The image MIME for a path's extension, or `None` for an unsupported type.
/// png/jpeg/gif/webp only — the same set the engine's `load_image_block` accepts.
fn image_mime_for(path: &str) -> Option<&'static str> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

/// Read a local image file into a `data:<mime>;base64,<b64>` URI for the chat
/// composer's image thumbnail preview (image attach). Path-safe: absolute paths
/// only (a `pick_file` result always is), capped at 5 MB, and the MIME must be a
/// supported image type (png/jpeg/gif/webp) — an unsupported/oversize/unreadable
/// pick is an HONEST error the composer surfaces as "couldn't attach <name>",
/// never a silently mangled or fabricated preview. The ENGINE independently
/// re-reads + validates the same file on send (`run --image <path>`), so this is
/// purely the preview path.
#[tauri::command]
async fn read_image_base64(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !path.starts_with('/') {
            return Err("only absolute paths are allowed".into());
        }
        let mime = image_mime_for(&path)
            .ok_or_else(|| "unsupported image type (png/jpeg/gif/webp only)".to_string())?;
        let meta = std::fs::metadata(&path).map_err(|e| format!("not found: {e}"))?;
        if !meta.is_file() {
            return Err("not a file".into());
        }
        if meta.len() > MAX_ATTACH_IMAGE_BYTES {
            return Err(format!(
                "image too large to attach (>{} MB)",
                MAX_ATTACH_IMAGE_BYTES / (1024 * 1024)
            ));
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("read failed: {e}"))?;
        Ok(format!("data:{mime};base64,{}", b64_encode(&bytes)))
    })
    .await
    .map_err(|e| format!("read join failed: {e}"))?
}

/// Fetch the provider's REAL available-model list from its models endpoint.
/// Works for OpenAI-compatible providers (`{"data":[{"id":..}]}`) and the
/// Anthropic Messages API (same shape, `x-api-key` auth). Returns model ids.
#[tauri::command]
async fn list_models(
    url: String,
    api_key: String,
    auth_header: Option<String>,
) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(6000))
        .user_agent("sc-prism")
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;
    let mut req = client.get(&url);
    if !api_key.is_empty() {
        if auth_header.as_deref() == Some("x-api-key") {
            req = req
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01");
        } else {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }
    }
    let resp = req.send().await.map_err(|e| format!("connection failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("models endpoint returned {}", resp.status().as_u16()));
    }
    let text = resp.text().await.map_err(|e| format!("body read failed: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("bad JSON: {e}"))?;
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.get("models").and_then(|d| d.as_array()));
    let mut out: Vec<String> = arr
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    m.get("id")
                        .and_then(|x| x.as_str())
                        .or_else(|| m.get("name").and_then(|x| x.as_str()))
                        .map(|s| s.trim_start_matches("models/").to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.dedup();
    Ok(out)
}

/// GET a provider endpoint and return its RAW JSON body (native only, so the
/// webview's CORS rules cannot block a localhost server). Same auth handling
/// and same shape as `list_models`, but the caller parses the body itself —
/// used for the local server's `/v1/models/status`, whose per-model sizes,
/// memory ceiling and load-rate estimate are the ONLY honest source for "will
/// this model even load right now?" (the picker must never estimate those).
///
/// The body is capped: a runaway endpoint must not hand the webview megabytes.
/// A non-2xx status is an Err naming the code — never a silent empty object,
/// which the picker would have to render as "nothing measured".
#[tauri::command]
async fn provider_get_json(
    url: String,
    api_key: String,
    auth_header: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(4000))
        .user_agent("sc-prism")
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;
    let mut req = client.get(&url);
    if !api_key.is_empty() {
        if auth_header.as_deref() == Some("x-api-key") {
            req = req
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01");
        } else {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("connection failed: {e}"))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("endpoint returned {status}"));
    }
    let text = resp.text().await.map_err(|e| format!("body read failed: {e}"))?;
    const MAX_BODY: usize = 512 * 1024;
    if text.len() > MAX_BODY {
        return Err(format!("body too large ({} bytes)", text.len()));
    }
    Ok(text)
}

/// Open an http(s) URL in the user's default browser (macOS `open`).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("open failed: {e}"))?;
    Ok(())
}

/// Open a local file in its DEFAULT app (macOS `open`): html in the browser,
/// images in Preview, and so on (his ask, 2026-08-31). Absolute paths only —
/// same rule as reveal_path; the file must exist so `open` cannot be steered
/// at app names or flags.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("only absolute paths are allowed".into());
    }
    if !std::path::Path::new(&path).is_file() {
        return Err("no such file".into());
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open failed: {e}"))?;
    Ok(())
}

/// Reveal a filesystem path in the Finder (macOS `open -R`), selecting it in
/// its enclosing folder. Only absolute paths are accepted — a relative or `~`
/// path must never reach the shell as-is (mirrors `open_url`'s allowlist).
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("only absolute paths are allowed".into());
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open failed: {e}"))?;
    Ok(())
}

/// Append one chat turn (user message + assistant reply) to the vault's running
/// conversation log at `<vault>/conversations/chat-log.md` as markdown. Creates
/// the `conversations` directory if needed. Best-effort note write-back.
#[tauri::command]
async fn append_chat_note(
    vault: String,
    user_msg: String,
    assistant_msg: String,
    model: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let dir = PathBuf::from(&vault).join("conversations");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create conversations dir: {e}"))?;
        let path = dir.join("chat-log.md");
        let entry =
            format!("\n## You\n{user_msg}\n\n**{model}:**\n{assistant_msg}\n\n---\n");
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("cannot open chat log: {e}"))?;
        file.write_all(entry.as_bytes())
            .map_err(|e| format!("chat log write failed: {e}"))
    })
    .await
    .map_err(|e| format!("chat note join failed: {e}"))?
}

/// Guard a vault-relative path: no absolutes, no `..`, non-empty.
fn safe_rel(relpath: &str) -> Result<(), String> {
    if relpath.is_empty() || relpath.starts_with('/') || relpath.contains("..") {
        return Err("invalid path".into());
    }
    Ok(())
}

/// List one vault SUBDIRECTORY's files, any extension (relative paths, sorted).
///
/// `list_vault_tree` returns only `.md`, which is right for a markdown vault
/// and wrong for `tools/`, where every manifest is `.json`. The generated-tools
/// view rendered "none yet" against a vault that held two tools purely because
/// nothing could see a file that was not markdown.
///
/// Scoped to a subdirectory on purpose: this is not a general filesystem
/// reader, and a caller cannot walk out of the vault with it.
#[tauri::command]
async fn list_vault_dir(vault: String, subdir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fn walk(dir: &PathBuf, base: &PathBuf, out: &mut Vec<String>) {
            if out.len() >= 2000 {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                let p = e.path();
                if p.is_dir() {
                    walk(&p, base, out);
                } else if let Ok(rel) = p.strip_prefix(base) {
                    out.push(rel.to_string_lossy().to_string());
                }
            }
        }
        let base = PathBuf::from(&vault);
        // A subdir containing `..` could escape the vault; refuse rather than
        // normalise, so there is nothing to get subtly wrong.
        if subdir.contains("..") || subdir.starts_with('/') {
            return Ok(Vec::new());
        }
        let root = base.join(&subdir);
        if !base.is_dir() || !root.is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        walk(&root, &base, &mut out);
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Recursively list the vault's markdown files (relative paths, sorted).
/// Hidden entries, .git and node_modules are skipped; capped at 3000 files.
#[tauri::command]
async fn list_vault_tree(vault: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fn walk(dir: &PathBuf, base: &PathBuf, out: &mut Vec<String>) {
            if out.len() >= 3000 {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                let p = e.path();
                if p.is_dir() {
                    walk(&p, base, out);
                } else if name.ends_with(".md") {
                    if let Ok(rel) = p.strip_prefix(base) {
                        out.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
        let base = PathBuf::from(&vault);
        if !base.is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        walk(&base, &base, &mut out);
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| format!("tree join failed: {e}"))?
}

/// Write one file INSIDE a project directory (the Editor's project mode,
/// 2026-08-31: "open up a project like Visual Studio — all files, and I can
/// edit"). Containment is the whole contract: `dir` must be absolute, `rel`
/// must not traverse out (the canonicalized parent must stay under the
/// canonicalized dir), and symlinked targets are refused — a project file
/// edit can never become a write anywhere else.
#[tauri::command]
async fn write_project_file(dir: String, rel: String, content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !dir.starts_with('/') {
            return Err("project dir must be absolute".into());
        }
        let base = std::fs::canonicalize(&dir).map_err(|e| format!("bad project dir: {e}"))?;
        if rel.split('/').any(|seg| seg == "..") || rel.starts_with('/') {
            return Err("relative path may not traverse".into());
        }
        let target = base.join(&rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
            let canon_parent = std::fs::canonicalize(parent).map_err(|e| format!("bad parent: {e}"))?;
            if !canon_parent.starts_with(&base) {
                return Err("path escapes the project".into());
            }
        }
        if target.exists() {
            let meta = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                return Err("refusing to write through a symlink".into());
            }
        }
        std::fs::write(&target, content).map_err(|e| format!("write failed: {e}"))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("write join failed: {e}"))?
}

/// One project file for the room's Files panel: relative path + kind +
/// mtime + size. Everything the panel shows is a real filesystem fact.
#[derive(serde::Serialize)]
struct ProjectFileMeta {
    path: String,
    dir: bool,
    mtime: u64,
    size: u64,
}

/// The room's Files panel listing (project-room spec, 2026-08-29: "even the
/// project holder cannot access that project folder"). Same defensive walk
/// as the vault walkers: dotfiles and node_modules skipped, symlinked dirs
/// never followed (`is_dir` on the entry's own file_type, not the resolved
/// target), capped at 500 entries so a giant folder cannot balloon the IPC
/// payload. Sorted by path for a stable panel.
#[tauri::command]
async fn list_project_files(dir: String) -> Result<Vec<ProjectFileMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fn walk(dir: &PathBuf, base: &PathBuf, out: &mut Vec<ProjectFileMeta>) {
            if out.len() >= 500 {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            let mut items: Vec<_> = entries.flatten().collect();
            items.sort_by_key(|e| e.file_name());
            for e in items {
                if out.len() >= 500 {
                    return;
                }
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    continue;
                }
                let p = e.path();
                let Ok(ft) = e.file_type() else { continue };
                let meta = e.metadata().ok();
                let mtime = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let Ok(rel) = p.strip_prefix(base) else { continue };
                if ft.is_dir() {
                    out.push(ProjectFileMeta {
                        path: rel.to_string_lossy().to_string(),
                        dir: true,
                        mtime,
                        size: 0,
                    });
                    walk(&p, base, out);
                } else if ft.is_file() {
                    out.push(ProjectFileMeta {
                        path: rel.to_string_lossy().to_string(),
                        dir: false,
                        mtime,
                        size: meta.map(|m| m.len()).unwrap_or(0),
                    });
                }
                // Symlinks (neither branch): skipped entirely — a committed
                // link escaping the project must never be walked or sized.
            }
        }
        let base = PathBuf::from(&dir);
        if !base.is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        walk(&base, &base, &mut out);
        Ok(out)
    })
    .await
    .map_err(|e| format!("list join failed: {e}"))?
}

/// One vault note's change-relevant identity: relative path + mtime + size.
/// The heartbeat's unchanged-state guard compares lists of these for free
/// instead of paying a model call to re-read an unchanged vault.
#[derive(serde::Serialize)]
struct VaultNoteMeta {
    path: String,
    mtime: u64,
    size: u64,
}

/// list_vault_tree with metadata — same walk, same caps, same .md filter.
#[tauri::command]
async fn list_vault_tree_meta(vault: String) -> Result<Vec<VaultNoteMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fn walk(dir: &PathBuf, base: &PathBuf, out: &mut Vec<VaultNoteMeta>) {
            if out.len() >= 3000 {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                let p = e.path();
                if p.is_dir() {
                    walk(&p, base, out);
                } else if name.ends_with(".md") {
                    if let Ok(rel) = p.strip_prefix(base) {
                        let meta = e.metadata().ok();
                        let mtime = meta
                            .as_ref()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        let size = meta.map(|m| m.len()).unwrap_or(0);
                        out.push(VaultNoteMeta {
                            path: rel.to_string_lossy().to_string(),
                            mtime,
                            size,
                        });
                    }
                }
            }
        }
        let base = PathBuf::from(&vault);
        if !base.is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        walk(&base, &base, &mut out);
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    })
    .await
    .map_err(|e| format!("tree meta join failed: {e}"))?
}

/// Read one markdown file from the vault (capped at 1 MB).
#[tauri::command]
async fn read_vault_file(vault: String, relpath: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        safe_rel(&relpath)?;
        let path = PathBuf::from(&vault).join(&relpath);
        let meta = std::fs::metadata(&path).map_err(|e| format!("not found: {e}"))?;
        if meta.len() > 1_000_000 {
            return Err("file too large to open here (>1 MB)".into());
        }
        std::fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))
    })
    .await
    .map_err(|e| format!("read join failed: {e}"))?
}

/// Delete one file (never a directory) inside the vault.
#[tauri::command]
async fn delete_vault_file(vault: String, relpath: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        safe_rel(&relpath)?;
        let path = PathBuf::from(&vault).join(&relpath);
        if !path.is_file() {
            return Err("not a file".into());
        }
        std::fs::remove_file(&path).map_err(|e| format!("delete failed: {e}"))
    })
    .await
    .map_err(|e| format!("delete join failed: {e}"))?
}

/// REAL backlinks: which vault files reference `target` (by [[name]] or path),
/// up to 20 results. Case-insensitive on the note name.
#[tauri::command]
async fn find_backlinks(vault: String, target: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        safe_rel(&target)?;
        let base = PathBuf::from(&vault);
        let stem = std::path::Path::new(&target)
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if stem.is_empty() {
            return Ok(Vec::new());
        }
        fn walk(dir: &PathBuf, base: &PathBuf, stem: &str, target: &str, out: &mut Vec<String>) {
            if out.len() >= 20 {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                if out.len() >= 20 {
                    return;
                }
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                let p = e.path();
                if p.is_dir() {
                    walk(&p, base, stem, target, out);
                } else if name.ends_with(".md") {
                    let Ok(rel) = p.strip_prefix(base) else { continue };
                    let rel_s = rel.to_string_lossy().to_string();
                    if rel_s == target {
                        continue;
                    }
                    // Size cap keeps the scan cheap on big vaults.
                    if std::fs::metadata(&p).map(|m| m.len() > 512_000).unwrap_or(true) {
                        continue;
                    }
                    if let Ok(content) = std::fs::read_to_string(&p) {
                        let low = content.to_lowercase();
                        if low.contains(&format!("[[{stem}")) || low.contains(&target.to_lowercase()) {
                            out.push(rel_s);
                        }
                    }
                }
            }
        }
        let mut out = Vec::new();
        walk(&base, &base, &stem, &target, &mut out);
        Ok(out)
    })
    .await
    .map_err(|e| format!("backlinks join failed: {e}"))?
}

/// Write a markdown note to `<vault>/<relpath>` (overwrite), creating parent
/// dirs. `relpath` is sanitized: no absolute paths, no `..` — stays inside the
/// vault. Used for co-founder deliverables (e.g. plans/first-automations.md).
#[tauri::command]
async fn write_vault_note(vault: String, relpath: String, content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if relpath.contains("..") || relpath.starts_with('/') || relpath.is_empty() {
            return Err("invalid note path".into());
        }
        let full = PathBuf::from(&vault).join(&relpath);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create dir: {e}"))?;
        }
        std::fs::write(&full, content.as_bytes()).map_err(|e| format!("note write failed: {e}"))?;
        Ok(full.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("note join failed: {e}"))?
}

/// Append `content` to `<vault>/<relpath>` (create if missing, create parent dirs).
/// True append — never truncates or overwrites; no size cap. `relpath` sanitized.
#[tauri::command]
async fn append_vault_note(vault: String, relpath: String, content: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        if relpath.contains("..") || relpath.starts_with('/') || relpath.is_empty() {
            return Err("invalid note path".into());
        }
        let full = PathBuf::from(&vault).join(&relpath);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create dir: {e}"))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&full)
            .map_err(|e| format!("cannot open note: {e}"))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("note append failed: {e}"))?;
        Ok(full.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("note join failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Mid-run BLOCKING approval — the client half of the engine's file handshake
// (engine/scprism_engine/approval.py::BlockingApprovalBroker). When blocking is
// enabled and a tool is held, the engine PAUSES the run: it writes a request to
// `<vault>/approvals/pending/<id>.json` and polls `<vault>/approvals/decided/
// <id>.json` (~2×/s, bounded) for our answer. On `"allow"` it runs the tool; on
// `"deny"`/timeout it honestly does not, and cleans up both files. So the client
// SURFACES the pending request as a live "run paused" prompt and WRITES the
// decision atomically. Off by default (no broker → no pending dir → []).
// ---------------------------------------------------------------------------

/// One paused run awaiting a live decision — a request the engine wrote to
/// `<vault>/approvals/pending/<id>.json`. `at` is wall-clock epoch SECONDS.
#[derive(serde::Serialize)]
struct PendingApproval {
    id: String,
    run_id: Option<String>,
    server: String,
    tool: String,
    args_summary: Option<String>,
    at: Option<f64>,
}

/// Filename-safe approval id: non-empty, bounded, no path separators / `..` /
/// NUL — only `[A-Za-z0-9._-]`. The engine mints `uuid4().hex`, which passes;
/// the guard is what keeps a decision write pinned inside the decided dir.
fn safe_approval_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains('\0')
        || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("invalid approval id".into());
    }
    Ok(())
}

/// The sync body of `read_pending_approvals` (extracted so it is unit-testable
/// without the Tauri async runtime). See the command below for the contract.
fn read_pending_approvals_sync(vault: &str) -> Vec<PendingApproval> {
    let dir = PathBuf::from(vault).join("approvals").join("pending");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<PendingApproval> = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        // Only committed `*.json` requests — the engine's temp files use a
        // `.tmp` suffix (tempfile.mkstemp), so a half-written pending never
        // surfaces.
        if p.extension().map(|x| x != "json").unwrap_or(true) || !p.is_file() {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        // `id` is the decision key — required, and non-empty. A request with
        // neither a server nor a tool has nothing honest to show; skip it.
        let id = match v.get("id").and_then(|x| x.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let server = v.get("server").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let tool = v.get("tool").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if server.is_empty() && tool.is_empty() {
            continue;
        }
        out.push(PendingApproval {
            id,
            run_id: v.get("run_id").and_then(|x| x.as_str()).map(|s| s.to_string()),
            server,
            tool,
            args_summary: v.get("args_summary").and_then(|x| x.as_str()).map(|s| s.to_string()),
            at: v.get("at").and_then(|x| x.as_f64()),
        });
    }
    // Newest pause first (the desk shows the most recent at the top).
    out.sort_by(|a, b| b.at.partial_cmp(&a.at).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// The sync body of `write_approval_decision` (extracted for unit testing).
fn write_approval_decision_sync(vault: &str, id: &str, decision: &str) -> Result<(), String> {
    if decision != "allow" && decision != "deny" {
        return Err("decision must be allow or deny".into());
    }
    safe_approval_id(id)?;
    let dir = PathBuf::from(vault).join("approvals").join("decided");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create decided dir: {e}"))?;
    let path = dir.join(format!("{id}.json"));
    // Temp in the SAME directory so the rename is a same-filesystem atomic swap.
    // The leading dot keeps it out of a plain `*.json` listing.
    let tmp = dir.join(format!(".{id}.json.tmp"));
    let body = serde_json::json!({ "decision": decision }).to_string();
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| format!("decision write failed: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("decision rename failed: {e}"))?;
    Ok(())
}

/// Scan `<vault>/approvals/pending/` for the engine's live blocking-approval
/// requests. Each `*.json` is `{id, run_id, server, tool, args_summary, at}`;
/// unparseable / partial files and non-`.json` temps are skipped SILENTLY (the
/// engine writes atomically, but a torn read is still possible), and an absent
/// dir yields `[]` — so nothing ever fabricates a pause. Newest-first by `at`.
/// Path-safe: only this one directory is scanned; ids never index out of it.
#[tauri::command]
async fn read_pending_approvals(vault: String) -> Result<Vec<PendingApproval>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(read_pending_approvals_sync(&vault)))
        .await
        .map_err(|e| format!("pending approvals join failed: {e}"))?
}

/// Write the user's decision for a paused blocking-approval to
/// `<vault>/approvals/decided/<id>.json` = `{"decision":"allow"|"deny"}`,
/// ATOMICALLY (temp file in the SAME dir + `rename`) so the engine — which polls
/// this path and treats a partial/malformed read as not-yet-decided — never sees
/// a torn file (a non-atomic write would only delay, never corrupt). `decision`
/// must be exactly `"allow"` or `"deny"`; `id` must be a safe filename. Creates
/// the decided dir if needed.
#[tauri::command]
async fn write_approval_decision(vault: String, id: String, decision: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_approval_decision_sync(&vault, &id, &decision))
        .await
        .map_err(|e| format!("decision join failed: {e}"))?
}

// ---------------------------------------------------------------------------
// Power state (2026-08-15 spec §1 — "don't work on a sleeping Mac")
// ---------------------------------------------------------------------------

/// What the machine's power system says about RIGHT NOW.
///
/// `state` is one of exactly three words:
///   "full"    — a normal, fully awake Mac. Work may run.
///   "dark"    — a maintenance / dark wake (or a root domain already stepping
///               down towards sleep). A wake started here cannot finish: commit
///               4f95483 measured ~90s of awake time against a 180s bound spread
///               over 48 minutes of wall clock before the app's own cancel
///               killed it. The caller SKIPS without spending tokens.
///   "unknown" — the state could not be determined. The caller RUNS: work is
///               never skipped on a guess.
/// `detail` is always the real reason, quoted from what we actually read, so the
/// skipped beat can say why instead of asserting something unverified.
#[derive(Clone, serde::Serialize)]
pub struct PowerState {
    pub state: String,
    pub detail: String,
}

impl PowerState {
    fn unknown(detail: impl Into<String>) -> Self {
        PowerState { state: "unknown".into(), detail: detail.into() }
    }
}

/// Why `pmset -g systemstate` and not something else.
///
/// The distinction we need is the SAME one macOS itself draws between a dark
/// wake and a full wake: in a dark (maintenance) wake the CPU and network come
/// up but GRAPHICS does not. `pmset -g systemstate` prints exactly that, in two
/// stable lines:
///
///     Current System Capabilities are: CPU Graphics Audio Network
///     Current Power State: 4
///
/// The alternatives, and why they lost:
///   • `pmset -g log` — the forensic source 4f95483 used, but it is megabytes of
///     history parsed for one boolean; far too expensive to run every wake.
///   • IOPMCopyCPUPowerStatus — reports CPU speed limiting (thermal/power
///     throttling), not wake type. It cannot answer this question at all.
///   • IOKit FFI (IORegistryEntry → IOPMrootDomain → "System Capabilities") —
///     the SAME bitmask this line is printed from, but it needs core-foundation
///     bindings and unsafe code for a check that runs once every two hours.
///   • IORegisterForSystemPower / a darkwake notification — a run loop thread
///     plus cached state that can go stale across app restarts; a poll asks the
///     kernel the question at the exact moment it matters instead.
///   • An IOPMAssertion — explicitly REJECTED by the user: he chose to defer the
///     work, not to keep the Mac awake. Nothing here holds an assertion.
///
/// Degrades toward RUNNING in every failure mode: a missing line, an
/// unrecognised capability set, a non-zero exit or an unrunnable binary all
/// return "unknown", never "dark".
#[cfg(target_os = "macos")]
fn read_power_state_sync() -> PowerState {
    match Command::new("/usr/bin/pmset").args(["-g", "systemstate"]).output() {
        Ok(o) if o.status.success() => parse_power_state(&String::from_utf8_lossy(&o.stdout)),
        Ok(o) => PowerState::unknown(format!(
            "pmset -g systemstate exited with {}",
            o.status.code().map(|c| c.to_string()).unwrap_or_else(|| "no code".into())
        )),
        Err(e) => PowerState::unknown(format!("pmset could not be run: {e}")),
    }
}

/// Every other platform reports nothing, which means "unknown", which means the
/// caller runs exactly as it always did.
#[cfg(not(target_os = "macos"))]
fn read_power_state_sync() -> PowerState {
    PowerState::unknown("the dark-wake signal is macOS-only; this platform reports nothing")
}

/// Parse `pmset -g systemstate` output. Pure, so the rule is unit-tested.
fn parse_power_state(out: &str) -> PowerState {
    const CAPS: &str = "Current System Capabilities are:";
    const POWER: &str = "Current Power State:";
    let caps_line = out.lines().map(str::trim).find(|l| l.starts_with(CAPS));
    let caps_line = match caps_line {
        Some(l) => l,
        None => return PowerState::unknown("pmset printed no capability line"),
    };
    let caps: Vec<&str> = caps_line[CAPS.len()..].split_whitespace().collect();
    if !caps.iter().any(|c| c.eq_ignore_ascii_case("CPU")) {
        // We are running, so the CPU capability must be there; if it isn't, the
        // line is not the one we think it is. Unknown → the caller runs.
        return PowerState::unknown(format!("unrecognised capability set: {}", caps.join(" ")));
    }
    let graphics = caps.iter().any(|c| c.eq_ignore_ascii_case("Graphics"));
    if !graphics {
        return PowerState {
            state: "dark".into(),
            detail: format!("a maintenance (dark) wake — capabilities: {}", caps.join(" ")),
        };
    }
    // Graphics is up, so this is a full wake — unless the root domain has
    // already begun stepping down (power state below ON), which is the "about
    // to sleep again" half of the same problem.
    if let Some(n) = out
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with(POWER))
        .and_then(|l| l[POWER.len()..].trim().parse::<i32>().ok())
    {
        if n < 4 {
            return PowerState {
                state: "dark".into(),
                detail: format!("the system is at power state {n}, not fully on"),
            };
        }
    }
    PowerState { state: "full".into(), detail: format!("awake — capabilities: {}", caps.join(" ")) }
}

/// Read the machine's wake state. Never fails toward "dark": every error path
/// answers "unknown", and the caller's rule is that unknown RUNS.
#[tauri::command]
async fn power_state() -> Result<PowerState, String> {
    tauri::async_runtime::spawn_blocking(read_power_state_sync)
        .await
        .map_err(|e| format!("power state join failed: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        // Shared handle map for in-flight engine subprocesses, so a client that
        // times out can cancel_engine_run(run_id) and actually kill the child.
        .manage(EngineRuns::default())
        // Inbound Telegram decisions: the bot token lives HERE, native side,
        // for as long as reports are on — never in the webview's copy of state.
        .manage(telegram::TelegramInbox::default())
        .invoke_handler(tauri::generate_handler![
            open_path,
            write_project_file,
            list_project_files,
            run_engine_task,
            run_engine_verify,
            run_engine_project,
            run_engine_project_merge,
            run_engine_project_finish,
            run_engine_team,
            cancel_engine_run,
            run_engine_dashboard,
            run_engine_train,
            run_engine_train_apply,
            run_engine_mcp,
            run_engine_okf,
            run_engine_export,
            read_spans_tail,
            check_extensions,
            read_training_count,
            send_telegram,
            store_set,
            store_get,
            ping_provider,
            list_models,
            provider_get_json,
            pick_folder,
            pick_file,
            read_text_file,
            read_image_base64,
            sync_vault,
            check_cli,
            probe_cli,
            detect_obsidian_vaults,
            open_url,
            reveal_path,
            append_chat_note,
            write_vault_note,
            append_vault_note,
            list_vault_tree,
            list_vault_dir,
            list_vault_tree_meta,
            read_vault_file,
            delete_vault_file,
            find_backlinks,
            read_pending_approvals,
            write_approval_decision,
            power_state,
            telegram::telegram_watch_start,
            telegram::telegram_watch_stop,
            telegram::telegram_take_decisions,
            telegram::telegram_watch_log,
            telegram::send_telegram_request,
            telegram::telegram_answer_callback
        ])
        .setup(|app| {
            // THE MANAGER'S HEARTBEAT LIVES IN THE OS, NOT THE WEBVIEW.
            //
            // Both schedulers were `window.setInterval` in the page. macOS
            // throttles timers hard in a hidden or occluded WKWebView — a
            // minimised app can go minutes between ticks, and a manager that
            // only wakes when someone is looking at it is not a manager.
            //
            // This is a real OS thread on a real clock. It emits a tick the
            // frontend listens for and runs the SAME driver; the page's own
            // interval stays as a fallback for anything that misses an event,
            // and the driver's existing busy guard makes a double tick a
            // no-op rather than a double run.
            //
            // It does NOT survive the app being quit — that needs a headless
            // runner, which is a bigger piece. This closes the gap between
            // "open and focused" and "open at all".
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    sleep_secs(MANAGER_TICK_SECS).await;
                    // A failed emit means no window is listening yet; the next
                    // tick tries again rather than tearing the loop down.
                    let _ = handle.emit("scprism://manager-tick", ());
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // A quit is an honest cancel. RunEvent::Exit is the last hook that
            // fires on every quit path (⌘Q, last window closed, app.exit()) —
            // without this, in-flight engine children outlive the app and
            // finish solo on real provider tokens. A force-kill of the app
            // still can't be caught; nothing can catch SIGKILL.
            if let tauri::RunEvent::Exit = event {
                app.state::<EngineRuns>().terminate_all();
            }
        });
}

/// How often the OS-side driver wakes the manager. Matches the webview
/// interval it backs up (`DRIVER_TICK_MS` in src/lib/managers.ts) so the two
/// cannot disagree about how often a tick is expected.
const MANAGER_TICK_SECS: u64 = 30;

/// Sleep off the async runtime's worker so a long wait cannot occupy it.
async fn sleep_secs(secs: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_secs(secs))
    })
    .await;
}

/// Finding 0 — the verify PATH. A GUI-launched app inherits `/usr/bin:/bin`,
/// which cannot see this user's nvm-installed npm; Tier-1 then failed 51 runs
/// with "npm: command not found". These pin the PATH assembly.
#[cfg(test)]
mod path_tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "scprism-path-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn nvm_dirs_are_newest_version_first() {
        let home = tmp_dir("nvm");
        let root = home.join(".nvm/versions/node");
        for v in ["v18.20.1", "v22.14.0", "v20.9.0", "v9.1.0"] {
            std::fs::create_dir_all(root.join(v).join("bin")).unwrap();
        }
        // A version dir without a bin/ is not a usable install.
        std::fs::create_dir_all(root.join("v23.0.0")).unwrap();

        let dirs = nvm_bin_dirs(&root);
        let names: Vec<String> = dirs
            .iter()
            .map(|p| p.parent().unwrap().file_name().unwrap().to_string_lossy().to_string())
            .collect();
        // Numeric (not lexicographic) ordering: 22 > 20 > 18 > 9.
        assert_eq!(names, vec!["v22.14.0", "v20.9.0", "v18.20.1", "v9.1.0"]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_nvm_root_is_empty_not_an_error() {
        assert!(nvm_bin_dirs(&PathBuf::from("/nope/does/not/exist")).is_empty());
    }

    #[test]
    fn enriched_path_keeps_inherited_first_and_adds_tool_dirs_incl_nvm() {
        let home = tmp_dir("enrich");
        std::fs::create_dir_all(home.join(".nvm/versions/node/v22.14.0/bin")).unwrap();
        let homes = home.to_string_lossy().to_string();

        let path = enriched_path("/usr/bin:/bin", &homes);
        let parts: Vec<String> = std::env::split_paths(&path)
            .map(|p| p.to_string_lossy().to_string())
            .collect();

        // The GUI-inherited entries keep priority.
        assert_eq!(parts[0], "/usr/bin");
        assert_eq!(parts[1], "/bin");
        // Standard install dirs are present.
        assert!(parts.iter().any(|p| p == "/opt/homebrew/bin"));
        assert!(parts.iter().any(|p| p == "/usr/local/bin"));
        assert!(parts.iter().any(|p| p == &format!("{homes}/.local/bin")));
        assert!(parts.iter().any(|p| p == &format!("{homes}/.volta/bin")));
        // …and so is the nvm glob — the dir this user's npm actually lives in.
        assert!(parts
            .iter()
            .any(|p| p == &format!("{homes}/.nvm/versions/node/v22.14.0/bin")));
        let _ = std::fs::remove_dir_all(&home);
    }

    // --- CLI liveness probe (2026-08-12) -----------------------------------
    // `check_cli` only ever proved the BINARY EXISTS. A Gemini CLI that is
    // installed but whose Google login Google itself has closed
    // (IneligibleTierError) passed that check, showed green, and kept its seat
    // on every team while contributing an offline stub. These pin the pieces
    // that make "installed" and "usable" separate answers.

    #[test]
    fn probe_argv_mirrors_the_gateways_own_one_shot_shape() {
        assert_eq!(
            cli_probe_argv("claude"),
            Some(vec![
                "-p".to_string(),
                CLI_PROBE_PROMPT.to_string(),
                "--setting-sources".to_string(),
                "project".to_string(),
            ])
        );
        assert_eq!(
            cli_probe_argv("gemini"),
            Some(vec!["-p".to_string(), CLI_PROBE_PROMPT.to_string()])
        );
        assert_eq!(
            cli_probe_argv("codex"),
            Some(vec![
                "exec".to_string(),
                "--skip-git-repo-check".to_string(),
                CLI_PROBE_PROMPT.to_string(),
            ])
        );
    }

    #[test]
    fn an_unknown_binary_is_never_guessed_at() {
        assert_eq!(cli_probe_argv("rm"), None);
        assert!(!is_safe_bin_name("../../bin/sh"));
        assert!(!is_safe_bin_name("gemini; rm -rf /"));
        assert!(!is_safe_bin_name(""));
        assert!(is_safe_bin_name("gemini-cli"));
    }

    #[test]
    fn the_error_line_is_the_clis_own_words_trimmed() {
        // The real one, from the live run that exposed this bug.
        let stderr = "\n  IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals\n  at foo\n";
        assert_eq!(
            cli_error_line(stderr, ""),
            "IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals"
        );
        // stdout is the fallback when the CLI complains there instead.
        assert_eq!(cli_error_line("", "not signed in"), "not signed in");
        // Nothing captured invents nothing.
        assert_eq!(cli_error_line("", ""), "");
        // Long lines are cut, and SAY they were cut.
        let long = "x".repeat(400);
        let cut = cli_error_line(&long, "");
        assert_eq!(cut.chars().count(), 201);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn enriched_path_does_not_duplicate_entries() {
        let path = enriched_path("/opt/homebrew/bin:/usr/bin", "");
        let count = std::env::split_paths(&path)
            .filter(|p| p.to_string_lossy() == "/opt/homebrew/bin")
            .count();
        assert_eq!(count, 1);
    }
}

#[cfg(test)]
mod approval_tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "scprism-approvals-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn safe_approval_id_accepts_uuid_hex_and_rejects_traversal() {
        // uuid4().hex (what the engine mints) is [0-9a-f]{32} — must pass.
        assert!(safe_approval_id("0123456789abcdef0123456789abcdef").is_ok());
        assert!(safe_approval_id("a-b_c.1").is_ok());
        // Path escapes and separators must be rejected.
        assert!(safe_approval_id("").is_err());
        assert!(safe_approval_id("../evil").is_err());
        assert!(safe_approval_id("a/b").is_err());
        assert!(safe_approval_id("a\\b").is_err());
        assert!(safe_approval_id("a\0b").is_err());
    }

    #[test]
    fn read_pending_missing_dir_is_empty() {
        let vault = tmp_vault("missing");
        assert!(read_pending_approvals_sync(vault.to_str().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn write_then_read_round_trip_and_skips_junk() {
        let vault = tmp_vault("roundtrip");
        let vs = vault.to_str().unwrap();
        let pending = vault.join("approvals").join("pending");
        std::fs::create_dir_all(&pending).unwrap();
        // Two real requests + one torn temp + one unparseable file.
        std::fs::write(
            pending.join("id1.json"),
            r#"{"id":"id1","run_id":"r1","server":"fs","tool":"write_file","args_summary":"{\"p\":1}","at":100.0}"#,
        )
        .unwrap();
        std::fs::write(
            pending.join("id2.json"),
            r#"{"id":"id2","server":"echo","tool":"add","at":200}"#,
        )
        .unwrap();
        std::fs::write(pending.join("tmpXXXX.tmp"), "half-written").unwrap();
        std::fs::write(pending.join("broken.json"), "{ not json").unwrap();

        let got = read_pending_approvals_sync(vs);
        // Newest-first by `at`: id2 (200) before id1 (100); junk skipped.
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].id, "id2");
        assert_eq!(got[0].server, "echo");
        assert_eq!(got[0].tool, "add");
        assert_eq!(got[1].id, "id1");
        assert_eq!(got[1].run_id.as_deref(), Some("r1"));

        // Round-trip a decision and confirm the exact bytes the engine expects.
        write_approval_decision_sync(vs, "id2", "allow").unwrap();
        let decided = std::fs::read_to_string(vault.join("approvals").join("decided").join("id2.json")).unwrap();
        assert_eq!(decided, r#"{"decision":"allow"}"#);
        // No temp left behind after the atomic rename.
        assert!(!vault.join("approvals").join("decided").join(".id2.json.tmp").exists());

        // A bad decision or unsafe id is refused (nothing written).
        assert!(write_approval_decision_sync(vs, "id2", "maybe").is_err());
        assert!(write_approval_decision_sync(vs, "../escape", "deny").is_err());

        let _ = std::fs::remove_dir_all(&vault);
    }
}

/// The dark-wake signal (2026-08-15 spec §1). The rule these pin is the one the
/// whole feature rests on: only a capability set that PROVES a dark wake may
/// skip work; everything else — including anything we cannot read — runs.
#[cfg(test)]
mod power_tests {
    use super::*;

    /// A real full wake, copied from this machine's own `pmset -g systemstate`.
    const FULL: &str =
        "Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n";
    /// A maintenance (dark) wake: CPU and network up, graphics NOT.
    const DARK: &str = "Current System Capabilities are: CPU Network \nCurrent Power State: 4\n";

    #[test]
    fn a_full_wake_is_full() {
        let p = parse_power_state(FULL);
        assert_eq!(p.state, "full");
        assert!(p.detail.contains("Graphics"));
    }

    #[test]
    fn a_dark_wake_is_dark_and_says_so() {
        let p = parse_power_state(DARK);
        assert_eq!(p.state, "dark");
        assert!(p.detail.contains("maintenance"));
    }

    #[test]
    fn a_root_domain_stepping_down_counts_as_dark() {
        let p = parse_power_state(
            "Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 1\n",
        );
        assert_eq!(p.state, "dark");
        assert!(p.detail.contains("power state 1"));
    }

    #[test]
    fn anything_unreadable_is_unknown_never_dark() {
        // No capability line at all (a future pmset, a truncated pipe).
        assert_eq!(parse_power_state("").state, "unknown");
        assert_eq!(parse_power_state("something else entirely\n").state, "unknown");
        // A capability set we do not recognise (no CPU) is not evidence of a
        // dark wake — it is evidence we misread the line.
        assert_eq!(
            parse_power_state("Current System Capabilities are: Widget \n").state,
            "unknown"
        );
        // An unparseable power state does not veto an otherwise full wake.
        assert_eq!(
            parse_power_state(
                "Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: ?\n"
            )
            .state,
            "full"
        );
    }

    #[test]
    fn the_live_machine_never_reports_dark_while_this_test_runs() {
        // Running this test IS a full wake (or at least an unreadable one) —
        // the one end-to-end assertion available without sleeping the Mac.
        assert_ne!(read_power_state_sync().state, "dark");
    }
}

/// A quit is an honest cancel (2026-08-28). Quitting the app used to orphan
/// in-flight engine children: each finished solo, spent real provider tokens,
/// and landed a Verdict + spans no client ever recorded. These pin the exit
/// path: `terminate_all` — called on `tauri::RunEvent::Exit` — kills and reaps
/// every child still in the run map, the same kill-then-wait path
/// `cancel_engine_run` takes for one run.
#[cfg(test)]
mod engine_run_exit_tests {
    use super::*;

    /// Retain a long-lived child exactly the way `run_capturing` retains an
    /// in-flight engine run: spawned, then inserted into the shared map.
    fn retain_sleeper(runs: &EngineRuns, id: &str) {
        let child = Command::new("sleep")
            .arg("300")
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn sleep");
        runs.0.lock().unwrap().insert(id.to_string(), child);
    }

    #[test]
    fn quitting_kills_and_reaps_every_retained_child() {
        let runs = EngineRuns::default();
        retain_sleeper(&runs, "step-a");
        retain_sleeper(&runs, "step-b");

        let started = std::time::Instant::now();
        let killed = runs.terminate_all();

        // Both children dead and reaped: terminate_all returning at all
        // (instead of sitting in wait() for the sleepers' 300 seconds) is the
        // proof, and the bound turns a botched kill into a fast failure
        // rather than a hung test run.
        assert_eq!(killed, 2);
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        assert!(runs.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_finished_or_empty_map_is_a_no_op() {
        let runs = EngineRuns::default();
        assert_eq!(runs.terminate_all(), 0);

        // A child that already exited (run finishing right at quit) must
        // neither error nor block — kill is best-effort on a corpse, and
        // wait just returns the cached exit status.
        let mut done = Command::new("true").spawn().expect("spawn true");
        done.wait().expect("reap");
        runs.0.lock().unwrap().insert("finished".into(), done);
        assert_eq!(runs.terminate_all(), 1);
        assert!(runs.0.lock().unwrap().is_empty());
    }
}
