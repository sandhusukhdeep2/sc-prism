//! Inbound Telegram decisions — the phone half of the approval loop
//! (2026-08-11 spec, `docs/superpowers/specs/2026-08-11-telegram-two-way-design.md`).
//!
//! The app already PARKS things and waits: a mid-run blocking approval pauses a
//! real subprocess for up to five minutes, and a manager dispatch job sits until
//! someone says OK. Until now that pause could only end at the desk. This module
//! is the narrow inbound channel that lets a tap on the phone end it — and
//! NOTHING else. It carries decisions (Approve / Deny on something already
//! parked); it is not chat and it cannot start work.
//!
//! Token custody (binding, from the earlier audit that caught the token leaking
//! into a DOM error string):
//!
//!   * The bot token lives ONLY in this module's `InboxState`, native side. It
//!     is written once by `telegram_watch_start` and cleared by
//!     `telegram_watch_stop`. No command returns it, and nothing derived from it
//!     is serialized to the webview — `InboundDecision` carries a callback id, a
//!     request id, a decision and the chat id, and that is the whole surface.
//!   * NO error string built here is derived from a `reqwest` error (whose
//!     `Display` embeds the full request URL, token included) or from the URL.
//!     Every failure resolves to one of the module's fixed strings or to
//!     `http_status_error`, which is status + Telegram's own short description.
//!   * `send_telegram_request` / `telegram_answer_callback` do not TAKE a token
//!     at all: they use the stored one, so the outbound half of the loop never
//!     asks the webview to hand a secret back.
//!
//! Trust (binding): a callback is forwarded to the app ONLY when the chat id
//! matches the configured one. Anything else is dropped here and written to an
//! honest local log line (`telegram_watch_log`) — never answered, so a stranger
//! probing the bot learns nothing. Whether the request is still genuinely
//! pending, and whether it was already decided, is the app's call (it owns the
//! registry and the pending files) — see `src/lib/telegramApprovals.ts`.
//!
//! Polling runs ONLY while reports are on: the loop re-checks `running` and its
//! `generation` every iteration and returns the moment either says stop, so a
//! toggle-off really does end the poller (and a toggle-on never stacks two).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Fixed failure strings. None is derived from a URL or a `reqwest` error, so
/// none can carry the token (see the module note).
const NET_ERR: &str = "connection failed — check your network";
const OFF_ERR: &str = "telegram reports are off";
const BAD_TOKEN_ERR: &str = "that does not look like a bot token";

/// Button payload prefixes. Telegram caps `callback_data` at 64 bytes; a 32-hex
/// request id + a 3-byte prefix fits with room to spare.
const APPROVE_PREFIX: &str = "ok:";
const DENY_PREFIX: &str = "no:";

/// How many honest log lines to retain (a ring — the desk/tests read the tail).
const LOG_CAP: usize = 50;

/// One inbound Approve/Deny tap that PASSED the chat-id check. This is the whole
/// shape the webview ever sees from the poller: no token, no message text, no
/// user profile — just enough to look the request up and answer it honestly.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct InboundDecision {
    /// Telegram's callback query id — needed to answer the tap (and only that).
    pub callback_id: String,
    /// OUR opaque, single-use request id (minted app-side, never a target id).
    pub request_id: String,
    /// `"allow"` or `"deny"` — the same two words the desk writes.
    pub decision: String,
    /// The chat the tap came from. Already checked here; forwarded so the app
    /// can check it again (defense in depth) before it writes anything.
    pub chat_id: String,
}

#[derive(Default)]
pub struct InboxState {
    /// The bot token. NEVER read by anything that returns a value to the webview.
    token: String,
    chat_id: String,
    /// `getUpdates` offset — persisted, so a restart does not re-deliver taps
    /// that were already handled (which would look like a phantom decision).
    offset: i64,
    running: bool,
    /// Bumped on every start/stop so a loop from a previous start exits instead
    /// of racing the current one.
    generation: u64,
    queue: Vec<InboundDecision>,
    log: Vec<String>,
}

