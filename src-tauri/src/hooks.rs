//! コーディングエージェント（Claude Code / Codex / Copilot CLI）の hooks を受け取るローカルHTTPサーバーと、
//! 各エージェント用の hooks 設定ファイルの生成。
//!
//! 受信口は起動のたびに OS が空けたポートで開き、ランダムなトークンと一緒に
//! セッションの環境変数（DASH_HOOK_PORT / DASH_HOOK_TOKEN）で渡す。
//! 固定ポートだと別のプログラムに先取りされて hooks の中身が流れる恐れがあり、
//! トークンが無いと Web ページなど他のプログラムから偽の状態を送り込まれるため。
//!
//! 設定ファイルにはポートもトークンも書かないので、複数の Tower で共有しても干渉せず、
//! Tower の外で起動したエージェント（環境変数が無い）では hooks は何もしない。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::session::Manager;

/// 入力待ちとして扱う通知の種類。Claude Code と Copilot CLI の notification_type に共通する名前と、
/// Claude Code の一定時間入力が無いときの通知（idle_prompt）。種類の無い通知は入力待ちとみなす。
const WAITING_TYPES: &[&str] = &["permission_prompt", "elicitation_dialog", "idle_prompt"];

/// セッションに渡す受信口の情報
#[derive(Clone)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

/// hook の入力を受信口に送るイベント。入力待ちのメッセージ（notification）と、一覧画面に出す指示と最後の返答だけ。
/// ツールの実行などの入力にはコマンドやファイルの内容が入るので送らない。
const BODY_EVENTS: &[&str] = &["notification", "user_prompt_submit", "stop"];

fn sends_body(slug: &str) -> bool {
    BODY_EVENTS.contains(&slug)
}

/// bash で受信口に POST するコマンド。with_body が false なら hook の入力は捨てる。
/// Tower が落ちていてもエージェントの動作は止めない（--max-time と || true）。
fn post_bash(event: &str, with_body: bool) -> String {
    let (drain, body) = if with_body { ("", "--data-binary @-") } else { ("cat >/dev/null; ", "-d ''") };
    format!(
        "{drain}[ -n \"$DASH_HOOK_TOKEN\" ] && curl -s --max-time 1 -X POST \
         -H \"Authorization: Bearer $DASH_HOOK_TOKEN\" \
         \"http://127.0.0.1:$DASH_HOOK_PORT/hook/$DASH_SESSION_ID/{event}\" \
         {body} >/dev/null 2>&1 || true"
    )
}

/// PowerShell 版。Windows の Codex と Copilot CLI は hook を PowerShell で実行する。
/// 一重引用符を使わない（TOML のリテラル文字列に入れるため）。
fn post_powershell(event: &str, with_body: bool) -> String {
    let url = format!("http://127.0.0.1:$env:DASH_HOOK_PORT/hook/$env:DASH_SESSION_ID/{event}");
    let auth = "-H \"Authorization: Bearer $env:DASH_HOOK_TOKEN\"";
    if with_body {
        // PowerShell 5.1 は標準入力をコンソールの文字コード（日本語環境では CP932）で読み、
        // ネイティブコマンドへのパイプを ASCII で書くので、どちらも UTF-8 にする。
        // [Text.Encoding]::UTF8 だと先頭に BOM が付いて JSON として読めないので、BOM なしにする
        format!(
            "if ($env:DASH_HOOK_TOKEN) {{ $OutputEncoding = New-Object Text.UTF8Encoding $false; \
             (New-Object IO.StreamReader([Console]::OpenStandardInput(), $OutputEncoding)).ReadToEnd() | \
             curl.exe -s --max-time 1 -X POST {auth} --data-binary \"@-\" \"{url}\" | Out-Null }}"
        )
    } else {
        format!("if ($env:DASH_HOOK_TOKEN) {{ curl.exe -s --max-time 1 -X POST {auth} \"{url}\" | Out-Null }}")
    }
}

