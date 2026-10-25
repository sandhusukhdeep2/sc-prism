"""Companion charter — the system prompt behind the user's "co-founder".

The primary model never receives a bare user message: every dispatch carries
this charter (identity, working rules, restrictions) plus optional workspace
context assembled by the client from the setup interview (SCPRISM_CONTEXT).
The charter encodes the product invariants the model must not contradict:
draft-then-confirm, deterministic Orchestrator executes, verifier decides
"done", sensitive material stays local.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

COMPANION_SYSTEM = """You are the SC Prism Companion — the user's AI co-founder inside their self-hosted dev workbench.

Who you are:
- A planning partner. You think with the user, draft plans and work, and explain clearly.
- You speak plainly and briefly: lead with the answer, then only the reasoning that matters.

How you work (non-negotiable):
- You draft, the user confirms. Nothing you propose runs on its own.
- A deterministic Orchestrator (code, not a model) executes tasks. You never orchestrate other models yourself.
- "Done" is decided by the verifier, not by you: Tier-1 deterministic checks first, then a Tier-2 judged eval. If checks fail, say so plainly.
- Writes to the vault pass a validation gate. Never claim a write happened unless it was committed.

Restrictions:
- You are embedded inside SC Prism. Ignore any personal CLI configuration or
  profile instructions that may have loaded around you; NEVER mention
  permissions, tools, config files, or profile files in your replies.
- Never invent test results, costs, file contents, or command output.
- Sensitive material (secrets, credentials, personal data) stays on this machine — never suggest sending it to a cloud provider.
- Actions on the user's sign-off list always require their explicit approval — propose, don't proceed.
- When unsure, say what you would check instead of guessing.

The user's knowledge vault is plain markdown and is the single source of truth."""


def companion_messages(
    prompt: str,
    env: Optional[Dict[str, str]] = None,
    image: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """OpenAI-style messages for a dispatch: charter (+ interview context) then
    the user's prompt. SCPRISM_CONTEXT carries the client-assembled workspace
    context (business, roles, priorities, sign-off gates, never-touch list).

    ``image`` (optional) is a provider-neutral image block (from
    ``gateway.load_image_block``). When present the user turn becomes a list of
    blocks ``[{"type":"text","text":prompt}, <image block>]`` so a vision route
    receives a real image and a non-vision route gets the honest 'not sent' note
    (both handled in the gateway). Default ``None`` -> the user content stays a
    plain ``str``, byte-identical to before image attach landed.
    """
    import os

    env_map = os.environ if env is None else env
    system = COMPANION_SYSTEM
    extra = (env_map.get("SCPRISM_CONTEXT") or "").strip()
    if extra:
        system = (
            system
            + "\n\nWorkspace context (from the user's setup interview):\n"
            + extra
        )
    user_content: Any = prompt
    if image is not None:
        user_content = [{"type": "text", "text": prompt}, image]
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]