/// Tauri-managed handle around the inbox (cloned into the polling task).
#[derive(Clone, Default)]
pub struct TelegramInbox(pub Arc<Mutex<InboxState>>);

// ---------------------------------------------------------------------------
// Pure pieces (unit-tested below — no network, no Tauri runtime)
// ---------------------------------------------------------------------------

/// Telegram bot tokens are `<digits>:<base64ish>`. Positively validated so a
/// token can never rewrite the request path (audit: `\` normalizes to `/` in
/// WHATWG URLs and `%2F` decodes server-side — a denylist is not enough).
pub fn token_looks_valid(token: &str) -> bool {
    token.split_once(':').is_some_and(|(id, secret)| {
        !id.is_empty()
            && id.bytes().all(|b| b.is_ascii_digit())
            && secret.len() >= 20
            && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// An opaque request id is filename/payload-safe and long enough to be
/// unguessable: 16..=64 of `[A-Za-z0-9_-]`. The app mints 32 hex chars from
/// `crypto.getRandomValues` (128 bits); this is the receiving-end guard.
pub fn safe_request_id(id: &str) -> bool {
    id.len() >= 16
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `"ok:<id>"` → `("allow", id)`, `"no:<id>"` → `("deny", id)`; anything else
/// (or an unsafe id) → `None`. The button payload carries ONLY the opaque
/// request id — never the approval id, the tool name, or a vault path.
pub fn parse_callback_data(data: &str) -> Option<(&'static str, &str)> {
    let (decision, id) = if let Some(rest) = data.strip_prefix(APPROVE_PREFIX) {
        ("allow", rest)
    } else if let Some(rest) = data.strip_prefix(DENY_PREFIX) {
        ("deny", rest)
    } else {
        return None;
    };
    if safe_request_id(id) {
        Some((decision, id))
    } else {
        None
    }
}

/// The inline keyboard for a request message: two buttons, each carrying only
/// the opaque request id.
pub fn request_keyboard(request_id: &str) -> serde_json::Value {
    serde_json::json!({
        "inline_keyboard": [[
            { "text": "Approve", "callback_data": format!("{APPROVE_PREFIX}{request_id}") },
            { "text": "Deny", "callback_data": format!("{DENY_PREFIX}{request_id}") },
        ]]
    })
}

/// A non-2xx Telegram reply, rendered WITHOUT the request URL: status code plus
/// Telegram's own short `description`. This is the only status-bearing error
/// this module produces, and it is token-free by construction.
pub fn http_status_error(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("description").and_then(|d| d.as_str()).map(String::from))
        .unwrap_or_default();
    format!(
        "telegram said {status}{}{}",
        if detail.is_empty() { "" } else { ": " },
        detail
    )
}

#[derive(Default, Debug, PartialEq)]
pub struct ParsedUpdates {
    pub decisions: Vec<InboundDecision>,
    /// `max(update_id) + 1` over EVERY update in the batch — including the ones
    /// dropped for a wrong chat id, so a stranger's tap cannot wedge the offset
    /// and make us re-fetch the same batch forever.
    pub next_offset: Option<i64>,
    pub log: Vec<String>,
}

fn chat_id_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

/// Parse one `getUpdates` response into forwardable decisions + the next offset
/// + honest log lines. Everything that is not a callback_query from the
/// CONFIGURED chat is dropped with a log line and never answered.
pub fn parse_updates(body: &str, configured_chat: &str) -> ParsedUpdates {
    let mut out = ParsedUpdates::default();
    let configured = configured_chat.trim();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        out.log.push("telegram poll: unreadable response — ignored".into());
        return out;
    };
    let Some(results) = v.get("result").and_then(|r| r.as_array()) else {
        out.log.push("telegram poll: no updates in response".into());
        return out;
    };
    for u in results {
        if let Some(id) = u.get("update_id").and_then(|x| x.as_i64()) {
            let next = id + 1;
            out.next_offset = Some(out.next_offset.map_or(next, |cur: i64| cur.max(next)));
        }
        let Some(cq) = u.get("callback_query") else { continue };
        let chat = cq
            .get("message")
            .and_then(|m| m.get("chat"))
            .and_then(|c| c.get("id"))
            .map(chat_id_string)
            .unwrap_or_default();
        if configured.is_empty() || chat != configured {
            // SILENT to the sender (never answered — a stranger learns nothing),
            // honest locally.
            out.log.push(format!(
                "ignored a Telegram tap from chat {} — not the configured chat; nothing was decided",
                if chat.is_empty() { "unknown".to_string() } else { chat }
            ));
            continue;
        }
        let callback_id = cq.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let data = cq.get("data").and_then(|x| x.as_str()).unwrap_or("");
        let Some((decision, request_id)) = parse_callback_data(data) else {
            out.log
                .push("ignored a Telegram tap with unrecognised button data".into());
            continue;
        };
        if callback_id.is_empty() {
            out.log.push("ignored a Telegram tap with no callback id".into());
            continue;
        }
        out.decisions.push(InboundDecision {
            callback_id,
            request_id: request_id.to_string(),
            decision: decision.to_string(),
            chat_id: chat,
        });
    }
    out
}

/// Read the persisted `getUpdates` offset (absent/garbage → 0, never an error).
pub fn read_offset(path: &PathBuf) -> i64 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .filter(|n| *n >= 0)
        .unwrap_or(0)
}

/// Persist the offset (best effort — a failed write only risks re-seeing a tap,
/// which the app-side single-use registry then rejects honestly).
pub fn write_offset(path: &PathBuf, offset: i64) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, offset.to_string());
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

