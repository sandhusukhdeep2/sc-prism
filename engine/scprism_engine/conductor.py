"""Conductor integration — the planner EMITS a deterministic workflow graph.

ADR-032 (proposed): treat Microsoft Conductor (github.com/microsoft/conductor,
MIT) as a dependency with extension points rather than a fork. The integration
pattern for the loop is: the **planner emits Conductor-style YAML per Task
Contract**, then execution is deterministic — a diffable, inspectable routing
graph exists *before anything runs*. This resolves the topology mismatch
(Conductor fixes structure at definition time; SC Prism plans per task) and
strengthens ADR-007 (a model never orchestrates) and the audit story.

The workflow is a DAG over the planner's steps plus the loop's verify/repair
edges:

  - each planner Step becomes a task typed ``read`` or ``write`` with the
    router's ``route`` (local/cloud);
  - ``deps`` enforce the seriality rule — writes chain one-after-another
    (never concurrent) while independent reads have no deps (parallel-able);
  - two ``verify`` tasks model the two-tier verifier — Tier-1 (deterministic,
    local, zero-token) gates Tier-2 (the model judge); each has an explicit
    ``on_fail: repair`` edge and Tier-1 an ``on_pass`` edge to Tier-2;
  - a single ``repair`` task is the target of those fail edges. Its
    ``retry`` edge back to the first executable step is the ONE intentional
    cycle in the graph; the ``deps`` DAG itself stays acyclic.

Everything here is stdlib-only and deterministic: the YAML is hand-rolled (no
pyyaml), key order is fixed, and the same contract+plan always emits identical
bytes. ``parse_workflow`` is the exact inverse of the emitter, and
``validate_workflow`` checks the structural invariants. A real Conductor
install, if present, is a pluggable second validation backend
(``conductor_available`` / ``try_conductor_validate``); when absent it is
skipped cleanly.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .contract import TaskContract
from .planner import Step, WRITE, READ, plan as _plan

# Task types in the emitted workflow.
T_READ = "read"
T_WRITE = "write"
T_VERIFY = "verify"
T_REPAIR = "repair"

# Fixed task names for the verify/repair spine.
TIER1 = "verify-tier1"
TIER2 = "verify-tier2"
REPAIR = "repair"

WORKFLOW_VERSION = 1


# --------------------------------------------------------------------------
# Workflow construction (deterministic)
# --------------------------------------------------------------------------

def _step_name(step: Step) -> str:
    """Deterministic, readable task name for a planner step."""
    return f"step-{step.index}"


def build_workflow(contract: TaskContract, steps: List[Step]) -> Dict[str, Any]:
    """Build the workflow as an ordered plain dict (ready to dump to YAML).

    Deterministic: key order is fixed and derived only from the contract and
    the (already deterministic) plan. The ``tasks`` list is the planner steps
    in plan order, then Tier-1, Tier-2, and the repair task.
    """
    inputs = {
        "intent": contract.intent,
        "mode": contract.mode,
        "token_budget": int(contract.token_budget),
        "max_turns": int(contract.max_turns),
        "scope": list(contract.scope),
        "acceptance_criteria": list(contract.acceptance_criteria),
    }

    tasks: List[Dict[str, Any]] = []

    # 1. Planner steps → typed, routed tasks with seriality deps.
    #    Reads before any write have no deps (parallel-able). A write depends
    #    on the reads since the last write AND the previous write (serial
    #    chain — no two writes ever run concurrently). A read after a write
    #    (self-check) depends on that write.
    prev_write: Optional[str] = None
    pending_reads: List[str] = []
    step_names: List[str] = []
    first_exec: Optional[str] = None

    for step in steps:
        name = _step_name(step)
        step_names.append(name)
        if first_exec is None:
            first_exec = name
        if step.kind == WRITE:
            deps = list(pending_reads)
            if prev_write is not None:
                deps.append(prev_write)
            pending_reads = []
            prev_write = name
            ttype = T_WRITE
        else:
            deps = [prev_write] if prev_write is not None else []
            pending_reads.append(name)
            ttype = T_READ
        tasks.append(
            {
                "name": name,
                "type": ttype,
                "route": step.route,
                "description": step.description,
                "deps": deps,
            }
        )

    # 2. Verify spine. Tier-1 runs after every step executed; it is
    #    deterministic and local (zero tokens). Tier-2 (the model judge)
    #    depends on Tier-1 — it only runs when Tier-1 passed, exactly the
    #    loop's short-circuit. Both fail to `repair`.
    tasks.append(
        {
            "name": TIER1,
            "type": T_VERIFY,
            "tier": 1,
            "route": "local",
            "description": "Tier-1 deterministic checks (tests/lint/build), zero tokens",
            "deps": list(step_names),
            "on_pass": TIER2,
            "on_fail": REPAIR,
        }
    )
    tasks.append(
        {
            "name": TIER2,
            "type": T_VERIFY,
            "tier": 2,
            "route": "cloud",
            "description": "Tier-2 model/eval judge (only runs when Tier-1 passed)",
            "deps": [TIER1],
            "on_pass": "writeback",
            "on_fail": REPAIR,
        }
    )

    # 3. Repair task — the target of the verify fail edges. Its `retry` edge
    #    back to the first executable step is the ONE allowed cycle; it is not
    #    a `deps` edge, so the deps DAG stays acyclic.
    tasks.append(
        {
            "name": REPAIR,
            "type": T_REPAIR,
            "route": "local",
            "description": "Repair step; re-enters the plan on a verify failure",
            "deps": [],
            "retry": first_exec if first_exec is not None else TIER1,
        }
    )

    return {
        "name": contract.task_id,
        "version": WORKFLOW_VERSION,
        "inputs": inputs,
        "tasks": tasks,
    }


def emit_workflow(contract: TaskContract, steps: Optional[List[Step]] = None) -> str:
    """Emit a deterministic Conductor-style YAML workflow for a Task Contract.

    ``steps`` defaults to ``planner.plan(contract)`` so callers can emit
    straight from a contract. The output is stable: the same contract (and
    plan) always produces byte-identical YAML.
    """
    if steps is None:
        steps = _plan(contract)
    wf = build_workflow(contract, steps)
    return dump_yaml(wf)


# --------------------------------------------------------------------------
# Minimal, hand-rolled YAML emitter (stdlib only — NO pyyaml)
# --------------------------------------------------------------------------

def _escape(s: str) -> str:
    return (
        s.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\t", "\\t")
    )


def _unescape(s: str) -> str:
    out: List[str] = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            out.append(
                {"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(nxt, nxt)
            )
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _scalar_repr(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if v is None:
        return "null"
    return '"' + _escape(str(v)) + '"'


def _dump(value: Any, indent: int) -> List[str]:
    pad = "  " * indent
    lines: List[str] = []
    if isinstance(value, dict):
        for k, v in value.items():
            if isinstance(v, dict) and v:
                lines.append(f"{pad}{k}:")
                lines.extend(_dump(v, indent + 1))
            elif isinstance(v, list) and v:
                lines.append(f"{pad}{k}:")
                lines.extend(_dump(v, indent + 1))
            elif isinstance(v, dict):  # empty
                lines.append(f"{pad}{k}: {{}}")
            elif isinstance(v, list):  # empty
                lines.append(f"{pad}{k}: []")
            else:
                lines.append(f"{pad}{k}: {_scalar_repr(v)}")
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                item_lines = _dump(item, indent + 1)
                # Move the first key up onto the dash line.
                first = item_lines[0].lstrip()
                lines.append(f"{pad}- {first}")
                lines.extend(item_lines[1:])
            elif isinstance(item, list):
                # Nested bare lists are not emitted by this schema.
                lines.append(f"{pad}-")
                lines.extend(_dump(item, indent + 1))
            else:
                lines.append(f"{pad}- {_scalar_repr(item)}")
    return lines


def dump_yaml(wf: Dict[str, Any]) -> str:
    """Serialise a workflow dict to deterministic YAML (trailing newline)."""
    return "\n".join(_dump(wf, 0)) + "\n"


# --------------------------------------------------------------------------
# Minimal YAML parser — the exact inverse of what we emit
# --------------------------------------------------------------------------

def _scalar(text: str) -> Any:
    if text == "[]":
        return []
    if text == "{}":
        return {}
    if text in ("null", "~"):
        return None
    if text in ("true", "false"):
        return text == "true"
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        return _unescape(text[1:-1])
    try:
        return int(text)
    except ValueError:
        return text


def _lines(yaml_str: str) -> List[Tuple[int, str]]:
    out: List[Tuple[int, str]] = []
    for raw in yaml_str.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        out.append((indent, stripped))
    return out


def _parse_block(lines: List[Tuple[int, str]], i: int, indent: int) -> Tuple[int, Any]:
    if i >= len(lines):
        return i, None
    if lines[i][1].startswith("- "):
        return _parse_seq(lines, i, indent)
    return _parse_map(lines, i, indent)


def _parse_map(lines: List[Tuple[int, str]], i: int, indent: int) -> Tuple[int, Dict[str, Any]]:
    result: Dict[str, Any] = {}
    while i < len(lines) and lines[i][0] == indent and not lines[i][1].startswith("- "):
        key, _, rest = lines[i][1].partition(":")
        key = key.strip()
        rest = rest.strip()
        i += 1
        if rest == "":
            if i < len(lines) and lines[i][0] > indent:
                i, child = _parse_block(lines, i, lines[i][0])
                result[key] = child
            else:
                result[key] = None
        else:
            result[key] = _scalar(rest)
    return i, result


def _parse_seq(lines: List[Tuple[int, str]], i: int, indent: int) -> Tuple[int, List[Any]]:
    result: List[Any] = []
    while i < len(lines) and lines[i][0] == indent and lines[i][1].startswith("- "):
        item_text = lines[i][1][2:]
        if ":" in item_text and not (item_text.startswith('"')):
            # Mapping item: reconstruct as a mapping block at indent+2 covering
            # this line's content plus any deeper following lines.
            sub: List[Tuple[int, str]] = [(indent + 2, item_text)]
            j = i + 1
            while j < len(lines) and lines[j][0] >= indent + 2:
                sub.append(lines[j])
                j += 1
            _, item_val = _parse_block(sub, 0, indent + 2)
            result.append(item_val)
            i = j
        else:
            result.append(_scalar(item_text))
            i += 1
    return i, result


def parse_workflow(yaml_str: str) -> Dict[str, Any]:
    """Parse a workflow YAML string emitted by ``emit_workflow`` back to a dict.

    Minimal by design: it understands exactly the subset this module emits
    (2-space indent, quoted strings, bare ints/bools, block maps and
    sequences). It is the round-trip inverse of ``dump_yaml``.
    """
    lines = _lines(yaml_str)
    if not lines:
        return {}
    _, val = _parse_block(lines, 0, 0)
    return val if isinstance(val, dict) else {}


# --------------------------------------------------------------------------
# Structural validation
# --------------------------------------------------------------------------

def validate_workflow(wf: Dict[str, Any]) -> Dict[str, Any]:
    """Structurally validate an (emitted or parsed) workflow.

    Returns ``{"ok": bool, "issues": [str, ...]}``. Checks:
      - top-level ``name`` and a non-empty ``tasks`` list;
      - every task has a ``name``, a known ``type`` and a ``route``;
      - all ``deps`` reference existing tasks;
      - write tasks are serially ordered (each write depends on the previous
        write — no concurrent writers);
      - the verify/repair spine is present (Tier-1 → Tier-2 with ``on_fail``
        edges to a ``repair`` task);
      - the ``deps`` graph is acyclic (the repair ``retry`` back-edge, the one
        intentional cycle, is not a dep and is excluded).
    """
    issues: List[str] = []

    if not isinstance(wf, dict):
        return {"ok": False, "issues": ["workflow is not a mapping"]}
    if not wf.get("name"):
        issues.append("missing top-level 'name'")
    tasks = wf.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return {"ok": False, "issues": issues + ["missing or empty 'tasks'"]}

    names: List[str] = []
    by_name: Dict[str, Dict[str, Any]] = {}
    valid_types = {T_READ, T_WRITE, T_VERIFY, T_REPAIR}
    valid_routes = {"local", "cloud"}

    for idx, t in enumerate(tasks):
        if not isinstance(t, dict):
            issues.append(f"task[{idx}] is not a mapping")
            continue
        name = t.get("name")
        if not name:
            issues.append(f"task[{idx}] missing 'name'")
            name = f"<{idx}>"
        if name in by_name:
            issues.append(f"duplicate task name {name!r}")
        names.append(name)
        by_name[name] = t
        if t.get("type") not in valid_types:
            issues.append(f"task {name!r} has invalid/missing type {t.get('type')!r}")
        if t.get("route") not in valid_routes:
            issues.append(f"task {name!r} has invalid/missing route {t.get('route')!r}")
        deps = t.get("deps", [])
        if not isinstance(deps, list):
            issues.append(f"task {name!r} 'deps' is not a list")

    name_set = set(names)

    # deps must reference existing tasks.
    for name, t in by_name.items():
        for d in t.get("deps", []) or []:
            if d not in name_set:
                issues.append(f"task {name!r} depends on unknown task {d!r}")

    # Serial writes: each write depends on the previous write.
    write_names = [n for n in names if by_name.get(n, {}).get("type") == T_WRITE]
    for a, b in zip(write_names, write_names[1:]):
        if a not in (by_name[b].get("deps", []) or []):
            issues.append(
                f"write task {b!r} is not serialized after {a!r} (missing dep)"
            )

    # Verify/repair spine.
    t1 = by_name.get(TIER1)
    t2 = by_name.get(TIER2)
    rep = by_name.get(REPAIR)
    if t1 is None:
        issues.append(f"missing Tier-1 verify task {TIER1!r}")
    elif t1.get("on_fail") != REPAIR:
        issues.append(f"{TIER1!r} missing on_fail -> {REPAIR!r} edge")
    if t2 is None:
        issues.append(f"missing Tier-2 verify task {TIER2!r}")
    else:
        if t2.get("on_fail") != REPAIR:
            issues.append(f"{TIER2!r} missing on_fail -> {REPAIR!r} edge")
        if TIER1 not in (t2.get("deps", []) or []):
            issues.append(f"{TIER2!r} must depend on {TIER1!r} (Tier-1 gates Tier-2)")
    if rep is None:
        issues.append(f"missing repair task {REPAIR!r}")

    # deps graph must be acyclic (retry back-edges excluded — they are not deps).
    if _has_cycle(by_name):
        issues.append("dependency graph has a cycle (outside the repair edge)")

    return {"ok": not issues, "issues": issues}


def _has_cycle(by_name: Dict[str, Dict[str, Any]]) -> bool:
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {n: WHITE for n in by_name}

    def visit(n: str) -> bool:
        color[n] = GRAY
        for d in by_name.get(n, {}).get("deps", []) or []:
            if d not in color:
                continue
            if color[d] == GRAY:
                return True
            if color[d] == WHITE and visit(d):
                return True
        color[n] = BLACK
        return False

    return any(color[n] == WHITE and visit(n) for n in by_name)


# --------------------------------------------------------------------------
# Optional real-Conductor backend (pluggable; skipped cleanly when absent)
# --------------------------------------------------------------------------

def conductor_available() -> bool:
    """True iff the real Microsoft Conductor package is importable.

    This is the pluggable production backend. We NEVER pip install it; when it
    is not present the emitted workflow is validated by our own structural
    checks only.
    """
    try:
        import conductor  # noqa: F401  (microsoft/conductor)

        return True
    except Exception:
        return False


def try_conductor_validate(wf: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Validate against a real Conductor install if one is present.

    Returns ``None`` when Conductor is not installed (skip cleanly) so callers
    fall back to ``validate_workflow``. When present, best-effort routes the
    workflow through Conductor's own validator and reports the outcome.
    """
    if not conductor_available():
        return None
    try:
        import conductor  # type: ignore

        validate = getattr(conductor, "validate_workflow", None)
        if callable(validate):
            res = validate(wf)
            return {"ok": bool(res), "backend": "conductor"}
        return {"ok": True, "backend": "conductor", "note": "no validator symbol"}
    except Exception as exc:  # pragma: no cover - depends on external lib
        return {"ok": False, "backend": "conductor", "error": repr(exc)}
