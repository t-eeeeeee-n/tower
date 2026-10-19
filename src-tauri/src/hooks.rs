//! Claude Code の hooks を受け取るローカルHTTPサーバー。
//! セッション起動時に `claude --settings <このファイル>` を渡すので、
//! ユーザーの ~/.claude/settings.json は書き換えない。
//!
//! 受信口は起動のたびに OS が空けたポートで開き、ランダムなトークンと一緒に
//! セッションの環境変数（DASH_HOOK_PORT / DASH_HOOK_TOKEN）で渡す。
//! 固定ポートだと別のプログラムに先取りされて hooks の中身が流れる恐れがあり、
//! トークンが無いと Web ページなど他のプログラムから偽の状態を送り込まれるため。

use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::session::Manager;

/// (Claude Code のイベント名, URLに使う名前)
const EVENTS: &[(&str, &str)] = &[
    ("SessionStart", "session_start"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("PreToolUse", "pre_tool_use"),
    ("Notification", "notification"),
    ("Stop", "stop"),
    ("SessionEnd", "session_end"),
];

/// セッションに渡す受信口の情報
#[derive(Clone)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

fn hook_command(event: &str) -> String {
    // 入力待ちのメッセージ表示に使う Notification 以外は、hook の入力（コマンドやファイル内容を含む）を送らない
    let body = if event == "notification" { "--data-binary @-" } else { "-d '' " };
    let drain = if event == "notification" { "" } else { "cat >/dev/null; " };
    // Tower の外で起動された claude（環境変数が無い）では何もしない。
    // Tower が落ちていても Claude Code の動作は止めない（--max-time と || true）。
    format!(
        "{drain}[ -n \"$DASH_HOOK_TOKEN\" ] && curl -s --max-time 1 -X POST \
         -H \"Authorization: Bearer $DASH_HOOK_TOKEN\" \
         \"http://127.0.0.1:$DASH_HOOK_PORT/hook/$DASH_SESSION_ID/{event}\" \
         {body} >/dev/null 2>&1 || true"
    )
}

/// ポートもトークンも含まないので、複数の Tower（インストール版と開発版など）で共有しても干渉しない
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

/// 受信口を開く。サーバーは [`serve`] に渡して動かす。
pub fn bind() -> Result<(tiny_http::Server, Endpoint), String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("hooks の受信口を開けませんでした: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("hooks の受信ポートを取得できませんでした")?;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("トークンを生成できませんでした: {e}"))?;
    let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok((server, Endpoint { port, token }))
}

fn header<'a>(req: &'a tiny_http::Request, name: &'static str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

/// 長さが同じなら一致・不一致で比較時間が変わらない
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authorized(req: &tiny_http::Request, endpoint: &Endpoint) -> bool {
    // ブラウザからのリクエストは Origin が付くので、トークンに関係なく拒否する
    if header(req, "Origin").is_some() {
        return false;
    }
    let expected = format!("Bearer {}", endpoint.token);
    header(req, "Authorization").is_some_and(|v| same(v, &expected))
}

pub fn serve<R: Runtime>(server: tiny_http::Server, endpoint: Endpoint, app: AppHandle<R>, manager: Arc<Manager>) {
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            if !authorized(&req, &endpoint) {
                let _ = req.respond(tiny_http::Response::empty(403));
                continue;
            }
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
}