impl TelegramInbox {
    /// True only while THIS generation is the live poller. The loop checks this
    /// every iteration, which is what makes "polling stops when reports are
    /// off" real rather than aspirational.
    pub fn should_poll(&self, generation: u64) -> bool {
        let s = self.0.lock().unwrap();
        s.running && s.generation == generation && !s.token.is_empty()
    }

    fn credentials(&self, generation: u64) -> Option<(String, String, i64)> {
        let s = self.0.lock().unwrap();
        if !s.running || s.generation != generation || s.token.is_empty() {
            return None;
        }
        Some((s.token.clone(), s.chat_id.clone(), s.offset))
    }

    fn note(&self, line: String) {
        let mut s = self.0.lock().unwrap();
        s.log.push(line);
        let over = s.log.len().saturating_sub(LOG_CAP);
        if over > 0 {
            s.log.drain(0..over);
        }
    }

    fn absorb(&self, generation: u64, parsed: ParsedUpdates) -> Option<i64> {
        let mut s = self.0.lock().unwrap();
        if !s.running || s.generation != generation {
            return None; // stopped mid-request: drop the batch, decide nothing
        }
        if let Some(next) = parsed.next_offset {
            if next > s.offset {
                s.offset = next;
            }
        }
        s.queue.extend(parsed.decisions);
        s.log.extend(parsed.log);
        let over = s.log.len().saturating_sub(LOG_CAP);
        if over > 0 {
            s.log.drain(0..over);
        }
        Some(s.offset)
    }
}

// ---------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------

fn offset_file(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("telegram")
        .join("updates-offset")
}

async fn poll_loop(app: tauri::AppHandle, inbox: TelegramInbox, generation: u64) {
    let offset_path = offset_file(&app);
    let client = match reqwest::Client::builder()
        // Long-poll: 25s server-side hold, 40s client bound so a wedged socket
        // cannot pin the task forever.
        .timeout(std::time::Duration::from_secs(40))
        .user_agent("sc-prism")
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            inbox.note("telegram poll: could not start the http client".into());
            return;
        }
    };
    while let Some((token, chat_id, offset)) = inbox.credentials(generation) {
        // The token appears ONLY here, in the URL Telegram itself defines. It is
        // never formatted into an error, a log line, or anything returned.
        let url = format!("https://api.telegram.org/bot{token}/getUpdates");
        let body = serde_json::json!({
            "offset": offset,
            "timeout": 25,
            "allowed_updates": ["callback_query"],
        })
        .to_string();
        let sent = client
            .post(&url)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await;
        let text = match sent {
            // NEVER Display the reqwest error: it embeds the URL, token included.
            Err(_) => {
                inbox.note(format!("telegram poll: {NET_ERR}"));
                sleep_secs(5).await;
                continue;
            }
            Ok(resp) if !resp.status().is_success() => {
                let status = resp.status().as_u16();
                let raw = resp.text().await.unwrap_or_default();
                inbox.note(format!("telegram poll: {}", http_status_error(status, &raw)));
                sleep_secs(5).await;
                continue;
            }
            Ok(resp) => resp.text().await.unwrap_or_default(),
        };
        let parsed = parse_updates(&text, &chat_id);
        if let Some(next) = inbox.absorb(generation, parsed) {
            if next != offset {
                write_offset(&offset_path, next);
            }
        } else {
            return; // reports went off while the request was in flight
        }
    }
}

