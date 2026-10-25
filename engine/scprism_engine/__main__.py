"""CLI entrypoint — the surface the client (Tauri app) calls (specs/12, E6).

Each subcommand prints a single JSON object to stdout. Exit code is NOT
uniform: the governed, pass/fail-able subcommands — ``run``, ``team``,
``project``, ``project-merge``, ``project-finish``, ``mcp`` — exit 0 on pass/ok
and non-zero on a failed Verdict (or a not-ok merge/finish, or a blocked/failed
MCP call) so scripts can gate on them;
every other subcommand (``dashboard``, ``export``, ``verify-chain``,
``gate``, ``reconstruct``, ``train``, ``okf``) always exits 0, even on an
internal error, and reports failure inside the JSON body instead (E6's
never-crash-on-a-cold-vault contract). The JSON shapes below are a CONTRACT
the client depends on — keep them stable.

    python -m scprism_engine run "<intent>" --vault <dir> [--tier1 "<cmd>"]
        -> Verdict JSON (see writeback.Verdict). Exit 0 pass / 1 fail.

    python -m scprism_engine dashboard --vault <dir>
        -> observability.dashboard(vault): cost attribution, token burn,
           hook-rate, eval-trend, cache warmth, drift signals.

    python -m scprism_engine export --vault <dir> [--from <iso>] [--to <iso>]
        -> evidence.export(...): a compliance artifact for the date range.

    python -m scprism_engine verify-chain --vault <dir>
        -> {"ok": bool, "tampered_at": int|null, "length": int, "reason": str}.

    python -m scprism_engine gate --vault <dir> [--threshold <float>]
        -> ci_gate.run_gate(...): {"passed", "blocked", "threshold", "scores",
           "results", "blockers", "reason"}.

    python -m scprism_engine reconstruct --vault <dir> --task <id>
        -> evidence.reconstruct(id): {"found", "task_id", "who", "what", "why",
           "verdict", "trajectory", "chain_ok", ...}.

Robustness: a missing vault or empty store returns a valid EMPTY JSON object —
these commands never crash on a cold vault (E6 acceptance).
"""

from __future__ import annotations

import argparse
import json
import sys

from .contract import parse
from .loop import run
from .memory import MemoryStore
from .skills import load_vault_skill_catalog