/// Claude Code 用。`claude --settings <path>` で渡すので ~/.claude/settings.json は書き換えない。
pub fn write_settings(path: &Path) -> std::io::Result<()> {
    const EVENTS: &[(&str, &str)] = &[
        ("SessionStart", "session_start"),
        ("UserPromptSubmit", "user_prompt_submit"),
        ("PreToolUse", "pre_tool_use"),
        ("Notification", "notification"),
        ("Stop", "stop"),
        ("SessionEnd", "session_end"),
    ];
    let mut hooks = serde_json::Map::new();
    for (name, slug) in EVENTS {
        let mut entry = json!({ "hooks": [{ "type": "command", "command": post_bash(slug, sends_body(slug)) }] });
        if *name == "PreToolUse" {
            entry["matcher"] = json!("*");
        }
        hooks.insert((*name).to_string(), json!([entry]));
    }
    write(path, &serde_json::to_vec_pretty(&json!({ "hooks": hooks }))?)
}

/// Codex 用のプロファイル。`codex -p tower` で利用者の config.toml の上に重ねる。
/// PermissionRequest の入力には実行しようとしているコマンドが入るので、中身は送らない。
pub fn codex_profile() -> String {
    const EVENTS: &[(&str, &str)] = &[
        ("SessionStart", "session_start"),
        ("UserPromptSubmit", "user_prompt_submit"),
        ("PreToolUse", "pre_tool_use"),
        ("PermissionRequest", "notification"),
        ("Stop", "stop"),
        // 承認を断ったときや Esc で止めたときは Stop ではなく Interrupt になる（返答は無いので中身は送らない）
        ("Interrupt", "stop"),
        ("SessionEnd", "session_end"),
    ];
    let mut out = format!(
        "{CODEX_BEGIN}\n\
         # Tower の外で起動した codex では何もしない。初回は Codex の画面で信頼を承認すると、Tower に状態が表示される。\n"
    );
    for (name, slug) in EVENTS {
        // Codex は SessionEnd と Interrupt の timeout を 3 秒に切り詰めて毎回警告を出すので、最初から 3 秒にする
        let timeout = if matches!(*name, "SessionEnd" | "Interrupt") { 3 } else { 10 };
        out.push_str(&format!("\n[[hooks.{name}]]\n[[hooks.{name}.hooks]]\ntype = \"command\"\ntimeout = {timeout}\n"));
        let with_body = sends_body(slug) && !matches!(*name, "PermissionRequest" | "Interrupt");
        // bash 版は '' を含むので、一重引用符を含められる複数行リテラル文字列にする
        out.push_str(&format!("command = '''{}'''\n", post_bash(slug, with_body)));
        out.push_str(&format!("commandWindows = '{}'\n", post_powershell(slug, with_body)));
    }
    out.push_str(CODEX_END);
    out.push('\n');
    out
}

const CODEX_BEGIN: &str = "# >>> Tower hooks（Tower が自動で書き換える区間） >>>";
const CODEX_END: &str = "# <<< Tower hooks <<<";

/// プロファイルの hooks のテーブルだけを Tower の内容に差し替える。変える必要が無ければ None。
///
/// Codex はプロファイル使用中、フォルダの信頼などをこのファイルへ書き足す。書き足す位置は
/// ファイル末尾のコメントより前になるので、目印のコメントでは区切れない。そのためテーブルの見出しで分け、
/// `[[hooks.…]]` 以外のテーブルとトップレベルの設定はそのまま残す。
/// また、ファイルを書き換えると Codex が hook の信頼をやり直させるので、同じ内容なら書かない。
fn merge_codex_profile(existing: Option<&str>, block: &str) -> Option<String> {
    let Some(existing) = existing else { return Some(block.to_string()) };
    let (mut root, mut others) = (String::new(), String::new());
    // None: 最初の見出しより前、Some(true): hooks のテーブル、Some(false): それ以外のテーブル
    let mut section: Option<bool> = None;
    for line in existing.lines() {
        let t = line.trim_start();
        if t == CODEX_BEGIN || t == CODEX_END {
            continue;
        }
        if t.starts_with('[') {
            section = Some(t.starts_with("[[hooks.") || t.starts_with("[hooks"));
        }
        match section {
            None if !t.is_empty() && !t.starts_with('#') => {
                root.push_str(line);
                root.push('\n');
            }
            Some(false) => {
                others.push_str(line);
                others.push('\n');
            }
            _ => {}
        }
    }
    let merged = format!("{root}{block}{others}");
    (merged != existing).then_some(merged)
}