/// Back off without adding a runtime dependency: hand the wait to Tauri's
/// blocking pool so the async worker thread is never parked.
async fn sleep_secs(secs: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_secs(secs))
    })
    .await;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start polling for inbound decisions. Idempotent-ish: a second start replaces
/// the credentials and bumps the generation, so the previous loop exits on its
/// next check instead of two loops racing the same offset.
#[tauri::command]
pub async fn telegram_watch_start(
    app: tauri::AppHandle,
    inbox: tauri::State<'_, TelegramInbox>,
    token: String,
    chat_id: String,
) -> Result<(), String> {
    let token = token.trim().to_string();
    let chat_id = chat_id.trim().to_string();
    if token.is_empty() || chat_id.is_empty() {
        return Err("token and chat id are both required".into());
    }
    // The error says the token is malformed — it never ECHOES the token.
    if !token_looks_valid(&token) {
        return Err(BAD_TOKEN_ERR.into());
    }
    let handle = inbox.inner().clone();
    let generation = {
        let mut s = handle.0.lock().unwrap();
        s.generation += 1;
        s.token = token;
        s.chat_id = chat_id;
        s.running = true;
        if s.offset == 0 {
            s.offset = read_offset(&offset_file(&app));
        }
        s.generation
    };
    let loop_handle = handle.clone();
    tauri::async_runtime::spawn(async move { poll_loop(app, loop_handle, generation).await });
    Ok(())
}

/// Stop polling and FORGET the token. Called whenever reports go off (or the
/// credentials change) — after this, `should_poll` is false for every
/// generation, so the live loop returns at its next check.
#[tauri::command]
pub async fn telegram_watch_stop(inbox: tauri::State<'_, TelegramInbox>) -> Result<(), String> {
    let mut s = inbox.0.lock().unwrap();
    s.running = false;
    s.generation += 1;
    s.token.clear();
    s.chat_id.clear();
    s.queue.clear();
    Ok(())
}

/// Drain the decisions received since the last call. The app decides what each
/// one MEANS (pending? already decided? expired?) — this only hands over taps
/// that already passed the chat-id check.
#[tauri::command]
pub async fn telegram_take_decisions(
    inbox: tauri::State<'_, TelegramInbox>,
) -> Result<Vec<InboundDecision>, String> {
    let mut s = inbox.0.lock().unwrap();
    Ok(std::mem::take(&mut s.queue))
}

/// The honest local log (ignored taps, poll failures). Token-free by
/// construction; the desk can show it and tests assert on it.
#[tauri::command]
pub async fn telegram_watch_log(
    inbox: tauri::State<'_, TelegramInbox>,
) -> Result<Vec<String>, String> {
    let s = inbox.0.lock().unwrap();
    Ok(s.log.clone())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("sc-prism")
        .build()
        // The reqwest error is dropped, not Displayed (custody).
        .map_err(|_| "could not start the http client".to_string())
}

async fn post_json(path: &str, token: &str, body: serde_json::Value) -> Result<(), String> {
    let client = http_client()?;
    let url = format!("https://api.telegram.org/bot{token}/{path}");
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        // NEVER Display the reqwest error here — it embeds the token-bearing URL.
        .map_err(|_| NET_ERR.to_string())?;
    if resp.status().is_success() {
        return Ok(());
    }
    let status = resp.status().as_u16();
    let raw = resp.text().await.unwrap_or_default();
    Err(http_status_error(status, &raw))
}

