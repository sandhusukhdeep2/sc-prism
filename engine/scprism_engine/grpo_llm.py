"""Real neural GRPO backend — the compute-gated FINAL step (specs/10 §6).

``grpo.py`` proves the flywheel *mechanics* in pure stdlib with ``RoutePolicy``
(a softmax + REINFORCE update). THIS module proves the same mechanics with a
GENUINE neural update: a tiny causal LM whose token policy is moved by torch
autograd against the very same group-relative advantages ``grpo.py`` computes.

It is an honest, TINY, CPU proof of the mechanism — not a production fine-tune
of a real coding model. What is real here:

  * A real ``transformers`` causal LM (a tiny ``GPT2LMHeadModel``) with real
    parameters and a real optimizer.
  * A real GRPO update: for each ``(context, action)`` training record we take
    the LM's log-prob of the action's completion given the context prompt, form
    ``loss = -(advantage * logprob).mean()``, call ``loss.backward()`` and step
    the optimizer. Positive-advantage actions get their completion log-prob
    pushed UP; negative-advantage actions get it pushed DOWN. That is
    policy-gradient GRPO on a neural policy, end to end.
  * ``act`` derives the routing distribution (the same discrete ``local``/
    ``cloud`` decision set as ``RoutePolicy``) from a softmax over the LM's
    completion log-probs, so this policy satisfies the ``grpo.Policy`` protocol
    and plugs straight into ``GRPOTrainer`` and ``eval_lift_gate``.

HONESTY: the model is a few-thousand-parameter randomly-initialised GPT-2 with a
byte-level vocab, so NOTHING needs downloading and a full train+gate run finishes
in well under a second on a CPU. This proves the neural GRPO *update executes and
moves the policy per the reward advantages* — the flywheel turns — not that a
tiny random model has learned to code. The production path (a real base model,
GPU, Unsloth/trl) is the same update at scale.

Import-guarded: importing this module imports ``torch``/``transformers``. Callers
that must stay stdlib-only (the offline core, the 3.9 test suite) never import it
unless ``$SCPRISM_GRPO_LLM=1`` AND the heavy libs are present (see
``grpo.LLMPolicy`` / ``grpo._select_policy``).
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional, Sequence, Tuple

# Heavy deps — importing THIS module is the guard. Kept at module scope so an
# ImportError propagates to the caller's try/except (grpo.py routes around it).
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from transformers import GPT2Config, GPT2LMHeadModel  # noqa: E402

from . import grpo as _grpo

# Same discrete routing decision set as the stdlib reference policy so the two
# backends are interchangeable behind the Policy protocol.
DECISION_SET: Tuple[str, ...] = _grpo.DECISION_SET

# Byte-level vocab: every UTF-8 byte (0..255) is its own token, so short prompts
# like ``"test-gen -> local"`` encode with NO tokenizer files to download.
_VOCAB = 256


def llm_available() -> bool:
    """True — reaching here means torch + transformers already imported.

    A convenience for callers that imported this module inside a ``try`` and now
    want a boolean. (If the import failed they never get here.)
    """
    return True


def _encode(text: str, *, limit: int) -> List[int]:
    """Byte-level encode, truncated to ``limit`` tokens (context window)."""
    return list(text.encode("utf-8"))[:limit]


class LLMPolicy:
    """A REAL neural GRPO policy over a tiny causal LM (specs/10 §6).

    Satisfies the ``grpo.Policy`` protocol (``act`` / ``update`` / ``snapshot`` /
    ``restore``) so it drops into ``GRPOTrainer`` and ``eval_lift_gate`` exactly
    where ``RoutePolicy`` does — but every update is a genuine autograd step on
    the LM's parameters.

    The policy over the routing decision set is *induced* by the LM: for a
    context bucket ``c`` and action ``a`` the score is the LM's total log-prob of
    the completion ``" a"`` given the prompt ``"c ->"``; ``act`` is the softmax of
    those scores. Training a record with positive advantage raises the completion
    log-prob of the action it took, which raises that action's probability under
    ``act`` — the same flywheel as the stdlib policy, driven by a real network.
    """

    def __init__(
        self,
        model_name: str = "",
        *,
        env: Optional[Dict[str, str]] = None,
        actions: Sequence[str] = DECISION_SET,
        context_of=None,
        action_of=None,
        seed: int = 0,
        lr: float = 0.05,
        n_layer: int = 2,
        n_embd: int = 32,
        n_head: int = 2,
        n_positions: int = 64,
    ) -> None:
        self.model_name = model_name
        self.actions: Tuple[str, ...] = tuple(actions)
        self.context_of = context_of or _grpo.task_bucket
        self._action_of = action_of or (lambda r: _grpo.record_action(r, self.actions))
        self.seed = int(seed)
        self.lr = float(lr)
        self._cfg = dict(
            vocab_size=_VOCAB,
            n_positions=int(n_positions),
            n_ctx=int(n_positions),
            n_embd=int(n_embd),
            n_layer=int(n_layer),
            n_head=int(n_head),
            n_inner=int(n_embd * 2),
            bos_token_id=None,
            eos_token_id=None,
            # No dropout: a deterministic forward makes ``act``/``logprob``
            # reproducible and clones bit-identical (a tiny proof model does not
            # need regularisation).
            resid_pdrop=0.0,
            embd_pdrop=0.0,
            attn_pdrop=0.0,
        )

        # Deterministic tiny random-init model — NOTHING is downloaded.
        torch.manual_seed(self.seed)
        self.model = GPT2LMHeadModel(GPT2Config(**self._cfg))
        self.model.train()
        self.opt = torch.optim.Adam(self.model.parameters(), lr=self.lr)
        self.last_loss: Optional[float] = None

    # -- prompts ----------------------------------------------------------

    def _prompt_ids(self, context: str) -> List[int]:
        # Non-empty prompt guarantees a preceding position for the first
        # completion token's next-token prediction.
        return _encode(f"{context} ->", limit=self._cfg["n_positions"])

    def _completion_ids(self, action: str) -> List[int]:
        return _encode(f" {action}", limit=self._cfg["n_positions"])

    def completion_logprob(self, context: str, action: str) -> torch.Tensor:
        """LM's total log-prob of ``action``'s completion given ``context``.

        Returns a scalar tensor (grad-tracking) = Σ log p(token_t | prefix). This
        IS the neural policy's score for taking ``action`` in ``context``.
        """
        prompt = self._prompt_ids(context)
        comp = self._completion_ids(action)
        ids = torch.tensor([prompt + comp], dtype=torch.long)
        logits = self.model(ids).logits[0]  # [T, V]
        logprobs = F.log_softmax(logits, dim=-1)
        total = ids.new_zeros((), dtype=torch.float32).float()
        start = len(prompt)
        for pos in range(start, len(prompt) + len(comp)):
            tok = ids[0, pos]
            total = total + logprobs[pos - 1, tok]
        return total

    def logprob(self, context: str, action: str) -> float:
        """Detached float of ``completion_logprob`` — for assertions/metrics."""
        with torch.no_grad():
            return float(self.completion_logprob(context, action))

    # -- distribution (Policy protocol) ----------------------------------

    def act(self, context: str) -> Dict[str, float]:
        """Routing distribution induced by the LM (softmax over completion lp)."""
        with torch.no_grad():
            scores = {a: self.logprob(context, a) for a in self.actions}
        hi = max(scores.values())
        exps = {a: torch.tensor(v - hi).exp().item() for a, v in scores.items()}
        z = sum(exps.values()) or 1.0
        return {a: e / z for a, e in exps.items()}

    def prob(self, context: str, action: str) -> float:
        return self.act(context).get(action, 0.0)

    # -- the REAL GRPO update (Policy protocol) --------------------------

    def update(
        self,
        batch: Sequence[Dict[str, Any]],
        advantages: Sequence[float],
        lr: float,
    ) -> None:
        """One genuine neural GRPO step: ``loss = -(adv * logprob).mean()``.

        Builds the policy-gradient loss over every record with a non-zero
        advantage, backprops through the LM, and steps the optimizer. This is the
        real neural update — autograd moves the parameters so positive-advantage
        completions become more likely and negative-advantage ones less likely.
        """
        if len(batch) != len(advantages):
            raise ValueError(
                f"batch/advantages length mismatch: {len(batch)} != {len(advantages)}"
            )
        terms: List[torch.Tensor] = []
        for rec, adv in zip(batch, advantages):
            if adv == 0.0:
                continue  # no signal (singleton / zero-variance group)
            context = self.context_of(rec)
            action = self._action_of(rec)
            lp = self.completion_logprob(context, action)
            terms.append(-(float(adv) * lp))
        if not terms:
            return  # nothing to learn from this batch
        loss = torch.stack(terms).mean()
        for g in self.opt.param_groups:
            g["lr"] = float(lr)
        self.opt.zero_grad()
        loss.backward()
        self.opt.step()
        self.last_loss = float(loss.detach())

    # -- convenience metric ----------------------------------------------

    def expected_reward(self, records, **kwargs) -> float:
        """The module-level expected-reward metric, for this policy + records."""
        return _grpo.expected_reward(self, records, **kwargs)

    # -- versioning / rollback (Policy protocol) -------------------------

    def snapshot(self) -> Dict[str, Any]:
        state = {k: v.detach().cpu().tolist() for k, v in self.model.state_dict().items()}
        return {
            "kind": "llm-policy",
            "actions": list(self.actions),
            "seed": self.seed,
            "lr": self.lr,
            "config": dict(self._cfg),
            "state": state,
        }

    def restore(self, snapshot: Dict[str, Any]) -> None:
        self.actions = tuple(snapshot.get("actions", self.actions))
        sd = self.model.state_dict()
        for k, v in snapshot.get("state", {}).items():
            if k in sd:
                sd[k] = torch.tensor(v, dtype=sd[k].dtype)
        self.model.load_state_dict(sd)

    def clone(self) -> "LLMPolicy":
        """A deep copy with IDENTICAL weights — the baseline the gate compares to.

        Cloning (not re-initialising) is what makes the eval-lift gate fair: an
        untrained buckets stays bit-identical to the baseline, so it cannot
        spuriously 'regress'.
        """
        twin = LLMPolicy(
            self.model_name,
            actions=self.actions,
            context_of=self.context_of,
            action_of=self._action_of,
            seed=self.seed,
            lr=self.lr,
            n_layer=self._cfg["n_layer"],
            n_embd=self._cfg["n_embd"],
            n_head=self._cfg["n_head"],
            n_positions=self._cfg["n_positions"],
        )
        twin.model.load_state_dict(copy.deepcopy(self.model.state_dict()))
        return twin
