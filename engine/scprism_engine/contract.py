"""TaskContract — the deterministic unit of work handed to the Orchestrator.

A contract is a plain data record. It carries the *intent*, the
*acceptance_criteria* the Verifier will judge against, the *scope* of files
the work may touch, the *mode* (read vs write), and hard budgets. No model
input is trusted here: `parse`/`validate` are deterministic.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field, asdict
from typing import List, Optional

Mode = str  # 'read' | 'write' | 'converse'

_VALID_MODES = ("read", "write", "converse")


class ContractError(ValueError):
    """Raised when a TaskContract fails validation."""


@dataclass
class TaskContract:
    """A single task to orchestrate.

    Attributes:
        task_id: Stable identifier (used as the verdict filename).
        intent: Natural-language description of what to accomplish.
        acceptance_criteria: List of human/deterministic criteria the
            verifier judges against.
        scope: List of paths/globs the task is allowed to touch.
        mode: 'read' (no mutation), 'write' (may mutate), or 'converse' (a
            chat turn — the reply IS the deliverable; only ever explicit,
            never inferred).
        token_budget: Hard cap on tokens the dispatch phase may spend.
        max_turns: Hard cap on dispatch iterations.
        steps: Plan this many steps instead of the default shape. Only 1 is
            special (a single findings step); None keeps the deterministic
            understand -> locate -> findings/implement plan unchanged.
    """

    task_id: str
    intent: str
    acceptance_criteria: List[str] = field(default_factory=list)
    scope: List[str] = field(default_factory=list)
    mode: Mode = "write"
    token_budget: int = 100_000
    max_turns: int = 8
    # A ONE-STEP TASK (2026-08-27). The default plan is a code-task shape —
    # understand, locate, then produce — and each step runs its OWN tool loop
    # with its own turn budget. That is right for "change this repo" and wrong
    # for "check in on my business and do one small thing": the companion wake
    # did the same research three times over, spent its turns in each, and
    # returned "I ran out of tool turns" after fifteen minutes, every hour,
    # having never once completed. Set to 1 to plan a single step.
    steps: Optional[int] = None

    def validate(self) -> "TaskContract":
        """Return self if valid, else raise ContractError."""
        if not self.task_id or not str(self.task_id).strip():
            raise ContractError("task_id must be non-empty")
        if not self.intent or not str(self.intent).strip():
            raise ContractError("intent must be non-empty")
        if self.mode not in _VALID_MODES:
            raise ContractError(
                f"mode must be one of {_VALID_MODES}, got {self.mode!r}"
            )
        if not isinstance(self.acceptance_criteria, list):
            raise ContractError("acceptance_criteria must be a list")
        if not isinstance(self.scope, list):
            raise ContractError("scope must be a list")
        if int(self.token_budget) <= 0:
            raise ContractError("token_budget must be positive")
        if int(self.max_turns) <= 0:
            raise ContractError("max_turns must be positive")
        if self.steps is not None and int(self.steps) <= 0:
            raise ContractError("steps must be positive when given")
        return self

    def to_dict(self) -> dict:
        return asdict(self)


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:40] or "task"


def parse(
    intent: str,
    *,
    task_id: Optional[str] = None,
    acceptance_criteria: Optional[List[str]] = None,
    scope: Optional[List[str]] = None,
    mode: Optional[Mode] = None,
    token_budget: int = 100_000,
    max_turns: int = 8,
    steps: Optional[int] = None,
) -> TaskContract:
    """Build and validate a TaskContract from a raw intent string.

    Deterministic: a missing task_id is derived from the intent slug plus a
    short uuid so runs are unique but readable. If `mode` is not given it is
    inferred — intents that read/inspect/analyze default to 'read', anything
    that mutates defaults to 'write'.
    """
    intent = (intent or "").strip()
    if task_id is None:
        task_id = f"{_slugify(intent)}-{uuid.uuid4().hex[:8]}"

    if mode is None:
        mode = _infer_mode(intent)

    if acceptance_criteria is None:
        # AFTER the mode is settled above — the criteria depend on it.
        acceptance_criteria = _default_criteria(intent, mode)

    contract = TaskContract(
        task_id=task_id,
        intent=intent,
        acceptance_criteria=acceptance_criteria,
        scope=scope or [],
        mode=mode,
        token_budget=token_budget,
        max_turns=max_turns,
        steps=steps,
    )
    return contract.validate()


_READ_VERBS = (
    "read",
    "inspect",
    "analyze",
    "analyse",
    "review",
    "audit",
    "explain",
    "summarize",
    "summarise",
    "list",
    "find",
    "search",
    "explore",
)


def _infer_mode(intent: str) -> Mode:
    first = intent.lower().split()
    if first and first[0] in _READ_VERBS:
        return "read"
    return "write"


def _default_criteria(intent: str, mode: Mode = "write") -> List[str]:
    """A minimal, deterministic acceptance-criteria stub, MATCHED TO THE MODE.

    Every run used to be judged against the write-mode pair below: repository
    checks passing, and "a plausible implementation of" the intent. For a task
    that changes a repository that is exactly right.

    For a READ task it is unmeetable by construction. A companion wake has no
    repository, runs no tests, and produces no change — so criterion one can
    never be satisfied (tier-1 is skipped, which the verdict reports as "nothing
    deterministic was verified") and criterion two asks whether a report is a
    plausible *implementation*, which it is not. The owner's wakes were doing the
    work asked of them and being graded 0.0175 for it, and his pass rate read 3%
    because most of what this app does is read-only.

    A read task's success is what a read task is for: answering the thing that
    was asked, from what was really there, and saying plainly when the answer is
    that nothing needed doing. Resting IS a real outcome — the companion charter
    says so — and a judge that cannot score it as one turns "nothing to do" into
    a failure every time the vault is quiet.

    A CONVERSE turn is the same lesson one seat over. The Work page's chat
    reached the engine with no kind at all, inferred "write", and a good reply
    — the right clarifying questions for "Create a wordpress theme like
    moppers slashcreative" — was graded as a build that produced no files:
    ~0 on acceptance and completion, outcome "failed", 3% pass on the team
    card. The judge was behaving correctly given wrong criteria. A chat turn's
    success is a reply that answers what was said, asks instead of guessing
    when it must, and claims nothing it did not do. Converse is only ever
    EXPLICIT (the chat path says so); `_infer_mode` stays a read/write
    question, so no task wording can wander into chat grading.
    """
    if mode == "converse":
        return [
            "tier1: not applicable — a conversational turn changes nothing, so "
            "there is nothing deterministic to verify",
            f"tier2: the reply is responsive to what was actually said: {intent}",
            "tier2: asking for genuinely missing information instead of guessing "
            "IS a complete turn — the right clarifying question passes",
            "tier2: the reply is honest — it claims no file, no check, and no "
            "fact it did not have",
        ]
    if mode == "read":
        return [
            "tier1: not applicable — a read-only task changes nothing, so there is "
            "nothing deterministic to verify",
            f"tier2: the reply answers, from evidence actually gathered: {intent}",
            "tier2: an honest 'nothing needed doing' IS a pass, when the reply says "
            "what was checked to reach it",
        ]
    return [
        "tier1: repository checks (tests/lint/build) pass",
        f"tier2: change is a plausible implementation of: {intent}",
    ]