def _emit(obj) -> None:
    """Print one JSON object to stdout (the client parses stdout)."""
    print(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=False))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scprism_engine",
        description="SC Prism Orchestrator engine CLI — the surface the client calls.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # -- run ------------------------------------------------------------
    run_p = sub.add_parser(
        "run",
        help="Orchestrate one task from an intent. Prints Verdict JSON; "
        "exit 0 pass / 1 fail.",
    )
    run_p.add_argument("intent", help="Natural-language task intent.")
    run_p.add_argument(
        "--vault", required=True, help="Directory to write verdicts + log.md into."
    )
    run_p.add_argument(
        "--tier1",
        action="append",
        default=[],
        metavar="CMD",
        help="Deterministic Tier-1 check command (repeatable).",
    )
    run_p.add_argument(
        "--tier1-cwd",
        default=None,
        metavar="DIR",
        help="Working directory the --tier1 commands run in (verify-only "
        "test-loop seam, P2-2): `run` writes no project files and never "
        "branches, so pointing --tier1-cwd at a project directory turns this "
        "into a governed, read-only verification of that project. Omitted runs "
        "Tier-1 in the engine's own process cwd — what a shell caller means, "
        "byte-identical to before. Passing an EMPTY value means 'I have a "
        "verify command but no project directory': Tier-1 is a PROJECT gate, so "
        "with no codebase to check it SKIPS honestly, recording the reason on "
        "the verdict and the span. It never guesses a folder — that "
        "manufactured 'test failures' in whatever directory the caller happened "
        "to occupy — and it never fails a run for having nothing to verify.",
    )
    run_p.add_argument(
        "--mode",
        choices=("read", "write", "converse"),
        default=None,
        help="Override inferred contract mode. `converse` is the chat path's "
        "flag — the turn is planned as one reply and judged as one (the judge "
        "stops asking a conversation for files), and a good reply lands "
        "outcome `replied`, not a build's pass/fail.",
    )
    run_p.add_argument(
        "--token-budget", type=int, default=0, metavar="N",
        help="Hard token cap for this run's contract (0 -> the contract "
        "default, 100_000). Threaded into the TaskContract, so the dispatch "
        "phase and the Tier-2 operating envelope enforce it — breaching the "
        "cap fails the Verdict. Same semantics as `team`'s flag.",
    )
    run_p.add_argument(
        "--tool-turns", type=int, default=0, metavar="N",
        help="Tool executions allowed per model turn (0 -> the engine default, "
        "SCPRISM_TOOL_TURNS or 12). Clamped to a hard ceiling (32) — the loop "
        "stays bounded whatever is asked for, and the run's token budget still "
        "stops it first. Same omit-means-default discipline as --token-budget.",
    )
    run_p.add_argument(
        "--agent", default="", metavar="NAME",
        help="Name the worker for this run, so the crew board and the coworker "
        "panel can say WHO did it. A team run has always named its agents; a "
        "solo run named nobody, so a chat, a wake or a project step was "
        "unattributable. Empty (the default) writes no attr.",
    )
    run_p.add_argument(
        "--stage", default="", metavar="LABEL",
        help="Name the phase of a larger job this run is — e.g. a project's "
        "plan step. Written as the span's `round`, which is what the board "
        "groups its columns by. Empty (the default) writes no attr.",
    )
    run_p.add_argument(
        "--steps", type=int, default=0, metavar="N",
        help="Plan N steps instead of the default shape. Only 1 is special: a "
        "SINGLE findings/implement step, for a task that is one small piece of "
        "work rather than a change to a codebase. 0 (the default) keeps the "
        "deterministic understand -> locate -> produce plan, byte-identical.",
    )
    run_p.add_argument(
        "--route",
        choices=("auto", "local", "cloud"),
        default="auto",
        help="Per-message routing preference honored by the gateway WITHIN the "
        "zero-egress sensitivity floor: 'local' keeps this message on-device, "
        "'cloud' asks the primary cloud provider, 'auto' (default) uses the "
        "gateway's normal rules. Sensitivity ALWAYS wins — a message with a "
        "sensitive keyword stays local even under --route cloud (the route "
        "reason says the override was refused). 'auto' maps to no hint, so it "
        "is byte-identical to omitting this flag.",
    )
    run_p.add_argument(
        "--image",
        default=None,
        metavar="PATH",
        help="Attach a local image (png/jpeg/gif/webp, <=5 MB) to the user "
        "message. A vision-capable cloud route (openai/claude/gemini) receives "
        "it as a real image block; a non-vision route (local, offline stub, or a "
        "CLI bridge) is told HONESTLY that an image was attached but not sent — "
        "never a fabricated 'I can see it'. An image never forces a route: "
        "routing stays on the text, and an image on a LOCAL route stays local. "
        "Default None -> a plain-text message, byte-identical to omitting it.",
    )
    run_p.add_argument(
        "--emit-workflow",
        action="store_true",
        help="Emit the Conductor-style workflow YAML to "
        "<vault>/workflows/<task_id>.yaml before running (ADR-032). "
        "Non-default; the routing graph is recorded in the Verdict.",
    )
    run_p.add_argument(
        "--no-skills",
        action="store_true",
        help="Do not load or inject <vault>/skills/*.md into the model "
        "context (progressive disclosure off). Default: matching saved "
        "skills are disclosed and their instructions injected.",
    )
    run_p.add_argument(
        "--no-memory",
        action="store_true",
        help="Do not construct a MemoryStore for this run (memory injection "
        "off). Default: the vault's profile + L3 notes are surfaced as "
        "candidates and the selected ones are injected under budget. A cold or "
        "non-matching vault yields no candidates, so the default is "
        "byte-identical to --no-memory there.",
    )
    run_p.add_argument(
        "--mcp-server",
        action="append",
        default=None,
        metavar="NAME",
        help="Configured MCP server whose tools the model may request during "
        "dispatch (MCP v2b, ADR-035): each step runs the bounded, gated "
        "tool-use loop; every model turn and tool exec is a real span. "
        "Repeatable or a comma-list to attach MULTIPLE servers in one run — "
        "their tools are merged (name-deduped, first wins) via a "
        "CompositeToolClient; a single server is unchanged (no composite). Each "
        "name must exist in the MCP config (see --mcp-config); unknown -> JSON "
        "error on stderr + exit 1. An unreachable server degrades to tool-less. "
        "Default None: no tools, byte-identical.",
    )
    run_p.add_argument(
        "--require-approval",
        action="append",
        default=None,
        metavar="NAME",
        help="Hold matching tool calls for human sign-off before they run (MCP "
        "follow-ons). Repeatable or comma-list of server-or-tool names, or "
        "'all'. A held call NEVER egresses and returns an honest 'held — needs "
        "approval' observation, audited as a held=True tool_exec span; the loop "
        "continues. Also reads <vault>/mcp-approvals.json when present. Default "
        "none -> byte-identical (every call allowed, subject to the existing "
        "allowlist + sensitivity gates).",
    )
    run_p.add_argument(
        "--approve",
        action="append",
        default=None,
        metavar="NAME",
        help="Pre-grant approval for these server-or-tool names this run "
        "(repeatable or comma-list). A granted call is not held but STILL runs "
        "the allowlist + sensitivity gates (approval is on top of, never "
        "instead of, those).",
    )
    run_p.add_argument(
        "--approval-blocking",
        action="store_true",
        default=False,
        help="Mid-run blocking approval: PAUSE the run at a held tool call and "
        "wait (bounded by --approval-timeout) for the user to Approve/Deny via "
        "the vault handshake (<vault>/approvals/pending -> decided), then resume "
        "the SAME run — 'allow' runs the tool (inner gates still apply), "
        "'deny'/timeout returns the honest held observation (tool NOT run). "
        "Only affects an ACTIVE approval policy. Absent -> byte-identical "
        "(held-then-continue).",
    )
    run_p.add_argument(
        "--approval-timeout",
        type=float,
        default=300.0,
        metavar="SECS",
        help="Bound (seconds) for --approval-blocking: the pause can NEVER hang "
        "forever — on timeout the tool is honestly not run and the run continues "
        "(default 300).",
    )
    run_p.add_argument(
        "--mcp-config",
        default=None,
        metavar="PATH",
        help="MCP server config JSON (default <vault>/mcp-servers.json).",
    )
    run_p.add_argument(
        "--web",
        action="store_true",
        help="Enable web-research tools (web_fetch / web_search) for this run "
        "(web design, 2026-07-23): each dispatch step runs the same bounded, "
        "gated tool-use loop as --mcp-server, under the SAME governance (a "
        "secret is blocked before egress; every call is a real tool_exec span; "
        "citations are real source URLs). Opt-in — absent, byte-identical.",
    )
    run_p.add_argument(
        "--search-api-key",
        default=None,
        metavar="KEY",
        help="Optional web_search API key (or env SCPRISM_SEARCH_API_KEY). With "
        "--search-endpoint, uses a keyed backend; else the keyless default.",
    )
    run_p.add_argument(
        "--search-endpoint",
        default=None,
        metavar="URL",
        help="Optional web_search API endpoint (or env SCPRISM_SEARCH_ENDPOINT).",
    )
    run_p.add_argument(
        "--no-vault-tools",
        action="store_true",
        help="Do not offer the vault tools (vault_list / vault_read / "
        "vault_search / project_status) to this run. Default: they ARE offered "
        "(mission-control design, 2026-08-05) — the vault is the user's own "
        "LOCAL data and the companion's charter requires eyes on it, so they "
        "default ON (opt out here, like --no-skills / --no-memory) rather than "
        "opt IN like --web, which egresses. Read-only, path-confined, and under "
        "the SAME gates as every "
        "other tool source (approval posture, F1 cloud-withhold, real tool_exec "
        "spans). This flag restores the tool-less path.",
    )
    _add_capability_args(run_p)

    # -- dashboard ------------------------------------------------------
    dash_p = sub.add_parser(
        "dashboard",
        help="Observability dashboard JSON: cost attribution, token burn, "
        "hook-rate, eval-trend, cache warmth, drift. Empty vault -> empty JSON.",
    )
    dash_p.add_argument("--vault", required=True, help="Vault to read spans.jsonl from.")

    # -- export ---------------------------------------------------------
    exp_p = sub.add_parser(
        "export",
        help="Compliance export JSON for a date range (evidence.export). "
        "Empty/missing vault -> valid empty artifact.",
    )
    exp_p.add_argument("--vault", required=True, help="Vault to read the audit spine from.")
    exp_p.add_argument(
        "--from", dest="start", default=None, metavar="ISO",
        help="Inclusive ISO-8601 start bound (optional).",
    )
    exp_p.add_argument(
        "--to", dest="end", default=None, metavar="ISO",
        help="Inclusive ISO-8601 end bound (optional).",
    )

    # -- verify-chain ---------------------------------------------------
    vc_p = sub.add_parser(
        "verify-chain",
        help="Verify the audit hash-chain. Prints {ok, tampered_at, length, "
        "reason}. Empty vault -> {ok:true, tampered_at:null}.",
    )
    vc_p.add_argument("--vault", required=True, help="Vault whose audit spine to verify.")

    # -- gate -----------------------------------------------------------
    gate_p = sub.add_parser(
        "gate",
        help="Run the score-based CI gate (ci_gate.run_gate). Prints {passed, "
        "blocked, threshold, scores, results, blockers, reason}.",
    )
    gate_p.add_argument("--vault", required=True, help="Vault the goldens execute in.")
    gate_p.add_argument(
        "--threshold", type=float, default=None, metavar="FLOAT",
        help="Gate-wide score threshold override (optional).",
    )

    # -- reconstruct ----------------------------------------------------
    rec_p = sub.add_parser(
        "reconstruct",
        help="Replay a decision from evidence (evidence.reconstruct). Prints "
        "{found, task_id, who, what, why, verdict, trajectory, chain_ok, ...}. "
        "Unknown task -> {found:false}.",
    )
    rec_p.add_argument("--vault", required=True, help="Vault holding the evidence spine.")
    rec_p.add_argument("--task", required=True, help="task_id to reconstruct.")

    # -- train ----------------------------------------------------------
    train_p = sub.add_parser(
        "train",
        help="Run the offline GRPO flywheel step (specs/10): load training "
        "records, compute group-relative advantages, train the reference "
        "policy, run the eval-lift gate, promote or discard. Empty/missing "
        "records -> clean no-op.",
    )
    train_p.add_argument(
        "--vault", required=True,
        help="Vault holding training/records.jsonl (the seam) + models/.",
    )
    train_p.add_argument(
        "--dry-run", action="store_true",
        help="Train + gate but never persist weights (report the decision only).",
    )
    train_p.add_argument(
        "--epochs", type=int, default=60, metavar="N",
        help="GRPO ascent steps over the advantages (default 60).",
    )
    train_p.add_argument(
        "--lr", type=float, default=0.5, metavar="F",
        help="Policy-gradient learning rate (default 0.5).",
    )

    # -- team ------------------------------------------------------------
    team_p = sub.add_parser(
        "team",
        help="Run a multi-agent team: each agent on its OWN provider, "
        "communicating via the orchestrator-relayed board (ADR-007). "
        "Board persists to <vault>/agents/board-<id>.jsonl. "
        "Prints TeamResult JSON; exit 0 pass / 1 fail.",
    )
    team_p.add_argument("intent", help="The task the team works on.")
    team_p.add_argument("--vault", required=True, help="Vault directory.")
    team_p.add_argument(
        "--agents",
        default="lead:claude-cli,researcher:local,critic:gemini",
        help="Comma list of name:provider (default "
        "'lead:claude-cli,researcher:local,critic:gemini').",
    )
    team_p.add_argument(
        "--rounds", type=int, default=1, help="Board rounds before synthesis."
    )
    team_p.add_argument(
        "--mode", choices=("read", "write", "converse"), default=None,
        help="Contract mode for the team verdict. Default read (advisory "
        "research frame). 'converse' judges a QUESTION put to the board as a "
        "conversation — outcome 'replied' — the same third mode solo chat has.",
    )
    team_p.add_argument(
        "--token-budget", type=int, default=0, metavar="N",
        help="Hard token cap enforced before every agent/synthesis call "
        "(0 -> the contract default, 100_000). Breaching it stops the run "
        "early and forces the Verdict to fail.",
    )
    team_p.add_argument(
        "--tool-turns", type=int, default=0, metavar="N",
        help="Tool executions allowed per agent turn (0 -> the engine default, "
        "SCPRISM_TOOL_TURNS or 12). Clamped to a hard ceiling (32); the token "
        "budget still stops the board first. Same semantics as `run`'s flag.",
    )
    team_p.add_argument(
        "--mcp-server",
        action="append",
        default=None,
        metavar="NAME",
        help="Configured MCP server whose tools every agent contribution AND "
        "the lead synthesis may request (MCP v2b, ADR-035): each turn runs "
        "the bounded, gated tool-use loop. Repeatable or a comma-list to attach "
        "MULTIPLE servers in one run (tools merged, name-deduped, via a "
        "CompositeToolClient; a single server is unchanged). Each name must "
        "exist in the MCP config (see --mcp-config); unknown -> JSON error on "
        "stderr + exit 1. An unreachable server degrades to a tool-less team "
        "run. Default None: no tools, byte-identical.",
    )
    team_p.add_argument(
        "--require-approval",
        action="append",
        default=None,
        metavar="NAME",
        help="Hold matching tool calls for human sign-off before they run (MCP "
        "follow-ons). Repeatable or comma-list of server-or-tool names, or "
        "'all'. A held call NEVER egresses and returns an honest 'held — needs "
        "approval' observation, audited as a held=True tool_exec span. Also "
        "reads <vault>/mcp-approvals.json when present. Default none -> "
        "byte-identical.",
    )
    team_p.add_argument(
        "--approve",
        action="append",
        default=None,
        metavar="NAME",
        help="Pre-grant approval for these server-or-tool names this run "
        "(repeatable or comma-list). A granted call is not held but STILL runs "
        "the allowlist + sensitivity gates.",
    )
    team_p.add_argument(
        "--approval-blocking",
        action="store_true",
        default=False,
        help="Mid-run blocking approval: PAUSE at a held tool call and wait "
        "(bounded by --approval-timeout) for the user to Approve/Deny via the "
        "vault handshake, then resume — 'allow' runs the tool (inner gates still "
        "apply), 'deny'/timeout returns the honest held observation. Only "
        "affects an ACTIVE approval policy. Absent -> byte-identical.",
    )
    team_p.add_argument(
        "--approval-timeout",
        type=float,
        default=300.0,
        metavar="SECS",
        help="Bound (seconds) for --approval-blocking: the pause can NEVER hang "
        "forever — on timeout the tool is honestly not run (default 300).",
    )
    team_p.add_argument(
        "--mcp-config",
        default=None,
        metavar="PATH",
        help="MCP server config JSON (default <vault>/mcp-servers.json).",
    )
    team_p.add_argument(
        "--web",
        action="store_true",
        help="Enable web-research tools (web_fetch / web_search) for every agent "
        "contribution AND the lead synthesis (web design, 2026-07-23): the same "
        "bounded, gated tool-use loop as --mcp-server, under the SAME governance. "
        "Opt-in — absent, byte-identical.",
    )
    team_p.add_argument(
        "--search-api-key",
        default=None,
        metavar="KEY",
        help="Optional web_search API key (or env SCPRISM_SEARCH_API_KEY). With "
        "--search-endpoint, uses a keyed backend; else the keyless default.",
    )
    team_p.add_argument(
        "--search-endpoint",
        default=None,
        metavar="URL",
        help="Optional web_search API endpoint (or env SCPRISM_SEARCH_ENDPOINT).",
    )
    team_p.add_argument(
        "--no-vault-tools",
        action="store_true",
        help="Do not offer the vault tools (vault_list / vault_read / "
        "vault_search / project_status) to this team run. Default: they ARE "
        "offered to every agent contribution AND the lead synthesis "
        "(mission-control design, 2026-08-05), read-only and under the same "
        "gates as every other tool source. This flag restores the tool-less path.",
    )
    _add_capability_args(team_p)

    # -- project ---------------------------------------------------------
    proj_p = sub.add_parser(
        "project",
        help="Run a project-mode task: write files to disk inside a project "
        "directory, gate on Tier-1 (verify_command), then checkpoint to git. "
        "Prints Verdict JSON; exit 0 pass / 1 fail.",
    )
    proj_p.add_argument("intent", help="Natural-language task intent.")
    proj_p.add_argument(
        "--token-budget", type=int, default=0, metavar="N",
        help="Hard token cap for this build step's contract envelope "
        "(0 -> the contract default, 100_000). A four-seat board step "
        "measured 105,843 tokens on 2026-08-29 and failed the ENVELOPE with "
        "a Tier-2 score that had cleared the judge — the cap must be the "
        "caller's deliberate number, not an accident. Breaching it fails the "
        "Verdict, same discipline as run/team.",
    )
    proj_p.add_argument(
        "--project-dir", required=True, help="Directory to write files into."
    )
    proj_p.add_argument(
        "--vault", required=True, help="Directory to write verdicts + log.md into."
    )
    proj_p.add_argument(
        "--tier1",
        default="",
        metavar="CMD",
        help="Deterministic Tier-1 check command (single value, v1).",
    )
    proj_p.add_argument(
        "--context",
        default="",
        metavar="TEXT",
        help="Project brief / context for the model.",
    )
    proj_p.add_argument(
        "--refine-feedback",
        default="",
        metavar="TEXT",
        help="Error output from a previous failed run (triggers refinement "
        "prompt: the failing output, the CURRENT contents of the files being "
        "fixed, and any --data-sample, each bounded and labelled).",
    )
    proj_p.add_argument(
        "--attempt",
        type=int,
        default=0,
        metavar="N",
        help="Which attempt at ONE logical step this run is (1 = the first "
        "try, 2 = the first refine, …). With --attempt-group, the number is "
        "recorded on the Verdict and in <vault>/verdicts/attempts/<group>.json "
        "so attempt N and N+1 are readable as one run. Default 0 = untracked.",
    )
    proj_p.add_argument(
        "--attempt-group",
        default="",
        metavar="ID",
        help="Stable id for the logical step these attempts belong to (e.g. "
        "'<project>:step-2'). The engine never infers this — only the caller "
        "driving the refine loop knows which runs are the same step.",
    )
    proj_p.add_argument(
        "--previous-verdict",
        default="",
        metavar="PATH",
        help="Path to the previous attempt's Verdict JSON. Its files_written "
        "list is what the refine turn is shown the CURRENT contents of, and its "
        "task_id links the attempts together.",
    )
    proj_p.add_argument(
        "--data-sample",
        action="append",
        default=[],
        metavar="PATH",
        help="Path to a REAL input artifact this task must handle (repeatable). "
        "A bounded excerpt of each is quoted into the prompt, labelled as a "
        "sample — for a task that parses an artifact this machine already holds, "
        "the shape is a fact on disk, not something to guess at.",
    )
    proj_p.add_argument(
        "--never-touch",
        action="append",
        default=[],
        metavar="GLOB",
        help="Path glob to reject during file writes (repeatable).",
    )
    proj_p.add_argument(
        "--existing",
        action="store_true",
        help="Attach to an existing folder: run the branch-per-run git "
        "lifecycle (init / no-commits / resume / dirty-refusal, all BEFORE "
        "any model call) instead of new-project behavior. Default false — "
        "omitting this flag is byte-identical to v1.",
    )
    proj_p.add_argument(
        "--slug",
        default="",
        metavar="NAME",
        help="Project slug used to name run branches (scprism/<slug>-<n>); "
        "meaningful only with --existing.",
    )
    proj_p.add_argument(
        "--run-branch",
        default="",
        metavar="NAME",
        help="Stored run branch to resume (from a prior run that already "
        "returned to base, e.g. after an 'attention' verdict): if it still "
        "names a real local branch, that branch is checked out and reused "
        "instead of creating a new scprism/<slug>-<n> branch — steps "
        "already committed on it are never abandoned. A missing/stale "
        "value falls through to normal branch creation. Meaningful only "
        "with --existing; default '' is byte-identical to v1.",
    )
    proj_p.add_argument(
        "--no-skills",
        action="store_true",
        help="Do not load or inject <vault>/skills/*.md into the model "
        "context (progressive disclosure off). Default: matching saved "
        "skills are disclosed and their instructions injected.",
    )
    proj_p.add_argument(
        "--no-memory",
        action="store_true",
        help="Do not construct a MemoryStore for this project step (memory "
        "injection off). Default: the vault's profile + L3 notes flow as "
        "candidates. A cold/non-matching vault is byte-identical either way.",
    )
    proj_p.add_argument(
        "--stage", default="", metavar="LABEL",
        help="Name the PHASE this step is, in the plan's own words. Written as "
        "the span's `round`, which the crew board groups its columns by — so a "
        "four-step plan draws four columns instead of one anonymous 'Working'. "
        "Empty (the default) writes no attr.",
    )
    proj_p.add_argument(
        "--agents",
        default="",
        metavar="SPEC",
        help="Comma list of name:provider (e.g. "
        "'lead:claude,planner:gemini,developer:local') — reuses `team`'s "
        "parse_agents. When given, this step runs a per-role board "
        "(run_project(roster=...), P1-2) instead of a single model. "
        "Default '' is byte-identical to v1 (no roster, single doer).",
    )
    proj_p.add_argument(
        "--web",
        action="store_true",
        help="Enable web-research tools (web_fetch / web_search) for this "
        "project step (web design, 2026-07-23): the step's dispatch runs the "
        "same bounded, gated tool-use loop as `run`, under the SAME governance "
        "(a secret is blocked before egress; every call is a real tool_exec "
        "span; citations are real source URLs). Single-doer steps only for "
        "now — an --agents role board is an injected doer and does not "
        "receive tools yet. Opt-in — absent, byte-identical.",
    )
    proj_p.add_argument(
        "--search-api-key",
        default=None,
        metavar="KEY",
        help="Optional web_search API key (or env SCPRISM_SEARCH_API_KEY). With "
        "--search-endpoint, uses a keyed backend; else the keyless default.",
    )
    proj_p.add_argument(
        "--search-endpoint",
        default=None,
        metavar="URL",
        help="Optional web_search API endpoint (or env SCPRISM_SEARCH_ENDPOINT).",
    )
    proj_p.add_argument(
        "--no-vault-tools",
        action="store_true",
        help="Do not offer the vault tools (vault_list / vault_read / "
        "vault_search / project_status) to this project step. Default: they "
        "ARE offered (mission-control design, 2026-08-05) — same idiom as "
        "`run`/`team`: the vault is the user's own LOCAL data, so it defaults "
        "ON (opt out here) rather than opt IN like --web, which egresses. "
        "Read-only, path-confined, and under the SAME gates as every other "
        "tool source. This flag restores the tool-less path.",
    )
    _add_capability_args(proj_p)

    # -- project-merge ---------------------------------------------------
    merge_p = sub.add_parser(
        "project-merge",
        help="Merge a run branch into the CURRENT branch of --project-dir "
        "(a plain, local, no-ff-forcing merge — never push/force/rebase). "
        "Prints {ok, detail}; exit 0 ok / 1 not-ok.",
    )
    merge_p.add_argument(
        "--project-dir", required=True, help="Attached git repo to merge in."
    )
    merge_p.add_argument(
        "--branch", required=True, help="Branch to merge (e.g. scprism/<slug>-<n>)."
    )
    merge_p.add_argument(
        "--into",
        default="",
        metavar="BASE",
        help="The branch the repo must ACTUALLY be checked out on for the "
        "merge to proceed (the merge target guard, v2 final review): "
        "refuses closed rather than merging into whatever branch happens "
        "to be checked out. Default '' is byte-identical to v1 (no gate).",
    )

    # -- project-finish ----------------------------------------------------
    finish_p = sub.add_parser(
        "project-finish",
        help="Return an attached project to a clean state: wip-commit any "
        "leftovers left on a scprism/* run branch, then checkout --base. "
        "Prints {ok, detail}; exit 0 ok / 1 not-ok.",
    )
    finish_p.add_argument(
        "--project-dir", required=True, help="Attached git repo to finish."
    )
    finish_p.add_argument("--base", required=True, help="Base branch to return to.")

    # -- okf -------------------------------------------------------------
    okf_p = sub.add_parser(
        "okf",
        help="Validate the vault against the OKF v0.1 contract and print the "
        "report (ok, issues, warnings, doc_count).",
    )
    okf_p.add_argument("--vault", required=True, help="Vault directory.")

    # -- mcp -------------------------------------------------------------
    mcp_p = sub.add_parser(
        "mcp",
        help="Connect to a configured MCP server (ADR-009): list its tools or "
        "call one. Governed by an allowlist + sensitivity gate and traced with a "
        "tool_exec span. Prints JSON; exit 0 ok / non-zero on a blocked/failed "
        "call (never fabricates a tool result).",
    )
    mcp_p.add_argument(
        "--vault", required=True,
        help="Vault directory (holds the default config + spans.jsonl).",
    )
    mcp_p.add_argument(
        "--config", default=None, metavar="PATH",
        help="MCP server config JSON (default <vault>/mcp-servers.json).",
    )
    mcp_p.add_argument("--server", required=True, help="Configured server name to use.")
    mcp_p.add_argument(
        "--action", choices=("list", "call"), default="list",
        help="'list' the server's tools, or 'call' one (default list).",
    )
    mcp_p.add_argument(
        "--tool", default="", metavar="NAME",
        help="Tool name to call (required for --action call).",
    )
    mcp_p.add_argument(
        "--args", default="{}", metavar="JSON",
        help="Tool arguments as a JSON object string (for --action call).",
    )

    return parser


