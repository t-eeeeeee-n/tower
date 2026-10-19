//! Claude Code の hooks を受け取るローカルHTTPサーバー。
//! セッション起動時に `claude --settings <このファイル>` を渡すので、
//! ユーザーの ~/.claude/settings.json は書き換えない。

use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::session::Manager;

pub const PORT: u16 = 47800;

/// テスト時は別ポートを使えるようにする
pub fn port() -> u16 {
    std::env::var("CC_DECK_HOOK_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(PORT)
}

/// (Claude Code のイベント名, URLに使う名前)
const EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "session_start"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("PreToolUse", "pre_tool_use"),
    ("Notification", "notification"),
    ("Stop", "stop"),
    ("SessionEnd", "session_end"),
];

fn hook_command(event: &str) -> String {
    // ダッシュボード外で起動された claude では何もしない。
    // ダッシュボードが落ちていても Claude Code の動作は止めない（--max-time と || true）。
    let port = port();
    format!(
        "[ -n \"$DASH_SESSION_ID\" ] && curl -s --max-time 1 -X POST \
         \"http://127.0.0.1:{port}/hook/$DASH_SESSION_ID/{event}\" \
         --data-binary @- >/dev/null 2>&1 || true"
    )
}

pub fn write_settings(path: &Path) -> std::io::Result<()> {
    let mut hooks = serde_json::Map::new();
    for (name, slug) in EVENTS {
        let mut entry = json!({ "hooks": [{ "type": "command", "command": hook_command(slug) }] });
        if *name == "PreToolUse" {
            entry["matcher"] = json!("*");
        }
        hooks.insert((*name).to_string(), json!([entry]));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(&json!({ "hooks": hooks }))?)
}

/// サーバーを起動する。ポートが使用中ならエラーを返す。
pub fn serve<R: Runtime>(app: AppHandle<R>, manager: Arc<Manager>) -> Result<(), String> {
    let server = tiny_http::Server::http(("127.0.0.1", port()))
        .map_err(|e| format!("127.0.0.1:{} を開けませんでした: {e}", port()))?;
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let parts: Vec<String> =
                req.url().trim_matches('/').split('/').map(|s| s.to_string()).collect();
            let mut body = String::new();
            let _ = req.as_reader().take(1 << 20).read_to_string(&mut body);
            if parts.len() == 3 && parts[0] == "hook" {
                let message = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from));
                manager.apply_hook(&app, &parts[1], &parts[2], message);
            }
            let _ = req.respond(tiny_http::Response::empty(204));
        }
    });
    Ok(())
}
