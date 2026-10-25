# Team / Host mode — solo developer, or a company on one shared server

**Status:** DRAFT for Sukhdeep's review · roadmap #8 · per ADR-029 this ships only after the solo spine is proven in daily use (the vault-digest build walk is that proof-in-progress).

**Sukhdeep's framing (2026-08-28, verbatim intent):** the app serves a solo developer who has a server with the application — OR a company: the company admin runs the application's server; other users create accounts under that company, get the admin's approval, and then access the company server. Everyone shares the same memory, behind filters that govern which private data flows where.

## The two answers to one new wizard question

The Welcome step gains the product's first real fork — before providers, because everything downstream depends on it:

> **Who is this for?**
> **Just me** — everything runs on this machine. My models, my vault, my rules. *(today's app, unchanged — stays the default and the alpha focus)*
> **My company** — I'm setting this up for a team. I'll host the server my teammates connect to.

"Just me" continues into the existing 6-step wizard untouched. "My company" continues into the same wizard **as the admin/host**, plus the hosting step below.

## Company mode — the shapes

**The host (company admin).** Runs the shared gateway — the same Bifrost + engine services the solo app already embeds (ADR-026 designed exactly this embedded-vs-remote split; the remote half finally earns its keep). The host machine owns:
- the **company vault** — the shared memory, one source of truth, same markdown + validation gate as today (ADR-014);
- the **provider keys** — members never hold company keys; the gateway holds them, exactly as the solo Gateway already does ("keys are held by the Gateway · never rendered");
- the **governance** — never-touch, always-ask gates, force-local sensitivity, compliance and verify commands are authored once by the admin in the same interview/review flow that exists today, and bind every member's runs. Hooks enforce; instructions don't (ADR-010).

**Members.** Create an account under the company (company code or invite link + name + credential). A new account is **pending**: it can see nothing until approved. Approval lands where every other decision already lands — the admin's **Needs-You rail**, as a first-class desk item ("«Priya» asks to join — approve / deny"), phone-approvable through the existing Telegram path. Approved members connect to the host's gateway; their runs route through the company's providers under the company's governance. A removed member loses gateway access immediately (access is a gateway session, not a copied key).

**Every run is still governed the same way.** Tier-1 before Tier-2, spans, hash-chained evidence, Verdicts in the company vault — one audit trail for the whole team, which is the enterprise story writing itself.

## Shared memory, filtered — the privacy model

One company vault, three visibility tiers, enforced at the **tool source** (the governed vault tools the engine already has — the same seam the egress floor uses today):

1. **Company memory** — readable by every approved member's runs. The default for project notes, verdicts, reports.
2. **Role/department memory** — folders bound to roles the interview already captures (`finance/` readable by finance-role members' runs only). The admin's "memory filters": per-role read scopes declared in governance, enforced by the vault tool source before a byte reaches a prompt — a member's run literally cannot read outside its scope, which is stronger than promising the model won't.
3. **Personal memory** — each member's private area (`members/<id>/`), readable only by that member's own runs. Never injected into anyone else's context, never summarized into company memory without that member's explicit action.

**Sensitivity keeps its meaning.** Today "sensitive → force-local" pins work to the user's own Mac. In company mode the same rule reads: company-sensitive work is pinned to the **company's own server models** (never a third-party cloud), and the built-in protections (passwords, credentials, PII) stay always-on. A member without a local model still gets the private lane — the company server *is* the private lane.

## What this deliberately reuses (the build is smaller than it looks)

| Need | Already exists |
|---|---|
| Remote gateway | Bifrost + engine services, ADR-026's remote half |
| Approval queue | Desk needs-you items + Telegram two-way |
| Roles | Interview governance (`roles:`) + role-scoped skills |
| Read-scope enforcement | Governed vault tool source (path-confined today) |
| Force-local / egress floor | `VaultEgressFloor` — generalizes to force-company |
| Audit | Spans + hash-chained evidence + Verdicts, per run |

## Phases (each a full spec → reviewed build → gate)

- **A — Host & members:** the wizard fork; host runs the gateway listening beyond localhost (auth required); member accounts, pending→approved lifecycle on the admin desk; members' runs through the company gateway on company providers; one shared company vault.
- **B — Memory filters:** role/department read scopes + personal areas, enforced in the vault tool source; admin UI on the governance review page ("Who can remember what").
- **C — Company operations:** per-member usage on the Stats page, budgets/quotas per role, member offboarding sweep, backup/restore of the company vault.

## Out of scope (named so they don't creep)

Multi-company federation; SSO/OIDC (accounts are app-local in A); members bringing their own provider keys; real-time co-editing of one chat thread; mobile clients beyond the existing Telegram approvals.

## Open questions for Sukhdeep

1. Where does the company server actually run day one — the admin's Mac (simplest, matches today's install) or a headless Linux box (needs the engine packaged without the Tauri shell)?
2. May members ALSO have personal local models for tier-3 personal work, or is all member compute company-side in v1?
3. Does a member see the whole Work app (own projects on the company server), or a narrower "my tasks + company chat" surface first?

## Decisions (2026-08-31 — taken under the founder's standing "use your brain" authority; each reversible)

1. **Day-one server = the admin's Mac.** Matches today's install; zero new
   packaging. Headless Linux packaging is phase C material.
2. **v1 member compute is company-side only.** One governance story, one
   private lane (the company server IS the private lane). Personal local
   models for tier-3 return in phase B.
3. **Members get the whole Work app, permission-scoped** — own projects on
   the company server + company chat. Reusing the proven surfaces beats
   building a narrow new one; the vault tool source already enforces scope
   below the UI.
4. **Naming honesty (pre-launch):** all USER-FACING copy says "Prism
   Gateway (Go daemon)" — we do not trade on the upstream Bifrost project's
   name. Internal module/binary names migrate post-launch (mechanical).
5. **OTel export: deferred, recorded.** House spans already power every
   measured claim; an OTLP exporter adds weight with no solo-user value.
   Revisit with company mode phase C (fleet observability is when it pays).
