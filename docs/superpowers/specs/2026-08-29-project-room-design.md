# The project room — no more black box

**Status:** ACCEPTED direction · Sukhdeep, 2026-08-29 evening, verbatim intent:
"If I create any new project, I need to have a separate chat, separate folder
access, separate file details. I need it in a chat, like a cloud coworker like
Gemini — which file you are accessing, which agent of which AI is working on
it, and what they are doing. A scrollable chat representing me data. It's
working in a black box — user didn't understand what's happening. Even the
project holder cannot access that project folder. Rethink and sort out the
whole stuff."

## The standard to build to

A project is a ROOM, and the room's chat is the whole story of the work:

1. **Separate everything, visibly.** Own thread (exists), own folder access
   (Reveal always — shipped; Files panel — next), own file details. The
   header names the room; switching rooms is unmistakable.
2. **The work lives IN the chat.** During a run, the room's chat streams
   inline action lines between agent turns, chat-style and scrollable:
   - `🔎 researcher (gemini) searched "cli digest formats" — 8 results`
   - `📓 retrieval (local) read docs/vault-map.md`
   - `✍️ implementer (qwen) wrote docs/PITCH.md — 28 lines`
   - `$ tier-1 ran npm test — green in 4.2s`
   Every line derives from the engine's span records — never invented,
   exactly the EngineConsole data but INLINE in the room, attributed to the
   seat (colored circle + agent name + model brand) the span belongs to.
3. **Attribution is three-part everywhere:** agent name · AI brand · action.
   "Opus is doing this thing" is not enough (his words); "planner · claude ·
   reading docs/PITCH.md" is the floor.
4. **The privacy line holds in the room too:** web arguments may render
   (already egressed); vault/MCP arguments never; 🔒 withheld and ⛔ blocked
   moments render distinctly — governance is part of the story.
5. **Files are a first-class tab of the room:** list the folder's real
   contents (sizes, mtimes), click → reveal; nothing locked in the app.

## Build order (each slice TDD, gate, push)

- A. Inline action stream in the project chat (span → seat-attributed chat
  rows while a run is live; collapsed "n actions" group per turn after).
- B. Files panel (Rust `list_dir_tree` + room tab) + native Choose-folder
  picker for Attach existing (osascript, zero deps).
- C. Room header: project name + path + Reveal + Files + Delete in one bar.
- D. The ux-critic agent (below) reviews every page against this spec and
  files evidence-backed proposals on the heartbeat.

## The standing reviewer

`~/sc-vault/agents/ux-critic.md` — an agent whose charter is to walk one
surface per wake and name every black-box moment (a number without a source,
a status without a cause, work without attribution), citing real runs as
evidence. Its proposals ride the existing PROPOSE_AGENT/report flow — the
product reviewing itself with its own machinery.
