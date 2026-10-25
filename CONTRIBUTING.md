# Contributing to SC Prism

Thanks for looking. SC Prism is maintained by one person, so the most useful
contributions are small, verified, and explained.

## Before you start

- **Bugs**: open an issue with what you did, what you expected, what happened,
  and your macOS version. A failing test beats a description.
- **Features**: open an issue first and say what problem it solves. The project
  says no to a lot. The answer is often "yes, but smaller".
- **Security problems**: never in a public issue — see [SECURITY.md](SECURITY.md).

## Making a change

1. Set up the build: [BUILDING.md](BUILDING.md).
2. Make the change on a branch.
3. Leave `./verify.sh` ending in the literal line `VERIFY: PASS`. Run
   `./scripts/bootstrap-toolchains.sh` first, otherwise the Rust and Go steps skip.
4. Open a pull request against `main`. Every change to `main` is reviewed and
   approved by the maintainer before it merges.

## What a change has to meet

These are the project's standards, not style preferences. A pull request that
misses one will be asked to change.

- **Tests first for behaviour.** A bug fix comes with a test that fails without
  the fix. Say in the PR that you watched it fail.
- **The interface never invents.** A number, a status, a seat or an action on
  screen must come from a real record: an engine span, a verdict, a file. If the
  data doesn't exist, the screen says so instead of filling the gap.
- **A model never orchestrates models.** Deterministic code decides who acts,
  in what order, with what permission. Don't route a decision through an LLM
  that code can make.
- **Claims are demonstrable.** Documentation describes something as built only
  when it can be shown working. If it's designed but not built, say so.
- **Gates stay gates.** The privacy floor, the destructive-command denylist, the
  approval gate and the tool-generation gates are not to be weakened for
  convenience. A change that touches one needs a test proving it still refuses
  what it refused before.

`CLAUDE.md` lists the invariants in one place. It's written for AI coding agents,
and it applies to people too.

## Licence

SC Prism is licensed under the [Apache License 2.0](LICENSE). Under section 5 of
that licence, any contribution you submit for inclusion is licensed on the same
terms, with no additional conditions.
