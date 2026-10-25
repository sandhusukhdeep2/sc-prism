"""Planner — deterministic decomposition of a TaskContract into Steps.

`plan(contract)` breaks the intent into ordered Steps, each tagged read-only
or write. `route(step)` decides local vs cloud by (a) sensitivity keywords —
anything touching passwords / customer data / auth stays LOCAL — and (b)
reasoning load. This is deterministic code: no model decides the plan.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import List

from .contract import TaskContract
from .gateway import SENSITIVE_KEYWORDS, sensitive_hit  # noqa: F401 (re-export)

# Keywords that force a step to run on a LOCAL model regardless of load.
# Sensitive data must never leave the machine.
#
# The list AND the matching rule now come from ``gateway`` (2026-08-17). This
# module used to keep its own near-copy of the list and match it with plain
# substring containment, so a plan step could be forced local by "prodigy" or
# "authentic" while the gateway made a different call on the very same words.
# One list, one word-aware rule (``gateway.sensitive_hit``), no drift.
# ``SENSITIVE_KEYWORDS`` stays importable from here for existing callers.

# Keywords hinting at heavy reasoning that (absent sensitivity) benefit from
# a larger cloud model.
HEAVY_KEYWORDS = (
    "architect",
    "design",
    "refactor",
    "algorithm",
    "concurrency",
    "distributed",
    "optimize",
    "optimise",
    "security",
    "cryptograph",
    "proof",
    "migrate",
)

LOCAL = "local"
CLOUD = "cloud"

READ = "read"
WRITE = "write"


@dataclass
class Step:
    """A single planned step.

    Attributes:
        index: Position in the plan (0-based).
        description: What this step does.
        kind: 'read' (may run concurrently) or 'write' (strictly serial).
        route: 'local' or 'cloud' (filled by `route`, cached on the Step).
        reason: Why this route was chosen (audit trail).
    """

    index: int
    description: str
    kind: str = READ
    route: str = LOCAL
    reason: str = ""

    @property
    def is_write(self) -> bool:
        return self.kind == WRITE

    def to_dict(self) -> dict:
        return asdict(self)


def _looks_like_write(intent: str) -> bool:
    mutating = (
        "add",
        "create",
        "implement",
        "write",
        "fix",
        "update",
        "refactor",
        "remove",
        "delete",
        "rename",
        "guard",
        "patch",
    )
    lower = intent.lower()
    return any(w in lower for w in mutating)


def plan(contract: TaskContract) -> List[Step]:
    """Decompose a contract into an ordered list of Steps.

    The shape is deterministic: understand (read) -> locate (read) ->
    [implement (write) if the contract is write-mode] -> self-check (read).
    Write steps are only emitted when the contract mode is 'write' and the
    intent looks mutating.
    """
    intent = contract.intent
    steps: List[Step] = []

    # A CONVERSATION IS ONE REPLY. The code-task shape below (and even the
    # steps=1 findings step) frames the dispatch as producing work-product,
    # which is how a chat turn ended up walking understand -> locate ->
    # findings and handing the judge a trajectory that read as an aborted
    # build. A converse contract always plans the single reply step — whatever
    # the caller set steps to, and however mutating the wording sounds
    # ("Create a wordpress theme ..." is a thing SAID, not a thing to do yet).
    if contract.mode == "converse":
        return [
            Step(
                index=0,
                description=f"Reply to: {intent}",
                kind=READ,
            )
        ]

    # ONE STEP, WHEN THE CALLER ASKS FOR ONE. The default shape below is a
    # code-task plan — understand, then locate, then produce — and every step
    # runs its own tool loop with its own turn budget, so a task that needs to
    # read two notes reads them three times over. That is correct for "change
    # this repo" and ruinous for "check in and do one small thing": the
    # companion wake spent fifteen minutes and seventy thousand tokens per hour
    # doing the same research three times and returning "I ran out of tool
    # turns", having never once completed.
    if getattr(contract, "steps", None) == 1:
        return [
            Step(
                index=0,
                description=(
                    f"Implement: {intent}"
                    if contract.mode == WRITE and _looks_like_write(intent)
                    else f"Produce read-only findings for: {intent}"
                ),
                kind=WRITE if (contract.mode == WRITE and _looks_like_write(intent)) else READ,
            )
        ]

    steps.append(
        Step(index=0, description=f"Understand requirement: {intent}", kind=READ)
    )
    steps.append(
        Step(
            index=1,
            description=f"Locate relevant code/scope for: {intent}",
            kind=READ,
        )
    )

    if contract.mode == WRITE and _looks_like_write(intent):
        steps.append(
            Step(
                index=2,
                description=f"Implement change: {intent}",
                kind=WRITE,
            )
        )
        steps.append(
            Step(
                index=3,
                description="Self-check the change against acceptance criteria",
                kind=READ,
            )
        )
    else:
        steps.append(
            Step(
                index=2,
                description=f"Produce read-only findings for: {intent}",
                kind=READ,
            )
        )

    # Route every step deterministically.
    for step in steps:
        route(step)

    return steps


def route(step: Step) -> Step:
    """Decide local vs cloud for a step, mutating and returning it.

    Precedence:
      1. Sensitivity — any sensitive keyword forces LOCAL.
      2. Reasoning load — heavy keywords go CLOUD.
      3. Default — LOCAL (cheap, zero egress).
    """
    text = step.description.lower()

    hit = sensitive_hit(text)
    if hit:
        step.route = LOCAL
        step.reason = f"sensitive keyword '{hit}' -> keep local (no egress)"
        return step

    heavy = next((k for k in HEAVY_KEYWORDS if k in text), None)
    if heavy:
        step.route = CLOUD
        step.reason = f"heavy reasoning keyword '{heavy}' -> cloud"
        return step

    step.route = LOCAL
    step.reason = "default -> local (cheap, zero egress)"
    return step
