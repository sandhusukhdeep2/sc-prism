"""A2A serialisation seam (specs/11 §3, ADR-015).

SC Prism keeps single-agent as the default, but every handoff artifact is
serialisable to the open Agent-to-Agent standard (v1.0, Linux Foundation) so
activating true multi-agent later is a format no-op, not a retrofit:

  * an agent's capabilities  -> **Agent Card**
  * a Task Contract          -> **Task**
  * a team-board relay entry -> **Message** (typed text part)
  * a Verdict / synthesis    -> **Artifact** (typed data part)

Pure stdlib serialisers + a schema-lite validator. Inputs may be the engine's
dataclasses or plain dicts (everything is read via a tolerant getter), so the
seam works on live objects and on persisted JSON alike.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, List, Optional

A2A_PROTOCOL_VERSION = "1.0"


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Field access that works for dataclasses and dicts."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _stable_id(*parts: str) -> str:
    return hashlib.sha256("·".join(parts).encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Serialisers
# ---------------------------------------------------------------------------

def agent_card(
    name: str,
    description: str,
    provider: str,
    skills: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """A2A Agent Card — a JSON advertisement of what an agent can do."""
    return {
        "protocolVersion": A2A_PROTOCOL_VERSION,
        "name": name,
        "description": description,
        "version": "1",
        "capabilities": {"streaming": False, "pushNotifications": False},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain", "application/json"],
        "skills": skills
        or [
            {
                "id": f"{provider}-completion",
                "name": f"{provider} completion",
                "description": description,
            }
        ],
        "metadata": {"provider": provider},
    }


def task_from_contract(contract: Any, state: str = "submitted") -> Dict[str, Any]:
    """A2A Task from a Task Contract — the unit of delegated work."""
    task_id = str(_get(contract, "task_id", "") or "")
    return {
        "id": task_id or _stable_id(str(_get(contract, "intent", ""))),
        "contextId": task_id or "standalone",
        "status": {"state": state},
        "metadata": {
            "intent": _get(contract, "intent", ""),
            "acceptanceCriteria": list(_get(contract, "acceptance_criteria", []) or []),
            "scope": list(_get(contract, "scope", []) or []),
            "readOnly": _get(contract, "mode", None) == "read"
            or bool(_get(contract, "read_only", False)),
            "tokenBudget": _get(contract, "token_budget", 0),
            "maxTurns": _get(contract, "max_turns", 0),
            "requesterRole": _get(contract, "requester_role", ""),
        },
    }


def message_from_board(entry: Any, task_id: str) -> Dict[str, Any]:
    """A2A Message from one team-board relay entry (sender/provider/content)."""
    sender = str(_get(entry, "from", None) or _get(entry, "sender", "") or "")
    content = str(_get(entry, "content", "") or "")
    return {
        "role": "agent",
        "messageId": _stable_id(task_id, sender, str(_get(entry, "round", 0)), content),
        "taskId": task_id,
        "contextId": task_id,
        "parts": [{"kind": "text", "text": content}],
        "metadata": {
            "sender": sender,
            "provider": _get(entry, "provider", ""),
            "model": _get(entry, "model", ""),
            "round": _get(entry, "round", 0),
            "isReal": bool(_get(entry, "is_real", False)),
        },
    }


def artifact_from_verdict(verdict: Any) -> Dict[str, Any]:
    """A2A Artifact from a Verdict — the output of a Task (the audit spine)."""
    task_id = str(_get(verdict, "task_id", "") or "")
    data = verdict.to_dict() if hasattr(verdict, "to_dict") else dict(verdict)
    return {
        "artifactId": _stable_id("verdict", task_id, str(_get(verdict, "timestamp", ""))),
        "name": f"verdict-{task_id}" if task_id else "verdict",
        "description": "SC Prism Verdict (Tier-1 + Tier-2 outcome)",
        "parts": [{"kind": "data", "data": data}],
        "metadata": {"passed": bool(_get(verdict, "passed", False))},
    }


def artifact_from_text(name: str, text: str, task_id: str = "") -> Dict[str, Any]:
    """A2A Artifact wrapping plain text (e.g. a team lead's synthesis)."""
    return {
        "artifactId": _stable_id("text", name, task_id, text[:200]),
        "name": name,
        "description": "text artifact",
        "parts": [{"kind": "text", "text": text}],
        "metadata": {},
    }


# ---------------------------------------------------------------------------
# Schema-lite validation
# ---------------------------------------------------------------------------

_REQUIRED: Dict[str, Dict[str, type]] = {
    "agent_card": {
        "protocolVersion": str,
        "name": str,
        "description": str,
        "version": str,
        "capabilities": dict,
        "skills": list,
    },
    "task": {"id": str, "contextId": str, "status": dict, "metadata": dict},
    "message": {"role": str, "messageId": str, "taskId": str, "parts": list},
    "artifact": {"artifactId": str, "name": str, "parts": list},
}

_PART_KINDS = ("text", "data", "file")


def validate(kind: str, obj: Any) -> List[str]:
    """Return a list of problems (empty == valid) for an A2A object."""
    problems: List[str] = []
    required = _REQUIRED.get(kind)
    if required is None:
        return [f"unknown A2A kind: {kind}"]
    if not isinstance(obj, dict):
        return [f"{kind} must be an object"]
    for key, typ in required.items():
        if key not in obj:
            problems.append(f"{kind}.{key} missing")
        elif not isinstance(obj[key], typ):
            problems.append(f"{kind}.{key} must be {typ.__name__}")
    if kind == "task" and isinstance(obj.get("status"), dict):
        if not obj["status"].get("state"):
            problems.append("task.status.state missing")
    if kind == "message" and obj.get("role") not in ("user", "agent"):
        problems.append("message.role must be 'user' or 'agent'")
    for part in obj.get("parts", []) if isinstance(obj.get("parts"), list) else []:
        if not isinstance(part, dict) or part.get("kind") not in _PART_KINDS:
            problems.append(f"{kind}.parts entries need kind in {_PART_KINDS}")
            break
        if part["kind"] == "text" and not isinstance(part.get("text"), str):
            problems.append(f"{kind} text part needs a string 'text'")
            break
        if part["kind"] == "data" and not isinstance(part.get("data"), dict):
            problems.append(f"{kind} data part needs an object 'data'")
            break
    return problems


def team_bundle(result: Any, agents: Any, intent: str) -> Dict[str, Any]:
    """Serialise a whole team run as one portable A2A document.

    Agent cards + the Task + every board Message + the synthesis Artifact —
    written next to the board jsonl so any A2A consumer can replay the run.
    """
    run_id = str(_get(result, "run_id", "") or "")
    task = task_from_contract(
        {"task_id": run_id, "intent": intent}, state="completed"
    )
    board = _get(result, "board", []) or []
    return {
        "protocolVersion": A2A_PROTOCOL_VERSION,
        "agents": [
            agent_card(
                name=str(_get(a, "name", "")),
                description=str(_get(a, "role", "")),
                provider=str(_get(a, "primary", "")),
            )
            for a in agents
        ],
        "task": task,
        "messages": [message_from_board(m, task["id"]) for m in board],
        "artifacts": [
            artifact_from_text(
                "synthesis", str(_get(result, "synthesis", "") or ""), task["id"]
            )
        ],
    }