/// Read the credentials for an outbound call. `None` when reports are off —
/// which is what makes "a request message is only ever sent while the loop is
/// live" structural rather than a convention.
fn outbound(inbox: &tauri::State<'_, TelegramInbox>) -> Option<(String, String)> {
    let s = inbox.0.lock().unwrap();
    if !s.running || s.token.is_empty() || s.chat_id.is_empty() {
        return None;
    }
    Some((s.token.clone(), s.chat_id.clone()))
}

/// Send a DECISION REQUEST: the caller's outcome-only line plus Approve/Deny
/// buttons carrying `request_id`. Takes no token — it uses the stored one, so
/// the webview never hands a secret back. `text` is whatever the app's notifier
/// composed; the content rule (tool/job name only, never model output or vault
/// content) is enforced there, where the data is.
#[tauri::command]
pub async fn send_telegram_request(
    inbox: tauri::State<'_, TelegramInbox>,
    text: String,
    request_id: String,
) -> Result<(), String> {
    if !safe_request_id(&request_id) {
        return Err("invalid request id".into());
    }
    let Some((token, chat_id)) = outbound(&inbox) else {
        return Err(OFF_ERR.into());
    };
    post_json(
        "sendMessage",
        &token,
        serde_json::json!({
            "chat_id": chat_id,
            "text": text.chars().take(500).collect::<String>(),
            "reply_markup": request_keyboard(&request_id),
        }),
    )
    .await
}

/// Answer a tap honestly (`answerCallbackQuery`) — "approved", "already timed
/// out", "unknown request". Takes no token, same custody as above.
#[tauri::command]
pub async fn telegram_answer_callback(
    inbox: tauri::State<'_, TelegramInbox>,
    callback_id: String,
    text: String,
) -> Result<(), String> {
    if callback_id.is_empty() {
        return Err("missing callback id".into());
    }
    let Some((token, _chat)) = outbound(&inbox) else {
        return Err(OFF_ERR.into());
    };
    post_json(
        "answerCallbackQuery",
        &token,
        serde_json::json!({
            "callback_query_id": callback_id,
            // Telegram caps this at 200 chars.
            "text": text.chars().take(190).collect::<String>(),
            "show_alert": true,
        }),
    )
    .await
}

