# Coworker-parity sprint — Sukhdeep's screenshot review, 2026-08-30

His words, consolidated (two screenshots: his Claude Code transcript = the
bar; SC Prism's repeated anonymous failure bubbles = the miss):

1. **Feed like a cloud coworker.** Each project strictly its own chat (never
   mixed); the feed shows WHICH agent does WHAT — terminal commands, file
   edits, agent↔agent and agent→manager communication, properly elaborated.
   Repeated identical app-voice bubbles (his screenshot: 3× the same step
   notice) are noise — collapse them honestly (one bubble, ×N, latest time).
2. **The "default initial chat" shouldn't exist as a peer.** The universal
   thread reads as a leftover. Decision: it becomes the MANAGER's chat —
   named for what it is (talk to your manager) — projects are rooms beside it.
3. **Sidebar is very complicated — simplify** (my plan, my call).
4. **Files must open IN the app.** File links that only reveal in Finder are
   not enough: a read-only viewer (markdown rendered, code in a pre, html as
   source) opens in-app; reveal in Finder stays as the secondary action.
5. **The target picker is too complicated.** Default = TEAM (different AIs,
   different agents — "by default Sukh is using a team"). Manager-managed is
   the alternative; agent/staff/propose fold behind "more". Two visible
   choices, not five.
6. **Real tool power for agents.** "They are not able to search the internet,
   control the browser, control the PC." Web research becomes actually usable
   (on by default within the governed allow-list/egress rules; seats with
   tools:[web] really browse), and the computer capability (engine slice
   landed 19261ca) gets its client grant surface. Verified with real runs,
   not claimed.

Order: (A) feed dedup+depth, (B) picker default team + manager rename,
(C) in-app file viewer, (D) real web/computer capability surfacing + live
verification, (E) sidebar simplification. Each slice TDD → gate → push;
rebuild after each batch.
