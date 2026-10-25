# Capability-aware chat attachments (files + images) + audio — design

**Date:** 2026-07-19 · **From Sukhdeep:** "let me add pictures, files, and enter through audio… but if the user's model can't do images/files, hide that section; if the local model is capable, show the upload." **Chosen:** files + images, **capability-gated** (show only what the active model can use). Audio = macOS dictation (no build).

## Principle

Never show an affordance the model can't use. **Text files work with every model** (text → context), so the file button is always available. **Images require a vision-capable model**, so the image button appears **only when the active model supports vision**.

## Capability model

- Add `supportsVision?: boolean` to `ProviderConfig` (settings.ts).
- **Defaults (auto):** cloud providers known to be multimodal — `claude`, `gemini`, `openai` (GPT-4o family) — default `true`. `local` and unknown → default `false` (most local models aren't vision).
- **User override:** a **"This model can see images"** toggle in the local (and any) provider's settings, so a user running a vision local model (LLaVA / Llama-Vision / Qwen-VL) can turn it on.
- `activeModelSupportsVision(settings): boolean` — the PRIMARY provider's `supportsVision`. The composer's image button renders only when this is true.

## Slice A — Files (build first; universal, no gating)

- **Composer:** a **📎 attach** button in the Workspace chat composer → native file picker (new Rust `pick_file` command mirroring `pick_folder`; or plugin-fs) → read the file's **text** content (cap size, e.g. 200 KB; UTF-8; binary/oversize → honest "can't attach this file type/size").
- **To the AI:** the attached file's content is prepended to the sent message as a clearly-delimited block, e.g. `[Attached file: <name>]\n<contents>\n[end of file]\n\n<user's text>`. Reaches the engine via the existing intent/`SCPRISM_CONTEXT` path — works with any connected model.
- Show attached files as removable chips in the composer before sending; clear on send.
- Types: text/code/markdown/json/csv/log. PDF/docx → out of scope for slice A (note honestly: "text/code files for now").

## Slice B — Images (build after A; capability-gated + multimodal engine)

- **Composer:** a **🖼️ image** button, rendered ONLY when `activeModelSupportsVision(settings)`. Native picker (images) → base64 (cap size). Show a thumbnail chip; clear on send.
- **Engine multimodal (the substantial part):** the pipeline sends text today (`SCPRISM_CONTEXT` + intent). Add an image channel: pass image(s) as base64 (env is unsuitable for large blobs → write to a temp file under the vault and pass its path, OR a dedicated arg; decide in the plan) to the engine; `gateway.py` builds the provider-specific multimodal message:
  - **OpenAI-compatible (incl. LOCAL via LM Studio/Ollama vision models):** `messages[].content` array with `{type:'text'}` + `{type:'image_url', image_url:{url:'data:image/…;base64,…'}}`.
  - **Anthropic (Claude):** `content` array with `{type:'image', source:{type:'base64', media_type, data}}`.
  - **Gemini:** `parts` with `inline_data{mime_type, data}`.
  - Only the doer/lead model call carries the image; keep it off the Tier-2 judge.
- **Honest failure:** if the model turns out not to support vision (a local one the user toggled on wrongly), surface the provider's error honestly, don't fake a response.

## Audio (no build)

Document macOS dictation in-app: a small hint near the composer ("🎤 press Fn twice to dictate"). No transcription engine bundled.

## Cuts / honesty

Slice A ships first (universal, low-risk). Slice B (images) is the larger multimodal engine change, capability-gated, built after A lands. No cloud transcription / no bundled Whisper. PDF/office files deferred. The image button never shows for a model that can't use vision, so the user is never offered something that will fail.

## Acceptance

Slice A: attach a `.md`/`.ts` file in the chat → the AI's answer references its contents; works on a local model. Slice B: with a vision model as primary, an image button appears, attach a screenshot → the model describes it; with a non-vision local model, the image button is absent. `verify.sh` PASS.