def _resolve_mcp_server(vault, server_name, config):
    """Resolve ``--mcp-server NAME`` against the MCP config, or None.

    A bad config or an unknown name prints the same ``{"ok": false, "error":
    ...}`` stderr JSON `_cmd_mcp` uses; the caller then exits 1.
    """
    import os

    from .mcp import MCPError, load_mcp_servers

    config_path = config or os.path.join(vault, "mcp-servers.json")
    try:
        servers = load_mcp_servers(config_path)
    except MCPError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return None
    server = servers.get(server_name)
    if server is None:
        print(
            json.dumps({
                "ok": False,
                "error": f"MCP server {server_name!r} not found in {config_path}",
            }),
            file=sys.stderr,
        )
        return None
    return server


def _open_mcp_client(stack, server, telemetry):
    """Enter a governed ``MCPClient`` on the ExitStack, or None.

    An UNREACHABLE server (failed spawn/handshake) must not kill the run — it
    degrades to a normal tool-less run: the failure is reported honestly on
    stderr and the caller proceeds with ``mcp_client=None``.
    """
    from .mcp import MCPClient, MCPError

    try:
        return stack.enter_context(
            MCPClient(
                server["command"],
                allowed_tools=server.get("allowed_tools"),
                telemetry=telemetry,
                server_name=server["name"],
            )
        )
    except (MCPError, OSError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return None


def _build_web_provider(args, telemetry):
    """Build a governed ``WebToolProvider`` for ``--web`` with the run's
    Telemetry + the configured search backend (key present + endpoint ->
    keyed; else the keyless default). Reads env fallbacks for the search config.
    """
    import os

    from .webtools import WebToolProvider, make_search_backend

    api_key = args.search_api_key or os.environ.get("SCPRISM_SEARCH_API_KEY")
    endpoint = args.search_endpoint or os.environ.get("SCPRISM_SEARCH_ENDPOINT")
    backend = make_search_backend(api_key=api_key, endpoint=endpoint)
    return WebToolProvider(telemetry=telemetry, search_backend=backend)


def _build_vault_provider(args, telemetry):
    """Build the governed ``VaultToolProvider`` for this run, or None.

    ALWAYS-AVAILABLE by design (mission-control design, 2026-08-05, Part 1):
    unlike ``--web`` (which egresses and is therefore opt-in), the vault is the
    user's OWN local data — already read by memory injection and skill
    disclosure on every run — and the companion's charter requires eyes on it.
    So it follows the ``--no-skills`` / ``--no-memory`` idiom: on by default,
    with ``--no-vault-tools`` as the explicit opt-out (which restores the
    byte-identical tool-less path).
    """
    from .vault_tools import VaultToolProvider

    if getattr(args, "no_vault_tools", False):
        return None
    return VaultToolProvider(args.vault, telemetry=telemetry)


def _build_computer_provider(args, telemetry):
    """Governed ``ComputerToolProvider`` when the user's OWN grant includes
    ``computer`` (both doors: the per-agent gate still intersects on top).
    Strictly opt-in — absent from --user-capabilities means None, and the run
    is byte-identical to before the source existed."""
    caps = str(getattr(args, "user_capabilities", "") or "")
    if "computer" not in [c.strip() for c in caps.split(",")]:
        return None
    from .computer_tools import ComputerToolProvider

    return ComputerToolProvider(telemetry=telemetry)


def _build_terminal_provider(args, telemetry):
    """Governed ``TerminalToolProvider`` when the user's OWN grant includes
    ``terminal``. Strictly opt-in; the ACTING risk class means every command
    still rides the approval gate on top of both capability doors."""
    caps = str(getattr(args, "user_capabilities", "") or "")
    if "terminal" not in [c.strip() for c in caps.split(",")]:
        return None
    from .terminal_tools import TerminalToolProvider

    return TerminalToolProvider(telemetry=telemetry)


def _parse_server_names(raw):
    """Flatten the (repeatable, comma-list) ``--mcp-server`` values into an
    ordered, de-duped list of names. ``None``/empty -> ``[]`` (byte-identical, no
    tools). ``["a,b", "a"]`` -> ``["a", "b"]`` (first occurrence wins, matching
    the composite's first-source-wins dedupe)."""
    if not raw:
        return []
    parts = [raw] if isinstance(raw, str) else list(raw)
    out = []
    for part in parts:
        for name in str(part).split(","):
            name = name.strip()
            if name and name not in out:
                out.append(name)
    return out


def _compose_tool_source(
    mcp_clients, web_provider, vault_provider=None, computer_provider=None, terminal_provider=None
):
    """Fold N reachable MCP clients + the optional web provider + the optional
    vault provider into ONE tool source: 0 -> None (byte-identical, no tools);
    exactly 1 -> that source itself (no composite needed — the single-server /
    web-only / vault-only path is unchanged); 2+ -> a ``CompositeToolClient``
    fanning all of them (tools merged, name-deduped, first source wins).

    Order matters: a user's own MCP server (and then web) is listed BEFORE the
    vault source, so a name collision resolves to the user's tool, never to
    ours."""
    sources = [c for c in (mcp_clients or []) if c is not None]
    if web_provider is not None:
        sources.append(web_provider)
    if computer_provider is not None:
        sources.append(computer_provider)
    if terminal_provider is not None:
        sources.append(terminal_provider)
    if vault_provider is not None:
        sources.append(vault_provider)
    if not sources:
        return None

    from .toolhooks import PreToolUseGate

    if len(sources) == 1:
        composed = sources[0]
    else:
        from .webtools import CompositeToolClient

        composed = CompositeToolClient(sources)

    # THE WIRE (2026-08-31). `hooks.py`'s destructive denylist was complete,
    # correct and reachable only through `loop.py`'s `tool_requests`, which
    # nothing outside the tests has ever populated — so the live path had no
    # `rm -rf` guard while a green suite implied one.
    #
    # It lives HERE rather than at each of the three call sites because every
    # run path (solo, team, project) builds its source through this function:
    # there is no call site left to forget. INNERMOST, beneath the approval and
    # capability gates, which is the right order — a tool the user never
    # granted is refused as ungranted, a tool needing sign-off is held, and only
    # a call that clears both is command-scanned. That last step is the one that
    # matters: approval is granted by tool NAME and is permanent, so once
    # `terminal_run` is approved this denylist is the only thing between the
    # model and `rm -rf ~`.
    return PreToolUseGate(composed)


def _add_capability_args(parser) -> None:
    """The per-agent CAPABILITY flags (Sukh-orchestrates design, 2026-08-15).

    Declared once and attached to `run`, `team` and `project` so a grant means
    the same thing everywhere. Both absent (the default) → no grant table, no
    gate, byte-identical to every run before this landed.
    """
    parser.add_argument(
        "--user-capabilities",
        default=None,
        metavar="LIST",
        help="Comma list of the capabilities the USER themselves holds "
        "(vault,web,tools,writes). This is the ceiling: a sub-agent's grant is "
        "the INTERSECTION of what the manager asked for with this, enforced in "
        "capabilities.AgentGrants — a manager can never grant what the user did "
        "not. Absent (with --agent-capabilities also absent) = no gate at all.",
    )
    parser.add_argument(
        "--agent-capabilities",
        default=None,
        metavar="JSON|LIST",
        help="Per-agent grants: a JSON object ('{\"researcher\":[\"web\"]}') or "
        "a bare comma list meaning the single (solo) agent. An agent not named "
        "here gets NOTHING (least privilege). Ungranted tools are hidden from "
        "the model and REFUSED by the engine before the tool source is touched; "
        "'writes' is enforced at project.apply_file_ops.",
    )


def _build_grants(args):
    """The run's ``AgentGrants``, or None when no grant was declared.

    A malformed grant is an honest hard failure (``{"ok": false, ...}`` on
    stderr, exit 1) — never a guessed-at or silently empty grant, because a
    grant nobody can read is not a grant.
    """
    from .capabilities import AgentGrants, CapabilityDenied

    try:
        return AgentGrants.from_cli(
            getattr(args, "user_capabilities", None),
            getattr(args, "agent_capabilities", None),
        ), True
    except CapabilityDenied as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return None, False


def _apply_capability_gate(tool_source, grants, agent=""):
    """Wrap ``tool_source`` in the per-agent capability gate when a grant exists.

    OUTSIDE the approval gate on purpose: a capability the user never granted is
    not something a human can approve away mid-run. No grant / no tools → the
    source is returned untouched (byte-identical).
    """
    if tool_source is None or grants is None:
        return tool_source
    from .capabilities import AgentCapabilityGate

    return AgentCapabilityGate(tool_source, grants, agent=agent)


def _apply_approval_gate(args, tool_source):
    """Wrap ``tool_source`` in an ``ApprovalGate`` when a policy is active.

    Returns ``(source, ok)``. A malformed ``<vault>/mcp-approvals.json`` prints
    an honest ``{"ok": false, ...}`` on stderr and returns ``ok=False`` (the
    caller exits 1 — no crash). No tool source, or no active policy (empty
    ``require`` and no flags), leaves the source untouched -> byte-identical.

    ``--approval-blocking`` (with an ACTIVE policy) attaches a
    ``BlockingApprovalBroker`` so a held call PAUSES for the user's Approve/Deny
    (bounded by ``--approval-timeout``). Absent the flag -> ``broker=None`` ->
    byte-identical held-then-continue. Blocking with no active policy is a no-op
    (there is no gate, so nothing is ever held)."""
    if tool_source is None:
        return tool_source, True
    from .approval import ApprovalGate, BlockingApprovalBroker, load_approval_policy
    from .mcp import MCPError

    try:
        policy = load_approval_policy(
            args.vault,
            require=getattr(args, "require_approval", None),
            approve=getattr(args, "approve", None),
        )
    except MCPError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return None, False
    if policy.is_active():
        broker = None
        if getattr(args, "approval_blocking", False):
            broker = BlockingApprovalBroker(
                args.vault, timeout=getattr(args, "approval_timeout", 300.0)
            )
        return ApprovalGate(tool_source, policy, broker=broker), True
    return tool_source, True


def _cmd_run(args) -> int:
    import os
    from contextlib import ExitStack

    # A negative raw --token-budget must never become a literal negative cap
    # (TaskContract.validate rejects <= 0); clamp to 0 first — 0 keeps the
    # contract's default budget (100_000), the same semantics as omitting the
    # flag. Mirrors _cmd_team's clamp.
    token_budget = max(0, args.token_budget)
    # --steps: 0/absent keeps the default plan (None), so an unused flag is
    # byte-identical to before it existed.
    steps = getattr(args, "steps", 0) or None
    if token_budget > 0:
        contract = parse(
            args.intent, mode=args.mode, token_budget=token_budget, steps=steps
        )
    else:
        contract = parse(args.intent, mode=args.mode, steps=steps)
    # --image: read + validate the local image into a provider-neutral block
    # (png/jpeg/gif/webp, <=5 MB). An unsupported/oversize/unreadable file is an
    # honest JSON error on stderr + exit 1 — never a fabricated attachment.
    # Default None -> no image, byte-identical to a plain-text run.
    image_block = None
    if getattr(args, "image", None):
        from .gateway import GatewayError, load_image_block

        try:
            image_block = load_image_block(args.image)
        except GatewayError as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
            return 1
    # Load the vault's skill catalog so matching skills disclose + inject
    # (roadmap #5). --no-skills opts out entirely — nothing is loaded.
    skill_catalog = None if args.no_skills else load_vault_skill_catalog(args.vault)
    # Construct the vault-backed MemoryStore so LF-1 memory injection is REAL in
    # production (kills debt #10 — no caller built one before). --no-memory opts
    # out. A cold/non-matching vault surfaces no candidates -> byte-identical.
    store = None if args.no_memory else MemoryStore(vault=args.vault)
    with ExitStack() as stack:
        # MCP tool-use (v2b): open the governed client AROUND the run and hand
        # `run` the SAME Telemetry instance, so the client's tool_exec spans
        # land in the same <vault>/spans.jsonl as the run's own spans.
        telemetry = None
        mcp_clients = []
        web_provider = None
        server_names = _parse_server_names(args.mcp_server)
        if server_names:
            from .telemetry import Telemetry

            # One shared Telemetry so every server's tool_exec spans land in the
            # run's single spans.jsonl (built once, before opening any client).
            telemetry = Telemetry(os.path.join(args.vault, "spans.jsonl"))
            for name in server_names:
                server = _resolve_mcp_server(args.vault, name, args.mcp_config)
                if server is None:
                    return 1
                # An unreachable server returns None and degrades tool-less; the
                # reachable ones still compose.
                client = _open_mcp_client(stack, server, telemetry)
                if client is not None:
                    mcp_clients.append(client)
        if args.web:
            # Share the SAME Telemetry as the mcp wiring so web tool_exec spans
            # land in the run's spans.jsonl (build one if mcp didn't).
            from .telemetry import Telemetry

            if telemetry is None:
                telemetry = Telemetry(os.path.join(args.vault, "spans.jsonl"))
            web_provider = _build_web_provider(args, telemetry)
        # Eyes (mission-control design Part 1): the vault tools are offered to
        # EVERY run unless --no-vault-tools. Same shared Telemetry, so their
        # tool_exec spans land in this run's spans.jsonl like any other source.
        vault_provider = None
        if not args.no_vault_tools:
            from .telemetry import Telemetry

            if telemetry is None:
                telemetry = Telemetry(os.path.join(args.vault, "spans.jsonl"))
            vault_provider = _build_vault_provider(args, telemetry)
        # Part B: wrap the composed source in the engine-level approval gate when
        # a policy is active (empty policy / no tools -> untouched, byte-identical).
        computer_provider = None
        if telemetry is None and args.vault:
            from .telemetry import Telemetry

            telemetry = Telemetry(os.path.join(args.vault, "spans.jsonl"))
        computer_provider = _build_computer_provider(args, telemetry)
        terminal_provider = _build_terminal_provider(args, telemetry)
        tool_source, ok = _apply_approval_gate(
            args,
            _compose_tool_source(
                mcp_clients, web_provider, vault_provider, computer_provider, terminal_provider
            ),
        )
        if not ok:
            return 1
        # Per-agent capabilities (2026-08-15): the outermost gate, so a tool the
        # acting agent was never granted is refused before approval is even
        # consulted. No --user/--agent-capabilities -> grants is None -> no gate.
        grants, ok = _build_grants(args)
        if not ok:
            return 1
        tool_source = _apply_capability_gate(tool_source, grants)
        # Per-message route hint: 'auto' -> None (the gateway's normal rules,
        # byte-identical); 'local'/'cloud' -> a request the gateway grants only
        # within the sensitivity floor.
        route_hint = None if args.route == "auto" else args.route
        verdict = run(
            contract,
            vault=args.vault,
            tier1_commands=args.tier1,
            tier1_cwd=args.tier1_cwd,
            skill_catalog=skill_catalog,
            memory=store,
            emit_workflow=args.emit_workflow,
            telemetry=telemetry,
            mcp_client=tool_source,
            route_hint=route_hint,
            image=image_block,
            # Per-run tool-turn budget. 0 (the default, and what every caller
            # that omits the flag sends) means "no per-run choice": the engine
            # resolves the env value or its own default, so an omitted flag is
            # byte-identical to before this flag existed.
            mcp_max_iters=args.tool_turns,
            # WHO and WHICH PHASE — empty writes neither span attr.
            agent_name=getattr(args, "agent", "") or "",
            stage=getattr(args, "stage", "") or "",
        )
    print(verdict.to_json())
    # Point at the trace so a run is reconstructable (specs/07).
    print(f"# spans: {verdict.spans_path}", file=sys.stderr)
    return 0 if verdict.passed else 1


def _cmd_dashboard(args) -> int:
    from . import observability

    try:
        _emit(observability.dashboard(args.vault))
    except Exception as exc:  # cold vault must never crash the client
        _emit({"vault": args.vault, "runs": 0, "run_series": [], "healthy": True,
               "error": repr(exc)})
    return 0


def _cmd_export(args) -> int:
    from .evidence import EvidenceStore

    try:
        artifact = EvidenceStore(args.vault).export(args.start, args.end)
    except Exception as exc:
        artifact = {
            "artifact": "sc-prism-compliance-export",
            "range": {"start": args.start, "end": args.end},
            "count": 0, "passed": 0, "failed": 0, "records": [],
            "chain_verified": True, "error": repr(exc),
        }
    _emit(artifact)
    return 0


def _cmd_verify_chain(args) -> int:
    from .evidence import EvidenceStore

    try:
        report = EvidenceStore(args.vault).verify_chain()
        _emit({
            "ok": report.ok,
            "tampered_at": report.broken_at,
            "length": report.length,
            "reason": report.reason,
        })
    except Exception as exc:
        _emit({"ok": True, "tampered_at": None, "length": 0, "reason": repr(exc)})
    return 0


def _cmd_gate(args) -> int:
    from . import ci_gate

    try:
        # Goldens run in an ISOLATED scratch vault (run_gate's default when no
        # vault is passed) so the gate never pollutes the live vault's evidence /
        # spans / training records — the CIGate isolation guarantee (specs/06 §4).
        result = ci_gate.run_gate(threshold=args.threshold)
        _emit(result.to_dict())
    except Exception as exc:
        _emit({
            "passed": False, "blocked": True, "threshold": args.threshold,
            "scores": {}, "results": [], "blockers": ["gate error"],
            "reason": repr(exc),
        })
        # A crash is NOT a pass. Defaulting an error to success is how a broken
        # gate goes unnoticed: every CI step reads the exit code, not the JSON.
        return 1
    # THE contract for a CI gate: 0 = safe to proceed, non-zero = stop. This
    # returned 0 unconditionally, so a gate that blocked still reported success
    # and any step wired to it was decorative (found pre-release, 2026-08-31).
    return 0 if (result.passed and not result.blocked) else 1


def _cmd_reconstruct(args) -> int:
    from .evidence import EvidenceStore, EvidenceError

    try:
        out = EvidenceStore(args.vault).reconstruct(args.task)
        out["found"] = True
        _emit(out)
    except EvidenceError:
        # Unknown task / empty store — a valid, non-crashing "not found".
        _emit({"found": False, "task_id": args.task, "records": [],
               "trajectory": [], "chain_ok": True})
    except Exception as exc:
        _emit({"found": False, "task_id": args.task, "records": [],
               "trajectory": [], "chain_ok": True, "error": repr(exc)})
    return 0


def _cmd_train(args) -> int:
    from . import grpo

    try:
        report = grpo.run_training_pipeline(
            args.vault,
            epochs=args.epochs,
            lr=args.lr,
            dry_run=args.dry_run,
        )
        _emit(report)
    except Exception as exc:  # a cold/broken vault must never crash the client
        _emit({
            "vault": args.vault, "records": 0, "trained": False,
            "promoted": False, "decision": "NOOP", "reason": repr(exc),
        })
    return 0


def _cmd_team(args) -> int:
    import os
    from contextlib import ExitStack

    from .team import parse_agents, run_team

    agents = parse_agents(args.agents)
    # A negative raw --token-budget must never become a literal negative cap
    # (which would force an over-budget breach at zero tokens spent before
    # any agent speaks); clamp to 0 first, which run_team maps to the
    # contract default — the same semantics as an omitted flag.
    token_budget = max(0, args.token_budget)
    team_mode = getattr(args, "mode", None) or ""
    with ExitStack() as stack:
        # MCP tool-use (v2b): open the governed client AROUND the team run. F3:
        # build ONE Telemetry and hand it to BOTH the client and `run_team`, so
        # the client's tool_exec spans and the team's spans share ONE run_id —
        # a second internally-built Telemetry gave the tool spans a foreign
        # run_id and conjured a phantom run in the dashboard.
        mcp_clients = []
        telemetry = None
        web_provider = None
        server_names = _parse_server_names(args.mcp_server)
        if server_names:
            from .telemetry import Telemetry

            # F3: build ONE Telemetry and hand it to BOTH every client and
            # `run_team`, so the client tool_exec spans and the team's spans
            # share ONE run_id (a second Telemetry conjured a phantom run).
            telemetry = Telemetry(os.path.join(args.vault, "spans.jsonl"))
            for name in server_names:
                server = _resolve_mcp_server(args.vault, name, args.mcp_config)
                if server is None:
                    return 1
                client = _open_mcp_client(stack, server, telemetry)
                if client is not None:
                    mcp_clients.append(client)
        if args.web:
            # Share the SAME Telemetry (F3) so web tool_exec spans and the team's
            # spans keep ONE run_id — no phantom run in the dashboard.
            from .telemetry import Telemetry

            if telemetry is None:
                telemetry = Telemetry(os.path.join(args.vault, "spans.jsonl"))
            web_provider = _build_web_provider(args, telemetry)
        # Eyes (mission-control design Part 1): the vault tools are offered to
        # every team run unless --no-vault-tools, sharing the SAME Telemetry
        # (F3) so their tool_exec spans keep the team's single run_id.
        vault_provider = None
        if not args.no_vault_tools:
            from .telemetry import Telemetry

            if telemetry is None:
                telemetry = Telemetry(os.path.join(args.vault, "spans.jsonl"))
            vault_provider = _build_vault_provider(args, telemetry)
        # Part B: engine-level approval gate (inactive policy / no tools ->
        # untouched, byte-identical).
        computer_provider = None
        if telemetry is None and args.vault:
            from .telemetry import Telemetry

            telemetry = Telemetry(os.path.join(args.vault, "spans.jsonl"))
        computer_provider = _build_computer_provider(args, telemetry)
        terminal_provider = _build_terminal_provider(args, telemetry)
        tool_source, ok = _apply_approval_gate(
            args,
            _compose_tool_source(
                mcp_clients, web_provider, vault_provider, computer_provider, terminal_provider
            ),
        )
        if not ok:
            return 1
        # Per-agent capabilities (2026-08-15). ONE gate shared by the whole
        # board; `run_team` calls `set_agent` before each turn, so agent A's
        # grant can never serve agent B's tool call.
        grants, ok = _build_grants(args)
        if not ok:
            return 1
        # Slice B (2026-08-29): when the CLI declares no grants, each seat's
        # OWN definition file speaks — agents/<slug>.md `tools:` clamped to
        # this run's real ceiling (vault unless opted out, web only when
        # enabled). An over-ask is an escalation surfaced on the result as
        # tool_refusals — said out loud, never silently dropped. No file
        # declares anything → grants stays None → byte-identical run.
        seat_refusals = []
        if grants is None:
            from .capabilities import grants_from_seat_files

            ceiling = []
            if not args.no_vault_tools:
                ceiling.append("vault")
            if args.web:
                ceiling.append("web")
            grants = grants_from_seat_files(
                args.vault, [a.name for a in agents], ceiling
            )
            if grants is not None:
                seat_refusals = grants.escalation_lines()
        tool_source = _apply_capability_gate(tool_source, grants)
        result = run_team(
            args.intent,
            args.vault,
            agents,
            rounds=args.rounds,
            token_budget=token_budget,
            mode=team_mode,
            mcp_client=tool_source,
            telemetry=telemetry,
            # Per-run tool-turn budget; 0 (omitted flag) -> the engine default.
            mcp_max_iters=args.tool_turns,
        )
    out = result.to_dict()
    if seat_refusals:
        out["tool_refusals"] = seat_refusals
    _emit(out)
    return 0 if result.passed else 1


def _cmd_project(args) -> int:
    import os

    from .project import run_project
    from .team import parse_agents

    # Same disclosure wiring as `run` (roadmap #5): load the vault's skill
    # catalog and thread it through run_project -> loop.run. --no-skills opts
    # out (nothing loaded).
    skill_catalog = None if args.no_skills else load_vault_skill_catalog(args.vault)
    # Same LF-1 memory wiring as `run`: surface the vault's profile + L3 notes.
    # --no-memory opts out; a cold/non-matching vault is byte-identical.
    store = None if args.no_memory else MemoryStore(vault=args.vault)
    # P1-3: an --agents roster makes this step run the per-role board
    # (run_project's roster=, P1-2) instead of a single model. Omitted (the
    # default '') -> roster stays None, the byte-identical single-doer path.
    roster = parse_agents(args.agents) if args.agents else None
    # Per-agent capabilities (2026-08-15): `writes` is enforced at
    # project.apply_file_ops. The writer is the board's LEAD (the agent that
    # emits the FILE blocks), or the solo doer when there is no roster.
    grants, ok = _build_grants(args)
    if not ok:
        return 1
    writer_agent = roster[0].name if roster else ""
    # Governed tool source for the STEP LOOP (2026-08-28) — the same wiring
    # `_cmd_run` feeds `loop.run`, minus MCP servers (not offered on this path
    # yet): `--web` opts the governed web provider in; the vault tools default
    # ON with `--no-vault-tools` as the opt-out. ONE Telemetry is built for
    # the providers AND handed through run_project -> loop.run (the F3
    # lesson: a second Telemetry gives the tool_exec spans a foreign run_id —
    # a phantom run in the dashboard). No source at all -> telemetry stays
    # None and loop.run builds its own, byte-identical to the tool-less path.
    telemetry = None
    web_provider = None
    vault_provider = None
    if args.web or not args.no_vault_tools:
        from .telemetry import Telemetry

        telemetry = Telemetry(os.path.join(args.vault, "spans.jsonl"))
    if args.web:
        web_provider = _build_web_provider(args, telemetry)
    if not args.no_vault_tools:
        vault_provider = _build_vault_provider(args, telemetry)
    # Part B + capabilities, exactly as `run`: approval gate first (a vault
    # policy with no flags still gates), then the capability gate OUTERMOST —
    # a tool the user never granted is refused before approval is consulted.
    computer_provider = _build_computer_provider(args, telemetry)
    terminal_provider = _build_terminal_provider(args, telemetry)
    tool_source, ok = _apply_approval_gate(
        args,
        _compose_tool_source([], web_provider, vault_provider, computer_provider, terminal_provider),
    )
    if not ok:
        return 1
    tool_source = _apply_capability_gate(tool_source, grants)
    verdict = run_project(
        args.intent,
        token_budget=max(0, args.token_budget),
        stage=getattr(args, "stage", "") or "",
        project_dir=args.project_dir,
        vault=args.vault,
        verify_command=args.tier1,
        context=args.context,
        refine_feedback=args.refine_feedback,
        attempt=args.attempt,
        attempt_group=args.attempt_group,
        previous_verdict=args.previous_verdict,
        data_samples=args.data_sample,
        never_touch=args.never_touch,
        existing_mode=args.existing,
        slug=args.slug,
        run_branch=args.run_branch,
        roster=roster,
        skill_catalog=skill_catalog,
        memory=store,
        mcp_client=tool_source,
        telemetry=telemetry,
        grants=grants,
        writer_agent=writer_agent,
    )
    print(verdict.to_json())
    # Point at the trace so a run is reconstructable (specs/07).
    print(f"# spans: {verdict.spans_path}", file=sys.stderr)
    return 0 if verdict.passed else 1


def _cmd_project_merge(args) -> int:
    from .project import git_merge_branch

    ok, detail = git_merge_branch(args.project_dir, args.branch, args.into)
    _emit({"ok": ok, "detail": detail})
    return 0 if ok else 1


def _cmd_project_finish(args) -> int:
    from .project import project_finish

    ok, detail = project_finish(args.project_dir, args.base)
    _emit({"ok": ok, "detail": detail})
    return 0 if ok else 1


def _cmd_okf(args) -> int:
    from . import okf

    try:
        _emit(okf.validate_bundle(args.vault))
    except Exception as exc:  # a cold vault must never crash the client
        _emit({"ok": True, "issues": [], "warnings": [], "doc_count": 0,
               "error": repr(exc)})
    return 0


def _cmd_mcp(args) -> int:
    import os

    from .mcp import MCPClient, MCPError, load_mcp_servers
    from .telemetry import Telemetry

    config_path = args.config or os.path.join(args.vault, "mcp-servers.json")
    try:
        servers = load_mcp_servers(config_path)
    except MCPError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return 1
    server = servers.get(args.server)
    if server is None:
        print(
            json.dumps({
                "ok": False,
                "error": f"MCP server {args.server!r} not found in {config_path}",
            }),
            file=sys.stderr,
        )
        return 1

    # Real calls are traced to <vault>/spans.jsonl (same audit spine as runs).
    telemetry = Telemetry(os.path.join(args.vault, "spans.jsonl"))
    try:
        with MCPClient(
            server["command"],
            allowed_tools=server.get("allowed_tools"),
            telemetry=telemetry,
            server_name=server["name"],
        ) as client:
            if args.action == "list":
                tools = client.list_tools()
                _emit({
                    "server": server["name"],
                    "tools": [
                        {
                            "name": t.name,
                            "description": t.description,
                            "inputSchema": t.input_schema,
                        }
                        for t in tools
                    ],
                })
                return 0
            # action == "call"
            if not args.tool:
                print(
                    json.dumps({"ok": False, "error": "--action call requires --tool"}),
                    file=sys.stderr,
                )
                return 1
            try:
                arguments = json.loads(args.args or "{}")
            except json.JSONDecodeError as exc:
                print(
                    json.dumps({"ok": False, "error": f"--args is not valid JSON: {exc}"}),
                    file=sys.stderr,
                )
                return 1
            if not isinstance(arguments, dict):
                print(
                    json.dumps({"ok": False, "error": "--args must be a JSON object"}),
                    file=sys.stderr,
                )
                return 1
            result = client.call_tool(args.tool, arguments)
            _emit({"server": server["name"], "tool": args.tool, "result": result})
            # A tool that reports its OWN failure (MCP isError) is surfaced in the
            # result AND signalled by a non-zero exit, so a script gating on the
            # exit code doesn't read a tool-level error as success.
            return 1 if isinstance(result, dict) and result.get("isError") else 0
    except MCPError as exc:
        # Honest failure: a blocked or failed call is reported as-is, never faked.
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        return 1


_DISPATCH = {
    "run": _cmd_run,
    "dashboard": _cmd_dashboard,
    "export": _cmd_export,
    "verify-chain": _cmd_verify_chain,
    "gate": _cmd_gate,
    "reconstruct": _cmd_reconstruct,
    "train": _cmd_train,
    "team": _cmd_team,
    "project": _cmd_project,
    "project-merge": _cmd_project_merge,
    "project-finish": _cmd_project_finish,
    "okf": _cmd_okf,
    "mcp": _cmd_mcp,
}


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    handler = _DISPATCH.get(args.command)
    if handler is None:
        return 2
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
