# Skill library + performance tracker — design

**Date:** 2026-07-16 (overnight, autonomous per Sukhdeep's directive; decisions documented here for his morning review) · **Roadmap:** #5

## Problem + ground truth

Sukhdeep's vision: repeatedly-used skills live in a universal library "where it sits always"; a tracker records how each skill performed; underperformers get improved from real usage. Extraction found: (a) the library is ALREADY universal (one global `scprism.skills` list — but app-local: localStorage, not the portable vault); (b) zero usage/performance data exists (`StoredSkill.usage` is never written); (c) **the engine's disclosure machinery is dead in real runs** — the client never passes a `skill_catalog`, so `disclose()` always sees `[]`, `Verdict.disclosed` is always empty, and disclosed skill *bodies* are discarded even in tests (recorded, never injected). Skills reach the model only as one-line charter text.

A tracker keyed on `Verdict.disclosed` today would be a vanity metric over a dead pipe. v1 therefore has three legs, in dependency order: make the library durable in the vault → make disclosure real (skills actually reach task prompts, attributably) → track and improve.

## Design

### 1. The vault IS the library ("where it sits always")
User-created/edited skills are written through to `<vault>/skills/<slug>.md` (frontmatter: `name`/`description`/`when_to_use`; body = the SKILL.md procedure) via the existing `writeVaultNote` — the same format `parseVaultSkill`/`syncVaultSkills` already round-trips. `create()`/`update()`/`remove()` gain a native-only vault write-through (localStorage remains the cache + the browser story; the vault copy is the durable, portable truth). Deterministic path `skills/<name-slug>.md`; deletes remove the file (existing `deleteVaultFile`). Provenance stays as-is ('vault' skills already originate there).

### 2. Real disclosure (engine)
- New `engine/scprism_engine/skills.py`: `load_vault_skill_catalog(vault) -> List[CatalogEntry]` — scans `<vault>/skills/*.md` (bounded: ≤100 files, ≤32KB each), parses the same frontmatter, builds `CatalogEntry(name, triggers, instructions=body, summary=description)`. **Triggers** = the `when_to_use` line split on commas/newlines (each phrase one trigger; existing word-subset matching applies) + the name itself.
- `loop.run` callers pass it: `_cmd_run` and `_cmd_project`/`run_project` build the catalog from the vault and pass `skill_catalog=...` (a `--no-skills` CLI flag opts out). Team runs keep the charter-line mechanism (cut for v1).
- **Disclosure becomes real, not decorative:** the loop currently records disclosed names and discards the instructions. Add the injection: after `disclose(...)`, the top 3 matches (by trigger specificity: most matched-trigger words wins; ties by catalog order), capped at 4000 chars total, are appended to the model context for the run as a clearly-labeled block (`Relevant saved skills — follow the matching procedure:` + per-skill name + instructions). The implementer finds the exact context seam the loop already uses (memory/context injection or the dispatch prompt assembly) and records what was injected honestly (the existing `disclosed` names list is the attribution record; the memory-budget assert must not be tripped — the skill block is separately capped, documented). Single-task (`run`) and project modes both get this.

### 3. Tracker (client)
- `mapVerdict` maps the engine's `timestamp` (already on the wire, currently dropped) onto the client Verdict as `at?: string`.
- New pure `src/lib/skillStats.ts`: `skillStats(verdicts, skills)` → per skill `{ uses, passes, passRate, lastUsedAt ('' when never), underperforming }` where uses = verdicts whose `native.disclosed` includes the skill name (case-insensitive trim), and `underperforming = uses >= 3 && passRate < 0.5`.
- Skills page: each card gains a stats line (`{uses} uses · {passRate}% pass · last {rel-time}`; nothing when 0 uses — the hiding rule) and an amber `underperforming` badge; the drawer shows the same plus the last 3 run outcomes (task text + pass/fail) for that skill.
- The dead `StoredSkill.usage` string field is retired from display (superseded by real stats; field kept for shape back-compat).

### 4. Improve-from-usage (gated)
On an underperforming skill, the drawer offers **"Draft improvement with AI"**: one real completion (the setup-interview chat helper pattern) sending the skill body + its last ≤3 failing runs' task texts, asking for a revised SKILL.md body; the draft renders side-by-side with **Apply** (calls `update()` → also vault write-through) or **Discard**. No auto-apply, ever.

## Discovered during build (honest gap, deferred)

S2 found that **memory injection was also decorative**: `select_context`'s output was recorded on the span/Verdict but never reached model prompts. The skills block now has a real model-facing channel (doer prompts only — deliberately NOT the Tier-2 judge, to avoid biasing evaluation); memory still doesn't, because routing it in would change every memory-bearing run and is out of this feature's scope. Queued for the minor-debt sweep / its own slice.

## Final-review findings (2026-07-16, adversarial 4-lens + skeptic)

6 raw findings, 3 refuted as non-defects (disclosure-ranking uses a pre-existing `disclose()` behavior untouched here; offline-stub judge echo is test-mode only; dead `usage` field pre-existed). 3 confirmed:
- **Important — slug-collision vault-file clobber (FIXED):** two distinct skills whose names differ only by punctuation/spacing collapsed to one `skills/<slug>.md`, so create/persist/delete of one could silently overwrite or delete the other's durable file (imported-file variant was unrecoverable). Closed with a create()-time collision guard that assigns a distinct hashed `sourcePath` when the canonical path is already owned.
- **Minor — loader symlink containment (FIXED):** the engine skill loader followed symlinks with no containment, so a crafted `skills/*.md` symlink to e.g. `~/.ssh/id_rsa` could inject key material into the doer prompt. Closed by rejecting symlinks / out-of-vault realpaths (mirrors project.py's boundary).
- **Minor — loop-run disclosed skills uncounted (DEFERRED → roadmap #10):** `/loop` step verdicts land in `state.loop.verdicts`, which the tracker (reading `state.verdicts`) doesn't fold in, so skills disclosed only during loop runs show 0 uses. Not a wrong number — an undercount from one pipe. Deferred because the fix is ordering-sensitive (merging two newest-first verdict streams) and lower risk to do deliberately in the minor-debt sweep.

## Cuts

Team-run catalog disclosure (charter lines remain); per-project skill scoping (library is universal by design); auto-improvement without a click; engine-side stats aggregation; retiring the charter one-liners (kept — they cover the chat path); Rust changes (none needed — vault-side discovery).

## Testing

- Engine: catalog loader (frontmatter/caps/malformed files skipped with reason), trigger derivation, disclosure injection (fake model asserts the skills block reaches the prompt; cap respected; `disclosed` names recorded in the Verdict — an end-to-end offline test with a real vault skill file), `--no-skills` opt-out, existing suites untouched.
- Client: skillStats pure tests (attribution matching, pass-rate, underperforming threshold, empty states); mapVerdict `at` defensive; vault write-through unit-testable parts (slug/path/frontmatter serializer pure + tested; the native write path gated as usual).
- Boundary: page/drawer UI native-thin (tsc + suite); improve-flow manual.

## Acceptance

Create a skill in the app → `skills/<slug>.md` appears in the vault → run a task whose intent matches the skill's when-to-use → the run's Verdict lists the skill in `disclosed`, and the model's prompt demonstrably contained the procedure (engine test; in-app: the skill's stats line shows 1 use) → after 3+ matching runs the pass-rate renders; force failures → `underperforming` badge → "Draft improvement" produces an editable draft; Apply updates the vault file. `verify.sh` PASS; all existing flows byte-identical with `--no-skills` semantics preserved for non-matching runs.