/// Copilot CLI 用。ユーザー単位の hooks フォルダに単独のファイルとして置く。
pub fn copilot_hooks() -> Value {
    const EVENTS: &[(&str, &str)] = &[
        ("sessionStart", "session_start"),
        ("userPromptSubmitted", "user_prompt_submit"),
        ("preToolUse", "pre_tool_use"),
        ("notification", "notification"),
        ("agentStop", "stop"),
        ("sessionEnd", "session_end"),
    ];
    let mut hooks = serde_json::Map::new();
    for (name, slug) in EVENTS {
        let with_body = sends_body(slug);
        hooks.insert(
            (*name).to_string(),
            json!([{
                "type": "command",
                "bash": post_bash(slug, with_body),
                "powershell": post_powershell(slug, with_body),
                "timeoutSec": 10
            }]),
        );
    }
    json!({ "version": 1, "hooks": hooks })
}

fn home_dir(env: &str, default: &str) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(env) {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|h| PathBuf::from(h).join(default))
}

fn write(path: &Path, content: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // 内容が同じなら書かない（Codex は hook の内容のハッシュで信頼を管理している）
    if std::fs::read(path).is_ok_and(|old| old == content) {
        return Ok(());
    }
    std::fs::write(path, content)
}

/// Codex と Copilot CLI の hooks ファイルを書き出す。
/// エージェントの設定フォルダがあるとき（＝使っているとき）だけ書き、利用者の既存ファイルには触れない。
pub fn write_agent_hooks() -> Vec<String> {
    let mut errors = Vec::new();
    if let Some(codex) = home_dir("CODEX_HOME", ".codex").filter(|d| d.is_dir()) {
        let path = codex.join("tower.config.toml");
        let existing = std::fs::read_to_string(&path).ok();
        if let Some(content) = merge_codex_profile(existing.as_deref(), &codex_profile()) {
            if let Err(e) = write(&path, content.as_bytes()) {
                errors.push(format!("Codex の hooks を書き込めませんでした: {e}"));
            }
        }
    }
    if let Some(copilot) = home_dir("COPILOT_HOME", ".copilot").filter(|d| d.is_dir()) {
        let content = serde_json::to_vec_pretty(&copilot_hooks()).unwrap_or_default();
        if let Err(e) = write(&copilot.join("hooks").join("tower.json"), &content) {
            errors.push(format!("Copilot CLI の hooks を書き込めませんでした: {e}"));
        }
    }
    errors
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

/// notification の中身から、入力待ちとして扱うかとメッセージを取り出す
fn read_notification(body: &str) -> (bool, Option<String>) {
    let Ok(v) = serde_json::from_str::<Value>(body.trim_start_matches('\u{feff}')) else { return (true, None) };
    let waiting = v
        .get("notification_type")
        .and_then(|t| t.as_str())
        .is_none_or(|t| WAITING_TYPES.contains(&t));
    (waiting, v.get("message").and_then(|m| m.as_str()).map(String::from))
}

/// 一覧画面に出す、指示（UserPromptSubmit の prompt）と最後の返答（Stop の last_assistant_message）
fn read_talk(event: &str, body: &str) -> Option<String> {
    let key = match event {
        "user_prompt_submit" => "prompt",
        "stop" => "last_assistant_message",
        _ => return None,
    };
    let v: Value = serde_json::from_str(body.trim_start_matches('\u{feff}')).ok()?;
    v.get(key)?.as_str().filter(|s| !s.trim().is_empty()).map(String::from)
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
            // UTF-8 として正しくない部分があっても、本文全体は捨てない（read_to_string は空のまま失敗する）
            let mut raw = Vec::new();
            let _ = req.as_reader().take(1 << 20).read_to_end(&mut raw);
            let body = String::from_utf8_lossy(&raw);
            if parts.len() == 3 && parts[0] == "hook" {
                if parts[2] == "notification" {
                    let (waiting, message) = read_notification(&body);
                    if waiting {
                        manager.apply_hook(&app, &parts[1], "notification", message);
                    }
                } else {
                    let text = read_talk(&parts[2], &body);
                    match parts[2].as_str() {
                        "user_prompt_submit" => manager.record_talk(&parts[1], text.as_deref(), None),
                        "stop" => manager.record_talk(&parts[1], None, text.as_deref()),
                        _ => {}
                    }
                    manager.apply_hook(&app, &parts[1], &parts[2], None);
                }
            }
            let _ = req.respond(tiny_http::Response::empty(204));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_types() {
        assert_eq!(read_notification(r#"{"message":"m"}"#), (true, Some("m".into())));
        assert!(read_notification(r#"{"notification_type":"permission_prompt"}"#).0);
        assert!(!read_notification(r#"{"notification_type":"shell_completed"}"#).0);
        assert!(!read_notification(r#"{"notification_type":"agent_idle"}"#).0);
        // Codex の PermissionRequest は中身を送らない
        assert_eq!(read_notification(""), (true, None));
        // BOM 付きでも読める
        assert!(!read_notification("\u{feff}{\"notification_type\":\"agent_idle\"}").0);
    }

    #[test]
    fn reads_prompt_and_last_reply() {
        assert_eq!(read_talk("user_prompt_submit", r#"{"prompt":"テストして"}"#).as_deref(), Some("テストして"));
        assert_eq!(read_talk("stop", r#"{"last_assistant_message":"done"}"#).as_deref(), Some("done"));
        assert_eq!(read_talk("stop", r#"{"stop_hook_active":false}"#), None);
        assert_eq!(read_talk("stop", ""), None);
        assert_eq!(read_talk("pre_tool_use", r#"{"prompt":"x"}"#), None);
    }

    #[test]
    fn codex_profile_keeps_codex_additions() {
        let block = codex_profile();
        let trust = "[projects.'c:\\repo']\ntrust_level = \"trusted\"\n";
        // 新規作成
        assert_eq!(merge_codex_profile(None, &block).unwrap(), block);

        // Codex は末尾のコメント（終わりの目印）より前にテーブルを書き足す
        let end = format!("{CODEX_END}\n");
        let by_codex = format!("model = \"x\"\n{}{trust}{end}", block.replace(&end, ""));
        let merged = merge_codex_profile(Some(&by_codex), &block).unwrap();
        // フォルダの信頼とトップレベルの設定は残る
        assert_eq!(merged, format!("model = \"x\"\n{block}{trust}"));
        // 一度整えた後は、同じ内容なら書き換えない
        assert_eq!(merge_codex_profile(Some(&merged), &block), None);

        // hooks の中身が変わったときは hooks だけ差し替える
        let old = merged.replace("timeout = 10", "timeout = 9");
        assert_eq!(merge_codex_profile(Some(&old), &block).unwrap(), merged);
    }

    #[test]
    fn codex_profile_is_valid_toml_shape() {
        let p = codex_profile();
        // PowerShell 版は一重引用符のリテラル文字列に入れるので、一重引用符を含んではいけない
        for line in p.lines().filter(|l| l.starts_with("commandWindows")) {
            assert_eq!(line.matches('\'').count(), 2, "{line}");
        }
        assert!(p.contains("[[hooks.PermissionRequest]]"));
        // 中身を送るのは指示と返答だけ（PermissionRequest にはコマンドが入る）
        let section = |name: &str| p.split(&format!("[[hooks.{name}.hooks]]")).nth(1).unwrap().split("\n\n").next().unwrap().to_string();
        let permission = section("PermissionRequest");
        assert!(permission.contains("cat >/dev/null"), "{permission}");
        let prompt = section("UserPromptSubmit");
        assert!(prompt.contains("--data-binary @-"), "{prompt}");
    }
}