// ---------------------------------------------------------------------------
// Tests — the pure halves: parsing, the chat-id gate, offsets, token custody.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

    fn update(update_id: i64, chat: &str, data: &str) -> String {
        format!(
            r#"{{"update_id":{update_id},"callback_query":{{"id":"cb{update_id}","from":{{"id":7}},"message":{{"message_id":5,"chat":{{"id":{chat}}}}},"data":"{data}"}}}}"#
        )
    }

    fn batch(updates: &[String]) -> String {
        format!(r#"{{"ok":true,"result":[{}]}}"#, updates.join(","))
    }

    const REQ: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

    #[test]
    fn a_tap_from_the_configured_chat_is_forwarded_with_no_token_in_it() {
        let body = batch(&[update(11, "424242", &format!("ok:{REQ}"))]);
        let parsed = parse_updates(&body, "424242");
        assert_eq!(parsed.decisions.len(), 1);
        let d = &parsed.decisions[0];
        assert_eq!(d.request_id, REQ);
        assert_eq!(d.decision, "allow");
        assert_eq!(d.chat_id, "424242");
        assert_eq!(parsed.next_offset, Some(12));
        assert!(parsed.log.is_empty());
        // What the webview receives, serialized: no token, no message text.
        let wire = serde_json::to_string(d).unwrap();
        assert!(!wire.contains(TOKEN));
        assert!(!wire.contains("AAHdqTcv"));
    }

    #[test]
    fn a_tap_from_a_wrong_chat_is_dropped_silently_and_logged_honestly() {
        let body = batch(&[
            update(20, "999999", &format!("ok:{REQ}")),
            update(21, "424242", &format!("no:{REQ}")),
        ]);
        let parsed = parse_updates(&body, "424242");
        // Only the configured chat's tap survives — the stranger's is NOT
        // forwarded (so nothing can be decided from it) and NOT answered.
        assert_eq!(parsed.decisions.len(), 1);
        assert_eq!(parsed.decisions[0].decision, "deny");
        assert_eq!(parsed.log.len(), 1);
        assert!(parsed.log[0].contains("999999"));
        assert!(parsed.log[0].contains("not the configured chat"));
        assert!(parsed.log[0].contains("nothing was decided"));
        // The offset still advances past the ignored update — a stranger cannot
        // wedge the poller into re-fetching the same batch forever.
        assert_eq!(parsed.next_offset, Some(22));
    }

    #[test]
    fn an_empty_configured_chat_forwards_nothing() {
        let parsed = parse_updates(&batch(&[update(1, "424242", &format!("ok:{REQ}"))]), "  ");
        assert!(parsed.decisions.is_empty());
        assert_eq!(parsed.log.len(), 1);
    }

    #[test]
    fn junk_button_data_and_junk_responses_decide_nothing() {
        // Unrecognised prefix, and a too-short (guessable) request id.
        let body = batch(&[
            update(1, "42", "hello"),
            update(2, "42", "ok:short"),
            update(3, "42", &format!("maybe:{REQ}")),
        ]);
        let parsed = parse_updates(&body, "42");
        assert!(parsed.decisions.is_empty());
        assert_eq!(parsed.log.len(), 3);
        assert_eq!(parsed.next_offset, Some(4));

        let broken = parse_updates("{ not json", "42");
        assert!(broken.decisions.is_empty());
        assert_eq!(broken.next_offset, None);
        assert_eq!(broken.log.len(), 1);

        let empty = parse_updates(r#"{"ok":false,"description":"Unauthorized"}"#, "42");
        assert!(empty.decisions.is_empty());
        assert!(empty.next_offset.is_none());
    }

    #[test]
    fn a_string_chat_id_matches_too() {
        let body = format!(
            r#"{{"ok":true,"result":[{{"update_id":9,"callback_query":{{"id":"cb9","message":{{"chat":{{"id":"-1001234567890"}}}},"data":"ok:{REQ}"}}}}]}}"#
        );
        let parsed = parse_updates(&body, "-1001234567890");
        assert_eq!(parsed.decisions.len(), 1);
    }

    #[test]
    fn buttons_carry_only_the_opaque_request_id_and_round_trip() {
        let kb = request_keyboard(REQ);
        let row = kb["inline_keyboard"][0].clone();
        let approve = row[0]["callback_data"].as_str().unwrap().to_string();
        let deny = row[1]["callback_data"].as_str().unwrap().to_string();
        assert_eq!(row[0]["text"], "Approve");
        assert_eq!(row[1]["text"], "Deny");
        assert_eq!(parse_callback_data(&approve), Some(("allow", REQ)));
        assert_eq!(parse_callback_data(&deny), Some(("deny", REQ)));
        // Telegram's 64-byte callback_data limit.
        assert!(approve.len() <= 64 && deny.len() <= 64);
        // The payload carries the request id ONLY — no approval id, no tool.
        assert!(!approve.contains("write_file"));
    }

    #[test]
    fn request_ids_must_be_long_and_payload_safe() {
        assert!(safe_request_id(REQ));
        assert!(!safe_request_id("short"));
        assert!(!safe_request_id("../../etc/passwd"));
        assert!(!safe_request_id(&"x".repeat(65)));
        assert!(!safe_request_id("has space aaaaaaaaaaaaaaa"));
    }

    #[test]
    fn no_error_string_this_module_produces_can_carry_the_token() {
        // The status path renders code + Telegram's own description, never the
        // URL (which is the only place the token appears).
        let e = http_status_error(401, r#"{"ok":false,"description":"Unauthorized"}"#);
        assert_eq!(e, "telegram said 401: Unauthorized");
        assert!(!e.contains(TOKEN));
        // Even if Telegram echoed nothing useful, no URL leaks in.
        let e2 = http_status_error(429, "not json at all");
        assert_eq!(e2, "telegram said 429");
        assert!(!e2.contains("api.telegram.org"));
        // The fixed strings are literals — nothing interpolated, so no token
        // and no request URL can appear in any of them.
        for s in [NET_ERR, OFF_ERR, BAD_TOKEN_ERR] {
            assert!(!s.contains(TOKEN));
            assert!(!s.contains("api.telegram.org"));
            assert!(!s.contains(':'));
        }
    }

    #[test]
    fn token_shape_is_validated_positively() {
        assert!(token_looks_valid(TOKEN));
        assert!(!token_looks_valid("nope"));
        assert!(!token_looks_valid("123:short"));
        // A path-rewriting attempt is rejected by the charset rule.
        assert!(!token_looks_valid("123:aaaaaaaaaaaaaaaaaaaa/../getMe"));
    }

    #[test]
    fn polling_stops_when_reports_go_off_and_never_runs_without_a_token() {
        let inbox = TelegramInbox::default();
        // Reports off (the default) → no generation may poll.
        assert!(!inbox.should_poll(0));
        assert!(!inbox.should_poll(1));
        // Reports on.
        let generation = {
            let mut s = inbox.0.lock().unwrap();
            s.generation += 1;
            s.running = true;
            s.token = TOKEN.into();
            s.chat_id = "42".into();
            s.generation
        };
        assert!(inbox.should_poll(generation));
        // A stale loop from an earlier start must not keep polling.
        assert!(!inbox.should_poll(generation - 1));
        // Toggling reports off stops the live loop AND forgets the token.
        {
            let mut s = inbox.0.lock().unwrap();
            s.running = false;
            s.generation += 1;
            s.token.clear();
        }
        assert!(!inbox.should_poll(generation));
        assert!(inbox.0.lock().unwrap().token.is_empty());
    }

    #[test]
    fn a_batch_absorbed_after_stop_decides_nothing() {
        let inbox = TelegramInbox::default();
        let generation = {
            let mut s = inbox.0.lock().unwrap();
            s.generation += 1;
            s.running = true;
            s.token = TOKEN.into();
            s.chat_id = "42".into();
            s.generation
        };
        let parsed = parse_updates(&batch(&[update(5, "42", &format!("ok:{REQ}"))]), "42");
        // Reports go off while the long-poll was in flight.
        {
            let mut s = inbox.0.lock().unwrap();
            s.running = false;
            s.generation += 1;
        }
        assert_eq!(inbox.absorb(generation, parsed), None);
        assert!(inbox.0.lock().unwrap().queue.is_empty());
    }

    #[test]
    fn the_offset_persists_and_only_moves_forward() {
        let dir = std::env::temp_dir().join(format!("scprism-tg-{}", std::process::id()));
        let path = dir.join("updates-offset");
        assert_eq!(read_offset(&path), 0); // absent → 0, never an error
        write_offset(&path, 42);
        assert_eq!(read_offset(&path), 42);
        std::fs::write(&path, "not a number").unwrap();
        assert_eq!(read_offset(&path), 0);

        let inbox = TelegramInbox::default();
        let generation = {
            let mut s = inbox.0.lock().unwrap();
            s.generation += 1;
            s.running = true;
            s.token = TOKEN.into();
            s.offset = 100;
            s.generation
        };
        // A late batch with a LOWER offset never rewinds us (which would
        // re-deliver taps that were already answered).
        let stale = ParsedUpdates { next_offset: Some(50), ..Default::default() };
        assert_eq!(inbox.absorb(generation, stale), Some(100));
        let fresh = ParsedUpdates { next_offset: Some(101), ..Default::default() };
        assert_eq!(inbox.absorb(generation, fresh), Some(101));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_log_is_a_bounded_ring() {
        let inbox = TelegramInbox::default();
        for i in 0..(LOG_CAP + 10) {
            inbox.note(format!("line {i}"));
        }
        let s = inbox.0.lock().unwrap();
        assert_eq!(s.log.len(), LOG_CAP);
        assert_eq!(s.log[0], format!("line {}", 10));
    }
}
